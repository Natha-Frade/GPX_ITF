// gpmf.js — Extrator de GPS da GoPro (GPMF: GPS5 antigo, GPS9 HERO11+).
// Porte em módulo ES do static/js/gpmf.js do app principal, com uma
// diferença: além dos pontos absolutos (ts ISO), devolve pontos com o
// tempo RELATIVO ao início do vídeo (t em segundos) — é o formato que o
// editor (store EDL / mapa / export) usa.
//
// Lê o arquivo em chunks de 2MB via slice(): nunca carrega o vídeo
// inteiro na memória — funciona com arquivos de vários GB.

const GPMF_CHUNK = 2 * 1024 * 1024
const GPMF_OVERLAP = 64 * 1024

// file: File local. Retorna { points:[{t,lat,lon,ele,spd}], device, synthetic:false }
// duration: duração do vídeo (s), usada pra distribuir pontos sem timestamp.
export async function extractGps(file, duration, onProgress) {
  const raw = await extractGPMF(file, onProgress)
  const pts = toRelative(raw.points, duration)
  return { points: pts, device: raw.device }
}

// Converte pontos com ts ISO absoluto em t relativo (s desde o 1º ponto).
function toRelative(points, duration) {
  if (!points.length) return []
  const withTs = points.filter((p) => p.ts)
  if (withTs.length >= 2) {
    const t0 = Date.parse(withTs[0].ts)
    return withTs.map((p) => ({
      t: Math.max(0, (Date.parse(p.ts) - t0) / 1000),
      lat: p.lat,
      lon: p.lon,
      ele: p.alt ?? 0,
      spd: p.spd,
    }))
  }
  // sem timestamps: distribui uniformemente pela duração do vídeo
  const dur = duration || points.length / 18
  return points.map((p, i) => ({
    t: (i / Math.max(points.length - 1, 1)) * dur,
    lat: p.lat,
    lon: p.lon,
    ele: p.alt ?? 0,
    spd: p.spd,
  }))
}

async function extractGPMF(file, onProgress) {
  const size = file.size
  let offset = 0
  let scal = 10000000
  let device = 'GoPro'
  const points = []
  const timestamps = []
  let blockIdx = 0

  const points9 = []
  let scal9 = [10000000, 10000000, 1000, 1000, 100, 1, 1000, 100, 1]
  const seen9 = new Set()

  onProgress && onProgress(0, 'Lendo GPS do vídeo…')

  while (offset < size) {
    const end = Math.min(offset + GPMF_CHUNK, size)
    const buffer = await file.slice(offset, end).arrayBuffer()
    const bytes = new Uint8Array(buffer)

    if (device === 'GoPro') {
      const di = findBytes(bytes, [0x44, 0x56, 0x4e, 0x4d]) // DVNM
      if (di !== -1) {
        const klv = readKLV(bytes, di)
        if (klv) device = new TextDecoder().decode(klv.payload).replace(/\0/g, '').trim()
      }
    }

    const si = findBytes(bytes, [0x53, 0x43, 0x41, 0x4c]) // SCAL
    if (si !== -1) {
      const klv = readKLV(bytes, si)
      if (klv) {
        if (klv.type === 'S' && klv.size === 2) {
          scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getUint16(0)
        } else if (klv.type === 'l' && klv.size === 4 && klv.repeat === 1) {
          scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getInt32(0)
        }
        if (!scal) scal = 10000000
      }
    }

    // SCAL de 9 valores (escalas do GPS9)
    let scalPos = 0
    for (;;) {
      const sj = findBytes(bytes, [0x53, 0x43, 0x41, 0x4c], scalPos)
      if (sj === -1) break
      const klv = readKLV(bytes, sj)
      if (klv && klv.type === 'l' && klv.size === 4 && klv.repeat === 9) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset)
        const arr = []
        for (let k = 0; k < 9; k++) arr.push(dv.getInt32(k * 4) || 1)
        scal9 = arr
        break
      }
      scalPos = sj + 4
    }

    // GPSU (timestamps ~1Hz do GPS5)
    let gpsuPos = 0
    for (;;) {
      const gi = findBytes(bytes, [0x47, 0x50, 0x53, 0x55], gpsuPos)
      if (gi === -1) break
      const klv = readKLV(bytes, gi)
      if (klv && klv.payload.length >= 16) {
        timestamps.push(new TextDecoder().decode(klv.payload.slice(0, 16)))
      }
      gpsuPos = gi + 4
    }

    // GPS5
    let gps5Pos = 0
    for (;;) {
      const gi = findBytes(bytes, [0x47, 0x50, 0x53, 0x35], gps5Pos)
      if (gi === -1) break
      const klv = readKLV(bytes, gi)
      if (klv && klv.size === 20 && klv.repeat > 0) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset)
        for (let i = 0; i < klv.repeat; i++) {
          const base = i * 20
          if (base + 20 > klv.payload.length) break
          const lat = dv.getInt32(base + 0) / scal
          const lon = dv.getInt32(base + 4) / scal
          const alt = dv.getInt32(base + 8) / 1000
          const spd = dv.getInt32(base + 12) / 1000
          if (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001) {
            points.push({ lat, lon, alt, spd, blockIdx })
          }
        }
        blockIdx++
      }
      gps5Pos = gi + 4
    }

    // GPS9 (HERO11+, timestamp por amostra)
    let gps9Pos = 0
    for (;;) {
      const gi = findBytes(bytes, [0x47, 0x50, 0x53, 0x39], gps9Pos)
      if (gi === -1) break
      const klv = readKLV(bytes, gi)
      if (klv && klv.size === 32 && klv.repeat > 0) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset)
        for (let i = 0; i < klv.repeat; i++) {
          const base = i * 32
          if (base + 32 > klv.payload.length) break
          const lat = dv.getInt32(base + 0) / scal9[0]
          const lon = dv.getInt32(base + 4) / scal9[1]
          const alt = dv.getInt32(base + 8) / scal9[2]
          const spd = dv.getInt32(base + 12) / scal9[3]
          const days = dv.getInt32(base + 20) / scal9[5]
          const secs = dv.getInt32(base + 24) / scal9[6]
          const fix = dv.getUint16(base + 30) / scal9[8]
          if (fix === 0) continue
          if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) continue
          const ms = Date.UTC(2000, 0, 1) + days * 86400000 + secs * 1000
          const key = Math.round(ms)
          if (seen9.has(key)) continue
          seen9.add(key)
          points9.push({ lat, lon, alt, spd, ts: new Date(ms).toISOString() })
        }
      }
      gps9Pos = gi + 4
    }

    onProgress &&
      onProgress(
        Math.round((end / size) * 100),
        `${Math.max(points.length, points9.length)} pontos GPS…`
      )
    if (end >= size) break
    offset = end - GPMF_OVERLAP
  }

  if (points9.length) {
    points9.sort((a, b) => (a.ts < b.ts ? -1 : 1))
    return { points: points9, device }
  }

  const tsPerBlock =
    points.length > 0 && timestamps.length > 0
      ? Math.ceil(points.length / Math.max(timestamps.length, 1))
      : 18
  points.forEach((pt, i) => {
    const tsIdx = Math.min(Math.floor(i / tsPerBlock), timestamps.length - 1)
    if (tsIdx >= 0 && timestamps[tsIdx]) {
      pt.ts = parseGPSU(timestamps[tsIdx], i % tsPerBlock, tsPerBlock)
    }
  })
  return { points, device }
}

function parseGPSU(ts, sampleOffset, samplesPerSec) {
  try {
    const yr = 2000 + parseInt(ts.slice(0, 2))
    const mo = parseInt(ts.slice(2, 4))
    const dy = parseInt(ts.slice(4, 6))
    const hr = parseInt(ts.slice(6, 8))
    const mn = parseInt(ts.slice(8, 10))
    const sc = parseInt(ts.slice(10, 12))
    const ms = parseFloat('0.' + (ts.slice(13) || '0')) * 1000
    const base = Date.UTC(yr, mo - 1, dy, hr, mn, sc, ms)
    const fracMs = (sampleOffset / samplesPerSec) * 1000
    return new Date(base + fracMs).toISOString()
  } catch {
    return null
  }
}

function findBytes(arr, pattern, start = 0) {
  const p0 = pattern[0]
  for (let i = start; i <= arr.length - pattern.length; i++) {
    if (arr[i] !== p0) continue
    let ok = true
    for (let j = 1; j < pattern.length; j++) {
      if (arr[i + j] !== pattern[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

function readKLV(bytes, offset) {
  if (offset + 8 > bytes.length) return null
  const type = String.fromCharCode(bytes[offset + 4])
  const size = bytes[offset + 5]
  const repeat = (bytes[offset + 6] << 8) | bytes[offset + 7]
  const length = size * repeat
  if (offset + 8 + length > bytes.length) return null
  return { type, size, repeat, payload: bytes.slice(offset + 8, offset + 8 + length) }
}

// gpmf.js — Extrator de GPS da GoPro (GPMF: GPS5 antigo, GPS9 HERO11+).
// Porte em módulo ES do static/js/gpmf.js do app principal, com uma
// diferença: além dos pontos absolutos (ts ISO), devolve pontos com o
// tempo RELATIVO ao início do vídeo (t em segundos) — é o formato que o
// editor (store EDL / mapa / export) usa.
//
// Lê o arquivo em chunks de 2MB via slice(): nunca carrega o vídeo
// inteiro na memória — funciona com arquivos de vários GB.

import MP4Box from 'mp4box'

const GPMF_CHUNK = 2 * 1024 * 1024
const GPMF_OVERLAP = 64 * 1024

// ---------------------------------------------------------------------------
// Leitura direcionada da trilha de metadados (gpmd)
//
// O GPS da GoPro nao esta espalhado pelo arquivo: fica numa trilha propria
// ('GoPro MET', codec gpmd) de poucos MB. Varrer o MP4 inteiro atras dos
// marcadores custava ~1.500 iteracoes de busca byte a byte num video de 4 min
// em 4K — minutos de CPU travando a thread principal (e, de quebra, deixando
// o <video> preto por falta de tempo pra decodificar).
//
// Aqui pedimos ao mp4box os offsets exatos das amostras dessa trilha e lemos
// so esses trechos. Passa de gigabytes para poucos megabytes.
// ---------------------------------------------------------------------------

async function lerRange(file, ini, fim) {
  return new Uint8Array(await file.slice(ini, fim).arrayBuffer())
}

// Varre os boxes de nivel superior sem carregar o arquivo.
async function boxesDoTopo(file) {
  const tops = []
  let pos = 0
  while (pos + 8 <= file.size) {
    const cab = await lerRange(file, pos, Math.min(pos + 16, file.size))
    const dv = new DataView(cab.buffer)
    let tam = dv.getUint32(0)
    const tipo = String.fromCharCode(cab[4], cab[5], cab[6], cab[7])
    if (tam === 1) tam = Number(dv.getBigUint64(8))
    else if (tam === 0) tam = file.size - pos
    if (tam < 8) break
    tops.push({ type: tipo, start: pos, size: tam })
    pos += tam
  }
  return tops
}

// Devolve um Uint8Array so com os bytes da trilha gpmd, ou null se nao achar.
async function lerTrilhaGpmd(file, onProgress) {
  const tops = await boxesDoTopo(file)
  const ftypBox = tops.find((b) => b.type === 'ftyp')
  const moovBox = tops.find((b) => b.type === 'moov')
  if (!moovBox) return null

  const ftyp = ftypBox ? await lerRange(file, ftypBox.start, ftypBox.start + ftypBox.size) : null
  const moov = await lerRange(file, moovBox.start, moovBox.start + moovBox.size)

  const mp4 = MP4Box.createFile()
  const info = await new Promise((ok, falhou) => {
    mp4.onError = (e) => falhou(new Error('mp4box: ' + e))
    mp4.onReady = ok
    if (ftyp) {
      const b = ftyp.buffer.slice(ftyp.byteOffset, ftyp.byteOffset + ftyp.byteLength)
      b.fileStart = ftypBox.start
      mp4.appendBuffer(b)
    }
    const b2 = moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength)
    b2.fileStart = moovBox.start
    mp4.appendBuffer(b2)
    mp4.flush()
  })

  // A trilha do GPMF aparece como codec 'gpmd'; algumas firmwares so
  // identificam pelo nome do handler ('GoPro MET').
  const trilha = (info.tracks || []).find(
    (t) => t.codec === 'gpmd' || /GoPro MET/i.test(t.name || '')
  )
  if (!trilha) return null

  const amostras = mp4.getTrackSamplesInfo(trilha.id)
  if (!amostras || !amostras.length) return null

  // Amostras consecutivas costumam ser contiguas no arquivo: juntamos em
  // faixas pra fazer poucas leituras grandes em vez de milhares pequenas.
  const faixas = []
  for (const a of amostras) {
    const ult = faixas[faixas.length - 1]
    if (ult && a.offset === ult.fim) ult.fim += a.size
    else faixas.push({ ini: a.offset, fim: a.offset + a.size })
  }

  const partes = []
  let lidos = 0
  const total = faixas.reduce((acc, f) => acc + (f.fim - f.ini), 0)
  for (const f of faixas) {
    partes.push(await lerRange(file, f.ini, f.fim))
    lidos += f.fim - f.ini
    onProgress && onProgress(Math.round((lidos / total) * 100), 'Lendo GPS do vídeo…')
  }

  const out = new Uint8Array(total)
  let p = 0
  for (const parte of partes) {
    out.set(parte, p)
    p += parte.length
  }
  return out
}

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

async function extractGPMF(arquivo, onProgress) {
  // Caminho rapido: le so a trilha gpmd. Se o MP4 nao tiver essa trilha
  // (ou o mp4box nao conseguir lê-la), cai na varredura completa antiga.
  let file = arquivo
  try {
    const gpmd = await lerTrilhaGpmd(arquivo, onProgress)
    if (gpmd && gpmd.length) {
      file = new Blob([gpmd])
      console.debug(
        `[gpmf] trilha gpmd: ${(gpmd.length / 1048576).toFixed(1)} MB ` +
          `(arquivo tem ${(arquivo.size / 1048576).toFixed(0)} MB)`
      )
    } else {
      console.warn('[gpmf] trilha gpmd não encontrada — varrendo o arquivo inteiro')
    }
  } catch (e) {
    console.warn('[gpmf] leitura direcionada falhou, varrendo tudo:', e)
  }

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

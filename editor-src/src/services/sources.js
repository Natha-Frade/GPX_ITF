// sources.js — Registro de fontes de vídeo do editor (100% no navegador).
//
// Uma "source" nasce de um File local (seletor/arrastar) ou de um item do
// SharePoint (streaming via backend). O objeto devolvido é o que o store
// EDL guarda em edl.sources:
//   { id, path(nome), url, file|null, remote|null, duration, fps,
//     width, height, gpx:{points}, thumb(dataURL), probe }
//
// - id: hash do nome+tamanho — o mesmo arquivo adicionado 2x vira 1 source.
// - url: objectURL (local) ou /api/sharepoint/media/stream/… (remoto);
//   é o que o <video> do player toca.
// - gpx.points: [{t,lat,lon,ele}] com t RELATIVO ao início do vídeo.

import { reactive, markRaw } from 'vue'
import { probeFile } from './probe'
import { extractGps } from './gpmf'
import { makeThumb } from './thumbs'

const registry = new Map() // id -> source

export function getSource(id) {
  return registry.get(id) ?? null
}

async function hashId(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

// file: File local. onStatus(msg) opcional pro painel.
export async function registerLocalFile(file, onStatus) {
  const id = 'src_' + (await hashId(`${file.name}|${file.size}|${file.lastModified}`))
  if (registry.has(id)) return registry.get(id)

  onStatus && onStatus(`lendo metadados de ${file.name}…`)
  const probe = await probeFile(file)
  const url = URL.createObjectURL(file)

  const source = reactive({
    id,
    path: file.name,
    url,
    file: markRaw(file),
    remote: null,
    duration: probe.duration,
    fps: probe.fps,
    width: probe.width,
    height: probe.height,
    gpx: { points: [] },
    thumb: null,
    probe: markRaw(probe),
  })
  registry.set(id, source)

  // GPS e thumbnail rodam em paralelo, sem travar a inclusão na timeline
  ;(async () => {
    try {
      onStatus && onStatus(`extraindo GPS de ${file.name}…`)
      const { points } = await extractGps(file, probe.duration, null)
      source.gpx.points = points
      onStatus && onStatus(points.length ? `${points.length} pontos GPS` : 'vídeo sem GPS')
    } catch (e) {
      console.warn('[gps]', e)
      onStatus && onStatus('não consegui ler o GPS deste vídeo')
    }
  })()
  ;(async () => {
    try {
      source.thumb = await makeThumb(url)
    } catch (e) {
      console.warn('[thumb]', e)
    }
  })()

  return source
}

// item do SharePoint: { driveId, itemId, name, size } vindo do backend.
// O vídeo NÃO é baixado: o player toca o stream; o GPS vem do backend
// (que extrai server-side) e o export usa corte no servidor.
export async function registerSharePointItem(item, onStatus) {
  const id = 'sp_' + (await hashId(`${item.driveId}|${item.itemId}`))
  if (registry.has(id)) return registry.get(id)

  const url = `/api/sharepoint/media/stream/${encodeURIComponent(item.driveId)}/${encodeURIComponent(item.itemId)}`

  onStatus && onStatus(`lendo metadados de ${item.name}…`)
  // metadados via <video> (o stream suporta Range; só o cabeçalho é lido)
  const meta = await new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.src = url
    v.onloadedmetadata = () =>
      resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight })
    v.onerror = () => reject(new Error('não consegui abrir o vídeo do SharePoint'))
  })

  const source = reactive({
    id,
    path: item.name,
    url,
    file: null,
    remote: { driveId: item.driveId, itemId: item.itemId, size: item.size },
    duration: meta.duration,
    fps: 30, // sem o moov na mão; o corte remoto é server-side, não precisa
    width: meta.width,
    height: meta.height,
    gpx: { points: [] },
    thumb: null,
    probe: null,
  })
  registry.set(id, source)
  ;(async () => {
    try {
      source.thumb = await makeThumb(url)
    } catch {}
  })()
  ;(async () => {
    try {
      onStatus && onStatus(`extraindo GPS de ${item.name} (no servidor)…`)
      const res = await fetch(
        `/api/sharepoint/media/gpx/${encodeURIComponent(item.driveId)}/${encodeURIComponent(item.itemId)}`,
        { headers: authHeader() }
      )
      if (res.ok) {
        const data = await res.json()
        source.gpx.points = data.points ?? []
        onStatus && onStatus(`${source.gpx.points.length} pontos GPS`)
      } else {
        onStatus && onStatus('GPS indisponível para este vídeo remoto')
      }
    } catch {
      onStatus && onStatus('GPS indisponível para este vídeo remoto')
    }
  })()

  return source
}

// token JWT do app principal (mesmo login do GPX IMTRAFF)
export function authHeader() {
  const tok = localStorage.getItem('token')
  return tok ? { Authorization: `Bearer ${tok}` } : {}
}

// export/index.js — Orquestrador da exportação. Analisa a EDL (plan.js),
// escolhe o motor certo e devolve { videoBlob|videoUrl, gpxText, points,
// mode, duration } pro ExportPane baixar/mostrar a comparação.

import { analyze, composeIntervals, timelineDuration } from './plan'
import { exportCopy, buildComposeAudio, muxAv } from './ffmpeg'
import { exportCompose } from './webcodecs'
import { remapCopy, remapCompose, writeGpx } from './gpx'
import { getSource, authHeader } from '../sources'

export { analyze }

// qualidade → bits por pixel por frame (H.264). "alta" ≈ GoPro nativo.
const QUALITY_BPP = { alta: 0.14, media: 0.09, baixa: 0.055 }

export function estimateBitrate(w, h, fps, quality = 'media') {
  const bpp = QUALITY_BPP[quality] ?? QUALITY_BPP.media
  return Math.min(Math.round(w * h * fps * bpp), 90_000_000)
}

// edl: store.edl | opts: {title, ignoreGaps, quality, signal}
// cb: {status(msg), progress(0-1)}
export async function runExport(edl, opts, cb = {}) {
  const plan = analyze(edl, getSource, { ignoreGaps: opts.ignoreGaps })
  const title = opts.title || 'export'

  if (plan.mode === 'empty') throw new Error('a timeline está vazia')
  if (plan.mode === 'mixed') throw new Error(plan.reasons.join('; '))

  if (plan.mode === 'copy') {
    cb.status?.('Exportação SEM re-encode (stream copy) — qualidade original')
    const { blob, pieces, duration } = await exportCopy(plan.pieces, getSource, cb.status, cb.progress)
    const points = remapCopy(pieces, getSource)
    return { videoBlob: blob, gpxText: writeGpx(points, title), points, mode: 'copy', duration }
  }

  if (plan.mode === 'remote') {
    cb.status?.('Cortando no servidor, direto do SharePoint…')
    const trechos = plan.pieces.map((p) => {
      const src = getSource(p.sourceId)
      return { drive_id: src.remote.driveId, item_id: src.remote.itemId, inicio: p.in, fim: p.out }
    })
    const res = await fetch('/api/sharepoint/media/cortar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ trechos }),
      signal: opts.signal,
    })
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `erro ${res.status}`)
    const durs = JSON.parse(res.headers.get('X-Duracoes') ?? '[]')
    const blob = await res.blob()
    const pieces = plan.pieces.map((p, i) => ({ ...p, realDur: durs[i] ?? p.out - p.in }))
    const points = remapCopy(pieces, getSource)
    const duration = pieces.reduce((s, p) => s + p.realDur, 0)
    return { videoBlob: blob, gpxText: writeGpx(points, title), points, mode: 'remote', duration }
  }

  // webcodecs (composição)
  const intervals = plan.intervals ?? composeIntervals(edl)
  const total = timelineDuration(edl)

  // canvas = source da trilha principal (menor z com segmento), como no main_Local
  let ref = null
  for (const track of [...edl.tracks].sort((a, b) => a.z - b.z)) {
    const seg = [...track.segments].sort((a, b) => a.start - b.start)[0]
    if (seg) {
      ref = getSource(seg.source_id)
      break
    }
  }
  if (!ref) throw new Error('a timeline está vazia')
  const width = ref.width - (ref.width % 2)
  const height = ref.height - (ref.height % 2)
  const fps = Math.min(Math.round(ref.fps) || 30, 60)
  const bitrate = estimateBitrate(width, height, fps, opts.quality)

  cb.status?.(`Composição com aceleração de hardware (${width}x${height}@${fps}, ${(bitrate / 1e6).toFixed(0)} Mbps)`)

  // vídeo (WebCodecs) e áudio (ffmpeg.wasm) em paralelo
  const [videoOnly, audio] = await Promise.all([
    exportCompose(intervals, getSource, { width, height, fps, bitrate, signal: opts.signal }, cb.status, cb.progress),
    buildComposeAudio(edl, getSource, total, cb.status).catch((e) => {
      console.warn('[audio]', e)
      return null
    }),
  ])
  const blob = await muxAv(videoOnly, audio, cb.status)
  const points = remapCompose(intervals, getSource)
  return { videoBlob: blob, gpxText: writeGpx(points, title), points, mode: 'compose', duration: total }
}

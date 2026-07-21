// ffmpeg.js — Wrapper do ffmpeg.wasm para o export.
//
// Papel dele no motor:
//  - caminho COPY: corta cada trecho com -c copy (sem re-encode, sem
//    perda) e concatena — é rápido porque é só I/O, nada de CPU.
//  - caminho WEBCODECS: monta o ÁUDIO (atrim/adelay/amix → AAC; áudio é
//    barato até em wasm) e faz o mux final vídeo+áudio com -c copy.
//
// Os arquivos de ENTRADA são montados via WORKERFS (o wasm lê o File por
// referência — funciona com vídeos de vários GB sem copiar pra memória).
// Só as SAÍDAS vivem na memória do wasm; num corte típico isso é o
// tamanho do trecho exportado.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { probeFile } from '../probe'

// dois CDNs pro core (~31MB, fica em cache): redes de empresa às vezes
// bloqueiam um deles — mesmo esquema já usado no app principal
const CORES = [
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
]

let _ffmpeg = null
let _loading = null

export async function ensureFFmpeg(onStatus) {
  if (_ffmpeg) return _ffmpeg
  if (!_loading) {
    _loading = (async () => {
      onStatus && onStatus('Baixando motor de vídeo (primeira vez, ~31 MB)…')
      let lastErr = null
      for (const base of CORES) {
        try {
          const ff = new FFmpeg()
          await ff.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
          })
          _ffmpeg = ff
          return ff
        } catch (e) {
          lastErr = e
        }
      }
      _loading = null
      throw new Error('não consegui baixar o motor de vídeo (rede bloqueou os CDNs): ' + lastErr?.message)
    })()
  }
  return _loading
}

let _mounted = false
async function mountInputs(ff, files) {
  if (_mounted) {
    try { await ff.unmount('/inputs') } catch {}
    try { await ff.deleteDir('/inputs') } catch {}
  }
  await ff.createDir('/inputs')
  await ff.mount('WORKERFS', { files }, '/inputs')
  _mounted = true
}

const clean = async (ff, name) => { try { await ff.deleteFile(name) } catch {} }

// pieces: [{sourceId, in, out}] + sources locais (com .file). Corta cada
// trecho com -c copy, MEDE a duração real (keyframe), concatena e devolve
// { blob, pieces:[{…, realDur}], duration }.
export async function exportCopy(pieces, getSource, onStatus, onProgress) {
  const ff = await ensureFFmpeg(onStatus)

  // nome único por source dentro do WORKERFS
  const files = []
  const nameById = new Map()
  for (const p of pieces) {
    if (nameById.has(p.sourceId)) continue
    const src = getSource(p.sourceId)
    const safe = `${nameById.size}_${src.path.replace(/[^\w.\-]/g, '_')}`
    nameById.set(p.sourceId, safe)
    files.push({ name: safe, data: src.file })
  }
  await mountInputs(ff, files)

  const outNames = []
  const measured = []
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    const inName = `/inputs/${nameById.get(p.sourceId)}`
    const outName = `piece_${i}.mp4`
    onStatus && onStatus(`Cortando trecho ${i + 1}/${pieces.length} (sem re-encode)…`)
    // -ss antes do -i com -c copy: começa no keyframe anterior; -t preserva o fim
    await ff.exec([
      '-ss', p.in.toFixed(3),
      '-i', inName,
      '-t', (p.out - p.in).toFixed(3),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outName,
    ])
    const data = await ff.readFile(outName)
    const blob = new Blob([data.buffer ?? data], { type: 'video/mp4' })
    let realDur = p.out - p.in
    try {
      realDur = (await probeFile(blob)).duration
    } catch {}
    measured.push({ ...p, realDur })
    outNames.push(outName)
    onProgress && onProgress((i + 1) / (pieces.length + 1))
  }

  let finalName
  if (outNames.length === 1) {
    finalName = outNames[0]
  } else {
    onStatus && onStatus('Juntando os trechos…')
    const list = outNames.map((n) => `file '${n}'`).join('\n')
    await ff.writeFile('list.txt', list)
    finalName = 'final.mp4'
    await ff.exec([
      '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-c', 'copy', '-movflags', '+faststart', finalName,
    ])
    await clean(ff, 'list.txt')
  }

  const data = await ff.readFile(finalName)
  const blob = new Blob([data.buffer ?? data], { type: 'video/mp4' })
  for (const n of outNames) if (n !== finalName) await clean(ff, n)
  await clean(ff, finalName)
  onProgress && onProgress(1)
  const duration = measured.reduce((s, m) => s + m.realDur, 0)
  return { blob, pieces: measured, duration }
}

// Áudio da composição: mix das trilhas NÃO mudas, cada segmento no seu
// start (atrim + adelay + amix). Devolve Blob .m4a ou null se não há áudio.
export async function buildComposeAudio(edl, getSource, totalDur, onStatus) {
  const ff = await ensureFFmpeg(onStatus)
  const segs = []
  for (const track of edl.tracks) {
    if (track.muted) continue
    for (const s of track.segments) {
      const src = getSource(s.source_id)
      if (src?.file && src.probe?.audioCodec) segs.push({ ...s, src })
    }
  }
  if (!segs.length) return null

  const files = []
  const nameById = new Map()
  for (const s of segs) {
    if (nameById.has(s.src.id)) continue
    const safe = `${nameById.size}_${s.src.path.replace(/[^\w.\-]/g, '_')}`
    nameById.set(s.src.id, safe)
    files.push({ name: safe, data: s.src.file })
  }
  await mountInputs(ff, files)

  onStatus && onStatus('Montando o áudio…')
  const inputs = []
  const filters = []
  const labels = []
  const srcIndex = new Map()
  for (const [id, name] of nameById) {
    srcIndex.set(id, inputs.length / 2)
    inputs.push('-i', `/inputs/${name}`)
  }
  segs.forEach((s, i) => {
    const idx = srcIndex.get(s.src.id)
    const delayMs = Math.round(s.start * 1000)
    filters.push(
      `[${idx}:a]atrim=start=${s.in.toFixed(3)}:end=${s.out.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${i}]`
    )
    labels.push(`[a${i}]`)
  })
  filters.push(
    `${labels.join('')}amix=inputs=${segs.length}:duration=longest:normalize=0,apad,atrim=0:${totalDur.toFixed(3)}[aout]`
  )

  await ff.exec([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[aout]',
    '-c:a', 'aac', '-b:a', '192k',
    'audio.m4a',
  ])
  const data = await ff.readFile('audio.m4a')
  await clean(ff, 'audio.m4a')
  return new Blob([data.buffer ?? data], { type: 'audio/mp4' })
}

// Junta o vídeo (WebCodecs) com o áudio (acima) sem re-encode.
export async function muxAv(videoBlob, audioBlob, onStatus) {
  if (!audioBlob) return videoBlob
  const ff = await ensureFFmpeg(onStatus)
  onStatus && onStatus('Finalizando (mux vídeo+áudio)…')
  await ff.writeFile('v.mp4', new Uint8Array(await videoBlob.arrayBuffer()))
  await ff.writeFile('a.m4a', new Uint8Array(await audioBlob.arrayBuffer()))
  await ff.exec([
    '-i', 'v.mp4', '-i', 'a.m4a',
    '-c', 'copy', '-shortest', '-movflags', '+faststart',
    'muxed.mp4',
  ])
  const data = await ff.readFile('muxed.mp4')
  for (const n of ['v.mp4', 'a.m4a', 'muxed.mp4']) await clean(ff, n)
  return new Blob([data.buffer ?? data], { type: 'video/mp4' })
}

// probe.js — Lê os metadados de um MP4 local SEM carregar o arquivo:
// varre os boxes de nível superior (ftyp/moov/mdat…), baixa só o moov
// (alguns MB, mesmo em vídeos de 11GB — na GoPro ele fica no FIM do
// arquivo) e entrega pro mp4box interpretar.
//
// Retorna { duration, fps, width, height, videoCodec, audioCodec,
//           videoTrackId, audioTrackId, nbSamples, boxes:{ftyp,moov} }
// `boxes` é reaproveitado pelo motor WebCodecs (demux sem re-ler).

import MP4Box from 'mp4box'

async function readRange(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

// Varre boxes de nível superior: [{type, start, size}]
export async function scanTopBoxes(file) {
  const boxes = []
  let offset = 0
  const size = file.size
  while (offset + 8 <= size) {
    const head = await readRange(file, offset, Math.min(offset + 16, size))
    const dv = new DataView(head.buffer)
    let boxSize = dv.getUint32(0)
    const type = String.fromCharCode(head[4], head[5], head[6], head[7])
    if (boxSize === 1) {
      // largesize de 64 bits (mdat gigante da GoPro)
      boxSize = Number(dv.getBigUint64(8))
    } else if (boxSize === 0) {
      boxSize = size - offset // até o fim do arquivo
    }
    if (boxSize < 8) break
    boxes.push({ type, start: offset, size: boxSize })
    offset += boxSize
  }
  return boxes
}

export async function probeFile(file) {
  const tops = await scanTopBoxes(file)
  const ftypBox = tops.find((b) => b.type === 'ftyp')
  const moovBox = tops.find((b) => b.type === 'moov')
  if (!moovBox) throw new Error('MP4 sem moov — arquivo corrompido ou incompleto')

  const ftyp = ftypBox ? await readRange(file, ftypBox.start, ftypBox.start + ftypBox.size) : null
  const moov = await readRange(file, moovBox.start, moovBox.start + moovBox.size)

  const info = await new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile()
    mp4.onError = (e) => reject(new Error('mp4box: ' + e))
    mp4.onReady = (i) => resolve(i)
    if (ftyp) {
      const b = ftyp.buffer.slice(ftyp.byteOffset, ftyp.byteOffset + ftyp.byteLength)
      b.fileStart = ftypBox.start
      mp4.appendBuffer(b)
    }
    const m = moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength)
    m.fileStart = moovBox.start
    mp4.appendBuffer(m)
    mp4.flush()
  })

  const v = info.videoTracks?.[0]
  const a = info.audioTracks?.[0]
  if (!v) throw new Error('MP4 sem trilha de vídeo')

  const duration = v.duration && v.timescale ? v.duration / v.timescale : info.duration / info.timescale
  const fps = v.nb_samples && duration ? v.nb_samples / duration : 30

  return {
    duration,
    fps,
    width: v.track_width || v.video?.width || 0,
    height: v.track_height || v.video?.height || 0,
    videoCodec: v.codec, // ex.: 'avc1.640033' ou 'hvc1.1.6.L153.B0'
    audioCodec: a?.codec ?? null, // ex.: 'mp4a.40.2'
    videoTrackId: v.id,
    audioTrackId: a?.id ?? null,
    nbSamples: v.nb_samples,
    bitrate: v.bitrate || 0,
    boxes: { ftyp, ftypStart: ftypBox?.start ?? 0, moov, moovStart: moovBox.start },
    tops,
  }
}

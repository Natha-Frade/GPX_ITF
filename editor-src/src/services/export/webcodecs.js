// webcodecs.js — Motor de COMPOSIÇÃO no navegador com aceleração de
// hardware (WebCodecs). É o caminho usado quando a timeline tem trilhas
// sobrepostas (vídeo sobre vídeo), espaços vazios a manter, ou fontes de
// codec/resolução diferentes — casos em que stream copy é impossível.
//
// Pipeline (tudo por GPU quando o navegador suporta):
//   mp4box (demux por trechos, lendo o File por slices — nada de carregar
//   11GB) → VideoDecoder (HW) → OffscreenCanvas (compose por z) →
//   VideoEncoder H.264 (HW) → mp4-muxer.
// O áudio é montado à parte pelo ffmpeg.wasm (barato) e muxado no final.
//
// Requisitos: Chrome/Edge recentes. HEVC (GoPro) decodifica por HW no
// Windows; a saída é sempre H.264 (compatível com tudo).

import MP4Box from 'mp4box'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

const US = 1e6

function avcLevelFor(w, h, fps) {
  const mbps = (w * h * fps) / 256 // macroblocks/s aprox
  if (mbps <= 245760) return '640028' // 1080p30 — level 4.0
  if (mbps <= 522240) return '64002a' // 1080p60 — level 4.2
  if (mbps <= 983040) return '640033' // 4K30    — level 5.1
  return '640034' // 4K60 — level 5.2
}

// description (avcC/hvcC) pro VideoDecoder, extraída do moov via mp4box
function decoderDescription(mp4file, trackId) {
  const trak = mp4file.getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // tira o header do box
    }
  }
  return undefined
}

// ── Decodificador de UM segmento de UMA source ─────────────────────────
// Lê o arquivo por slices a partir do keyframe anterior ao `in`, alimenta
// o VideoDecoder e entrega frames em ordem de apresentação sob demanda.
class SegDecoder {
  constructor(source, inSec, outSec) {
    this.source = source
    this.in = inSec
    this.out = outSec
    this.frames = [] // VideoFrames decodificados, em ordem
    this.current = null // último frame "consumido" (ainda válido pra desenhar)
    this.eof = false
    this.error = null
    this._sampleDone = false
    this._readOffset = 0
    this._feeding = null
  }

  async init() {
    const { probe, file } = this.source
    const mp4 = (this.mp4 = MP4Box.createFile())
    this.file = file

    await new Promise((resolve, reject) => {
      mp4.onError = (e) => reject(new Error('mp4box: ' + e))
      mp4.onReady = () => resolve()
      const append = (bytes, start) => {
        const b = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        b.fileStart = start
        mp4.appendBuffer(b)
      }
      if (probe.boxes.ftyp) append(probe.boxes.ftyp, probe.boxes.ftypStart)
      append(probe.boxes.moov, probe.boxes.moovStart)
    })

    const desc = decoderDescription(mp4, probe.videoTrackId)
    this.decoder = new VideoDecoder({
      output: (frame) => this.frames.push(frame),
      error: (e) => (this.error = e),
    })
    const config = { codec: probe.videoCodec, hardwareAcceleration: 'prefer-hardware' }
    if (desc) config.description = desc
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) {
      config.hardwareAcceleration = 'no-preference'
      const sup2 = await VideoDecoder.isConfigSupported(config).catch(() => null)
      if (!sup2?.supported)
        throw new Error(`o navegador não decodifica ${probe.videoCodec} — atualize o Chrome/Edge`)
    }
    this.decoder.configure(config)

    this._pendingSamples = []
    mp4.onSamples = (id, user, samples) => {
      for (const s of samples) this._pendingSamples.push(s)
      this._lastSample = samples[samples.length - 1]?.number
    }
    mp4.setExtractionOptions(probe.videoTrackId, null, { nbSamples: 60 })
    mp4.start()

    // posiciona no keyframe anterior ao in
    const seek = mp4.seek(Math.max(0, this.in - 0.05), true)
    this._readOffset = seek.offset ?? 0
    this._feed() // dispara o abastecimento em background
  }

  // abastece o mp4box com slices do arquivo e o decoder com os samples
  async _pump() {
    const CHUNK = 8 * 1024 * 1024
    const outUs = this.out * US
    while (!this._sampleDone) {
      // manda samples pendentes pro decoder (com backpressure)
      while (this._pendingSamples.length) {
        if (this.decoder.decodeQueueSize > 40) {
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        const s = this._pendingSamples.shift()
        const cts = (s.cts / s.timescale) * US
        this.decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: cts,
            duration: (s.duration / s.timescale) * US,
            data: s.data,
          })
        )
        if (this._lastSample != null) {
          try { this.mp4.releaseUsedSamples(this.source.probe.videoTrackId, s.number) } catch {}
        }
        // passou do out: um keyframe de folga e encerra
        if (cts > outUs + 0.5 * US) {
          this._sampleDone = true
          break
        }
      }
      if (this._sampleDone) break

      // sem samples na fila: lê mais um pedaço do arquivo
      if (this._readOffset >= this.file.size) {
        this._sampleDone = true
        break
      }
      const end = Math.min(this._readOffset + CHUNK, this.file.size)
      const bytes = new Uint8Array(await this.file.slice(this._readOffset, end).arrayBuffer())
      const buf = bytes.buffer
      buf.fileStart = this._readOffset
      this._readOffset = end
      this.mp4.appendBuffer(buf)
    }
    try { await this.decoder.flush() } catch {}
    this.eof = true
  }

  _feed() {
    if (!this._feeding) this._feeding = this._pump().catch((e) => (this.error = this.error || e))
    return this._feeding
  }

  // frame a desenhar no instante tSec (tempo da SOURCE)
  async frameAt(tSec) {
    const tUs = tSec * US
    for (;;) {
      if (this.error) throw this.error
      // descarta frames que já passaram (mantém o último como current)
      while (this.frames.length && this.frames[0].timestamp + (this.frames[0].duration ?? 0) <= tUs) {
        this.current?.close()
        this.current = this.frames.shift()
      }
      if (this.frames.length && this.frames[0].timestamp <= tUs) {
        this.current?.close()
        this.current = this.frames.shift()
        return this.current
      }
      if (this.current && (this.frames.length || this.eof)) return this.current // segura o frame atual
      if (this.eof) return this.current // acabou: congela no último
      await new Promise((r) => setTimeout(r, 8))
    }
  }

  close() {
    for (const f of this.frames) f.close()
    this.frames = []
    this.current?.close()
    this.current = null
    try { this.decoder?.close() } catch {}
    try { this.mp4?.stop() } catch {}
  }
}

// ── Export da composição ───────────────────────────────────────────────
// intervals: composeIntervals(edl) — cada intervalo com os segmentos
// ativos em z asc. opts: {width,height,fps,bitrate, signal}
export async function exportCompose(intervals, getSource, opts, onStatus, onProgress) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('este navegador não tem WebCodecs — use Chrome ou Edge atualizados')
  }
  const { width, height, fps, bitrate } = opts
  const total = intervals.length ? intervals[intervals.length - 1].b : 0
  const totalFrames = Math.max(1, Math.round(total * fps))

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  let encError = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encError = e),
  })
  const encConfig = {
    codec: 'avc1.' + avcLevelFor(width, height, fps),
    width,
    height,
    framerate: fps,
    bitrate,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  }
  const sup = await VideoEncoder.isConfigSupported(encConfig).catch(() => null)
  if (!sup?.supported) {
    encConfig.hardwareAcceleration = 'no-preference'
    const sup2 = await VideoEncoder.isConfigSupported(encConfig).catch(() => null)
    if (!sup2?.supported) throw new Error('o navegador não codifica H.264 nesta resolução')
  }
  encoder.configure(encConfig)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')

  let frameIdx = 0
  const keyEvery = Math.round(fps * 2)

  for (const iv of intervals) {
    if (opts.signal?.aborted) throw new Error('exportação cancelada')

    // decodificadores dos segmentos ativos deste intervalo
    const decs = []
    for (const seg of iv.segs) {
      const src = getSource(seg.source_id)
      const sIn = seg.in + (iv.a - seg.start)
      const sOut = seg.in + (iv.b - seg.start)
      const d = new SegDecoder(src, sIn, sOut)
      onStatus && onStatus(`Preparando ${src.path}…`)
      await d.init()
      decs.push({ seg, src, dec: d })
    }

    const endFrame = Math.round(iv.b * fps)
    onStatus &&
      onStatus(iv.segs.length ? `Renderizando ${iv.a.toFixed(1)}s → ${iv.b.toFixed(1)}s (GPU)…` : 'Trecho vazio (tela preta)…')

    while (frameIdx < endFrame) {
      if (opts.signal?.aborted) {
        decs.forEach((d) => d.dec.close())
        throw new Error('exportação cancelada')
      }
      if (encError) throw encError
      const T = frameIdx / fps

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      for (const { seg, dec } of decs) {
        const t = seg.in + (T - seg.start)
        const frame = await dec.frameAt(t)
        if (frame) {
          // "cover": preenche o canvas mantendo proporção
          const fw = frame.displayWidth || width
          const fh = frame.displayHeight || height
          const scale = Math.max(width / fw, height / fh)
          const dw = fw * scale
          const dh = fh * scale
          ctx.drawImage(frame, (width - dw) / 2, (height - dh) / 2, dw, dh)
        }
      }

      const vf = new VideoFrame(canvas, { timestamp: T * US, duration: US / fps })
      encoder.encode(vf, { keyFrame: frameIdx % keyEvery === 0 })
      vf.close()
      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 5))
      }

      frameIdx++
      if (frameIdx % 15 === 0) onProgress && onProgress(frameIdx / totalFrames)
    }
    decs.forEach((d) => d.dec.close())
  }

  onStatus && onStatus('Finalizando o vídeo…')
  await encoder.flush()
  encoder.close()
  muxer.finalize()
  onProgress && onProgress(1)
  return new Blob([muxer.target.buffer], { type: 'video/mp4' })
}

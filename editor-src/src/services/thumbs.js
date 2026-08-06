// thumbs.js — thumbnail de um vídeo direto no navegador (canvas).
// Usa um <video> descartável, busca ~1s e captura o frame em JPEG pequeno.

export function makeThumb(url, t = 1.0) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    v.src = url
    const fail = () => reject(new Error('thumb: vídeo não carregou'))
    v.onerror = fail
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(t, Math.max(0, (v.duration || 2) - 0.1))
    }
    v.onseeked = () => {
      try {
        const w = 160
        const h = Math.round((w * v.videoHeight) / Math.max(v.videoWidth, 1)) || 90
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(v, 0, 0, w, h)
        resolve(c.toDataURL('image/jpeg', 0.6))
      } catch (e) {
        reject(e) // codec sem suporte no navegador (ex.: HEVC em alguns PCs)
      } finally {
        v.removeAttribute('src')
        v.load()
      }
    }
    setTimeout(fail, 15000)
  })
}

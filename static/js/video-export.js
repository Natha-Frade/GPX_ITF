// ══════════════════════════════════════════════════════════════════════
//  video-export.js — Corte e junção de VÍDEO no navegador (ffmpeg.wasm)
//
//  Como funciona:
//  - Carrega o ffmpeg compilado em WebAssembly (sob demanda, via CDN,
//    ~31 MB na primeira vez — depois fica no cache do navegador).
//  - Os cortes usam "stream copy" (-c copy): NÃO re-encoda o vídeo.
//    É rápido (segundos) e sem perda de qualidade. O corte é alinhado
//    ao keyframe anterior — na GoPro isso significa até ~1s antes do
//    instante pedido.
//  - A junção usa o concat demuxer (-c copy): ideal para capítulos da
//    GoPro (GX010001 + GX020001 + ...), que têm codec idêntico.
//  - O arquivo de entrada é MONTADO (WORKERFS), não copiado para a
//    memória — por isso funciona com vídeos de vários GB. O que precisa
//    caber na memória é só o TRECHO exportado (limite prático ~1.5 GB
//    por trecho de saída).
//
//  Dependências (injetadas sob demanda, padrão do streetview.js):
//    @ffmpeg/ffmpeg 0.12 (UMD) + @ffmpeg/util (UMD) + @ffmpeg/core (ST)
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const CDN_FFMPEG = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
  const CDN_UTIL   = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js';
  const CDN_CORE   = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

  let _loadPromise = null;
  let _ffmpeg = null;
  let _cancelado = false;

  // ── Carregamento sob demanda ─────────────────────────────────────────
  function _injectScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => rej(new Error('Falha ao baixar ' + src));
      document.head.appendChild(s);
    });
  }

  async function _ensureFFmpeg(onStatus) {
    if (_ffmpeg) return _ffmpeg;
    if (!_loadPromise) {
      _loadPromise = (async () => {
        onStatus && onStatus('Baixando motor de vídeo (primeira vez ~31 MB)...');
        if (!window.FFmpegWASM) await _injectScript(CDN_FFMPEG);
        if (!window.FFmpegUtil) await _injectScript(CDN_UTIL);
        const { FFmpeg } = window.FFmpegWASM;
        const { toBlobURL } = window.FFmpegUtil;
        const ff = new FFmpeg();
        await ff.load({
          coreURL: await toBlobURL(CDN_CORE + '/ffmpeg-core.js', 'text/javascript'),
          wasmURL: await toBlobURL(CDN_CORE + '/ffmpeg-core.wasm', 'application/wasm'),
        });
        _ffmpeg = ff;
        return ff;
      })().catch(e => { _loadPromise = null; throw e; });
    }
    return _loadPromise;
  }

  // ── Monta os arquivos de entrada sem copiar para a memória ──────────
  async function _mount(ff, files) {
    try {
      await ff.createDir('/work');
      await ff.mount('WORKERFS', { files }, '/work');
      return { dir: '/work', mounted: true };
    } catch (e) {
      // Fallback: copia para o FS em memória (só seguro p/ arquivos menores)
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > 1.6 * 1024 * 1024 * 1024) {
        throw new Error('Vídeo grande demais para este navegador sem WORKERFS. ' +
          'Use Chrome/Edge atualizados.');
      }
      const { fetchFile } = window.FFmpegUtil;
      for (const f of files) await ff.writeFile('/' + f.name, await fetchFile(f));
      return { dir: '', mounted: false };
    }
  }

  async function _unmount(ff, m, files) {
    try {
      if (m.mounted) { await ff.unmount('/work'); await ff.deleteDir('/work'); }
      else for (const f of files) await ff.deleteFile('/' + f.name).catch(() => {});
    } catch (_) {}
  }

  function _baixarBlob(u8, nome) {
    const blob = new Blob([u8.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  const _fmtT = s => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3);
    return `${h}:${String(m).padStart(2, '0')}:${sec.padStart(6, '0')}`;
  };

  // ── API pública: exportar cortes como MP4 ────────────────────────────
  // cuts: [{startSec, endSec}], file: File do vídeo carregado
  async function videoExportarCortesMP4(file, cuts, onStatus, onProgress) {
    if (!file) throw new Error('Nenhum vídeo carregado.');
    if (!cuts || !cuts.length) throw new Error('Nenhum corte definido na timeline.');
    _cancelado = false;

    const ff = await _ensureFFmpeg(onStatus);
    const progHandler = ({ progress }) => onProgress && onProgress(Math.min(1, progress));
    ff.on('progress', progHandler);

    const m = await _mount(ff, [file]);
    const inPath = (m.dir ? m.dir + '/' : '/') + file.name;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    let ok = 0;

    try {
      for (let i = 0; i < cuts.length; i++) {
        if (_cancelado) break;
        const c = cuts[i];
        const dur = c.endSec - c.startSec;
        if (dur <= 0) continue;
        onStatus && onStatus(`Cortando trecho ${i + 1}/${cuts.length} ` +
          `(${_fmtT(c.startSec)} → ${_fmtT(c.endSec)})...`);
        const out = `corte_${i + 1}.mp4`;
        await ff.exec([
          '-ss', _fmtT(c.startSec),
          '-i', inPath,
          '-t', _fmtT(dur),
          '-map', '0',
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          out,
        ]);
        const data = await ff.readFile(out);
        await ff.deleteFile(out).catch(() => {});
        _baixarBlob(data, `${baseName}_corte${i + 1}.mp4`);
        ok++;
      }
    } finally {
      ff.off('progress', progHandler);
      await _unmount(ff, m, [file]);
    }
    return ok;
  }

  // ── API pública: juntar vários vídeos em um só ───────────────────────
  // files: File[] na ordem desejada (ex.: capítulos GX01, GX02...)
  async function videoJuntarMP4(files, onStatus, onProgress) {
    if (!files || files.length < 2) throw new Error('Selecione 2 ou mais vídeos.');
    _cancelado = false;

    const ff = await _ensureFFmpeg(onStatus);
    const progHandler = ({ progress }) => onProgress && onProgress(Math.min(1, progress));
    ff.on('progress', progHandler);

    const m = await _mount(ff, files);
    const pref = m.dir ? m.dir + '/' : '/';
    // Lista para o concat demuxer (aspas simples + escape)
    const lista = files.map(f =>
      "file '" + (pref + f.name).replace(/'/g, "'\\''") + "'").join('\n');
    await ff.writeFile('lista.txt', lista);

    try {
      onStatus && onStatus(`Juntando ${files.length} vídeos (sem re-encode)...`);
      await ff.exec([
        '-f', 'concat', '-safe', '0',
        '-i', 'lista.txt',
        '-map', '0',
        '-c', 'copy',
        'unido.mp4',
      ]);
      const data = await ff.readFile('unido.mp4');
      await ff.deleteFile('unido.mp4').catch(() => {});
      const nome = files[0].name.replace(/\.[^.]+$/, '') + `_unido_${files.length}partes.mp4`;
      _baixarBlob(data, nome);
    } finally {
      ff.off('progress', progHandler);
      await ff.deleteFile('lista.txt').catch(() => {});
      await _unmount(ff, m, files);
    }
    return true;
  }

  function videoExportCancelar() { _cancelado = true; }

  window.videoExportarCortesMP4 = videoExportarCortesMP4;
  window.videoJuntarMP4 = videoJuntarMP4;
  window.videoExportCancelar = videoExportCancelar;
})();

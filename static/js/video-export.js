// video-export.js
// Corte e junção de video no navegador usando ffmpeg.wasm.
// - Corte com stream copy (-c copy): sem re-encode, sem perda, rápido.
//   O ponto de corte alinha ao keyframe anterior (~1s na GoPro).
// - O arquivo de entrada é montado (WORKERFS), não copiado: funciona
//   com videos de varios GB. Só o trecho de SAIDA precisa caber na
//   memoria (limite pratico ~1.5 GB por trecho).
// - Motor baixado sob demanda do CDN (~31 MB, fica em cache).

(function () {
  'use strict';

  // Fontes do motor, em ordem de tentativa:
  //  1) LOCAL — hospedado no próprio app (static/vendor/ffmpeg, ver
  //     Dockerfile) → funciona mesmo com a rede da empresa bloqueando CDN;
  //  2/3) CDNs públicos como fallback (uso local sem o vendor baixado).
  const CDNS = [
    {
      ffmpeg: '/vendor/ffmpeg/ffmpeg.js',
      util:   '/vendor/ffmpeg/util.js',
      core:   '/vendor/ffmpeg-mt',   // core MULTI-THREAD (bem mais rápido)
      worker: '/vendor/ffmpeg-mt/ffmpeg-core.worker.js',
      mt:     true,
      local:  true,
    },
    {
      ffmpeg: '/vendor/ffmpeg/ffmpeg.js',
      util:   '/vendor/ffmpeg/util.js',
      core:   '/vendor/ffmpeg',      // core single-thread (fallback)
      local:  true,
    },
    {
      ffmpeg: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
      util:   'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
      core:   'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    },
    {
      ffmpeg: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
      util:   'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js',
      core:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
    },
  ];

  let _loadPromise = null;
  let _ffmpeg = null;
  let _ffmpegMT = false;
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
        onStatus && onStatus('Carregando motor de vídeo...');
        let ultimoErro = null;
        for (const cdn of CDNS) {
          try {
            // O core multi-thread só funciona com cross-origin isolation
            // (SharedArrayBuffer). Se não estiver disponível, pula p/ o
            // single-thread.
            if (cdn.mt && !self.crossOriginIsolated) {
              throw new Error('sem cross-origin isolation p/ multi-thread');
            }
            if (cdn.local) {
              // só tenta o vendor local se ele realmente existir no servidor
              const head = await fetch(cdn.core + '/ffmpeg-core.js', { method: 'HEAD' }).catch(() => null);
              if (!head || !head.ok) throw new Error('vendor local ausente');
            } else {
              onStatus && onStatus('Baixando motor de vídeo do CDN (primeira vez ~31 MB)...');
            }
            if (!window.FFmpegWASM) await _injectScript(cdn.ffmpeg);
            if (!window.FFmpegUtil) await _injectScript(cdn.util);
            const { FFmpeg } = window.FFmpegWASM;
            const { toBlobURL } = window.FFmpegUtil;
            const ff = new FFmpeg();
            const cfg = {
              coreURL: await toBlobURL(cdn.core + '/ffmpeg-core.js', 'text/javascript'),
              wasmURL: await toBlobURL(cdn.core + '/ffmpeg-core.wasm', 'application/wasm'),
            };
            if (cdn.mt && cdn.worker) {
              onStatus && onStatus('Carregando motor de vídeo (multi-thread, mais rápido)...');
              cfg.workerURL = await toBlobURL(cdn.worker, 'text/javascript');
            }
            await ff.load(cfg);
            _ffmpeg = ff;
            _ffmpegMT = !!cdn.mt;
            return ff;
          } catch (e) {
            ultimoErro = e;
            onStatus && onStatus('Tentando outra configuração do motor...');
          }
        }
        throw new Error('Não consegui baixar o motor de vídeo (rede bloqueando ' +
          'unpkg.com e cdn.jsdelivr.net?). Detalhe: ' + (ultimoErro?.message || ''));
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
    _baixarBlobDireto(new Blob([u8.buffer], { type: 'video/mp4' }), nome);
  }

  function _baixarBlobDireto(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  const _fmtT = s => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3);
    return `${h}:${String(m).padStart(2, '0')}:${sec.padStart(6, '0')}`;
  };

  // ── NÚCLEO: corta e devolve Blobs (usado pelo export e pelo handoff) ─
  // cuts: [{startSec, endSec}], file: File do vídeo carregado
  // modo: 'reencode' (padrão) -> H.264 universal, abre no Windows Media
  //        Player; mais lento (usado no DOWNLOAD do .mp4 final).
  //       'copy' -> corte rápido em stream-copy, SEM re-encode; usado no
  //        envio para o EDITOR, que reprocessa o vídeo internamente na
  //        hora de exportar (então não precisa do re-encode aqui — era o
  //        que travava "meia hora" ao mandar pro editor).
  // retorna [{ nome, blob }]
  async function videoCortarParaBlobs(file, cuts, onStatus, onProgress, modo) {
    if (!file) throw new Error('Nenhum vídeo carregado.');
    if (!cuts || !cuts.length) throw new Error('Nenhum corte definido na timeline.');
    _cancelado = false;
    const rapido = modo === 'copy';

    const ff = await _ensureFFmpeg(onStatus);
    const progHandler = ({ progress }) => onProgress && onProgress(Math.min(1, progress));
    ff.on('progress', progHandler);

    const m = await _mount(ff, [file]);
    const inPath = (m.dir ? m.dir + '/' : '/') + file.name;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const saida = [];

    try {
      for (let i = 0; i < cuts.length; i++) {
        if (_cancelado) break;
        const c = cuts[i];
        const dur = c.endSec - c.startSec;
        if (dur <= 0) continue;
        onStatus && onStatus(
          (rapido ? 'Preparando' : 'Cortando') + ` trecho ${i + 1}/${cuts.length} ` +
          `(${_fmtT(c.startSec)} → ${_fmtT(c.endSec)})...`);
        const out = `corte_${i + 1}.mp4`;

        const comum = [
          '-ss', _fmtT(c.startSec),
          '-i', inPath,
          '-t', _fmtT(dur),
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-dn',
          '-map_metadata', '-1',
          '-map_chapters', '-1',
        ];

        if (rapido) {
          // Corte RÁPIDO em stream-copy (segundos) para enviar ao EDITOR,
          // que re-encoda depois no export dele. Usa -ss como OUTPUT seek
          // (depois do -i) para o trecho começar no keyframe correto e o
          // preview do editor não ficar preto no frame 0.
          await ff.exec([
            '-i', inPath,
            '-ss', _fmtT(c.startSec),
            '-t', _fmtT(dur),
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-dn',
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            out,
          ]);
        } else {
          // Corte com RE-ENCODE p/ H.264 + AAC (receita do editor local,
          // backend/app/engine.py -> trim), compatível com Windows Media
          // Player. Mais lento, mas gera um MP4 universal p/ download.
          await ff.exec([
            ...comum,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-threads', _ffmpegMT ? '0' : '1',   // 0 = usa todos os núcleos (core-mt)
            '-c:a', 'aac', '-ar', '48000',
            '-vsync', 'cfr',
            '-movflags', '+faststart',
            out,
          ]);
        }
        const data = await ff.readFile(out);
        await ff.deleteFile(out).catch(() => {});
        saida.push({
          nome: `${baseName}_corte${i + 1}.mp4`,
          blob: new Blob([data.buffer], { type: 'video/mp4' }),
        });
      }
    } finally {
      ff.off('progress', progHandler);
      await _unmount(ff, m, [file]);
    }
    return saida;
  }

  // ── API pública: exportar cortes como MP4 (download) ─────────────────
  // 1 corte = baixa o .mp4 direto; vários = 1 único .zip (o navegador
  // bloqueia downloads múltiplos em sequência — era um dos motivos da
  // exportação "não funcionar").
  async function videoExportarCortesMP4(file, cuts, onStatus, onProgress, modo) {
    const blobs = await videoCortarParaBlobs(file, cuts, onStatus, onProgress, modo);
    if (!blobs.length) return 0;

    if (blobs.length === 1 || typeof JSZip === 'undefined') {
      for (const b of blobs) {
        _baixarBlobDireto(b.blob, b.nome);
        // pequeno respiro entre downloads quando não há JSZip
        if (blobs.length > 1) await new Promise(r => setTimeout(r, 900));
      }
      return blobs.length;
    }

    onStatus && onStatus('Empacotando ' + blobs.length + ' cortes num .zip...');
    const zip = new JSZip();
    blobs.forEach(b => zip.file(b.nome, b.blob));
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const base = file.name.replace(/\.[^.]+$/, '');
    _baixarBlobDireto(zipBlob, base + '_cortes.zip');
    return blobs.length;
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
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        '-movflags', '+faststart',
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
  window.videoCortarParaBlobs   = videoCortarParaBlobs;
  window.videoJuntarMP4 = videoJuntarMP4;
  window.videoExportCancelar = videoExportCancelar;
  // Internos expostos p/ o editor (editor-ffmpeg.js)
  window._ffmpegEnsure  = _ensureFFmpeg;
  window._ffmpegMount   = _mount;
  window._ffmpegUnmount = _unmount;
})();

// editor-ffmpeg.js
// Exportação do Editor usando ffmpeg.wasm (video-export.js).
// Substitui o MediaRecorder (re-encodava em tempo real, com perda)
// por corte real com stream copy, e adiciona a exportação da
// timeline inteira: apara cada clipe e concatena em um MP4 só.

(function () {
  'use strict';

  const _ffStatus = msg => {
    const el = document.getElementById('ffStatus');
    if (el) el.textContent = msg || '';
  };
  const _ffFill = p => {
    const el = document.getElementById('ffFill');
    if (el) el.style.width = (p * 100).toFixed(0) + '%';
  };

  // ── Baixar UM segmento do clipe ativo (substitui MediaRecorder) ─────
  const _downloadSegOriginal = window.downloadSeg; // fallback
  window.downloadSeg = async function (i) {
    const seg = getSegments()[i];
    if (!seg || !activeClip) return;
    if (typeof videoExportarCortesMP4 !== 'function') {
      return _downloadSegOriginal && _downloadSegOriginal(i);
    }
    try {
      toast('Cortando segmento ' + (i + 1) + ' (sem re-encode)...', '');
      await videoExportarCortesMP4(
        activeClip.file,
        [{ startSec: seg.start, endSec: seg.end }],
        _ffStatus, _ffFill
      );
      _ffStatus('Segmento ' + (i + 1) + ' baixado.');
      toast('Segmento ' + (i + 1) + ' exportado', 'success');
    } catch (e) {
      console.error('[ffmpeg]', e);
      toast('ffmpeg falhou (' + e.message + ') — usando gravação alternativa', 'warn');
      if (_downloadSegOriginal) _downloadSegOriginal(i);
    } finally {
      setTimeout(() => _ffFill(0), 1500);
    }
  };

  // ── Exportar a TIMELINE INTEIRA como um único MP4 ────────────────────
  // Apara cada item (trimStart/trimEnd) com -c copy e concatena na ordem.
  // Requisito: clipes com o MESMO codec/resolução (capítulos GoPro ok).
  window.exportTimelineMP4 = async function () {
    if (!timeline.length) { toast('Timeline vazia — adicione clipes com o botão +', 'error'); return; }
    if (typeof window._ffmpegEnsure !== 'function') {
      toast('video-export.js não carregado', 'error'); return;
    }
    const btn = document.getElementById('ffTimelineBtn');
    if (btn) btn.disabled = true;
    _ffFill(0);

    try {
      const ff = await window._ffmpegEnsure(_ffStatus);
      const progHandler = ({ progress }) => _ffFill(Math.min(1, progress));
      ff.on('progress', progHandler);

      // Monta todos os arquivos únicos usados na timeline
      const arquivos = [];
      const vistos = new Set();
      for (const seg of timeline) {
        const item = library.find(l => l.id === seg.clipId);
        if (item && !vistos.has(item.name)) { vistos.add(item.name); arquivos.push(item.file); }
      }
      const m = await window._ffmpegMount(ff, arquivos);
      const pref = m.dir ? m.dir + '/' : '/';

      try {
        // 1) Apara cada item da timeline (stream copy)
        const partes = [];
        for (let i = 0; i < timeline.length; i++) {
          const seg  = timeline[i];
          const item = library.find(l => l.id === seg.clipId);
          if (!item) continue;
          const dur = seg.trimEnd - seg.trimStart;
          _ffStatus(`Aparando parte ${i + 1}/${timeline.length} (${item.name.slice(0, 22)})...`);
          const out = `parte_${i}.mp4`;
          const args = ['-i', pref + item.name, '-map', '0', '-c', 'copy',
                        '-avoid_negative_ts', 'make_zero', out];
          // Só aplica -ss/-t se houve aparo real (evita perda de keyframe à toa)
          if (seg.trimStart > 0.05) args.unshift('-ss', String(seg.trimStart.toFixed(3)));
          if (dur < item.dur - 0.05) args.splice(args.indexOf(out), 0, '-t', String(dur.toFixed(3)));
          await ff.exec(args);
          partes.push(out);
        }

        // 2) Concatena as partes
        _ffStatus('Unindo ' + partes.length + ' parte(s)...');
        const lista = partes.map(p => "file '" + p + "'").join('\n');
        await ff.writeFile('lista.txt', lista);
        await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'lista.txt',
                       '-map', '0', '-c', 'copy', 'timeline_final.mp4']);

        const data = await ff.readFile('timeline_final.mp4');
        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const ts   = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        a.href = url; a.download = `timeline_${ts}.mp4`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 8000);

        // Limpeza do FS em memória
        for (const p of partes) await ff.deleteFile(p).catch(() => {});
        await ff.deleteFile('lista.txt').catch(() => {});
        await ff.deleteFile('timeline_final.mp4').catch(() => {});

        _ffStatus('Timeline exportada (' + partes.length + ' parte(s), sem re-encode).');
        _ffFill(1);
        toast('Timeline exportada como MP4 único', 'success');
      } finally {
        ff.off('progress', progHandler);
        await window._ffmpegUnmount(ff, m, arquivos);
      }
    } catch (e) {
      console.error('[timeline export]', e);
      _ffStatus('Erro: ' + e.message);
      toast('Erro ao exportar timeline: ' + e.message +
        (String(e.message).match(/codec|match/i) ? ' — os clipes precisam ter o mesmo formato' : ''), 'error');
    } finally {
      if (btn) btn.disabled = false;
      setTimeout(() => _ffFill(0), 2500);
    }
  };
})();

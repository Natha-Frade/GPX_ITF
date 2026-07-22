// batch-browser.js
// Conversão GoPro -> GPX 100% no navegador (modo "Navegador" da aba lote).
// Nada é enviado ao servidor: o gpmf.js lê os MP4 em chunks direto do
// disco e gera os .gpx localmente. Para pastas do SharePoint, basta
// sincronizar a biblioteca pelo OneDrive e selecionar a pasta local.
// Sai um .zip com todos os GPX, preservando subpastas.
// Depende de: gpmf.js e JSZip. Chrome/Edge usam showDirectoryPicker();
// os demais caem no <input webkitdirectory>.

(function () {
  'use strict';

  const EXTS = ['.mp4', '.mov'];
  let _arquivos = [];   // [{ file: File, rel: 'sub/GX010001.MP4' }]
  let _rodando = false;

  function _isVideo(nome) {
    const n = nome.toLowerCase();
    return EXTS.some(e => n.endsWith(e));
  }

  // ── Seleção da pasta ─────────────────────────────────────────────────
  async function browserPick() {
    _arquivos = [];
    try {
      if (window.showDirectoryPicker) {
        const dir = await window.showDirectoryPicker();
        await _varrer(dir, '');
      } else {
        // Fallback: input com webkitdirectory
        await new Promise((resolve) => {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.webkitdirectory = true;
          inp.onchange = () => {
            for (const f of inp.files) {
              if (_isVideo(f.name)) {
                _arquivos.push({ file: f, rel: f.webkitRelativePath || f.name });
              }
            }
            resolve();
          };
          inp.click();
        });
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // usuário cancelou
      alert('Erro ao abrir a pasta: ' + e.message);
      return;
    }
    _renderLista();
  }

  async function _varrer(dirHandle, prefixo) {
    for await (const [nome, handle] of dirHandle.entries()) {
      const rel = prefixo ? `${prefixo}/${nome}` : nome;
      if (handle.kind === 'directory') {
        await _varrer(handle, rel);
      } else if (_isVideo(nome)) {
        const file = await handle.getFile();
        _arquivos.push({ file, rel });
      }
    }
  }

  function _renderLista() {
    const box = document.getElementById('browserList');
    const info = document.getElementById('browserInfo');
    if (!box) return;
    if (!_arquivos.length) {
      box.innerHTML = '<div class="batch-empty">Nenhum vídeo (.mp4/.mov) na pasta selecionada.</div>';
      if (info) info.textContent = '';
      return;
    }
    _arquivos.sort((a, b) => a.rel.localeCompare(b.rel));
    const totMB = _arquivos.reduce((s, a) => s + a.file.size, 0) / 1048576;
    if (info) info.textContent =
      `${_arquivos.length} vídeo(s) • ${totMB.toFixed(0)} MB • processados no SEU computador (sem upload)`;
    box.innerHTML = _arquivos.map(a => `
      <div class="batch-row">
        <span class="batch-name" title="${_esc(a.rel)}">${_esc(a.rel)}</span>
        <span class="batch-size">${(a.file.size / 1048576).toFixed(0)} MB</span>
      </div>`).join('');
  }

  // ── Decimação 1Hz (mesmo comportamento do exiftool/servidor) ─────────
  function _decimar1hz(points) {
    const out = [];
    let ultimo = null;
    for (const p of points) {
      const seg = p.ts ? p.ts.slice(0, 19) : null; // YYYY-MM-DDTHH:MM:SS
      if (seg === null) { out.push(p); continue; }
      if (seg !== ultimo) {
        out.push(Object.assign({}, p, { ts: seg + 'Z' }));
        ultimo = seg;
      }
    }
    return out;
  }

  // ── Conversão em lote ────────────────────────────────────────────────
  // browserStart: pasta selecionada (modo Navegador).
  // browserRunLista: recebe lista lazy [{rel, getFile: async () => File}] —
  //   usada pelo modo "Arrastar ZIP" (extrai 1 vídeo por vez, sem estourar
  //   a memória com o zip inteiro).
  async function browserStart() {
    if (!_arquivos.length) { alert('Selecione uma pasta primeiro.'); return; }
    return browserRunLista(_arquivos.map(a => ({ rel: a.rel, getFile: async () => a.file })));
  }

  async function browserRunLista(lista) {
    if (_rodando) return;
    if (!lista || !lista.length) { alert('Nenhum vídeo para converter.'); return; }
    if (typeof extractGPMF !== 'function' || typeof JSZip === 'undefined') {
      alert('gpmf.js ou JSZip não carregados — verifique os <script> do index.html.');
      return;
    }
    _rodando = true;

    const um1hz = document.getElementById('batch1hz')?.checked;
    const go = document.getElementById('batchStart');
    const lbl = document.getElementById('batchProgLbl');
    const fill = document.getElementById('batchProgFill');
    if (go) { go.disabled = true; go.textContent = 'CONVERTENDO...'; }

    const zip = new JSZip();
    const usados = {};
    let ok = 0, semGps = 0;

    try {
      for (let i = 0; i < lista.length; i++) {
        const rel = lista[i].rel;
        if (lbl) lbl.textContent = `[${i + 1}/${lista.length}] ${rel} — abrindo...`;
        const file = await lista[i].getFile();
        const base = ((i) / lista.length) * 100;
        const passo = 100 / lista.length;

        const { points, device } = await extractGPMF(file, (pct, msg) => {
          if (fill) fill.style.width = (base + (pct / 100) * passo).toFixed(1) + '%';
          if (lbl) lbl.textContent = `[${i + 1}/${lista.length}] ${rel} — ${msg}`;
        });

        if (!points.length) { semGps++; continue; }

        const pts = um1hz ? _decimar1hz(points) : points;
        const nomeTrk = file.name.replace(/\.(mp4|mov)$/i, '');
        const gpx = buildGPXFromPoints(pts, `${nomeTrk} (${device})`);

        // Caminho no zip preservando subpastas, com dedup de nomes
        let zpath = rel.replace(/\.(mp4|mov)$/i, '.gpx');
        if (usados[zpath]) {
          usados[zpath]++;
          zpath = zpath.replace(/\.gpx$/i, `_${usados[zpath]}.gpx`);
        } else {
          usados[zpath] = 1;
        }
        zip.file(zpath, gpx);
        ok++;
      }

      if (ok === 0) {
        throw new Error('Nenhum vídeo continha dados de GPS (verifique se o GPS estava LIGADO na GoPro).');
      }

      if (lbl) lbl.textContent = 'Compactando ZIP...';
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (meta) => { if (fill) fill.style.width = meta.percent.toFixed(0) + '%'; }
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url; a.download = `gpx_gopro_${ts}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      if (fill) fill.style.width = '100%';
      if (lbl) lbl.textContent = `Concluído: ${ok} GPX gerado(s), ${semGps} sem GPS. ZIP baixado.`;
    } catch (e) {
      if (lbl) lbl.textContent = 'Erro: ' + e.message;
      if (fill) fill.style.width = '0%';
    } finally {
      _rodando = false;
      if (go) { go.disabled = false; go.textContent = 'CONVERTER TUDO'; }
    }
  }

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.batchBrowserPick = browserPick;
  window.batchBrowserStart = browserStart;
  window.batchBrowserRunLista = browserRunLista;
  window.batchBrowserTemVideos = () => _arquivos.length > 0;
})();

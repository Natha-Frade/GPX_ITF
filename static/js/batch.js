// ══════════════════════════════════════════════════════════════════════
//  batch.js — Conversor GoPro → GPX (backend exiftool local)
//
//  3 modos de entrada:
//   • Pasta local  -> POST /api/gopro/converter    { pasta, recursivo, um_hz }
//   • Arrastar ZIP -> POST /api/gopro/converter-zip (multipart)
//   • Link Drive   -> POST /api/gopro/converter-drive { link, um_hz }
//
//  Se o exiftool faltar, oferece instalação automática (POST /api/gopro/instalar).
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  let _rodando = false;
  let _modo = 'pasta';
  let _zipFile = null;

  // ── STATUS / INSTALAÇÃO ──────────────────────────────────────────────
  async function batchCheckStatus() {
    const el = document.getElementById('batchStatus');
    const btnInst = document.getElementById('batchInstall');
    if (!el) return;
    el.textContent = 'Verificando exiftool no servidor...';
    el.className = 'batch-status';
    if (btnInst) btnInst.style.display = 'none';
    try {
      const r = await fetch('/api/gopro/status', {
        headers: { 'Authorization': 'Bearer ' + apiToken() },
      });
      const j = await r.json();
      if (j.disponivel) {
        el.textContent = `✓ exiftool ${j.versao} pronto (modo rápido, local).`;
        el.className = 'batch-status ok';
      } else {
        el.innerHTML = '⚠ exiftool não encontrado no servidor. ' +
          'Clique abaixo para instalar automaticamente.';
        el.className = 'batch-status warn';
        if (btnInst) btnInst.style.display = '';
      }
    } catch (e) {
      el.textContent = 'Não consegui verificar o exiftool: ' + e.message;
      el.className = 'batch-status warn';
    }
  }

  async function batchInstall() {
    const el = document.getElementById('batchStatus');
    const btn = document.getElementById('batchInstall');
    if (btn) { btn.disabled = true; btn.textContent = 'Baixando e instalando exiftool...'; }
    if (el) { el.textContent = 'Baixando exiftool da fonte oficial... aguarde.'; el.className = 'batch-status'; }
    try {
      const r = await fetch('/api/gopro/instalar', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken() },
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || 'Falha na instalação');
      }
      const j = await r.json();
      if (el) {
        el.textContent = `✓ exiftool ${j.versao} instalado! Iniciando conversão...`;
        el.className = 'batch-status ok';
      }
      if (btn) btn.style.display = 'none';
      // Avisa e já começa a conversão automaticamente
      setTimeout(() => batchStart(), 800);
    } catch (e) {
      if (el) { el.innerHTML = 'Não foi possível instalar automaticamente: ' + _esc(e.message) +
        '<br>Baixe manualmente em exiftool.org e coloque na pasta do servidor.';
        el.className = 'batch-status warn'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Tentar instalar novamente'; }
    }
  }

  // ── SELETOR DE MODO ──────────────────────────────────────────────────
  function batchMode(m) {
    _modo = m;
    document.querySelectorAll('.batch-mode').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === m));
    ['pasta', 'zip', 'drive', 'browser'].forEach(id => {
      const pane = document.getElementById('pane-' + id);
      if (pane) pane.style.display = (id === m) ? '' : 'none';
    });
  }

  // ── MODO PASTA: listar ───────────────────────────────────────────────
  async function batchListar() {
    const pasta = document.getElementById('batchPasta')?.value.trim();
    const rec = document.getElementById('batchRec')?.checked;
    if (!pasta) { alert('Informe o caminho da pasta.'); return; }
    const box = document.getElementById('batchList');
    box.innerHTML = '<div class="batch-empty">Listando...</div>';
    try {
      const r = await fetch('/api/gopro/listar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken() },
        body: JSON.stringify({ pasta, recursivo: !!rec }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || 'Erro ao listar');
      }
      const j = await r.json();
      _render(j.videos);
    } catch (e) {
      box.innerHTML = `<div class="batch-empty" style="color:#d05c5c">${_esc(e.message)}</div>`;
    }
  }

  function _render(videos) {
    const box = document.getElementById('batchList');
    const info = document.getElementById('batchInfo');
    if (!videos || !videos.length) {
      box.innerHTML = '<div class="batch-empty">Nenhum vídeo encontrado.</div>';
      if (info) info.textContent = '';
      return;
    }
    const totMB = videos.reduce((s, v) => s + (v.tamanho_mb || 0), 0);
    if (info) info.textContent = `${videos.length} vídeo(s) • ${totMB.toFixed(0)} MB • lidos pelo exiftool`;
    box.innerHTML = videos.map(v => `
      <div class="batch-row">
        <span class="batch-name" title="${_esc(v.rel)}">${_esc(v.rel)}</span>
        <span class="batch-size">${v.tamanho_mb} MB</span>
      </div>`).join('');
  }

  // ── MODO ZIP: drag & drop ────────────────────────────────────────────
  function _initDrop() {
    const drop = document.getElementById('batchDrop');
    const input = document.getElementById('batchZipInput');
    if (!drop || drop._init) return;
    drop._init = true;

    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files.length) _setZip(input.files[0]);
    });
    ['dragenter', 'dragover'].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) _setZip(f);
    });
  }

  function _setZip(f) {
    if (!f.name.toLowerCase().endsWith('.zip')) {
      alert('Arraste um arquivo .zip.');
      return;
    }
    _zipFile = f;
    const info = document.getElementById('batchZipInfo');
    if (info) info.textContent = `Selecionado: ${f.name} (${(f.size / 1048576).toFixed(0)} MB)`;
  }

  // ── ZIP no navegador: extrai 1 vídeo por vez e converte com gpmf.js ──
  async function _converterZipNoNavegador() {
    if (typeof JSZip === 'undefined' || typeof window.batchBrowserRunLista !== 'function') {
      alert('JSZip / batch-browser.js não carregados.'); return;
    }
    const lbl = document.getElementById('batchProgLbl');
    if (lbl) lbl.textContent = 'Lendo o índice do .zip...';
    let zip;
    try {
      zip = await JSZip.loadAsync(_zipFile);
    } catch (e) {
      if (lbl) lbl.textContent = '';
      alert('Não consegui abrir o .zip: ' + e.message); return;
    }
    const lista = [];
    zip.forEach((rel, entry) => {
      if (entry.dir) return;
      if (!/\.(mp4|mov)$/i.test(rel)) return;
      if (/(^|\/)__MACOSX\//.test(rel)) return;
      lista.push({
        rel,
        getFile: async () => {
          const blob = await entry.async('blob');
          const nome = rel.split('/').pop();
          return new File([blob], nome, { type: 'video/mp4' });
        },
      });
    });
    if (!lista.length) {
      if (lbl) lbl.textContent = '';
      alert('Nenhum vídeo (.mp4/.mov) dentro do .zip.'); return;
    }
    lista.sort((a, b) => a.rel.localeCompare(b.rel));
    return window.batchBrowserRunLista(lista);
  }

  // ── CONVERTER (roteia pelo modo) ─────────────────────────────────────
  async function batchStart() {
    if (_rodando) return;

    // Modo navegador: tudo roda no cliente (gpmf.js), sem servidor.
    if (_modo === 'browser') {
      if (window.batchBrowserStart) return window.batchBrowserStart();
      alert('batch-browser.js não carregado.');
      return;
    }

    const um1hz = document.getElementById('batch1hz')?.checked;

    let req;
    if (_modo === 'pasta') {
      const pasta = document.getElementById('batchPasta')?.value.trim();
      const rec = document.getElementById('batchRec')?.checked;
      if (!pasta) { alert('Informe o caminho da pasta.'); return; }
      req = {
        url: '/api/gopro/converter',
        opts: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken() },
          body: JSON.stringify({ pasta, recursivo: !!rec, um_hz: !!um1hz }),
        },
      };
    } else if (_modo === 'zip') {
      // ZIP processado 100% no NAVEGADOR: nada é enviado ao servidor.
      // (o upload de centenas de MB pro Railway caía/estourava timeout —
      //  era o motivo do "gerar GPX via zip" não funcionar)
      if (!_zipFile) { alert('Arraste um arquivo .zip primeiro.'); return; }
      return _converterZipNoNavegador();
    } else { // drive
      const link = document.getElementById('batchDrive')?.value.trim();
      if (!link) { alert('Cole o link do Drive.'); return; }
      req = {
        url: '/api/gopro/converter-drive',
        opts: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken() },
          body: JSON.stringify({ link, um_hz: !!um1hz }),
        },
      };
    }

    _rodando = true;
    const go = document.getElementById('batchStart');
    const lbl = document.getElementById('batchProgLbl');
    const fill = document.getElementById('batchProgFill');
    if (go) { go.disabled = true; go.textContent = 'CONVERTENDO...'; }
    if (fill) fill.style.width = '30%';
    if (lbl) lbl.textContent = 'Processando no servidor (exiftool)... aguarde.';

    try {
      const r = await fetch(req.url, req.opts);
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || 'Erro na conversão');
      }
      const ok = r.headers.get('X-Convertidos') || '?';
      const sem = r.headers.get('X-Sem-GPS') || '0';
      if (fill) fill.style.width = '90%';
      if (lbl) lbl.textContent = 'Baixando ZIP...';

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url; a.download = `gpx_gopro_${ts}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      if (fill) fill.style.width = '100%';
      if (lbl) lbl.textContent = `Concluído: ${ok} GPX gerado(s), ${sem} sem GPS. ZIP baixado.`;
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

  // Inicializa drag&drop quando a aba abre
  function batchInit() { _initDrop(); }

  window.batchCheckStatus = function () { batchCheckStatus(); batchInit(); };
  window.batchInstall = batchInstall;
  window.batchMode = batchMode;
  window.batchListar = batchListar;
  window.batchStart = batchStart;
})();

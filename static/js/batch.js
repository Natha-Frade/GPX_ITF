// ══════════════════════════════════════════════════════════════════════
//  batch.js — Conversor GoPro → GPX
//
//  Uma entrada só, 100% no NAVEGADOR (gpmf.js + JSZip). Nada é enviado ao
//  servidor: sem upload, sem limite de tamanho, sem timeout.
//
//  O usuário pode:
//   • arrastar vídeos soltos (.mp4/.mov), pastas ou .zip — misturados
//   • clicar para escolher arquivos
//   • clicar para escolher uma PASTA inteira (inclui subpastas)
//
//  Por que NÃO existe mais o campo "caminho da pasta": aquele modo mandava
//  o texto "C:\Users\..." pro backend, que rodava os.path.isdir() no
//  SERVIDOR. Na nuvem o servidor é um container Linux e esse caminho nunca
//  existe — dava 400 sempre. Navegador nenhum entrega caminho de disco.
//  A forma correta de "apontar a pasta" é o seletor de pasta abaixo.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const EH_VIDEO = (n) => /\.(mp4|mov)$/i.test(n);
  const EH_ZIP   = (n) => /\.zip$/i.test(n);

  // Entradas selecionadas: { tipo: 'zip'|'video', file: File, rel: string }
  let _entradas = [];

  // ── Coleta ───────────────────────────────────────────────────────────
  function _add(files) {
    let ignorados = 0;
    for (const f of files) {
      const rel = f._rel || f.webkitRelativePath || f.name;
      if (EH_ZIP(f.name))        _entradas.push({ tipo: 'zip',   file: f, rel });
      else if (EH_VIDEO(f.name)) _entradas.push({ tipo: 'video', file: f, rel });
      else ignorados++;
    }
    _render(ignorados);
  }

  function _render(ignorados) {
    const info  = document.getElementById('batchZipInfo');
    const lista = document.getElementById('batchList');

    if (info) {
      if (!_entradas.length) {
        info.innerHTML = ignorados
          ? 'Nenhum arquivo aceito — use .mp4, .mov ou .zip.'
          : '';
      } else {
        const zips = _entradas.filter(e => e.tipo === 'zip').length;
        const vids = _entradas.length - zips;
        const mb = _entradas.reduce((s, e) => s + e.file.size, 0) / 1048576;
        const partes = [];
        if (vids) partes.push(vids + ' vídeo(s)');
        if (zips) partes.push(zips + ' zip(s)');
        info.innerHTML = partes.join(' + ') + ' • ' + mb.toFixed(0) + ' MB' +
          (ignorados ? ' • ' + ignorados + ' ignorado(s)' : '') +
          ' — <a href="#" onclick="batchLimpar();return false;" style="color:var(--muted);">limpar</a>';
      }
    }

    if (lista) {
      if (!_entradas.length) {
        lista.innerHTML = '<div class="batch-empty">Nada selecionado ainda.</div>';
      } else {
        lista.innerHTML = _entradas.map(e => `
          <div class="batch-row">
            <span class="batch-name" title="${_esc(e.rel)}">${e.tipo === 'zip' ? '📦 ' : ''}${_esc(e.rel)}</span>
            <span class="batch-size">${(e.file.size / 1048576).toFixed(0)} MB</span>
          </div>`).join('');
      }
    }
  }

  function batchLimpar() {
    _entradas = [];
    const inp = document.getElementById('batchFileInput');
    if (inp) inp.value = '';
    _render(0);
  }

  // ── Arrastar (aceita arquivo e pasta) ────────────────────────────────
  function _initDrop() {
    const drop  = document.getElementById('batchDrop');
    const input = document.getElementById('batchFileInput');
    if (!drop || drop._init) return;
    drop._init = true;

    if (input) {
      input.multiple = true;
      input.accept = '.zip,.mp4,.mov,video/mp4,video/quicktime';
      input.addEventListener('change', () => {
        if (input.files.length) _add([...input.files]);
      });
    }

    drop.addEventListener('click', () => input && input.click());
    ['dragenter', 'dragover'].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev =>
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));

    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const items = e.dataTransfer.items;
      // Com .items dá pra aceitar PASTA arrastada (webkitGetAsEntry).
      if (items && items.length && items[0].webkitGetAsEntry) {
        const raizes = [];
        for (const it of items) {
          const en = it.webkitGetAsEntry();
          if (en) raizes.push(en);
        }
        const achados = [];
        for (const en of raizes) await _percorrer(en, '', achados);
        _add(achados);
      } else if (e.dataTransfer.files.length) {
        _add([...e.dataTransfer.files]);
      }
    });
  }

  async function _percorrer(entry, prefixo, saida) {
    const rel = prefixo ? prefixo + '/' + entry.name : entry.name;
    if (entry.isFile) {
      if (!EH_VIDEO(entry.name) && !EH_ZIP(entry.name)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      file._rel = rel;
      saida.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries devolve no máximo ~100 por chamada: repetir até vir
      // vazio, senão pasta grande é lida pela metade sem avisar.
      for (;;) {
        const lote = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!lote.length) break;
        for (const sub of lote) await _percorrer(sub, rel, saida);
      }
    }
  }

  // ── Escolher pasta pelo seletor do navegador ─────────────────────────
  async function batchEscolherPasta() {
    const achados = [];
    try {
      if (window.showDirectoryPicker) {
        const dir = await window.showDirectoryPicker();
        await _varrerHandle(dir, '', achados);
      } else {
        // Firefox/Safari: <input webkitdirectory> ainda funciona.
        await new Promise((resolve) => {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.webkitdirectory = true;
          inp.onchange = () => { achados.push(...inp.files); resolve(); };
          inp.click();
        });
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // usuário cancelou
      alert('Não consegui abrir a pasta: ' + e.message);
      return;
    }
    _add(achados);
  }

  async function _varrerHandle(dirHandle, prefixo, saida) {
    for await (const [nome, handle] of dirHandle.entries()) {
      const rel = prefixo ? prefixo + '/' + nome : nome;
      if (handle.kind === 'directory') {
        await _varrerHandle(handle, rel, saida);
      } else if (EH_VIDEO(nome) || EH_ZIP(nome)) {
        const file = await handle.getFile();
        file._rel = rel;
        saida.push(file);
      }
    }
  }

  // ── Converter ────────────────────────────────────────────────────────
  // Monta a lista PREGUIÇOSA: { rel, getFile: async () => File }. Vídeo
  // dentro de .zip só é descompactado na hora, um por vez — não estoura a
  // memória com o zip inteiro descompactado.
  async function batchStart() {
    if (!_entradas.length) {
      alert('Arraste os vídeos, uma pasta ou um .zip — ou use "Escolher pasta".');
      return;
    }
    if (typeof window.batchBrowserRunLista !== 'function') {
      alert('batch-browser.js não carregado — recarregue com Ctrl+Shift+R.');
      return;
    }

    const lbl = document.getElementById('batchProgLbl');
    const lista = [];

    for (const ent of _entradas) {
      if (ent.tipo === 'video') {
        lista.push({ rel: ent.rel, getFile: async () => ent.file });
        continue;
      }
      if (typeof JSZip === 'undefined') { alert('JSZip não carregado.'); return; }
      if (lbl) lbl.textContent = 'Lendo o índice de ' + ent.file.name + '...';
      let zip;
      try {
        zip = await JSZip.loadAsync(ent.file);
      } catch (e) {
        if (lbl) lbl.textContent = '';
        alert('Não consegui abrir "' + ent.file.name + '": ' + e.message +
          '\n\nSe veio do Drive/OneDrive, confirme que o download terminou e ' +
          'que o arquivo não é um marcador "sob demanda". Zip muito grande ' +
          'pode não caber na memória — nesse caso extraia e arraste os vídeos.');
        return;
      }
      zip.forEach((rel, entry) => {
        if (entry.dir) return;
        if (!EH_VIDEO(rel)) return;
        if (/(^|\/)__MACOSX\//.test(rel)) return;
        lista.push({
          rel,
          getFile: async () => {
            const blob = await entry.async('blob');
            return new File([blob], rel.split('/').pop(), { type: 'video/mp4' });
          },
        });
      });
    }

    if (!lista.length) {
      if (lbl) lbl.textContent = '';
      alert('Nenhum vídeo (.mp4/.mov) encontrado no que foi selecionado.');
      return;
    }
    lista.sort((a, b) => a.rel.localeCompare(b.rel));
    return window.batchBrowserRunLista(lista);
  }

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Chamado por map.js ao abrir a aba.
  window.batchCheckStatus = function () { _initDrop(); _render(0); };
  window.batchEscolherPasta = batchEscolherPasta;
  window.batchLimpar = batchLimpar;
  window.batchStart = batchStart;
})();

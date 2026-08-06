// ══════════════════════════════════════════════════════════════════════
//  PONTE COM A ABA DE VÍDEO  (carregada dentro do EDITOR)
//
//  PROBLEMA QUE ISSO RESOLVE
//  Cada envio da aba "VÍDEO + GPX" abria uma aba NOVA do editor. Fazendo
//  dois cortes em momentos diferentes, cada um caía numa aba — e não dava
//  para juntar os dois na mesma timeline.
//
//  COMO FUNCIONA
//  A aba de vídeo grava os cortes no IndexedDB e avisa por BroadcastChannel.
//  Aqui, se o editor JÁ estiver aberto, pegamos os cortes novos e os
//  entregamos ao editor simulando um "arrastar e soltar" — que é um
//  caminho que ele já suporta. Assim os clipes entram na biblioteca sem
//  recarregar a página, preservando o que já estava montado na timeline.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const DB      = 'gpxitf_handoff';
  const STORE   = 'files';
  const CANAL   = 'gpxitf_editor';

  function abrirBanco() {
    return new Promise((res, rej) => {
      let rq;
      try { rq = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(STORE))
          rq.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error);
    });
  }

  // Lê os cortes pendentes e esvazia a fila (o editor já vai ficar com eles).
  function pegarPendentes() {
    return abrirBanco().then(db => new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const rq = st.getAll();
      rq.onsuccess = () => {
        const itens = rq.result || [];
        st.clear();
        tx.oncomplete = () => { db.close(); res(itens); };
      };
      rq.onerror = () => { db.close(); rej(rq.error); };
    }));
  }

  // Entrega os arquivos ao editor simulando um arrastar-e-soltar.
  function entregarAoEditor(arquivos) {
    if (!arquivos.length) return false;
    let dt;
    try {
      dt = new DataTransfer();
      arquivos.forEach(f => dt.items.add(f));
    } catch (e) {
      return false;               // navegador não deixa montar o DataTransfer
    }
    // O editor escuta 'dragover' (para permitir) e 'drop' na janela.
    window.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
    window.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
    return true;
  }

  function aviso(texto) {
    let el = document.getElementById('__ponte_aviso');
    if (!el) {
      el = document.createElement('div');
      el.id = '__ponte_aviso';
      el.style.cssText =
        'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:99999;' +
        'background:#1f2937;color:#e8eaed;border:1px solid #3b4453;border-radius:8px;' +
        'padding:10px 16px;font:600 13px system-ui,sans-serif;box-shadow:0 4px 18px #0008';
      document.body.appendChild(el);
    }
    el.textContent = texto;
    el.style.display = '';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  async function receber() {
    let itens;
    try {
      itens = await pegarPendentes();
    } catch (e) {
      console.warn('[ponte] não consegui ler os cortes:', e);
      return;
    }
    if (!itens.length) return;

    const arquivos = itens.map(it =>
      new File([it.blob], it.nome, { type: it.tipo || 'video/mp4' }));

    if (entregarAoEditor(arquivos)) {
      aviso(`+${arquivos.length} corte(s) recebido(s) da aba Vídeo`);
    } else {
      // Plano B: não deu para simular o arrastar — recarrega e deixa o
      // próprio editor consumir a fila na carga.
      itens.forEach(() => {});
      location.search = '?handoff=1';
    }
  }

  // Só entra em ação depois que o editor montou a tela (ele consome a fila
  // sozinho no primeiro carregamento; daí em diante quem entrega somos nós).
  function iniciar() {
    try {
      const ch = new BroadcastChannel(CANAL);
      ch.onmessage = ev => {
        const d = ev && ev.data;
        if (!d) return;
        //  A aba de vídeo pergunta "tem editor aberto?" antes de enviar.
        //  Respondemos aqui; assim ela sabe que NÃO precisa abrir aba nova.
        if (d.tipo === 'ping') { try { ch.postMessage({ tipo: 'pong' }); } catch (_) {} }
        if (d.tipo === 'novos-cortes') receber();
      };
      window.__pontePronta = true;
    } catch (e) {
      console.warn('[ponte] BroadcastChannel indisponível:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(iniciar, 1200));
  } else {
    setTimeout(iniciar, 1200);
  }
})();

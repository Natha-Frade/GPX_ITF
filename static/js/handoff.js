// ══════════════════════════════════════════════════════════════════════
//  handoff.js — Transferência de arquivos entre páginas (mesma origem)
//  via IndexedDB. Usado para "Enviar cortes de vídeo → EDITOR":
//  a aba Vídeo+GPX grava os Blobs aqui e abre /editor/?handoff=1;
//  o editor lê, registra na biblioteca e limpa.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const DB = 'gpxitf_handoff';
  const STORE = 'files';

  function _abrirCru() {
    return new Promise((res, rej) => {
      let rq;
      try { rq = indexedDB.open(DB, 1); }
      catch (e) { rej(e); return; }
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(STORE))
          rq.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error || new Error('indexedDB.open falhou'));
      rq.onblocked = () => rej(new Error('banco em uso por outra aba'));
    });
  }

  function _apagarBanco() {
    return new Promise(res => {
      try {
        const rq = indexedDB.deleteDatabase(DB);
        rq.onsuccess = rq.onerror = rq.onblocked = () => res();
        setTimeout(res, 2500);            // não trava se o navegador não responder
      } catch (e) { res(); }
    });
  }

  //  O IndexedDB às vezes fica corrompido e devolve
  //  "Internal error opening backing store for indexedDB.open".
  //  Nesse caso apagar o banco e recriar resolve, então tentamos isso uma
  //  vez antes de desistir. Se nem assim abrir (modo anônimo, permissão de
  //  dados do site bloqueada, disco cheio), quem chamou trata o erro.
  async function _open() {
    try {
      return await _abrirCru();
    } catch (e) {
      await _apagarBanco();
      return await _abrirCru();          // se falhar de novo, propaga
    }
  }

  // itens: [{ nome, blob, tipo? }]
  //  ACUMULA por padrão: cada envio entra na fila depois do que já estava
  //  lá, então dá para mandar um corte agora, outro depois, e o editor
  //  recebe todos na ordem em que foram enviados (cada um vira um clipe).
  //  Antes havia um st.clear() aqui e o envio novo APAGAVA o anterior.
  //  Passe substituir=true se quiser mesmo descartar o que estava na fila.
  async function handoffPut(itens, substituir) {
    const db = await _open();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      if (substituir) st.clear();
      itens.forEach(it => st.add({
        nome: it.nome,
        blob: it.blob,
        tipo: it.tipo || 'video/mp4',
        ts: Date.now(),
      }));
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }

  async function handoffTakeAll() {
    const db = await _open();
    const itens = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const rq = st.getAll();
      rq.onsuccess = () => { st.clear(); res(rq.result || []); };
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return itens;
  }

  window.handoffPut = handoffPut;
  window.handoffTakeAll = handoffTakeAll;
})();

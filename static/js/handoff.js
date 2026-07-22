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

  function _open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(STORE))
          rq.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  // itens: [{ nome, blob, tipo? }]
  async function handoffPut(itens) {
    const db = await _open();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      st.clear();
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

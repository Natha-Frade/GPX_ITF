// unir-video.js — Aba UNIR VÍDEO
//
// Mesma lógica da aba Unir GPX, só que para MP4: slots na ordem A→D, o
// usuário escolhe os cortes e baixa um arquivo só.
//
// A união é feita por STREAM COPY (concat demuxer do ffmpeg, -c copy):
// não decodifica, não recodifica, não perde qualidade. É I/O puro, então
// roda em segundos mesmo em wasm.
//
// De propósito, esta aba NÃO faz probe de metadados, NÃO extrai GPS e NÃO
// gera preview — as três coisas que travam o editor. Os arquivos só são
// lidos na hora de unir, e via WORKERFS (por referência, sem copiar pra
// memória), então vídeos de vários GB passam.
//
// Requisito do concat demuxer: todos os vídeos com mesmo codec, resolução
// e fps. Cortes gerados pelo próprio app a partir da mesma GoPro atendem.

(function () {
  'use strict';

  const SLOTS = ['A', 'B', 'C', 'D'];
  const arquivos = { A: null, B: null, C: null, D: null };

  const $ = (id) => document.getElementById(id);

  function fmtTamanho(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(0) + ' KB';
  }

  function selecionados() {
    return SLOTS.map((s) => arquivos[s]).filter(Boolean);
  }

  function atualizarEstado() {
    const lista = selecionados();
    const btn = $('uvBtnUnir');
    const vazio = $('uvEmptyState');
    const resumo = $('uvResumo');

    if (btn) btn.disabled = lista.length < 2;
    if (vazio) vazio.style.display = lista.length < 2 ? '' : 'none';
    if (resumo) resumo.style.display = lista.length < 2 ? 'none' : '';

    if (lista.length >= 2) {
      const total = lista.reduce((acc, f) => acc + f.size, 0);
      const qtd = $('uvResQtd');
      const tam = $('uvResTam');
      if (qtd) qtd.textContent = lista.length + ' vídeos';
      if (tam) tam.textContent = fmtTamanho(total);
    }
  }

  // Carrega um arquivo no slot. Sem leitura de conteúdo aqui: só guardamos
  // a referência do File. É isso que mantém a aba instantânea.
  window.uvLoadFile = function (slot, input) {
    const f = input && input.files && input.files[0];
    if (!f) return;

    // .ts entra aqui porque e a saida do corte longo e da propria uniao —
    // sem isso, o resultado do app nao pode ser reaproveitado.
    if (!/\.(mp4|mov|ts|m2ts|mts)$/i.test(f.name)) {
      if (typeof toast === 'function') toast('Formato não suportado — use .mp4, .mov ou .ts', 'error');
      input.value = '';
      return;
    }

    arquivos[slot] = f;
    const nome = $('uv-fname-' + slot);
    const info = $('uv-info-' + slot);
    if (nome) nome.textContent = f.name;
    if (info) info.textContent = fmtTamanho(f.size);
    atualizarEstado();
  };

  window.uvClearSlot = function (slot) {
    arquivos[slot] = null;
    const nome = $('uv-fname-' + slot);
    const info = $('uv-info-' + slot);
    const inp = document.querySelector('#uv-slot-' + slot + ' input[type=file]');
    if (nome) nome.textContent = 'Nenhum arquivo';
    if (info) info.textContent = '—';
    if (inp) inp.value = '';
    atualizarEstado();
  };

  function status(msg) {
    const el = $('uvStatus');
    if (el) el.textContent = msg || '';
  }

  function progresso(p) {
    const el = $('uvFill');
    if (el) el.style.width = Math.round((p || 0) * 100) + '%';
  }

  window.uvUnir = async function () {
    const lista = selecionados();
    if (lista.length < 2) {
      if (typeof toast === 'function') toast('Selecione ao menos 2 vídeos', 'error');
      return;
    }

    if (typeof window.videoUnirStreaming !== 'function') {
      status('Motor de vídeo indisponível — recarregue a página (Ctrl+Shift+R).');
      if (typeof toast === 'function') toast('video-export.js não carregou', 'error');
      return;
    }

    const btn = $('uvBtnUnir');
    if (btn) { btn.disabled = true; btn.textContent = 'Unindo…'; }

    try {
      status('Carregando motor de vídeo…');
      // Streaming pro disco: sem teto de memoria, sem limite de duracao.
      await window.videoUnirStreaming(lista, status, progresso);
      if (typeof toast === 'function') toast('Vídeos unidos com sucesso', 'success');
    } catch (e) {
      if (e && e.name === 'AbortError') { status('Cancelado.'); return; }
      console.error('[unir-video]', e);
      const motivo = (typeof window._ffErroTexto === 'function')
        ? window._ffErroTexto(e)
        : ((e && e.message) || 'erro desconhecido');
      status('Falhou: ' + motivo);
      if (typeof toast === 'function') toast('Não consegui unir: ' + motivo, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔗 Unir e Gravar no Disco'; }
      setTimeout(() => progresso(0), 2000);
    }
  };

  // Recebe arquivos de outra aba (ex.: cortes recem-gravados na VÍDEO+GPX)
  // e preenche os slots na ordem. Substitui o conteudo anterior.
  window.uvReceberArquivos = function (files) {
    if (!files || !files.length) return 0;
    SLOTS.forEach((s) => { arquivos[s] = null; });
    const n = Math.min(files.length, SLOTS.length);
    for (let i = 0; i < n; i++) {
      const slot = SLOTS[i];
      const f = files[i];
      arquivos[slot] = f;
      const nome = $('uv-fname-' + slot);
      const info = $('uv-info-' + slot);
      if (nome) nome.textContent = f.name;
      if (info) info.textContent = fmtTamanho(f.size);
    }
    for (let i = n; i < SLOTS.length; i++) window.uvClearSlot(SLOTS[i]);
    atualizarEstado();
    return n;
  };

  document.addEventListener('DOMContentLoaded', atualizarEstado);
})();

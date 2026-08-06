// ══════════════════════════════════════════════════════════════════════
//  conversor.js — Conversor de vídeo no SERVIDOR
//
//  Duas decisões que valem explicação:
//
//  1) UM ARQUIVO POR REQUISIÇÃO, corpo cru. Em vez de mandar tudo num
//     multipart gigante, cada vídeo vai numa requisição própria com o
//     File direto no body. Ganhos: o servidor grava o arquivo uma única
//     vez (sem temporário duplicado), a barra mostra o progresso REAL de
//     cada vídeo, e uma queda de conexão derruba só um item da lista.
//
//  2) XMLHttpRequest, não fetch. É a única API do navegador que dá
//     progresso de UPLOAD. Com arquivos de vários GB, enviar sem barra
//     é insuportável.
//
//  Depois do envio, a fila é acompanhada por polling. Fechar a aba não
//  cancela nada: quem converte é o servidor.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API = '/api/conversor';

  let selecionados = [];
  let enviando = false;
  let timer = null;
  let status = null;

  const $ = id => document.getElementById(id);
  const zona      = $('zona');
  const entrada   = $('entrada');
  const lista     = $('lista');
  const selPerfil = $('perfil');
  const chkTele   = $('telemetria');
  const btEnviar  = $('btEnviar');
  const btLimpar  = $('btLimpar');
  const elStatus  = $('statusServidor');
  const elFila    = $('fila');

  // ── Sessão ──────────────────────────────────────────────────────────
  // Todas as rotas do conversor exigem token. Sem sessão, volta para a
  // tela de login em vez de encher a tela de erro 401.
  function token() { return localStorage.getItem('gpx_token'); }

  function semSessao() {
    localStorage.removeItem('gpx_token');
    localStorage.removeItem('gpx_nome');
    localStorage.removeItem('gpx_isAdmin');
    alert('Sessão expirada. Faça login novamente.');
    window.location.href = '/';
  }

  async function api(caminho, opcoes = {}) {
    const tk = token();
    if (!tk) { semSessao(); throw new Error('sem sessão'); }
    const r = await fetch(API + caminho, {
      ...opcoes,
      headers: { ...(opcoes.headers || {}), Authorization: 'Bearer ' + tk },
    });
    if (r.status === 401) { semSessao(); throw new Error('401'); }
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || ('HTTP ' + r.status));
    }
    return r.json();
  }

  // ── Formatação ──────────────────────────────────────────────────────
  function tamanho(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function duracao(seg) {
    if (!seg && seg !== 0) return '—';
    seg = Math.round(seg);
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    const s = seg % 60;
    return h ? `${h}h${String(m).padStart(2, '0')}m`
             : m ? `${m}min ${String(s).padStart(2, '0')}s`
                 : `${s}s`;
  }

  // Escapa TUDO que vem do servidor antes de virar HTML. Nome de arquivo
  // é dado do usuário: sem isto, um vídeo chamado <img onerror=...> vira
  // XSS na tela de quem for admin e enxerga a fila dos outros.
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Status do servidor / perfis ─────────────────────────────────────
  async function carregarStatus() {
    try {
      const s = await api('/status');
      status = s;

      if (!selPerfil.options.length) {
        selPerfil.innerHTML = s.perfis
          .map(p => `<option value="${esc(p.id)}"${p.id === '720p' ? ' selected' : ''}>${esc(p.rotulo)}</option>`)
          .join('');
      }
      $('ttl').textContent = s.ttl_horas;
      $('maxGb').textContent = s.max_gb;

      if (!s.ok) {
        elStatus.className = 'aviso-servidor';
        elStatus.textContent = 'Servidor sem ffmpeg — ' + (s.motivo || 'indisponível');
        btEnviar.disabled = true;
        return false;
      }
      elStatus.className = 'status-ok';
      const partes = [`${s.workers} conversão${s.workers > 1 ? 'es' : ''} simultânea${s.workers > 1 ? 's' : ''}`];
      if (s.na_fila) partes.push(`${s.na_fila} na fila`);
      partes.push(`${s.disco_livre_gb} GB livres`);
      elStatus.textContent = partes.join(' · ');
      return true;
    } catch (e) {
      elStatus.className = 'aviso-servidor';
      elStatus.textContent = 'Não consegui falar com o servidor.';
      return false;
    }
  }

  // ── Seleção de arquivos ─────────────────────────────────────────────
  function extensoes() {
    return (status && status.extensoes) || ['.mp4', '.mov', '.mkv', '.avi'];
  }

  function mostrarSelecao() {
    if (!selecionados.length) {
      lista.innerHTML = '';
      btEnviar.disabled = true;
      btEnviar.textContent = 'Converter';
      return;
    }
    const total = selecionados.reduce((s, f) => s + f.size, 0);
    lista.innerHTML = selecionados
      .map(f => `${esc(f.name)} — ${tamanho(f.size)}`).join('<br>');
    btEnviar.disabled = enviando;
    btEnviar.textContent = selecionados.length === 1
      ? `Converter (${tamanho(total)})`
      : `Converter ${selecionados.length} vídeos (${tamanho(total)})`;
  }

  function adicionar(files) {
    const ok = extensoes();
    const maxBytes = (status ? status.max_gb : 20) * 1024 * 1024 * 1024;
    const recusados = [];
    const novos = [];

    Array.from(files).forEach(f => {
      const ext = ('.' + (f.name.split('.').pop() || '')).toLowerCase();
      if (ok.indexOf(ext) < 0) { recusados.push(`${f.name} (formato)`); return; }
      if (f.size > maxBytes)   { recusados.push(`${f.name} (acima de ${status.max_gb} GB)`); return; }
      novos.push(f);
    });

    if (recusados.length) {
      alert('Ignorei:\n' + recusados.join('\n') +
            '\n\nAceitos: ' + ok.join(' '));
    }
    selecionados = selecionados.concat(novos);
    mostrarSelecao();
  }

  zona.addEventListener('click', () => { if (!enviando) entrada.click(); });
  entrada.addEventListener('change', e => adicionar(e.target.files));

  ['dragenter', 'dragover'].forEach(ev =>
    zona.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      zona.classList.add('arrasto');
    }));
  ['dragleave', 'drop'].forEach(ev =>
    zona.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      zona.classList.remove('arrasto');
    }));
  zona.addEventListener('drop', e => {
    if (!enviando && e.dataTransfer && e.dataTransfer.files.length) {
      adicionar(e.dataTransfer.files);
    }
  });

  btLimpar.addEventListener('click', () => {
    selecionados = [];
    entrada.value = '';
    mostrarSelecao();
  });

  // ── Envio: um arquivo por requisição, em série ──────────────────────
  //
  //  São DUAS requisições por vídeo, de propósito:
  //
  //    1) POST /reservar  — vazia. O servidor confere cota, espaço em
  //       disco, extensão e tamanho e devolve o id do job (ou o erro).
  //    2) PUT  /enviar/{id} — o File cru no corpo.
  //
  //  Sem a etapa 1, uma recusa aconteceria com o upload já em curso: o
  //  servidor responde e fecha, o navegador enxerga só "conexão perdida"
  //  e a pessoa nunca fica sabendo que o problema era a cota. Com 13 GB,
  //  descobriria isso 40 minutos depois.
  async function reservar(arquivo) {
    const q = new URLSearchParams({
      nome: arquivo.name,
      tamanho: String(arquivo.size),
      perfil: selPerfil.value,
      telemetria: chkTele.checked ? 'true' : 'false',
    });
    const r = await api(`/reservar?${q.toString()}`, { method: 'POST' });
    return r.job.id;
  }

  function enviarBytes(jobId, arquivo, indice, total) {
    return new Promise((resolve, reject) => {
      const tk = token();
      if (!tk) { semSessao(); return reject(new Error('sem sessão')); }

      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${API}/enviar/${encodeURIComponent(jobId)}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + tk);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total * 100).toFixed(1);
        btEnviar.textContent =
          `Enviando ${indice + 1}/${total} — ${pct}% (${tamanho(e.loaded)} de ${tamanho(e.total)})`;
      };

      xhr.onload = () => {
        if (xhr.status === 401) { semSessao(); return reject(new Error('401')); }
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = xhr.statusText || ('HTTP ' + xhr.status);
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('conexão interrompida'));
      xhr.onabort = () => reject(new Error('envio cancelado'));

      // O File vai direto no corpo — sem envelope multipart.
      xhr.send(arquivo);
    });
  }

  async function enviarUm(arquivo, indice, total) {
    btEnviar.textContent = `Preparando ${indice + 1}/${total}…`;
    const jobId = await reservar(arquivo);
    try {
      await enviarBytes(jobId, arquivo, indice, total);
    } catch (e) {
      // Reserva morta: não deixa segurando vaga na cota do usuário.
      try { await api(`/job/${encodeURIComponent(jobId)}`, { method: 'DELETE' }); }
      catch (_) {}
      throw e;
    }
  }

  btEnviar.addEventListener('click', async () => {
    if (!selecionados.length || enviando) return;

    enviando = true;
    btEnviar.disabled = true;
    btLimpar.disabled = true;

    const fila = selecionados.slice();
    const falhas = [];

    for (let i = 0; i < fila.length; i++) {
      try {
        await enviarUm(fila[i], i, fila.length);
        selecionados = selecionados.filter(f => f !== fila[i]);
        atualizarFila();
      } catch (e) {
        if (e.message === '401' || e.message === 'sem sessão') return;
        falhas.push(`${fila[i].name}: ${e.message}`);
        // Cota estourada ou disco cheio: não adianta insistir com o resto.
        if (/limite|espaço|andamento|GB/i.test(e.message)) break;
      }
    }

    enviando = false;
    btLimpar.disabled = false;
    entrada.value = '';
    mostrarSelecao();
    atualizarFila();

    if (falhas.length) alert('Não enviei:\n' + falhas.join('\n'));
  });

  // ── Fila ────────────────────────────────────────────────────────────
  function linhaJob(j) {
    const ATIVOS = ['reservado', 'recebendo', 'fila', 'analisando', 'convertendo'];
    const emAndamento = j.estado === 'convertendo' || j.estado === 'analisando';
    const org = j.origem || {};
    const dst = j.destino || {};

    const detalhes = [];
    if (org.codec) {
      detalhes.push(`<span>origem <b>${esc(String(org.codec).toUpperCase())} ` +
        `${esc(org.largura)}×${esc(org.altura)}</b></span>`);
      detalhes.push(`<span>duração <b>${duracao(org.duracao)}</b></span>`);
    }
    detalhes.push(`<span>entrada <b>${tamanho(j.tamanho_entrada)}</b></span>`);
    if (j.estado === 'concluido') {
      detalhes.push(`<span>saída <b>${esc(dst.largura)}×${esc(dst.altura)} · ` +
        `${tamanho(j.tamanho_saida)}</b></span>`);
      if (j.tamanho_entrada && j.tamanho_saida) {
        const red = (1 - j.tamanho_saida / j.tamanho_entrada) * 100;
        if (red > 0) detalhes.push(`<span>redução <b>${red.toFixed(0)}%</b></span>`);
      }
      if (j.iniciado_em && j.terminado_em) {
        detalhes.push(`<span>levou <b>${duracao(j.terminado_em - j.iniciado_em)}</b></span>`);
      }
    } else if (emAndamento) {
      if (j.velocidade) detalhes.push(`<span>velocidade <b>${esc(j.velocidade)}x</b></span>`);
      if (j.restante_seg != null) {
        detalhes.push(`<span>faltam <b>${duracao(j.restante_seg)}</b></span>`);
      }
    }

    const acoes = [];
    if (j.estado === 'concluido') {
      // O download precisa do header Authorization, então não dá para
      // usar um <a href> simples: o botão busca o arquivo via fetch com
      // o token e entrega como blob.
      acoes.push(`<button class="botao pequeno" data-baixar="${esc(j.id)}">Baixar</button>`);
    }
    if (ATIVOS.indexOf(j.estado) >= 0) {
      acoes.push(`<button class="botao secundario pequeno" data-cancelar="${esc(j.id)}">Cancelar</button>`);
    } else {
      acoes.push(`<button class="botao perigo pequeno" data-remover="${esc(j.id)}">Remover</button>`);
    }

    return `
      <div class="job">
        <div class="topo">
          <span class="nome">${esc(j.nome)}</span>
          ${j.dono ? `<span class="dono">${esc(j.dono)}</span>` : ''}
          <span class="selo ${esc(j.estado)}">${esc(j.estado)}</span>
          ${acoes.join('')}
        </div>
        <div class="barra${j.estado === 'erro' ? ' erro' : ''}">
          <i style="width:${j.estado === 'erro' ? 100 : (Number(j.progresso) || 0)}%"></i>
        </div>
        <div class="detalhe">
          <span>${esc(j.etapa || '')}</span>
          ${emAndamento ? `<span><b>${(Number(j.progresso) || 0).toFixed(1)}%</b></span>` : ''}
          ${detalhes.join('')}
        </div>
        ${j.aviso ? `<div class="msg-aviso">${esc(j.aviso)}</div>` : ''}
        ${j.erro ? `<div class="msg-erro">${esc(j.erro)}</div>` : ''}
      </div>`;
  }

  async function baixar(id, botao) {
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Baixando…';
    try {
      const tk = token();
      const r = await fetch(`${API}/job/${encodeURIComponent(id)}/baixar`, {
        headers: { Authorization: 'Bearer ' + tk },
      });
      if (r.status === 401) return semSessao();
      if (!r.ok) throw new Error('HTTP ' + r.status);

      // Nome do arquivo a partir do Content-Disposition (com fallback).
      let nome = 'video.mp4';
      const cd = r.headers.get('content-disposition') || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      if (m) nome = decodeURIComponent(m[1]);

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      alert('Não consegui baixar: ' + e.message);
    } finally {
      botao.disabled = false;
      botao.textContent = rotulo;
    }
  }

  async function atualizarFila() {
    let jobs = [];
    try {
      jobs = (await api('/fila')).jobs || [];
    } catch (_) {
      return;
    }

    elFila.innerHTML = jobs.length
      ? jobs.map(linhaJob).join('')
      : '<div class="vazio">Nenhuma conversão ainda.</div>';

    elFila.querySelectorAll('[data-baixar]').forEach(b =>
      b.addEventListener('click', () => baixar(b.dataset.baixar, b)));

    elFila.querySelectorAll('[data-cancelar]').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await api(`/job/${encodeURIComponent(b.dataset.cancelar)}/cancelar`, { method: 'POST' }); }
        catch (e) { alert(e.message); }
        atualizarFila();
      }));

    elFila.querySelectorAll('[data-remover]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm('Remover este job e apagar os arquivos do servidor?')) return;
        b.disabled = true;
        try { await api(`/job/${encodeURIComponent(b.dataset.remover)}`, { method: 'DELETE' }); }
        catch (e) { alert(e.message); }
        atualizarFila();
      }));

    // Enquanto houver job vivo, acompanha de perto; senão, alivia o servidor.
    const ativo = jobs.some(j =>
      ['reservado', 'recebendo', 'fila', 'analisando', 'convertendo'].indexOf(j.estado) >= 0);
    clearTimeout(timer);
    timer = setTimeout(atualizarFila, ativo ? 1500 : 8000);
  }

  // ── Início ──────────────────────────────────────────────────────────
  if (!token()) {
    alert('Faça login para usar o conversor.');
    window.location.href = '/';
  } else {
    carregarStatus().then(() => { mostrarSelecao(); atualizarFila(); });
    setInterval(carregarStatus, 30000);
  }
})();

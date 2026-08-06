// ══════════════════════════════════════════════════════════════════════
//  BIBLIOTECA DE KMZ COMPARTILHADOS  (aba MARCAÇÕES)
//
//  O admin publica um KMZ e escolhe o nome que todos vão ver. Quem é
//  usuário comum só enxerga a lista e carrega o que precisar — não
//  precisa ter o arquivo na máquina nem pedir pra ninguém.
//
//  Backend: app/routers/kmz_lib.py  (GET livre p/ logados, escrita só admin)
// ══════════════════════════════════════════════════════════════════════

let _kmzLibItens   = [];
let _kmzLibArquivo = null;   // arquivo escolhido pelo admin antes de publicar

// ── Carrega a lista e monta o seletor ────────────────────────────────
async function kmzLibListar() {
  const sel   = document.getElementById('kmzLibSelect');
  const badge = document.getElementById('kmzLibBadge');
  if (!sel) return;
  try {
    const r = await apiFetch('/kmz-lib');
    _kmzLibItens = r.itens || [];
  } catch (e) {
    // sem sessão ainda, ou backend fora: deixa a seção quieta
    _kmzLibItens = [];
  }
  if (badge) badge.textContent = _kmzLibItens.length;

  sel.innerHTML = '<option value="">— escolha um KMZ da equipe —</option>' +
    _kmzLibItens.map(i =>
      `<option value="${i.id}">${_kmzEsc(i.nome)}</option>`).join('');

  const hint = document.getElementById('kmzLibHint');
  if (hint) {
    hint.textContent = _kmzLibItens.length
      ? 'KMZ publicados pela coordenação. Escolha um para carregar no mapa.'
      : 'Nenhum KMZ publicado ainda.';
  }
  kmzLibRenderGerenciar();
}

// ── Usuário escolhe um KMZ: baixa e carrega no mapa ──────────────────
async function kmzLibCarregar(id) {
  if (!id) return;
  const item = _kmzLibItens.find(i => i.id === id);
  if (!item) return;
  const hint = document.getElementById('kmzLibHint');
  try {
    if (hint) hint.textContent = 'Carregando ' + item.nome + '…';
    // Este endpoint devolve o arquivo binário, então não dá pra usar o
    // apiFetch (que espera JSON) — buscamos direto com o token.
    const res = await fetch(API_BASE + '/kmz-lib/' + id + '/arquivo', {
      headers: { 'Authorization': 'Bearer ' + apiToken() },
    });
    if (!res.ok) throw new Error('não consegui baixar (HTTP ' + res.status + ')');
    const blob = await res.blob();
    const nomeArq = (item.nome_original || item.nome).replace(/[^\w.\-]/g, '_');
    const ext = nomeArq.toLowerCase().endsWith('.kml') ? '.kml' : '.kmz';
    const file = new File([blob], nomeArq.endsWith(ext) ? nomeArq : nomeArq + ext);
    await loadKmzFile(file);
    if (hint) hint.textContent = item.nome + ' carregado no mapa.';
    showToast('KMZ "' + item.nome + '" carregado', 'success');
  } catch (e) {
    if (hint) hint.textContent = 'Erro: ' + e.message;
    showToast('Erro ao carregar o KMZ: ' + e.message, 'error');
  }
}

// ── ADMIN: escolher arquivo ──────────────────────────────────────────
function kmzLibArquivoEscolhido(input) {
  _kmzLibArquivo = input.files && input.files[0] ? input.files[0] : null;
  const lbl = document.getElementById('kmzLibFileName');
  if (lbl) lbl.textContent = _kmzLibArquivo ? _kmzLibArquivo.name : 'Escolher arquivo';
  // Sugere o nome do arquivo como nome de exibição, se ainda estiver vazio
  const nomeEl = document.getElementById('kmzLibNome');
  if (nomeEl && !nomeEl.value.trim() && _kmzLibArquivo) {
    nomeEl.value = _kmzLibArquivo.name.replace(/\.(kmz|kml)$/i, '');
  }
}

// ── ADMIN: publicar ──────────────────────────────────────────────────
async function kmzLibPublicar() {
  const st    = document.getElementById('kmzLibStatus');
  const nome  = (document.getElementById('kmzLibNome')?.value || '').trim();
  const desc  = (document.getElementById('kmzLibDesc')?.value || '').trim();
  if (!_kmzLibArquivo) { showToast('Escolha um arquivo .kmz ou .kml', 'error'); return; }
  if (!nome)           { showToast('Dê um nome para o KMZ', 'error'); return; }

  const fd = new FormData();
  fd.append('arquivo', _kmzLibArquivo);
  fd.append('nome', nome);
  fd.append('descricao', desc);

  try {
    if (st) st.textContent = 'Enviando…';
    // FormData: o navegador monta o Content-Type (com boundary) sozinho.
    const res = await fetch(API_BASE + '/kmz-lib', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiToken() },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || 'falha no envio');
    }
    if (st) st.textContent = '';
    document.getElementById('kmzLibNome').value = '';
    document.getElementById('kmzLibDesc').value = '';
    document.getElementById('kmzLibFile').value = '';
    _kmzLibArquivo = null;
    const lbl = document.getElementById('kmzLibFileName');
    if (lbl) lbl.textContent = 'Escolher arquivo';
    showToast('KMZ "' + nome + '" publicado para a equipe', 'success');
    await kmzLibListar();
  } catch (e) {
    if (st) st.textContent = 'Erro: ' + e.message;
    showToast('Erro ao publicar: ' + e.message, 'error');
  }
}

// ── ADMIN: renomear / remover ────────────────────────────────────────
async function kmzLibRenomear(id) {
  const item = _kmzLibItens.find(i => i.id === id);
  if (!item) return;
  const novo = prompt('Novo nome para este KMZ:', item.nome);
  if (novo === null) return;
  if (!novo.trim()) { showToast('O nome não pode ficar vazio', 'error'); return; }
  try {
    await apiFetch('/kmz-lib/' + id, {
      method: 'PATCH', body: JSON.stringify({ nome: novo.trim() }),
    });
    showToast('Renomeado', 'success');
    await kmzLibListar();
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function kmzLibRemover(id) {
  const item = _kmzLibItens.find(i => i.id === id);
  if (!item) return;
  if (!confirm(`Remover "${item.nome}" da biblioteca?\n\nTodos deixam de ver este KMZ.`)) return;
  try {
    await apiFetch('/kmz-lib/' + id, { method: 'DELETE' });
    showToast('Removido da biblioteca', 'success');
    await kmzLibListar();
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── ADMIN: lista de gerenciamento ────────────────────────────────────
function kmzLibRenderGerenciar() {
  const box = document.getElementById('kmzLibGerenciar');
  if (!box) return;
  if (!_kmzLibItens.length) { box.innerHTML = ''; return; }
  box.innerHTML = _kmzLibItens.map(i => `
    <div class="kmz-lib-item">
      <div class="kmz-lib-item-info">
        <div class="kmz-lib-item-nome">${_kmzEsc(i.nome)}</div>
        <div class="kmz-lib-item-meta">${_kmzEsc(i.enviado_por || '')} · ${_kmzTam(i.tamanho)}</div>
      </div>
      <button class="kmz-lib-btn" onclick="kmzLibRenomear('${i.id}')" title="Renomear">✎</button>
      <button class="kmz-lib-btn" onclick="kmzLibRemover('${i.id}')" title="Remover">✕</button>
    </div>`).join('');
}

// ── Helpers ──────────────────────────────────────────────────────────
function _kmzEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _kmzTam(b) {
  if (!b) return '';
  return b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB'
                         : (b / 1024 / 1024).toFixed(1) + ' MB';
}

// ── Init: mostra o painel de admin só para quem é admin ──────────────
function kmzLibInit() {
  const painel = document.getElementById('kmzLibAdmin');
  if (painel) {
    painel.style.display = (typeof apiIsAdmin === 'function' && apiIsAdmin())
      ? 'block' : 'none';
  }
  kmzLibListar();
}

document.addEventListener('DOMContentLoaded', () => {
  // Espera o boot da sessão resolver antes de pedir a lista.
  setTimeout(kmzLibInit, 600);
});

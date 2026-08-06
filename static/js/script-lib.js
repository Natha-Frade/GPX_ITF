// ══════════════════════════════════════════════════════════════════════
//  BIBLIOTECA DE SCRIPTS  (aba SCRIPTS)
//
//  Mesma arquitetura da biblioteca de KMZ (kmz-lib.js):
//  o ADMIN publica um .zip com título e descrição; todo usuário logado
//  vê a lista e baixa o que precisar.
//
//  Backend: app/routers/script_lib.py
// ══════════════════════════════════════════════════════════════════════

let _scrItens   = [];
let _scrArquivo = null;   // .zip escolhido pelo admin antes de publicar

// ── Lista ────────────────────────────────────────────────────────────
async function scrListar() {
  const box   = document.getElementById('scrLista');
  const badge = document.getElementById('scrBadge');
  if (!box) return;
  try {
    const r = await apiFetch('/script-lib');
    _scrItens = r.itens || [];
  } catch (e) {
    _scrItens = [];
  }
  if (badge) badge.textContent = _scrItens.length;

  if (!_scrItens.length) {
    box.innerHTML = '<div class="scr-vazio">Nenhum script publicado ainda.</div>';
    return;
  }

  const admin = (typeof apiIsAdmin === 'function' && apiIsAdmin());
  box.innerHTML = _scrItens.map(i => `
    <div class="scr-card">
      <div class="scr-card-head">
        <div class="scr-card-titulo">${_scrEsc(i.titulo)}</div>
        ${admin ? `
          <button class="scr-btn" onclick="scrEditar('${i.id}')" title="Editar título/descrição">✎</button>
          <button class="scr-btn" onclick="scrRemover('${i.id}')" title="Remover">✕</button>` : ''}
      </div>
      ${i.descricao ? `<div class="scr-card-desc">${_scrEsc(i.descricao)}</div>` : ''}
      <div class="scr-card-meta">
        ${_scrTam(i.tamanho)} · ${i.arquivos || '?'} arquivo(s)
        · por ${_scrEsc(i.enviado_por || '—')}
        · ${_scrEsc((i.enviado_em || '').slice(0, 10))}
        ${i.downloads ? ` · ${i.downloads} download(s)` : ''}
      </div>
      <button class="btn btn-secondary scr-card-baixar" onclick="scrBaixar('${i.id}')">
        ⬇ Baixar .zip
      </button>
    </div>`).join('');
}

// ── Baixar ───────────────────────────────────────────────────────────
async function scrBaixar(id) {
  const item = _scrItens.find(i => i.id === id);
  if (!item) return;
  try {
    // Endpoint devolve binário, então não passa pelo apiFetch (que é JSON).
    const res = await fetch(API_BASE + '/script-lib/' + id + '/arquivo', {
      headers: { 'Authorization': 'Bearer ' + apiToken() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = item.nome_original || (item.titulo + '.zip');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast('Baixando "' + item.titulo + '"', 'success');
    scrListar();                       // atualiza o contador de downloads
  } catch (e) {
    showToast('Erro ao baixar: ' + e.message, 'error');
  }
}

// ── ADMIN: escolher arquivo ──────────────────────────────────────────
function scrArquivoEscolhido(input) {
  _scrArquivo = input.files && input.files[0] ? input.files[0] : null;
  const lbl = document.getElementById('scrFileName');
  if (lbl) lbl.textContent = _scrArquivo ? _scrArquivo.name : 'Escolher .zip';
  const tit = document.getElementById('scrTitulo');
  if (tit && !tit.value.trim() && _scrArquivo) {
    tit.value = _scrArquivo.name.replace(/\.zip$/i, '');
  }
}

// ── ADMIN: publicar ──────────────────────────────────────────────────
async function scrPublicar() {
  const st     = document.getElementById('scrStatus');
  const titulo = (document.getElementById('scrTitulo')?.value || '').trim();
  const desc   = (document.getElementById('scrDesc')?.value || '').trim();
  if (!_scrArquivo) { showToast('Escolha o arquivo .zip do script', 'error'); return; }
  if (!titulo)      { showToast('Dê um título para o script', 'error'); return; }

  const fd = new FormData();
  fd.append('arquivo', _scrArquivo);
  fd.append('titulo', titulo);
  fd.append('descricao', desc);

  try {
    if (st) st.textContent = 'Enviando…';
    const res = await fetch(API_BASE + '/script-lib', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiToken() },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || 'falha no envio');
    }
    if (st) st.textContent = '';
    document.getElementById('scrTitulo').value = '';
    document.getElementById('scrDesc').value   = '';
    document.getElementById('scrFile').value   = '';
    _scrArquivo = null;
    const lbl = document.getElementById('scrFileName');
    if (lbl) lbl.textContent = 'Escolher .zip';
    showToast('Script "' + titulo + '" publicado', 'success');
    await scrListar();
  } catch (e) {
    if (st) st.textContent = 'Erro: ' + e.message;
    showToast('Erro ao publicar: ' + e.message, 'error');
  }
}

// ── ADMIN: editar / remover ──────────────────────────────────────────
async function scrEditar(id) {
  const item = _scrItens.find(i => i.id === id);
  if (!item) return;
  const titulo = prompt('Título do script:', item.titulo);
  if (titulo === null) return;
  if (!titulo.trim()) { showToast('O título não pode ficar vazio', 'error'); return; }
  const descricao = prompt('Descrição (deixe vazio para remover):', item.descricao || '');
  if (descricao === null) return;
  try {
    await apiFetch('/script-lib/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ titulo: titulo.trim(), descricao: descricao.trim() }),
    });
    showToast('Atualizado', 'success');
    await scrListar();
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function scrRemover(id) {
  const item = _scrItens.find(i => i.id === id);
  if (!item) return;
  if (!confirm(`Remover "${item.titulo}" da biblioteca?\n\nTodos deixam de ver este script.`)) return;
  try {
    await apiFetch('/script-lib/' + id, { method: 'DELETE' });
    showToast('Removido', 'success');
    await scrListar();
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── Helpers ──────────────────────────────────────────────────────────
function _scrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _scrTam(b) {
  if (!b) return '';
  return b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB'
                         : (b / 1024 / 1024).toFixed(1) + ' MB';
}

// ── Init ─────────────────────────────────────────────────────────────
function scrInit() {
  const painel = document.getElementById('scrAdmin');
  if (painel) {
    painel.style.display = (typeof apiIsAdmin === 'function' && apiIsAdmin())
      ? 'block' : 'none';
  }
  scrListar();
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(scrInit, 600);
});

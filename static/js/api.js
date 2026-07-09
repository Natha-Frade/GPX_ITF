// ══════════════════════════════════════════════════════════════════════
//  api.js — Cliente da API GPX IMTRAFF
//  Gerencia autenticação JWT e sincronização de dados com o servidor.
// ══════════════════════════════════════════════════════════════════════

const API_BASE = '/api';

// ── Estado de auth ────────────────────────────────────────────────────
let _token    = localStorage.getItem('gpx_token')    || null;
let _nomeUser = localStorage.getItem('gpx_nome')     || null;
let _isAdmin  = localStorage.getItem('gpx_isAdmin') === 'true';

function apiToken()    { return _token; }
function apiNome()     { return _nomeUser; }
function apiIsAdmin()  { return _isAdmin; }
function apiLogado()   { return !!_token; }

// ── HTTP helper ───────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (_token) headers['Authorization'] = 'Bearer ' + _token;

  const res = await fetch(API_BASE + path, { ...options, headers });

  if (res.status === 401) {
    apiLogout();
    window.location.reload();
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Erro na requisição');
  }

  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────
async function apiLogin(nome, senha) {
  const data = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ nome, senha }),
  });
  _token    = data.token;
  _nomeUser = data.nome;
  _isAdmin  = data.is_admin;
  localStorage.setItem('gpx_token',   _token);
  localStorage.setItem('gpx_nome',    _nomeUser);
  localStorage.setItem('gpx_isAdmin', _isAdmin);
  return data;
}

async function apiLogout() {
  try { await apiFetch('/auth/logout', { method: 'POST' }); } catch (_) {}
  _token = _nomeUser = null;
  _isAdmin = false;
  localStorage.removeItem('gpx_token');
  localStorage.removeItem('gpx_nome');
  localStorage.removeItem('gpx_isAdmin');
}

// ── Marcações ─────────────────────────────────────────────────────────
async function apiGetMarcacoes()       { return apiFetch('/marcacoes'); }
async function apiSalvarMarcacao(m)    { return apiFetch('/marcacoes',      { method: 'POST',   body: JSON.stringify(m) }); }
async function apiAtualizarMarcacao(id, m) { return apiFetch(`/marcacoes/${id}`, { method: 'PUT', body: JSON.stringify(m) }); }
async function apiDeletarMarcacao(id)  { return apiFetch(`/marcacoes/${id}`, { method: 'DELETE' }); }
async function apiLimparMarcacoes()    { return apiFetch('/marcacoes',       { method: 'DELETE' }); }

// ── Cortes ────────────────────────────────────────────────────────────
async function apiGetCortes()          { return apiFetch('/cortes'); }
async function apiSalvarCorte(c)       { return apiFetch('/cortes',          { method: 'POST',   body: JSON.stringify(c) }); }
async function apiDeletarCorte(id)     { return apiFetch(`/cortes/${id}`,    { method: 'DELETE' }); }
async function apiLimparCortes()       { return apiFetch('/cortes',          { method: 'DELETE' }); }

// ── Config ────────────────────────────────────────────────────────────
async function apiGetConfig()          { return apiFetch('/config'); }
async function apiSalvarConfig(c)      { return apiFetch('/config',          { method: 'PUT',    body: JSON.stringify(c) }); }

// ── Admin ─────────────────────────────────────────────────────────────
async function apiListarUsuarios()     { return apiFetch('/admin/usuarios'); }
async function apiCriarUsuario(u)      { return apiFetch('/admin/usuarios',  { method: 'POST',   body: JSON.stringify(u) }); }
async function apiEditarUsuario(id, u) { return apiFetch(`/admin/usuarios/${id}`, { method: 'PATCH', body: JSON.stringify(u) }); }
async function apiDeletarUsuario(id)   { return apiFetch(`/admin/usuarios/${id}`, { method: 'DELETE' }); }
async function apiUsuariosOnline()     { return apiFetch('/admin/online'); }
async function apiStats()              { return apiFetch('/admin/stats'); }
async function apiEncerrarSessoes(uid) { return apiFetch(`/admin/sessoes/${uid}`, { method: 'DELETE' }); }

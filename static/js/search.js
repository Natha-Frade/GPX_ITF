// ══════════════════════════════════════════════════════════════════════
//  search.js — Busca de localização no mapa
//
//  Usa Nominatim (OpenStreetMap) — gratuito, sem API key
//  Suporta:
//   - Endereços completos
//   - Cidades e estados
//   - Rodovias (BR-277, SP-065...)
//   - Coordenadas diretas (-25.43, -49.27)
//   - Histórico local (localStorage)
// ══════════════════════════════════════════════════════════════════════

const NOMINATIM_URL  = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

let searchMarker     = null;   // marcador do resultado no mapa
let searchDebounce   = null;   // timer para autocomplete
let searchHistory    = [];     // array de {label, lat, lng}
let lastResults      = [];     // últimos resultados da busca

// ── INIT ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSearchHistory();
});

// ── AUTOCOMPLETE ──────────────────────────────────────────────────────
function onSearchInput(value) {
  clearTimeout(searchDebounce);
  const suggestions = document.getElementById('searchSuggestions');

  if (!value || value.length < 3) {
    suggestions.style.display = 'none';
    return;
  }

  // Se parece ser coordenadas, não faz autocomplete
  if (isCoordString(value)) {
    suggestions.style.display = 'none';
    return;
  }

  searchDebounce = setTimeout(() => fetchSuggestions(value), 400);
}

async function fetchSuggestions(query) {
  const suggestions = document.getElementById('searchSuggestions');
  try {
    const params = new URLSearchParams({
      q:              query,
      format:         'json',
      limit:          5,
      countrycodes:   'br',
      addressdetails: 1,
      'accept-language': 'pt-BR',
    });
    const res  = await fetch(NOMINATIM_URL + '?' + params, {
      headers: { 'User-Agent': 'GPX-IMTRAFF/1.0' }
    });
    const data = await res.json();
    if (!data.length) { suggestions.style.display = 'none'; return; }

    suggestions.innerHTML = '';
    data.slice(0, 5).forEach(item => {
      const div = document.createElement('div');
      div.className = 'search-suggestion-item';
      div.textContent = item.display_name;
      div.addEventListener('click', () => {
        document.getElementById('searchInput').value = item.display_name;
        suggestions.style.display = 'none';
        flyToResult(item);
      });
      suggestions.appendChild(div);
    });
    suggestions.style.display = 'block';
  } catch (e) {
    suggestions.style.display = 'none';
  }
}

// Fecha sugestões ao clicar fora
document.addEventListener('click', e => {
  if (!e.target.closest('#searchInput') && !e.target.closest('#searchSuggestions')) {
    const s = document.getElementById('searchSuggestions');
    if (s) s.style.display = 'none';
  }
});

// ── BUSCA PRINCIPAL ───────────────────────────────────────────────────
async function runSearch() {
  const input = document.getElementById('searchInput');
  const query = input?.value?.trim();
  if (!query) return;

  document.getElementById('searchSuggestions').style.display = 'none';

  // Tenta parse de coordenadas primeiro
  const coords = parseCoords(query);
  if (coords) {
    flyToLatLng(coords.lat, coords.lng, 16, query);
    return;
  }

  // Busca no Nominatim
  showToast('Buscando...', 'info');
  try {
    const params = new URLSearchParams({
      q:              query,
      format:         'json',
      limit:          8,
      countrycodes:   'br',
      addressdetails: 1,
      'accept-language': 'pt-BR',
    });

    const res  = await fetch(NOMINATIM_URL + '?' + params, {
      headers: { 'User-Agent': 'GPX-IMTRAFF/1.0' }
    });
    const data = await res.json();

    if (!data.length) {
      showToast('Nenhum resultado para "' + query + '"', 'error');
      return;
    }

    lastResults = data;

    if (data.length === 1) {
      // Um único resultado — vai direto
      flyToResult(data[0]);
    } else {
      // Múltiplos — mostra lista
      renderSearchResults(data);
      // Vai para o primeiro automaticamente
      flyToResult(data[0], false);
    }
  } catch (err) {
    showToast('Erro na busca: ' + err.message, 'error');
  }
}

function renderSearchResults(results) {
  const section = document.getElementById('searchResultsSection');
  const list    = document.getElementById('searchResults');
  section.style.display = '';
  list.innerHTML = '';

  results.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'search-result-item' + (i === 0 ? ' active' : '');

    // Ícone por tipo
    const icon = getResultIcon(item.type, item.class);

    // Nome curto + endereço completo
    const shortName = item.namedetails?.name || item.name || item.display_name.split(',')[0];
    const subtext   = item.display_name.split(',').slice(1).join(',').trim();

    div.innerHTML =
      `<div class="sr-icon">${icon}</div>` +
      `<div class="sr-info">` +
        `<div class="sr-name">${escH(shortName)}</div>` +
        `<div class="sr-sub">${escH(subtext.slice(0, 60))}</div>` +
      `</div>` +
      `<div class="sr-type">${escH(item.type || '')}</div>`;

    div.addEventListener('click', () => {
      list.querySelectorAll('.search-result-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
      flyToResult(item);
    });

    list.appendChild(div);
  });
}

function flyToResult(item, addToHistory = true) {
  const lat  = parseFloat(item.lat);
  const lng  = parseFloat(item.lon);
  const name = item.display_name.split(',').slice(0, 2).join(',').trim();

  flyToLatLng(lat, lng, getZoomForType(item.type, item.class), name, addToHistory);
}

function flyToLatLng(lat, lng, zoom, label, addToHistory = true) {
  // Remove marcador anterior
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }

  // Cria marcador de busca
  const svgIcon = buildSearchMarkerSvg();
  const icon = L.divIcon({
    html:       svgIcon,
    className:  '',
    iconSize:   [28, 38],
    iconAnchor: [14, 36],
    popupAnchor:[0, -36],
  });

  searchMarker = L.marker([lat, lng], { icon, zIndexOffset: 1200 }).addTo(map);
  searchMarker.bindPopup(
    `<div style="font-family:'Syne',sans-serif;min-width:190px;">
      <div style="font-weight:700;font-size:0.85rem;color:#73b753;margin-bottom:4px;">
        ${escH(label?.slice(0, 60) || 'Local')}
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:#888;">
        ${lat.toFixed(6)}, ${lng.toFixed(6)}
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;">
        <button onclick="copyCoords(${lat},${lng})"
          style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--accent);
                 border-radius:5px;padding:4px 8px;font-size:0.65rem;cursor:pointer;font-family:'Syne',sans-serif;">
          Copiar coords
        </button>
        <button onclick="openStreetView(${lat},${lng})"
          style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--accent);
                 border-radius:5px;padding:4px 8px;font-size:0.65rem;cursor:pointer;font-family:'Syne',sans-serif;">
          🧭 Street View
        </button>
        <button onclick="if(searchMarker){map.removeLayer(searchMarker);searchMarker=null;}"
          style="background:transparent;border:1px solid var(--border);color:var(--muted);
                 border-radius:5px;padding:4px 8px;font-size:0.65rem;cursor:pointer;">
          Fechar
        </button>
      </div>
    </div>`,
    { maxWidth: 280 }
  );

  map.flyTo([lat, lng], zoom, { duration: 1.2 });
  setTimeout(() => searchMarker && searchMarker.openPopup(), 1300);

  if (addToHistory && label) {
    addToSearchHistory(label, lat, lng);
  }
}

// ── IR PARA COORDENADAS DIRETAS ───────────────────────────────────────
function gotoCoords() {
  const lat  = parseFloat(document.getElementById('gotoLat').value);
  const lng  = parseFloat(document.getElementById('gotoLng').value);
  const zoom = parseInt(document.getElementById('gotoZoom').value);

  if (isNaN(lat) || isNaN(lng)) {
    showToast('Insira latitude e longitude válidas', 'error');
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showToast('Coordenadas fora do intervalo válido', 'error');
    return;
  }

  flyToLatLng(lat, lng, zoom, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
}

// ── HISTÓRICO ─────────────────────────────────────────────────────────
function loadSearchHistory() {
  try {
    searchHistory = JSON.parse(localStorage.getItem('imtraff_search_history') || '[]');
  } catch { searchHistory = []; }
  renderSearchHistory();
}

function addToSearchHistory(label, lat, lng) {
  // Remove duplicata
  searchHistory = searchHistory.filter(h => !(Math.abs(h.lat - lat) < 0.001 && Math.abs(h.lng - lng) < 0.001));
  // Adiciona no início
  searchHistory.unshift({ label: label.slice(0, 60), lat, lng, ts: Date.now() });
  // Mantém só 10
  searchHistory = searchHistory.slice(0, 10);
  try { localStorage.setItem('imtraff_search_history', JSON.stringify(searchHistory)); } catch {}
  renderSearchHistory();
}

function renderSearchHistory() {
  const section = document.getElementById('searchHistorySection');
  const list    = document.getElementById('searchHistory');
  if (!list) return;

  if (!searchHistory.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = '';

  searchHistory.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'search-history-item';
    div.innerHTML =
      `<div class="sh-icon">🕐</div>` +
      `<div class="sh-info">
        <div class="sh-label">${escH(h.label)}</div>
        <div class="sh-coords">${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}</div>
      </div>` +
      `<button class="sh-del" onclick="removeHistoryItem(${i});event.stopPropagation();" title="Remover">✕</button>`;
    div.addEventListener('click', () => flyToLatLng(h.lat, h.lng, 15, h.label, false));
    list.appendChild(div);
  });
}

function removeHistoryItem(idx) {
  searchHistory.splice(idx, 1);
  try { localStorage.setItem('imtraff_search_history', JSON.stringify(searchHistory)); } catch {}
  renderSearchHistory();
}

function clearSearchHistory() {
  searchHistory = [];
  try { localStorage.removeItem('imtraff_search_history'); } catch {}
  renderSearchHistory();
}

// ── HELPERS ───────────────────────────────────────────────────────────

// Preenche o campo de busca e executa
function fillSearch(text) {
  const input = document.getElementById('searchInput');
  if (input) { input.value = text; runSearch(); }
}

// Tenta parsear uma string de coordenadas
function parseCoords(str) {
  // Formato: "-25.4284, -49.2733" ou "-25.4284 -49.2733"
  const m = str.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (m) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a >= -90 && a <= 90 && b >= -180 && b <= 180) return { lat: a, lng: b };
  }
  return null;
}

function isCoordString(str) {
  return /^-?\d+\.?\d*[,\s]+-?\d+\.?\d*$/.test(str.trim());
}

// Zoom adequado por tipo de resultado
function getZoomForType(type, cls) {
  if (cls === 'highway' || type === 'motorway' || type === 'trunk') return 13;
  if (type === 'city' || type === 'town') return 13;
  if (type === 'village' || type === 'suburb') return 14;
  if (type === 'neighbourhood') return 15;
  if (type === 'road' || type === 'residential') return 16;
  if (cls === 'place') return 12;
  return 15;
}

// Ícone por tipo de resultado
function getResultIcon(type, cls) {
  if (cls === 'highway') return '🛣️';
  if (type === 'city' || type === 'town') return '🏙️';
  if (type === 'village') return '🏘️';
  if (type === 'road' || type === 'residential') return '📍';
  if (cls === 'amenity') return '🏢';
  if (cls === 'natural') return '🌿';
  if (type === 'state') return '🗺️';
  return '📍';
}

// SVG do marcador de busca (diferente dos outros — cor amarela)
function buildSearchMarkerSvg() {
  return `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
    <filter id="sbshadow"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.5)"/></filter>
    <path d="M14 2 C6.82 2 2 7.82 2 14 C2 24 14 36 14 36 C14 36 26 24 26 14 C26 7.82 21.18 2 14 2Z"
          fill="#ffd740" stroke="#FFFFFF" stroke-width="2" filter="url(#sbshadow)"/>
    <circle cx="14" cy="14" r="5" fill="rgba(0,0,0,0.35)"/>
  </svg>`;
}

function copyCoords(lat, lng) {
  const text = lat.toFixed(6) + ', ' + lng.toFixed(6);
  navigator.clipboard?.writeText(text).then(() => showToast('Coordenadas copiadas', 'success'));
}

function escH(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

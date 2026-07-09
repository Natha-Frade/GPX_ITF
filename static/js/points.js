// ══════════════════════════════════════════════════════════════════════
//  points.js — Aba "Pontos": múltiplos GPX + pins estilo Google Earth
// ══════════════════════════════════════════════════════════════════════

// ── ESTADO ──
let pointsGpxLayers = [];   // [{ id, name, color, points[], polyline, outline, visible }]
let savedPoints = [];        // [{ id, lat, lng, label, color, category, marker }]
let pointsAddMode = false;
let nextGpxId = 0;
let nextPointId = 0;
let filterCategory = 'all';

// Paleta de cores para as trilhas GPX
const GPX_COLORS = [
  '#73b753', '#4fc3f7', '#ff7043', '#ab47bc',
  '#ffd740', '#26a69a', '#ef5350', '#42a5f5'
];

// Categorias de pontos
const POINT_CATEGORIES = [
  { id: 'geral',     label: 'Geral',      emoji: '📍', color: '#73b753' },
  { id: 'perigo',    label: 'Perigo',     emoji: '⚠️', color: '#ff7043' },
  { id: 'obra',      label: 'Obra',       emoji: '🚧', color: '#ffd740' },
  { id: 'referencia',label: 'Referência', emoji: '🏁', color: '#4fc3f7' },
  { id: 'acidente',  label: 'Acidente',   emoji: '🚨', color: '#ef5350' },
];

// ── DRAG-AND-DROP na zona de upload ──
const ptUploadZone = document.getElementById('ptUploadZone');
const ptFileInput  = document.getElementById('ptFileInput');

ptFileInput.addEventListener('change', e => {
  [...e.target.files].forEach(f => {
    if (/\.(kmz|kml)$/i.test(f.name)) loadKmzFile(f);
    else loadPointsGpx(f);
  });
  e.target.value = '';
});

ptUploadZone.addEventListener('click', () => ptFileInput.click());

ptUploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  ptUploadZone.classList.add('drag-over');
});
ptUploadZone.addEventListener('dragleave', () => ptUploadZone.classList.remove('drag-over'));
ptUploadZone.addEventListener('drop', e => {
  e.preventDefault();
  ptUploadZone.classList.remove('drag-over');
  const all = [...e.dataTransfer.files];
  const gpxFiles = all.filter(f => /\.gpx$/i.test(f.name));
  const kmzFiles = all.filter(f => /\.(kmz|kml)$/i.test(f.name));
  if (!gpxFiles.length && !kmzFiles.length) {
    showToast('⚠️ Apenas arquivos .gpx, .kmz ou .kml', 'error'); return;
  }
  gpxFiles.forEach(f => loadPointsGpx(f));
  kmzFiles.forEach(f => loadKmzFile(f));
});

// ── CARREGAR GPX ──
function loadPointsGpx(file) {
  if (pointsGpxLayers.length >= 8) {
    showToast('⚠️ Máximo de 8 GPXs simultâneos', 'error'); return;
  }
  const reader = new FileReader();
  reader.onload = ev => parsePointsGpx(ev.target.result, file.name);
  reader.readAsText(file);
}

function parsePointsGpx(text, filename) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  const trkpts = xml.querySelectorAll('trkpt');
  if (!trkpts.length) { showToast('❌ Nenhum ponto no GPX', 'error'); return; }

  const pts = Array.from(trkpts).map(pt => ({
    lat: parseFloat(pt.getAttribute('lat')),
    lng: parseFloat(pt.getAttribute('lon')),
  }));

  const id    = nextGpxId++;
  const color = GPX_COLORS[id % GPX_COLORS.length];
  const name  = filename.replace('.gpx', '');

  // Desenha trilha no mapa
  const latlngs = pts.map(p => [p.lat, p.lng]);
  const outline  = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.5 }).addTo(map);
  const polyline = L.polyline(latlngs, { color, weight: 4, opacity: 0.95 }).addTo(map);

  const layer = { id, name, color, points: pts, polyline, outline, visible: true };
  pointsGpxLayers.push(layer);

  map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
  renderGpxList();
  updatePtEmptyState();
  showToast(`✅ ${name} — ${pts.length} pts`, 'success');
}

// ── RENDER LISTA DE GPX ──
function renderGpxList() {
  const list = document.getElementById('ptGpxList');
  list.innerHTML = '';
  pointsGpxLayers.forEach(layer => {
    const item = document.createElement('div');
    item.className = 'pt-gpx-item' + (layer.visible ? '' : ' hidden-layer');
    item.innerHTML = `
      <div class="pt-gpx-color" style="background:${layer.color}"></div>
      <div class="pt-gpx-name" title="${layer.name}">${layer.name}</div>
      <div class="pt-gpx-pts">${layer.points.length} pts</div>
      <button class="pt-gpx-eye" onclick="toggleGpxLayer(${layer.id})" title="${layer.visible ? 'Ocultar' : 'Mostrar'}">
        ${layer.visible ? '👁' : '🚫'}
      </button>
      <button class="pt-gpx-del" onclick="removeGpxLayer(${layer.id})" title="Remover">✕</button>
    `;
    list.appendChild(item);
  });
}

function toggleGpxLayer(id) {
  const layer = pointsGpxLayers.find(l => l.id === id);
  if (!layer) return;
  layer.visible = !layer.visible;
  if (layer.visible) {
    layer.polyline.addTo(map);
    layer.outline.addTo(map);
    layer.outline.bringToBack();
  } else {
    map.removeLayer(layer.polyline);
    map.removeLayer(layer.outline);
  }
  renderGpxList();
}

function removeGpxLayer(id) {
  const idx = pointsGpxLayers.findIndex(l => l.id === id);
  if (idx === -1) return;
  const layer = pointsGpxLayers[idx];
  map.removeLayer(layer.polyline);
  map.removeLayer(layer.outline);
  pointsGpxLayers.splice(idx, 1);
  renderGpxList();
  updatePtEmptyState();
}

// ── MODO ADICIONAR PINO ──
function toggleAddPointMode() {
  pointsAddMode = !pointsAddMode;
  const btn = document.getElementById('ptAddModeBtn');
  btn.classList.toggle('active', pointsAddMode);
  btn.textContent = pointsAddMode ? '🟢 Clicando no mapa...' : '📍 Adicionar Pino';
  map.getContainer().style.cursor = pointsAddMode ? 'crosshair' : '';
  if (pointsAddMode) showToast('Clique no mapa para colocar um pino', 'info');
}

function handlePointsMapClick(lat, lng) {
  if (currentTab !== 'pontos' || !pointsAddMode) return;
  openPinModal(lat, lng);
}

// ── MODAL DE NOVO PINO ──
function openPinModal(lat, lng) {
  document.getElementById('pinLat').value = lat.toFixed(6);
  document.getElementById('pinLng').value = lng.toFixed(6);
  document.getElementById('pinLabel').value = '';
  document.getElementById('pinModal').style.display = 'flex';
  document.getElementById('pinLabel').focus();
  // Reset category selection
  document.querySelectorAll('.pin-cat-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.pin-cat-btn').classList.add('active');
}

function closePinModal() {
  document.getElementById('pinModal').style.display = 'none';
}

function confirmPinModal() {
  const lat   = parseFloat(document.getElementById('pinLat').value);
  const lng   = parseFloat(document.getElementById('pinLng').value);
  const label = document.getElementById('pinLabel').value.trim() || 'Pino ' + (nextPointId + 1);
  const activeBtn = document.querySelector('.pin-cat-btn.active');
  const catId = activeBtn ? activeBtn.dataset.cat : 'geral';
  addSavedPoint(lat, lng, label, catId);
  closePinModal();
}

// ── ADICIONAR PONTO ──
function addSavedPoint(data, lng, label, catId) {
  // Suporta dois modos de chamada:
  // 1. addSavedPoint({lat,lng,label,color,category,note,serverId}) — vindo da API
  // 2. addSavedPoint(lat, lng, label, catId) — interação direta do usuário
  let lat, color, category, note, serverId;
  if (typeof data === 'object' && data !== null && 'lat' in data) {
    ({ lat, lng, label, color, category, note, serverId } = data);
    catId = category;
  } else {
    lat = data;
  }

  const cat    = POINT_CATEGORIES.find(c => c.id === catId) || POINT_CATEGORIES[0];
  color        = color || cat.color;
  category     = catId || cat.id;
  note         = note  || '';
  const id     = nextPointId++;
  const marker = createPinMarker(lat, lng, label, cat);
  marker.addTo(map);
  const point = { id, lat, lng, label, color, category, note, marker, serverId: serverId || null };
  savedPoints.push(point);
  renderPointsList();

  // Sync com servidor se veio de interação do usuário (não do carregamento inicial)
  if (!serverId && typeof apiLogado === 'function' && apiLogado()) {
    apiSalvarMarcacao({ label, lat, lng, color, category: category || 'Geral', note: note || '' })
      .then(res => { point.serverId = res.id; })
      .catch(() => {});
  }

  if (!serverId) showToast(`📍 "${label}" adicionado`, 'success');
}

function createPinMarker(lat, lng, label, cat) {
  // SVG pin estilo Google Earth
  const svg = `
    <svg width="32" height="42" viewBox="0 0 32 42" xmlns="http://www.w3.org/2000/svg">
      <filter id="shadow" x="-30%" y="-10%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.45)"/>
      </filter>
      <path d="M16 2 C8.268 2 2 8.268 2 16 C2 26 16 40 16 40 C16 40 30 26 30 16 C30 8.268 23.732 2 16 2Z"
            fill="${cat.color}" stroke="white" stroke-width="2" filter="url(#shadow)"/>
      <text x="16" y="20" text-anchor="middle" dominant-baseline="middle"
            font-size="14" style="user-select:none">${cat.emoji}</text>
    </svg>`;

  const icon = L.divIcon({
    html: svg,
    className: '',
    iconSize: [32, 42],
    iconAnchor: [16, 40],
    popupAnchor: [0, -40]
  });

  const marker = L.marker([lat, lng], { icon, draggable: true });
  marker.bindPopup(`
    <div style="font-family:'Syne',sans-serif; min-width:160px;">
      <div style="font-weight:700; font-size:0.9rem; margin-bottom:6px;">${cat.emoji} ${label}</div>
      <div style="font-size:0.72rem; color:#888; font-family:'JetBrains Mono',monospace;">
        ${lat.toFixed(6)}, ${lng.toFixed(6)}
      </div>
      <div style="margin-top:4px; font-size:0.72rem; color:#aaa;">
        Categoria: ${cat.label}
      </div>
      <button onclick="openStreetView(${lat},${lng})"
        style="margin-top:8px;width:100%;background:var(--surface2);border:1px solid var(--border);
               color:var(--accent);border-radius:5px;padding:5px 8px;font-size:0.68rem;cursor:pointer;
               font-family:'Syne',sans-serif;">
        🧭 Abrir Street View
      </button>
    </div>
  `, { maxWidth: 240 });

  // Atualiza coords se arrastar
  marker.on('dragend', e => {
    const p = savedPoints.find(pt => pt.marker === marker);
    if (p) {
      p.lat = e.target.getLatLng().lat;
      p.lng = e.target.getLatLng().lng;
      marker.setPopupContent(`
        <div style="font-family:'Syne',sans-serif; min-width:160px;">
          <div style="font-weight:700; font-size:0.9rem; margin-bottom:6px;">${cat.emoji} ${p.label}</div>
          <div style="font-size:0.72rem; color:#888; font-family:'JetBrains Mono',monospace;">
            ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}
          </div>
          <button onclick="openStreetView(${p.lat},${p.lng})"
            style="margin-top:8px;width:100%;background:var(--surface2);border:1px solid var(--border);
                   color:var(--accent);border-radius:5px;padding:5px 8px;font-size:0.68rem;cursor:pointer;
                   font-family:'Syne',sans-serif;">
            🧭 Abrir Street View
          </button>
        </div>`);
      renderPointsList();
    }
  });
  return marker;
}

// ── RENDER LISTA DE PONTOS ──
function renderPointsList() {
  const list = document.getElementById('ptSavedList');
  const filtered = filterCategory === 'all'
    ? savedPoints
    : savedPoints.filter(p => p.category === filterCategory);

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.75rem;padding:8px 0;text-align:center;">
      ${savedPoints.length ? 'Nenhum pino nessa categoria' : 'Nenhum pino adicionado ainda'}
    </div>`;
    return;
  }

  filtered.forEach(pt => {
    const cat = POINT_CATEGORIES.find(c => c.id === pt.category) || POINT_CATEGORIES[0];
    const item = document.createElement('div');
    item.className = 'pt-saved-item';
    item.innerHTML = `
      <div class="pt-saved-emoji">${cat.emoji}</div>
      <div class="pt-saved-info">
        <div class="pt-saved-label">${pt.label}</div>
        <div class="pt-saved-coords">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</div>
      </div>
      <button class="pt-saved-fly" onclick="flyToPoint(${pt.id})" title="Ir para ponto">⊕</button>
      <button class="pt-saved-sv" onclick="event.stopPropagation();openStreetView(${pt.lat},${pt.lng})" title="Abrir Street View">🧭</button>
      <button class="pt-saved-del" onclick="deletePoint(${pt.id})" title="Remover">✕</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      flyToPoint(pt.id);
    });
    list.appendChild(item);
  });
  document.getElementById('ptCountBadge').textContent = savedPoints.length;
}

function flyToPoint(id) {
  const pt = savedPoints.find(p => p.id === id);
  if (!pt) return;
  map.flyTo([pt.lat, pt.lng], 17, { duration: 1.2 });
  setTimeout(() => pt.marker.openPopup(), 1300);
}

function deletePoint(id) {
  const idx = savedPoints.findIndex(p => p.id === id);
  if (idx === -1) return;
  const pt = savedPoints[idx];
  map.removeLayer(pt.marker);
  // Sync com servidor
  if (pt.serverId && typeof apiLogado === 'function' && apiLogado()) {
    apiDeletarMarcacao(pt.serverId).catch(() => {});
  }
  savedPoints.splice(idx, 1);
  renderPointsList();
}

// ── FILTROS ──
function setPointFilter(cat) {
  filterCategory = cat;
  document.querySelectorAll('.pt-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === cat);
  });
  renderPointsList();
}

// ── EXPORTAR PONTOS ──
function exportPointsKML() {
  if (!savedPoints.length) { showToast('Nenhum pino para exportar', 'error'); return; }
  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>Pontos GPX IMTRAFF</name>\n`;
  savedPoints.forEach(pt => {
    const cat = POINT_CATEGORIES.find(c => c.id === pt.category) || POINT_CATEGORIES[0];
    kml += `  <Placemark>
    <name>${pt.label}</name>
    <description>${cat.label}</description>
    <Point><coordinates>${pt.lng},${pt.lat},0</coordinates></Point>
  </Placemark>\n`;
  });
  kml += `</Document></kml>`;
  triggerDownload(kml, 'pontos-imtraff.kml', 'application/vnd.google-earth.kml+xml');
  showToast(`✅ ${savedPoints.length} pontos exportados (.kml)`, 'success');
}

function exportPointsCSV() {
  if (!savedPoints.length) { showToast('Nenhum pino para exportar', 'error'); return; }
  let csv = 'label,latitude,longitude,categoria\n';
  savedPoints.forEach(pt => {
    const cat = POINT_CATEGORIES.find(c => c.id === pt.category) || POINT_CATEGORIES[0];
    csv += `"${pt.label}",${pt.lat.toFixed(6)},${pt.lng.toFixed(6)},"${cat.label}"\n`;
  });
  triggerDownload(csv, 'pontos-imtraff.csv', 'text/csv');
  showToast(`✅ ${savedPoints.length} pontos exportados (.csv)`, 'success');
}

function clearAllPoints() {
  if (!savedPoints.length) return;
  if (!confirm(`Remover todos os ${savedPoints.length} pinos?`)) return;
  savedPoints.forEach(p => map.removeLayer(p.marker));
  savedPoints = [];
  renderPointsList();
}

// ── EMPTY STATE ──
function updatePtEmptyState() {
  const empty = document.getElementById('ptEmptyState');
  if (empty) empty.style.display = (pointsGpxLayers.length || kmzLayers.length) ? 'none' : 'flex';
}

// Init: render filtros e categorias no modal
document.addEventListener('DOMContentLoaded', () => {
  // Filtros
  const filterBar = document.getElementById('ptFilterBar');
  filterBar.innerHTML = `<button class="pt-filter-btn active" data-filter="all" onclick="setPointFilter('all')">Todos</button>` +
    POINT_CATEGORIES.map(c =>
      `<button class="pt-filter-btn" data-filter="${c.id}" onclick="setPointFilter('${c.id}')">${c.emoji} ${c.label}</button>`
    ).join('');

  // Categorias no modal
  const catRow = document.getElementById('pinCatRow');
  catRow.innerHTML = POINT_CATEGORIES.map((c, i) =>
    `<button class="pin-cat-btn${i === 0 ? ' active' : ''}" data-cat="${c.id}"
       style="--cat-color:${c.color}" onclick="selectPinCat(this)" title="${c.label}">
      ${c.emoji} ${c.label}
    </button>`
  ).join('');

  renderPointsList();
  updatePtEmptyState();
});

function selectPinCat(btn) {
  document.querySelectorAll('.pin-cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Fechar modal ao clicar fora
document.getElementById('pinModal').addEventListener('click', e => {
  if (e.target === document.getElementById('pinModal')) closePinModal();
});

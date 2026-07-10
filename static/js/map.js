// ── map.js — Shared map setup and utilities ──

// ── MAP INITIALIZATION ──
let satelliteLayer = null;
let baseLayer = null;
let useSatellite = false;

const map = L.map('map', { zoomControl: false, maxZoom: 23 }).setView([-15.8, -47.9], 5);

baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 23, maxNativeZoom: 19,
}).addTo(map);

satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles © Esri',
  maxZoom: 23, maxNativeZoom: 19,
});

map.whenReady(() => {
  const pane = document.querySelector('.leaflet-tile-pane');
  if (pane) pane.style.filter = 'brightness(0.85) saturate(0.7) hue-rotate(180deg) invert(1) contrast(1.05)';
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

map.on('mousemove', e => {
  document.getElementById('cursorCoords').textContent =
    `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
});

map.on('click', e => {
  if (currentTab === 'corte') {
    if (!gpxPoints.length) return;
    if (cutMode !== 'click') return;
    handleMapClick(e.latlng.lat, e.latlng.lng);
  } else if (currentTab === 'pontos') {
    if (pointsAddMode) handlePointsMapClick(e.latlng.lat, e.latlng.lng);
  }
});

// ── TAB SWITCHING ──
let currentTab = 'corte';

function switchTab(tab) {
  currentTab = tab;
  const tabs = ['corte', 'unir', 'pontos', 'video', 'gopro'];
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', tabs[i] === tab);
  });
  tabs.forEach(id => {
    const el = document.getElementById('panel-' + id);
    if (el) el.classList.toggle('active', tab === id);
  });
  map.getContainer().style.cursor = (tab === 'pontos' && pointsAddMode) ? 'crosshair' : '';
  if (tab === 'video' && typeof updateVidUI === 'function') updateVidUI();
  if (tab === 'gopro' && typeof batchCheckStatus === 'function') batchCheckStatus();
}

// ── BUSCA: seção colapsável dentro da aba Marcações ──
let ptSearchOpen = false;

function togglePtSearch(forceOpen) {
  const body    = document.getElementById('ptSearchBody');
  const chevron = document.getElementById('ptSearchChevron');
  if (!body) return;
  ptSearchOpen = forceOpen !== undefined ? forceOpen : !ptSearchOpen;
  body.style.display = ptSearchOpen ? '' : 'none';
  if (chevron) chevron.style.transform = ptSearchOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  if (ptSearchOpen) {
    setTimeout(() => {
      const inp = document.getElementById('searchInput');
      if (inp) inp.focus();
    }, 100);
  }
}

// ── SHARED MAP CONTROLS ──
function toggleSatellite() {
  useSatellite = !useSatellite;
  if (useSatellite) {
    map.removeLayer(baseLayer);
    satelliteLayer.addTo(map);
    document.getElementById('satBtn').textContent = '🗺';
    document.querySelector('.leaflet-tile-pane').style.filter = 'none';
  } else {
    map.removeLayer(satelliteLayer);
    baseLayer.addTo(map);
    document.getElementById('satBtn').textContent = '🛰';
    document.querySelector('.leaflet-tile-pane').style.filter = 'brightness(0.85) saturate(0.7) hue-rotate(180deg) invert(1) contrast(1.05)';
  }
  refreshTrackStyle();
}

function fitToTrack() {
  const allPolylines = [
    ...mergePolylines,
    ...pointsGpxLayers.map(l => l.polyline).filter(Boolean),
    ...(typeof kmzLayers !== 'undefined' ? kmzLayers.flatMap(l => l.trackPolylines) : []),
  ];
  const kmzMarkerPos = typeof kmzLayers !== 'undefined'
    ? kmzLayers.flatMap(l => l.markerObjs.map(m => m.getLatLng()))
    : [];

  if (allPolylines.length || kmzMarkerPos.length) {
    let bounds = allPolylines.length ? allPolylines[0].getBounds() : L.latLngBounds(kmzMarkerPos);
    for (let i = allPolylines.length ? 1 : 0; i < allPolylines.length; i++) bounds = bounds.extend(allPolylines[i].getBounds());
    if (kmzMarkerPos.length) bounds = bounds.extend(kmzMarkerPos);
    map.fitBounds(bounds, { padding: [30, 30] });
    return;
  }
  if (trackPolyline) map.fitBounds(trackPolyline.getBounds(), { padding: [30, 30] });
}

// ── SHARED UTILS ──
function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function totalKm(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.className = 'toast', 3000);
}

// ── STREET VIEW ──
// Implementação completa (embutido com fallback externo) em js/streetview.js

// ── SHARED ARROW & DOT HELPERS ──

function bearing(from, to) {
  const lat1 = from[0] * Math.PI / 180;
  const lat2 = to[0]  * Math.PI / 180;
  const dLng  = (to[1] - from[1]) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function makeArrowMarker(latlng, angleDeg, color, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="14" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>
    <polygon points="18,5 25,26 18,21 11,26" fill="${color}" stroke="#000" stroke-width="1.2"
      transform="rotate(${angleDeg},18,18)"/>
  </svg>`;
  const icon = L.divIcon({ html: svg, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
  const marker = L.marker(latlng, { icon, zIndexOffset: 800 });
  if (label) marker.bindTooltip(label, { permanent: false, direction: 'top', className: 'marker-label' });
  return marker;
}

function makeStartDot(latlng, color, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="8" fill="${color}" stroke="#000" stroke-width="2"/>
    <circle cx="11" cy="11" r="3" fill="#fff"/>
  </svg>`;
  const icon = L.divIcon({ html: svg, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
  const marker = L.marker(latlng, { icon, zIndexOffset: 700 });
  if (label) marker.bindTooltip(label, { permanent: false, direction: 'top', className: 'marker-label' });
  return marker;
}

function addTrackArrows(latlngs, color, slotLabel) {
  const markers = [];
  if (latlngs.length < 2) return markers;
  const startDot = makeStartDot(latlngs[0], color, `▶ INÍCIO ${slotLabel}`);
  startDot.addTo(map);
  markers.push(startDot);
  const last  = latlngs[latlngs.length - 1];
  const prev  = latlngs[latlngs.length - 2];
  const angle = bearing(prev, last);
  const endArrow = makeArrowMarker(last, angle, color, `⛳ FIM ${slotLabel}`);
  endArrow.addTo(map);
  markers.push(endArrow);
  return markers;
}

// ── MELHORIAS DO MAPA (v8) ──

// ── Escala métrica (canto inferior esquerdo) ──
L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

// ── Modo híbrido: satélite + nomes de rodovias/cidades ──
// Esri Reference sobreposta à World Imagery (BR-xxx aparecem no satélite)
const labelsLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 23, maxNativeZoom: 19, opacity: 0.9 }
);
const placesLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 23, maxNativeZoom: 19, opacity: 0.9 }
);

// Encapsula o toggleSatellite original para ligar/desligar os rótulos junto
const _toggleSatOriginal = toggleSatellite;
toggleSatellite = function () {
  _toggleSatOriginal();
  if (useSatellite) { labelsLayer.addTo(map); placesLayer.addTo(map); }
  else { map.removeLayer(labelsLayer); map.removeLayer(placesLayer); }
};

// ── Tela cheia ──
function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

// ── Clique DIREITO no mapa: Street View no ponto da trilha mais próximo,
//    já orientado no sentido do tráfego ──
map.on('contextmenu', e => {
  if (typeof gpxPoints === 'undefined' || !gpxPoints.length) {
    openStreetView(e.latlng.lat, e.latlng.lng);
    return;
  }
  const idx = nearestPointIndex(e.latlng.lat, e.latlng.lng);
  const p = gpxPoints[idx];
  // Abre já em modo percurso a partir desse ponto
  if (typeof svTourStart === 'function' && STREETVIEW_EMBEDDED_ENABLED) {
    map.setView([p.lat, p.lng], map.getZoom()); // svTourStart usa o centro
    svTourStart();
  } else {
    openStreetView(p.lat, p.lng);
  }
});

// ── Coordenada no clique: copia para a área de transferência com Ctrl ──
map.on('click', e => {
  if (e.originalEvent && e.originalEvent.ctrlKey) {
    const txt = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
    navigator.clipboard?.writeText(txt).then(() =>
      showToast('Coordenada copiada: ' + txt, 'success'));
  }
});

// ══════════════════════════════════════════════════════════════════════
//  cut.js — v7 — Corte avançado com múltiplos cortes, drag e reset individual
// ══════════════════════════════════════════════════════════════════════

// ── ESTADO PRINCIPAL ──
let gpxPoints   = [];
let cutMode     = 'click';
let trackPolyline  = null;
let trackOutline   = null;
let cutArrowMarkers = [];

// ── ESTADO DO CORTE ATUAL (em construção) ──
// activeTarget: 'start' | 'end' | null  — qual ponto o próximo clique define
let activeTarget   = 'start';   // padrão: próximo clique define início
let pendingStart   = null;      // { idx, marker, latlng }
let pendingEnd     = null;      // { idx, marker, latlng }
let previewPolyline = null;

// ── LISTA DE CORTES SALVOS ──
// Cada item: { id, startIdx, endIdx, polyline, startMarker, endMarker, name }
let savedCuts   = [];
let nextCutId   = 0;

// ──────────────────────────────────────────────────────────────────────
//  UPLOAD / PARSE
// ──────────────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => parseGPX(ev.target.result, file.name);
  reader.readAsText(file);
});

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.gpx')) {
    const reader = new FileReader();
    reader.onload = ev => parseGPX(ev.target.result, file.name);
    reader.readAsText(file);
  } else showToast('Arquivo deve ser .gpx', 'error');
});

function parseGPX(text, name) {
  const parser = new DOMParser();
  const xml    = parser.parseFromString(text, 'application/xml');
  const trkpts = xml.querySelectorAll('trkpt');
  if (!trkpts.length) { showToast('Nenhum ponto no GPX', 'error'); return; }
  gpxPoints = Array.from(trkpts).map(pt => {
    // getElementsByTagName ignora namespace — funciona com xmlns do GPX/Garmin
    const eleEl  = pt.getElementsByTagName('ele')[0];
    const timeEl = pt.getElementsByTagName('time')[0];
    return {
      lat:  parseFloat(pt.getAttribute('lat')),
      lng:  parseFloat(pt.getAttribute('lon')),
      ele:  eleEl  ? parseFloat(eleEl.textContent)  : 0,
      time: timeEl ? timeEl.textContent.trim() : '',
    };
  });
  drawTrack();
  updateInfo();
  showSections();
  clearPending();
  clearAllCuts();
  showToast(gpxPoints.length + ' pontos carregados', 'success');
  document.getElementById('fileStatus').textContent = name.replace('.gpx', '');
  document.getElementById('fileStatus').classList.add('active');
  document.getElementById('emptyState').style.display = 'none';
  if (typeof kmcalcFromGPX === 'function') kmcalcFromGPX();
  if (typeof onCutGpxLoaded === 'function') onCutGpxLoaded();
  // Atualiza o painel de corte por tempo se já estiver montado no DOM
  if (document.getElementById('timeGpxInfo')) populateTimeCutPanel();
}

// ──────────────────────────────────────────────────────────────────────
//  DESENHO DO TRAÇADO
// ──────────────────────────────────────────────────────────────────────
function getTrackStyle() {
  const zoom = map.getZoom();
  if (useSatellite) {
    const w = zoom >= 15 ? 9 : zoom >= 13 ? 7 : zoom >= 11 ? 5 : 4;
    return { outline: { color: '#000000', weight: w + 4, opacity: 0.7 },
             line:    { color: '#FFE600', weight: w,     opacity: 1   } };
  }
  const w = zoom >= 15 ? 5 : zoom >= 13 ? 4 : 3.5;
  return { outline: { color: '#000000', weight: w + 3, opacity: 0.4 },
           line:    { color: '#73b753', weight: w,     opacity: 0.9 } };
}

function drawTrack() {
  if (trackPolyline) map.removeLayer(trackPolyline);
  if (trackOutline)  map.removeLayer(trackOutline);
  cutArrowMarkers.forEach(m => map.removeLayer(m));
  cutArrowMarkers = [];

  const latlngs = gpxPoints.map(p => [p.lat, p.lng]);
  const style   = getTrackStyle();
  trackOutline  = L.polyline(latlngs, style.outline).addTo(map);
  trackPolyline = L.polyline(latlngs, style.line).addTo(map);
  trackPolyline.on('click', e => {
    if (cutMode !== 'click') return;
    L.DomEvent.stopPropagation(e);
    handleMapClick(e.latlng.lat, e.latlng.lng);
  });
  cutArrowMarkers = addTrackArrows(latlngs, style.line.color, 'Traçado');
  fitToTrack();
}

function refreshTrackStyle() {
  if (!trackPolyline || !trackOutline) return;
  const style = getTrackStyle();
  trackOutline.setStyle(style.outline);
  trackPolyline.setStyle(style.line);
}
map.on('zoomend', refreshTrackStyle);

// ──────────────────────────────────────────────────────────────────────
//  INFO PANEL
// ──────────────────────────────────────────────────────────────────────
function updateInfo() {
  const total = totalKm(gpxPoints);
  document.getElementById('statPoints').textContent = gpxPoints.length.toLocaleString('pt-BR');
  document.getElementById('statTotal').textContent  = total.toFixed(3) + ' km';
  document.getElementById('statStart').textContent  = gpxPoints[0].lat.toFixed(4) + ',' + gpxPoints[0].lng.toFixed(4);
  document.getElementById('statEnd').textContent    = gpxPoints.at(-1).lat.toFixed(4) + ',' + gpxPoints.at(-1).lng.toFixed(4);
  updateOffsetPreview();
}

function showSections() {
  document.getElementById('gpxInfoSection').style.display = '';
  document.getElementById('cutSection').style.display     = '';
}

// ──────────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────────
function kmUpTo(pts, idx) {
  let d = 0;
  for (let i = 1; i <= idx; i++) d += haversine(pts[i-1], pts[i]);
  return d;
}

function nearestPointIndex(lat, lng) {
  let best = 0, bestDist = Infinity;
  gpxPoints.forEach((p, i) => {
    const d = Math.hypot(p.lat - lat, p.lng - lng);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// ──────────────────────────────────────────────────────────────────────
//  MODO DE CORTE
// ──────────────────────────────────────────────────────────────────────
function setMode(mode) {
  cutMode = mode;
  document.getElementById('modeClick').classList.toggle('active', mode === 'click');
  document.getElementById('modeCoord').classList.toggle('active', mode === 'coord');
  document.getElementById('modeTime').classList.toggle('active',  mode === 'time');
  document.getElementById('clickModePanel').style.display = mode === 'click' ? '' : 'none';
  document.getElementById('coordModePanel').style.display = mode === 'coord' ? '' : 'none';
  document.getElementById('timeModePanel').style.display  = mode === 'time'  ? '' : 'none';
  if (mode === 'time') populateTimeCutPanel();
  clearPending();
}

// ──────────────────────────────────────────────────────────────────────
//  CORTE POR TEMPO
// ──────────────────────────────────────────────────────────────────────

/**
 * Converte string ISO 8601 do GPX para objeto Date.
 * Suporta tanto "2024-03-15T10:23:05Z" quanto "2024-03-15T10:23:05.000Z".
 */
function parseGpxTime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr);
}

/**
 * Preenche o painel de tempo com a duração total do GPX.
 */
function populateTimeCutPanel() {
  const infoEl = document.getElementById('timeGpxInfo');
  if (!infoEl) return;

  if (!gpxPoints || !gpxPoints.length) {
    infoEl.textContent = 'Carregue um GPX para ver a duração disponível.';
    return;
  }

  const firstWithTime = gpxPoints.find(p => p.time);
  const lastWithTime  = [...gpxPoints].reverse().find(p => p.time);

  if (!firstWithTime || !lastWithTime) {
    infoEl.textContent = 'Este GPX não possui dados de tempo nos pontos.';
    return;
  }

  const tStart = parseGpxTime(firstWithTime.time);
  const tEnd   = parseGpxTime(lastWithTime.time);
  if (!tStart || !tEnd) { infoEl.textContent = 'Não foi possível ler os timestamps.'; return; }

  const durMs  = tEnd - tStart;
  const durMin = Math.floor(durMs / 60000);
  const durSec = Math.floor((durMs % 60000) / 1000);
  const durH   = Math.floor(durMin / 60);
  const durStr = durH > 0
    ? `${durH}h ${String(durMin % 60).padStart(2,'0')}min ${String(durSec).padStart(2,'0')}s`
    : `${durMin}min ${String(durSec).padStart(2,'0')}s`;

  infoEl.innerHTML =
    `GPX com <strong style="color:var(--accent)">${durStr}</strong> de duração<br>` +
    `<span style="font-size:0.65rem;color:var(--muted)">` +
    `${tStart.toLocaleString('pt-BR')} → ${tEnd.toLocaleString('pt-BR')}</span>`;

  document.getElementById('timeCutStartMin').value = 0;
  document.getElementById('timeCutStartSec').value = 0;
  document.getElementById('timeCutEndMin').value   = durMin;
  document.getElementById('timeCutEndSec').value   = durSec;

  previewTimeCut();
}

/**
 * Acha o índice do ponto mais próximo de um offset em ms a partir do início do GPX.
 */
function nearestPointByTime(offsetMs) {
  const firstWithTime = gpxPoints.find(p => p.time);
  if (!firstWithTime) return 0;
  const t0 = parseGpxTime(firstWithTime.time).getTime();
  const target = t0 + offsetMs;

  let bestIdx = 0, bestDiff = Infinity;
  for (let i = 0; i < gpxPoints.length; i++) {
    if (!gpxPoints[i].time) continue;
    const diff = Math.abs(parseGpxTime(gpxPoints[i].time).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Lê os 4 inputs (min/seg início/fim) e retorna offsets em ms.
 */
function readTimeInputs() {
  const sMin = parseInt(document.getElementById('timeCutStartMin').value) || 0;
  const sSec = parseInt(document.getElementById('timeCutStartSec').value) || 0;
  const eMin = parseInt(document.getElementById('timeCutEndMin').value)   || 0;
  const eSec = parseInt(document.getElementById('timeCutEndSec').value)   || 0;
  return {
    startMs: (sMin * 60 + sSec) * 1000,
    endMs:   (eMin * 60 + eSec) * 1000,
  };
}

/**
 * Atualiza o preview em tempo real.
 */
function previewTimeCut() {
  const previewEl = document.getElementById('timeCutPreview');
  if (!gpxPoints || !gpxPoints.length || !gpxPoints.find(p => p.time)) {
    previewEl.style.display = 'none'; return;
  }
  const { startMs, endMs } = readTimeInputs();
  if (endMs <= startMs) { previewEl.style.display = 'none'; return; }

  const idxS = nearestPointByTime(startMs);
  const idxE = nearestPointByTime(endMs);
  if (idxS >= idxE) { previewEl.style.display = 'none'; return; }

  const slice = gpxPoints.slice(idxS, idxE + 1);
  document.getElementById('timeCutPoints').textContent = slice.length.toLocaleString('pt-BR');
  document.getElementById('timeCutDist').textContent   = totalKm(slice).toFixed(3) + ' km';
  previewEl.style.display = '';
}

/**
 * Exporta o GPX do trecho selecionado por tempo diretamente, sem passar pelo mapa.
 */
function applyTimeCut() {
  if (!gpxPoints || !gpxPoints.length) {
    showToast('Nenhum GPX carregado', 'error'); return;
  }
  if (!gpxPoints.find(p => p.time)) {
    showToast('GPX sem dados de tempo', 'error'); return;
  }

  const { startMs, endMs } = readTimeInputs();
  if (endMs <= startMs) {
    showToast('O fim deve ser depois do início', 'error'); return;
  }

  const idxS = nearestPointByTime(startMs);
  const idxE = nearestPointByTime(endMs);
  if (idxS >= idxE) {
    showToast('Intervalo não cobre pontos suficientes', 'error'); return;
  }

  // Posiciona marcadores no mapa para feedback visual
  placePendingMarker('start', idxS, gpxPoints[idxS]);
  placePendingMarker('end',   idxE, gpxPoints[idxE]);
  drawPreviewCut();
  updatePendingUI();
  if (previewPolyline) map.fitBounds(previewPolyline.getBounds(), { padding: [40, 40] });

  const pts   = gpxPoints.slice(idxS, idxE + 1);
  const lines = pts.map(p => {
    const el = p.ele  ? `\n      <ele>${p.ele}</ele>`   : '';
    const tm = p.time ? `\n      <time>${p.time}</time>` : '';
    return `    <trkpt lat="${p.lat.toFixed(8)}" lon="${p.lng.toFixed(8)}">${el}${tm}\n    </trkpt>`;
  });
  const gpxOut =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="GPX IMTRAFF" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `  <metadata><name>Corte por Tempo</name><time>${new Date().toISOString()}</time></metadata>\n` +
    '  <trk><name>Corte por Tempo</name><trkseg>\n' +
    lines.join('\n') + '\n' +
    '  </trkseg></trk>\n</gpx>';

  const blob = new Blob([gpxOut], { type: 'application/gpx+xml' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  const sMin = Math.floor(startMs / 60000);
  const sSec = Math.floor((startMs % 60000) / 1000);
  const eMin = Math.floor(endMs / 60000);
  const eSec = Math.floor((endMs % 60000) / 1000);
  a.download = `corte_${String(sMin).padStart(2,'0')}m${String(sSec).padStart(2,'0')}s-${String(eMin).padStart(2,'0')}m${String(eSec).padStart(2,'0')}s.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);

  showToast(`Corte exportado — ${pts.length} pontos, ${totalKm(pts).toFixed(3)} km`, 'success');
}

// ──────────────────────────────────────────────────────────────────────
//  SELEÇÃO DE QUAL PONTO DEFINIR PRIMEIRO
// ──────────────────────────────────────────────────────────────────────
function setActiveTarget(target) {
  activeTarget = target;
  document.getElementById('btnTargetStart').classList.toggle('active', target === 'start');
  document.getElementById('btnTargetEnd').classList.toggle('active',   target === 'end');
}

// ──────────────────────────────────────────────────────────────────────
//  CLICK NO MAPA
// ──────────────────────────────────────────────────────────────────────
function handleMapClick(lat, lng) {
  const idx = nearestPointIndex(lat, lng);
  const pt  = gpxPoints[idx];

  if (activeTarget === 'start') {
    placePendingMarker('start', idx, pt);
    // Após definir início, muda alvo automaticamente para fim (se não estiver definido)
    if (!pendingEnd) setActiveTarget('end');
  } else {
    placePendingMarker('end', idx, pt);
    if (!pendingStart) setActiveTarget('start');
  }

  updatePendingUI();
  if (pendingStart && pendingEnd) drawPreviewCut();
}

function placePendingMarker(which, idx, pt) {
  const isStart = which === 'start';
  const color   = isStart ? '#73b753' : '#216C3E';
  const label   = isStart ? 'INÍCIO'  : 'FIM';

  // Remove marcador anterior se existir
  if (isStart && pendingStart) { map.removeLayer(pendingStart.marker); }
  if (!isStart && pendingEnd)  { map.removeLayer(pendingEnd.marker); }

  // Cria marcador arrastável
  const svgIcon = buildCutMarkerSvg(color, label[0]);
  const icon    = L.divIcon({ html: svgIcon, className: '', iconSize: [28, 38], iconAnchor: [14, 36] });
  const marker  = L.marker([pt.lat, pt.lng], { icon, draggable: true, zIndexOffset: 900 }).addTo(map);

  // Drag: ao arrastar, snapping para o ponto mais próximo do traçado
  marker.on('drag', e => {
    const nearIdx = nearestPointIndex(e.latlng.lat, e.latlng.lng);
    const nearPt  = gpxPoints[nearIdx];
    marker.setLatLng([nearPt.lat, nearPt.lng]);
    if (isStart) pendingStart.idx = nearIdx;
    else         pendingEnd.idx   = nearIdx;
    if (pendingStart && pendingEnd) drawPreviewCut();
    updatePendingUI();
  });

  marker.on('dragend', () => updatePendingUI());

  const obj = { idx, marker, latlng: [pt.lat, pt.lng] };
  if (isStart) pendingStart = obj;
  else         pendingEnd   = obj;
}

function buildCutMarkerSvg(color, letter) {
  return `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
    <filter id="ds"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="rgba(0,0,0,0.5)"/></filter>
    <path d="M14 2 C6.82 2 2 7.82 2 14 C2 24 14 36 14 36 C14 36 26 24 26 14 C26 7.82 21.18 2 14 2Z"
          fill="${color}" stroke="#FFFFFF" stroke-width="2" filter="url(#ds)"/>
    <text x="14" y="16" text-anchor="middle" dominant-baseline="middle"
          font-family="Arial" font-size="10" font-weight="800" fill="#FFFFFF">${letter}</text>
  </svg>`;
}

function drawPreviewCut() {
  if (previewPolyline) map.removeLayer(previewPolyline);
  if (!pendingStart || !pendingEnd) return;
  const [s, e] = sortedPending();
  const slice  = gpxPoints.slice(s, e + 1).map(p => [p.lat, p.lng]);
  previewPolyline = L.polyline(slice, { color: '#ffd700', weight: 5, opacity: 0.9, dashArray: '8 4' }).addTo(map);
}

function sortedPending() {
  const a = pendingStart.idx, b = pendingEnd.idx;
  return a <= b ? [a, b] : [b, a];
}

function updatePendingUI() {
  const sl = document.getElementById('clickStartLabel');
  const el = document.getElementById('clickEndLabel');
  const cutBtn = document.getElementById('cutBtn');

  if (pendingStart) {
    const pt = gpxPoints[pendingStart.idx];
    sl.textContent = 'INÍCIO: ' + pt.lat.toFixed(5) + ', ' + pt.lng.toFixed(5);
    sl.style.color = 'var(--start-color)';
    // Sincroniza coordenadas
    const sLat = document.getElementById('startLat');
    const sLng = document.getElementById('startLng');
    if (sLat) sLat.value = pt.lat.toFixed(6);
    if (sLng) sLng.value = pt.lng.toFixed(6);
    // Sincroniza tempo
    syncTimeCutFromMarker('start', pendingStart.idx);
    // Card de coordenada do corte
    const csEl = document.getElementById('cutCoordStart');
    if (csEl) {
      const timeStr = getOffsetLabel(pendingStart.idx);
      csEl.innerHTML = pt.lat.toFixed(5) + ', ' + pt.lng.toFixed(5) +
        (timeStr ? `<br><span style="font-size:0.65rem;color:var(--muted);">${timeStr}</span>` : '');
      csEl.style.color = 'var(--accent)';
    }
  } else {
    sl.textContent = 'INÍCIO: não definido';
    sl.style.color = 'var(--muted)';
    const csEl = document.getElementById('cutCoordStart');
    if (csEl) { csEl.innerHTML = '—'; csEl.style.color = 'var(--muted)'; }
  }

  if (pendingEnd) {
    const pt = gpxPoints[pendingEnd.idx];
    el.textContent = 'FIM: ' + pt.lat.toFixed(5) + ', ' + pt.lng.toFixed(5);
    el.style.color = 'var(--end-color)';
    // Sincroniza coordenadas
    const eLat = document.getElementById('endLat');
    const eLng = document.getElementById('endLng');
    if (eLat) eLat.value = pt.lat.toFixed(6);
    if (eLng) eLng.value = pt.lng.toFixed(6);
    // Sincroniza tempo
    syncTimeCutFromMarker('end', pendingEnd.idx);
    // Card de coordenada do corte
    const ceEl = document.getElementById('cutCoordEnd');
    if (ceEl) {
      const timeStr = getOffsetLabel(pendingEnd.idx);
      ceEl.innerHTML = pt.lat.toFixed(5) + ', ' + pt.lng.toFixed(5) +
        (timeStr ? `<br><span style="font-size:0.65rem;color:var(--muted);">${timeStr}</span>` : '');
      ceEl.style.color = 'var(--accent)';
    }
  } else {
    el.textContent = 'FIM: não definido';
    el.style.color = 'var(--muted)';
    const ceEl = document.getElementById('cutCoordEnd');
    if (ceEl) { ceEl.innerHTML = '—'; ceEl.style.color = 'var(--muted)'; }
  }

  const ready = pendingStart && pendingEnd;
  cutBtn.disabled = !ready;

  if (ready) {
    const [s, e] = sortedPending();
    const km = totalKm(gpxPoints.slice(s, e + 1));
    document.getElementById('sectionKm').textContent = km.toFixed(3) + ' km';
    document.getElementById('selectedCount').textContent = '2 / 2';
  } else {
    document.getElementById('sectionKm').textContent = '—';
    document.getElementById('selectedCount').textContent = (pendingStart || pendingEnd ? '1' : '0') + ' / 2';
  }
}

// Retorna string formatada "Xmin Ys" do offset do ponto em relação ao início do GPX
function getOffsetLabel(idx) {
  if (!gpxPoints || !gpxPoints[idx] || !gpxPoints[idx].time) return '';
  const firstWithTime = gpxPoints.find(p => p.time);
  if (!firstWithTime) return '';
  const t0       = new Date(firstWithTime.time).getTime();
  const tPt      = new Date(gpxPoints[idx].time).getTime();
  const offsetMs = Math.max(0, tPt - t0);
  const min      = Math.floor(offsetMs / 60000);
  const sec      = Math.floor((offsetMs % 60000) / 1000);
  return min > 0
    ? `${min}min ${String(sec).padStart(2,'0')}s`
    : `${sec}s`;
}

// Sincroniza campos min/seg do modo Tempo a partir do índice do marcador
function syncTimeCutFromMarker(which, idx) {
  if (!gpxPoints || !gpxPoints[idx] || !gpxPoints[idx].time) return;
  const firstWithTime = gpxPoints.find(p => p.time);
  if (!firstWithTime) return;
  const t0       = new Date(firstWithTime.time).getTime();
  const tPt      = new Date(gpxPoints[idx].time).getTime();
  const offsetMs = Math.max(0, tPt - t0);
  const min      = Math.floor(offsetMs / 60000);
  const sec      = Math.floor((offsetMs % 60000) / 1000);
  if (which === 'start') {
    const mEl = document.getElementById('timeCutStartMin');
    const sEl = document.getElementById('timeCutStartSec');
    if (mEl) mEl.value = min;
    if (sEl) sEl.value = sec;
  } else {
    const mEl = document.getElementById('timeCutEndMin');
    const sEl = document.getElementById('timeCutEndSec');
    if (mEl) mEl.value = min;
    if (sEl) sEl.value = sec;
  }
  if (document.getElementById('timeModePanel')?.style.display !== 'none') previewTimeCut();
}

// Reset individual
function resetStart() {
  if (pendingStart) { map.removeLayer(pendingStart.marker); pendingStart = null; }
  setActiveTarget('start');
  if (previewPolyline) { map.removeLayer(previewPolyline); previewPolyline = null; }
  updatePendingUI();
}

function resetEnd() {
  if (pendingEnd) { map.removeLayer(pendingEnd.marker); pendingEnd = null; }
  setActiveTarget('end');
  if (previewPolyline) { map.removeLayer(previewPolyline); previewPolyline = null; }
  updatePendingUI();
}

function clearPending() {
  if (pendingStart)    { map.removeLayer(pendingStart.marker); pendingStart = null; }
  if (pendingEnd)      { map.removeLayer(pendingEnd.marker);   pendingEnd   = null; }
  if (previewPolyline) { map.removeLayer(previewPolyline);     previewPolyline = null; }
  activeTarget = 'start';
  setActiveTarget('start');
  updatePendingUI();
}

// ──────────────────────────────────────────────────────────────────────
//  MODO COORDENADAS
// ──────────────────────────────────────────────────────────────────────
function applyCoordCut() {
  const sLat = parseFloat(document.getElementById('startLat').value);
  const sLng = parseFloat(document.getElementById('startLng').value);
  const eLat = parseFloat(document.getElementById('endLat').value);
  const eLng = parseFloat(document.getElementById('endLng').value);
  if (isNaN(sLat) || isNaN(sLng) || isNaN(eLat) || isNaN(eLng)) {
    showToast('Preencha as 4 coordenadas', 'error'); return;
  }
  placePendingMarker('start', nearestPointIndex(sLat, sLng), gpxPoints[nearestPointIndex(sLat, sLng)]);
  placePendingMarker('end',   nearestPointIndex(eLat, eLng), gpxPoints[nearestPointIndex(eLat, eLng)]);
  updatePendingUI();
  drawPreviewCut();
}

// ──────────────────────────────────────────────────────────────────────
//  KM OFFSET
// ──────────────────────────────────────────────────────────────────────
// ── KM INICIAL DA VIA: direção + cálculo do KM final ──
let kmDirection = 1; // 1 = crescente (+), -1 = decrescente (-)

function getKmOffset() {
  return (parseFloat(document.getElementById('kmOffsetInt').value) || 0) +
         (parseFloat(document.getElementById('kmOffsetDec').value) || 0) / 1000;
}

function toggleKmDirection() {
  kmDirection *= -1;
  const btn  = document.getElementById('kmDirToggle');
  const hint = document.getElementById('kmDirHint');
  if (kmDirection === 1) {
    btn.textContent = '▲';
    hint.textContent = '▲ Sentido crescente — KM final = inicial + percorrido';
  } else {
    btn.textContent = '▼';
    hint.textContent = '▼ Sentido decrescente — KM final = inicial − percorrido';
  }
  updateOffsetPreview();
}

function updateOffsetPreview() {
  const startInt = document.getElementById('kmOffsetInt').value;
  const startDisplay = document.getElementById('kmOffsetStartDisplay');
  const endDisplay   = document.getElementById('kmOffsetEndDisplay');
  if (!startDisplay || !endDisplay) return;

  const offset = getKmOffset();

  if (!startInt) {
    startDisplay.textContent = '—';
    endDisplay.textContent   = '—';
    return;
  }

  startDisplay.textContent = formatKmMarker(offset);

  if (!gpxPoints || !gpxPoints.length) {
    endDisplay.textContent = '—';
    return;
  }

  const percorrido = totalKm(gpxPoints);
  const kmFinal = offset + (kmDirection * percorrido);
  endDisplay.textContent = formatKmMarker(Math.max(0, kmFinal));
}

function formatKmMarker(km) {
  const i = Math.floor(km);
  const d = Math.round((km - i) * 1000);
  return i + '+' + String(d).padStart(3, '0');
}

// ──────────────────────────────────────────────────────────────────────
//  EXECUTAR CORTE — salva na lista
// ──────────────────────────────────────────────────────────────────────
function executeCut() {
  if (!pendingStart || !pendingEnd) { showToast('Defina início e fim do corte', 'error'); return; }

  const [s, e] = sortedPending();
  const pts    = gpxPoints.slice(s, e + 1);
  const offset = getKmOffset();
  const kmS    = offset + (kmDirection * kmUpTo(gpxPoints, s));
  const kmE    = offset + (kmDirection * kmUpTo(gpxPoints, e));
  const kmPerc = totalKm(pts);
  const id     = nextCutId++;
  const name   = 'Corte ' + (id + 1) + '  KM ' + formatKmMarker(kmS) + ' → ' + formatKmMarker(kmE);

  // Desenha o trecho salvo no mapa (cor permanente)
  const COLORS = ['#ffd700', '#ff7043', '#4fc3f7', '#ab47bc', '#ff80ab', '#69f0ae'];
  const color  = COLORS[id % COLORS.length];
  const poly   = L.polyline(pts.map(p => [p.lat, p.lng]), { color, weight: 5, opacity: 1 }).addTo(map);

  // Clona os marcadores como estáticos (remove o drag)
  if (pendingStart) map.removeLayer(pendingStart.marker);
  if (pendingEnd)   map.removeLayer(pendingEnd.marker);

  const mkStart = L.circleMarker([pts[0].lat, pts[0].lng], {
    radius: 8, color, fillColor: color, fillOpacity: 1, weight: 2
  }).addTo(map).bindTooltip('INÍCIO ' + name.split(' ')[0] + ' ' + name.split(' ')[1], { permanent: false, className: 'marker-label' });

  const mkEnd = L.circleMarker([pts.at(-1).lat, pts.at(-1).lng], {
    radius: 8, color, fillColor: color, fillOpacity: 1, weight: 2
  }).addTo(map).bindTooltip('FIM ' + name.split(' ')[0] + ' ' + name.split(' ')[1], { permanent: false, className: 'marker-label' });

  const cut = { id, name, pts, polyline: poly, startMarker: mkStart, endMarker: mkEnd, kmS, kmE, kmPerc, serverId: null };
  savedCuts.push(cut);

  // Sync com servidor
  if (typeof apiLogado === 'function' && apiLogado()) {
    const gpxNome = document.getElementById('fileStatus')?.textContent || '';
    apiSalvarCorte({
      nome: name,
      km_inicio:  kmS,
      km_fim:     kmE,
      distancia:  kmPerc,
      n_pontos:   pts.length,
      gpx_nome:   gpxNome !== 'Nenhum arquivo' ? gpxNome : null,
      pontos:     pts.map(p => ({ lat: p.lat, lng: p.lng, ele: p.ele || null, time: p.time || null })),
    }).then(res => { cut.serverId = res.id; }).catch(() => {});
  }

  // Limpa pending para novo corte
  pendingStart = null;
  pendingEnd   = null;
  if (previewPolyline) { map.removeLayer(previewPolyline); previewPolyline = null; }
  setActiveTarget('start');
  updatePendingUI();

  renderCutsList();
  document.getElementById('resultsSection').style.display = '';
  showToast('Corte ' + (id + 1) + ' salvo — ' + kmPerc.toFixed(3) + ' km', 'success');
}

// ──────────────────────────────────────────────────────────────────────
//  LISTA DE CORTES SALVOS
// ──────────────────────────────────────────────────────────────────────
function renderCutsList() {
  const list = document.getElementById('cutsList');
  list.innerHTML = '';
  if (!savedCuts.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.72rem;padding:6px 0;">Nenhum corte salvo ainda.</div>';
    return;
  }
  savedCuts.forEach(cut => {
    const item = document.createElement('div');
    item.className = 'cut-list-item';
    item.innerHTML =
      '<div class="cut-list-name">' + cut.name + '</div>' +
      '<div class="cut-list-km">' + cut.kmPerc.toFixed(3) + ' km · ' + cut.pts.length + ' pts</div>' +
      '<div class="cut-list-actions">' +
        '<button onclick="downloadCutGPX(' + cut.id + ')" title="Baixar GPX">GPX</button>' +
        '<button onclick="downloadCutReport(' + cut.id + ')" title="Baixar Relatório">TXT</button>' +
        '<button onclick="focusCut(' + cut.id + ')" title="Ir para trecho">IR</button>' +
        '<button class="danger" onclick="removeCut(' + cut.id + ')" title="Remover">X</button>' +
      '</div>';
    list.appendChild(item);
  });
  document.getElementById('downloadAllBtn').style.display = savedCuts.length > 1 ? '' : 'none';
}

function focusCut(id) {
  const cut = savedCuts.find(c => c.id === id);
  if (cut) map.fitBounds(cut.polyline.getBounds(), { padding: [40, 40] });
}

function removeCut(id) {
  const idx = savedCuts.findIndex(c => c.id === id);
  if (idx === -1) return;
  const cut = savedCuts[idx];
  map.removeLayer(cut.polyline);
  map.removeLayer(cut.startMarker);
  map.removeLayer(cut.endMarker);
  if (cut.serverId && typeof apiLogado === 'function' && apiLogado()) {
    apiDeletarCorte(cut.serverId).catch(() => {});
  }
  savedCuts.splice(idx, 1);
  renderCutsList();
  if (!savedCuts.length) document.getElementById('resultsSection').style.display = 'none';
}

function clearAllCuts() {
  savedCuts.forEach(c => {
    map.removeLayer(c.polyline);
    map.removeLayer(c.startMarker);
    map.removeLayer(c.endMarker);
  });
  savedCuts = [];
  nextCutId = 0;
  renderCutsList();
}

// ──────────────────────────────────────────────────────────────────────
//  DOWNLOAD — individual e todos
// ──────────────────────────────────────────────────────────────────────
function buildGpxString(pts) {
  const ptsXml = pts.map(p => {
    const el = p.ele  ? '\n      <ele>' + p.ele.toFixed(2) + '</ele>' : '';
    const tm = p.time ? '\n      <time>' + p.time + '</time>'         : '';
    return '    <trkpt lat="' + p.lat.toFixed(8) + '" lon="' + p.lng.toFixed(8) + '">' + el + tm + '\n    </trkpt>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="GPX IMTRAFF" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '  <metadata><name>Trecho Cortado</name><time>' + new Date().toISOString() + '</time></metadata>\n' +
    '  <trk><name>Trecho Cortado</name><trkseg>\n' + ptsXml + '\n    </trkseg></trk>\n</gpx>';
}

function downloadCutGPX(id) {
  const cut = savedCuts.find(c => c.id === id);
  if (!cut) return;
  triggerDownload(buildGpxString(cut.pts), 'corte_' + (id + 1) + '_' + Date.now() + '.gpx', 'application/gpx+xml');
  showToast('GPX do Corte ' + (id + 1) + ' exportado', 'success');
}

function downloadCutReport(id) {
  const cut = savedCuts.find(c => c.id === id);
  if (!cut) return;
  const report =
    'GPX IMTRAFF — Relatório de Corte\n================================\n' +
    'Corte     : ' + cut.name + '\n' +
    'Data      : ' + new Date().toLocaleString('pt-BR') + '\n\n' +
    'KM INICIAL   : KM ' + formatKmMarker(cut.kmS) + '\n' +
    'KM FINAL     : KM ' + formatKmMarker(cut.kmE) + '\n' +
    'KM PERCORRIDO: ' + cut.kmPerc.toFixed(3) + ' km\n' +
    'PONTOS       : ' + cut.pts.length + '\n\n' +
    'Início : Lat ' + cut.pts[0].lat.toFixed(8) + '  Lng ' + cut.pts[0].lng.toFixed(8) + '\n' +
    'Fim    : Lat ' + cut.pts.at(-1).lat.toFixed(8) + '  Lng ' + cut.pts.at(-1).lng.toFixed(8) + '\n';
  triggerDownload(report, 'relatorio_corte_' + (id + 1) + '_' + Date.now() + '.txt', 'text/plain');
}

function downloadAllCuts() {
  if (!savedCuts.length) return;
  savedCuts.forEach(cut => downloadCutGPX(cut.id));
  showToast(savedCuts.length + ' arquivos GPX exportados', 'success');
}

// ──────────────────────────────────────────────────────────────────────
//  RESET TOTAL
// ──────────────────────────────────────────────────────────────────────
function resetAll() {
  gpxPoints = [];
  clearPending();
  clearAllCuts();
  if (trackPolyline) map.removeLayer(trackPolyline);
  if (trackOutline)  map.removeLayer(trackOutline);
  cutArrowMarkers.forEach(m => map.removeLayer(m));
  cutArrowMarkers = [];
  trackPolyline = trackOutline = null;

  document.getElementById('gpxInfoSection').style.display = 'none';
  document.getElementById('cutSection').style.display     = 'none';
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('emptyState').style.display     = '';
  document.getElementById('fileStatus').textContent       = 'Nenhum arquivo';
  document.getElementById('fileStatus').classList.remove('active');
  document.getElementById('fileInput').value = '';
  showToast('Projeto resetado', '');
}

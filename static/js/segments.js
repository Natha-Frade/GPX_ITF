// ══════════════════════════════════════════════════════════════════════
//  segments.js — Marcações CONTÍNUAS (trechos) na aba "Marcações"
//
//  • Modo "Ponto": comportamento clássico (pino único) — points.js
//  • Modo "Trecho": 1º clique = início, 2º clique = fim.
//    - Se houver KMZ/GPX carregado, o trecho SEGUE a linha da via
//      (snap na linha mais próxima, até SEG_SNAP_MAX_M de distância).
//    - Km inicial/final no formato estaca (ex.: 230+515 → 245+980),
//      interpolado dos marcos do KMZ (motor do kmcalc.js).
//    - Sem KMZ/marcos: linha reta entre os cliques, exporta só coords.
//  • Exportação CSV/KML unificada fica em points.js (inclui trechos).
// ══════════════════════════════════════════════════════════════════════

let savedSegments = [];      // [{id,label,category,path[],start,end,kmIni,kmFim,extKm,road,polyline,outline,mStart,mEnd}]
let nextSegId  = 0;
let markMode   = 'ponto';    // 'ponto' | 'trecho'
let segDraft   = null;       // { start:{lat,lng}, marker } — aguardando 2º clique

const SEG_SNAP_MAX_M = 300;  // distância máxima p/ "grudar" o clique na via

// ── Distância equiretangular em metros ────────────────────────────────
function _segDistM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const x = (lng2 - lng1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R;
}

// ── Linhas disponíveis para snap (KMZ visíveis + GPX da aba) ─────────
function _segLines() {
  const lines = [];
  if (typeof kmzLayers !== 'undefined') {
    kmzLayers.forEach(l => {
      if (!l.visible || !l.trackPolylines) return;
      l.trackPolylines.forEach(p => {
        let ll = p.getLatLngs();
        if (ll.length && Array.isArray(ll[0])) ll = ll.flat();
        if (ll.length >= 2) lines.push({ name: l.name, pts: ll.map(x => ({ lat: x.lat, lng: x.lng })) });
      });
    });
  }
  if (typeof pointsGpxLayers !== 'undefined') {
    pointsGpxLayers.forEach(l => {
      if (l.visible && l.points && l.points.length >= 2)
        lines.push({ name: l.name, pts: l.points });
    });
  }
  return lines;
}

// ── Projeta um ponto na linha: retorna melhor {segIdx,t,lat,lng,dist} ──
function _segProject(line, lat, lng) {
  let best = null;
  const pts = line.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    // projeção em coordenadas "planas" locais
    const kx = Math.cos(lat * Math.PI / 180);
    const ax = (a.lng - lng) * kx, ay = a.lat - lat;
    const bx = (b.lng - lng) * kx, by = b.lat - lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.lat + t * (b.lat - a.lat);
    const py = a.lng + t * (b.lng - a.lng);
    const d = _segDistM(lat, lng, px, py);
    if (!best || d < best.dist) best = { segIdx: i, t, lat: px, lng: py, dist: d };
  }
  return best;
}

// ── Caminho ao longo da linha entre duas projeções ────────────────────
function _segPathAlong(line, pA, pB) {
  let a = pA, b = pB, invert = false;
  if (a.segIdx > b.segIdx || (a.segIdx === b.segIdx && a.t > b.t)) {
    a = pB; b = pA; invert = true;
  }
  const path = [{ lat: a.lat, lng: a.lng }];
  for (let i = a.segIdx + 1; i <= b.segIdx; i++) path.push({ lat: line.pts[i].lat, lng: line.pts[i].lng });
  path.push({ lat: b.lat, lng: b.lng });
  if (invert) path.reverse();
  return path;
}

function _segPathKm(path) {
  let m = 0;
  for (let i = 0; i < path.length - 1; i++)
    m += _segDistM(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng);
  return m / 1000;
}

// ── Km (estaca) numa coordenada, se houver marcos de KMZ ─────────────
function segKmAt(lat, lng) {
  if (typeof calcKmFromCoord !== 'function') return null;
  try {
    const r = calcKmFromCoord(lat, lng);
    if (r && r.estaca) return { estaca: r.estaca, km: r.km };
  } catch (_) {}
  return null;
}

// ── SELETOR DE MODO (Ponto | Trecho) ─────────────────────────────────
function setMarkMode(m) {
  markMode = m;
  document.querySelectorAll('.mark-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === m));
  _segCancelDraft();
  if (typeof pointsAddMode !== 'undefined' && pointsAddMode) {
    showToast(m === 'trecho'
      ? 'Modo trecho: clique no INÍCIO e depois no FIM'
      : 'Modo ponto: clique no mapa para colocar um pino', 'info');
  }
}

function _segCancelDraft() {
  if (segDraft && segDraft.marker) map.removeLayer(segDraft.marker);
  segDraft = null;
}

// ── FLUXO DE CLIQUES (chamado por points.js) ─────────────────────────
function segHandleClick(lat, lng) {
  if (!segDraft) {
    // 1º clique — início (com snap visual se houver via)
    const snapped = _segSnapOne(lat, lng);
    const p = snapped ? snapped.pt : { lat, lng };
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#73b753', fillOpacity: 1,
    }).addTo(map).bindTooltip('Início do trecho', { permanent: true, direction: 'top', offset: [0, -8] });
    segDraft = { start: p, marker };
    showToast('Início marcado — agora clique no FIM do trecho', 'info');
    return;
  }

  // 2º clique — fim: monta o trecho
  const start = segDraft.start;
  const end0  = { lat, lng };
  _segCancelDraft();

  const lines = _segLines();
  let path = null, road = '', end = end0, snapOk = false;

  // tenta a MESMA linha para início e fim (menor pior-distância)
  let melhor = null;
  lines.forEach(line => {
    const pa = _segProject(line, start.lat, start.lng);
    const pb = _segProject(line, end0.lat, end0.lng);
    if (!pa || !pb) return;
    const pior = Math.max(pa.dist, pb.dist);
    if (pior <= SEG_SNAP_MAX_M && (!melhor || pior < melhor.pior))
      melhor = { line, pa, pb, pior };
  });

  if (melhor) {
    path = _segPathAlong(melhor.line, melhor.pa, melhor.pb);
    road = melhor.line.name;
    end  = { lat: melhor.pb.lat, lng: melhor.pb.lng };
    snapOk = true;
  } else {
    path = [start, end0];
  }

  const kmIni = segKmAt(path[0].lat, path[0].lng);
  const kmFim = segKmAt(path[path.length - 1].lat, path[path.length - 1].lng);
  const extKm = _segPathKm(path);

  // abre o modal de trecho pré-preenchido
  _segPending = { path, road, snapOk, kmIni, kmFim, extKm };
  document.getElementById('segKmInfo').textContent =
    (kmIni && kmFim)
      ? `Km ${kmIni.estaca} → ${kmFim.estaca}  ·  ${extKm.toFixed(2).replace('.', ',')} km` + (road ? `  ·  via: ${road}` : '')
      : `${extKm.toFixed(2).replace('.', ',')} km` + (snapOk ? `  ·  via: ${road}` : '  ·  linha reta (sem via carregada)') +
        (kmIni || kmFim ? '' : '  ·  sem marcos de km');
  document.getElementById('segLabel').value = '';
  document.getElementById('segModal').style.display = 'flex';
  document.getElementById('segLabel').focus();
  document.querySelectorAll('#segCatRow .pin-cat-btn').forEach(b => b.classList.remove('active'));
  const first = document.querySelector('#segCatRow .pin-cat-btn');
  if (first) first.classList.add('active');
}

let _segPending = null;

function closeSegModal() {
  document.getElementById('segModal').style.display = 'none';
  _segPending = null;
}

function confirmSegModal() {
  if (!_segPending) return;
  const label = document.getElementById('segLabel').value.trim() || 'Trecho ' + (nextSegId + 1);
  const btn   = document.querySelector('#segCatRow .pin-cat-btn.active');
  const catId = btn ? btn.dataset.cat : POINT_CATEGORIES[0].id;
  addSavedSegment(Object.assign({ label, category: catId }, _segPending));
  closeSegModal();
}

// ── CRIA / DESENHA UM TRECHO ─────────────────────────────────────────
function addSavedSegment(data) {
  const cat = POINT_CATEGORIES.find(c => c.id === data.category) || POINT_CATEGORIES[0];
  const id  = nextSegId++;
  const latlngs = data.path.map(p => [p.lat, p.lng]);

  const outline  = L.polyline(latlngs, { color: '#000', weight: 9, opacity: 0.45 }).addTo(map);
  const polyline = L.polyline(latlngs, { color: cat.color, weight: 5, opacity: 0.95, dashArray: '10 6' }).addTo(map);

  const mk = (p, txt) => L.circleMarker([p.lat, p.lng], {
    radius: 6, color: '#fff', weight: 2, fillColor: cat.color, fillOpacity: 1,
  }).addTo(map).bindTooltip(txt, { direction: 'top', offset: [0, -8] });
  const mStart = mk(data.path[0], 'Início: ' + data.label);
  const mEnd   = mk(data.path[data.path.length - 1], 'Fim: ' + data.label);

  const seg = {
    id, label: data.label, category: cat.id,
    path: data.path,
    start: data.path[0], end: data.path[data.path.length - 1],
    kmIni: data.kmIni, kmFim: data.kmFim, extKm: data.extKm, road: data.road || '',
    polyline, outline, mStart, mEnd,
  };
  savedSegments.push(seg);

  const kmTxt = (seg.kmIni && seg.kmFim)
    ? `<div style="font-size:0.78rem;color:var(--accent);font-family:'JetBrains Mono',monospace;margin:4px 0;">
         Km ${seg.kmIni.estaca} → ${seg.kmFim.estaca}</div>`
    : '';
  polyline.bindPopup(`
    <div style="font-family:'Syne',sans-serif;min-width:180px;">
      <div style="font-weight:700;font-size:0.9rem;margin-bottom:4px;">${catIconSVG(cat,16)} ${seg.label}</div>
      ${kmTxt}
      <div style="font-size:0.7rem;color:#888;font-family:'JetBrains Mono',monospace;">
        Início: ${seg.start.lat.toFixed(6)}, ${seg.start.lng.toFixed(6)}<br>
        Fim: &nbsp;&nbsp;&nbsp;${seg.end.lat.toFixed(6)}, ${seg.end.lng.toFixed(6)}
      </div>
      <div style="margin-top:4px;font-size:0.72rem;color:#aaa;">
        Extensão: ${seg.extKm.toFixed(2).replace('.', ',')} km · ${cat.label}${seg.road ? ' · ' + seg.road : ''}
      </div>
    </div>`, { maxWidth: 260 });

  renderPointsList();
  showToast(`📏 Trecho "${seg.label}" salvo` +
    (seg.kmIni && seg.kmFim ? ` — ${seg.kmIni.estaca} → ${seg.kmFim.estaca}` : ''), 'success');
}

function deleteSegment(id) {
  const i = savedSegments.findIndex(s => s.id === id);
  if (i === -1) return;
  const s = savedSegments[i];
  [s.polyline, s.outline, s.mStart, s.mEnd].forEach(l => map.removeLayer(l));
  savedSegments.splice(i, 1);
  renderPointsList();
}

function flyToSegment(id) {
  const s = savedSegments.find(x => x.id === id);
  if (!s) return;
  map.fitBounds(s.polyline.getBounds(), { padding: [40, 40] });
  setTimeout(() => s.polyline.openPopup(), 600);
}

// ── Snap simples de 1 ponto (feedback visual do 1º clique) ───────────
function _segSnapOne(lat, lng) {
  let best = null;
  _segLines().forEach(line => {
    const p = _segProject(line, lat, lng);
    if (p && p.dist <= SEG_SNAP_MAX_M && (!best || p.dist < best.dist))
      best = { pt: { lat: p.lat, lng: p.lng }, dist: p.dist };
  });
  return best;
}

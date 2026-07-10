// ── video.js — v7 ──

// ── ESTADO DE SINCRONIA ──
let videoGpxPoints  = [];
let gpxStartEpoch   = 0;
let gpxEndEpoch     = 0;
let gpxTotalSec     = 0;
let videoDuration   = 0;
let videoLinked     = false;
let videoOffsetSec  = 0;
let videoGpxName    = '';

// ── CAMADAS DO MAPA ──
let videoTrackLine    = null;
let videoTrackOutline = null;
let videoCursorMarker = null;
let videoAnimFrame    = null;

// ── CORTES DE VÍDEO ──
// Cada item: { id, startSec, endSec }
let videoCuts     = [];
let nextVidCutId  = 0;
// Handle sendo arrastado: { cutId, which: 'start'|'end', startX, startSec }
let draggingHandle = null;

// ── DOM ──
let vidEl, vidStatus, vidLinkBtn, vidOffsetInput,
    vidUploadZone, vidFileInput,
    vidProgressBar, vidProgressFill,
    vidTimeLabel, vidCursorInfo, vidOffsetDisplay,
    vidCompatBar, vidTimeline, vidPlayhead, vidCutsListEl;

document.addEventListener('DOMContentLoaded', () => {
  vidEl           = document.getElementById('videoPlayer');
  vidStatus       = document.getElementById('vidStatus');
  vidLinkBtn      = document.getElementById('vidLinkBtn');
  vidOffsetInput  = document.getElementById('vidOffsetInput');
  vidUploadZone   = document.getElementById('vidUploadZone');
  vidFileInput    = document.getElementById('vidFileInput');
  vidProgressBar  = document.getElementById('vidProgressBar');
  vidProgressFill = document.getElementById('vidProgressFill');
  vidTimeLabel    = document.getElementById('vidTimeLabel');
  vidCursorInfo   = document.getElementById('vidCursorInfo');
  vidOffsetDisplay= document.getElementById('vidOffsetDisplay');
  vidCompatBar    = document.getElementById('vidCompatBar');
  vidTimeline     = document.getElementById('vidTimeline');
  vidPlayhead     = document.getElementById('vidPlayhead');
  vidCutsListEl   = document.getElementById('vidCutsList');

  // Upload
  vidUploadZone.addEventListener('click', () => vidFileInput.click());
  vidUploadZone.addEventListener('dragover', e => { e.preventDefault(); vidUploadZone.classList.add('drag-over'); });
  vidUploadZone.addEventListener('dragleave', () => vidUploadZone.classList.remove('drag-over'));
  vidUploadZone.addEventListener('drop', e => {
    e.preventDefault(); vidUploadZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) loadVideo(f);
    else showToast('Arquivo deve ser um vídeo (MP4, MOV...)', 'error');
  });
  vidFileInput.addEventListener('change', e => { if (e.target.files[0]) loadVideo(e.target.files[0]); });

  // Eventos do player
  vidEl.addEventListener('loadedmetadata', onVideoMetadata);
  vidEl.addEventListener('play',           onVideoPlay);
  vidEl.addEventListener('pause',          onVideoPause);
  vidEl.addEventListener('ended',          () => cancelAnimationFrame(videoAnimFrame));
  vidEl.addEventListener('timeupdate',     onVideoTimeUpdate);
  vidEl.addEventListener('seeking',        () => { if (videoLinked) updateCursorPosition(vidEl.currentTime); });

  // Timeline — clique para seek
  if (vidTimeline) {
    vidTimeline.addEventListener('mousedown', onTimelineMouseDown);
    vidTimeline.addEventListener('touchstart', onTimelineTouchStart, { passive: false });
  }

  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup',   onDocMouseUp);
  document.addEventListener('touchmove', onDocTouchMove, { passive: false });
  document.addEventListener('touchend',  onDocMouseUp);

  updateVidUI();
});

// ──────────────────────────────────────────────────────────────────────
//  CARREGAR VÍDEO
// ──────────────────────────────────────────────────────────────────────
let videoFileRef = null; // File original — usado pela exportação em MP4

function loadVideo(file) {
  videoFileRef = file;
  vidEl.src = URL.createObjectURL(file);
  vidEl.load();
  document.getElementById('vidFileName').textContent = file.name;
  document.getElementById('vidUploadSection').style.display  = 'none';
  document.getElementById('vidPlayerSection').style.display  = 'block';
  showToast('Vídeo carregado', 'success');
  updateVidUI();
}

function onVideoMetadata() {
  videoDuration = vidEl.duration;
  renderTimeMarkers();
  updateVidUI();
  checkCompatibility();
}

// ──────────────────────────────────────────────────────────────────────
//  COMPATIBILIDADE GPX ↔ VÍDEO
//  Critério: duração do GPX e do vídeo devem diferir em menos de 60s
// ──────────────────────────────────────────────────────────────────────
function checkCompatibility() {
  if (!vidCompatBar) return;
  if (!videoDuration || !gpxPoints || !gpxPoints.length) {
    vidCompatBar.textContent = 'Carregue GPX e Vídeo para verificar compatibilidade';
    vidCompatBar.className = 'vid-compat-bar pending';
    return;
  }

  const hasTimestamps = gpxPoints.some(p => p.time && p.time.length > 5);
  if (!hasTimestamps) {
    vidCompatBar.textContent = 'GPX sem timestamps — compatibilidade não verificável';
    vidCompatBar.className = 'vid-compat-bar pending';
    return;
  }

  const t0   = new Date(gpxPoints[0].time).getTime() / 1000;
  const t1   = new Date(gpxPoints.at(-1).time).getTime() / 1000;
  const gpxD = t1 - t0;
  const diff = Math.abs(gpxD - videoDuration);

  if (diff <= 60) {
    vidCompatBar.textContent = 'GPX e vídeo compatíveis — diferença: ' + diff.toFixed(0) + 's';
    vidCompatBar.className = 'vid-compat-bar ok';
    if (vidLinkBtn) vidLinkBtn.disabled = false;
  } else {
    vidCompatBar.textContent =
      'Incompatíveis — GPX: ' + formatTime(gpxD) + '  Vídeo: ' + formatTime(videoDuration) +
      '  (diferença: ' + formatTime(diff) + ')';
    vidCompatBar.className = 'vid-compat-bar mismatch';
    if (vidLinkBtn) vidLinkBtn.disabled = true;
    showToast('GPX e vídeo têm durações incompatíveis', 'error');
  }
}

// ──────────────────────────────────────────────────────────────────────
//  VINCULAR GPX AO VÍDEO
// ──────────────────────────────────────────────────────────────────────
function linkGpxToVideo() {
  if (!gpxPoints || !gpxPoints.length) { showToast('Carregue um GPX na aba CORTAR GPX', 'error'); return; }
  if (!videoDuration) { showToast('Carregue um vídeo primeiro', 'error'); return; }

  const hasTimestamps = gpxPoints.some(p => p.time && p.time.length > 5);
  if (!hasTimestamps) { linkByDistance(); return; }

  videoGpxPoints = gpxPoints.map(p => ({
    ...p, epochSec: new Date(p.time).getTime() / 1000
  })).filter(p => p.epochSec > 0);

  gpxStartEpoch = videoGpxPoints[0].epochSec;
  gpxEndEpoch   = videoGpxPoints.at(-1).epochSec;
  gpxTotalSec   = gpxEndEpoch - gpxStartEpoch;
  videoOffsetSec = parseFloat(vidOffsetInput?.value) || 0;
  videoGpxName   = document.getElementById('fileStatus')?.textContent || 'GPX';
  videoLinked    = true;

  drawVideoTrack();
  updateVidUI();
  showToast('GPX vinculado — ' + videoGpxPoints.length + ' pontos', 'success');
}

function linkByDistance() {
  const total = totalKm(gpxPoints);
  let acc = 0;
  videoGpxPoints = gpxPoints.map((p, i) => {
    if (i > 0) acc += haversine(gpxPoints[i-1], p);
    return { ...p, epochSec: (total > 0 ? acc / total : 0) * videoDuration };
  });
  gpxStartEpoch = 0; gpxEndEpoch = videoDuration; gpxTotalSec = videoDuration;
  videoLinked   = true;
  drawVideoTrack();
  updateVidUI();
}

// ──────────────────────────────────────────────────────────────────────
//  INTERPOLAÇÃO — timestamp real → posição
// ──────────────────────────────────────────────────────────────────────
function interpolatePosition(videoTimeSec) {
  if (!videoGpxPoints.length) return null;
  const target = gpxStartEpoch + videoOffsetSec + videoTimeSec;

  if (target <= gpxStartEpoch) return { ...videoGpxPoints[0], idx: 0, angleDeg: 0 };
  if (target >= gpxEndEpoch) {
    const last = videoGpxPoints.length - 1;
    const ang  = last > 0 ? bearing([videoGpxPoints[last-1].lat, videoGpxPoints[last-1].lng],
                                     [videoGpxPoints[last].lat,  videoGpxPoints[last].lng]) : 0;
    return { ...videoGpxPoints[last], idx: last, angleDeg: ang };
  }

  let lo = 0, hi = videoGpxPoints.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (videoGpxPoints[mid].epochSec <= target) lo = mid; else hi = mid;
  }

  const a = videoGpxPoints[lo], b = videoGpxPoints[hi];
  const dt = b.epochSec - a.epochSec;
  const f  = dt > 0 ? Math.min(1, (target - a.epochSec) / dt) : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    idx: lo,
    angleDeg: bearing([a.lat, a.lng], [b.lat, b.lng])
  };
}

// ──────────────────────────────────────────────────────────────────────
//  MAPA — trilha e cursor
// ──────────────────────────────────────────────────────────────────────
function drawVideoTrack() {
  [videoTrackLine, videoTrackOutline, videoCursorMarker].forEach(l => { if (l) map.removeLayer(l); });
  const latlngs = videoGpxPoints.map(p => [p.lat, p.lng]);
  videoTrackOutline = L.polyline(latlngs, { color: '#000', weight: 8, opacity: 0.45 }).addTo(map);
  videoTrackLine    = L.polyline(latlngs, { color: '#73b753', weight: 4, opacity: 0.85 }).addTo(map);
  map.fitBounds(videoTrackLine.getBounds(), { padding: [40, 40] });
  videoCursorMarker = createVideoCursor(latlngs[0], 0);
  videoCursorMarker.addTo(map);
}

function createVideoCursor(latlng, angleDeg) {
  const icon = L.divIcon({
    html: buildCursorSvg(angleDeg), className: '', iconSize: [28, 28], iconAnchor: [14, 14]
  });
  return L.marker(latlng, { icon, zIndexOffset: 1000, interactive: false });
}

function buildCursorSvg(a) {
  return `<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
    <circle cx="14" cy="14" r="11" fill="#73b753" fill-opacity="0.2" stroke="#73b753" stroke-width="2"/>
    <polygon points="14,3 20,22 14,17 8,22" fill="#73b753" stroke="#000" stroke-width="1"
      transform="rotate(${a},14,14)"/>
  </svg>`;
}

// ──────────────────────────────────────────────────────────────────────
//  EVENTOS DO PLAYER
// ──────────────────────────────────────────────────────────────────────
function onVideoPlay() {
  if (videoLinked) scheduleFrame();
}

function onVideoPause() {
  cancelAnimationFrame(videoAnimFrame);
  if (videoLinked) updateCursorPosition(vidEl.currentTime);
}

function onVideoTimeUpdate() {
  if (!videoDuration) return;
  const t = vidEl.currentTime;
  if (vidProgressFill) vidProgressFill.style.width = ((t / videoDuration) * 100).toFixed(2) + '%';
  if (vidTimeLabel) vidTimeLabel.textContent = formatTime(t) + ' / ' + formatTime(videoDuration);
  updatePlayhead(t);
}

function scheduleFrame() {
  videoAnimFrame = requestAnimationFrame(() => {
    if (!vidEl.paused && !vidEl.ended && videoLinked) {
      updateCursorPosition(vidEl.currentTime);
      scheduleFrame();
    }
  });
}

function updateCursorPosition(t) {
  const pos = interpolatePosition(t);
  if (!pos || !videoCursorMarker) return;
  videoCursorMarker.setLatLng([pos.lat, pos.lng]);
  const el = videoCursorMarker.getElement();
  if (el) el.innerHTML = buildCursorSvg(pos.angleDeg);
  if (!map.getBounds().contains([pos.lat, pos.lng])) {
    map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.4 });
  }
  if (vidCursorInfo) vidCursorInfo.textContent = pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5);
}

// ──────────────────────────────────────────────────────────────────────
//  TIMELINE — renderização
// ──────────────────────────────────────────────────────────────────────
function updatePlayhead(t) {
  if (!vidPlayhead || !videoDuration) return;
  const pct = (t / videoDuration) * 100;
  vidPlayhead.style.left = pct.toFixed(2) + '%';
}

function renderTimeMarkers() {
  const container = document.getElementById('vidTimeMarkers');
  if (!container || !videoDuration) return;
  container.innerHTML = '';
  const steps = Math.min(10, Math.floor(videoDuration / 60) + 1);
  const interval = videoDuration / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * interval;
    const tick = document.createElement('div');
    tick.className = 'vid-time-tick';
    tick.style.left = ((t / videoDuration) * 100).toFixed(1) + '%';
    tick.textContent = formatTime(t);
    container.appendChild(tick);
  }
}

function renderVideoCutRanges() {
  // Remove ranges anteriores
  vidTimeline.querySelectorAll('.vid-cut-range, .vid-handle').forEach(el => el.remove());

  videoCuts.forEach(cut => {
    const startPct = (cut.startSec / videoDuration) * 100;
    const endPct   = (cut.endSec   / videoDuration) * 100;

    // Faixa colorida
    const range = document.createElement('div');
    range.className = 'vid-cut-range';
    range.style.left  = startPct.toFixed(2) + '%';
    range.style.width = (endPct - startPct).toFixed(2) + '%';
    range.dataset.cutId = cut.id;
    vidTimeline.appendChild(range);

    // Handle esquerdo (início)
    const hStart = document.createElement('div');
    hStart.className = 'vid-handle';
    hStart.style.left = 'calc(' + startPct.toFixed(2) + '% - 5px)';
    hStart.dataset.cutId = cut.id;
    hStart.dataset.which = 'start';
    hStart.title = 'Início: ' + formatTime(cut.startSec);
    vidTimeline.appendChild(hStart);

    // Handle direito (fim)
    const hEnd = document.createElement('div');
    hEnd.className = 'vid-handle end-handle';
    hEnd.style.left = 'calc(' + endPct.toFixed(2) + '% - 5px)';
    hEnd.dataset.cutId = cut.id;
    hEnd.dataset.which = 'end';
    hEnd.title = 'Fim: ' + formatTime(cut.endSec);
    vidTimeline.appendChild(hEnd);
  });

  renderVideoCutsList();
}

function renderVideoCutsList() {
  if (!vidCutsListEl) return;
  vidCutsListEl.innerHTML = '';
  const badge = document.getElementById('vidCutsCountBadge');
  if (badge) badge.textContent = videoCuts.length;
  if (!videoCuts.length) {
    vidCutsListEl.innerHTML = '<div style="color:var(--muted);font-size:0.7rem;padding:4px 0;">Nenhum corte definido.</div>';
    return;
  }
  videoCuts.forEach(cut => {
    const item = document.createElement('div');
    item.className = 'vid-cut-item';
    item.innerHTML =
      '<div class="vid-cut-item-info">' +
        '<div class="vid-cut-item-time">' + formatTime(cut.startSec) + ' → ' + formatTime(cut.endSec) + '</div>' +
        '<div style="font-size:0.62rem;color:var(--muted);">Duração: ' + formatTime(cut.endSec - cut.startSec) + '</div>' +
      '</div>' +
      '<div class="vid-cut-item-actions">' +
        '<button onclick="seekToCut(' + cut.id + ')">IR</button>' +
        '<button class="danger" onclick="removeVideoCut(' + cut.id + ')">X</button>' +
      '</div>';
    vidCutsListEl.appendChild(item);
  });
  document.getElementById('vidCutsSection').style.display = videoCuts.length ? '' : 'none';
}

// ──────────────────────────────────────────────────────────────────────
//  TIMELINE — interação (clique + drag nos handles)
// ──────────────────────────────────────────────────────────────────────
function timelineXToSec(clientX) {
  const rect = vidTimeline.getBoundingClientRect();
  const f    = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return f * videoDuration;
}

function onTimelineMouseDown(e) {
  const handle = e.target.closest('.vid-handle');
  if (handle) {
    // Arrasta handle existente
    e.preventDefault();
    draggingHandle = {
      cutId: parseInt(handle.dataset.cutId),
      which: handle.dataset.which,
      startX: e.clientX,
    };
    return;
  }
  // Clique na timeline sem handle = seek
  const t = timelineXToSec(e.clientX);
  vidEl.currentTime = t;
}

function onTimelineTouchStart(e) {
  e.preventDefault();
  const touch  = e.touches[0];
  const handle = e.target.closest('.vid-handle');
  if (handle) {
    draggingHandle = { cutId: parseInt(handle.dataset.cutId), which: handle.dataset.which };
    return;
  }
  vidEl.currentTime = timelineXToSec(touch.clientX);
}

function onDocMouseMove(e) {
  if (!draggingHandle) return;
  applyHandleDrag(e.clientX);
}
function onDocTouchMove(e) {
  if (!draggingHandle) return;
  e.preventDefault();
  applyHandleDrag(e.touches[0].clientX);
}

function applyHandleDrag(clientX) {
  const sec = timelineXToSec(clientX);
  const cut = videoCuts.find(c => c.id === draggingHandle.cutId);
  if (!cut) return;
  if (draggingHandle.which === 'start') {
    cut.startSec = Math.max(0, Math.min(sec, cut.endSec - 0.5));
  } else {
    cut.endSec = Math.min(videoDuration, Math.max(sec, cut.startSec + 0.5));
  }
  renderVideoCutRanges();
}

function onDocMouseUp() { draggingHandle = null; }

// ──────────────────────────────────────────────────────────────────────
//  ADICIONAR / REMOVER CORTE DE VÍDEO
// ──────────────────────────────────────────────────────────────────────
function addVideoCutAtCurrent() {
  if (!videoDuration) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  const t    = vidEl.currentTime;
  const span = Math.min(30, videoDuration * 0.1);
  const s    = Math.max(0, t - span / 2);
  const e    = Math.min(videoDuration, t + span / 2);
  videoCuts.push({ id: nextVidCutId++, startSec: s, endSec: e });
  renderVideoCutRanges();
  showToast('Corte adicionado — arraste os handles para ajustar', 'success');
  document.getElementById('vidCutsSection').style.display = '';
}

function removeVideoCut(id) {
  const idx = videoCuts.findIndex(c => c.id === id);
  if (idx !== -1) videoCuts.splice(idx, 1);
  renderVideoCutRanges();
}

function seekToCut(id) {
  const cut = videoCuts.find(c => c.id === id);
  if (cut) vidEl.currentTime = cut.startSec;
}

// ──────────────────────────────────────────────────────────────────────
//  EXPORTAR CORTES DE VÍDEO (exporta os GPX correspondentes)
// ──────────────────────────────────────────────────────────────────────
function exportVideoCutsAsGpx() {
  if (!videoLinked || !videoCuts.length) {
    showToast('Vincule o GPX e defina cortes na timeline', 'error'); return;
  }
  videoCuts.forEach((cut, i) => {
    // Mesma fórmula do interpolatePosition: epoch = start + offset + tVideo
    const ptsInRange = videoGpxPoints.filter(p => {
      const t = p.epochSec - gpxStartEpoch - videoOffsetSec;
      return t >= cut.startSec && t <= cut.endSec;
    });
    if (ptsInRange.length < 2) return;
    const gpxStr = buildGpxStringFromPts(ptsInRange);
    triggerDownload(gpxStr, 'video_corte_' + (i + 1) + '_' + Date.now() + '.gpx', 'application/gpx+xml');
  });
  showToast(videoCuts.length + ' GPXs exportados', 'success');
}

function buildGpxStringFromPts(pts) {
  const xml = pts.map(p => {
    const el = p.ele  ? '\n      <ele>' + p.ele.toFixed(2) + '</ele>' : '';
    const tm = p.time ? '\n      <time>' + p.time + '</time>'         : '';
    return '    <trkpt lat="' + p.lat.toFixed(8) + '" lon="' + p.lng.toFixed(8) + '">' + el + tm + '\n    </trkpt>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="GPX IMTRAFF" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '  <metadata><time>' + new Date().toISOString() + '</time></metadata>\n' +
    '  <trk><name>Corte de Vídeo</name><trkseg>\n' + xml + '\n    </trkseg></trk>\n</gpx>';
}

// ──────────────────────────────────────────────────────────────────────
//  OFFSET
// ──────────────────────────────────────────────────────────────────────
function applyOffset() {
  if (!videoLinked) return;
  videoOffsetSec = parseFloat(vidOffsetInput?.value) || 0;
  if (vidOffsetDisplay) vidOffsetDisplay.textContent =
    (videoOffsetSec >= 0 ? '+' : '') + videoOffsetSec.toFixed(1) + 's';
  updateCursorPosition(vidEl.currentTime);
}

function nudgeOffset(delta) {
  if (!vidOffsetInput) return;
  vidOffsetInput.value = ((parseFloat(vidOffsetInput.value) || 0) + delta).toFixed(1);
  applyOffset();
}

// ──────────────────────────────────────────────────────────────────────
//  REMOVER VÍDEO
// ──────────────────────────────────────────────────────────────────────
function removeVideo() {
  cancelAnimationFrame(videoAnimFrame);
  vidEl.pause(); vidEl.src = '';
  [videoTrackLine, videoTrackOutline, videoCursorMarker].forEach(l => { if (l) map.removeLayer(l); });
  videoTrackLine = videoTrackOutline = videoCursorMarker = null;
  videoGpxPoints = []; videoLinked = false; videoDuration = 0;
  videoCuts = []; nextVidCutId = 0;
  document.getElementById('vidUploadSection').style.display  = 'block';
  document.getElementById('vidPlayerSection').style.display  = 'none';
  document.getElementById('vidCutsSection').style.display    = 'none';
  updateVidUI();
}

// ──────────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────────
function formatTime(s) {
  if (isNaN(s) || s === Infinity) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  return m + ':' + String(sec).padStart(2,'0');
}

function seekVideo(e) {
  if (!videoDuration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  vidEl.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * videoDuration;
}

function updateVidUI() {
  if (!vidLinkBtn) return;
  const hasGpx   = typeof gpxPoints !== 'undefined' && gpxPoints.length > 0;
  const hasVideo = vidEl && vidEl.src && !vidEl.src.endsWith(window.location.href);
  const canLink  = hasGpx && hasVideo && !videoLinked;

  if (vidLinkBtn) vidLinkBtn.disabled = !canLink;

  if (!vidStatus) return;
  if (videoLinked) {
    vidStatus.textContent = 'Vinculado: ' + videoGpxName;
    vidStatus.className = 'vid-status linked';
  } else if (hasVideo && !hasGpx) {
    vidStatus.textContent = 'Aguardando GPX — abra na aba CORTAR GPX';
    vidStatus.className = 'vid-status waiting';
  } else if (!hasVideo) {
    vidStatus.textContent = 'Sem vídeo carregado';
    vidStatus.className = 'vid-status';
  } else {
    vidStatus.textContent = 'Pronto para vincular';
    vidStatus.className = 'vid-status ready';
  }

  checkCompatibility();
}

function onCutGpxLoaded() {
  updateVidUI();
  checkCompatibility();
}

// ── SINCRONIA BIDIRECIONAL GPX ↔ VÍDEO  +  EXPORTAÇÃO EM MP4 ──

// Corte feito na aba CORTAR GPX → espelha na timeline do vídeo.
// Recebe os epochs (ms) do primeiro/último ponto do trecho cortado e
// converte para segundos de vídeo com a MESMA fórmula do
// interpolatePosition: tVideo = epoch − gpxStartEpoch − offset.
function videoMirrorCutFromEpoch(t0Ms, t1Ms, nome) {
  if (!videoLinked || !videoDuration) return false;
  let s = (t0Ms / 1000) - gpxStartEpoch - videoOffsetSec;
  let e = (t1Ms / 1000) - gpxStartEpoch - videoOffsetSec;
  if (e < s) [s, e] = [e, s];
  // Clampa ao vídeo; ignora se o trecho cai totalmente fora dele
  if (e <= 0 || s >= videoDuration) return false;
  s = Math.max(0, s);
  e = Math.min(videoDuration, e);
  if (e - s < 0.5) return false;
  videoCuts.push({ id: nextVidCutId++, startSec: s, endSec: e });
  renderVideoCutRanges();
  renderVideoCutsList();
  showToast('Corte espelhado na timeline do vídeo' + (nome ? ' (' + nome + ')' : ''), 'success');
  return true;
}

// ── Exportar os cortes da timeline como arquivos MP4 ──
async function exportVideoCutsAsMP4() {
  if (!videoFileRef) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (!videoCuts.length) { showToast('Defina cortes na timeline', 'error'); return; }
  if (typeof videoExportarCortesMP4 !== 'function') {
    showToast('video-export.js não carregado', 'error'); return;
  }
  const st = document.getElementById('vidExportStatus');
  const fill = document.getElementById('vidExportFill');
  const btn = document.getElementById('vidExportMp4Btn');
  if (btn) btn.disabled = true;
  try {
    const cuts = [...videoCuts].sort((a, b) => a.startSec - b.startSec);
    const n = await videoExportarCortesMP4(
      videoFileRef, cuts,
      msg => { if (st) st.textContent = msg; },
      p   => { if (fill) fill.style.width = (p * 100).toFixed(0) + '%'; }
    );
    if (st) st.textContent = n + ' vídeo(s) exportado(s) — sem re-encode, corte no keyframe.';
    showToast(n + ' MP4(s) baixado(s)', 'success');
  } catch (e) {
    if (st) st.textContent = 'Erro: ' + e.message;
    showToast('Erro ao exportar: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (fill) setTimeout(() => { fill.style.width = '0%'; }, 1500);
  }
}

// ── Exportar corte + GPX de uma vez (o combo que o levantamento usa) ──
async function exportVideoCutsCompleto() {
  exportVideoCutsAsGpx();
  await exportVideoCutsAsMP4();
}

// ── Juntar vários vídeos (capítulos GX01/GX02...) em um só ──
function vidJoinPick() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'video/mp4,video/quicktime'; inp.multiple = true;
  inp.onchange = async () => {
    const files = [...inp.files].sort((a, b) => a.name.localeCompare(b.name));
    if (files.length < 2) { showToast('Selecione 2 ou mais vídeos', 'error'); return; }
    const st = document.getElementById('vidExportStatus');
    const fill = document.getElementById('vidExportFill');
    try {
      await videoJuntarMP4(
        files,
        msg => { if (st) st.textContent = msg; },
        p   => { if (fill) fill.style.width = (p * 100).toFixed(0) + '%'; }
      );
      if (st) st.textContent = 'Vídeo unido baixado (ordem: ' + files.map(f => f.name).join(' → ') + ')';
      showToast('Vídeos unidos com sucesso', 'success');
    } catch (e) {
      if (st) st.textContent = 'Erro: ' + e.message;
      showToast('Erro ao juntar: ' + e.message, 'error');
    } finally {
      if (fill) setTimeout(() => { fill.style.width = '0%'; }, 1500);
    }
  };
  inp.click();
}

// Mensagem legivel para qualquer coisa lancada. Erros vindos do worker do
// ffmpeg nao sao Error e nao tem .message — dai o antigo "Erro: undefined".
function _vidErro(e) {
  if (typeof window._ffErroTexto === 'function') return window._ffErroTexto(e);
  if (!e) return 'erro desconhecido';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

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
let videoCodec   = '';   // 'avc1' (H.264) | 'hvc1'/'hev1' (HEVC) | ''

function loadVideo(file) {
  videoFileRef = file;
  vidEl.src = URL.createObjectURL(file);
  vidEl.load();
  document.getElementById('vidFileName').textContent = file.name;
  document.getElementById('vidUploadSection').style.display  = 'none';
  document.getElementById('vidPlayerSection').style.display  = 'block';

  // Detecta o codec (rápido, lê só os átomos). Avisa se for HEVC/H.265,
  // que o Chrome costuma NÃO tocar (preview preto no editor) e que torna
  // o export bem mais lento (precisa converter p/ H.264 no navegador).
  if (typeof detectarCodecVideo === 'function') {
    detectarCodecVideo(file).then(cc => {
      videoCodec = cc;
      const nomeEl = document.getElementById('vidFileName');
      if (!nomeEl) return;
      const ehHEVC = /^(hvc1|hev1|hev2|dvhe)/.test(cc);
      let tag = nomeEl.querySelector('.vid-codec-tag');
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'vid-codec-tag';
        tag.style.cssText = 'margin-left:8px;font-size:11px;padding:2px 6px;border-radius:4px;';
        nomeEl.appendChild(tag);
      }
      if (ehHEVC) {
        tag.textContent = 'HEVC/H.265';
        tag.style.background = '#7a2b2b'; tag.style.color = '#ffd7d7';
        tag.title = 'Vídeo em HEVC: o preview pode ficar preto e o export é mais lento (converte p/ H.264).';
        if (typeof showToast === 'function') {
          showToast('Vídeo em HEVC/H.265: preview pode ficar preto e o export é mais lento.', 'info');
        }
      } else if (cc) {
        tag.textContent = cc === 'avc1' ? 'H.264' : cc.toUpperCase();
        tag.style.background = '#2b5a2b'; tag.style.color = '#d7ffd7';
      }
    });
  }
  showToast('Vídeo carregado — lendo GPS embutido...', 'success');
  updateVidUI();
  // Extração AUTOMÁTICA do GPS embutido (GoPro). Se o vídeo não tiver
  // trilha (ex.: re-exportado por editor), avisa de leve e segue o jogo.
  setTimeout(() => useVideoGps({ auto: true }), 300);
}

function onVideoMetadata() {
  videoDuration = vidEl.duration;
  renderTimeMarkers();
  updateVidUI();
  checkCompatibility();
}

// ── Duração pelo ffmpeg quando o navegador não consegue ler o vídeo ───
//  O Chrome não decodifica HEVC/H.265 (formato comum das GoPro novas):
//  o <video> nunca dispara 'loadedmetadata', videoDuration fica 0 e todo
//  o resto trava — o GPX não vincula ("Carregue um vídeo primeiro") e,
//  sem vínculo, os botões de GPX→UNIR e Vídeo→EDITOR não fazem nada.
//  Aqui lemos a duração direto do arquivo, que não depende do decoder.
async function garantirDuracaoVideo() {
  if (videoDuration > 0) return videoDuration;
  if (!videoFileRef || typeof _ffmpegEnsure !== 'function') return 0;
  const st = document.getElementById('vidExportStatus');
  try {
    if (st) st.textContent = 'Lendo a duração do vídeo (formato não suportado pelo player)...';
    const ff = await _ffmpegEnsure();
    const linhas = [];
    const cap = ({ message }) => linhas.push(message);
    ff.on('log', cap);
    const nome = 'dur_' + videoFileRef.name.replace(/[^\w.]/g, '_');
    await ff.writeFile(nome, new Uint8Array(await videoFileRef.arrayBuffer()));
    await ff.exec(['-hide_banner', '-i', nome]).catch(() => {});
    ff.off('log', cap);
    await ff.deleteFile(nome).catch(() => {});
    // "Duration: 00:11:49.20, start: ..."
    const m = linhas.join('\n').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      videoDuration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      renderTimeMarkers();
      updateVidUI();
      checkCompatibility();
      if (st) st.textContent = '';
      return videoDuration;
    }
  } catch (e) {
    console.warn('[duracao]', e);
  }
  if (st) st.textContent = '';
  return videoDuration;
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
async function linkGpxToVideo() {
  if (!gpxPoints || !gpxPoints.length) { showToast('Carregue um GPX na aba CORTAR GPX', 'error'); return; }
  // Se o player não conseguiu ler o vídeo (HEVC), busca a duração pelo
  // ffmpeg antes de desistir — senão o vínculo nunca acontece.
  if (!videoDuration) await garantirDuracaoVideo();
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
// Lê a opção "exportar sem áudio" da tela.
function vidSemAudio() {
  const el = document.getElementById('vidSemAudio');
  return !!(el && el.checked);
}

// O usuário decide se quer converter para H.264. Antes o app decidia
// sozinho: todo vídeo HEVC ia para re-encode, e num arquivo longo isso
// não terminava nunca — o export ficava travado. Agora o padrão é o
// corte rápido (mantém o formato original) e a conversão é opcional.
function vidConverterH264() {
  const el = document.getElementById('vidConverterH264');
  return !!(el && el.checked);
}

async function exportVideoCutsAsMP4() {
  if (!videoFileRef) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (!videoDuration) await garantirDuracaoVideo();
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
    // Só re-encoda se o vídeo for HEVC (precisa virar H.264 p/ abrir no
    // Windows). Se já é H.264, corta em stream-copy: rápido e sem perda.
    const ehHEVC = /^(hvc1|hev1|hev2|dvhe)/.test(videoCodec || '');
    const converter = vidConverterH264();
    if (converter && st) {
      st.textContent = 'Convertendo para H.264 — isso é demorado, deixe a aba aberta...';
    } else if (ehHEVC && st) {
      st.textContent = 'Cortando (mantendo HEVC). Se não abrir no Windows Media Player, ' +
                       'use o VLC ou marque "Converter para H.264".';
    }
    const n = await videoExportarCortesMP4(
      videoFileRef, cuts,
      msg => { if (st) st.textContent = msg; },
      p   => { if (fill) fill.style.width = (p * 100).toFixed(0) + '%'; },
      converter ? 'reencode' : 'copy',
      vidSemAudio()
    );
    if (st) st.textContent = n + ' vídeo(s) exportado(s) — sem re-encode, corte no keyframe.';
    showToast(n + ' MP4(s) baixado(s)', 'success');
  } catch (e) {
    if (st) st.textContent = 'Erro: ' + _vidErro(e);
    showToast('Erro ao exportar: ' + _vidErro(e), 'error');
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

// ── Enviar GPX dos cortes → aba UNIR GPX (sem baixar/recarregar) ─────
// ── Manda o corte do VÍDEO pro EDITOR e o corte do GPX pro CORTAR GPX ─
//  Um clique só: o vídeo cortado abre no editor e o GPX correspondente
//  fica carregado na aba CORTAR GPX (de onde dá pra mandar pro UNIR).
async function sendVideoCutsToEditorAndCut() {
  if (!videoLinked || !videoCuts.length) {
    showToast('Vincule o GPX e defina cortes na timeline', 'error'); return;
  }
  const cortes = [...videoCuts].sort((a, b) => a.startSec - b.startSec);

  // 1) GPX do 1º corte vai para a aba CORTAR GPX (ela trabalha com um
  //    traçado por vez). Se houver mais cortes, avisa.
  const primeiro = cortes[0];
  const pts = videoGpxPoints.filter(p => {
    const t = p.epochSec - gpxStartEpoch - videoOffsetSec;
    return t >= primeiro.startSec && t <= primeiro.endSec;
  });
  if (pts.length >= 2 && typeof parseGPX === 'function') {
    const base = videoFileRef ? videoFileRef.name.replace(/\.[^.]+$/, '') : 'video';
    parseGPX(buildGpxStringFromPts(pts), base + '_corte1.gpx');
    if (cortes.length > 1) {
      showToast(`GPX do corte 1 carregado no CORTAR GPX (${cortes.length} cortes no total)`, 'info');
    } else {
      showToast('GPX do corte carregado na aba CORTAR GPX', 'success');
    }
  } else {
    showToast('O corte não tem pontos de GPX suficientes', 'error');
  }

  // 2) Vídeo cortado vai para o EDITOR (usa o mesmo caminho já testado).
  await sendVideoCutsToEditor();
}

function sendVideoCutsToMerge() {
  if (!videoLinked || !videoCuts.length) {
    showToast('Vincule o GPX e defina cortes na timeline', 'error'); return;
  }
  if (typeof mergeInjectGpx !== 'function') {
    showToast('merge.js não carregado', 'error'); return;
  }
  const cortes = [...videoCuts].sort((a, b) => a.startSec - b.startSec);
  const gpxs = [];
  cortes.forEach((cut, i) => {
    const ptsInRange = videoGpxPoints.filter(p => {
      const t = p.epochSec - gpxStartEpoch - videoOffsetSec;
      return t >= cut.startSec && t <= cut.endSec;
    });
    if (ptsInRange.length >= 2) {
      gpxs.push({
        nome: (videoFileRef ? videoFileRef.name.replace(/\.[^.]+$/, '') : 'video') + '_corte' + (i + 1) + '.gpx',
        texto: buildGpxStringFromPts(ptsInRange),
      });
    }
  });
  if (!gpxs.length) { showToast('Nenhum corte com pontos de GPX suficientes', 'error'); return; }

  // A aba UNIR tem 4 slots (A, B, C, D). Troca de aba ANTES de injetar
  // para que os elementos dos slots já existam no DOM.
  switchTab('unir');
  // Mesmo comportamento do CORTAR: ocupa os slots vagos em ordem, sem
  // apagar o que já foi enviado antes.
  const livres = mergeSlotsLivres();
  if (!livres.length) {
    showToast('Os 4 slots da aba UNIR estão ocupados. Uma e baixe o resultado, ' +
      'ou limpe um slot (✕) antes de enviar mais.', 'error');
    return;
  }
  const enviar = gpxs.slice(0, livres.length);
  enviar.forEach((g, i) => mergeInjectGpx(livres[i], g.nome, g.texto));
  const sobra = gpxs.length - enviar.length;
  showToast(`GPX de ${enviar.length} corte(s) no(s) slot(s) ` +
    enviar.map((_, i) => livres[i]).join(', ') +
    (sobra > 0 ? ` — faltaram ${sobra}, sem slot livre.` : ''), 'success');
}

// ── Enviar cortes de VÍDEO → EDITOR (via IndexedDB, sem re-upload) ──
// Baixa os cortes para o usuário arrastar no editor (plano B quando o
// armazenamento interno do navegador não está disponível).
function _baixarCortesParaEditor(blobs) {
  blobs.forEach((b, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(b.blob);
      const a = document.createElement('a');
      a.href = url; a.download = b.nome;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, i * 400);            // espaça os downloads p/ o navegador não barrar
  });
}

async function sendVideoCutsToEditor() {
  if (!videoFileRef) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (!videoDuration) await garantirDuracaoVideo();
  if (!videoCuts.length) { showToast('Defina cortes na timeline', 'error'); return; }
  if (typeof videoCortarParaBlobs !== 'function' || typeof handoffPut !== 'function') {
    showToast('video-export.js / handoff.js não carregados', 'error'); return;
  }
  const st   = document.getElementById('vidExportStatus');
  const fill = document.getElementById('vidExportFill');
  const btn  = document.getElementById('vidSendEditorBtn');
  if (btn) btn.disabled = true;
  try {
    const cuts  = [...videoCuts].sort((a, b) => a.startSec - b.startSec);
    // Se o vídeo é HEVC/H.265, o Chrome não toca no editor (preview preto)
    // e nem o download abre — então re-encoda p/ H.264. Se já é H.264,
    // corta em stream-copy (rápido). Detecção feita ao carregar o vídeo.
    // SEMPRE corte por cópia aqui. O editor re-encoda por conta própria na
    // hora de exportar, então re-encodar antes de mandar era trabalho
    // dobrado — e num HEVC longo o navegador simplesmente não terminava:
    // o botão ficava travado e o vídeo nunca chegava no editor.
    const ehHEVC = /^(hvc1|hev1|hev2|dvhe)/.test(videoCodec || '');
    const modo   = 'copy';
    if (ehHEVC && st) st.textContent =
      'Preparando o corte (HEVC: a prévia pode ficar preta no editor, mas o corte e a exportação funcionam)...';
    const blobs = await videoCortarParaBlobs(
      videoFileRef, cuts,
      msg => { if (st) st.textContent = msg; },
      p   => { if (fill) fill.style.width = (p * 100).toFixed(0) + '%'; },
      modo,
      vidSemAudio()
    );
    if (!blobs.length) { showToast('Nenhum corte gerado', 'error'); return; }
    if (st) st.textContent = 'Enviando ' + blobs.length + ' corte(s) para o editor...';
    //  A passagem dos cortes para o editor usa o IndexedDB. Em algumas
    //  máquinas ele falha ("Internal error opening backing store"): banco
    //  corrompido, navegação anônima ou dados do site bloqueados. O
    //  handoff já tenta se reparar sozinho; se ainda assim não der, em vez
    //  de simplesmente falhar, baixamos os cortes e o usuário arrasta os
    //  arquivos para dentro do editor (que aceita arrastar/soltar).
    try {
      await handoffPut(blobs);
    } catch (e) {
      console.warn('[handoff] IndexedDB indisponível:', e);
      _baixarCortesParaEditor(blobs);
      const url = '/editor/';
      window.open(url, '_blank');
      if (st) st.innerHTML =
        'O navegador bloqueou o armazenamento interno, então baixei os ' +
        blobs.length + ' corte(s) na sua pasta de Downloads. ' +
        '<b>Arraste os arquivos para a janela do editor</b> (ou use "+ Adicionar vídeos"). ' +
        '<a href="' + url + '" target="_blank" style="color:var(--accent);text-decoration:underline;">Abrir o EDITOR</a>';
      showToast('Cortes baixados — arraste-os para o editor', 'info');
      return;
    }
    // Abre o editor. Alguns navegadores bloqueiam window.open fora de um
    // clique direto (aqui já estamos num handler async), então se vier
    // null, mostramos um link para o usuário abrir manualmente.
    //  Antes de abrir qualquer aba, PERGUNTAMOS se já existe um editor
    //  aberto (handshake ping/pong pelo BroadcastChannel). Se alguém
    //  responder, mandamos os cortes para lá e não abrimos nada — era isso
    //  que faltava: a referência da janela se perde quando a página do app
    //  é recarregada, e aí abria uma segunda aba do editor.
    const editorAberto = await new Promise(resolve => {
      let ch;
      try { ch = new BroadcastChannel('gpxitf_editor'); }
      catch (_) { resolve(false); return; }
      let respondeu = false;
      ch.onmessage = ev => {
        if (ev && ev.data && ev.data.tipo === 'pong' && !respondeu) {
          respondeu = true;
          try { ch.close(); } catch (_) {}
          resolve(true);
        }
      };
      try { ch.postMessage({ tipo: 'ping' }); } catch (_) {}
      setTimeout(() => {
        if (respondeu) return;
        try { ch.close(); } catch (_) {}
        resolve(false);
      }, 500);
    });

    if (editorAberto) {
      try {
        const ch2 = new BroadcastChannel('gpxitf_editor');
        ch2.postMessage({ tipo: 'novos-cortes' });
        ch2.close();
      } catch (_) {}
      try { if (window.__editorWin && !window.__editorWin.closed) window.__editorWin.focus(); } catch (_) {}
      if (st) st.textContent =
        blobs.length + ' corte(s) enviados para o editor que já está aberto (veja a outra aba).';
      showToast('Cortes adicionados ao editor já aberto', 'success');
      return;
    }

    const win = window.open('/editor/?handoff=1', 'gpxitf_editor');
    window.__editorWin = win;
    if (!win) {
      if (st) st.innerHTML = blobs.length + ' corte(s) prontos. ' +
        '<a href="/editor/?handoff=1" target="_blank" style="color:var(--accent);text-decoration:underline;">' +
        'Clique aqui para abrir o EDITOR</a> (o navegador bloqueou a aba automática).';
      showToast('Cortes prontos — clique no link para abrir o editor', 'info');
    } else {
      if (st) st.textContent = blobs.length + ' corte(s) enviados — o editor abriu em outra aba.';
      showToast('Cortes enviados para o EDITOR', 'success');
    }
  } catch (e) {
    if (st) st.textContent = 'Erro: ' + _vidErro(e);
    showToast('Erro ao enviar: ' + _vidErro(e), 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (fill) setTimeout(() => { fill.style.width = '0%'; }, 1500);
  }
}

// ── Corta e manda os trechos pra aba UNIR VÍDEO ────────────────────
// Equivalente ao "GPX → UNIR", mas para video: grava os cortes no disco e
// ja carrega os arquivos resultantes nos slots da aba de uniao. Os
// arquivos entram por referencia (handle.getFile()), sem passar pela
// memoria — e o que permite trabalhar com varios GB.
async function sendVideoCutsToUnir() {
  const st  = document.getElementById('vidExportStatus');
  const btn = document.getElementById('vidSendUnirBtn');

  if (!videoFileRef) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (!videoDuration) await garantirDuracaoVideo();
  if (!videoCuts.length) { showToast('Defina cortes na timeline', 'error'); return; }
  if (typeof window.videoCortarStreaming !== 'function') {
    showToast('video-export.js não carregado — Ctrl+Shift+R', 'error'); return;
  }

  const cuts = [...videoCuts].sort((a, b) => a.startSec - b.startSec);
  if (btn) btn.disabled = true;
  try {
    const arquivos = await window.videoCortarStreaming(
      videoFileRef, cuts,
      msg => { if (st) st.textContent = msg; },
      p => { const f = document.getElementById('vidExportFill'); if (f) f.style.width = (p * 100).toFixed(0) + '%'; }
    );
    if (!arquivos || !arquivos.length) { showToast('Nenhum corte gravado', 'error'); return; }

    const n = window.uvReceberArquivos(arquivos);
    switchTab('unirvideo');
    showToast(n + ' corte(s) carregados na aba UNIR VÍDEO', 'success');
    if (arquivos.length > 4) {
      showToast('Só os 4 primeiros cabem nos slots', 'error');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') { if (st) st.textContent = 'Cancelado.'; return; }
    console.error('[video->unir]', e);
    if (st) st.textContent = 'Erro: ' + _vidErro(e);
    showToast('Erro: ' + _vidErro(e), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Corte LONGO: grava direto no disco (.ts), sem teto de memoria ──
// Use quando o corte passa de ~5 min. O caminho normal (MP4) monta o
// arquivo inteiro na memoria do wasm e estoura em ~2 GB.
async function exportVideoCutsStreaming() {
  const st   = document.getElementById('vidExportStatus');
  const fill = document.getElementById('vidExportFill');
  const btn  = document.getElementById('vidExportTsBtn');

  if (!videoFileRef) { showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (!videoDuration) await garantirDuracaoVideo();
  if (!videoCuts.length) { showToast('Defina cortes na timeline', 'error'); return; }
  if (typeof window.videoCortarStreaming !== 'function') {
    showToast('video-export.js não carregado — recarregue com Ctrl+Shift+R', 'error'); return;
  }

  const cuts = [...videoCuts].sort((a, b) => a.startSec - b.startSec);
  if (btn) btn.disabled = true;
  try {
    await window.videoCortarStreaming(
      videoFileRef, cuts,
      msg => { if (st) st.textContent = msg; },
      p   => { if (fill) fill.style.width = (p * 100).toFixed(0) + '%'; }
    );
    showToast('Corte(s) gravados no disco', 'success');
  } catch (e) {
    if (e && e.name === 'AbortError') { if (st) st.textContent = 'Cancelado.'; return; }
    console.error('[corte-streaming]', e);
    if (st) st.textContent = 'Erro: ' + _vidErro(e);
    showToast('Erro no corte: ' + _vidErro(e), 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (fill) setTimeout(() => { fill.style.width = '0%'; }, 1500);
  }
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
      if (st) st.textContent = 'Erro: ' + _vidErro(e);
      showToast('Erro ao juntar: ' + _vidErro(e), 'error');
    } finally {
      if (fill) setTimeout(() => { fill.style.width = '0%'; }, 1500);
    }
  };
  inp.click();
}

// ──────────────────────────────────────────────────────────────────────
//  GPS DO PRÓPRIO VÍDEO (GoPro GPMF — GPS5/GPS9)
//  Extrai a trilha de GPS embutida no vídeo carregado, gera o GPX em
//  memória, carrega no mapa (mesmo fluxo do parseGPX) e vincula ao
//  vídeo automaticamente — conferência pronta: play no vídeo e o
//  marcador acompanha a posição no mapa.
//  Obs.: só funciona com vídeo ORIGINAL da GoPro. Vídeos re-exportados
//  por editores (CapCut, Premiere...) perdem a trilha de GPS.
// ──────────────────────────────────────────────────────────────────────
async function useVideoGps(opts) {
  const auto = !!(opts && opts.auto);
  if (!videoFileRef) { if (!auto) showToast('Carregue um vídeo primeiro', 'error'); return; }
  if (typeof extractGPMF !== 'function' || typeof buildGPXFromPoints !== 'function') {
    showToast('Extrator GPMF não carregado (gpmf.js)', 'error'); return;
  }
  const btn  = document.getElementById('vidGpsBtn');
  const prog = document.getElementById('vidGpsProgress');
  if (btn)  { btn.disabled = true; btn.textContent = 'Lendo GPS do vídeo…'; }
  if (prog) { prog.style.display = 'block'; prog.textContent = '0%'; }

  try {
    const result = await extractGPMF(videoFileRef, (pct, msg) => {
      if (prog) prog.textContent = pct + '% — ' + (msg || '');
    });

    if (!result || !result.points || !result.points.length) {
      showToast(auto
        ? 'Vídeo sem GPS embutido — vincule um GPX manualmente (aba CORTAR GPX).'
        : 'Este vídeo não tem GPS. Vídeos exportados por editores ' +
          '(CapCut etc.) perdem a trilha — use o arquivo original da GoPro.',
        auto ? 'info' : 'error');
      return;
    }

    // Alinha o GPX à linha do tempo do VÍDEO.
    //  A GoPro descarta pontos sem sinal de satélite (começo da gravação,
    //  túnel, mata fechada). Se usássemos só os horários do GPS, o 1º
    //  ponto válido viraria o segundo 0 do vídeo e TUDO ficava deslocado —
    //  era por isso que o GPX saía mais curto que o vídeo (10:49 x 11:52).
    //  Cada ponto sabe em que fração do vídeo foi gravado (fracVideo),
    //  então reconstruímos os horários em cima da duração real do vídeo.
    await garantirDuracaoVideo();
    const pts = _alinharGpsAoVideo(_gpsVideo1hz(result.points), videoDuration);
    const nome = videoFileRef.name.replace(/\.[^.]+$/, '');
    const gpxText = buildGPXFromPoints(pts, nome);
    parseGPX(gpxText, nome + ' (GPS do vídeo)');  // carrega a rota no mapa
    await linkGpxToVideo();                             // vincula: conferência pronta
    showToast(`GPS do vídeo: ${pts.length} pontos` +
              (result.device ? ` — ${result.device}` : '') +
              ' — dê play para conferir', 'success');
  } catch (err) {
    console.error('[useVideoGps]', err);
    showToast((auto ? 'Não consegui ler o GPS do vídeo: ' : 'Erro ao ler o vídeo: ') + err.message,
      auto ? 'info' : 'error');
  } finally {
    if (btn)  { btn.disabled = false; btn.textContent = '📡 Usar GPS do próprio vídeo (GoPro)'; }
    if (prog) prog.style.display = 'none';
  }
}

// Reescreve os horários dos pontos usando a posição real dentro do vídeo,
// para o GPX cobrir exatamente a mesma duração do vídeo. Onde a GoPro
// perdeu sinal fica um buraco (sem ponto), o que é honesto — mas o que
// existe fica no segundo certo.
function _alinharGpsAoVideo(pts, duracao) {
  if (!pts.length) return pts;
  const temFrac = pts.some(p => typeof p.fracVideo === 'number');
  if (!temFrac || !duracao) return pts;      // sem dados: mantém como está
  const base = Date.UTC(2000, 0, 1) / 1000;  // âncora fixa; só o intervalo importa
  return pts.map(p => {
    const q = Object.assign({}, p);
    if (typeof p.fracVideo === 'number') {
      q.ts = new Date((base + p.fracVideo * duracao) * 1000).toISOString();
    }
    return q;
  });
}

// 1 ponto por segundo (mesmo padrão dos GPX do fluxo da equipe)
function _gpsVideo1hz(points) {
  const out = [];
  let ultimo = null;
  for (const p of points) {
    const seg = p.ts ? String(p.ts).replace(/(\d{2}:\d{2}:\d{2})(\.\d+)?/, '$1') : null;
    if (seg === null) { out.push(p); continue; }
    if (seg !== ultimo) {
      const q = Object.assign({}, p);
      q.ts = seg.endsWith('Z') ? seg : seg + 'Z';
      out.push(q);
      ultimo = seg;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  editor.js — Editor de Vídeo GPX IMTRAFF v8
//  - Upload múltiplo de vídeos GoPro
//  - Timeline horizontal com clipes lado a lado
//  - Player principal com seek, play/pause
//  - Marcadores de corte arrastáveis
//  - Extração de GPS GoPro (GPMF) → GPX
//  - Download de segmentos via MediaRecorder
// ══════════════════════════════════════════════════════════════════════

// ── ESTADO ──
let edClips        = [];      // [{id, file, name, duration, blobUrl, color, gpsPoints}]
let edNextId       = 0;
let edActiveClip   = null;    // clip aberto no player
let edCuts         = [];      // [{timeSec}] marcadores no clip ativo
let edDragging     = null;    // {type:'cut'|'playhead', idx}
let edPlaying      = false;

// Cores dos clipes
const ED_COLORS = ['#73b753','#4fc3f7','#ff7043','#ab47bc','#ffd740','#26a69a','#ef5350','#42a5f5'];

// ── DOM ──
let edPlayer, edTimeDisplay, edTimeline, edPlayheadEl, edClipStrip, edCutsList;

document.addEventListener('DOMContentLoaded', initEditor);

function initEditor() {
  edPlayer      = document.getElementById('edPlayer');
  edTimeDisplay = document.getElementById('edTimeDisplay');
  edTimeline    = document.getElementById('edTimeline');
  edPlayheadEl  = document.getElementById('edPlayhead');
  edClipStrip   = document.getElementById('edClipStrip');
  edCutsList    = document.getElementById('edCutsList');

  if (!edPlayer) return;

  // Upload
  document.getElementById('edFileInput').addEventListener('change', e => {
    [...e.target.files].forEach(loadEdClip);
    e.target.value = '';
  });
  const zone = document.getElementById('edUploadZone');
  zone.addEventListener('click', () => document.getElementById('edFileInput').click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('video/'));
    if (!files.length) { showToast('Apenas arquivos de vídeo', 'error'); return; }
    files.forEach(loadEdClip);
  });

  // Player events
  edPlayer.addEventListener('timeupdate', onEdTimeUpdate);
  edPlayer.addEventListener('loadedmetadata', onEdMetadata);
  edPlayer.addEventListener('play',  () => { edPlaying = true;  updateEdPlayBtn(); });
  edPlayer.addEventListener('pause', () => { edPlaying = false; updateEdPlayBtn(); });
  edPlayer.addEventListener('ended', () => { edPlaying = false; updateEdPlayBtn(); });

  // Timeline interactions
  edTimeline.addEventListener('mousedown', onEdMouseDown);
  document.addEventListener('mousemove', onEdMouseMove);
  document.addEventListener('mouseup',   onEdMouseUp);
  edTimeline.addEventListener('touchstart', onEdTouchStart, { passive: false });
  document.addEventListener('touchmove',  onEdTouchMove, { passive: false });
  document.addEventListener('touchend',   onEdMouseUp);

  renderEdClipStrip();
  renderEdCutsList();
}

// ──────────────────────────────────────────────────────────────────────
//  CARREGAR CLIPE
// ──────────────────────────────────────────────────────────────────────
function loadEdClip(file) {
  const id      = edNextId++;
  const blobUrl = URL.createObjectURL(file);
  const color   = ED_COLORS[id % ED_COLORS.length];
  const clip    = { id, file, name: file.name, duration: 0, blobUrl, color, gpsPoints: null };
  edClips.push(clip);

  // Detecta duração via elemento temporário
  const tmp = document.createElement('video');
  tmp.src   = blobUrl;
  tmp.addEventListener('loadedmetadata', () => {
    clip.duration = tmp.duration;
    renderEdClipStrip();
    if (!edActiveClip) openClip(clip);
  });

  renderEdClipStrip();
  showToast('Carregando: ' + file.name.slice(0,30), '');
}

function openClip(clip) {
  edActiveClip = clip;
  edCuts       = [];
  edPlayer.src = clip.blobUrl;
  edPlayer.load();
  document.getElementById('edEditorSection').style.display = 'block';
  document.getElementById('edEmptyState').style.display    = 'none';
  document.getElementById('edActiveClipName').textContent  = clip.name;
  renderEdClipStrip();
  renderEdTimeline();
  renderEdCutsList();
}

function removeEdClip(id) {
  const idx = edClips.findIndex(c => c.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(edClips[idx].blobUrl);
  const wasActive = edActiveClip?.id === id;
  edClips.splice(idx, 1);
  if (wasActive) {
    edActiveClip = edClips[0] || null;
    if (edActiveClip) openClip(edActiveClip);
    else {
      edPlayer.src = '';
      document.getElementById('edEditorSection').style.display = 'none';
      document.getElementById('edEmptyState').style.display    = '';
    }
  }
  renderEdClipStrip();
  const badge = document.getElementById('edClipsCountBadge');
  if (badge) badge.textContent = edClips.length;
}

// ──────────────────────────────────────────────────────────────────────
//  PLAYER CONTROLS
// ──────────────────────────────────────────────────────────────────────
function edTogglePlay() {
  if (!edActiveClip) return;
  edPlaying ? edPlayer.pause() : edPlayer.play();
}

function edSeekRelative(sec) {
  if (!edPlayer) return;
  edPlayer.currentTime = Math.max(0, Math.min(edPlayer.currentTime + sec, edPlayer.duration || 0));
}

function edSetVolume(val) {
  if (edPlayer) edPlayer.volume = parseFloat(val);
}

function updateEdPlayBtn() {
  const btn = document.getElementById('edPlayBtn');
  if (btn) btn.textContent = edPlaying ? '⏸' : '▶';
}

function onEdTimeUpdate() {
  updateEdPlayhead();
  if (edTimeDisplay && edPlayer) {
    edTimeDisplay.textContent = edFmt(edPlayer.currentTime) + ' / ' + edFmt(edPlayer.duration);
  }
}

function onEdMetadata() {
  if (edActiveClip) edActiveClip.duration = edPlayer.duration;
  renderEdTimeline();
  renderEdClipStrip();
}

// ──────────────────────────────────────────────────────────────────────
//  TIMELINE DE CORTE
// ──────────────────────────────────────────────────────────────────────
function renderEdTimeline() {
  if (!edTimeline || !edActiveClip) return;
  const dur = edActiveClip.duration || 1;

  // Limpa tudo exceto playhead
  edTimeline.querySelectorAll('.ed-cut-line, .ed-cut-hdl, .ed-tick').forEach(el => el.remove());

  // Segmentos coloridos de fundo
  const segs = edGetSegments();
  const segBg = document.getElementById('edTimelineSegs');
  if (segBg) {
    segBg.innerHTML = '';
    segs.forEach((seg, i) => {
      const div = document.createElement('div');
      div.className = 'ed-seg-bg';
      div.style.left  = ((seg.start / dur) * 100).toFixed(2) + '%';
      div.style.width = (((seg.end - seg.start) / dur) * 100).toFixed(2) + '%';
      div.style.background = `hsl(${(i * 47) % 360}, 60%, 25%)`;
      div.style.opacity = '0.35';
      segBg.appendChild(div);
    });
  }

  // Ticks de tempo
  const tickEvery = dur > 300 ? 60 : dur > 60 ? 30 : dur > 20 ? 10 : 5;
  for (let t = 0; t <= dur; t += tickEvery) {
    const tick = document.createElement('div');
    tick.className = 'ed-tick';
    tick.style.left = ((t / dur) * 100).toFixed(1) + '%';
    tick.textContent = edFmt(t);
    edTimeline.appendChild(tick);
  }

  // Marcadores de corte
  edCuts.forEach((cut, idx) => {
    const pct = (cut.timeSec / dur * 100).toFixed(2);

    const line = document.createElement('div');
    line.className = 'ed-cut-line';
    line.style.left = pct + '%';
    edTimeline.appendChild(line);

    const hdl = document.createElement('div');
    hdl.className = 'ed-cut-hdl';
    hdl.style.left = 'calc(' + pct + '% - 7px)';
    hdl.dataset.idx = idx;
    hdl.title = edFmt(cut.timeSec);
    edTimeline.appendChild(hdl);
  });

  updateEdPlayhead();
}

function updateEdPlayhead() {
  if (!edPlayheadEl || !edActiveClip?.duration) return;
  const pct = (edPlayer.currentTime / edActiveClip.duration * 100).toFixed(2);
  edPlayheadEl.style.left = pct + '%';
}

// ── MOUSE / TOUCH ──
function onEdMouseDown(e) {
  const hdl = e.target.closest('.ed-cut-hdl');
  if (hdl) {
    e.preventDefault();
    edDragging = { type: 'cut', idx: parseInt(hdl.dataset.idx) };
    return;
  }
  // Clique na timeline = seek
  e.preventDefault();
  const t = edTimelineX(e.clientX);
  edPlayer.currentTime = t;
}

function onEdTouchStart(e) {
  const hdl = e.target.closest('.ed-cut-hdl');
  if (hdl) {
    e.preventDefault();
    edDragging = { type: 'cut', idx: parseInt(hdl.dataset.idx) };
    return;
  }
  edPlayer.currentTime = edTimelineX(e.touches[0].clientX);
}

function onEdMouseMove(e) {
  if (!edDragging) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  applyEdDrag(x);
}
function onEdTouchMove(e) {
  if (!edDragging) return;
  e.preventDefault();
  applyEdDrag(e.touches[0].clientX);
}
function onEdMouseUp() { edDragging = null; }

function applyEdDrag(clientX) {
  if (!edDragging || edDragging.type !== 'cut') return;
  const t = edTimelineX(clientX);
  edCuts[edDragging.idx].timeSec = Math.max(0.1, Math.min(t, (edActiveClip?.duration || 0) - 0.1));
  edCuts.sort((a, b) => a.timeSec - b.timeSec);
  renderEdTimeline();
  renderEdCutsList();
}

function edTimelineX(clientX) {
  const rect = edTimeline.getBoundingClientRect();
  const f    = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return f * (edActiveClip?.duration || 0);
}

// ── ADICIONAR / LIMPAR CORTES ──
function addEdCutNow() {
  if (!edActiveClip) { showToast('Abra um vídeo primeiro', 'error'); return; }
  const t = edPlayer.currentTime;
  if (edCuts.some(c => Math.abs(c.timeSec - t) < 0.3)) {
    showToast('Marcador já existe nesse ponto', 'error'); return;
  }
  edCuts.push({ timeSec: t });
  edCuts.sort((a, b) => a.timeSec - b.timeSec);
  renderEdTimeline();
  renderEdCutsList();
  showToast('Marcador em ' + edFmt(t), 'success');
}

function removeEdCut(idx) {
  edCuts.splice(idx, 1);
  renderEdTimeline();
  renderEdCutsList();
}

function clearEdCuts() {
  edCuts = [];
  renderEdTimeline();
  renderEdCutsList();
}

// ── SEGMENTOS ──
function edGetSegments() {
  const dur = edActiveClip?.duration || 0;
  if (!dur) return [];
  const pts = [0, ...edCuts.map(c => c.timeSec), dur];
  return pts.slice(0,-1).map((s,i) => ({ start: s, end: pts[i+1], idx: i }))
            .filter(s => s.end - s.start > 0.05);
}

function renderEdCutsList() {
  if (!edCutsList) return;
  const segs  = edGetSegments();
  const badge = document.getElementById('edCutsCountBadge');
  if (badge) badge.textContent = edCuts.length;

  edCutsList.innerHTML = '';
  if (!segs.length || (!edCuts.length && segs.length === 1)) {
    edCutsList.innerHTML = '<div style="color:var(--muted);font-size:0.7rem;padding:6px 0;">Adicione marcadores para dividir o vídeo.</div>';
    return;
  }

  segs.forEach((seg, i) => {
    const dur = seg.end - seg.start;
    const div = document.createElement('div');
    div.className = 'ed-seg-row';
    div.innerHTML =
      '<div class="ed-seg-num">' + (i+1) + '</div>' +
      '<div class="ed-seg-info">' +
        '<div class="ed-seg-time">' + edFmt(seg.start) + ' → ' + edFmt(seg.end) + '</div>' +
        '<div class="ed-seg-dur">' + edFmt(dur) + '</div>' +
      '</div>' +
      '<div class="ed-seg-btns">' +
        '<button onclick="edPreviewSeg(' + i + ')" title="Pré-ver">▶</button>' +
        '<button onclick="edDownloadSeg(' + i + ')" title="Baixar segmento">↓</button>' +
      '</div>';
    edCutsList.appendChild(div);
  });
}

// ──────────────────────────────────────────────────────────────────────
//  CLIP STRIP — faixa de clipes horizontais
// ──────────────────────────────────────────────────────────────────────
function renderEdClipStrip() {
  if (!edClipStrip) return;
  edClipStrip.innerHTML = '';
  const badge = document.getElementById('edClipsCountBadge');
  if (badge) badge.textContent = edClips.length;

  if (!edClips.length) {
    edClipStrip.innerHTML = '<div style="color:var(--muted);font-size:0.7rem;padding:8px;">Nenhum vídeo carregado.</div>';
    return;
  }

  edClips.forEach(clip => {
    const active = edActiveClip?.id === clip.id;
    const div    = document.createElement('div');
    div.className = 'ed-clip-card' + (active ? ' active' : '');
    div.style.borderTopColor = clip.color;
    div.innerHTML =
      '<div class="ed-clip-card-name" title="' + escEdHtml(clip.name) + '">' + escEdHtml(clip.name.slice(0,22)) + '</div>' +
      '<div class="ed-clip-card-dur">' + (clip.duration ? edFmt(clip.duration) : '…') + '</div>' +
      '<div class="ed-clip-card-gps" id="edGpsState_' + clip.id + '">' +
        (clip.gpsPoints ? '✓ GPS: ' + clip.gpsPoints.length + ' pts' : '') +
      '</div>' +
      '<div class="ed-clip-card-actions">' +
        '<button onclick="openClip(edClips.find(c=>c.id===' + clip.id + '))" title="Abrir no editor">Abrir</button>' +
        '<button onclick="edExtractGPS(' + clip.id + ')" title="Extrair GPS GoPro">GPS→GPX</button>' +
        '<button class="danger" onclick="removeEdClip(' + clip.id + ')" title="Remover">X</button>' +
      '</div>';
    edClipStrip.appendChild(div);
  });
}

// ──────────────────────────────────────────────────────────────────────
//  EXTRAÇÃO GPS GPMF (GoPro)
// ──────────────────────────────────────────────────────────────────────
async function edExtractGPS(clipId) {
  const clip = edClips.find(c => c.id === clipId);
  if (!clip) return;

  const btn = document.querySelector(`#edGpsState_${clipId}`);
  if (btn) btn.textContent = 'Lendo GPS...';
  showToast('Extraindo GPS de ' + clip.name.slice(0,25) + '...', 'info');

  try {
    const result = await extractGPMF(clip.file, (pct, msg) => {
      if (btn) btn.textContent = pct + '% — ' + msg;
    });

    if (!result.points.length) {
      showToast('Nenhum ponto GPS encontrado no vídeo', 'error');
      if (btn) btn.textContent = 'Sem GPS';
      return;
    }

    clip.gpsPoints = result.points;
    if (btn) btn.textContent = '✓ GPS: ' + result.points.length + ' pts (' + result.device + ')';

    // Download automático do GPX
    const gpxName = clip.name.replace(/\.[^.]+$/, '');
    const gpx     = buildGPXFromPoints(result.points, gpxName);
    triggerDownload(gpx, gpxName + '.gpx', 'application/gpx+xml');

    showToast('GPX gerado: ' + result.points.length + ' pontos — ' + result.device, 'success');
    renderEdClipStrip();

  } catch (err) {
    console.error('[GPMF]', err);
    showToast('Erro ao ler GPS: ' + err.message, 'error');
    if (btn) btn.textContent = 'Erro GPS';
  }
}

// ──────────────────────────────────────────────────────────────────────
//  DOWNLOAD DE SEGMENTO
// ──────────────────────────────────────────────────────────────────────
function edPreviewSeg(segIdx) {
  const segs = edGetSegments();
  const seg  = segs[segIdx];
  if (!seg) return;
  edPlayer.currentTime = seg.start;
  edPlayer.play();
  const stop = () => {
    if (edPlayer.currentTime >= seg.end - 0.08) {
      edPlayer.pause();
      edPlayer.removeEventListener('timeupdate', stop);
    }
  };
  edPlayer.addEventListener('timeupdate', stop);
}

function edDownloadSeg(segIdx) {
  const segs = edGetSegments();
  const seg  = segs[segIdx];
  if (!seg || !edActiveClip) return;

  // Usa MediaRecorder se disponível
  if (window.MediaRecorder && edPlayer.captureStream) {
    edRecordSeg(seg, segIdx);
  } else {
    // Fallback — baixa original com timecode no nome
    const a = document.createElement('a');
    a.href     = edActiveClip.blobUrl;
    a.download = edActiveClip.name.replace(/\.[^.]+$/, '') +
                 '_seg' + (segIdx+1) + '_' + edFmt(seg.start).replace(':','-') +
                 '_a_' + edFmt(seg.end).replace(':','-') + '.mp4';
    a.click();
    showToast('Vídeo original baixado. Use ' + edFmt(seg.start) + '–' + edFmt(seg.end) + ' para corte externo.', 'info');
  }
}

function edRecordSeg(seg, segIdx) {
  showToast('Gravando segmento ' + (segIdx+1) + ' — aguarde...', 'info');
  edPlayer.currentTime = seg.start;
  edPlayer.muted  = false;
  edPlayer.volume = 1;

  const stream = edPlayer.captureStream();
  const mime   = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = edActiveClip.name.replace(/\.[^.]+$/, '') + '_seg' + (segIdx+1) + '.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    edPlayer.pause();
    showToast('Segmento ' + (segIdx+1) + ' baixado!', 'success');
  };

  mr.start(100);
  edPlayer.play();

  const watchEnd = () => {
    if (edPlayer.currentTime >= seg.end - 0.08) {
      mr.stop();
      edPlayer.removeEventListener('timeupdate', watchEnd);
    }
  };
  edPlayer.addEventListener('timeupdate', watchEnd);
}

function edDownloadActive() {
  if (!edActiveClip) return;
  const a    = document.createElement('a');
  a.href     = edActiveClip.blobUrl;
  a.download = edActiveClip.name;
  a.click();
}

// ──────────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────────
function edFmt(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  return m + ':' + String(sec).padStart(2,'0');
}

function escEdHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

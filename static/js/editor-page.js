// ══════════════════════════════════════════════════════════════════════
//  editor-page.js — GPX IMTRAFF Editor
//  Depende de: gpmf.js (buildGPXFromPoints, extractGPMF)
// ══════════════════════════════════════════════════════════════════════

// ── ESTADO ──────────────────────────────────────────────────────────
const library  = [];     // [{id,file,name,dur,blobUrl,color,thumb,gpsPoints}]
const timeline = [];     // [{id,clipId,trimStart,trimEnd,color}]
let nextId     = 0;
let activeClip = null;   // item da library
let isPlaying  = false;
let cuts       = [];     // [{timeSec}]
let dragging   = null;   // objeto de drag ativo
let tlPxPerSec = 60;     // zoom: pixels por segundo
let tlOffset   = 0;      // scroll horizontal em px

const COLORS = ['#73b753','#4fc3f7','#ff7043','#ab47bc','#ffd740','#26a69a','#ef5350','#42a5f5'];

// ── DOM refs ─────────────────────────────────────────────────────────
const player   = document.getElementById('mainPlayer');
const tlScroll = document.getElementById('tlScroll');
const tlTrack  = document.getElementById('tlTrack');
const tlInner  = document.getElementById('tlInner');
const tlRuler  = document.getElementById('tlRuler');
const tlHead   = document.getElementById('tlHead');
const rulerHead= document.getElementById('rulerHead');

// ══════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  // Upload
  const inp  = document.getElementById('libInput');
  const zone = document.getElementById('libDrop');
  inp.addEventListener('change', e => { [...e.target.files].forEach(addToLib); e.target.value = ''; });
  zone.addEventListener('click', () => inp.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    [...e.dataTransfer.files].filter(f => f.type.startsWith('video/')).forEach(addToLib);
  });

  // Player
  player.addEventListener('timeupdate',     onTimeUpdate);
  player.addEventListener('loadedmetadata', onMetadata);
  player.addEventListener('play',  () => { isPlaying = true;  renderPlayBtn(); });
  player.addEventListener('pause', () => { isPlaying = false; renderPlayBtn(); });
  player.addEventListener('ended', () => { isPlaying = false; renderPlayBtn(); });

  // Timeline interactions
  tlRuler.addEventListener('mousedown',  onRulerDown);
  tlTrack.addEventListener('mousedown',  onTrackDown);
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('mouseup',   onDocUp);

  // Zoom
  document.getElementById('zoomSlider').addEventListener('input', e => {
    tlPxPerSec = parseFloat(e.target.value);
    document.getElementById('zoomVal').textContent = Math.round(tlPxPerSec) + 'px/s';
    renderTimeline();
    renderRuler();
  });

  // Keyboard
  document.addEventListener('keydown', onKey);

  // Resize
  new ResizeObserver(() => { renderRuler(); renderTimeline(); }).observe(document.getElementById('tlArea'));
});

// ══════════════════════════════════════════════════════════════════════
//  TECLADO
// ══════════════════════════════════════════════════════════════════════
function onKey(e) {
  if (e.target.tagName === 'INPUT') return;
  const k = e.code;
  if (k === 'Space')       { e.preventDefault(); togglePlay(); }
  if (k === 'KeyC')        { markCutNow(); }
  if (k === 'Delete')      { removeLastCut(); }
  if (k === 'ArrowLeft')   { seekRel(e.shiftKey ? -10 : e.ctrlKey ? -1 : -0.04); }
  if (k === 'ArrowRight')  { seekRel(e.shiftKey ?  10 : e.ctrlKey ?  1 :  0.04); }
  if (k === 'Home')        { seekTo(0); }
  if (k === 'End')         { seekToEnd(); }
  if (k === 'KeyJ')        { seekRel(-10); }
  if (k === 'KeyL')        { seekRel(10); }
  if (k === 'KeyK')        { togglePlay(); }
}

// ══════════════════════════════════════════════════════════════════════
//  PLAYER TRANSPORT
// ══════════════════════════════════════════════════════════════════════
function togglePlay() {
  if (!activeClip) return;
  isPlaying ? player.pause() : player.play();
}
function renderPlayBtn() {
  document.getElementById('playBtn').textContent = isPlaying ? '⏸' : '▶';
}
function seekRel(d)  { if (player.duration) player.currentTime = clamp(player.currentTime + d, 0, player.duration); }
function seekTo(t)   { if (player.duration) player.currentTime = clamp(t, 0, player.duration); }
function seekToEnd() { if (player.duration) player.currentTime = player.duration; }
function setVol(v)   { player.volume = parseFloat(v); }

function onTimeUpdate() {
  const t = player.currentTime || 0;
  const tc = fmtTC(t);
  document.getElementById('tcDisplay').textContent = tc;
  const ov = document.getElementById('tcOverlay');
  if (ov) ov.textContent = tc;
  updatePlayheads();
}

function updatePlayheads() {
  if (!player.duration) return;
  const pct = (player.currentTime / player.duration * 100).toFixed(4) + '%';
  if (rulerHead) rulerHead.style.left = pct;
  // tlHead é absoluto em px dentro de tlTrack
  if (tlHead) tlHead.style.left = (player.currentTime * tlPxPerSec) + 'px';
}

function onMetadata() {
  if (activeClip) activeClip.dur = player.duration;
  renderPropPanel();
  renderTimeline();
  renderRuler();
  renderSegList();
}

// ══════════════════════════════════════════════════════════════════════
//  BIBLIOTECA
// ══════════════════════════════════════════════════════════════════════
function addToLib(file) {
  const id    = nextId++;
  const url   = URL.createObjectURL(file);
  const item  = { id, file, name: file.name, dur: 0, blobUrl: url,
                  color: COLORS[id % COLORS.length], thumb: null, gpsPoints: null };
  library.push(item);
  makeThumbnail(item);
  renderLibrary();
  toast('Carregado: ' + file.name.slice(0, 28), 'success');
}

function makeThumbnail(item) {
  const v = document.createElement('video');
  v.src   = item.blobUrl;
  v.muted = true;
  v.preload = 'metadata';
  v.addEventListener('loadedmetadata', () => {
    item.dur = v.duration;
    v.currentTime = Math.min(3, v.duration * 0.08);
  });
  v.addEventListener('seeked', () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 135;
    c.getContext('2d').drawImage(v, 0, 0, 240, 135);
    item.thumb = c.toDataURL('image/jpeg', 0.75);
    v.src = '';
    renderLibrary();
    renderTimeline(); // atualiza frames dos clipes já na timeline
  }, { once: true });
}

function removeFromLib(id) {
  const idx = library.findIndex(i => i.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(library[idx].blobUrl);
  const wasActive = activeClip?.id === id;
  library.splice(idx, 1);
  // Remove da timeline também
  const tIdx = timeline.findIndex(t => t.clipId === id);
  if (tIdx !== -1) timeline.splice(tIdx, 1);
  if (wasActive) {
    activeClip = null;
    player.src = '';
    player.style.display = 'none';
    document.getElementById('viewerEmpty').style.display = '';
    document.getElementById('tcOverlay').style.display  = 'none';
    document.getElementById('gpsOverlay').style.display = 'none';
    cuts = [];
  }
  renderLibrary();
  renderTimeline();
  renderPropPanel();
  renderSegList();
}

function openClip(item) {
  activeClip = item;
  cuts = [];
  player.src          = item.blobUrl;
  player.style.display = 'block';
  player.load();
  document.getElementById('viewerEmpty').style.display = 'none';
  document.getElementById('tcOverlay').style.display   = '';
  const gpsOv = document.getElementById('gpsOverlay');
  if (item.gpsPoints) {
    gpsOv.textContent    = '📍 ' + item.gpsPoints.length + ' pts GPS';
    gpsOv.style.display  = '';
  } else {
    gpsOv.style.display = 'none';
  }
  renderLibrary();
  renderPropPanel();
  renderTimeline();
  renderSegList();
}

function renderLibrary() {
  const grid  = document.getElementById('libGrid');
  const badge = document.getElementById('libBadge');
  badge.textContent = library.length;

  if (!library.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);font-size:0.68rem;text-align:center;padding:16px;">Nenhum vídeo</div>';
    return;
  }

  grid.innerHTML = '';
  library.forEach(item => {
    const active = activeClip?.id === item.id;
    const inTl   = timeline.some(t => t.clipId === item.id);
    const div    = document.createElement('div');
    div.className = 'lib-card' + (active ? ' active' : '') + (inTl ? ' in-tl' : '');
    div.dataset.id = item.id;

    // Thumbnail
    if (item.thumb) {
      div.innerHTML = `<img class="lib-card-thumb" src="${item.thumb}" draggable="false">`;
    } else {
      div.innerHTML = `<div class="lib-card-placeholder">🎬</div>`;
    }

    // GPS label text
    let gpsLabel;
    if (item.gpsPoints) {
      gpsLabel = '✓ ' + item.gpsPoints.length + ' pts GPS';
    } else if (item._gpsLoading) {
      gpsLabel = item._gpsLoading;
    } else {
      gpsLabel = 'GPS → GPX';
    }

    // Overlay
    div.innerHTML += `
      <div class="lib-card-overlay">
        <div class="lib-card-name">${escH(item.name)}</div>
        <div class="lib-card-dur">${item.dur ? fmt(item.dur) : '…'}</div>
      </div>
      ${item.gpsPoints ? `<div class="lib-card-gps">GPS ✓</div>` : ''}
      <div class="lib-card-btns">
        <button class="lib-card-btn add" data-action="add" title="Adicionar à timeline">+</button>
        <button class="lib-card-btn del" data-action="del" title="Remover">✕</button>
      </div>
      <button class="lib-card-btn gps" data-action="gps"
              style="position:absolute;bottom:4px;left:4px;right:4px;pointer-events:auto;">
        ${gpsLabel}
      </button>`;

    // Eventos via delegação no card
    div.addEventListener('click', e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add') { e.stopPropagation(); addToTimeline(item.id); return; }
      if (action === 'del') { e.stopPropagation(); removeFromLib(item.id); return; }
      if (action === 'gps') { e.stopPropagation(); extractGPS(item.id); return; }
      openClip(item);
    });
    div.addEventListener('dblclick', () => openClip(item));
    grid.appendChild(div);
  });
}

// ══════════════════════════════════════════════════════════════════════
//  TIMELINE
// ══════════════════════════════════════════════════════════════════════
function totalTlDur() {
  return timeline.reduce((acc, seg) => {
    const item = library.find(i => i.id === seg.clipId);
    return acc + (seg.trimEnd - seg.trimStart);
  }, 0);
}

function addToTimeline(id) {
  const item = library.find(i => i.id === id);
  if (!item) return;
  if (!item.dur) { toast('Aguarde o carregamento do vídeo', 'warn'); return; }
  timeline.push({ id: nextId++, clipId: id, trimStart: 0, trimEnd: item.dur, color: item.color });
  if (!activeClip) openClip(item);
  renderTimeline();
  renderRuler();
  renderLibrary();
  toast(item.name.slice(0, 26) + ' adicionado', 'success');
}

function addActiveToTimeline() {
  if (!activeClip) { toast('Selecione um clipe primeiro', 'error'); return; }
  addToTimeline(activeClip.id);
}

function removeFromTimeline(tlId) {
  const idx = timeline.findIndex(t => t.id === tlId);
  if (idx !== -1) timeline.splice(idx, 1);
  renderTimeline();
  renderRuler();
  renderLibrary();
}

function renderTimeline() {
  // Limpa clipes e marcadores (preserva playhead e empty)
  tlTrack.querySelectorAll('.tl-clip, .tl-cut').forEach(el => el.remove());
  document.getElementById('tlEmpty').style.display = timeline.length ? 'none' : '';

  let offsetPx = 0;
  timeline.forEach((seg, si) => {
    const item   = library.find(i => i.id === seg.clipId);
    if (!item) return;
    const dur    = seg.trimEnd - seg.trimStart;
    const widthPx = dur * tlPxPerSec;
    const active  = activeClip?.id === item.id;

    const clip = document.createElement('div');
    clip.className   = 'tl-clip' + (active ? ' active' : '');
    clip.style.left  = offsetPx + 'px';
    clip.style.width = Math.max(20, widthPx) + 'px';
    clip.dataset.si  = si;
    clip.dataset.tlId = seg.id;

    // Tint de cor
    const tint = document.createElement('div');
    tint.className          = 'tl-clip-tint';
    tint.style.background   = item.color + '33';
    clip.appendChild(tint);

    // Frames (thumbnail repetido)
    if (item.thumb) {
      const frames = document.createElement('div');
      frames.className = 'tl-frames';
      const count = Math.max(1, Math.ceil(widthPx / 80));
      for (let i = 0; i < count; i++) {
        const img = new Image();
        img.src = item.thumb;
        img.className = 'tl-frame-img';
        img.style.width = (widthPx / count) + 'px';
        frames.appendChild(img);
      }
      clip.appendChild(frames);
    }

    // Labels
    const lbl = document.createElement('div');
    lbl.className   = 'tl-clip-lbl';
    lbl.textContent = item.name.replace(/\.[^.]+$/, '').slice(0, 30);
    clip.appendChild(lbl);

    const durLbl = document.createElement('div');
    durLbl.className   = 'tl-clip-dur-lbl';
    durLbl.textContent = fmt(dur);
    clip.appendChild(durLbl);

    // Handles de trim
    ['left', 'right'].forEach(side => {
      const h = document.createElement('div');
      h.className     = 'tl-handle ' + side;
      h.dataset.side  = side;
      h.dataset.si    = si;
      clip.appendChild(h);
    });

    clip.addEventListener('click', e => {
      if (e.target.closest('.tl-handle')) return;
      openClip(item);
    });

    tlTrack.appendChild(clip);
    offsetPx += widthPx;
  });

  // Marcadores de corte (relativos ao clip ativo)
  if (activeClip) {
    const activeSeg = timeline.find(t => t.clipId === activeClip.id);
    if (activeSeg) {
      const segOff = getSegOffset(activeSeg.id);
      cuts.forEach((cut, ci) => {
        const marker = document.createElement('div');
        marker.className = 'tl-cut';
        marker.style.left = (segOff + cut.timeSec * tlPxPerSec) + 'px';
        marker.dataset.ci = ci;
        const lbl = document.createElement('div');
        lbl.className   = 'tl-cut-lbl';
        lbl.textContent = fmt(cut.timeSec);
        marker.appendChild(lbl);
        tlTrack.appendChild(marker);
      });
    }
  }

  // Ajusta largura do inner para scroll funcionar
  const totalPx = totalTlDur() * tlPxPerSec + 200;
  tlInner.style.width = Math.max(totalPx, tlScroll.clientWidth) + 'px';

  updatePlayheads();
}

function getSegOffset(tlId) {
  let off = 0;
  for (const seg of timeline) {
    if (seg.id === tlId) return off;
    const item = library.find(i => i.id === seg.clipId);
    off += (seg.trimEnd - seg.trimStart) * tlPxPerSec;
  }
  return off;
}

function renderRuler() {
  tlRuler.querySelectorAll('.tl-tick, .tl-tick-lbl').forEach(el => el.remove());
  const dur     = totalTlDur() || (activeClip?.dur) || 60;
  const rulerW  = tlRuler.offsetWidth || 800;

  // Calcula intervalo de ticks adaptativo
  const secsVisible = rulerW / tlPxPerSec;
  const raw   = secsVisible / 10;
  const nice  = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(v => v >= raw) || 600;
  const minor = nice / 5;

  for (let t = 0; t <= dur + nice; t += minor) {
    const x     = t * tlPxPerSec;
    if (x > rulerW + 100) break;
    const major = Math.abs(t % nice) < 0.001;
    const tick  = document.createElement('div');
    tick.className = 'tl-tick ' + (major ? 'major' : 'minor');
    tick.style.left = x + 'px';
    tlRuler.appendChild(tick);
    if (major) {
      const lbl = document.createElement('div');
      lbl.className   = 'tl-tick-lbl';
      lbl.style.left  = x + 'px';
      lbl.textContent = fmt(t);
      tlRuler.appendChild(lbl);
    }
  }
}

// ── DRAG INTERAÇÕES ─────────────────────────────────────────────────
function onRulerDown(e) {
  e.preventDefault();
  dragging = { type: 'ruler' };
  seekFromX(e.clientX, tlRuler);
}

function onTrackDown(e) {
  const handle = e.target.closest('.tl-handle');
  const cutEl  = e.target.closest('.tl-cut');

  if (handle) {
    e.preventDefault();
    dragging = { type: 'trim', si: parseInt(handle.dataset.si), side: handle.dataset.side, lastX: e.clientX };
    return;
  }
  if (cutEl) {
    e.preventDefault();
    dragging = { type: 'cut', ci: parseInt(cutEl.dataset.ci), lastX: e.clientX };
    return;
  }
  // Clique no track = seek
  seekFromTrackX(e.clientX);
}

function onDocMove(e) {
  if (!dragging) return;
  if (dragging.type === 'ruler') { seekFromX(e.clientX, tlRuler); return; }

  const dx  = (e.clientX - (dragging.lastX || e.clientX)) / tlPxPerSec;
  dragging.lastX = e.clientX;

  if (dragging.type === 'trim') {
    const seg  = timeline[dragging.si];
    if (!seg) return;
    const item = library.find(i => i.id === seg.clipId);
    if (!item) return;
    if (dragging.side === 'left') {
      seg.trimStart = clamp(seg.trimStart + dx, 0, seg.trimEnd - 0.1);
    } else {
      seg.trimEnd = clamp(seg.trimEnd + dx, seg.trimStart + 0.1, item.dur);
    }
    renderTimeline();
    renderRuler();
  }

  if (dragging.type === 'cut') {
    const cut = cuts[dragging.ci];
    if (!cut) return;
    cut.timeSec = clamp(cut.timeSec + dx, 0.05, (activeClip?.dur || 0) - 0.05);
    cuts.sort((a, b) => a.timeSec - b.timeSec);
    renderTimeline();
    renderSegList();
  }
}

function onDocUp() { dragging = null; }

function seekFromX(clientX, el) {
  const rect = el.getBoundingClientRect();
  const t    = (clientX - rect.left) / tlPxPerSec;
  seekTo(t);
}

function seekFromTrackX(clientX) {
  const rect = tlTrack.getBoundingClientRect();
  const t    = (clientX - rect.left + tlScroll.scrollLeft) / tlPxPerSec;
  seekTo(t);
}

// ══════════════════════════════════════════════════════════════════════
//  CORTES
// ══════════════════════════════════════════════════════════════════════
function markCutNow() {
  if (!activeClip) { toast('Selecione um clipe', 'error'); return; }
  const t = player.currentTime;
  if (cuts.some(c => Math.abs(c.timeSec - t) < 0.15)) return;
  cuts.push({ timeSec: t });
  cuts.sort((a, b) => a.timeSec - b.timeSec);
  renderTimeline();
  renderSegList();
  toast('Corte: ' + fmtTC(t), 'success');
}

function removeLastCut() {
  if (!cuts.length) return;
  cuts.pop();
  renderTimeline();
  renderSegList();
}

function clearAllCuts() {
  cuts = [];
  renderTimeline();
  renderSegList();
}

function getSegments() {
  const dur = activeClip?.dur || 0;
  if (!dur) return [];
  const pts = [0, ...cuts.map(c => c.timeSec), dur];
  return pts.slice(0, -1)
    .map((s, i) => ({ start: s, end: pts[i + 1] }))
    .filter(s => s.end - s.start > 0.05);
}

function renderSegList() {
  const list  = document.getElementById('segList');
  const badge = document.getElementById('segBadge');
  const segs  = getSegments();
  badge.textContent = segs.length;

  list.innerHTML = '';
  if (!segs.length || (segs.length === 1 && !cuts.length)) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.62rem;padding:4px 0;">Adicione cortes na timeline</div>';
    return;
  }

  segs.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'seg-row';
    row.innerHTML =
      `<span class="seg-num">${i + 1}</span>
       <div class="seg-info">
         <div class="seg-time">${fmt(seg.start)} → ${fmt(seg.end)}</div>
         <div class="seg-dur">${fmt(seg.end - seg.start)}</div>
       </div>
       <div class="seg-btns">
         <button class="seg-btn" onclick="previewSeg(${i})" title="Pré-ver">▶</button>
         <button class="seg-btn dl" onclick="downloadSeg(${i})" title="Baixar">↓</button>
       </div>`;
    list.appendChild(row);
  });
}

// ──────────────────────────────────────────────────────────────────────
//  PRÉ-VISUALIZAR
// ──────────────────────────────────────────────────────────────────────
function previewSeg(i) {
  const seg = getSegments()[i];
  if (!seg) return;
  seekTo(seg.start);
  player.play();
  const stop = () => {
    if (player.currentTime >= seg.end - 0.08) {
      player.pause();
      player.removeEventListener('timeupdate', stop);
    }
  };
  player.addEventListener('timeupdate', stop);
}

// ──────────────────────────────────────────────────────────────────────
//  DOWNLOAD SEGMENTO — MediaRecorder
// ──────────────────────────────────────────────────────────────────────
function downloadSeg(i) {
  const seg = getSegments()[i];
  if (!seg || !activeClip) return;

  if (window.MediaRecorder && player.captureStream) {
    recordSeg(seg, i);
    return;
  }
  // Fallback Safari / sem suporte
  const a    = document.createElement('a');
  a.href     = activeClip.blobUrl;
  a.download = activeClip.name.replace(/\.[^.]+$/, '') + '_seg' + (i + 1) + '.mp4';
  a.click();
  toast('Vídeo original baixado — corte de ' + fmt(seg.start) + ' a ' + fmt(seg.end), 'warn');
}

function recordSeg(seg, idx) {
  toast('Gravando segmento ' + (idx + 1) + '... aguarde', 'info');

  seekTo(seg.start);
  player.muted  = false;
  player.volume = 1;

  const stream  = player.captureStream ? player.captureStream() : player.mozCaptureStream();
  const mime    = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const chunks  = [];
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });

  mr.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ext  = mime.includes('mp4') ? '.mp4' : '.webm';
    a.href     = url;
    a.download = (activeClip.name.replace(/\.[^.]+$/, '')) + '_seg' + (idx + 1) + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    player.pause();
    toast('Segmento ' + (idx + 1) + ' salvo!', 'success');
  };

  mr.start(100);
  player.play();

  const watch = () => {
    if (player.currentTime >= seg.end - 0.08) {
      mr.stop();
      player.removeEventListener('timeupdate', watch);
    }
  };
  player.addEventListener('timeupdate', watch);
}

function downloadActiveFull() {
  if (!activeClip) return;
  const a    = document.createElement('a');
  a.href     = activeClip.blobUrl;
  a.download = activeClip.name;
  a.click();
}

// ══════════════════════════════════════════════════════════════════════
//  PROPRIEDADES
// ══════════════════════════════════════════════════════════════════════
function renderPropPanel() {
  const el = document.getElementById('propRows');
  if (!activeClip) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.63rem;">Nenhum clipe</div>';
    return;
  }
  const mb = (activeClip.file.size / 1024 / 1024).toFixed(1);
  el.innerHTML = `
    <div class="prop-row"><span class="prop-k">Nome</span><span class="prop-v">${escH(activeClip.name.slice(0, 22))}</span></div>
    <div class="prop-row"><span class="prop-k">Duração</span><span class="prop-v">${activeClip.dur ? fmt(activeClip.dur) : '…'}</span></div>
    <div class="prop-row"><span class="prop-k">Tamanho</span><span class="prop-v">${mb} MB</span></div>
    <div class="prop-row"><span class="prop-k">GPS</span>
      <span class="prop-v" style="color:${activeClip.gpsPoints ? 'var(--accent)' : 'var(--muted)'}">
        ${activeClip.gpsPoints ? activeClip.gpsPoints.length + ' pts' : '—'}
      </span>
    </div>
    <div class="prop-row"><span class="prop-k">Cortes</span><span class="prop-v">${cuts.length}</span></div>`;
}

// ══════════════════════════════════════════════════════════════════════
//  GPS — EXTRAÇÃO GPMF (GoPro original)
// ══════════════════════════════════════════════════════════════════════
function extractActiveGPS() {
  if (!activeClip) { toast('Selecione um clipe GoPro original', 'error'); return; }
  extractGPS(activeClip.id);
}

async function extractGPS(id) {
  const item = library.find(i => i.id === id);
  if (!item) return;

  const wrap = document.getElementById('gpsProgressWrap');
  const fill = document.getElementById('gpsBarFill');
  const txt  = document.getElementById('gpsBarTxt');

  // Localiza o botão pelo data-id — robusto a re-renders
  const getBtn = () => document.querySelector(`.lib-card[data-id="${id}"] [data-action="gps"]`);

  if (wrap) wrap.style.display = '';
  item._gpsLoading = '0%...';

  try {
    const result = await extractGPMF(item.file, (pct, msg) => {
      if (fill) fill.style.width = pct + '%';
      if (txt)  txt.textContent  = pct + '% — ' + msg;
      item._gpsLoading = pct + '%...';
      const btn = getBtn(); if (btn) btn.textContent = pct + '%...';
    });

    item._gpsLoading = null;

    if (!result.points || !result.points.length) {
      toast('Sem GPS — use o arquivo GoPro original (GX*.MP4)', 'error');
      item._gpsLoading = 'Sem dados GPS';
      const btn = getBtn(); if (btn) btn.textContent = 'Sem dados GPS';
      if (wrap) wrap.style.display = 'none';
      return;
    }

    item.gpsPoints = result.points;

    // Gera e baixa GPX
    const name = item.name.replace(/\.[^.]+$/, '');
    const gpx  = buildGPXFromPoints(result.points, name);
    dlBlob(gpx, name + '.gpx', 'application/gpx+xml');

    if (wrap) wrap.style.display = 'none';
    if (txt)  txt.textContent  = '';

    // Atualiza overlay no player se clipe ativo
    if (activeClip?.id === id) {
      const gpsOv = document.getElementById('gpsOverlay');
      if (gpsOv) {
        gpsOv.textContent   = '📍 ' + result.points.length + ' pts (' + result.device + ')';
        gpsOv.style.display = '';
      }
    }

    renderLibrary();
    renderPropPanel();
    toast('GPX gerado: ' + result.points.length + ' pontos — ' + result.device, 'success');

  } catch (err) {
    console.error('[GPMF]', err);
    toast('Erro GPS: ' + err.message, 'error');
    if (wrap) wrap.style.display = 'none';
    if (btn)  btn.textContent = 'Erro ao ler GPS';
  }
}

// ══════════════════════════════════════════════════════════════════════
//  EXPORTAR (modal)
// ══════════════════════════════════════════════════════════════════════
function showExportModal() { document.getElementById('exportModal').style.display = 'flex'; }
function hideExportModal() { document.getElementById('exportModal').style.display = 'none'; }

function runExport() {
  const doGpx  = document.getElementById('expGpx').checked;
  const doSegs = document.getElementById('expSegs').checked;
  const doFull = document.getElementById('expFull').checked;

  if (doGpx) {
    const withGps = library.filter(i => i.gpsPoints);
    if (!withGps.length) toast('Nenhum clipe com GPS', 'warn');
    withGps.forEach(i => {
      const gpx = buildGPXFromPoints(i.gpsPoints, i.name.replace(/\.[^.]+$/, ''));
      dlBlob(gpx, i.name.replace(/\.[^.]+$/, '') + '.gpx', 'application/gpx+xml');
    });
  }
  if (doSegs) getSegments().forEach((_, i) => downloadSeg(i));
  if (doFull) library.forEach(i => {
    const a = document.createElement('a');
    a.href = i.blobUrl; a.download = i.name;
    a.click();
  });

  hideExportModal();
}

function exportAllGPX() {
  const list = library.filter(i => i.gpsPoints);
  if (!list.length) { toast('Extraia o GPS primeiro (botão GPS→GPX)', 'error'); return; }
  list.forEach(i => {
    const gpx = buildGPXFromPoints(i.gpsPoints, i.name.replace(/\.[^.]+$/, ''));
    dlBlob(gpx, i.name.replace(/\.[^.]+$/, '') + '.gpx', 'application/gpx+xml');
  });
  toast(list.length + ' GPX exportados', 'success');
}

function exportSegments() {
  const segs = getSegments();
  if (!segs.length) { toast('Nenhum segmento definido', 'error'); return; }
  segs.forEach((_, i) => downloadSeg(i));
}

// ══════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════
function dlBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function fmt(s) {
  if (!s || isNaN(s) || !isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return h + ':' + pad(m) + ':' + pad(sec);
  return m + ':' + pad(sec);
}

function fmtTC(s) {
  if (!s || isNaN(s)) return '0:00:00.000';
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  return h + ':' + pad(m) + ':' + pad(sc) + '.' + String(ms).padStart(3, '0');
}

function pad(n) { return String(n).padStart(2, '0'); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type = '') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className   = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 320); }, 3800);
}

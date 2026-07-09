// ══════════════════════════════════════════════════════════════════════
//  merge.js — Merge (Unir) tab logic
// ══════════════════════════════════════════════════════════════════════

// ── CONSTANTS ──
const SLOT_COLORS = { A: '#73b753', B: '#3b9dd6', C: '#e0a030', D: '#c062d0' };
const SLOTS = ['A', 'B', 'C', 'D'];

// ── STATE ──
// mergeData[slot] = { points: [{lat, lng, ele, time}], name: string, raw: string }
const mergeData = { A: null, B: null, C: null, D: null };
let mergePolylines = [];
let mergeArrowMarkers = [];
let mergeResult = null;
let segMode = 'continuo'; // 'continuo' | 'manter'

// ── ARROW & MARKER HELPERS — definidos em map.js (compartilhado) ──

// ── SEGMENT MODE ──
function setSegMode(mode) {
  segMode = mode;
  document.getElementById('segContinuo').classList.toggle('active', mode === 'continuo');
  document.getElementById('segManter').classList.toggle('active', mode === 'manter');
}

// ── LOAD MERGE FILE ──
function loadMergeFile(slot, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const text = ev.target.result;
    const points = parseMergeGPX(text);
    if (!points) { showToast(`❌ GPX ${slot} inválido`, 'error'); return; }
    mergeData[slot] = { points, name: file.name, raw: text };
    // UI updates
    document.getElementById(`fname-${slot}`).textContent = file.name.replace('.gpx', '');
    document.getElementById(`fname-${slot}`).classList.add('ok');
    document.getElementById(`pts-${slot}`).textContent = `${points.length.toLocaleString('pt-BR')} pontos · ${totalKm(points).toFixed(2)} km`;
    document.getElementById(`pts-${slot}`).classList.add('ok');
    document.getElementById(`slot-${slot}`).classList.add('loaded');
    document.getElementById(`uploadBtn-${slot}`).classList.add('has-file');
    document.getElementById(`uploadBtn-${slot}`).childNodes[0].textContent = `✅ GPX ${slot} carregado`;
    drawMergePreview();
    showToast(`✅ GPX ${slot}: ${points.length} pontos`, 'success');
  };
  reader.readAsText(file);
}

function parseMergeGPX(text) {
  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    const trkpts = xml.querySelectorAll('trkpt');
    if (!trkpts.length) return null;
    return Array.from(trkpts).map(pt => ({
      lat:  parseFloat(pt.getAttribute('lat')),
      lng:  parseFloat(pt.getAttribute('lon')),
      ele:  parseFloat(pt.querySelector('ele')?.textContent || 0),
      time: pt.querySelector('time')?.textContent || ''
    }));
  } catch (e) { return null; }
}

function clearSlot(slot) {
  mergeData[slot] = null;
  document.getElementById(`fname-${slot}`).textContent = 'Nenhum arquivo';
  document.getElementById(`fname-${slot}`).classList.remove('ok');
  document.getElementById(`pts-${slot}`).textContent = '— pontos';
  document.getElementById(`pts-${slot}`).classList.remove('ok');
  document.getElementById(`slot-${slot}`).classList.remove('loaded');
  document.getElementById(`uploadBtn-${slot}`).classList.remove('has-file');
  document.getElementById(`uploadBtn-${slot}`).childNodes[0].textContent = `📂 Escolher GPX ${slot}`;
  drawMergePreview();
}

// ── PREVIEW ──
function drawMergePreview() {
  mergePolylines.forEach(p => map.removeLayer(p));
  mergePolylines = [];
  mergeArrowMarkers.forEach(m => map.removeLayer(m));
  mergeArrowMarkers = [];

  SLOTS.forEach(slot => {
    const d = mergeData[slot];
    if (!d) return;
    const latlngs = d.points.map(p => [p.lat, p.lng]);
    const outline = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.5 }).addTo(map);
    const line    = L.polyline(latlngs, { color: SLOT_COLORS[slot], weight: 4, opacity: 0.9 }).addTo(map);
    mergePolylines.push(outline, line);
    const arrows = addTrackArrows(latlngs, SLOT_COLORS[slot], `GPX ${slot}`);
    mergeArrowMarkers.push(...arrows);
  });

  if (mergePolylines.length) {
    const allBounds = mergePolylines.map(p => p.getBounds());
    let bounds = allBounds[0];
    for (let i = 1; i < allBounds.length; i++) bounds = bounds.extend(allBounds[i]);
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

// ── CORE MERGE LOGIC ──
// For each GPX after the first, remap timestamps so they start right after
// the last timestamp of the previous GPX, preserving internal spacing.
function executeMerge() {
  const loaded = SLOTS.filter(s => mergeData[s] !== null);
  if (loaded.length < 2) {
    showToast('⚠️ Carregue ao menos 2 arquivos GPX', 'error'); return;
  }

  const gapSec = parseInt(document.getElementById('gapSeconds').value) || 0;

  let allSegments = [];

  for (let i = 0; i < loaded.length; i++) {
    const slot = loaded[i];
    const pts = mergeData[slot].points.map(p => ({ ...p })); // clone

    if (i === 0) {
      allSegments.push(pts);
    } else {
      const prevSeg     = allSegments[allSegments.length - 1];
      const prevLastTime = getLastValidTime(prevSeg);
      const curFirstTime = getFirstValidTime(pts);

      if (prevLastTime && curFirstTime) {
        const prevLastMs  = new Date(prevLastTime).getTime();
        const curFirstMs  = new Date(curFirstTime).getTime();
        const shiftMs     = (prevLastMs + gapSec * 1000) - curFirstMs;
        pts.forEach(pt => {
          if (pt.time) {
            const newMs = new Date(pt.time).getTime() + shiftMs;
            pt.time = new Date(newMs).toISOString();
          }
        });
      } else {
        pts.forEach(pt => { pt.time = ''; });
      }
      allSegments.push(pts);
    }
  }

  mergeResult = { segments: allSegments, slotNames: loaded };

  // Clear preview, draw merged result
  mergePolylines.forEach(p => map.removeLayer(p));
  mergePolylines = [];
  mergeArrowMarkers.forEach(m => map.removeLayer(m));
  mergeArrowMarkers = [];

  if (segMode === 'continuo') {
    const allPts = allSegments.flat();
    const latlngs = allPts.map(p => [p.lat, p.lng]);
    const outline = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.5 }).addTo(map);
    const line    = L.polyline(latlngs, { color: '#73b753', weight: 4, opacity: 1 }).addTo(map);
    mergePolylines.push(outline, line);
    const arrows = addTrackArrows(latlngs, '#73b753', 'Trilha Unida');
    mergeArrowMarkers.push(...arrows);
  } else {
    allSegments.forEach((seg, i) => {
      const slot    = loaded[i];
      const latlngs = seg.map(p => [p.lat, p.lng]);
      const outline = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.5 }).addTo(map);
      const line    = L.polyline(latlngs, { color: SLOT_COLORS[slot], weight: 4, opacity: 1 }).addTo(map);
      mergePolylines.push(outline, line);
      const arrows = addTrackArrows(latlngs, SLOT_COLORS[slot], `GPX ${slot}`);
      mergeArrowMarkers.push(...arrows);
    });
  }

  if (mergePolylines.length) {
    const allBounds = mergePolylines.map(p => p.getBounds());
    let bounds = allBounds[0];
    for (let i = 1; i < allBounds.length; i++) bounds = bounds.extend(allBounds[i]);
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  // Show stats
  const totalPts  = allSegments.flat().length;
  const totalDist = allSegments.reduce((acc, seg) => acc + totalKm(seg), 0);
  document.getElementById('mergeResFiles').textContent  = loaded.join(' + ');
  document.getElementById('mergeResPoints').textContent = totalPts.toLocaleString('pt-BR');
  document.getElementById('mergeResKm').textContent     = `${totalDist.toFixed(3)} km`;
  document.getElementById('mergeResSegs').textContent   = segMode === 'manter' ? `${loaded.length} segmentos` : '1 contínuo';
  document.getElementById('mergeResultSection').style.display = '';
  document.getElementById('mergeEmptyState').style.display    = 'none';

  showToast(`✅ ${loaded.length} GPX unidos! ${totalPts.toLocaleString('pt-BR')} pontos`, 'success');
}

function getFirstValidTime(pts) {
  for (const p of pts) { if (p.time) return p.time; }
  return null;
}

function getLastValidTime(pts) {
  for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].time) return pts[i].time; }
  return null;
}

// ── DOWNLOAD ──
function downloadMergedGPX() {
  if (!mergeResult) return;
  const { segments, slotNames } = mergeResult;
  const now = new Date().toISOString();

  let trksegsXml = '';
  if (segMode === 'continuo') {
    const allPts = segments.flat();
    trksegsXml = `    <trkseg>\n${buildTrkptsXml(allPts)}\n    </trkseg>`;
  } else {
    trksegsXml = segments.map((seg, i) => {
      return `    <trkseg>\n      <!-- GPX ${slotNames[i]} -->\n${buildTrkptsXml(seg)}\n    </trkseg>`;
    }).join('\n');
  }

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX IMTRAFF Merge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>GPX Unido (${slotNames.join(' + ')})</name>
    <time>${now}</time>
    <desc>Gerado por GPX IMTRAFF — timestamps recalculados para compatibilidade</desc>
  </metadata>
  <trk>
    <name>Trilha Unida — GPX IMTRAFF</name>
${trksegsXml}
  </trk>
</gpx>`;

  triggerDownload(gpx, `gpx_unido_${Date.now()}.gpx`, 'application/gpx+xml');
  showToast('⬇️ GPX unido exportado!', 'success');
}

function buildTrkptsXml(pts) {
  return pts.map(p => {
    const elePart  = p.ele  ? `\n        <ele>${p.ele.toFixed(2)}</ele>`  : '';
    const timePart = p.time ? `\n        <time>${p.time}</time>` : '';
    return `      <trkpt lat="${p.lat.toFixed(8)}" lon="${p.lng.toFixed(8)}">${elePart}${timePart}\n      </trkpt>`;
  }).join('\n');
}

function resetMerge() {
  SLOTS.forEach(s => clearSlot(s));
  mergeResult = null;
  document.getElementById('mergeResultSection').style.display = 'none';
  document.getElementById('mergeEmptyState').style.display    = '';
  mergePolylines.forEach(p => map.removeLayer(p));
  mergePolylines = [];
  mergeArrowMarkers.forEach(m => map.removeLayer(m));
  mergeArrowMarkers = [];
  showToast('🗑 Junção resetada', '');
}

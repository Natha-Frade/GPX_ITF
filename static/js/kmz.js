// ══════════════════════════════════════════════════════════════════════
//  kmz.js — Leitura de KMZ/KML com suporte completo a namespaces XML
//
//  Corrigido v11:
//  1. querySelectorAll NÃO funciona com xmlns no KML — usa
//     getElementsByTagNameNS('*', tag) que ignora o namespace
//  2. Suporte a dois formatos de marco quilométrico:
//     a) <SimpleData name="km">304</SimpleData>  (SNV/DNIT padrão)
//     b) <name>322+560</name>  (formato estaca: KM+metro, ex: Ecoponte)
//  3. KML grande (5MB+) — processado sem travar o browser
// ══════════════════════════════════════════════════════════════════════

let kmzLayers  = [];
let nextKmzId  = 0;

const KMZ_TRACK_COLORS = [
  '#73b753','#4fc3f7','#ff7043','#ab47bc',
  '#ffd740','#26a69a','#ef5350','#42a5f5'
];

// ──────────────────────────────────────────────────────────────────────
//  ENTRADA — lê .kmz ou .kml
// ──────────────────────────────────────────────────────────────────────
async function loadKmzFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let kmlText;
    if (ext === 'kmz') {
      const zip      = await JSZip.loadAsync(file);
      const kmlEntry = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
      if (!kmlEntry) { showToast('KML não encontrado no KMZ', 'error'); return; }
      kmlText = await zip.files[kmlEntry].async('string');
    } else {
      kmlText = await file.text();
    }
    processKML(kmlText, file.name);
  } catch (err) {
    showToast('Erro ao ler arquivo: ' + err.message, 'error');
    console.error('[kmz.js]', err);
  }
}

// ──────────────────────────────────────────────────────────────────────
//  PARSE DO KML
//  CORREÇÃO PRINCIPAL: usa getElementsByTagNameNS('*', tagName)
//  em vez de querySelectorAll(tagName).
//  querySelectorAll ignora elementos com namespace XML declarado
//  no root (xmlns="http://www.opengis.net/kml/2.2"), retornando
//  NodeList vazia mesmo com centenas de Placemarks no arquivo.
// ──────────────────────────────────────────────────────────────────────
function processKML(text, filename) {
  // ── PRÉ-PROCESSAMENTO: corrige problemas comuns antes do DOMParser ──

  // 1. Declara xmlns:xsi caso não esteja — alguns KMLs (ex: Google Earth Pro)
  //    usam xsi:schemaLocation no <Document> sem declarar o prefixo xsi:
  //    O DOMParser rejeita o arquivo inteiro com "parsererror" nesse caso.
  if (!text.includes('xmlns:xsi') && text.includes('xsi:')) {
    text = text.replace(
      '<kml ',
      '<kml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    );
  }

  // 2. Remove atributos xsi:schemaLocation como fallback extra
  //    (não afeta os dados, apenas metadados de validação)
  text = text.replace(/\s+xsi:schemaLocation="[^"]*"/g, '');

  const parser = new DOMParser();
  const xml    = parser.parseFromString(text, 'application/xml');

  if (xml.querySelector('parsererror')) {
    // Tenta fallback: parse como text/html (mais permissivo)
    const xmlFallback = parser.parseFromString(text, 'text/html');
    const hasPlacemarks = xmlFallback.querySelectorAll('Placemark').length ||
                          xmlFallback.getElementsByTagName('Placemark').length;
    if (!hasPlacemarks) {
      showToast('XML inválido no arquivo KML — verifique o arquivo', 'error');
      console.error('[kmz.js] parsererror:', xml.querySelector('parsererror')?.textContent?.slice(0, 200));
      return;
    }
    // Continua com o fallback
    processKMLDocument(xmlFallback, filename);
    return;
  }

  processKMLDocument(xml, filename);
}

function processKMLDocument(xml, filename) {

  // ── Helper: busca elementos por nome ignorando namespace ──
  // Tenta querySelectorAll primeiro (rápido), cai em getElementsByTagNameNS se falhar
  function getEls(parent, tagName) {
    let els = parent.querySelectorAll(tagName);
    if (els.length === 0) {
      els = parent.getElementsByTagNameNS('*', tagName);
    }
    return Array.from(els);
  }

  function getText(el, tagName) {
    const child = getEls(el, tagName)[0];
    return child ? child.textContent.trim() : '';
  }

  const markerObjs      = [];
  const trackPolylines  = [];
  const trackOutlines   = [];
  const kmPoints        = []; // { lat, lng, km } — só os marcos com valor numérico válido
  const trackColor      = KMZ_TRACK_COLORS[nextKmzId % KMZ_TRACK_COLORS.length];

  // ── Processa todos os Placemarks ──
  const placemarks = getEls(xml, 'Placemark');

  placemarks.forEach(pm => {
    const name    = getText(pm, 'name');
    const kmInfo  = extractKmLabel(pm, name, getEls);
    const label   = kmInfo.label;

    // ── PONTO / MARCO QUILOMÉTRICO ──
    const pointEl = getEls(pm, 'Point')[0];
    if (pointEl) {
      const coordEl = getEls(pointEl, 'coordinates')[0];
      if (coordEl) {
        const parts = coordEl.textContent.trim().split(',');
        const lng   = parseFloat(parts[0]);
        const lat   = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          const descHtml = getText(pm, 'description');
          const m = createKmzMarker(lat, lng, label, name, descHtml);
          m.addTo(map);
          markerObjs.push(m);
          if (kmInfo.km !== null) kmPoints.push({ lat, lng, km: kmInfo.km });
        }
      }
    }

    // ── LINESTRING ──
    const lineEls = getEls(pm, 'LineString');
    lineEls.forEach(lineEl => {
      const coordEl = getEls(lineEl, 'coordinates')[0];
      if (!coordEl) return;
      const latlngs = parseKmlCoords(coordEl.textContent);
      if (latlngs.length < 2) return;
      // Tenta pegar cor da LineStyle do styleUrl
      const lineColor = resolveLineColor(pm, xml, trackColor, getEls);
      const outline   = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.4 }).addTo(map);
      const polyline  = L.polyline(latlngs, { color: lineColor, weight: 3.5, opacity: 0.9 }).addTo(map);
      if (name) polyline.bindTooltip(name, { sticky: true, className: 'marker-label' });
      trackOutlines.push(outline);
      trackPolylines.push(polyline);
    });

    // ── MULTIGEOMETRY ──
    const mgEls = getEls(pm, 'MultiGeometry');
    mgEls.forEach(mg => {
      getEls(mg, 'LineString').forEach(lsEl => {
        const coordEl = getEls(lsEl, 'coordinates')[0];
        if (!coordEl) return;
        const latlngs = parseKmlCoords(coordEl.textContent);
        if (latlngs.length < 2) return;
        const lineColor = resolveLineColor(pm, xml, trackColor, getEls);
        const outline   = L.polyline(latlngs, { color: '#000', weight: 7, opacity: 0.35 }).addTo(map);
        const polyline  = L.polyline(latlngs, { color: lineColor, weight: 3, opacity: 0.85 }).addTo(map);
        trackOutlines.push(outline);
        trackPolylines.push(polyline);
      });
    });
  });

  if (!markerObjs.length && !trackPolylines.length) {
    showToast('Nenhum dado encontrado no arquivo', 'error');
    return;
  }

  // Ordena os marcos por KM — necessário para a interpolação funcionar
  kmPoints.sort((a, b) => a.km - b.km);

  const id        = nextKmzId++;
  const layerName = filename.replace(/\.(kmz|kml)$/i, '');

  kmzLayers.push({
    id, name: layerName, trackColor,
    markerObjs, trackPolylines, trackOutlines, kmPoints,
    visible:     true,
    markerCount: markerObjs.length,
    trackCount:  trackPolylines.length,
  });

  // Centraliza no conteúdo carregado
  const allPos = [
    ...markerObjs.map(m => m.getLatLng()),
    ...trackPolylines.flatMap(p => p.getLatLngs().flat ? p.getLatLngs().flat() : p.getLatLngs()),
  ];
  if (allPos.length) {
    try { map.fitBounds(L.latLngBounds(allPos), { padding: [30, 30] }); } catch(e) {}
  }

  renderKmzList();
  updatePtEmptyState();
  if (typeof updateOffsetPreview === 'function') updateOffsetPreview();

  const summary = [
    markerObjs.length    ? markerObjs.length    + ' marcos'   : null,
    trackPolylines.length ? trackPolylines.length + ' trilhas' : null,
  ].filter(Boolean).join(', ');
  showToast(layerName + ' — ' + summary, 'success');
}

// ──────────────────────────────────────────────────────────────────────
//  EXTRAI O LABEL DO MARCO — dois formatos suportados
// ──────────────────────────────────────────────────────────────────────
function extractKmLabel(pm, name, getEls) {
  // FORMATO 1: SNV/DNIT — <SimpleData name="km">304</SimpleData>
  const fields = ['km', 'station', 'km_inicio', 'km_final', 'km_ref', 'estaca'];
  const allSD  = getEls(pm, 'SimpleData');
  for (const sd of allSD) {
    const fieldName = (sd.getAttribute('name') || '').toLowerCase();
    if (fields.some(f => fieldName.includes(f))) {
      const val = sd.textContent.trim();
      if (val) {
        const num = parseFloat(val.replace(',', '.'));
        return { label: 'KM ' + val, km: isNaN(num) ? null : num };
      }
    }
  }

  // FORMATO 2: Estaca rodoviária — <name>322+560</name>
  // Padrão: NNN+NNN onde NNN são dígitos, ex: "322+560" = KM 322.560
  if (name && /^\d+\+\d+$/.test(name.trim())) {
    const parts = name.trim().split('+');
    const km    = parseInt(parts[0]);
    const m     = parseInt(parts[1]);
    const kmVal = km + m / 1000;
    return { label: 'KM ' + kmVal.toFixed(3), km: kmVal };
  }

  // FORMATO 3: Número puro no <name>, com ou sem prefixo "Km"/"KM "
  if (name) {
    const cleaned = name.trim().replace(/^km\s*/i, '').replace(',', '.');
    const num = parseFloat(cleaned);
    if (!isNaN(num) && num > 0) return { label: 'KM ' + num, km: num };
  }

  // Fallback: usa o nome como está, sem valor numérico (não entra na interpolação)
  return { label: name || 'Marco', km: null };
}

// ──────────────────────────────────────────────────────────────────────
//  RESOLVE COR DA LINHA — tenta ler da styleUrl referenciada
// ──────────────────────────────────────────────────────────────────────
function resolveLineColor(pm, xml, fallback, getEls) {
  try {
    const styleUrlEl = getEls(pm, 'styleUrl')[0];
    if (!styleUrlEl) return fallback;
    const styleId = styleUrlEl.textContent.trim().replace('#', '');
    const styleEl = xml.getElementById(styleId) || xml.querySelector('[id="' + styleId + '"]');
    if (!styleEl) return fallback;
    const colorEl = getEls(styleEl, 'color')[0]; // LineStyle > color
    if (!colorEl) return fallback;
    // KML color = aabbggrr (invertido do RGB)
    const kmlColor = colorEl.textContent.trim();
    if (kmlColor.length === 8) {
      const r = parseInt(kmlColor.slice(6, 8), 16);
      const g = parseInt(kmlColor.slice(4, 6), 16);
      const b = parseInt(kmlColor.slice(2, 4), 16);
      return `rgb(${r},${g},${b})`;
    }
  } catch (e) {}
  return fallback;
}

// ──────────────────────────────────────────────────────────────────────
//  PARSE DE COORDENADAS KML "lng,lat[,alt] ..."
// ──────────────────────────────────────────────────────────────────────
function parseKmlCoords(text) {
  return text.trim()
    .split(/\s+/)
    .filter(s => s.includes(','))
    .map(pair => {
      const p = pair.split(',');
      return [parseFloat(p[1]), parseFloat(p[0])];
    })
    .filter(([lat, lng]) => !isNaN(lat) && !isNaN(lng));
}

// ──────────────────────────────────────────────────────────────────────
//  CRIA MARCADOR SVG de marco quilométrico
//  Design: etiqueta retangular verde #216C3E com número em branco
// ──────────────────────────────────────────────────────────────────────
function createKmzMarker(lat, lng, label, originalName, descHtml) {
  // Texto a exibir na etiqueta (ex: "322.560" ou "304")
  const displayText = label.replace('KM ', '');
  const chars       = displayText.length;
  const boxW        = Math.max(34, 10 + chars * 8);
  const boxH        = 22;
  const totalW      = boxW + 6;
  const totalH      = boxH + 10;
  const fid         = 'kmf' + Math.abs((lat * 1000 + lng * 1000) | 0);

  const svgParts = [
    `<svg width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">`,
    `<filter id="${fid}" x="-20%" y="-20%" width="140%" height="160%">`,
    `<feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="rgba(0,0,0,0.5)"/>`,
    `</filter>`,
    `<g filter="url(#${fid})">`,
    `<rect x="3" y="2" width="${boxW}" height="${boxH}" rx="4" ry="4" fill="#216C3E" stroke="#FFFFFF" stroke-width="1.5"/>`,
    `<polygon points="${totalW/2},${totalH-1} ${totalW/2-6},${boxH+2} ${totalW/2+6},${boxH+2}" fill="#216C3E"/>`,
    `</g>`,
    `<text x="${totalW/2}" y="${boxH/2+3}" text-anchor="middle" dominant-baseline="middle"`,
    `font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="#FFFFFF" letter-spacing="0.3">${escapeHtml(displayText)}</text>`,
    `</svg>`
  ].join('');

  const icon = L.divIcon({
    html:       svgParts,
    className:  '',
    iconSize:   [totalW, totalH],
    iconAnchor: [totalW / 2, totalH],
    popupAnchor:[0, -totalH],
  });

  const marker = L.marker([lat, lng], { icon, zIndexOffset: 600 });

  // Popup — extrai dados da description HTML (formato CDATA da Ecoponte)
  let popupHtml = `<div style="font-family:'Syne',sans-serif;min-width:160px;max-width:280px;">
    <div style="font-weight:800;font-size:0.9rem;margin-bottom:5px;color:#73b753;">${escapeHtml(label)}</div>
    <div style="font-size:0.68rem;color:#888;font-family:'JetBrains Mono',monospace;margin-bottom:6px;">
      ${lat.toFixed(6)}, ${lng.toFixed(6)}
    </div>`;

  if (originalName && originalName !== displayText) {
    popupHtml += `<div style="font-size:0.7rem;color:#aaa;margin-bottom:4px;">Estaca: ${escapeHtml(originalName)}</div>`;
  }

  // Extrai dados da description HTML (tabela CDATA)
  if (descHtml) {
    const tableData = extractTableFromDescription(descHtml);
    if (tableData.length) {
      tableData.forEach(row => {
        popupHtml += `<div style="display:flex;justify-content:space-between;font-size:0.68rem;
                          border-top:1px solid #1e2124;padding:2px 0;gap:8px;">
          <span style="color:#888;text-transform:uppercase;font-size:0.6rem;">${escapeHtml(row.key)}</span>
          <span style="font-family:'JetBrains Mono',monospace;color:#fff;">${escapeHtml(row.val)}</span>
        </div>`;
      });
    }
  }

  popupHtml += `</div>`;
  marker.bindPopup(popupHtml, { maxWidth: 300 });
  return marker;
}

// Extrai pares chave-valor de uma descrição HTML com tabela
function extractTableFromDescription(html) {
  const rows = [];
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const trs = tmp.querySelectorAll('tr');
    trs.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length === 2) {
        const key = tds[0].textContent.trim();
        const val = tds[1].textContent.trim();
        if (key && val && key !== val) rows.push({ key, val });
      }
    });
  } catch (e) {}
  return rows.slice(0, 8); // máximo 8 campos no popup
}

// ──────────────────────────────────────────────────────────────────────
//  RENDER LISTA DE CAMADAS KMZ
// ──────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderKmzList() {
  const section = document.getElementById('ptKmzSection');
  const list    = document.getElementById('ptKmzList');
  if (!section || !list) return;

  if (!kmzLayers.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = '';

  kmzLayers.forEach(layer => {
    const info = [
      layer.markerCount  ? layer.markerCount  + ' marcos'  : null,
      layer.trackCount   ? layer.trackCount   + ' trilhas' : null,
    ].filter(Boolean).join(' · ');

    const item = document.createElement('div');
    item.className = 'pt-gpx-item' + (layer.visible ? '' : ' hidden-layer');
    item.innerHTML =
      `<div class="pt-gpx-color" style="background:#216C3E;border:1px solid #73b753;"></div>` +
      `<div class="pt-gpx-name" title="${escapeHtml(layer.name)}">${escapeHtml(layer.name)}</div>` +
      `<div class="pt-gpx-pts">${info}</div>` +
      `<button class="pt-gpx-eye" onclick="toggleKmzLayer(${layer.id})">${layer.visible ? 'VIS' : 'OC'}</button>` +
      `<button class="pt-gpx-del" onclick="removeKmzLayer(${layer.id})">X</button>`;
    list.appendChild(item);
  });
}

function toggleKmzLayer(id) {
  const layer = kmzLayers.find(l => l.id === id);
  if (!layer) return;
  layer.visible = !layer.visible;
  if (layer.visible) {
    layer.markerObjs.forEach(m => m.addTo(map));
    layer.trackPolylines.forEach(p => p.addTo(map));
    layer.trackOutlines.forEach(o => { o.addTo(map); o.bringToBack(); });
  } else {
    layer.markerObjs.forEach(m => map.removeLayer(m));
    layer.trackPolylines.forEach(p => map.removeLayer(p));
    layer.trackOutlines.forEach(o => map.removeLayer(o));
  }
  renderKmzList();
  if (typeof updateOffsetPreview === 'function') updateOffsetPreview();
}

function removeKmzLayer(id) {
  const idx = kmzLayers.findIndex(l => l.id === id);
  if (idx === -1) return;
  const layer = kmzLayers[idx];
  layer.markerObjs.forEach(m => map.removeLayer(m));
  layer.trackPolylines.forEach(p => map.removeLayer(p));
  layer.trackOutlines.forEach(o => map.removeLayer(o));
  kmzLayers.splice(idx, 1);
  renderKmzList();
  updatePtEmptyState();
  if (typeof updateOffsetPreview === 'function') updateOffsetPreview();
}

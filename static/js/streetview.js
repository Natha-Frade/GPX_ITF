// ══════════════════════════════════════════════════════════════════════
//  streetview.js — Street View embutido (google.maps.StreetViewPanorama)
//
//  Comportamento:
//  - Com GOOGLE_MAPS_API_KEY configurada (config.js): abre um modal com
//    o painel real do Google Street View — pegman, zoom progressivo,
//    navegação 360°, igual Google Maps/Earth.
//  - Sem key configurada: fallback automático para o link externo
//    (abre o Street View em nova aba, sem custo, sem key).
//
//  A API do Google Maps só é carregada (injetada via <script>) na
//  primeira vez que o painel embutido é aberto — não pesa no carregamento
//  inicial do app, e nunca carrega se a key não estiver configurada.
// ══════════════════════════════════════════════════════════════════════

let gmapsApiLoadPromise = null;
let svPanoramaInstance  = null;

// ── Carrega a API do Google Maps sob demanda (uma única vez) ──
function loadGoogleMapsApi() {
  if (gmapsApiLoadPromise) return gmapsApiLoadPromise;

  gmapsApiLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) { resolve(); return; }

    const callbackName = '__onGoogleMapsLoaded';
    window[callbackName] = () => resolve();

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => reject(new Error('Falha ao carregar Google Maps API'));
    document.head.appendChild(script);
  });

  return gmapsApiLoadPromise;
}

// ── Abre Street View: embutido se houver key, senão link externo ──
function openStreetView(lat, lng) {
  if (STREETVIEW_EMBEDDED_ENABLED) {
    openStreetViewModal(lat, lng);
  } else {
    openStreetViewExternal(lat, lng);
  }
}

// Botão flutuante do mapa: usa o centro atual da visualização
function openStreetViewAtMapCenter() {
  const center = map.getCenter();
  openStreetView(center.lat, center.lng);
}

// ── Fallback sem API key: abre o Google Maps em nova aba ──
function openStreetViewExternal(lat, lng) {
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  window.open(url, '_blank', 'noopener');
}

// ── Painel embutido (modal com StreetViewPanorama real) ──
function openStreetViewModal(lat, lng) {
  const modal = document.getElementById('svModal');
  modal.classList.add('active');
  document.getElementById('svModalBody').innerHTML =
    '<div class="sv-loading">Carregando Street View…</div>';

  loadGoogleMapsApi().then(() => {
    checkStreetViewAvailability(lat, lng);
  }).catch(() => {
    document.getElementById('svModalBody').innerHTML =
      '<div class="sv-error">Não foi possível carregar o Google Maps. ' +
      'Verifique a API key em <code>js/config.js</code> e se o faturamento ' +
      'está ativo no Google Cloud.</div>';
  });
}

// Verifica se existe imagem de Street View naquele ponto antes de renderizar
// (evita o painel "cinza" quando não há cobertura)
function checkStreetViewAvailability(lat, lng) {
  const sv = new google.maps.StreetViewService();
  sv.getPanorama({ location: { lat, lng }, radius: 100 }, (data, status) => {
    if (status === google.maps.StreetViewStatus.OK) {
      renderStreetViewPanorama(data.location.latLng.lat(), data.location.latLng.lng());
    } else {
      document.getElementById('svModalBody').innerHTML =
        '<div class="sv-error">Sem cobertura do Street View neste ponto.<br>' +
        '<button class="btn btn-secondary" style="margin-top:10px;" ' +
        `onclick="closeStreetViewModal();openStreetViewExternal(${lat},${lng})">` +
        'Tentar abrir no Google Maps</button></div>';
    }
  });
}

function renderStreetViewPanorama(lat, lng) {
  const body = document.getElementById('svModalBody');
  body.innerHTML = '<div id="svPanoContainer" style="width:100%;height:100%;"></div>';

  svPanoramaInstance = new google.maps.StreetViewPanorama(
    document.getElementById('svPanoContainer'),
    {
      position: { lat, lng },
      pov: { heading: 0, pitch: 0 },
      zoom: 1,
      addressControl: true,
      fullscreenControl: false, // o modal já é full-size; evita controle duplicado
      motionTracking: false,
    }
  );
}

function closeStreetViewModal() {
  const modal = document.getElementById('svModal');
  modal.classList.remove('active');
  document.getElementById('svModalBody').innerHTML = '';
  svPanoramaInstance = null;
}

// ══════════════════════════════════════════════════════════════════════
//  MODO PERCURSO — "Google Earth" da trilha carregada
//
//  Percorre a trilha GPX dentro do Street View: a cada passo avança
//  ~PASSO_M metros ao longo do traçado e orienta a câmera no rumo da
//  via (bearing até o próximo ponto). Controles: ◀ passo atrás,
//  ▶ passo à frente, ⏯ tour automático, ESC fecha.
//
//  💰 Custo: cada panorama carregado conta na cota do Google
//  (Dynamic Street View). O tour automático é limitado a 1 pano/1.5s
//  e o passo mínimo evita recarregar o mesmo pano. Uso interno da
//  equipe dificilmente sai do crédito mensal gratuito, mas evite
//  deixar o tour rodando sem necessidade.
// ══════════════════════════════════════════════════════════════════════

let svTourIdx    = -1;
let svTourTimer  = null;
const SV_PASSO_M = 25; // metros por passo ao longo da trilha

function _svTrilha() {
  // Prioridade: trilha da aba CORTAR; senão, a vinculada ao vídeo
  if (typeof gpxPoints !== 'undefined' && gpxPoints.length > 1) return gpxPoints;
  if (typeof videoGpxPoints !== 'undefined' && videoGpxPoints.length > 1) return videoGpxPoints;
  return null;
}

// Índice do próximo ponto a >= `metros` de distância ao longo da trilha
function _svAvancar(pts, idx, metros, direcao) {
  let acc = 0, i = idx;
  while (true) {
    const j = i + direcao;
    if (j < 0 || j >= pts.length) return i;
    acc += haversine(pts[i], pts[j]) * 1000;
    i = j;
    if (acc >= metros) return i;
  }
}

function svTourStart() {
  const pts = _svTrilha();
  if (!pts) { showToast('Carregue um GPX primeiro (aba CORTAR GPX)', 'error'); return; }
  if (!STREETVIEW_EMBEDDED_ENABLED) {
    showToast('Configure a API key do Google em js/config.js para o modo percurso', 'error');
    openStreetViewExternal(pts[0].lat, pts[0].lng);
    return;
  }
  // Começa no ponto da trilha mais próximo do centro atual do mapa
  const c = map.getCenter();
  svTourIdx = (typeof nearestPointIndex === 'function' && pts === gpxPoints)
    ? nearestPointIndex(c.lat, c.lng) : 0;

  openStreetViewModal(pts[svTourIdx].lat, pts[svTourIdx].lng);
  // Injeta a barra de controles do tour no modal
  setTimeout(_svInjetarControles, 400);
}

function _svInjetarControles() {
  const body = document.getElementById('svModalBody');
  if (!body || document.getElementById('svTourBar')) return;
  const bar = document.createElement('div');
  bar.id = 'svTourBar';
  bar.style.cssText =
    'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;' +
    'display:flex;gap:8px;align-items:center;background:rgba(15,17,21,0.85);' +
    'padding:8px 12px;border-radius:12px;backdrop-filter:blur(6px);';
  bar.innerHTML =
    '<button class="btn btn-secondary" style="padding:6px 12px;" onclick="svTourStep(-1)" title="Voltar ~25 m">◀</button>' +
    '<button class="btn btn-primary"   style="padding:6px 14px;" onclick="svTourAuto()" id="svTourPlayBtn" title="Tour automático">⏯ Tour</button>' +
    '<button class="btn btn-secondary" style="padding:6px 12px;" onclick="svTourStep(1)" title="Avançar ~25 m">▶</button>' +
    '<span id="svTourInfo" style="font-size:0.68rem;color:#9aa3ad;font-family:monospace;"></span>';
  body.style.position = 'relative';
  body.appendChild(bar);
  _svAtualizarPano();
}

function svTourStep(direcao) {
  const pts = _svTrilha();
  if (!pts || svTourIdx < 0) return;
  svTourIdx = _svAvancar(pts, svTourIdx, SV_PASSO_M, direcao);
  _svAtualizarPano();
}

function _svAtualizarPano() {
  const pts = _svTrilha();
  if (!pts || !svPanoramaInstance) return;
  const p = pts[svTourIdx];
  const prox = pts[Math.min(svTourIdx + 1, pts.length - 1)];
  const rumo = (typeof bearing === 'function' && prox !== p)
    ? bearing([p.lat, p.lng], [prox.lat, prox.lng]) : 0;

  const sv = new google.maps.StreetViewService();
  sv.getPanorama({ location: { lat: p.lat, lng: p.lng }, radius: 60 }, (data, status) => {
    if (status === google.maps.StreetViewStatus.OK && svPanoramaInstance) {
      svPanoramaInstance.setPano(data.location.pano);
      svPanoramaInstance.setPov({ heading: rumo, pitch: 0 });
    }
    const info = document.getElementById('svTourInfo');
    if (info) {
      const kmAqui = (typeof kmUpTo === 'function' && pts === gpxPoints)
        ? kmUpTo(pts, svTourIdx).toFixed(2) + ' km' : 'pt ' + svTourIdx;
      info.textContent = kmAqui + ' • ' + (svTourIdx + 1) + '/' + pts.length +
        (status !== google.maps.StreetViewStatus.OK ? ' (sem cobertura aqui)' : '');
    }
  });
}

function svTourAuto() {
  const btn = document.getElementById('svTourPlayBtn');
  if (svTourTimer) {
    clearInterval(svTourTimer); svTourTimer = null;
    if (btn) btn.textContent = '⏯ Tour';
    return;
  }
  if (btn) btn.textContent = '⏸ Pausar';
  svTourTimer = setInterval(() => {
    const pts = _svTrilha();
    if (!pts || !document.getElementById('svModal')?.classList.contains('active')) {
      clearInterval(svTourTimer); svTourTimer = null; return;
    }
    const antes = svTourIdx;
    svTourStep(1);
    if (svTourIdx === antes) { // chegou ao fim da trilha
      clearInterval(svTourTimer); svTourTimer = null;
      if (btn) btn.textContent = '⏯ Tour';
      showToast('Fim da trilha', 'success');
    }
  }, 1500); // limite de 1 pano/1.5s — controla custo da API
}

// Encerra o timer quando o modal fecha (encapsula a função original)
const _svCloseOriginal = closeStreetViewModal;
closeStreetViewModal = function () {
  if (svTourTimer) { clearInterval(svTourTimer); svTourTimer = null; }
  svTourIdx = -1;
  _svCloseOriginal();
};

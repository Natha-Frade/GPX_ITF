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

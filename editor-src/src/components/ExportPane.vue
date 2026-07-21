<script setup>
// ExportPane — overlay de exportação (estilo CapCut), 100% no navegador.
// Fluxo: título/opções → análise da timeline (mostra o modo que será
// usado e por quê) → export (stream copy ou WebCodecs/GPU) → download do
// MP4 + GPX e player de comparação (vídeo × rota no mapa).
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEdlStore } from '../stores/edl'
import { fmt, positionAt } from '../utils'
import { analyze, runExport } from '../services/export'
import { getSource } from '../services/sources'

const store = useEdlStore()

const phase = ref('idle') // idle | ask | running | done | error
const title = ref('')
const quality = ref('media') // só usado no modo composição (re-encode)
const ignoreGaps = ref(true) // juntar trechos (remove espaços vazios)
const statusMsg = ref('')
const progress = ref(0)
const errorMsg = ref('')
const result = ref(null) // { videoBlob, gpxText, points, mode, duration }
const videoUrl = ref('')
const titleInput = ref(null)
const resultVideo = ref(null)
const resultMapEl = ref(null)
let abort = null
let rmap = null
let progressLine = null
let marker = null
let points = []

const plan = computed(() => {
  if (phase.value !== 'ask') return null
  return analyze(store.edl, getSource, { ignoreGaps: ignoreGaps.value })
})
const planLabel = computed(() => {
  const p = plan.value
  if (!p) return ''
  if (p.mode === 'copy') return '⚡ Sem re-encode (stream copy): rápido, qualidade original'
  if (p.mode === 'remote') return '☁ Corte no servidor, direto do SharePoint'
  if (p.mode === 'webcodecs') return '🎛 Composição com aceleração de hardware (GPU)'
  if (p.mode === 'mixed') return '⚠ ' + p.reasons.join('; ')
  return ''
})

function start() {
  if (!store.segmentsCount || phase.value === 'running') return
  title.value = ''
  errorMsg.value = ''
  phase.value = 'ask'
  nextTick(() => titleInput.value?.focus())
}
defineExpose({ start })

async function confirmExport() {
  if (plan.value?.mode === 'mixed') return
  phase.value = 'running'
  progress.value = 0
  statusMsg.value = 'Analisando a timeline…'
  errorMsg.value = ''
  abort = new AbortController()
  const t0 = performance.now()
  try {
    const res = await runExport(
      store.edl,
      {
        title: title.value.trim() || 'export',
        quality: quality.value,
        ignoreGaps: ignoreGaps.value,
        signal: abort.signal,
      },
      {
        status: (m) => (statusMsg.value = m),
        progress: (p) => (progress.value = Math.round(p * 100)),
      }
    )
    res.elapsed = (performance.now() - t0) / 1000
    result.value = res
    videoUrl.value = URL.createObjectURL(res.videoBlob)
    phase.value = 'done'
    nextTick(initResultMap)
  } catch (e) {
    console.error('[export]', e)
    errorMsg.value = e.message
    phase.value = 'error'
  }
}

function cancel() {
  abort?.abort()
}

const slug = () =>
  (title.value.trim() || 'export')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\- ]/g, '')
    .replace(/\s+/g, '_') || 'export'

function download(kind) {
  const a = document.createElement('a')
  if (kind === 'mp4') {
    a.href = videoUrl.value
    a.download = `${slug()}.mp4`
  } else {
    a.href = URL.createObjectURL(new Blob([result.value.gpxText], { type: 'application/gpx+xml' }))
    a.download = `${slug()}.gpx`
  }
  a.click()
}

const gpxRange = computed(() => {
  const pts = result.value?.points ?? []
  return pts.length ? pts[pts.length - 1].t - pts[0].t : 0
})
const timeDiff = computed(() => Math.abs((result.value?.duration ?? 0) - gpxRange.value))

function close() {
  destroyMap()
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  videoUrl.value = ''
  result.value = null
  phase.value = 'idle'
}

function newProject() {
  store.newProject()
  close()
}

function destroyMap() {
  rmap?.remove()
  rmap = null
  progressLine = null
  marker = null
}

function initResultMap() {
  if (!resultMapEl.value) return
  destroyMap()
  points = result.value?.points ?? []
  rmap = L.map(resultMapEl.value)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(rmap)
  const all = points.map((p) => [p.lat, p.lon])
  if (all.length) {
    L.polyline(all, { color: '#8b93a3', weight: 3, opacity: 0.5 }).addTo(rmap)
    rmap.fitBounds(L.latLngBounds(all).pad(0.15))
  } else {
    rmap.setView([-19.92, -43.94], 12)
  }
  progressLine = L.polyline([], { color: '#22c55e', weight: 4 }).addTo(rmap)
  setTimeout(() => rmap?.invalidateSize(), 120)
  syncMapToVideo()
}

function syncMapToVideo() {
  if (!rmap) return
  const t = resultVideo.value?.currentTime ?? 0
  progressLine.setLatLngs(points.filter((p) => p.t <= t).map((p) => [p.lat, p.lon]))
  const pos = positionAt(points, t)
  if (!pos) return
  if (!marker) {
    marker = L.circleMarker([pos.lat, pos.lon], {
      radius: 7,
      weight: 2,
      color: '#ffffff',
      fillColor: '#22c55e',
      fillOpacity: 1,
    }).addTo(rmap)
  } else {
    marker.setLatLng([pos.lat, pos.lon])
  }
}

onBeforeUnmount(() => {
  destroyMap()
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
})
</script>

<template>
  <div
    v-if="phase !== 'idle'"
    class="modal-backdrop"
    @click.self="phase === 'ask' ? close() : null"
  >
    <!-- 1. opções -->
    <div v-if="phase === 'ask'" class="modal pane">
      <h2>Exportar</h2>
      <label class="field">
        Título do vídeo
        <input
          ref="titleInput"
          v-model="title"
          type="text"
          placeholder="ex.: BR-153_corte_12"
          @keyup.enter="confirmExport"
        />
      </label>
      <label class="check">
        <input v-model="ignoreGaps" type="checkbox" />
        juntar os trechos (remove os espaços vazios da timeline)
      </label>
      <label v-if="plan?.mode === 'webcodecs'" class="field">
        Qualidade (só na composição — re-encode)
        <select v-model="quality">
          <option value="alta">Alta (arquivo maior)</option>
          <option value="media">Média (recomendada)</option>
          <option value="baixa">Baixa (arquivo menor)</option>
        </select>
      </label>
      <p class="plan" :class="{ warn: plan?.mode === 'mixed' }">{{ planLabel }}</p>
      <div class="row">
        <button class="btn" @click="close">Cancelar</button>
        <button class="btn primary" :disabled="plan?.mode === 'mixed'" @click="confirmExport">
          Exportar mp4 + gpx
        </button>
      </div>
    </div>

    <!-- 2. progresso -->
    <div v-else-if="phase === 'running'" class="modal pane">
      <h2>Exportando…</h2>
      <div class="bar"><div class="fill" :style="{ width: progress + '%' }" /></div>
      <p class="muted">{{ progress }}% — {{ statusMsg }}</p>
      <div class="row">
        <button class="btn" @click="cancel">Cancelar</button>
      </div>
    </div>

    <!-- 3. erro -->
    <div v-else-if="phase === 'error'" class="modal pane">
      <h2>Ops</h2>
      <p class="error">{{ errorMsg }}</p>
      <div class="row">
        <button class="btn" @click="phase = 'ask'">Voltar</button>
        <button class="btn" @click="close">Fechar</button>
      </div>
    </div>

    <!-- 4. resultado: download + comparação vídeo × GPX -->
    <div v-else-if="phase === 'done'" class="modal pane wide">
      <h2>Pronto ✓</h2>
      <p class="muted">
        modo: <b>{{ result.mode === 'copy' ? 'sem re-encode' : result.mode === 'remote' ? 'corte no servidor' : 'composição (GPU)' }}</b>
        · duração {{ fmt(result.duration) }}
        · levou {{ result.elapsed.toFixed(0) }}s
        · vídeo × GPX: {{ timeDiff.toFixed(2) }}s de diferença
      </p>
      <div class="compare">
        <video
          ref="resultVideo"
          :src="videoUrl"
          controls
          @timeupdate="syncMapToVideo"
        />
        <div ref="resultMapEl" class="result-map"></div>
      </div>
      <div class="row">
        <button class="btn primary" @click="download('mp4')">⬇ Baixar MP4</button>
        <button class="btn primary" @click="download('gpx')">⬇ Baixar GPX</button>
        <span class="spacer" />
        <button class="btn" @click="close">Continuar editando</button>
        <button class="btn" @click="newProject">Criar novo projeto</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: min(480px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
}

.modal.wide {
  width: min(980px, 94vw);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}

.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  margin-bottom: 10px;
}

.plan {
  font-size: 13px;
  color: #22c55e;
  margin: 4px 0 12px;
}

.plan.warn {
  color: #f59e0b;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.row .spacer {
  flex: 1;
}

.bar {
  height: 10px;
  background: var(--panel-2);
  border-radius: 6px;
  overflow: hidden;
  margin: 12px 0 8px;
}

.fill {
  height: 100%;
  background: #22c55e;
  transition: width 0.3s;
}

.error {
  color: var(--danger);
}

.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 10px 0;
}

.compare video {
  width: 100%;
  max-height: 380px;
  background: #000;
  border-radius: 8px;
}

.result-map {
  min-height: 260px;
  border-radius: 8px;
}

@media (max-width: 800px) {
  .compare {
    grid-template-columns: 1fr;
  }
}
</style>

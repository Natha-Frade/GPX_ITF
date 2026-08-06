<script setup>
import { computed, reactive, ref } from 'vue'
import { useEdlStore } from '../stores/edl'
import { basename, fmt } from '../utils'
import { getSource } from '../services/sources'

const store = useEdlStore()

const LABEL_W = 150
const SNAP_PX = 12

const pxPerSec = ref(40)
const scrollEl = ref(null)
const laneEls = reactive({}) // track.id -> elemento da pista (pra detectar drop)
const snapGuide = ref(null) // instante onde o imã "grudou" (linha-guia visual)

const innerWidth = computed(
  () => Math.max(store.timelineDuration + 8, 30) * pxPerSec.value
)

// zoom bem amplo: de 0.2 px/s (vídeos longos viram tracinhos) a 400 px/s
const ZOOM_MIN = 0.2
const ZOOM_MAX = 400
const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))

// régua: passo dos ticks conforme o zoom (>= ~50px entre marcas)
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
const tickStep = computed(
  () => TICK_STEPS.find((s) => s * pxPerSec.value >= 50) ?? 3600
)
const ticks = computed(() => {
  const total = Math.max(store.timelineDuration + 8, 30)
  const out = []
  for (let t = 0; t <= total; t += tickStep.value) out.push(t)
  return out
})

const tickLabel = (t) =>
  t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`

function zoom(factor) {
  pxPerSec.value = clampZoom(pxPerSec.value * factor)
}

// Ctrl+scroll com o mouse sobre a timeline: zoom ancorado no cursor
function onWheel(e) {
  if (!e.ctrlKey) return
  e.preventDefault()
  const el = scrollEl.value
  const rect = el.getBoundingClientRect()
  const cursorPx = e.clientX - rect.left + el.scrollLeft - LABEL_W
  const tAtCursor = cursorPx / pxPerSec.value
  const next = clampZoom(pxPerSec.value * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
  pxPerSec.value = next
  requestAnimationFrame(() => {
    el.scrollLeft = Math.max(0, tAtCursor * next - (e.clientX - rect.left - LABEL_W))
  })
}
function zoomFit() {
  const w = scrollEl.value?.clientWidth ?? 800
  pxPerSec.value = clampZoom((w - LABEL_W - 40) / Math.max(store.timelineDuration, 1))
}

const blockStyle = (seg) => {
  const src = store.sourceById(seg.source_id)
  return {
    left: `${seg.start * pxPerSec.value}px`,
    width: `${(seg.out - seg.in) * pxPerSec.value}px`,
    '--seg-color': src?.color ?? '#22c55e',
    backgroundImage: src?.thumb ? `url(${src.thumb})` : 'none',
  }
}

// ---- imã (snap): bordas dos segmentos de TODAS as trilhas, t=0 e o playhead
function snapCandidates(exceptId) {
  const cands = [0, store.playhead]
  for (const { seg } of store.allSegments) {
    if (seg.id === exceptId) continue
    cands.push(seg.start, seg.start + (seg.out - seg.in))
  }
  return cands
}

// gruda `raw` (ou `raw + dur`, o que estiver mais perto) num candidato;
// atualiza a linha-guia visual
function applySnap(raw, dur, cands) {
  const limit = SNAP_PX / pxPerSec.value
  let best = { t: raw, guide: null, d: limit }
  for (const c of cands) {
    let d = Math.abs(c - raw)
    if (d < best.d) best = { t: c, guide: c, d }
    if (dur > 0) {
      d = Math.abs(c - (raw + dur))
      if (d < best.d) best = { t: Math.max(0, c - dur), guide: c, d }
    }
  }
  snapGuide.value = best.guide
  return best.t
}

// ---- drag de blocos (mover / trim das bordas) -----------------------------
function onBlockDown(e, seg, kind) {
  e.preventDefault()
  store.selectSegment(seg.id, { seek: false })
  store.snapshot()
  const startX = e.clientX
  const orig = { start: seg.start, in: seg.in, out: seg.out }
  const dur = orig.out - orig.in
  const cands = snapCandidates(seg.id)
  const laneRects = Object.fromEntries(
    Object.entries(laneEls).map(([id, el]) => [id, el.getBoundingClientRect()])
  )

  const onMove = (ev) => {
    const dt = (ev.clientX - startX) / pxPerSec.value
    if (kind === 'move') {
      const ns = applySnap(Math.max(0, orig.start + dt), dur, cands)
      let trackId
      for (const [id, r] of Object.entries(laneRects)) {
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) trackId = id
      }
      store.moveSegment(seg.id, { start: ns, trackId })
    } else if (kind === 'trim-in') {
      // borda esquerda: in e start andam juntos (o conteúdo não escorrega);
      // o imã age sobre a borda na timeline
      const rawIn = Math.min(Math.max(orig.in + dt, 0), orig.out - 0.1)
      const snapped = applySnap(orig.start + (rawIn - orig.in), 0, cands)
      const newIn = Math.min(Math.max(orig.in + (snapped - orig.start), 0), orig.out - 0.1)
      store.trimSegment(seg.id, { in: newIn, start: orig.start + (newIn - orig.in) })
    } else if (kind === 'trim-out') {
      const rawEnd = orig.start + Math.max(orig.out + dt - orig.in, 0.1)
      const snapped = applySnap(rawEnd, 0, cands)
      store.trimSegment(seg.id, { out: orig.in + (snapped - orig.start) })
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    snapGuide.value = null
    store.dropSnapshotIfUnchanged()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// ---- drop de vídeo vindo do painel de vídeos ------------------------------
function onLaneDragOver(e) {
  if ([...e.dataTransfer.types].includes('application/x-tender-video')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}

async function onLaneDrop(e, track) {
  const srcId = e.dataTransfer.getData('application/x-tender-video')
  if (!srcId) return
  e.preventDefault()
  const rect = laneEls[track.id].getBoundingClientRect()
  const start = Math.max(0, (e.clientX - rect.left) / pxPerSec.value)
  try {
    const src = getSource(srcId)
    if (src) store.addSource(src, { trackId: track.id, start })
  } catch (err) {
    console.error('falha ao adicionar vídeo na trilha:', err)
  }
}

// ---- régua: clique/arrasto posiciona o playhead ---------------------------
function rulerSeek(ev, el) {
  const rect = el.getBoundingClientRect()
  store.seekTimeline(Math.max(0, (ev.clientX - rect.left) / pxPerSec.value))
}
function onRulerDown(e) {
  const el = e.currentTarget
  rulerSeek(e, el)
  const onMove = (ev) => rulerSeek(ev, el)
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

const trackLabel = (track) => `Trilha ${track.id.replace('track', '')}`
</script>

<template>
  <section class="pane timeline-pane">
    <div class="tl-toolbar">
      <h2>Timeline</h2>
      <button class="btn" title="divide o segmento sob o playhead (S)" @click="store.splitAtPlayhead()">
        ✂ dividir
      </button>
      <button
        class="btn"
        title="junta com o próximo segmento (mesma source, contíguo)"
        :disabled="!store.canJoinWithNext(store.selectedSegmentId)"
        @click="store.joinWithNext(store.selectedSegmentId)"
      >
        ⇥ juntar
      </button>
      <button
        class="btn"
        title="exclui o segmento selecionado (Del) — deixa buraco"
        :disabled="!store.selectedSegment"
        @click="store.removeSegment(store.selectedSegmentId)"
      >
        🗑 excluir
      </button>
      <span class="sep" />
      <button class="btn" title="desfazer (Ctrl+Z)" :disabled="!store.history.length" @click="store.undo()">↶</button>
      <button class="btn" title="refazer (Ctrl+Y)" :disabled="!store.future.length" @click="store.redo()">↷</button>
      <span class="spacer" />
      <span class="muted">zoom</span>
      <button class="btn" @click="zoom(1 / 1.5)">−</button>
      <button class="btn" @click="zoom(1.5)">+</button>
      <button class="btn" @click="zoomFit()">ajustar</button>
    </div>

    <div ref="scrollEl" class="tl-scroll" @wheel="onWheel">
      <div class="tl-inner" :style="{ width: innerWidth + LABEL_W + 'px' }">
        <div class="tl-row tl-ruler-row">
          <div class="tl-corner muted">{{ fmt(store.playhead) }}</div>
          <div class="tl-ruler" :style="{ width: innerWidth + 'px' }" @pointerdown="onRulerDown">
            <span
              v-for="t in ticks"
              :key="t"
              class="tick muted"
              :style="{ left: t * pxPerSec + 'px' }"
            >{{ tickLabel(t) }}</span>
          </div>
        </div>

        <div
          v-for="track in store.tracksTopFirst"
          :key="track.id"
          class="tl-row tl-track"
          :data-track="track.id"
        >
          <div
            class="tl-label"
            :class="{ sel: store.selectionMode === 'track' && store.selectedTrackId === track.id }"
            title="clique pra selecionar a trilha inteira (todas as rotas no mapa)"
            @click="store.selectTrack(track.id)"
          >
            <span class="tname">{{ trackLabel(track) }}</span>
            <button
              class="mute-btn"
              :class="{ off: track.muted }"
              :title="track.muted ? 'trilha mutada (sem som no preview e no export)' : 'mutar trilha'"
              @click.stop="store.toggleTrackMute(track.id)"
            >
              {{ track.muted ? '🔇' : '🔊' }}
            </button>
          </div>
          <div
            :ref="(el) => { if (el) laneEls[track.id] = el }"
            class="tl-lane"
            :style="{ width: innerWidth + 'px' }"
            @dragover="onLaneDragOver"
            @drop="onLaneDrop($event, track)"
          >
            <div
              v-for="seg in track.segments"
              :key="seg.id"
              class="tl-block"
              :class="{ sel: seg.id === store.selectedSegmentId && store.selectionMode === 'segment' }"
              :style="blockStyle(seg)"
              @pointerdown="onBlockDown($event, seg, 'move')"
            >
              <div class="edge left" @pointerdown.stop="onBlockDown($event, seg, 'trim-in')" />
              <span class="bl-name">{{ basename(store.sourceById(seg.source_id)?.path ?? '?') }}</span>
              <span class="bl-range">{{ fmt(seg.in) }}→{{ fmt(seg.out) }}</span>
              <div class="edge right" @pointerdown.stop="onBlockDown($event, seg, 'trim-out')" />
            </div>
          </div>
        </div>

        <div
          class="tl-playhead"
          :style="{ left: LABEL_W + store.playhead * pxPerSec + 'px' }"
        />
        <div
          v-if="snapGuide !== null"
          class="tl-snapline"
          :style="{ left: LABEL_W + snapGuide * pxPerSec + 'px' }"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.tl-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.tl-toolbar h2 {
  margin: 0 8px 0 0;
}

.sep {
  width: 1px;
  height: 20px;
  background: var(--border);
}

.spacer {
  flex: 1;
}

.tl-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
}

.tl-inner {
  position: relative;
}

.tl-row {
  display: flex;
}

.tl-corner {
  flex: none;
  width: 150px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}

.tl-ruler {
  position: relative;
  height: 26px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  flex: none;
}

.tick {
  position: absolute;
  top: 4px;
  font-size: 10px;
  border-left: 1px solid var(--border);
  padding-left: 3px;
  pointer-events: none;
  user-select: none;
}

.tl-track {
  border-bottom: 1px solid var(--border);
}

.tl-track:last-of-type {
  border-bottom: none;
}

.tl-label {
  flex: none;
  width: 150px;
  padding: 6px 8px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  border-left: 3px solid transparent;
}

.tl-label.sel {
  border-left-color: var(--accent);
}

.tname {
  font-size: 12px;
}

.mute-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}

.mute-btn.off {
  opacity: 0.9;
}

.tl-snapline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 2px dashed var(--accent);
  pointer-events: none;
}

.tl-lane {
  position: relative;
  height: 56px;
  flex: none;
}

.tl-block {
  position: absolute;
  top: 6px;
  height: 44px;
  border-radius: 6px;
  border: 1px solid var(--seg-color);
  background-color: color-mix(in srgb, var(--seg-color) 30%, transparent);
  background-size: auto 100%;
  background-repeat: no-repeat;
  background-blend-mode: multiply;
  cursor: grab;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  user-select: none;
  touch-action: none;
}

.tl-block.sel {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.bl-name {
  font-size: 11px;
  color: var(--text);
  text-shadow: 0 1px 2px #000;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bl-range {
  font-size: 10px;
  color: var(--text);
  text-shadow: 0 1px 2px #000;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}

.edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
}

.edge.left {
  left: 0;
  border-left: 3px solid var(--seg-color);
}

.edge.right {
  right: 0;
  border-right: 3px solid var(--seg-color);
}

.tl-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
  opacity: 0.85;
  pointer-events: none;
}

</style>

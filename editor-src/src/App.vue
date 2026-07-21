<script setup>
// App do Editor — layout e atalhos globais (S divide, Del exclui,
// Ctrl+Z/Y desfaz/refaz, espaço toca/pausa, ←/→ = 1 frame, Shift = 1s).
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEdlStore } from './stores/edl'
import PlayerPane from './components/PlayerPane.vue'
import MapPane from './components/MapPane.vue'
import TimelinePane from './components/TimelinePane.vue'
import MediaPool from './components/MediaPool.vue'
import ExportPane from './components/ExportPane.vue'

const store = useEdlStore()
const exportPane = ref(null)

function onKey(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  const k = e.key.toLowerCase()
  if ((e.ctrlKey || e.metaKey) && k === 'z' && e.shiftKey) {
    e.preventDefault()
    store.redo()
  } else if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault()
    store.undo()
  } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
    e.preventDefault()
    store.redo()
  } else if (k === 's' && !e.ctrlKey && !e.metaKey) {
    store.splitAtPlayhead()
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (store.selectedSegmentId) store.removeSegment(store.selectedSegmentId)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const fps = store.selectedSource?.fps || 30
    const step = (e.shiftKey ? 1 : 1 / fps) * (e.key === 'ArrowLeft' ? -1 : 1)
    store.setPlayhead(store.playhead + step)
  } else if (e.key === ' ') {
    e.preventDefault()
    const v = document.querySelector('video')
    if (v) v.paused ? v.play() : v.pause()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <a class="back" href="/" title="voltar ao GPX IMTRAFF">←</a>
      <h1>GPX IMTRAFF — EDITOR</h1>
      <div class="spacer" />
      <button class="btn" title="desfazer (Ctrl+Z)" :disabled="!store.history.length" @click="store.undo()">↶</button>
      <button class="btn" title="refazer (Ctrl+Y)" :disabled="!store.future.length" @click="store.redo()">↷</button>
      <button
        class="btn primary"
        :disabled="!store.segmentsCount"
        @click="exportPane.start()"
      >
        Exportar mp4+gpx
      </button>
    </header>

    <ExportPane ref="exportPane" />

    <main class="panes">
      <PlayerPane />
      <MapPane />
      <TimelinePane class="full" />
      <MediaPool class="full" />
    </main>
  </div>
</template>

<style scoped>
.app {
  max-width: 1280px;
  margin: 0 auto;
  padding: 14px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar .back {
  font-size: 20px;
  text-decoration: none;
  color: inherit;
  opacity: 0.7;
}

.toolbar .back:hover {
  opacity: 1;
}

.toolbar h1 {
  font-size: 18px;
  margin: 0;
  letter-spacing: 0.06em;
}

.spacer {
  flex: 1;
}

.panes {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 12px;
  align-items: start;
}

.panes .full {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .panes {
    grid-template-columns: 1fr;
  }
}
</style>

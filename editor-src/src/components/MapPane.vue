<script setup>
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEdlStore } from '../stores/edl'
import { positionAt } from '../utils'

const store = useEdlStore()
const mapEl = ref(null)

let map = null
let marker = null
const lines = new Map() // source_id -> L.Polyline
let lastFitKey = ''
let stopRedraw = null

onMounted(() => {
  map = L.map(mapEl.value)
  map.setView([-23.55, -46.63], 13)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map)
  stopRedraw = watchEffect(redraw) // reexecuta quando playhead/seleção/EDL mudam
})

onBeforeUnmount(() => {
  stopRedraw?.()
  map?.remove()
})

function redraw() {
  if (!map) return
  const visible = store.visibleSourceIds
  const windows = store.usedWindowsBySource

  for (const [id, line] of lines) {
    if (!visible.includes(id)) {
      line.remove()
      lines.delete(id)
    }
  }

  // REGRA CENTRAL: por source, desenha só os trechos USADOS na timeline
  // (janelas in..out dos segmentos), até onde o playhead já chegou em cada
  // um — partes cortadas do vídeo não aparecem no GPX
  for (const id of visible) {
    const src = store.sourceById(id)
    const pts = src?.gpx?.points ?? []
    const groups = (windows[id] ?? [])
      .map(([a, b]) =>
        pts.filter((p) => p.t >= a - 1e-6 && p.t <= b + 1e-6).map((p) => [p.lat, p.lon])
      )
      .filter((g) => g.length >= 2)

    if (!groups.length) {
      lines.get(id)?.remove()
      lines.delete(id)
      continue
    }
    const color = src.color ?? '#22c55e'
    let line = lines.get(id)
    if (!line) {
      line = L.polyline(groups, { color, weight: 4, className: 'route-line' }).addTo(map)
      lines.set(id, line)
    } else {
      line.setLatLngs(groups)
      line.setStyle({ color })
    }
  }

  // marcador da posição atual: mapa de tempo -> (source, t) -> lat/lon interpolado
  const at = store.markerPosition
  const src = at ? store.sourceById(at.source_id) : null
  const pos = src ? positionAt(src.gpx?.points ?? [], at.t) : null
  if (pos) {
    const color = src.color ?? '#22c55e'
    if (!marker) {
      marker = L.circleMarker([pos.lat, pos.lon], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: color,
        fillOpacity: 1,
        className: 'playhead-marker',
      }).addTo(map)
    } else {
      marker.setLatLng([pos.lat, pos.lon])
      marker.setStyle({ fillColor: color })
    }
  } else if (marker) {
    marker.remove()
    marker = null
  }

  // reenquadra só quando o conjunto de sources visíveis muda (não a cada tick)
  const fitKey = visible.join(',')
  if (fitKey !== lastFitKey) {
    lastFitKey = fitKey
    const all = visible.flatMap((id) =>
      (store.sourceById(id)?.gpx?.points ?? []).map((p) => [p.lat, p.lon])
    )
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.15))
  }
}
</script>

<template>
  <section class="pane map-pane">
    <h2>Mapa GPS</h2>
    <div ref="mapEl" class="map" />
  </section>
</template>

<style scoped>
.map {
  height: 340px;
  border-radius: 8px;
  background: var(--panel-2);
}
</style>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEdlStore } from '../stores/edl'
import { basename, fmt } from '../utils'

const store = useEdlStore()
const videoEl = ref(null)
const playMode = ref(null) // null | 'trecho' | 'timeline'
const inGap = ref(false) // tocando um buraco da timeline: tela preta
const playbackError = ref('')
let advancing = false // troca de segmento veio da reprodução: mantém tocando
let rafId = null
let lastTick = 0

const src = computed(() =>
  store.selectedSource?.url ?? ''
)

watch(src, () => (playbackError.value = ''))

function onVideoError() {
  const code = videoEl.value?.error?.code
  playbackError.value =
    code === 4 // MEDIA_ERR_SRC_NOT_SUPPORTED (ex.: HEVC sem suporte no navegador)
      ? 'o navegador não consegue tocar este codec — o export continua funcionando normalmente'
      : 'falha ao carregar o vídeo no player'
}

const pendingLoad = () => {
  const v = videoEl.value
  return Boolean(v && v.src && v.currentSrc !== v.src)
}

// seeks feitos pelo app não realimentam o playhead (senão eventos atrasados
// de seeked/timeupdate sobrescrevem cliques na régua e edições); só a
// reprodução de verdade e o scrub manual do usuário movem o playhead
let progSeek = false
function setVideoTime(t) {
  const v = videoEl.value
  if (!v) return
  progSeek = true
  v.currentTime = t
}
function onSeeked() {
  if (progSeek) {
    progSeek = false
    return
  }
  onTimeUpdate()
}

function applyTrackMute() {
  const v = videoEl.value
  if (v) v.muted = Boolean(store.selectedSegmentTrack?.muted)
}
watch(() => store.selectedSegmentTrack?.muted, applyTrackMute)

function seekToIn() {
  const seg = store.selectedSegment
  const v = videoEl.value
  if (!seg || !v) return
  if (!advancing) playMode.value = null
  applyTrackMute()
  // busca a posição do playhead DENTRO do segmento — assim clicar na régua
  // sobre outro segmento não faz o playhead voltar pro início dele
  const target =
    seg.in + Math.min(Math.max(store.playhead - seg.start, 0), seg.out - seg.in)
  // se a src acabou de trocar, o readyState ainda é da mídia antiga: buscar
  // agora aplicaria o tempo no vídeo errado e a carga nova zeraria tudo
  if (v.readyState >= 1 && !pendingLoad()) {
    setVideoTime(target)
  } else {
    v.addEventListener('loadedmetadata', () => setVideoTime(target), { once: true })
  }
  if (advancing) {
    advancing = false
    if (v.readyState >= 2 && !pendingLoad()) v.play()
    else v.addEventListener('canplay', () => v.play(), { once: true })
  }
}

watch(
  () => [store.selectedSegment?.id, store.selectedSegment?.in],
  () => seekToIn(),
  { flush: 'post' } // espera o <video> trocar de src antes de buscar o in
)

// playhead movido de fora (régua ou setinhas): busca o vídeo. Pausado, a
// precisão é de 1 frame (edição fina); tocando, o limiar maior evita briga
// com o timeupdate.
watch(
  () => store.playhead,
  (T) => {
    const seg = store.selectedSegment
    const v = videoEl.value
    if (!seg || !v || v.seeking || v.readyState < 1 || pendingLoad()) return
    const expected = seg.in + Math.min(Math.max(T - seg.start, 0), seg.out - seg.in)
    const threshold = v.paused ? 0.01 : 0.35
    if (Math.abs(v.currentTime - expected) > threshold) setVideoTime(expected)
  }
)

// sem os controles nativos (bugavam a sincronia): play/pause é pela
// interface — clique no vídeo, botões, ou espaço
function togglePause() {
  const v = videoEl.value
  if (!v || !src.value) return
  v.paused ? v.play() : v.pause()
}

// ---- reprodução da timeline (composição): toca até o fim da trilha mais
// longa; buraco = tela preta com o relógio andando por requestAnimationFrame
function stopGapClock() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  inGap.value = false
}

function startGapClock() {
  videoEl.value?.pause()
  inGap.value = true
  lastTick = performance.now()
  const step = (now) => {
    rafId = null
    if (playMode.value !== 'timeline') return stopGapClock()
    const T = store.playhead + (now - lastTick) / 1000
    lastTick = now
    if (T >= store.timelineDuration - 1e-3) {
      store.setPlayhead(store.timelineDuration)
      stopTimeline()
      return
    }
    store.setPlayhead(T)
    const active = store.activeAt(T)
    if (active) {
      stopGapClock()
      switchTo(active)
    } else {
      rafId = requestAnimationFrame(step)
    }
  }
  rafId = requestAnimationFrame(step)
}

function switchTo(active) {
  const v = videoEl.value
  if (store.selectedSegmentId === active.seg.id) {
    applyTrackMute()
    if (!v || !v.paused) return
    if (pendingLoad() || v.readyState < 2) {
      // a source ainda está carregando: retoma quando der
      v.addEventListener(
        'canplay',
        () => {
          if (playMode.value === 'timeline') v.play()
        },
        { once: true }
      )
    } else {
      v.play()
    }
  } else {
    advancing = true
    store.selectSegment(active.seg.id, { seek: false }) // o watch faz seek+play
  }
}

function stopTimeline() {
  stopGapClock()
  videoEl.value?.pause()
  playMode.value = null
}

function maybeSwitch() {
  const T = store.playhead
  if (T >= store.timelineDuration - 0.05) return stopTimeline()
  const active = store.activeAt(T)
  if (!active) return startGapClock()
  if (active.seg.id !== store.selectedSegmentId) switchTo(active)
}

function playSegment() {
  const seg = store.selectedSegment
  const v = videoEl.value
  if (!seg || !v) return
  stopGapClock()
  playMode.value = 'trecho'
  applyTrackMute()
  setVideoTime(seg.in)
  store.setPlayhead(seg.start)
  v.play()
}

function playTimeline() {
  if (playMode.value === 'timeline') return stopTimeline()
  if (!store.segmentsCount) return
  playMode.value = 'timeline'
  if (store.playhead >= store.timelineDuration - 0.05) store.setPlayhead(0)
  const active = store.activeAt(store.playhead)
  if (active) switchTo(active)
  else startGapClock()
}

function onTimeUpdate() {
  const v = videoEl.value
  const seg = store.selectedSegment
  if (!v || !seg || pendingLoad() || progSeek) return
  // playhead da timeline final = start do segmento + progresso dentro dele
  const inSeg = Math.min(Math.max(v.currentTime, seg.in), seg.out)
  store.setPlayhead(seg.start + (inSeg - seg.in))
  if (playMode.value === 'trecho') {
    if (v.currentTime >= seg.out - 0.05) {
      v.pause()
      playMode.value = null
    }
  } else if (playMode.value === 'timeline') {
    if (v.currentTime >= seg.out - 0.05) {
      store.setPlayhead(seg.start + (seg.out - seg.in))
    }
    maybeSwitch()
  }
}

function onEnded() {
  if (playMode.value === 'timeline') {
    const seg = store.selectedSegment
    if (seg) store.setPlayhead(seg.start + (seg.out - seg.in))
    maybeSwitch()
  } else {
    playMode.value = null
  }
}

onBeforeUnmount(stopGapClock)
</script>

<template>
  <section class="pane player">
    <h2>Player</h2>
    <div class="video-wrap">
      <video
        v-show="src && !inGap"
        ref="videoEl"
        :src="src"
        @click="togglePause"
        @timeupdate="onTimeUpdate"
        @seeked="onSeeked"
        @ended="onEnded"
        @error="onVideoError"
      />
      <div v-if="inGap" class="empty muted gap">— espaço vazio na timeline —</div>
      <div v-else-if="!src" class="empty muted">adicione um vídeo pra começar</div>
    </div>
    <p v-if="playbackError" class="playback-error">⚠ {{ playbackError }}</p>
    <div v-if="store.selectedSegment" class="seg-info">
      <span class="dot" :style="{ background: store.selectedSource?.color }" />
      <span>{{ basename(store.selectedSource?.path ?? '?') }}</span>
      <span class="muted">
        {{ fmt(store.selectedSegment.in) }} → {{ fmt(store.selectedSegment.out) }}
      </span>
      <button class="btn" title="toca/pausa (espaço)" @click="togglePause">
        ⏯
      </button>
      <button class="btn" title="toca só este trecho e pausa no out" @click="playSegment">
        ▶ trecho
      </button>
      <button
        class="btn"
        title="toca a timeline inteira (todas as trilhas, buracos ficam pretos)"
        @click="playTimeline"
      >
        {{ playMode === 'timeline' ? '⏸ parar' : '▶ timeline' }}
      </button>
      <span class="muted playhead">
        playhead: {{ fmt(store.playhead) }} / {{ fmt(store.timelineDuration) }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.video-wrap {
  background: #000;
  border-radius: 8px;
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

video {
  width: 100%;
  max-height: 420px;
  display: block;
}

.empty {
  padding: 40px 0;
}

.gap {
  opacity: 0.5;
}

.seg-info {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.playhead {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.playback-error {
  color: var(--danger);
  margin: 8px 0 0;
}
</style>

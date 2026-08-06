// Store Pinia com a EDL — o estado único da edição (edl-video-gpx.md).
// Salvar projeto = serializar `edl`; abrir = carregar de volta.
// Undo/redo = pilha de snapshots da EDL (arquitetura-local.md §4).
import { defineStore } from 'pinia'

// cores atribuídas às sources na ordem de chegada (rotas no mapa)
const PALETTE = ['#22c55e', '#3b82f6', '#ef4444', '#f59e0b', '#a855f7', '#14b8a6']

const EPS = 0.05
const HISTORY_MAX = 50
const clone = (o) => JSON.parse(JSON.stringify(o))

function emptyTracks() {
  return [
    { id: 'track1', z: 0, main: true, muted: false, segments: [] },
    { id: 'track2', z: 1, main: false, muted: false, segments: [] },
    { id: 'track3', z: 2, main: false, muted: false, segments: [] },
  ]
}

function emptyEdl() {
  return { version: 2, sources: [], tracks: emptyTracks() }
}

export const useEdlStore = defineStore('edl', {
  state: () => ({
    edl: emptyEdl(),
    selectedSegmentId: null,
    selectedTrackId: 'track1',
    selectionMode: 'segment', // 'segment' = um vídeo | 'track' = trilha inteira
    playhead: 0, // instante atual na timeline final (segundos)
    segSeq: 1,
    history: [], // snapshots da EDL pra undo
    future: [], // snapshots desfeitos pra redo
  }),

  getters: {
    tracks: (s) => s.edl.tracks,
    // pra renderizar: trilha de z maior em cima (compõe por cima, tipo Vegas)
    tracksTopFirst: (s) => [...s.edl.tracks].sort((a, b) => b.z - a.z),
    trackById: (s) => (id) => s.edl.tracks.find((t) => t.id === id) ?? null,
    sourceById: (s) => (id) => s.edl.sources.find((x) => x.id === id) ?? null,

    // todos os segmentos com sua trilha, em ordem z asc / start asc
    allSegments(state) {
      const out = []
      for (const track of [...state.edl.tracks].sort((a, b) => a.z - b.z)) {
        for (const seg of [...track.segments].sort((a, b) => a.start - b.start)) {
          out.push({ seg, track })
        }
      }
      return out
    },
    segmentsCount() {
      return this.allSegments.length
    },
    findSegment: (s) => (id) => {
      for (const track of s.edl.tracks) {
        const seg = track.segments.find((x) => x.id === id)
        if (seg) return { seg, track }
      }
      return null
    },
    selectedSegment() {
      return this.findSegment(this.selectedSegmentId)?.seg ?? null
    },
    selectedSegmentTrack() {
      return this.findSegment(this.selectedSegmentId)?.track ?? null
    },
    selectedSource() {
      return this.selectedSegment ? this.sourceById(this.selectedSegment.source_id) : null
    },
    timelineDuration() {
      let d = 0
      for (const { seg } of this.allSegments) d = Math.max(d, seg.start + seg.out - seg.in)
      return d
    },
    trackEnd: (s) => (trackId) => {
      const track = s.edl.tracks.find((t) => t.id === trackId)
      let end = 0
      for (const seg of track?.segments ?? []) end = Math.max(end, seg.start + seg.out - seg.in)
      return end
    },

    // REGRA CENTRAL do mapa (arquitetura-local.md §6), refinada: por source,
    // as janelas [in..alcançado] dos segmentos que ESTÃO na timeline — partes
    // cortadas do vídeo somem do GPX também. Cada janela vai até onde o
    // playhead já chegou naquele segmento; janelas sobrepostas são unidas.
    usedWindowsBySource() {
      const wins = {}
      for (const { seg } of this.allSegments) {
        const end = seg.start + (seg.out - seg.in)
        let hi = null
        // folga de 50ms: o seek do <video> para um fio antes do fim exato,
        // e sem a folga o último ponto de GPS do segmento pisca
        if (this.playhead >= end - EPS) hi = seg.out
        else if (this.playhead >= seg.start) hi = seg.in + (this.playhead - seg.start)
        if (hi === null || hi <= seg.in) continue
        ;(wins[seg.source_id] ??= []).push([seg.in, hi])
      }
      for (const id in wins) {
        const merged = []
        for (const w of wins[id].sort((a, b) => a[0] - b[0])) {
          const last = merged[merged.length - 1]
          if (last && w[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], w[1])
          else merged.push([...w])
        }
        wins[id] = merged
      }
      return wins
    },

    // segmento visível da composição no instante T: o de z mais alto que
    // cobre T (é o que o export mostraria por cima) — usado pelo preview
    activeAt() {
      return (T) => {
        let best = null
        for (const track of [...this.edl.tracks].sort((a, b) => a.z - b.z)) {
          for (const seg of track.segments) {
            if (T >= seg.start - 1e-6 && T < seg.start + (seg.out - seg.in) - 1e-6) {
              best = { seg, track } // z crescente: o último que cobre fica por cima
            }
          }
        }
        return best
      }
    },

    // que sources o mapa mostra: a do segmento selecionado, ou as da trilha
    // selecionada (na ordem de aparição) quando a trilha inteira está selecionada
    visibleSourceIds() {
      if (this.selectionMode === 'segment') {
        return this.selectedSegment ? [this.selectedSegment.source_id] : []
      }
      const track = this.trackById(this.selectedTrackId)
      const ids = []
      for (const seg of [...(track?.segments ?? [])].sort((a, b) => a.start - b.start)) {
        if (!ids.includes(seg.source_id)) ids.push(seg.source_id)
      }
      return ids
    },

    // posição do marcador no mapa: (source, t) sob o playhead.
    // Modo segmento: dentro do segmento selecionado. Modo trilha: percorre a
    // trilha selecionada (mapa de tempo do edl-video-gpx.md §3, por start).
    markerPosition() {
      const T = this.playhead
      if (this.selectionMode === 'segment') {
        const seg = this.selectedSegment
        if (!seg) return null
        const t = seg.in + Math.min(Math.max(T - seg.start, 0), seg.out - seg.in)
        return { source_id: seg.source_id, t }
      }
      const track = this.trackById(this.selectedTrackId)
      const ordered = [...(track?.segments ?? [])].sort((a, b) => a.start - b.start)
      let last = null
      for (const seg of ordered) {
        const end = seg.start + (seg.out - seg.in)
        if (T >= seg.start && T <= end) {
          return { source_id: seg.source_id, t: seg.in + (T - seg.start) }
        }
        if (end <= T) last = seg
      }
      return last ? { source_id: last.source_id, t: last.out } : null
    },
  },

  actions: {
    // ---- undo/redo -------------------------------------------------------
    snapshot() {
      this.history.push(clone(this.edl))
      if (this.history.length > HISTORY_MAX) this.history.shift()
      this.future = []
    },
    // gestos de drag tiram snapshot no início; se nada mudou, descarta
    dropSnapshotIfUnchanged() {
      const last = this.history[this.history.length - 1]
      if (last && JSON.stringify(last) === JSON.stringify(this.edl)) this.history.pop()
    },
    undo() {
      if (!this.history.length) return
      this.future.push(clone(this.edl))
      this.edl = this.history.pop()
      this._fixSelection()
    },
    redo() {
      if (!this.future.length) return
      this.history.push(clone(this.edl))
      this.edl = this.future.pop()
      this._fixSelection()
    },
    _fixSelection() {
      if (!this.findSegment(this.selectedSegmentId)) {
        this.selectedSegmentId = this.allSegments[0]?.seg.id ?? null
      }
      if (!this.trackById(this.selectedTrackId)) this.selectedTrackId = 'track1'
      this.setPlayhead(this.playhead)
    },

    // ---- seleção e playhead ---------------------------------------------
    selectSegment(id, { seek = true } = {}) {
      const found = this.findSegment(id)
      if (!found) return
      this.selectedSegmentId = id
      this.selectionMode = 'segment'
      if (seek) this.playhead = found.seg.start
    },
    selectTrack(trackId) {
      this.selectedTrackId = trackId
      this.selectionMode = 'track'
    },
    setPlayhead(t) {
      this.playhead = Math.min(Math.max(t, 0), this.timelineDuration)
    },
    // clique na régua: posiciona o playhead e seleciona o segmento sob ele
    // (trilha de cima primeiro, como na composição)
    seekTimeline(T) {
      this.setPlayhead(T)
      for (const track of this.tracksTopFirst) {
        for (const seg of track.segments) {
          if (T >= seg.start - EPS && T <= seg.start + (seg.out - seg.in) + EPS) {
            this.selectedSegmentId = seg.id
            this.selectionMode = 'segment'
            return
          }
        }
      }
    },
    nextSegment(id) {
      const found = this.findSegment(id)
      if (!found) return null
      const ordered = [...found.track.segments].sort((a, b) => a.start - b.start)
      return ordered[ordered.indexOf(found.seg) + 1] ?? null
    },

    // ---- edição ----------------------------------------------------------
    // resposta do POST /sources -> nova source (se inédita) + segmento
    // inteiro na trilha (no `start` dado, senão no fim da trilha)
    addSource(data, { trackId = 'track1', start } = {}) {
      this.snapshot()
      let src = this.sourceById(data.id)
      if (!src) {
        // guarda o PRÓPRIO objeto (reativo) do registro de sources: url,
        // thumb e gpx.points chegam de forma assíncrona e continuam vivos
        src = data
        src.color = src.color ?? PALETTE[this.edl.sources.length % PALETTE.length]
        this.edl.sources.push(src)
      }
      const seg = {
        id: `seg_${this.segSeq++}`,
        source_id: src.id,
        in: 0.0,
        out: src.duration,
        start: Math.max(0, start ?? this.trackEnd(trackId)),
      }
      this.trackById(trackId).segments.push(seg)
      this.selectSegment(seg.id)
      return seg
    },

    // drag do bloco (o gesto tira o snapshot): muda start e/ou de trilha
    moveSegment(id, { start, trackId }) {
      const found = this.findSegment(id)
      if (!found) return
      if (start !== undefined) found.seg.start = Math.max(0, start)
      if (trackId && trackId !== found.track.id) {
        const dest = this.trackById(trackId)
        if (!dest) return
        found.track.segments.splice(found.track.segments.indexOf(found.seg), 1)
        dest.segments.push(found.seg)
      }
    },

    // drag das bordas (o gesto tira o snapshot): trim de in/out
    trimSegment(id, { in: newIn, out: newOut, start }) {
      const found = this.findSegment(id)
      if (!found) return
      const seg = found.seg
      const max = this.sourceById(seg.source_id)?.duration ?? Infinity
      if (newIn !== undefined) seg.in = Math.min(Math.max(newIn, 0), seg.out - 0.1)
      if (newOut !== undefined) seg.out = Math.min(Math.max(newOut, seg.in + 0.1), max)
      if (start !== undefined) seg.start = Math.max(0, start)
    },

    // campos numéricos do painel de propriedades
    updateSegmentFields(id, { in: newIn, out: newOut, start }) {
      const found = this.findSegment(id)
      if (!found) return
      this.snapshot()
      const seg = found.seg
      const max = this.sourceById(seg.source_id)?.duration ?? Infinity
      const a = Number(newIn ?? seg.in)
      const b = Number(newOut ?? seg.out)
      const st = Number(start ?? seg.start)
      if (Number.isFinite(a) && Number.isFinite(b) && b > a && a >= 0 && b <= max) {
        seg.in = a
        seg.out = b
      }
      if (Number.isFinite(st) && st >= 0) seg.start = st
      this.dropSnapshotIfUnchanged()
    },

    // corta o segmento sob o playhead em dois (tipo Vegas)
    splitAtPlayhead() {
      const T = this.playhead
      const contains = (seg) =>
        T > seg.start + 0.1 && T < seg.start + (seg.out - seg.in) - 0.1
      let target = null
      const sel = this.findSegment(this.selectedSegmentId)
      if (sel && contains(sel.seg)) target = sel
      else {
        for (const track of this.tracksTopFirst) {
          const seg = track.segments.find(contains)
          if (seg) {
            target = { seg, track }
            break
          }
        }
      }
      if (!target) return false
      this.snapshot()
      const seg = target.seg
      const cutSrc = seg.in + (T - seg.start)
      const right = {
        id: `seg_${this.segSeq++}`,
        source_id: seg.source_id,
        in: cutSrc,
        out: seg.out,
        start: T,
      }
      seg.out = cutSrc
      target.track.segments.push(right)
      this.selectSegment(right.id, { seek: false })
      return true
    },

    // junta com o próximo da trilha: mesma source, contíguo na source e na timeline
    canJoinWithNext(id) {
      const found = this.findSegment(id)
      const next = this.nextSegment(id)
      if (!found || !next) return false
      const end = found.seg.start + (found.seg.out - found.seg.in)
      return (
        next.source_id === found.seg.source_id &&
        Math.abs(next.in - found.seg.out) < EPS &&
        Math.abs(next.start - end) < EPS
      )
    },
    joinWithNext(id) {
      if (!this.canJoinWithNext(id)) return false
      const found = this.findSegment(id)
      const next = this.nextSegment(id)
      this.snapshot()
      found.seg.out = next.out
      found.track.segments.splice(found.track.segments.indexOf(next), 1)
      if (this.selectedSegmentId === next.id) this.selectedSegmentId = found.seg.id
      return true
    },

    // excluir deixa buraco (sem ripple) — decisão do MVP
    removeSegment(id) {
      const found = this.findSegment(id)
      if (!found) return
      this.snapshot()
      found.track.segments.splice(found.track.segments.indexOf(found.seg), 1)
      this.setPlayhead(this.playhead)
      if (this.selectedSegmentId === id) {
        this.selectedSegmentId = this.allSegments[0]?.seg.id ?? null
      }
    },

    // trilha mutada: sem som no preview e fora do áudio do export
    toggleTrackMute(trackId) {
      const track = this.trackById(trackId)
      if (!track) return
      this.snapshot()
      track.muted = !track.muted
    },

    // recomeça do zero (botão "criar novo projeto" pós-export)
    newProject() {
      this.edl = emptyEdl()
      this.selectedSegmentId = null
      this.selectedTrackId = 'track1'
      this.selectionMode = 'segment'
      this.playhead = 0
      this.segSeq = 1
      this.history = []
      this.future = []
    },

  },
})

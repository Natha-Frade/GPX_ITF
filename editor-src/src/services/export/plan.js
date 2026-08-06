// plan.js — Analisa a EDL e decide o CAMINHO de exportação. É aqui que
// mora a otimização de velocidade: sempre que possível o vídeo sai por
// STREAM COPY (sem re-encode — 11GB em ~1–2 min, qualidade original);
// só cai pro re-encode (WebCodecs, GPU) quando a composição exige.
//
// Modos:
//  'copy'      — segmentos sem sobreposição, mesmas características,
//                arquivos locais → corta e junta com -c copy (ffmpeg.wasm)
//  'webcodecs' — há sobreposição de trilhas (picture over picture) ou
//                fontes de codecs/resoluções diferentes, ou o usuário quer
//                manter os espaços vazios (tela preta) → re-encode por
//                hardware no navegador
//  'remote'    — todas as fontes são do SharePoint, sem sobreposição →
//                o corte -c copy roda no SERVIDOR direto da URL do Graph
//                (só os bytes dos trechos trafegam)

const EPS = 1e-3

// todos os segmentos com metadados, ordenados por start
function orderedSegments(edl) {
  const out = []
  for (const track of [...edl.tracks].sort((a, b) => a.z - b.z)) {
    for (const seg of track.segments) {
      out.push({ ...seg, z: track.z, muted: track.muted, trackId: track.id })
    }
  }
  return out.sort((a, b) => a.start - b.start || a.z - b.z)
}

export function timelineDuration(edl) {
  let d = 0
  for (const t of edl.tracks) for (const s of t.segments) d = Math.max(d, s.start + s.out - s.in)
  return d
}

// [{a, b, segs:[segmentos ativos em z asc]}] — intervalos de composição
// constante; é a mesma regra do backend do main_Local (_visible_windows)
export function composeIntervals(edl) {
  const segs = orderedSegments(edl)
  const cuts = new Set([0])
  for (const s of segs) {
    cuts.add(s.start)
    cuts.add(s.start + (s.out - s.in))
  }
  const pts = [...cuts].sort((x, y) => x - y)
  const intervals = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (b - a < EPS) continue
    const mid = (a + b) / 2
    const active = segs.filter((s) => mid >= s.start && mid < s.start + (s.out - s.in))
    intervals.push({ a, b, segs: active.sort((x, y) => x.z - y.z) })
  }
  return intervals
}

// opts.ignoreGaps: true = junta os trechos (remove espaços vazios)
export function analyze(edl, getSource, opts = {}) {
  const segs = orderedSegments(edl).filter((s) => !s.muted || true) // mudo afeta só áudio
  const reasons = []
  if (!segs.length) return { mode: 'empty', reasons: ['timeline vazia'] }

  const intervals = composeIntervals(edl)
  const overlap = intervals.some((iv) => iv.segs.length > 1)
  const gaps = intervals.some((iv) => iv.segs.length === 0)

  const sources = new Map()
  for (const s of segs) {
    const src = getSource(s.source_id)
    if (src) sources.set(src.id, src)
  }
  const list = [...sources.values()]
  const anyRemote = list.some((s) => s.remote)
  const allRemote = list.length > 0 && list.every((s) => s.remote)

  const sameKind =
    list.length > 0 &&
    list.every(
      (s) =>
        s.probe &&
        list[0].probe &&
        s.probe.videoCodec === list[0].probe.videoCodec &&
        s.width === list[0].width &&
        s.height === list[0].height &&
        Math.abs(s.fps - list[0].fps) < 0.6 &&
        (s.probe.audioCodec ?? null) === (list[0].probe.audioCodec ?? null)
    )

  if (overlap) reasons.push('há trilhas sobrepostas (composição)')
  if (gaps && !opts.ignoreGaps) reasons.push('há espaços vazios e você pediu pra mantê-los (tela preta)')
  if (!anyRemote && !sameKind && list.length > 1)
    reasons.push('os vídeos têm codec/resolução diferentes')

  // pedaços na ordem da timeline (pro caminho copy/remote)
  const pieces = segs
    .filter((s) => intervals.some((iv) => iv.segs.length && iv.segs[iv.segs.length - 1].id === s.id))
    .map((s) => ({ sourceId: s.source_id, in: s.in, out: s.out, start: s.start, muted: s.muted }))

  if (anyRemote && !allRemote) {
    return {
      mode: 'mixed',
      reasons: ['a timeline mistura vídeos locais e do SharePoint — exporte separado ou baixe os remotos'],
    }
  }

  if (!overlap && (!gaps || opts.ignoreGaps)) {
    if (allRemote) return { mode: 'remote', reasons: ['fontes do SharePoint — corte no servidor'], pieces, gaps }
    if (sameKind || list.length === 1)
      return { mode: 'copy', reasons: ['sem sobreposição — corte sem re-encode'], pieces, gaps }
  }

  if (allRemote) {
    return {
      mode: 'mixed',
      reasons: ['composição/sobreposição com vídeos do SharePoint exige baixá-los antes'],
    }
  }

  return { mode: 'webcodecs', reasons, intervals, gaps }
}

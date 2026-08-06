// gpx.js — Constrói o GPX casado com o vídeo exportado.
//
// A regra de ouro (pra NUNCA quebrar o GPS): o GPX segue o que o vídeo
// MOSTRA. No caminho copy, o corte por stream copy alinha ao keyframe —
// o trecho real fica um fio maior que o pedido. Por isso cada pedaço é
// MEDIDO depois de cortado e os pontos são remapeados pela duração real
// (ancorados no ponto de saída, que o -t preserva). No caminho
// webcodecs/compose o corte é frame-exato e o remapeio usa as janelas
// visíveis (o GPS do segmento de z mais alto em cada instante — igual ao
// backend do main_Local).

// pieces: [{sourceId, in, out, realDur}] na ordem final.
// getSource(id).gpx.points = [{t,lat,lon,ele}] relativos à source.
export function remapCopy(pieces, getSource) {
  const out = []
  let offset = 0
  for (const p of pieces) {
    const src = getSource(p.sourceId)
    const dur = p.realDur ?? p.out - p.in
    // keyframe puxa o INÍCIO pra trás; o fim (-t a partir do -ss) fica ~exato
    const realIn = Math.max(0, p.out - dur)
    const pts = src?.gpx?.points ?? []
    for (const pt of pts) {
      if (pt.t >= realIn - 1e-6 && pt.t <= p.out + 1e-6) {
        out.push({ t: offset + (pt.t - realIn), lat: pt.lat, lon: pt.lon, ele: pt.ele })
      }
    }
    offset += dur
  }
  return dedupSort(out)
}

// intervals: composeIntervals(edl) — o topo (último de segs) manda no GPS
export function remapCompose(intervals, getSource) {
  const out = []
  for (const iv of intervals) {
    if (!iv.segs.length) continue // buraco: vídeo preto, sem GPS
    const top = iv.segs[iv.segs.length - 1]
    const src = getSource(top.source_id)
    const pts = src?.gpx?.points ?? []
    const sIn = top.in + (iv.a - top.start)
    const sOut = top.in + (iv.b - top.start)
    for (const pt of pts) {
      if (pt.t >= sIn - 1e-6 && pt.t <= sOut + 1e-6) {
        out.push({ t: iv.a + (pt.t - sIn), lat: pt.lat, lon: pt.lon, ele: pt.ele })
      }
    }
  }
  return dedupSort(out)
}

function dedupSort(points) {
  points.sort((a, b) => a.t - b.t)
  const out = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.t - p.t) < 1e-4) continue
    out.push(p)
  }
  return out
}

export function writeGpx(points, name) {
  const base = Date.now()
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const trkpts = points
    .map((p) => {
      const time = new Date(base + p.t * 1000).toISOString()
      const ele = p.ele !== undefined ? `\n      <ele>${Number(p.ele).toFixed(1)}</ele>` : ''
      return `    <trkpt lat="${p.lat.toFixed(8)}" lon="${p.lon.toFixed(8)}">${ele}\n      <time>${time}</time>\n    </trkpt>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX IMTRAFF — Editor"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(name)}</name>
    <time>${new Date(base).toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`
}

export const basename = (p) => p.split('/').pop()

export const fmt = (seconds) => `${Number(seconds).toFixed(1)}s`

// posição lat/lon no instante t (da source), interpolando entre os dois
// pontos GPS vizinhos; points precisa estar ordenado por t
export function positionAt(points, t) {
  if (!points.length) return null
  if (t <= points[0].t) return points[0]
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const a = points[i - 1]
      const b = points[i]
      const f = (t - a.t) / (b.t - a.t || 1)
      return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) }
    }
  }
  return points[points.length - 1]
}

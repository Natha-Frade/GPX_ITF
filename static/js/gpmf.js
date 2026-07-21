// ══════════════════════════════════════════════════════════════════════
//  gpmf.js — Extrator de GPS da GoPro (formato GPMF/Hero 8+)
//
//  Lê o arquivo MP4 em chunks de 2MB via FileReader.slice()
//  Nunca carrega o arquivo inteiro na memória
//  Extrai GPS5 (lat,lon,alt,spd2d,spd3d) + GPSU (timestamps UTC)
//  Gera GPX válido para download
//
//  Testado com: GoPro HERO11 Black (GX*.MP4)
//  SCAL padrão: 10.000.000 (7 casas decimais)
// ══════════════════════════════════════════════════════════════════════

const GPMF_CHUNK   = 2 * 1024 * 1024;  // 2MB por leitura
const GPMF_OVERLAP = 64 * 1024;         // 64KB de overlap entre chunks (evita cortar um KLV no meio)

// ── ENTRY POINT ──────────────────────────────────────────────────────
// Retorna Promise<{ points: [{lat,lon,alt,spd,ts}], device: string }>
async function extractGPMF(file, onProgress) {
  const size    = file.size;
  let   offset  = 0;
  let   scal    = 10000000;
  let   device  = 'GoPro';
  const points  = [];
  const timestamps = [];   // GPSU strings indexadas por bloco
  let   blockIdx = 0;

  // ── GPS9 (HERO11+) ──
  // Formato: 9 campos por amostra (32 bytes): lat, lon, alt, spd2d, spd3d,
  // dias desde 2000, segundos do dia, DOP, fix — com timestamp POR AMOSTRA.
  // Escalas padrão da GoPro (atualizadas se um SCAL de 9 valores aparecer).
  const points9 = [];
  let   scal9   = [10000000, 10000000, 1000, 1000, 100, 1, 1000, 100, 1];
  const seen9   = new Set();  // dedup entre chunks (overlap relê trechos)

  onProgress && onProgress(0, 'Iniciando leitura do arquivo...');

  while (offset < size) {
    const end    = Math.min(offset + GPMF_CHUNK, size);
    const slice  = file.slice(offset, end);
    const buffer = await readSliceAsArrayBuffer(slice);
    const bytes  = new Uint8Array(buffer);

    // Procura DVNM (device name) — só precisa uma vez
    if (device === 'GoPro') {
      const di = findBytes(bytes, [0x44,0x56,0x4E,0x4D]); // DVNM
      if (di !== -1) {
        const klv = readKLV(bytes, di);
        if (klv) device = new TextDecoder().decode(klv.payload).replace(/\0/g,'').trim();
      }
    }

    // Procura SCAL antes dos GPS5
    const si = findBytes(bytes, [0x53,0x43,0x41,0x4C]); // SCAL
    if (si !== -1) {
      const klv = readKLV(bytes, si);
      if (klv) {
        if (klv.type === 'S' && klv.size === 2) {
          scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getUint16(0);
        } else if (klv.type === 'l' && klv.size === 4) {
          scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getInt32(0);
        }
        if (scal === 0) scal = 10000000;
      }
    }

    // Procura SCAL de 9 valores (escalas do GPS9) em qualquer posição do chunk
    let scalPos = 0;
    while (true) {
      const sj = findBytes(bytes, [0x53,0x43,0x41,0x4C], scalPos);
      if (sj === -1) break;
      const klv = readKLV(bytes, sj);
      if (klv && klv.type === 'l' && klv.size === 4 && klv.repeat === 9) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
        const arr = [];
        for (let k = 0; k < 9; k++) arr.push(dv.getInt32(k * 4) || 1);
        scal9 = arr;
        break;  // as escalas não mudam dentro do arquivo
      }
      scalPos = sj + 4;
    }

    // Procura todos os GPSU timestamps neste chunk
    let gpsuPos = 0;
    while (true) {
      const gi = findBytes(bytes, [0x47,0x50,0x53,0x55], gpsuPos); // GPSU
      if (gi === -1) break;
      const klv = readKLV(bytes, gi);
      if (klv && klv.payload.length >= 16) {
        const ts = new TextDecoder().decode(klv.payload.slice(0,16));
        timestamps.push(ts);
      }
      gpsuPos = gi + 4;
    }

    // Procura todos os GPS5 neste chunk
    let gps5Pos = 0;
    while (true) {
      const gi = findBytes(bytes, [0x47,0x50,0x53,0x35], gps5Pos); // GPS5
      if (gi === -1) break;
      const klv = readKLV(bytes, gi);
      if (klv && klv.size === 20 && klv.repeat > 0) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
        for (let i = 0; i < klv.repeat; i++) {
          const base = i * 20;
          if (base + 20 > klv.payload.length) break;
          const lat  = dv.getInt32(base +  0) / scal;
          const lon  = dv.getInt32(base +  4) / scal;
          const alt  = dv.getInt32(base +  8) / 1000;
          const spd  = dv.getInt32(base + 12) / 1000;
          // Filtra pontos inválidos (0,0) ou fora do Brasil/mundo
          if (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001) {
            points.push({ lat, lon, alt, spd, blockIdx });
          }
        }
        blockIdx++;
      }
      gps5Pos = gi + 4;
    }

    // Procura todos os GPS9 neste chunk (HERO11+; timestamp por amostra)
    let gps9Pos = 0;
    while (true) {
      const gi = findBytes(bytes, [0x47,0x50,0x53,0x39], gps9Pos); // GPS9
      if (gi === -1) break;
      const klv = readKLV(bytes, gi);
      if (klv && klv.size === 32 && klv.repeat > 0) {
        const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
        for (let i = 0; i < klv.repeat; i++) {
          const base = i * 32;
          if (base + 32 > klv.payload.length) break;
          const lat  = dv.getInt32(base +  0) / scal9[0];
          const lon  = dv.getInt32(base +  4) / scal9[1];
          const alt  = dv.getInt32(base +  8) / scal9[2];
          const spd  = dv.getInt32(base + 12) / scal9[3];
          const days = dv.getInt32(base + 20) / scal9[5];
          const secs = dv.getInt32(base + 24) / scal9[6];
          const fix  = dv.getUint16(base + 30) / scal9[8];
          if (fix === 0) continue;                      // sem trava de GPS
          if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) continue;
          const ms = Date.UTC(2000, 0, 1) + days * 86400000 + secs * 1000;
          const key = Math.round(ms);                   // dedup do overlap
          if (seen9.has(key)) continue;
          seen9.add(key);
          points9.push({ lat, lon, alt, spd, ts: new Date(ms).toISOString() });
        }
      }
      gps9Pos = gi + 4;
    }

    onProgress && onProgress(Math.round((end / size) * 100), `${Math.max(points.length, points9.length)} pontos GPS encontrados...`);
    if (end >= size) break;         // fim do arquivo (evita loop infinito no último chunk)
    offset = end - GPMF_OVERLAP;    // overlap para não perder KLVs na junção
  }

  // ── ESCOLHA DO STREAM ──
  // GPS9 (HERO11+) tem timestamp por amostra — é o dado mais confiável.
  // GPS5 (câmeras antigas) usa GPSU distribuído. Em câmeras novas o GPS5
  // costuma vir vazio, por isso a preferência pelo GPS9.
  if (points9.length) {
    points9.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    onProgress && onProgress(100, `Concluído — ${points9.length} pontos GPS (GPS9)`);
    return { points: points9, device };
  }

  // Adiciona timestamps aos pontos (18Hz GPS, GPSU a ~1Hz)
  // Distribui timestamps proporcionalmente
  const tsPerBlock = points.length > 0 && timestamps.length > 0
    ? Math.ceil(points.length / Math.max(timestamps.length, 1))
    : 18;

  points.forEach((pt, i) => {
    const tsIdx = Math.min(Math.floor(i / tsPerBlock), timestamps.length - 1);
    if (tsIdx >= 0 && timestamps[tsIdx]) {
      pt.ts = parseGPSU(timestamps[tsIdx], i % tsPerBlock, tsPerBlock);
    }
  });

  onProgress && onProgress(100, `Concluído — ${points.length} pontos GPS`);
  return { points, device };
}

// ── PARSE TIMESTAMP GPSU ─────────────────────────────────────────────
// Formato: "YYMMDDHHMMSS.mmm"
// Ex: "260321175214.200" = 21/03/2026 17:52:14.200 UTC
function parseGPSU(ts, sampleOffset, samplesPerSec) {
  try {
    const yr  = 2000 + parseInt(ts.slice(0,2));
    const mo  = parseInt(ts.slice(2,4));
    const dy  = parseInt(ts.slice(4,6));
    const hr  = parseInt(ts.slice(6,8));
    const mn  = parseInt(ts.slice(8,10));
    const sc  = parseInt(ts.slice(10,12));
    const ms  = parseFloat('0.' + (ts.slice(13) || '0')) * 1000;
    const base = Date.UTC(yr, mo-1, dy, hr, mn, sc, ms);
    // Adiciona offset sub-segundo para pontos dentro do bloco
    const fracMs = (sampleOffset / samplesPerSec) * 1000;
    const d = new Date(base + fracMs);
    return d.toISOString().replace('Z','') + 'Z';
  } catch {
    return new Date().toISOString();
  }
}

// ── GERA GPX ─────────────────────────────────────────────────────────
function buildGPXFromPoints(points, trackName) {
  const trkpts = points.map(p => {
    const time = p.ts ? `\n      <time>${p.ts}</time>` : '';
    const ele  = p.alt !== undefined ? `\n      <ele>${p.alt.toFixed(1)}</ele>` : '';
    return `    <trkpt lat="${p.lat.toFixed(8)}" lon="${p.lon.toFixed(8)}">${ele}${time}\n    </trkpt>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX IMTRAFF — GoPro GPMF Extractor"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>${escXml(trackName)}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${escXml(trackName)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

// ── HELPERS ───────────────────────────────────────────────────────────
function readSliceAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

function findBytes(arr, pattern, start = 0) {
  const p0 = pattern[0];
  for (let i = start; i <= arr.length - pattern.length; i++) {
    if (arr[i] !== p0) continue;
    let ok = true;
    for (let j = 1; j < pattern.length; j++) {
      if (arr[i+j] !== pattern[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// Lê um KLV GPMF: key(4) + type(1) + size(1) + repeat(2) + data
function readKLV(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const key    = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
  const type   = String.fromCharCode(bytes[offset+4]);
  const size   = bytes[offset+5];
  const repeat = (bytes[offset+6] << 8) | bytes[offset+7];
  const length = size * repeat;
  if (offset + 8 + length > bytes.length) return null;
  const payload = bytes.slice(offset+8, offset+8+length);
  return { key, type, size, repeat, payload };
}

function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

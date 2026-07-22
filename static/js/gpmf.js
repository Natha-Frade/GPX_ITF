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
  onProgress && onProgress(0, 'Localizando dados de GPS no vídeo...');
  try {
    const loc = await _localizarGPMF(file);
    if (loc && loc.chunks.length) {
      return await _extractGPMFFromChunks(file, loc, onProgress);
    }
  } catch (e) {
    console.warn('[gpmf] parse de atomos falhou, usando varredura:', e && e.message);
  }
  return _extractGPMFScan(file, onProgress);
}

async function _extractGPMFFromChunks(file, loc, onProgress) {
  const ctx = _novoCtxGPMF();
  let lido = 0;
  for (let i = 0; i < loc.chunks.length; i++) {
    const ch = loc.chunks[i];
    const buf = await readSliceAsArrayBuffer(file.slice(ch.offset, ch.offset + ch.size));
    _parseGPMFBytes(new Uint8Array(buf), ctx);
    lido += ch.size;
    onProgress && onProgress(
      Math.min(99, Math.round((lido / loc.total) * 100)),
      `${Math.max(ctx.points.length, ctx.points9.length)} pontos GPS encontrados...`);
  }
  return _finalizarGPMF(ctx, onProgress);
}

async function _extractGPMFScan(file, onProgress) {
  const size = file.size;
  let offset = 0;
  const ctx  = _novoCtxGPMF();
  onProgress && onProgress(0, 'Lendo o arquivo (modo completo)...');
  while (offset < size) {
    const end = Math.min(offset + GPMF_CHUNK, size);
    const buf = await readSliceAsArrayBuffer(file.slice(offset, end));
    _parseGPMFBytes(new Uint8Array(buf), ctx);
    onProgress && onProgress(Math.round((end / size) * 100),
      `${Math.max(ctx.points.length, ctx.points9.length)} pontos GPS encontrados...`);
    if (end >= size) break;
    offset = end - GPMF_OVERLAP;
  }
  return _finalizarGPMF(ctx, onProgress);
}

function _novoCtxGPMF() {
  return {
    scal: 10000000, device: 'GoPro',
    points: [], timestamps: [], blockIdx: 0,
    points9: [], scal9: [10000000, 10000000, 1000, 1000, 100, 1, 1000, 100, 1],
    seen9: new Set(),
  };
}

function _parseGPMFBytes(bytes, ctx) {
  const di = findBytes(bytes, [0x44,0x56,0x4E,0x4D]);
  if (di !== -1) {
    const klv = readKLV(bytes, di);
    if (klv && klv.payload.length) {
      const nome = new TextDecoder().decode(klv.payload).replace(/\0+$/,'').trim();
      if (nome) ctx.device = nome;
    }
  }
  const si = findBytes(bytes, [0x53,0x43,0x41,0x4C]);
  if (si !== -1) {
    const klv = readKLV(bytes, si);
    if (klv && klv.payload.length >= 2) {
      if (klv.size === 2)      ctx.scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getUint16(0);
      else if (klv.size === 4) ctx.scal = new DataView(klv.payload.buffer, klv.payload.byteOffset).getInt32(0);
    }
  }
  let scalPos = 0;
  while (true) {
    const sj = findBytes(bytes, [0x53,0x43,0x41,0x4C], scalPos);
    if (sj === -1) break;
    const klv = readKLV(bytes, sj);
    if (klv && klv.repeat === 9 && klv.size === 4) {
      const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
      const arr = [];
      for (let k = 0; k < 9; k++) arr.push(dv.getInt32(k * 4) || 1);
      ctx.scal9 = arr;
    }
    scalPos = sj + 4;
  }
  let gpsuPos = 0;
  while (true) {
    const gi = findBytes(bytes, [0x47,0x50,0x53,0x55], gpsuPos);
    if (gi === -1) break;
    const klv = readKLV(bytes, gi);
    if (klv && klv.payload.length >= 12) {
      ctx.timestamps.push(new TextDecoder().decode(klv.payload.slice(0,16)));
    }
    gpsuPos = gi + 4;
  }
  let gps5Pos = 0;
  while (true) {
    const gi = findBytes(bytes, [0x47,0x50,0x53,0x35], gps5Pos);
    if (gi === -1) break;
    const klv = readKLV(bytes, gi);
    if (klv && klv.size === 20 && klv.repeat > 0) {
      const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
      for (let i = 0; i < klv.repeat; i++) {
        const base = i * 20;
        if (base + 20 > klv.payload.length) break;
        const lat = dv.getInt32(base + 0) / ctx.scal;
        const lon = dv.getInt32(base + 4) / ctx.scal;
        const alt = dv.getInt32(base + 8) / 1000;
        const spd = dv.getInt32(base + 12) / 1000;
        if (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001) {
          ctx.points.push({ lat, lon, alt, spd, blockIdx: ctx.blockIdx });
        }
      }
      ctx.blockIdx++;
    }
    gps5Pos = gi + 4;
  }
  let gps9Pos = 0;
  while (true) {
    const gi = findBytes(bytes, [0x47,0x50,0x53,0x39], gps9Pos);
    if (gi === -1) break;
    const klv = readKLV(bytes, gi);
    if (klv && klv.size === 32 && klv.repeat > 0) {
      const dv = new DataView(klv.payload.buffer, klv.payload.byteOffset);
      for (let i = 0; i < klv.repeat; i++) {
        const base = i * 32;
        if (base + 32 > klv.payload.length) break;
        const lat  = dv.getInt32(base + 0) / ctx.scal9[0];
        const lon  = dv.getInt32(base + 4) / ctx.scal9[1];
        const alt  = dv.getInt32(base + 8) / ctx.scal9[2];
        const spd  = dv.getInt32(base + 12) / ctx.scal9[3];
        const days = dv.getInt32(base + 20) / ctx.scal9[5];
        const secs = dv.getInt32(base + 24) / ctx.scal9[6];
        const fix  = dv.getUint16(base + 30) / ctx.scal9[8];
        if (fix === 0) continue;
        if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) continue;
        const ms  = Date.UTC(2000, 0, 1) + days * 86400000 + secs * 1000;
        const key = Math.round(ms);
        if (ctx.seen9.has(key)) continue;
        ctx.seen9.add(key);
        ctx.points9.push({ lat, lon, alt, spd, ts: new Date(ms).toISOString() });
      }
    }
    gps9Pos = gi + 4;
  }
}

function _finalizarGPMF(ctx, onProgress) {
  if (ctx.points9.length) {
    ctx.points9.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    onProgress && onProgress(100, `Concluido — ${ctx.points9.length} pontos GPS (GPS9)`);
    return { points: ctx.points9, device: ctx.device };
  }
  const tsPerBlock = ctx.points.length > 0 && ctx.timestamps.length > 0
    ? Math.ceil(ctx.points.length / Math.max(ctx.timestamps.length, 1))
    : 18;
  ctx.points.forEach((pt, i) => {
    const tsIdx = Math.min(Math.floor(i / tsPerBlock), ctx.timestamps.length - 1);
    if (tsIdx >= 0 && ctx.timestamps[tsIdx]) {
      pt.ts = parseGPSU(ctx.timestamps[tsIdx], i % tsPerBlock, tsPerBlock);
    }
  });
  onProgress && onProgress(100, `Concluido — ${ctx.points.length} pontos GPS`);
  return { points: ctx.points, device: ctx.device };
}

async function _localizarGPMF(file) {
  const tops = await _lerAtomosTopo(file);
  const moov = tops.find(a => a.type === 'moov');
  if (!moov) return null;
  const moovBuf = new Uint8Array(await readSliceAsArrayBuffer(
    file.slice(moov.start, moov.start + moov.size)));
  const traks = _acharSubAtomos(moovBuf, 8, moovBuf.length, 'trak');
  for (const trak of traks) {
    const hdlr = _primeiroAtomoRecursivo(moovBuf, trak.start, trak.end, 'hdlr');
    let htype = '';
    if (hdlr) htype = _lerString(moovBuf, hdlr.dataStart + 8, 4);
    const stbl = _primeiroAtomoRecursivo(moovBuf, trak.start, trak.end, 'stbl');
    if (!stbl) continue;
    const stsd = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'stsd');
    const ehGpmd = (stsd && _contemBytes(moovBuf, stsd.dataStart, stsd.end, 'gpmd')) ||
                   _contemBytes(moovBuf, stbl.start, stbl.end, 'gpmd') ||
                   htype === 'meta';
    if (!ehGpmd) continue;
    const stsz = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'stsz');
    const stco = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'stco');
    const co64 = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'co64');
    const stsc = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'stsc');
    if (!stsz || (!stco && !co64) || !stsc) continue;
    const sizes   = _lerStsz(moovBuf, stsz);
    const offsets = stco ? _lerStco(moovBuf, stco, false) : _lerStco(moovBuf, co64, true);
    const s2c     = _lerStsc(moovBuf, stsc);
    const chunks  = _montarSamples(sizes, offsets, s2c);
    if (chunks.length) {
      const merged = _mesclarContiguos(chunks);
      const total = merged.reduce((s, c) => s + c.size, 0);
      return { chunks: merged, total };
    }
  }
  return null;
}

async function _lerAtomosTopo(file) {
  const out = [];
  let pos = 0;
  const size = file.size;
  let guard = 0;
  while (pos + 8 <= size && guard++ < 10000) {
    const head = new Uint8Array(await readSliceAsArrayBuffer(file.slice(pos, pos + 16)));
    const dv = new DataView(head.buffer);
    let boxSize = dv.getUint32(0);
    const type = _lerString(head, 4, 4);
    let headerLen = 8;
    if (boxSize === 1) { boxSize = Number(dv.getBigUint64(8)); headerLen = 16; }
    else if (boxSize === 0) { boxSize = size - pos; }
    if (boxSize < headerLen) break;
    out.push({ type, start: pos, size: boxSize, dataStart: pos + headerLen });
    pos += boxSize;
  }
  return out;
}

function _acharSubAtomos(buf, start, end, type) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const res = [];
  let pos = start;
  while (pos + 8 <= end) {
    const boxSize = dv.getUint32(pos);
    const t = _lerString(buf, pos + 4, 4);
    if (boxSize < 8) break;
    if (t === type) res.push({ start: pos, end: pos + boxSize, dataStart: pos + 8 });
    pos += boxSize;
  }
  return res;
}
function _primeiroAtomo(buf, start, end, type) {
  const a = _acharSubAtomos(buf, start + 8, end, type);
  return a.length ? a[0] : null;
}
function _primeiroAtomoRecursivo(buf, start, end, type) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  let pos = start + 8;
  while (pos + 8 <= end) {
    const boxSize = dv.getUint32(pos);
    if (boxSize < 8) break;
    const t = _lerString(buf, pos + 4, 4);
    if (t === type) return { start: pos, end: pos + boxSize, dataStart: pos + 8 };
    if (['mdia','minf','stbl','trak','gmhd','dinf'].includes(t)) {
      const found = _primeiroAtomoRecursivo(buf, pos, pos + boxSize, type);
      if (found) return found;
    }
    pos += boxSize;
  }
  return null;
}
function _contemBytes(buf, start, end, str) {
  const pat = [...str].map(c => c.charCodeAt(0));
  return findBytes(buf.subarray(start, end), pat) !== -1;
}
function _lerString(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}
function _lerStsz(buf, box) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const base = box.dataStart;
  const sampleSize = dv.getUint32(base + 4);
  const count      = dv.getUint32(base + 8);
  const sizes = [];
  if (sampleSize !== 0) { for (let i = 0; i < count; i++) sizes.push(sampleSize); }
  else { for (let i = 0; i < count; i++) sizes.push(dv.getUint32(base + 12 + i * 4)); }
  return sizes;
}
function _lerStco(buf, box, is64) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const base = box.dataStart;
  const count = dv.getUint32(base + 4);
  const offs = [];
  for (let i = 0; i < count; i++) {
    offs.push(is64 ? Number(dv.getBigUint64(base + 8 + i * 8))
                   : dv.getUint32(base + 8 + i * 4));
  }
  return offs;
}
function _lerStsc(buf, box) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const base = box.dataStart;
  const count = dv.getUint32(base + 4);
  const runs = [];
  for (let i = 0; i < count; i++) {
    runs.push({
      first: dv.getUint32(base + 8 + i * 12),
      spc:   dv.getUint32(base + 8 + i * 12 + 4),
    });
  }
  return runs;
}
function _montarSamples(sizes, chunkOffsets, stsc) {
  const samples = [];
  let sampleIdx = 0;
  for (let c = 0; c < chunkOffsets.length; c++) {
    let spc = 1;
    for (let r = stsc.length - 1; r >= 0; r--) {
      if ((c + 1) >= stsc[r].first) { spc = stsc[r].spc; break; }
    }
    let off = chunkOffsets[c];
    for (let s = 0; s < spc && sampleIdx < sizes.length; s++) {
      const sz = sizes[sampleIdx++];
      samples.push({ offset: off, size: sz });
      off += sz;
    }
  }
  return samples;
}
function _mesclarContiguos(samples) {
  if (!samples.length) return [];
  samples.sort((a, b) => a.offset - b.offset);
  const out = [{ offset: samples[0].offset, size: samples[0].size }];
  for (let i = 1; i < samples.length; i++) {
    const last = out[out.length - 1];
    if (samples[i].offset === last.offset + last.size) {
      last.size += samples[i].size;
    } else {
      out.push({ offset: samples[i].offset, size: samples[i].size });
    }
  }
  return out;
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

// ── DETECTA O CODEC DE VÍDEO lendo os átomos MP4 (rápido, sem ffmpeg) ─
// Retorna 'avc1' (H.264), 'hvc1'/'hev1' (HEVC/H.265), ou '' se não achar.
async function detectarCodecVideo(file) {
  try {
    const tops = await _lerAtomosTopo(file);
    const moov = tops.find(a => a.type === 'moov');
    if (!moov) return '';
    const moovBuf = new Uint8Array(await readSliceAsArrayBuffer(
      file.slice(moov.start, moov.start + moov.size)));
    const traks = _acharSubAtomos(moovBuf, 8, moovBuf.length, 'trak');
    for (const trak of traks) {
      const stbl = _primeiroAtomoRecursivo(moovBuf, trak.start, trak.end, 'stbl');
      if (!stbl) continue;
      const stsd = _primeiroAtomo(moovBuf, stbl.start, stbl.end, 'stsd');
      if (!stsd) continue;
      // procura os fourccs de codec de vídeo dentro do stsd
      for (const cc of ['avc1', 'hvc1', 'hev1', 'hev2', 'dvhe', 'vp09', 'av01']) {
        if (_contemBytes(moovBuf, stsd.dataStart, stsd.end, cc)) return cc;
      }
    }
  } catch (e) { /* silencioso */ }
  return '';
}

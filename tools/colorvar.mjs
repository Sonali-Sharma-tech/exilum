#!/usr/bin/env node
/**
 * Unique-colour count — the DEFECT 2 instrument.
 *
 * Method (matches the parent audit exactly, stated for reproducibility):
 *   - 5-bit-per-channel quantisation: each of R,G,B >> 3  (32 levels/channel).
 *   - Sample every 7th pixel in raster order (i += 7 over the flat pixel list).
 *   - Whole frame (HUD included) — the parent measured whole-frame.
 *   - Count of DISTINCT quantised (r,g,b) triples.
 *
 * Also reports, as secondary lenses:
 *   - scene-window variant (y 12-72%, x 8-92%) so we can see the renderer-affectable region.
 *   - a saturation histogram of the sampled palette, to catch "colour added as saturation".
 *
 * Pure Node, hand-rolled PNG decode (zlib built-in) — same decoder as analyze.mjs.
 * Usage: node tools/colorvar.mjs <file.png> [file2.png ...] [--json] [--bits N] [--stride N]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`colorType ${colorType} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgb = new Uint8Array(width * height * 3);
  const cur = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: val = rawByte;
      }
      cur[x] = val & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels, di = (y * width + x) * 3;
      rgb[di] = cur[si]; rgb[di + 1] = channels >= 3 ? cur[si + 1] : cur[si]; rgb[di + 2] = channels >= 3 ? cur[si + 2] : cur[si];
    }
    const t = prev; prev = cur.slice(); void t;
  }
  return { width, height, rgb };
}

function rgbToHsvS(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

function count(png, { bits = 3, stride = 7 } = {}) {
  const { width: W, height: H, rgb } = png;
  const N = W * H;
  const whole = new Set();
  const scene = new Set();
  const sy0 = Math.floor(H * 0.12), sy1 = Math.floor(H * 0.72);
  const sx0 = Math.floor(W * 0.08), sx1 = Math.floor(W * 0.92);
  const sh = bits;
  // saturation buckets of the sampled palette
  let sat0 = 0, satTot = 0;
  for (let i = 0; i < N; i += stride) {
    const r = rgb[i * 3] >> sh, g = rgb[i * 3 + 1] >> sh, b = rgb[i * 3 + 2] >> sh;
    const key = (r << 10) | (g << 5) | b;
    whole.add(key);
    const y = (i / W) | 0, x = i % W;
    if (y >= sy0 && y < sy1 && x >= sx0 && x < sx1) scene.add(key);
    const s = rgbToHsvS(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    satTot++; if (s < 0.05) sat0++;
  }
  return {
    dims: `${W}x${H}`,
    uniqueWhole: whole.size,
    uniqueScene: scene.size,
    sampled: Math.ceil(N / stride),
    neutralSampledPct: +(100 * sat0 / satTot).toFixed(1),
    bits, stride,
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter(a => !a.startsWith('--'));
let bits = 3, stride = 7;
const bi = args.indexOf('--bits'); if (bi >= 0) bits = +args[bi + 1];
const si = args.indexOf('--stride'); if (si >= 0) stride = +args[si + 1];
if (!files.length) { console.error('usage: colorvar.mjs <file.png> [...]'); process.exit(2); }
const out = [];
for (const f of files) {
  try {
    const png = decodePNG(readFileSync(f));
    const m = count(png, { bits, stride });
    out.push({ file: f, ...m });
  } catch (e) { out.push({ file: f, error: e.message }); }
}
if (json) console.log(JSON.stringify(out, null, 2));
else for (const o of out) {
  if (o.error) { console.log(`${o.file}: ERROR ${o.error}`); continue; }
  console.log(`${o.file}  ${o.dims}  uniqueWhole=${o.uniqueWhole}  uniqueScene=${o.uniqueScene}  neutral%=${o.neutralSampledPct}  (bits=${o.bits} stride=${o.stride} sampled=${o.sampled})`);
}

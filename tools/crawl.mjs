#!/usr/bin/env node
/**
 * Crawl / staircase-aliasing proxy on a crop window of thin high-contrast geometry.
 *
 * WHY A NEW INSTRUMENT. `hardEdgeRatio` (analyze.mjs) counts adjacent pairs with a
 * big luma jump — it measures whether an edge EXISTS, not whether it STAIRCASES.
 * It stayed 0.0019-0.0026 (guard 0.0055) through the entire R12 SMAA sweep INCLUDING
 * AA fully off, while thin geometry visibly crawled. A guard that never moves when
 * the defect is introduced is worse than no guard. This measures the crawl directly.
 *
 * MECHANISM. Aliasing (crawl) is a FAILURE of edge reconstruction: a high-contrast
 * boundary crosses from dark to light in ONE pixel with no intermediate value (a
 * bimodal, width-1 transition), and on a near-diagonal that width-1 crossing walks
 * as a visible staircase. Antialiasing spreads the same crossing over 2-3px of grey
 * intermediates. So the crawl signal is the SHARPNESS/BIMODALITY of high-contrast
 * transitions, reported as:
 *   hard1Frac = (single-pixel full-contrast crossings) / (all high-contrast crossings)
 *               aliased -> ~1.0, antialiased -> low. This is R12's "sharp <=2px" idea
 *               inverted to isolate the width-1 (crawl-prone) tail.
 *   hardDens  = 1000 * width-1 crossings / cropPx   — absolute density per 1000 px.
 * BOTH rise as edges harden. NOTE: sharper edges are what we WANT for localContrast,
 * so a rise here on the WHOLE frame is good; a rise on an isolated THIN silhouette is
 * the crawl risk. The number cannot tell those apart — that is why the CROP is the
 * acceptance test (MEASUREMENT_NOTES: "the crop has to outrank the number"). Lead
 * with the A/B DELTA at a FIXED crop of thin geometry; treat this as corroboration.
 *
 * Self-validates with --selftest: synthesises a width-1 staircase vs a 3px-ramp
 * antialiased diagonal and asserts hard1Frac is far higher on the staircase.
 *
 * Usage: node tools/crawl.mjs <file.png> <x0> <y0> <x1> <y1> [--t 0.14]
 *        node tools/crawl.mjs --selftest
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, W = 0, H = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit supported, got ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * channels;
  const rgb = new Uint8Array(W * H * 3);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let rp = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < H; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawB = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawB; break; case 1: v = rawB + a; break; case 2: v = rawB + b; break;
        case 3: v = rawB + ((a + b) >> 1); break; case 4: v = rawB + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3, s = x * channels;
      if (channels === 1) { rgb[o] = rgb[o + 1] = rgb[o + 2] = cur[s]; }
      else { rgb[o] = cur[s]; rgb[o + 1] = cur[s + 1]; rgb[o + 2] = cur[s + 2]; }
    }
    prev.set(cur);
  }
  return { width: W, height: H, rgb };
}

const srgbToLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);

/** Crawl metric over a luma field L (W-wide) inside [x0,y0,x1,y1].
 *  T = high-contrast gap threshold. A horizontal gap i->i+1 with |dL|>T is a
 *  "high-contrast crossing"; it is WIDTH-1 (hard/aliased/crawl-prone) when that
 *  single gap DOMINATES its neighbours — max(|L[i]-L[i-1]|,|L[i+1]-L[i+2]|) < 0.5*d
 *  — i.e. the whole step happens in one pixel with no ramp either side. An AA edge
 *  spreads the step over 2-3 comparable gaps, so no single gap dominates. */
function crawl(L, W, x0, y0, x1, y1, T) {
  let hard = 0, cross = 0, cropPx = 0;
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = x0 + 1; x < x1 - 2; x++) {
      const i = y * W + x;
      cropPx++;
      const d = Math.abs(L[i + 1] - L[i]);
      if (d <= T) continue;
      cross++;
      const nbr = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(L[i + 2] - L[i + 1]));
      if (nbr < 0.5 * d) hard++;   // single gap dominates -> width-1 -> crawl-prone
    }
  }
  return {
    hard1Frac: +(hard / Math.max(cross, 1)).toFixed(4),
    hardDens: +(1000 * hard / Math.max(cropPx, 1)).toFixed(4),
    crossDens: +(1000 * cross / Math.max(cropPx, 1)).toFixed(4),
    hard, cross, cropPx,
  };
}

function synthDiagonal(W, H, antialias) {
  // shallow near-diagonal bright(left)/dark(right) edge (slope 1/4) on a dark field:
  // the most aliasing-prone orientation. lo=0.02 lin, hi=0.60 lin.
  const L = new Float64Array(W * H);
  const lo = 0.02, hi = 0.60;
  for (let y = 0; y < H; y++) {
    const edgeX = 8 + y * 0.25;         // fractional edge position per row
    for (let x = 0; x < W; x++) {
      let t;
      if (!antialias) {
        t = x < Math.round(edgeX) ? 1 : 0;          // nearest-neighbour -> width-1 staircase
      } else {
        t = Math.max(0, Math.min(1, 0.5 - (x - edgeX) / 3));   // 3px ramp -> antialiased
      }
      L[y * W + x] = lo + (hi - lo) * t;
    }
  }
  return L;
}

if (process.argv.includes('--selftest')) {
  const W = 64, H = 64, T = 0.14;
  const alias = crawl(synthDiagonal(W, H, false), W, 0, 0, W, H, T);
  const smooth = crawl(synthDiagonal(W, H, true), W, 0, 0, W, H, T);
  console.log(JSON.stringify({ selftest: true, T,
    aliased: alias, antialiased: smooth,
    fracRatio: +(alias.hard1Frac / Math.max(smooth.hard1Frac, 1e-9)).toFixed(2),
    PASS: alias.hard1Frac > 0.8 && smooth.hard1Frac < 0.2 }, null, 2));
  process.exit(0);
}

const file = process.argv[2];
let [x0, y0, x1, y1] = process.argv.slice(3, 7).map(Number);
const ti = process.argv.indexOf('--t');
const T = ti >= 0 ? Number(process.argv[ti + 1]) : 0.14;
if (!file || ![x0, y0, x1, y1].every(Number.isFinite)) {
  console.error('usage: crawl.mjs <file.png> <x0> <y0> <x1> <y1> [--t 0.14]  |  crawl.mjs --selftest');
  process.exit(2);
}
const png = decodePNG(readFileSync(file));
const { width: W, height: H, rgb } = png;
x0 = Math.max(1, x0); y0 = Math.max(1, y0); x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
const L = new Float64Array(W * H);
for (let i = 0; i < W * H; i++) L[i] = lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
const r = crawl(L, W, x0, y0, x1, y1, T);
console.log(JSON.stringify({ file, dims: `${W}x${H}`, window: [x0, y0, x1, y1], T, ...r }, null, 2));

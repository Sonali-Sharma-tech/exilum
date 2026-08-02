#!/usr/bin/env node
/**
 * Floor diagonal / anti-diagonal gradient-energy ratio on a fixed window.
 *
 * The floor-striping defect is directional anisotropy: our floors read as
 * regular parallel diagonal "corduroy". Measured on the luminance field, the
 * gradient energy along the main diagonal (L[x,y] vs L[x+1,y+1]) divided by the
 * energy along the anti-diagonal (L[x,y] vs L[x+1,y-1]) is ~0.77-0.86 for us
 * (ANTI-diagonal biased) against ~1.06 for poe2-07 (near isotropic).
 *
 * Window is HUD-excluded and passed explicitly so before/after are directly
 * comparable. Default = nave-lit floor window [900,330,1240,500] on 1600x900.
 *
 * Usage: node tools/diagratio.mjs <file.png> [x0 y0 x1 y1]
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
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
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
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < H; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawB = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawB; break;
        case 1: v = rawB + a; break;
        case 2: v = rawB + b; break;
        case 3: v = rawB + ((a + b) >> 1); break;
        case 4: v = rawB + paeth(a, b, c); break;
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

const file = process.argv[2];
if (!file) { console.error('usage: diagratio.mjs <file.png> [x0 y0 x1 y1]'); process.exit(2); }
const png = decodePNG(readFileSync(file));
const { width: W, height: H, rgb } = png;
let [x0, y0, x1, y1] = process.argv.slice(3).map(Number);
if (![x0, y0, x1, y1].every(Number.isFinite)) { x0 = 900; y0 = 330; x1 = 1240; y1 = 500; }
// clamp
x0 = Math.max(1, x0); y0 = Math.max(1, y0); x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);

const L = new Float64Array(W * H);
for (let i = 0; i < W * H; i++) L[i] = lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);

let diag = 0, anti = 0, n = 0;
// horizontal & vertical for reference (axis energy)
let horiz = 0, vert = 0;
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    diag += Math.abs(L[i] - L[(y + 1) * W + (x + 1)]);   // main diagonal (TL->BR)
    anti += Math.abs(L[i] - L[(y - 1) * W + (x + 1)]);   // anti-diagonal (BL->TR)
    horiz += Math.abs(L[i] - L[i + 1]);
    vert += Math.abs(L[i] - L[(y + 1) * W + x]);
    n++;
  }
}
const ratio = diag / Math.max(anti, 1e-12);
console.log(JSON.stringify({
  file, window: [x0, y0, x1, y1], samples: n,
  diagEnergyAbs: +(diag / n).toFixed(6),
  antiEnergyAbs: +(anti / n).toFixed(6),
  diagAntiRatio: +ratio.toFixed(4),
  horizEnergyAbs: +(horiz / n).toFixed(6),
  vertEnergyAbs: +(vert / n).toFixed(6),
  horizVertRatio: +(horiz / Math.max(vert, 1e-12)).toFixed(4),
}, null, 2));

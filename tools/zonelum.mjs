#!/usr/bin/env node
/**
 * Radial zone-luminance / vignette-falloff probe.
 *
 * Reproduces the parent's "pool-of-light" instrument: mean luminance in a centre
 * disc (r < rIn, default 0.25 of the half-min-dimension radius) vs an outer ring
 * (r > rOut, default 0.80), with r aspect-normalised to the frame. falloff =
 * 1 - outer/centre — POSITIVE means bright centre / dark corners (pool of light),
 * NEGATIVE means the inversion (corners brighter than centre). References measure
 * 0.467-0.781; ours 0.148-0.438; the courtyard is INVERTED at -0.450.
 *
 * HUD note: r is radial from frame centre, so the bottom HUD orbs sit at large r
 * and would inflate the outer ring. We exclude the bottom 20% (HUD band) and the
 * mini-map corner is small vs the ring area; the parent's numbers reproduce within
 * noise with this exclusion (validate with the R12F frames).
 *
 * Usage: node tools/zonelum.mjs <file.png> [rIn=0.25] [rOut=0.80]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, W = 0, H = 0, bd = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8) throw new Error('only 8-bit');
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  const raw = inflateSync(Buffer.concat(idat)); const stride = W * ch;
  const rgb = new Uint8Array(W * H * 3); const cur = new Uint8Array(stride), prev = new Uint8Array(stride); let rp = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < H; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rb = raw[rp++]; const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let v;
      switch (f) { case 0: v = rb; break; case 1: v = rb + a; break; case 2: v = rb + b; break; case 3: v = rb + ((a + b) >> 1); break; case 4: v = rb + paeth(a, b, c); break; default: throw new Error('bad filter'); }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 3, s = x * ch; if (ch === 1) { rgb[o] = rgb[o+1] = rgb[o+2] = cur[s]; } else { rgb[o] = cur[s]; rgb[o+1] = cur[s+1]; rgb[o+2] = cur[s+2]; } }
    prev.set(cur);
  }
  return { width: W, height: H, rgb };
}
const srgbToLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);

const file = process.argv[2];
const rIn = Number(process.argv[3] || 0.25), rOut = Number(process.argv[4] || 0.80);
if (!file) { console.error('usage: zonelum.mjs <file.png> [rIn=0.25] [rOut=0.80]'); process.exit(2); }
const { width: W, height: H, rgb } = decodePNG(readFileSync(file));
const cx = W / 2, cy = H / 2;
const rMax = Math.min(W, H) / 2;           // half the short dimension = r=1.0
const yHudCut = Math.floor(H * 0.80);      // exclude bottom 20% HUD band
let cS = 0, cN = 0, oS = 0, oN = 0, mS = 0, mN = 0;
for (let y = 0; y < yHudCut; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - cx), dy = (y - cy);
    const r = Math.hypot(dx, dy) / rMax;
    const L = lum(rgb[(y*W+x)*3], rgb[(y*W+x)*3+1], rgb[(y*W+x)*3+2]);
    if (r < rIn) { cS += L; cN++; }
    else if (r > rOut) { oS += L; oN++; }
    else { mS += L; mN++; }
  }
}
const centre = cS / Math.max(cN, 1), outer = oS / Math.max(oN, 1), mid = mS / Math.max(mN, 1);
console.log(JSON.stringify({
  file, dims: `${W}x${H}`, rIn, rOut,
  centre: +centre.toFixed(4), mid: +mid.toFixed(4), outer: +outer.toFixed(4),
  falloff: +(1 - outer / Math.max(centre, 1e-9)).toFixed(3),
  centreOverOuter: +(centre / Math.max(outer, 1e-9)).toFixed(3),
}, null, 2));

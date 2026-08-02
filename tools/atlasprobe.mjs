#!/usr/bin/env node
/**
 * Atlas-albedo probe — camera-free iteration loop for the colour-variety fix.
 *
 * The rendered distinct-colour count is the true acceptance metric, but it needs
 * a full page reload (baked textures are double-cached) and the shared camera.
 * The baked atlas albedo is the CAUSE of that count: more distinct albedo colours
 * arranged at more distinct scales is a NECESSARY condition for more rendered
 * colours. So this measures the atlas directly, in Node, with no WebGL:
 *
 *   uniqAtlas   distinct 6-bit (>>2) colours across the whole AO-folded atlas,
 *               sampled every 7th texel (mirrors the frame instrument's method).
 *   cellHueSpread   stddev of per-cell mean hue (deg) — "different stone beds".
 *   cellValSpread   stddev of per-cell mean value — slab-scale value variety.
 *   cellPeriodSpread coefficient of variation of per-cell dominant worley period
 *               (from the height field) — the SCALE-variety proxy for lagSpread.
 *   fineAbs     mean |luminance step| for steps <0.01 across the atlas — the
 *               anti-grain GUARD; must stay ~flat vs baseline (rising = added grain).
 *
 * Usage: node tools/atlasprobe.mjs [stoneFloor|stoneWall|cobble ...] [--grid N] [--cellpx N] [--json]
 */
import { getStoneAtlasFields } from '../src/gen/materials.js';

const srgbToLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum255 = (r, g, b) => 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

// AO-folded albedo bytes for one cell (mirrors texgen.albedoCanvas).
function cellAlbedo(cell, aoFold, size) {
  const { r, g, b, ao } = cell;
  const out = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const k = 1 - aoFold * (1 - (ao ? ao[i] : 1));
    const j = i * 3;
    out[j] = Math.max(0, Math.min(1, r[i] * k)) * 255;
    out[j + 1] = Math.max(0, Math.min(1, g[i] * k)) * 255;
    out[j + 2] = Math.max(0, Math.min(1, b[i] * k)) * 255;
  }
  return out;
}

// Dominant horizontal period of a cell's height field (worley block scale),
// via autocorrelation of the mid-row-averaged height profile.
function cellPeriod(cell, size) {
  // Average many rows of the ALBEDO luminance, then heavily blur: the worley
  // mortar grooves survive as periodic dark dips while micro-grain and fine face
  // relief (both near zero-mean and much finer) blur away, so the autocorrelation
  // locks onto the BLOCK period instead of flooring at the grain scale.
  const { r, g, b } = cell;
  const prof = new Float64Array(size);
  const y0 = (size * 0.15) | 0, y1 = (size * 0.85) | 0;
  for (let x = 0; x < size; x++) { let s = 0; for (let y = y0; y < y1; y++) { const i = y * size + x; s += 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i]; } prof[x] = s / (y1 - y0); }
  const rad = Math.max(2, (size / 48) | 0);
  const bl = new Float64Array(size);
  for (let x = 0; x < size; x++) { let s = 0, c = 0; for (let k = -rad; k <= rad; k++) { const xi = ((x + k) % size + size) % size; s += prof[xi]; c++; } bl[x] = s / c; }
  let mean = 0; for (let x = 0; x < size; x++) mean += bl[x]; mean /= size;
  let v0 = 0; for (let x = 0; x < size; x++) { bl[x] -= mean; v0 += bl[x] * bl[x]; }
  if (v0 < 1e-9) return { period: null, groove: 0 };
  let best = 0, bestR = 0.12;
  const minLag = Math.max(8, (size * 0.06) | 0), maxLag = (size * 0.7) | 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, n = 0; for (let x = 0; x + lag < size; x++) { s += bl[x] * bl[x + lag]; n++; }
    const rr = s / v0;
    if (rr > bestR) { bestR = rr; best = lag; }
  }
  // grooveFrac: fraction of blurred texels sitting well below the local mean = mortar.
  let gf = 0; for (let x = 0; x < size; x++) if (bl[x] < -0.35 * Math.sqrt(v0 / size)) gf++;
  return { period: best || null, groove: +(gf / size).toFixed(3) };
}

function probe(name, opts) {
  const A = getStoneAtlasFields(name, opts);
  const size = A.cellPx;
  const cells = A.cells.map((c) => cellAlbedo(c, A.aoFold, size));
  // whole-atlas distinct colours (6-bit >>2, every 7th texel)
  const uniq = new Set();
  let fineSum = 0, fineN = 0, stepN = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const px = cells[ci];
    for (let i = 0; i < size * size; i += 7) {
      const j = i * 3;
      uniq.add(((px[j] >> 2) << 10) | ((px[j + 1] >> 2) << 5) | (px[j + 2] >> 2));
    }
    // fine-step guard: horizontal |luminance step| for steps <0.01
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size - 1; x++) {
        const a = lum255(px[(y * size + x) * 3], px[(y * size + x) * 3 + 1], px[(y * size + x) * 3 + 2]);
        const b = lum255(px[(y * size + x + 1) * 3], px[(y * size + x + 1) * 3 + 1], px[(y * size + x + 1) * 3 + 2]);
        const d = Math.abs(a - b); stepN++;
        if (d < 0.01) { fineSum += d; fineN++; }
      }
    }
  }
  // per-cell mean hue / value / dominant period
  const hues = [], vals = [], sats = [], periods = [], grooves = [];
  for (let ci = 0; ci < cells.length; ci++) {
    const px = cells[ci]; let hx = 0, hy = 0, sw = 0, vs = 0, n = 0;
    for (let i = 0; i < size * size; i += 13) {
      const { h, s, v } = rgbToHsv(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
      const rad = h * Math.PI / 180; hx += Math.cos(rad) * s; hy += Math.sin(rad) * s; sw += s; vs += v; n++;
    }
    hues.push((Math.atan2(hy, hx) * 180 / Math.PI + 360) % 360);
    vals.push(vs / n); sats.push(sw / n);
    const pg = cellPeriod(A.cells[ci], size); if (pg.period) periods.push(pg.period); grooves.push(pg.groove);
  }
  const sd = (arr) => { if (arr.length < 2) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };
  const cv = (arr) => { if (arr.length < 2) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return sd(arr) / Math.max(m, 1e-6); };
  // circular-ish hue spread: use min spanning range clamped to 180
  const hueSpread = (() => { if (hues.length < 2) return 0; const m = hues.reduce((a, b) => a + b, 0) / hues.length; return Math.sqrt(hues.reduce((a, b) => { let d = ((b - m + 540) % 360) - 180; return a + d * d; }, 0) / hues.length); })();
  return {
    name, grid: A.grid, cellPx: A.cellPx,
    uniqAtlas: uniq.size,
    cellHueSpread: +hueSpread.toFixed(1),
    cellValSpread: +sd(vals).toFixed(4),
    cellPeriods: periods,
    cellPeriodSpread: +cv(periods).toFixed(3),
    cellGrooves: grooves,
    grooveSpread: +cv(grooves).toFixed(3),
    fineAbs: +(fineSum / Math.max(stepN, 1)).toFixed(6),
    atlasMeanSat: +(sats.reduce((a, b) => a + b, 0) / sats.length).toFixed(4),
    cellHues: hues.map((h) => +h.toFixed(0)),
    cellVals: vals.map((v) => +v.toFixed(3)),
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const gI = args.indexOf('--grid'); const cI = args.indexOf('--cellpx');
const opts = {};
if (gI >= 0) opts.grid = +args[gI + 1];
opts.cellPx = cI >= 0 ? +args[cI + 1] : 256;   // small default — fast iteration; scale-invariant metrics
const names = args.filter((a, k) => !a.startsWith('--') && args[k - 1] !== '--grid' && args[k - 1] !== '--cellpx');
if (!names.length) names.push('stoneFloor');
const out = names.map((n) => { try { return probe(n, opts); } catch (e) { return { name: n, error: e.message }; } });
if (json) console.log(JSON.stringify(out, null, 2));
else for (const o of out) o.error ? console.log(`${o.name}: ERR ${o.error}`)
  : console.log(`${o.name} g${o.grid} ${o.cellPx}px  uniqAtlas=${o.uniqAtlas}  hueSpread=${o.cellHueSpread}deg  valSpread=${o.cellValSpread}  meanSat=${o.atlasMeanSat}  grooves=${o.cellGrooves} gSpread=${o.grooveSpread}  fineAbs=${o.fineAbs}\n    cellHues=${o.cellHues}  cellVals=${o.cellVals}`);

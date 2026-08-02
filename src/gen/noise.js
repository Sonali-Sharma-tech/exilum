// Procedural noise basis for the material library.
//
// Everything here is SEAMLESS (periodic) so textures tile under RepeatWrapping
// with no visible seam. The basis functions:
//   - pnoise2 : periodic (tileable) gradient / Perlin noise
//   - fbm     : fractal Brownian motion (multi-octave), plain or ridged
//   - warp    : domain warping (offset sample coords by an fbm field)
//   - worley  : periodic cellular / Voronoi (F1, F2, per-cell id)
//   - whiteTile: per-texel hash speckle for micro grain
//
// No THREE dependency, no Math.random smeared into a canvas: this is real
// gradient noise with a seeded permutation table.

const GRAD2 = new Float32Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  0.70710678, 0.70710678, -0.70710678, 0.70710678,
  0.70710678, -0.70710678, -0.70710678, -0.70710678,
]);

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);

// Reusable out-object for worley so the hot loop never allocates.
const _cell = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };

export class Noise {
  constructor(seed = 1337) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    // Seeded Fisher-Yates (LCG) — deterministic per seed.
    let s = (seed >>> 0) || 1;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    // Doubled table lets pnoise index p[p[xi]+yi] without a modulo.
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  // Periodic Perlin. Coords are in "lattice space"; the field repeats every
  // `px`/`py` lattice units. Periods MUST be powers of two (<=256) so the
  // wrap is a bitmask and stays periodic. Fast floor via a +512 bias (all
  // sample coords stay well above -512), then mask.
  pnoise2(x, y, px, py) {
    const p = this.p;
    const xb = x + 512, yb = y + 512;      // bias positive for fast floor+mask
    const xi = xb | 0, yi = yb | 0;
    const xf = xb - xi, yf = yb - yi;
    const mx = px - 1, my = py - 1;
    const X0 = xi & mx, Y0 = yi & my;
    const X1 = (xi + 1) & mx, Y1 = (yi + 1) & my;
    const u = fade(xf), v = fade(yf);
    const aa = p[p[X0] + Y0], ba = p[p[X1] + Y0];
    const ab = p[p[X0] + Y1], bb = p[p[X1] + Y1];
    let gi = (aa & 7) << 1; const n00 = GRAD2[gi] * xf + GRAD2[gi + 1] * yf;
    gi = (ba & 7) << 1;     const n10 = GRAD2[gi] * (xf - 1) + GRAD2[gi + 1] * yf;
    gi = (ab & 7) << 1;     const n01 = GRAD2[gi] * xf + GRAD2[gi + 1] * (yf - 1);
    gi = (bb & 7) << 1;     const n11 = GRAD2[gi] * (xf - 1) + GRAD2[gi + 1] * (yf - 1);
    const x1 = lerp(n00, n10, u), x2 = lerp(n01, n11, u);
    return lerp(x1, x2, v); // ~[-1,1]
  }

  // Fractal Brownian motion over periodic Perlin. `base` = lattice period of
  // the first octave (power of two == cells across the tile). Each octave
  // doubles frequency AND period so the whole stack stays seamless. `ridged`
  // folds each octave into sharp ridges (1-|n|)^2 — cracks and rock spines.
  // Plain returns ~[-1,1]; ridged returns ~[0,1].
  fbm(u, v, base = 8, octaves = 5, gain = 0.5, ridged = false) {
    let amp = 1, sum = 0, norm = 0, per = base;
    for (let o = 0; o < octaves && per <= 256; o++) {
      let n = this.pnoise2(u * per, v * per, per, per);
      if (ridged) { n = 1 - Math.abs(n); n *= n; }
      sum += n * amp; norm += amp;
      amp *= gain; per *= 2;
    }
    return sum / norm;
  }

  // Domain warp: returns the fbm value at coords pushed around by another fbm
  // field. This is what turns bland noise into flowing, geological form.
  warp(u, v, base, octaves, amp, warpBase = 4) {
    const wx = this.fbm(u + 0.317, v + 0.114, warpBase, 3, 0.5, false);
    const wy = this.fbm(u + 0.829, v + 0.663, warpBase, 3, 0.5, false);
    return this.fbm(u + wx * amp, v + wy * amp, base, octaves, 0.5, false);
  }

  warpRidged(u, v, base, octaves, amp, warpBase = 4) {
    const wx = this.fbm(u + 0.211, v + 0.907, warpBase, 3, 0.5, false);
    const wy = this.fbm(u + 0.577, v + 0.021, warpBase, 3, 0.5, false);
    return this.fbm(u + wx * amp, v + wy * amp, base, octaves, 0.5, true);
  }

  // Periodic Worley/cellular over `cells` cells across the [0,1) tile.
  // Fills the shared _cell: f1 (nearest, ~0..1), f2 (2nd nearest), id (0..255),
  // cx/cy (owning cell). jitter 0..1 controls point scatter within a cell.
  worley(u, v, cells, jitter = 1) {
    const p = this.p;
    const x = u * cells, y = v * cells;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 1e9, f2 = 1e9, id = 0, ocx = 0, ocy = 0;
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++) {
        const cx = xi + gx, cy = yi + gy;
        const wx = ((cx % cells) + cells) % cells;
        const wy = ((cy % cells) + cells) % cells;
        const h = p[p[wx & 255] + (wy & 255)];
        const ox = p[(p[(wx + 41) & 255] + wy) & 511] / 255;
        const oy = p[(p[(wx + 97) & 255] + wy + 7) & 511] / 255;
        const fxp = cx + 0.5 + (ox - 0.5) * jitter;
        const fyp = cy + 0.5 + (oy - 0.5) * jitter;
        const dx = fxp - x, dy = fyp - y;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; id = h; ocx = wx; ocy = wy; }
        else if (d < f2) { f2 = d; }
      }
    }
    _cell.f1 = Math.sqrt(f1); _cell.f2 = Math.sqrt(f2);
    _cell.id = id; _cell.cx = ocx; _cell.cy = ocy;
    return _cell;
  }

  // Per-texel hash in [0,1), periodic at any power-of-two texture size.
  // The micro grain / aggregate speckle scale — cheap and seam-free.
  whiteTile(ix, iy) {
    const p = this.p;
    return p[(p[ix & 255] + (iy & 255)) & 511] / 255;
  }
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;

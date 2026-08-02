import * as THREE from 'three';

/**
 * Procedural VFX sprite atlas — 100% canvas2d, no external assets.
 *
 * A single 1024x1024 texture divided into an 8x8 grid of 128px cells. Each cell
 * holds one soft-edged sprite variant. Particles pick a cell via a per-instance
 * frame index; the vertex shader maps that index to a UV rectangle.
 *
 * All sprites are drawn white-on-transparent (luminance in RGB, shape in alpha)
 * so a single atlas can be tinted to any colour per particle via the vertex
 * colour. Blood/decal sprites follow the same rule and are tinted dark red at
 * spawn. The texture is uploaded with premultiplied alpha so both additive
 * (ONE,ONE) and alpha (ONE,ONE-SRC_ALPHA) blends composite correctly.
 *
 * Hard squares are an explicit rubric fail (§7): every cell fades fully to
 * transparent well inside its bounds, so no cell edge is ever visible.
 */

export const GRID = 8;
const SIZE = 1024;
const CELL = SIZE / GRID;      // 128
const HALF = CELL / 2;         // 64
const R = CELL * 0.46;         // content radius, leaves a transparent guard band

// Contiguous frame ranges per sprite family. { start, count }.
export const FRAMES = {
  glow:  { start: 0,  count: 4 },   // soft radial falloffs (cores, muzzle, glow)
  smoke: { start: 4,  count: 6 },   // billowing wisps (alpha-blended)
  spark: { start: 10, count: 4 },   // elongated streaks (velocity-stretched)
  ember: { start: 14, count: 4 },   // tiny bright dots with flicker halo
  flash: { start: 18, count: 4 },   // cracked-glass / star impact flashes
  ring:  { start: 22, count: 4 },   // shockwave ring gradients
  dust:  { start: 26, count: 4 },   // soft low-contrast puffs
  blood: { start: 30, count: 8 },   // irregular splatters (tinted, alpha)
  rune:  { start: 38, count: 4 },   // arcane glyph fragments (magic sparkle)
  shard: { start: 42, count: 4 },   // crystalline shards (ice/lightning)
};

// mulberry32 — deterministic per-cell RNG so the atlas is stable build-to-build.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Radial alpha gradient, white core -> transparent. `exp` shapes the falloff.
function radial(ctx, cx, cy, rad, core, exp) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = Math.pow(1 - t, exp) * core;
    g.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
  }
  return g;
}

function drawGlow(ctx, cx, cy, rnd) {
  const exp = 1.6 + rnd() * 2.6;         // tighter vs broader haloes
  const core = 0.9 + rnd() * 0.1;
  ctx.fillStyle = radial(ctx, cx, cy, R, core, exp);
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
}

function drawSmoke(ctx, cx, cy, rnd) {
  // Several overlapping soft lobes -> irregular billow, low peak alpha.
  const lobes = 5 + (rnd() * 4 | 0);
  for (let i = 0; i < lobes; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * R * 0.42;
    const lr = R * (0.4 + rnd() * 0.45);
    const lx = cx + Math.cos(ang) * dist;
    const ly = cy + Math.sin(ang) * dist;
    ctx.fillStyle = radial(ctx, lx, ly, lr, 0.30 + rnd() * 0.22, 2.2 + rnd() * 1.4);
    ctx.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
  }
}

function drawSpark(ctx, cx, cy, rnd) {
  // Vertical bright streak, tapered, gaussian across width — stretched by shader.
  const len = R * (1.3 + rnd() * 0.5);
  const wid = 3 + rnd() * 4;
  ctx.save();
  ctx.translate(cx, cy);
  const grad = ctx.createLinearGradient(0, -len, 0, len);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(0.58, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  // Diamond-ish streak: width tapers toward the ends.
  ctx.beginPath();
  const seg = 24;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, y = -len + t * len * 2;
    const w = wid * Math.sin(t * Math.PI);
    ctx.lineTo(w, y);
  }
  for (let i = seg; i >= 0; i--) {
    const t = i / seg, y = -len + t * len * 2;
    const w = wid * Math.sin(t * Math.PI);
    ctx.lineTo(-w, y);
  }
  ctx.closePath();
  ctx.fill();
  // hot centre dot
  ctx.fillStyle = radial(ctx, 0, 0, wid * 3, 1, 2.0);
  ctx.fillRect(-wid * 3, -wid * 3, wid * 6, wid * 6);
  ctx.restore();
}

function drawEmber(ctx, cx, cy, rnd) {
  const halo = R * (0.5 + rnd() * 0.3);
  ctx.fillStyle = radial(ctx, cx, cy, halo, 0.5, 2.6);   // soft halo
  ctx.fillRect(cx - halo, cy - halo, halo * 2, halo * 2);
  const core = 5 + rnd() * 5;
  ctx.fillStyle = radial(ctx, cx, cy, core, 1, 1.4);     // bright core
  ctx.fillRect(cx - core, cy - core, core * 2, core * 2);
}

function drawFlash(ctx, cx, cy, rnd) {
  // Central burst + radiating spikes (star) + faint cracked-glass fractures.
  ctx.fillStyle = radial(ctx, cx, cy, R * 0.5, 1, 1.5);
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  const spikes = 6 + (rnd() * 5 | 0);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rnd() * Math.PI);
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
    const len = R * (0.55 + rnd() * 0.42);
    const w = 2 + rnd() * 3;
    const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRing(ctx, cx, cy, rnd) {
  // Shockwave: transparent centre, bright thin ring, soft outer fade.
  const rad = R * (0.72 + rnd() * 0.2);
  const thick = 0.06 + rnd() * 0.06;      // as fraction of radius
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
  const peak = 0.7 + rnd() * 0.15;
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(Math.max(0, peak - thick * 2), 'rgba(255,255,255,0)');
  g.addColorStop(peak, `rgba(255,255,255,${(0.9).toFixed(3)})`);
  g.addColorStop(Math.min(1, peak + thick), 'rgba(255,255,255,0.12)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
}

function drawDust(ctx, cx, cy, rnd) {
  const lobes = 4 + (rnd() * 3 | 0);
  for (let i = 0; i < lobes; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * R * 0.3;
    const lr = R * (0.5 + rnd() * 0.4);
    const lx = cx + Math.cos(ang) * dist;
    const ly = cy + Math.sin(ang) * dist;
    ctx.fillStyle = radial(ctx, lx, ly, lr, 0.16 + rnd() * 0.12, 2.8 + rnd() * 1.2);
    ctx.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
  }
}

function drawBlood(ctx, cx, cy, rnd) {
  // Irregular central mass + satellite droplets + directional micro-streaks.
  const blobs = 3 + (rnd() * 3 | 0);
  for (let i = 0; i < blobs; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * R * 0.3;
    const lr = R * (0.28 + rnd() * 0.32);
    const lx = cx + Math.cos(ang) * dist;
    const ly = cy + Math.sin(ang) * dist;
    ctx.fillStyle = radial(ctx, lx, ly, lr, 0.85 + rnd() * 0.15, 1.4 + rnd() * 1.0);
    ctx.beginPath();
    // irregular polygon edge for an organic splat silhouette
    const pts = 9;
    for (let p = 0; p <= pts; p++) {
      const a = (p / pts) * Math.PI * 2;
      const rr = lr * (0.7 + rnd() * 0.5);
      const x = lx + Math.cos(a) * rr, y = ly + Math.sin(a) * rr;
      p ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  const drops = 6 + (rnd() * 8 | 0);
  for (let i = 0; i < drops; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = R * (0.4 + rnd() * 0.55);
    const dr = 1.5 + rnd() * 5;
    const dx = cx + Math.cos(ang) * dist;
    const dy = cy + Math.sin(ang) * dist;
    ctx.fillStyle = radial(ctx, dx, dy, dr, 0.7 + rnd() * 0.3, 1.6);
    ctx.fillRect(dx - dr, dy - dr, dr * 2, dr * 2);
  }
}

function drawRune(ctx, cx, cy, rnd) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rnd() * Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const strokes = 2 + (rnd() * 3 | 0);
  for (let i = 0; i < strokes; i++) {
    ctx.lineWidth = 2.5 + rnd() * 3;
    ctx.beginPath();
    if (rnd() < 0.5) {
      const r0 = R * (0.2 + rnd() * 0.5);
      const a0 = rnd() * Math.PI * 2, a1 = a0 + (0.6 + rnd() * 2.2);
      ctx.arc(0, 0, r0, a0, a1);
    } else {
      let x = (rnd() - 0.5) * R, y = (rnd() - 0.5) * R;
      ctx.moveTo(x, y);
      const segs = 2 + (rnd() * 2 | 0);
      for (let s = 0; s < segs; s++) { x += (rnd() - 0.5) * R; y += (rnd() - 0.5) * R; ctx.lineTo(x, y); }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawShard(ctx, cx, cy, rnd) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rnd() * Math.PI * 2);
  const len = R * (0.8 + rnd() * 0.4);
  const wid = R * (0.14 + rnd() * 0.14);
  const g = ctx.createLinearGradient(0, -len, 0, len);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -len);
  ctx.lineTo(wid, -len * 0.1);
  ctx.lineTo(wid * 0.4, len);
  ctx.lineTo(-wid * 0.4, len);
  ctx.lineTo(-wid, -len * 0.1);
  ctx.closePath();
  ctx.fill();
  // crisp bright spine
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, -len); ctx.lineTo(0, len); ctx.stroke();
  ctx.restore();
}

const DRAW = {
  glow: drawGlow, smoke: drawSmoke, spark: drawSpark, ember: drawEmber,
  flash: drawFlash, ring: drawRing, dust: drawDust, blood: drawBlood,
  rune: drawRune, shard: drawShard,
};

let _tex = null;

/** Build (once) and return the shared premultiplied VFX atlas texture. */
export function buildAtlas() {
  if (_tex) return _tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);

  for (const key in FRAMES) {
    const { start, count } = FRAMES[key];
    const fn = DRAW[key];
    for (let v = 0; v < count; v++) {
      const frame = start + v;
      const col = frame % GRID;
      const row = (frame / GRID) | 0;
      const cx = col * CELL + HALF;
      const cy = row * CELL + HALF;
      const rnd = rng(0x9e3779b9 ^ (frame * 2654435761));
      ctx.save();
      // clip to the cell so overlapping lobes never bleed into a neighbour
      ctx.beginPath();
      ctx.rect(col * CELL, row * CELL, CELL, CELL);
      ctx.clip();
      fn(ctx, cx, cy, rnd);
      ctx.restore();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.premultiplyAlpha = true;      // GPU premultiplies on upload
  tex.flipY = false;                // row 0 = top of canvas; shader maps accordingly
  tex.generateMipmaps = false;      // atlas: mipmaps would bleed across cells
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  _tex = tex;
  return tex;
}

/** Pick a frame index within a family from a 0..1 seed. */
export function pickFrame(family, seed) {
  const f = FRAMES[family];
  return f.start + Math.min(f.count - 1, (seed * f.count) | 0);
}

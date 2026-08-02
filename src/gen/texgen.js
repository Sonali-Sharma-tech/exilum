// Texture generation engine: turns per-pixel height/albedo/roughness/metal
// buffers into a wired set of THREE textures (albedo, normal, ORM, optional
// emissive). All the ART (noise recipes, weathering, colour) lives in
// materials.js; this file is the fast, correct plumbing.
//
// Decisions that matter for the look:
//  - Normal is derived from the height field with a real 3x3 Sobel, wrapped for
//    seamless tiling, interior fast-path + edge LUT so it is ~25x faster than a
//    naive per-tap modulo. Encoded OpenGL-style (+Y up) to pair with three's
//    default material.normalScale (1,1) on flipY=true canvas uploads.
//  - AO is baked from the height field with a difference-of-box-blur cavity
//    estimate (O(N) separable running-sum blur, wrapped, edge LUT). Baked at a
//    capped resolution (AO is low-frequency) then bilinearly read back, so hero
//    2048 tiles do not pay a 1s blur bill. Micro grain is excluded (we diff
//    against a lightly-smoothed height) so pores never speckle the AO.
//  - AO / roughness / metalness are PACKED into one ORM texture (glTF channel
//    convention: R=ao, G=roughness, B=metalness) and the one texture object is
//    assigned to aoMap + roughnessMap (+ metalnessMap when the material is
//    metallic). Three reads the right channel from each slot: 3 maps, 1 upload.
//  - Every map is a CanvasTexture (flipY=true default) so albedo/normal/ORM
//    stay pixel-aligned and the normal green sign follows the standard OpenGL
//    convention.
//  - A portion of baked AO is folded into albedo so cavities read even on
//    geometry that lacks a second UV set for aoMap.

import * as THREE from 'three';

// -------------------------------------------------------------- colour helpers
// h in [0,360), s,l in [0,1] -> {r,g,b} in [0,1] (sRGB working space)
export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: r + m, g: g + m, b: b + m };
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --------------------------------------------------------------- buffer layer
export function newLayer(size) {
  const n = size * size;
  return {
    size, n,
    h: new Float32Array(n),      // height 0..1 -> normals + AO
    r: new Float32Array(n),      // albedo sRGB 0..1
    g: new Float32Array(n),
    b: new Float32Array(n),
    rough: new Float32Array(n),  // roughness 0..1 (linear)
    ao: new Float32Array(n),     // baked ambient occlusion 0..1
    metal: null,                 // optional metalness 0..1
    em: null,                    // optional [rF32, gF32, bF32] emissive triple
  };
}
export function withMetal(layer) {
  if (!layer.metal) layer.metal = new Float32Array(layer.n);
  return layer;
}
export function withEmissive(layer) {
  if (!layer.em) layer.em = [new Float32Array(layer.n), new Float32Array(layer.n), new Float32Array(layer.n)];
  return layer;
}

// Wrapped-index LUT: W[size + i] = ((i % size)+size)%size for i in [-size, 2size).
function wrapLUT(size) {
  const W = new Int32Array(size * 3);
  for (let i = -size; i < size * 2; i++) W[size + i] = ((i % size) + size) % size;
  return W;
}

// ------------------------------------------------- separable wrapped box blur
// Running-sum box blur with toroidal wrap via LUT: O(N) regardless of radius.
function boxBlurWrap(src, size, radius, W) {
  const n = size * size;
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  const inv = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + W[size + k]];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + W[size + x + radius + 1]] - src[row + W[size + x - radius]];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[W[size + k] * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum * inv;
      sum += tmp[W[size + y + radius + 1] * size + x] - tmp[W[size + y - radius] * size + x];
    }
  }
  return out;
}

// Downsample a size*size field to cs*cs by box-averaging blocks (wrapped-safe:
// cs divides size in our use, so blocks tile exactly).
function downsample(src, size, cs) {
  const out = new Float32Array(cs * cs);
  const step = size / cs;
  const s0 = Math.max(1, Math.round(step));
  for (let cy = 0; cy < cs; cy++) {
    for (let cx = 0; cx < cs; cx++) {
      const ox = Math.round(cx * step), oy = Math.round(cy * step);
      let sum = 0, cnt = 0;
      for (let dy = 0; dy < s0; dy++) {
        const yy = (oy + dy) % size;
        for (let dx = 0; dx < s0; dx++) {
          sum += src[yy * size + ((ox + dx) % size)]; cnt++;
        }
      }
      out[cy * cs + cx] = sum / cnt;
    }
  }
  return out;
}

// Bake AO into layer.ao from layer.h. Cavity = how far a lightly-smoothed height
// sits below its neighbourhood mean, measured at two scales so mortar lines
// (mid) and broad hollows (macro) both darken. Blur runs at a capped resolution.
export function bakeAO(layer, { strength = 1.0, mid = 0.021, macro = 0.09, midGain = 4.2, macGain = 2.1 } = {}) {
  const { size, h, ao, n } = layer;
  const aoRes = Math.min(size, 1024);
  const W = wrapLUT(aoRes);
  const src = aoRes === size ? h : downsample(h, size, aoRes);
  const rMicro = Math.max(1, Math.round(aoRes / 512));
  const rMid = Math.max(2, Math.round(aoRes * mid));
  const rMacro = Math.max(4, Math.round(aoRes * macro));
  const hLow = boxBlurWrap(src, aoRes, rMicro, W);
  const bMid = boxBlurWrap(src, aoRes, rMid, W);
  const bMac = boxBlurWrap(src, aoRes, rMacro, W);
  const aoSmall = new Float32Array(aoRes * aoRes);
  for (let i = 0; i < aoSmall.length; i++) {
    const cavMid = bMid[i] - hLow[i];
    const cavMac = bMac[i] - hLow[i];
    let occ = 0;
    if (cavMid > 0) occ += cavMid * midGain;
    if (cavMac > 0) occ += cavMac * macGain;
    aoSmall[i] = clamp01(1 - occ * strength);
  }
  // Read AO back to full res (bilinear). AO is smooth, so this is loss-free.
  if (aoRes === size) { ao.set(aoSmall); return layer; }
  const scale = aoRes / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale - 0.5;
    let y0 = Math.floor(fy); const ty = fy - y0;
    const y1 = ((y0 + 1) % aoRes + aoRes) % aoRes; y0 = ((y0 % aoRes) + aoRes) % aoRes;
    for (let x = 0; x < size; x++) {
      const fx = x * scale - 0.5;
      let x0 = Math.floor(fx); const tx = fx - x0;
      const x1 = ((x0 + 1) % aoRes + aoRes) % aoRes; x0 = ((x0 % aoRes) + aoRes) % aoRes;
      const a = aoSmall[y0 * aoRes + x0], b = aoSmall[y0 * aoRes + x1];
      const c = aoSmall[y1 * aoRes + x0], d = aoSmall[y1 * aoRes + x1];
      ao[y * size + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return layer;
}

// ------------------------------------------------------------- canvas / upload
export function makeCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
export function canvasTexture(canvas, { srgb, aniso, repeat, wrap }) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------ normal from height
// 3x3 Sobel on the height field, wrapped, interior fast-path + edge LUT.
// OpenGL (+Y up) encoding to pair with three's default normalScale (1,1).
export function normalCanvas(layer, strength) {
  const { size, h } = layer;
  const W = wrapLUT(size);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const interiorY = y > 0 && y < size - 1;
    const yU = interiorY ? y - 1 : W[size + y - 1];
    const yD = interiorY ? y + 1 : W[size + y + 1];
    const rU = yU * size, rC = y * size, rD = yD * size;
    for (let x = 0; x < size; x++) {
      let xL, xR;
      if (x > 0 && x < size - 1) { xL = x - 1; xR = x + 1; }
      else { xL = W[size + x - 1]; xR = W[size + x + 1]; }
      const tl = h[rU + xL], t = h[rU + x], tr = h[rU + xR];
      const l = h[rC + xL], r = h[rC + xR];
      const bl = h[rD + xL], b = h[rD + x], br = h[rD + xR];
      const dX = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dY = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dX * strength, ny = dY * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const j = (rC + x) << 2;
      d[j] = (nx * inv * 0.5 + 0.5) * 255;
      d[j + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[j + 2] = (inv * 0.5 + 0.5) * 255;
      d[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function albedoCanvas(layer, aoFold) {
  const { size, r, g, b, ao } = layer;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const k = 1 - aoFold * (1 - ao[i]);
    const j = i << 2;
    d[j] = clamp01(r[i] * k) * 255;
    d[j + 1] = clamp01(g[i] * k) * 255;
    d[j + 2] = clamp01(b[i] * k) * 255;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ORM pack: R=ao, G=roughness, B=metalness (0 when non-metal).
export function ormCanvas(layer) {
  const { size, rough, ao, metal } = layer;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const j = i << 2;
    d[j] = clamp01(ao[i]) * 255;
    d[j + 1] = clamp01(rough[i]) * 255;
    d[j + 2] = metal ? clamp01(metal[i]) * 255 : 0;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function emissiveCanvas(layer) {
  const { size, em } = layer;
  const [er, eg, eb] = em;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const j = i << 2;
    d[j] = clamp01(er[i]) * 255;
    d[j + 1] = clamp01(eg[i]) * 255;
    d[j + 2] = clamp01(eb[i]) * 255;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Build all textures for a finished layer. Returns { map, normalMap,
// roughnessMap, aoMap, metalnessMap?, emissiveMap? }. roughnessMap / aoMap /
// metalnessMap share ONE packed ORM CanvasTexture.
export function buildTextures(layer, {
  aniso = 8, repeat = 1, normalStrength = 2.4, aoFold = 0.5,
  wrap = THREE.RepeatWrapping,
} = {}) {
  const orm = canvasTexture(ormCanvas(layer), { srgb: false, aniso, repeat, wrap });
  const out = {
    map: canvasTexture(albedoCanvas(layer, aoFold), { srgb: true, aniso, repeat, wrap }),
    normalMap: canvasTexture(normalCanvas(layer, normalStrength), { srgb: false, aniso, repeat, wrap }),
    roughnessMap: orm,
    aoMap: orm,
  };
  if (layer.metal) out.metalnessMap = orm;
  if (layer.em) out.emissiveMap = canvasTexture(emissiveCanvas(layer), { srgb: true, aniso, repeat, wrap });
  return out;
}

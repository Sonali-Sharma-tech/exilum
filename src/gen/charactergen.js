// charactergen.js — procedural PBR materials + geometry primitives for the exile.
// Owner: CharacterRig. No external assets: every texture is canvas2d, every mesh is code.
// Design target (measured PoE2 ground truth): most of the frame is black, the lit ~25%
// is RICHLY saturated. So albedos here are deep-but-chromatic (oxblood cloth, cold blue
// steel, warm sodium gold, ivory bone) with heavy micro-detail (target local contrast
// ~0.02): triple-scale noise + derived normal maps + spatially-varying roughness.
import * as THREE from 'three';
import { getMat } from './materials.js';

// ---------------------------------------------------------------------------
// value noise + fbm (hash-based, deterministic, allocation-free inner loop)
// ---------------------------------------------------------------------------
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, oct, lac = 2.03, gain = 0.5) {
  let f = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) { f += amp * vnoise(x * freq, y * freq); norm += amp; amp *= gain; freq *= lac; }
  return f / norm;
}

// tileable-ish periodic noise (wraps at `period` cells) for seamless wrap textures
function pnoise(x, y, period) {
  const xa = fbm(x, y, 4);
  const xb = fbm(x - period, y, 4);
  const yb = fbm(x - period, y - period, 4);
  const ya = fbm(x, y - period, 4);
  const fx = x / period - Math.floor(x / period);
  const fy = y / period - Math.floor(y / period);
  return xa * (1 - fx) * (1 - fy) + xb * fx * (1 - fy) + ya * (1 - fx) * fy + yb * fx * fy;
}

// ---------------------------------------------------------------------------
// texture factory — one pass fills a height field, then derives albedo / rough / normal
// ---------------------------------------------------------------------------
function texFromFields(size, fill) {
  const alb = new Uint8ClampedArray(size * size * 4);
  const rgh = new Uint8ClampedArray(size * size * 4);
  const hgt = new Float32Array(size * size);
  const col = { r: 0, g: 0, b: 0, rough: 0.5, h: 0.5 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fill(x, y, size, col);
      const i = (y * size + x) * 4;
      alb[i] = col.r * 255; alb[i + 1] = col.g * 255; alb[i + 2] = col.b * 255; alb[i + 3] = 255;
      const rq = Math.max(0, Math.min(1, col.rough)) * 255;
      rgh[i] = rq; rgh[i + 1] = rq; rgh[i + 2] = rq; rgh[i + 3] = 255;
      hgt[y * size + x] = col.h;
    }
  }
  // normal map from height (Sobel), strong enough to catch grazing light
  const nrm = new Uint8ClampedArray(size * size * 4);
  const S = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = (hgt[y * size + xp] - hgt[y * size + xm]) * S;
      const dy = (hgt[yp * size + x] - hgt[ym * size + x]) * S;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      nrm[i] = (nx * inv * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nrm[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
  const mk = (data, srgb) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d').putImageData(new ImageData(data, size, size), 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: mk(alb, true), roughnessMap: mk(rgh, false), normalMap: mk(nrm, false) };
}

// deep oxblood cloth: woven weave (mid) + heavy folds (macro) + fibre grain (micro)
function clothFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const weave = 0.5 + 0.5 * Math.sin(u * size * 0.9) * Math.sin(v * size * 0.9);
  const folds = pnoise(u * 3.2, v * 3.2, 3.2);
  const grain = fbm(u * 120, v * 120, 3);
  const h = folds * 0.7 + weave * 0.18 + grain * 0.12;
  o.h = h;
  // oxblood: rich crimson when lit, deep in creases. Broken with cold soot in folds.
  const shade = 0.42 + folds * 0.55;             // fold darkening
  const soot = fbm(u * 6, v * 6, 3);
  o.r = (0.30 + weave * 0.05) * shade;
  o.g = (0.045 + weave * 0.02) * shade * (1 - soot * 0.3);
  o.b = (0.05 + weave * 0.02) * shade * (1 - soot * 0.2);
  o.rough = 0.72 + grain * 0.2 - (h - 0.4) * 0.18;  // raised threads slightly smoother
}

// cold blue-steel iron with warm rust streaks + rivets + banded plate
function ironFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const band = Math.abs(((v * 4) % 1) - 0.5);       // horizontal plate bands
  const bandEdge = smooth(1 - Math.min(1, band * 5)); // bright at band seams
  const rivetU = (u * 6) % 1, rivetV = (v * 4) % 1;
  const rd = Math.hypot(rivetU - 0.5, rivetV - 0.15);
  const rivet = rd < 0.09 ? smooth(1 - rd / 0.09) : 0;
  const scratch = fbm(u * 40, v * 6, 3);
  const rust = Math.max(0, fbm(u * 5, v * 2.2, 4) - 0.5) * 2 * smooth(v);   // rust drains DOWN
  const grain = fbm(u * 160, v * 160, 3);
  o.h = 0.5 + bandEdge * 0.28 + rivet * 0.4 - band * 0.25 + grain * 0.06;
  // cold steel base, warm rust overlay
  const steel = 0.30 - band * 0.10 + bandEdge * 0.18 + scratch * 0.06;
  o.r = steel * (1 - rust) + rust * 0.34;
  o.g = (steel * 1.02) * (1 - rust) + rust * 0.15;
  o.b = (steel * 1.22) * (1 - rust) + rust * 0.06;   // blue bias in the steel
  o.rough = 0.5 + rust * 0.42 - bandEdge * 0.22 + grain * 0.12;
}

// warm sodium gold trim, low roughness, subtle brushed grain
function goldFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const brushed = fbm(u * 200, v * 12, 3);
  const dents = pnoise(u * 5, v * 5, 5);
  const grime = Math.max(0, fbm(u * 8, v * 8, 3) - 0.55) * 2;
  o.h = 0.5 + dents * 0.2 + brushed * 0.05;
  const base = 0.78 - dents * 0.2;
  o.r = base * (1 - grime * 0.5);
  o.g = base * 0.72 * (1 - grime * 0.4);
  o.b = base * 0.28 * (1 - grime * 0.3);
  o.rough = 0.24 + grime * 0.4 + brushed * 0.06;
}

// ivory bone with fine cracks + porous grain
function boneFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const crack = Math.max(0, fbm(u * 7, v * 7, 4) - 0.62) * 2.6;
  const pore = fbm(u * 90, v * 90, 3);
  const stain = fbm(u * 4, v * 4, 3);
  o.h = 0.55 - crack * 0.4 + pore * 0.08;
  const base = 0.72 - stain * 0.22 - crack * 0.5;
  o.r = base;
  o.g = base * 0.95;
  o.b = base * 0.82 - stain * 0.05;
  o.rough = 0.55 + pore * 0.2 + crack * 0.2;
}

// worn dark leather straps
function leatherFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const grain = fbm(u * 60, v * 60, 4);
  const crease = pnoise(u * 6, v * 2.5, 6);
  const wear = Math.max(0, fbm(u * 10, v * 10, 3) - 0.55) * 2;
  o.h = 0.5 + grain * 0.2 - crease * 0.25;
  const base = 0.16 + crease * 0.14 + wear * 0.1;
  o.r = base * 1.15;
  o.g = base * 0.78;
  o.b = base * 0.5;
  o.rough = 0.7 + grain * 0.18 - wear * 0.2;
}

// gaunt weathered skin for the face under the hood (kept dim; lives in shadow)
function skinFields(x, y, size, o) {
  const u = x / size, v = y / size;
  const pore = fbm(u * 110, v * 110, 3);
  const blotch = fbm(u * 6, v * 6, 3);
  o.h = 0.5 + pore * 0.12;
  const base = 0.44 - blotch * 0.12;
  o.r = base * 1.1;
  o.g = base * 0.82;
  o.b = base * 0.7;
  o.rough = 0.62 + pore * 0.16;
}

const FIELD = { cloth: clothFields, iron: ironFields, gold: goldFields, bone: boneFields, leather: leatherFields, skin: skinFields };
const TEX_SIZE = { cloth: 256, iron: 256, gold: 128, bone: 128, leather: 128, skin: 128 };
const _texCache = new Map();

function texSet(kind) {
  let s = _texCache.get(kind);
  if (!s) { s = texFromFields(TEX_SIZE[kind], FIELD[kind]); _texCache.set(kind, s); }
  return s;
}

// Build a character material. Prefer MaterialLab's getMat when it returns a *mapped*
// PBR material (so we inherit the shared look); otherwise fall back to our own maps so
// the character is NEVER an untextured primitive (§5 auto-fail) even if MaterialLab is
// still initialising or stubbed.
export function charMat(kind, { repeat = [1, 1], metalness, roughness, emissive, emissiveIntensity, color } = {}) {
  const alias = { cloth: 'cloth', iron: 'ironBanded', gold: 'gold', bone: 'bone', leather: 'ironBanded', skin: 'bone' };
  let base = null;
  try {
    const shared = getMat(alias[kind]);
    if (shared && shared.isMeshStandardMaterial && shared.map) base = shared.clone();
  } catch { /* MaterialLab not ready — use our own */ }
  if (!base) {
    const t = texSet(kind);
    base = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
    });
    base.normalScale.set(1.1, 1.1);
  }
  const defMetal = kind === 'gold' ? 1.0 : (kind === 'iron' ? 0.92 : 0.0);
  const defRough = kind === 'gold' ? 0.3 : (kind === 'iron' ? 0.5 : 0.85);
  base.metalness = metalness ?? defMetal;
  base.roughness = roughness ?? defRough;
  if (color) base.color.setHex(color);
  if (emissive != null) { base.emissive = new THREE.Color(emissive); base.emissiveIntensity = emissiveIntensity ?? 1; }
  // clone every tiled map before touching .repeat — Material.clone() and our texSet
  // cache both SHARE texture objects, so mutating .repeat here would corrupt tiling for
  // MaterialLab/LevelForge/PropsDress and for our own other parts. Dedupe by source.
  const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
  const cloneCache = new Map();
  for (const s of slots) {
    const tex = base[s]; if (!tex) continue;
    let c = cloneCache.get(tex);
    if (!c) { c = tex.clone(); c.needsUpdate = true; cloneCache.set(tex, c); }
    base[s] = c;
    c.repeat.set(repeat[0], repeat[1]);
  }
  base.shadowSide = THREE.FrontSide;
  return base;
}

// ---------------------------------------------------------------------------
// geometry primitives (all return BufferGeometry in bind-pose local space)
// ---------------------------------------------------------------------------

// Sweep a variable-radius tube along a polyline of nodes. Returns geometry plus, for
// every vertex, the arc-length parameter `s` (0..1 along the whole path) and the index
// of the segment it lives on — the rig uses these to assign skin weights analytically.
export function sweepTube(nodes, { radial = 10, capStart = true, capEnd = true, squash = null, twist = null } = {}) {
  const N = nodes.length;
  const pts = nodes.map(n => new THREE.Vector3(n.x, n.y, n.z));
  const rads = nodes.map(n => n.r);
  const seglen = [];
  let total = 0;
  for (let i = 0; i < N - 1; i++) { const l = pts[i].distanceTo(pts[i + 1]); seglen.push(l); total += l; }
  // per-node tangents
  const tan = [];
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
    tan.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // frame reference
  const up = new THREE.Vector3(0, 0, 1);
  const pos = [], norm = [], uv = [], sArr = [], segArr = [];
  const nml = new THREE.Vector3(), bnl = new THREE.Vector3(), rad = new THREE.Vector3(), nrmv = new THREE.Vector3();
  let arc = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0) arc += seglen[i - 1];
    const s = total > 0 ? arc / total : 0;
    const t = tan[i];
    // Gram-Schmidt frame from a stable up
    let ref = Math.abs(t.dot(up)) > 0.9 ? new THREE.Vector3(1, 0, 0) : up;
    nml.copy(ref).sub(t.clone().multiplyScalar(ref.dot(t))).normalize();
    bnl.crossVectors(t, nml).normalize();
    const rBase = rads[i];
    const sq = nodes[i].sq != null ? nodes[i].sq : (squash ? squash(s) : 1);
    const tw = nodes[i].tw != null ? nodes[i].tw : (twist ? twist(s) : 0);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2 + tw;
      const ca = Math.cos(a), sa = Math.sin(a);
      rad.copy(nml).multiplyScalar(ca * rBase).addScaledVector(bnl, sa * rBase * sq);
      pos.push(pts[i].x + rad.x, pts[i].y + rad.y, pts[i].z + rad.z);
      nrmv.copy(rad).normalize();
      norm.push(nrmv.x, nrmv.y, nrmv.z);
      uv.push(j / radial, s * total * 1.3);
      sArr.push(s);
      segArr.push(Math.min(N - 2, Math.max(0, i - (i === N - 1 ? 1 : 0))));
    }
  }
  const idx = [];
  const ring = radial + 1;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ring + j, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps (flat fans) for the ends
  const addCap = (nodeIdx, flip) => {
    const cx = pts[nodeIdx].x, cy = pts[nodeIdx].y, cz = pts[nodeIdx].z;
    const center = pos.length / 3;
    pos.push(cx, cy, cz);
    const t = tan[nodeIdx];
    norm.push(t.x * (flip ? -1 : 1), t.y * (flip ? -1 : 1), t.z * (flip ? -1 : 1));
    uv.push(0.5, 0.5); sArr.push(nodeIdx === 0 ? 0 : 1); segArr.push(nodeIdx === 0 ? 0 : N - 2);
    const base = nodeIdx * ring;
    for (let j = 0; j < radial; j++) {
      const a = base + j, b = base + j + 1;
      if (flip) idx.push(center, b, a); else idx.push(center, a, b);
    }
  };
  if (capStart) addCap(0, true);
  if (capEnd) addCap(N - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('_s', new THREE.Float32BufferAttribute(sArr, 1));
  g.setAttribute('_seg', new THREE.Float32BufferAttribute(segArr, 1));
  g.setIndex(idx);
  return g;
}

// jagged spike — a tapered pyramid with a slight curve, for pauldrons/hood crest
export function spike(len, base, bend = 0.15) {
  const seg = 5, sides = 5;
  const nodes = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    nodes.push({ x: Math.sin(t * Math.PI * 0.5) * bend * len, y: t * len, z: 0, r: base * (1 - t) * (1 - t) + 0.004 });
  }
  return sweepTube(nodes, { radial: sides, capStart: true, capEnd: false });
}

// broad chipped cleaver blade for the weapon (extruded asymmetric profile)
export function bladeGeo(len, width, thick) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(width * 0.5, len * 0.06);
  shape.lineTo(width * 0.62, len * 0.5);
  shape.lineTo(width * 0.30, len * 0.9);
  shape.lineTo(0, len);                    // point
  shape.lineTo(-width * 0.12, len * 0.85);
  shape.lineTo(-width * 0.18, len * 0.3);
  shape.lineTo(-width * 0.12, 0);
  shape.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.4, bevelSize: thick * 0.5, bevelSegments: 2, steps: 1 });
  g.translate(0, 0, -thick * 0.5);
  g.computeVertexNormals();
  return g;
}

// beveled armour plate box (pauldron cap / boot shell / belt buckle)
export function plate(w, h, d, bevel = 0.02) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // chamfer corners toward centre for a forged look
    const sx = Math.sign(v.x), sy = Math.sign(v.y), sz = Math.sign(v.z);
    if (Math.abs(v.x) > w * 0.4 && Math.abs(v.z) > d * 0.4) { v.x -= sx * bevel; v.z -= sz * bevel; }
    if (Math.abs(v.y) > h * 0.4) v.y -= sy * bevel * 0.5;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// lathe a cowl/hood shell: a half revolve, opened at the front for the face cavity
export function cowl(radius, height, openFront = 0.62) {
  const pts = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = Math.sin(t * Math.PI * 0.62) * radius * (1 - t * 0.15) + 0.01;
    pts.push(new THREE.Vector2(r, t * height));
  }
  const g = new THREE.LatheGeometry(pts, 16, Math.PI * openFront, Math.PI * (2 - openFront * 2) + Math.PI * openFront);
  g.rotateY(Math.PI * (1 - openFront));   // face the opening forward (+Z)
  g.computeVertexNormals();
  return g;
}

export default { charMat, sweepTube, spike, bladeGeo, plate, cowl };

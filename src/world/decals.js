// decals.js — causal weathering + runtime blood for EXILIUM. Owner: PropsDress.
// Projected quads (unit plane, normal +Z) instanced per type, depth-offset + normal-pushed
// to beat z-fighting, oriented to the surface normal with world-up-aligned texture V so
// streaks run DOWN. Weathering is CAUSAL (§4): water runs down walls, moss on shadowed
// faces + crevices, scorch around fire, cracks on walkable paths, blood at deaths.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { EV } from '../core/events.js';

const CAPS = { blood: 110, moss: 300, water: 170, scorch: 190, crack: 300 };

// --- module-scope scratch (zero per-frame / per-placement allocation) ---
const _m4 = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _ref = new THREE.Vector3();
const _scale = new THREE.Vector3(), _col = new THREE.Color();
const _sun = new THREE.Vector3(0.4, -0.8, 0.3).normalize();

let _scene = null, _bus = null;
const meshes = {};          // type -> InstancedMesh
const counts = {};          // type -> live instance count
const ring = { blood: 0 };  // ring-buffer heads for runtime types

// ---------------------------------------------------------------------------
// Procedural RGBA textures (albedo + alpha in one). No external assets.
// ---------------------------------------------------------------------------
function canvas(s = 256) { const c = document.createElement('canvas'); c.width = c.height = s; return c; }
function tex(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }

function bloodTex() {
  const s = 256, c = canvas(s), x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  const cx = s * 0.5, cy = s * 0.44;
  for (let i = 0; i < 5; i++) {
    const r = s * (0.12 + Math.random() * 0.16), a = Math.random() * 6.28, d = Math.random() * s * 0.12;
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
    const g = x.createRadialGradient(px, py, 1, px, py, r);
    g.addColorStop(0, 'rgba(96,10,10,0.95)'); g.addColorStop(0.6, 'rgba(72,7,9,0.8)'); g.addColorStop(1, 'rgba(40,4,6,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 6.28); x.fill();
  }
  // splatter droplets + downward runs
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * 6.28, d = s * (0.16 + Math.random() * 0.32);
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d, r = 1 + Math.random() * 4;
    x.fillStyle = `rgba(${60 + Math.random() * 40 | 0},6,8,${0.4 + Math.random() * 0.5})`;
    x.beginPath(); x.arc(px, py, r, 0, 6.28); x.fill();
  }
  for (let i = 0; i < 6; i++) {
    const px = cx + (Math.random() - 0.5) * s * 0.4, len = s * (0.1 + Math.random() * 0.22);
    x.strokeStyle = 'rgba(60,6,8,0.6)'; x.lineWidth = 2 + Math.random() * 3;
    x.beginPath(); x.moveTo(px, cy); x.lineTo(px + (Math.random() - 0.5) * 8, cy + len); x.stroke();
  }
  return tex(c);
}

function mossTex() {
  const s = 256, c = canvas(s), x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {
    const px = Math.random() * s, py = Math.random() * s;
    const d = Math.hypot(px - s / 2, py - s / 2) / (s * 0.5);
    if (Math.random() < d * d) continue;
    const g = 70 + Math.random() * 80, r = g * (0.4 + Math.random() * 0.3), b = g * 0.4;
    x.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${0.5 * (1 - d)})`;
    x.beginPath(); x.arc(px, py, 1 + Math.random() * 3.5, 0, 6.28); x.fill();
  }
  return tex(c);
}

function waterTex() {
  const s = 256, c = canvas(s), x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  for (let i = 0; i < 26; i++) {
    const px = Math.random() * s, w = 2 + Math.random() * 10, top = Math.random() * s * 0.3, len = s * (0.4 + Math.random() * 0.6);
    const g = x.createLinearGradient(px, top, px, top + len);
    g.addColorStop(0, 'rgba(30,40,44,0)'); g.addColorStop(0.3, 'rgba(22,32,38,0.5)'); g.addColorStop(1, 'rgba(14,22,28,0.72)');
    x.fillStyle = g; x.fillRect(px - w / 2, top, w, len);
  }
  return tex(c);
}

function scorchTex() {
  const s = 256, c = canvas(s), x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  const g = x.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(6,5,5,0.9)'); g.addColorStop(0.5, 'rgba(14,10,9,0.7)'); g.addColorStop(1, 'rgba(20,15,12,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 120; i++) { const a = Math.random() * 6.28, d = s * (0.1 + Math.random() * 0.38); x.fillStyle = `rgba(4,4,4,${0.3 + Math.random() * 0.4})`; x.beginPath(); x.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, 1 + Math.random() * 5, 0, 6.28); x.fill(); }
  return tex(c);
}

function crackTex() {
  const s = 256, c = canvas(s), x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  x.strokeStyle = 'rgba(8,8,10,0.85)'; x.lineCap = 'round';
  const branch = (px, py, ang, len, w) => {
    if (len < 6) return;
    const nx = px + Math.cos(ang) * len, ny = py + Math.sin(ang) * len;
    x.lineWidth = w; x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
    branch(nx, ny, ang + (Math.random() - 0.5) * 0.9, len * 0.7, w * 0.7);
    if (Math.random() < 0.6) branch(nx, ny, ang + (Math.random() - 0.5) * 1.6, len * 0.55, w * 0.6);
  };
  for (let i = 0; i < 3; i++) branch(s / 2 + (Math.random() - 0.5) * 40, s / 2 + (Math.random() - 0.5) * 40, Math.random() * 6.28, 30 + Math.random() * 30, 2.5 + Math.random() * 1.5);
  return tex(c);
}

// One lit, shadow-receiving, depth-offset decal material per type.
function decalMat(map, { rough = 0.9, metal = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map, transparent: true, roughness: rough, metalness: metal,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    side: THREE.DoubleSide, alphaTest: 0.02,
  });
  if (World.registerCSMMaterial) try { World.registerCSMMaterial(m); } catch (e) {}
  return m;
}

const QUAD = new THREE.PlaneGeometry(1, 1);

function makeMesh(type, map, order, opts) {
  const mesh = new THREE.InstancedMesh(QUAD, decalMat(map, opts), CAPS[type]);
  mesh.count = 0; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
  mesh.renderOrder = order;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  meshes[type] = mesh; counts[type] = 0;
  _scene.add(mesh);
  return mesh;
}

// Orient a unit quad: plane +Z -> surface normal n, plane +Y -> world-up projected (down-runs),
// optional roll for radial textures. Writes _m4; scale (sx,sy) then push off along normal.
function place(type, px, py, pz, nx, ny, nz, sx, sy, roll, r, g, b, off = 0.02) {
  const mesh = meshes[type]; if (!mesh) return;
  _z.set(nx, ny, nz).normalize();
  if (Math.abs(_z.y) > 0.94) _ref.set(0, 0, 1); else _ref.set(0, 1, 0);
  _x.crossVectors(_ref, _z).normalize();
  _y.crossVectors(_z, _x).normalize();
  if (roll) {
    const cs = Math.cos(roll), sn = Math.sin(roll);
    const xx = _x.x * cs + _y.x * sn, xy = _x.y * cs + _y.y * sn, xz = _x.z * cs + _y.z * sn;
    const yx = -_x.x * sn + _y.x * cs, yy = -_x.y * sn + _y.y * cs, yz = -_x.z * sn + _y.z * cs;
    _x.set(xx, xy, xz); _y.set(yx, yy, yz);
  }
  _m4.makeBasis(_x, _y, _z);
  _m4.scale(_scale.set(sx, sy, 1));
  _m4.setPosition(px + _z.x * off, py + _z.y * off, pz + _z.z * off);
  let idx;
  if (type === 'blood') { idx = ring.blood; ring.blood = (ring.blood + 1) % CAPS.blood; if (counts.blood < CAPS.blood) counts.blood++; }
  else { if (counts[type] >= CAPS[type]) return; idx = counts[type]++; }
  mesh.setMatrixAt(idx, _m4);
  mesh.setColorAt(idx, _col.setRGB(r, g, b));
  mesh.count = counts[type];
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Public API — driven by props.js (init/placement) + the bus (runtime blood).
// ---------------------------------------------------------------------------
export function initDecals(scene, bus) {
  disposeDecals();
  _scene = scene; _bus = bus;
  makeMesh('scorch', scorchTex(), 1, { rough: 0.95 });
  makeMesh('crack', crackTex(), 1, { rough: 0.95 });
  makeMesh('moss', mossTex(), 2, { rough: 0.85 });
  makeMesh('water', waterTex(), 2, { rough: 0.28 });   // wet: lower roughness + dark albedo (§4)
  makeMesh('blood', bloodTex(), 3, { rough: 0.55 });
  if (World.sunDir) _sun.copy(World.sunDir).multiplyScalar(-1).normalize(); // sun->surface dir
  // Runtime blood on combat (self-driven; other systems need not call us).
  bus.on(EV.DAMAGE_DEALT, (p) => { if (p?.pos && p.type !== 'dot') addBlood(p.pos, 0.55 + Math.random() * 0.4, false); });
  bus.on(EV.ENTITY_DIED, (p) => { const pos = p?.pos || p?.entity?.pos; if (pos && p?.entity?.kind !== 'prop') addBlood(pos, 1.3 + Math.random() * 0.7, true); });
}

// Static causal placement. Called once by props.js after it has classified the level.
// floorCells: [{x,y,z,open}], wallCells: [{x,y,z,nx,nz}], lightSpots: [{x,y,z}], graveSpots:[{x,y,z}]
export function placeStaticDecals({ floorCells = [], wallCells = [], lightSpots = [], graveSpots = [], propSpots = [], rng = Math.random }) {
  // Scorch rings under fire sources.
  for (const s of lightSpots) {
    const sc = 1.1 + rng() * 1.4;
    place('scorch', s.x, s.y + 0.01, s.z, 0, 1, 0, sc, sc, rng() * 6.28, 0.9, 0.85, 0.8);
    for (let k = 0; k < 2; k++) if (rng() < 0.6) { const a = rng() * 6.28, d = 0.6 + rng() * 0.9, ss = 0.4 + rng() * 0.5; place('scorch', s.x + Math.cos(a) * d, s.y + 0.01, s.z + Math.sin(a) * d, 0, 1, 0, ss, ss, rng() * 6.28, 0.9, 0.85, 0.8); }
  }
  // Cracks on walkable/open floor (wear on trodden surfaces).
  for (const f of floorCells) {
    if (!f.open || rng() > 0.16) continue;
    const sc = 0.9 + rng() * 1.6;
    place('crack', f.x, f.y + 0.008, f.z, 0, 1, 0, sc, sc, rng() * 6.28, 0.8, 0.8, 0.82);
  }
  // Dried blood near graves/spawns.
  for (const g of graveSpots) { const a = rng() * 6.28, d = rng() * 1.0, sc = 0.8 + rng() * 0.9; place('blood', g.x + Math.cos(a) * d, g.y + 0.006, g.z + Math.sin(a) * d, 0, 1, 0, sc, sc, rng() * 6.28, 0.42, 0.3, 0.3); }
  // Wall weathering: water streaks + moss on shadowed faces + crevice moss on floor at wall base.
  for (const w of wallCells) {
    const shadowed = (w.nx * _sun.x + w.nz * _sun.z) < 0.1; // face turned from sun
    if (rng() < 0.4) { const sc = 1.2 + rng() * 1.4; place('water', w.x, w.y + 0.6, w.z, w.nx, 0, w.nz, sc * 0.8, sc * 1.8, 0, 0.6, 0.7, 0.75, 0.03); }
    if (shadowed && rng() < 0.5) { const sc = 0.9 + rng() * 1.3; place('moss', w.x, w.y + rng() * 1.4, w.z, w.nx, 0, w.nz, sc, sc, 0, 0.7, 1.0, 0.6, 0.03); }
    if (rng() < 0.45) { const sc = 0.8 + rng() * 1.0; place('moss', w.x - w.nx * 0.2, w.y + 0.02, w.z - w.nz * 0.2, 0, 1, 0, sc, sc, rng() * 6.28, 0.75, 1.0, 0.65); }
  }
  // Prop-base weathering (§5): heavy settled props crack the floor they rest on, gather
  // grime rings, and grow moss in the crevice at their foot. Reuses existing decal meshes.
  for (const p of propSpots) {
    const r = p.r || 0.5;
    // settling cracks radiating from the base
    if (rng() < 0.7) { const a = rng() * 6.28, d = r * (0.7 + rng() * 0.5), sc = 0.8 + rng() * 1.1; place('crack', p.x + Math.cos(a) * d, p.y + 0.008, p.z + Math.sin(a) * d, 0, 1, 0, sc, sc, rng() * 6.28, 0.8, 0.8, 0.82); }
    // grime/dirt accumulation ring (dark-tinted moss quads read as ground-in dirt)
    const grime = 1 + (rng() * 2 | 0);
    for (let k = 0; k < grime; k++) { const a = rng() * 6.28, d = r * (0.5 + rng() * 0.6), sc = 0.6 + rng() * 0.8; place('moss', p.x + Math.cos(a) * d, p.y + 0.006, p.z + Math.sin(a) * d, 0, 1, 0, sc, sc, rng() * 6.28, 0.5, 0.44, 0.34); }
    // crevice moss hugging the base of hero props (damp shadowed foot)
    if (p.hero && rng() < 0.7) { const a = rng() * 6.28, d = r * 0.7, sc = 0.7 + rng() * 0.9; place('moss', p.x + Math.cos(a) * d, p.y + 0.012, p.z + Math.sin(a) * d, 0, 1, 0, sc, sc, rng() * 6.28, 0.68, 1.0, 0.6); }
  }
}

// Runtime blood — pos:Vector3, scale, fresh(bright red)|dried(dark).
export function addBlood(pos, scale = 1, fresh = true) {
  const y = World.level?.heightAt ? World.level.heightAt(pos.x, pos.z) : pos.y;
  const r = fresh ? 0.62 : 0.4, g = fresh ? 0.06 : 0.06, b = fresh ? 0.08 : 0.07;
  place('blood', pos.x, y + 0.006, pos.z, 0, 1, 0, scale, scale, Math.random() * 6.28, r, g, b);
}

export function disposeDecals() {
  for (const k in meshes) { const m = meshes[k]; if (!m) continue; _scene?.remove(m); m.material.map?.dispose(); m.material.dispose(); m.dispose(); delete meshes[k]; }
  for (const k in counts) delete counts[k];
  ring.blood = 0;
}

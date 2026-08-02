// rig.js — procedural skinned exile: real skeleton, analytic skin weights (no
// candy-wrapper twisting), a merged SkinnedMesh body, a hand-parented weapon, and
// verlet cloth for the cloak + belt sash. Owner: CharacterRig.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { charMat, sweepTube, spike, bladeGeo, plate, cowl } from '../gen/charactergen.js';

// ---------------------------------------------------------------------------
// Skeleton definition — world bind positions, feet at y=0, character faces +Z.
// name, parent, [x,y,z], childForTail (bone whose head is this bone's tail; null = leaf)
// ---------------------------------------------------------------------------
const BONES = [
  ['pelvis',    null,      0.00, 0.95, 0.00,  'spine01'],
  ['spine01',   'pelvis',  0.00, 1.10, 0.00,  'spine02'],
  ['spine02',   'spine01', 0.00, 1.28, 0.00,  'chest'],
  ['chest',     'spine02', 0.00, 1.46, -0.01, 'neck'],
  ['neck',      'chest',   0.00, 1.60, -0.02, 'head'],
  ['head',      'neck',    0.00, 1.72, 0.01,  null],
  ['clavicleL', 'chest',   0.07, 1.54, 0.00,  'upperArmL'],
  ['upperArmL', 'clavicleL', 0.21, 1.52, 0.00, 'lowerArmL'],
  ['lowerArmL', 'upperArmL', 0.27, 1.28, 0.02, 'handL'],
  ['handL',     'lowerArmL', 0.31, 1.05, 0.04, null],
  ['clavicleR', 'chest',  -0.07, 1.54, 0.00,  'upperArmR'],
  ['upperArmR', 'clavicleR', -0.21, 1.52, 0.00, 'lowerArmR'],
  ['lowerArmR', 'upperArmR', -0.27, 1.28, 0.02, 'handR'],
  ['handR',     'lowerArmR', -0.31, 1.05, 0.04, null],
  ['thighL',    'pelvis',  0.10, 0.92, 0.00,  'shinL'],
  ['shinL',     'thighL',  0.11, 0.50, 0.01,  'footL'],
  ['footL',     'shinL',   0.11, 0.08, -0.02, 'toeL'],
  ['toeL',      'footL',   0.11, 0.03, 0.13,  null],
  ['thighR',    'pelvis', -0.10, 0.92, 0.00,  'shinR'],
  ['shinR',     'thighR', -0.11, 0.50, 0.01,  'footR'],
  ['footR',     'shinR',  -0.11, 0.08, -0.02, 'toeR'],
  ['toeR',      'footR',  -0.11, 0.03, 0.13,  null],
];

function buildSkeleton() {
  const idx = new Map();
  BONES.forEach((b, i) => idx.set(b[0], i));
  const head = BONES.map(b => new THREE.Vector3(b[2], b[3], b[4]));
  // tail per bone: child head, or extrapolate along (head - parentHead)
  const tail = BONES.map((b, i) => {
    if (b[5]) return head[idx.get(b[5])].clone();
    const p = b[1] ? head[idx.get(b[1])] : head[i];
    return head[i].clone().add(new THREE.Vector3().subVectors(head[i], p).setLength(0.13));
  });
  const bones = BONES.map(() => new THREE.Bone());
  BONES.forEach((b, i) => {
    bones[i].name = b[0];
    const local = b[1] ? head[i].clone().sub(head[idx.get(b[1])]) : head[i].clone();
    bones[i].position.copy(local);
  });
  BONES.forEach((b, i) => { if (b[1]) bones[idx.get(b[1])].add(bones[i]); });
  bones[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const boneOf = (n) => idx.get(n);
  return { skeleton, bones, idx, head, tail, boneOf };
}

// ---------------------------------------------------------------------------
// analytic skinning: weight vertices to bone SEGMENTS by inverse-distance^p,
// keep top-4, normalise. Restricting candidate segments per body part is what
// prevents arm bones bleeding into torso verts (the candy-wrapper bug).
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3(), _ab = new THREE.Vector3(), _ap = new THREE.Vector3();
function distToSeg(px, py, pz, a, b) {
  _ab.subVectors(b, a); _ap.set(px - a.x, py - a.y, pz - a.z);
  const t = THREE.MathUtils.clamp(_ap.dot(_ab) / Math.max(1e-6, _ab.dot(_ab)), 0, 1);
  _v.copy(a).addScaledVector(_ab, t);
  return Math.hypot(px - _v.x, py - _v.y, pz - _v.z);
}
function weightBlend(geo, segs, p = 3.2) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const cand = segs.map(() => 0);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < segs.length; c++) {
      const d = distToSeg(pos.getX(i), pos.getY(i), pos.getZ(i), segs[c].a, segs[c].b);
      cand[c] = 1 / Math.pow(Math.max(0.012, d), p);
    }
    // top-4
    let i0 = -1, i1 = -1, i2 = -1, i3 = -1, w0 = 0, w1 = 0, w2 = 0, w3 = 0;
    for (let c = 0; c < segs.length; c++) {
      const w = cand[c];
      if (w > w0) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w0; i1 = i0; w0 = w; i0 = c; }
      else if (w > w1) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w; i1 = c; }
      else if (w > w2) { w3 = w2; i3 = i2; w2 = w; i2 = c; }
      else if (w > w3) { w3 = w; i3 = c; }
    }
    const sum = w0 + w1 + w2 + w3 || 1;
    const o = i * 4;
    si[o] = segs[i0]?.bone ?? 0; sw[o] = w0 / sum;
    si[o + 1] = i1 >= 0 ? segs[i1].bone : 0; sw[o + 1] = w1 / sum;
    si[o + 2] = i2 >= 0 ? segs[i2].bone : 0; sw[o + 2] = w2 / sum;
    si[o + 3] = i3 >= 0 ? segs[i3].bone : 0; sw[o + 3] = w3 / sum;
  }
  applyWeights(geo, si, sw);
}
function weightSingle(geo, bone) {
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = bone; sw[i * 4] = 1; }
  applyWeights(geo, si, sw);
}
function applyWeights(geo, si, sw) {
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.deleteAttribute('_s'); geo.deleteAttribute('_seg');
  if (geo.attributes.uv1) geo.deleteAttribute('uv1');
}

// ---------------------------------------------------------------------------
// verlet cloth — a pinned grid simulated in WORLD space, colliding against the
// body capsule, reacting to movement/turn/roll inertia. Sells weight at distance.
// ---------------------------------------------------------------------------
const _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3(), _seg = new THREE.Vector3();
export class Cloth {
  constructor({ cols, rows, width, height, mat, anchorBone, anchorOffsets, gravity = -8.5, stiffness = 3, drag = 0.86 }) {
    this.cols = cols; this.rows = rows;
    this.n = cols * rows;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.pinned = new Uint8Array(this.n);
    this.gravity = gravity; this.stiff = stiffness; this.drag = drag;
    this.anchorBone = anchorBone;               // THREE.Bone the top row hangs from
    this.anchorOffsets = anchorOffsets;         // Vector3[] bone-local, one per top-row col
    this.rest = { x: width / (cols - 1), y: height / (rows - 1) };
    this.restD = Math.hypot(this.rest.x, this.rest.y);
    this._impulse = new THREE.Vector3();
    this._built = false;

    const g = new THREE.PlaneGeometry(width, height, cols - 1, rows - 1);
    g.attributes.position.setUsage(THREE.DynamicDrawUsage);
    // remap so vertex order matches our grid indexing (row-major from top)
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;         // we write world verts directly
  }
  idx(c, r) { return r * this.cols + c; }
  // seed positions once we know where the anchor is
  _seed() {
    this.anchorBone.updateWorldMatrix(true, false);
    for (let c = 0; c < this.cols; c++) {
      _tmp.copy(this.anchorOffsets[c]).applyMatrix4(this.anchorBone.matrixWorld);
      for (let r = 0; r < this.rows; r++) {
        const i = this.idx(c, r);
        const px = _tmp.x, py = _tmp.y - r * this.rest.y, pz = _tmp.z + r * this.rest.y * 0.35;
        this.pos[i * 3] = this.prev[i * 3] = px;
        this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = py;
        this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = pz;
      }
    }
    this._built = true;
  }
  addImpulse(v) { this._impulse.add(v); }
  update(dt, ctx) {
    if (!this._built) this._seed();
    dt = Math.min(dt, 1 / 30);
    const { capA, capB, capR, wind, ground } = ctx;
    this.anchorBone.updateWorldMatrix(true, false);
    // pin top row to bone
    for (let c = 0; c < this.cols; c++) {
      _tmp.copy(this.anchorOffsets[c]).applyMatrix4(this.anchorBone.matrixWorld);
      const i = this.idx(c, 0) * 3;
      this.pos[i] = _tmp.x; this.pos[i + 1] = _tmp.y; this.pos[i + 2] = _tmp.z;
      this.prev[i] = _tmp.x; this.prev[i + 1] = _tmp.y; this.prev[i + 2] = _tmp.z;
    }
    // verlet integrate free particles
    const g = this.gravity * dt * dt;
    const imx = this._impulse.x * dt, imy = this._impulse.y * dt, imz = this._impulse.z * dt;
    for (let r = 1; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = this.idx(c, r) * 3;
        const vx = (this.pos[i] - this.prev[i]) * this.drag;
        const vy = (this.pos[i + 1] - this.prev[i + 1]) * this.drag;
        const vz = (this.pos[i + 2] - this.prev[i + 2]) * this.drag;
        this.prev[i] = this.pos[i]; this.prev[i + 1] = this.pos[i + 1]; this.prev[i + 2] = this.pos[i + 2];
        const sway = wind * Math.sin((this.pos[i + 1] + this.pos[i]) * 2.3 + ctx.t * 2.1) * r * 0.0006;
        this.pos[i] += vx + imx + sway;
        this.pos[i + 1] += vy + g + imy;
        this.pos[i + 2] += vz + imz + wind * 0.0004 * r;
      }
    }
    // constraint relaxation
    for (let it = 0; it < this.stiff; it++) {
      // structural: horizontal + vertical
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (c < this.cols - 1) this._constrain(this.idx(c, r), this.idx(c + 1, r), this.rest.x);
          if (r < this.rows - 1) this._constrain(this.idx(c, r), this.idx(c, r + 1), this.rest.y);
        }
      }
      // shear (diagonals) so it holds a drape instead of collapsing
      for (let r = 0; r < this.rows - 1; r++)
        for (let c = 0; c < this.cols - 1; c++)
          this._constrain(this.idx(c, r), this.idx(c + 1, r + 1), this.restD);
      // collide vs body capsule + floor
      for (let r = 1; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) this._collide(this.idx(c, r) * 3, capA, capB, capR, ground);
    }
    this._impulse.multiplyScalar(0.35);
    // write verts (world space, mesh matrix is identity)
    const arr = this.geo.attributes.position.array;
    for (let i = 0; i < this.n; i++) { arr[i * 3] = this.pos[i * 3]; arr[i * 3 + 1] = this.pos[i * 3 + 1]; arr[i * 3 + 2] = this.pos[i * 3 + 2]; }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
  _constrain(ia, ib, rest) {
    const a = ia * 3, b = ib * 3;
    _seg.set(this.pos[b] - this.pos[a], this.pos[b + 1] - this.pos[a + 1], this.pos[b + 2] - this.pos[a + 2]);
    const d = _seg.length() || 1e-6;
    const diff = (d - rest) / d * 0.5;
    const ox = _seg.x * diff, oy = _seg.y * diff, oz = _seg.z * diff;
    const pa = this.pinned[ia], pb = this.pinned[ib];
    if (!pa) { this.pos[a] += ox; this.pos[a + 1] += oy; this.pos[a + 2] += oz; }
    if (!pb) { this.pos[b] -= ox; this.pos[b + 1] -= oy; this.pos[b + 2] -= oz; }
  }
  _collide(i, capA, capB, capR, ground) {
    // push out of vertical body capsule
    const d = distToSeg(this.pos[i], this.pos[i + 1], this.pos[i + 2], capA, capB);
    if (d < capR) {
      _ab.subVectors(capB, capA); _ap.set(this.pos[i] - capA.x, this.pos[i + 1] - capA.y, this.pos[i + 2] - capA.z);
      const t = THREE.MathUtils.clamp(_ap.dot(_ab) / Math.max(1e-6, _ab.dot(_ab)), 0, 1);
      _v.copy(capA).addScaledVector(_ab, t);
      _tmp2.set(this.pos[i] - _v.x, 0, this.pos[i + 2] - _v.z);
      if (_tmp2.lengthSq() < 1e-7) _tmp2.set(0, 0, -1);
      _tmp2.normalize().multiplyScalar(capR);
      this.pos[i] = _v.x + _tmp2.x; this.pos[i + 2] = _v.z + _tmp2.z;
    }
    if (this.pos[i + 1] < ground + 0.01) this.pos[i + 1] = ground + 0.01;
  }
  dispose() { this.geo.dispose(); }
}

// ---------------------------------------------------------------------------
// full assembly
// ---------------------------------------------------------------------------
export function buildExile() {
  const sk = buildSkeleton();
  const { skeleton, bones, head, tail, boneOf } = sk;
  const S = (name) => ({ a: head[boneOf(name)], b: tail[boneOf(name)], bone: boneOf(name) });

  const M = {
    cloth: charMat('cloth', { repeat: [2, 3] }),
    iron:  charMat('iron',  { repeat: [1, 1.5] }),
    gold:  charMat('gold',  { repeat: [1, 1] }),
    bone:  charMat('bone',  { repeat: [1, 1] }),
    leather: charMat('leather', { repeat: [1, 2] }),
    skin:  charMat('skin',  { repeat: [1, 1] }),
  };

  const parts = [];      // { geo, mat }
  const add = (geo, mat) => parts.push({ geo, mat });

  // --- torso robe (broad forged silhouette, cloth) ---
  const torso = sweepTube([
    { x: 0, y: 0.92, z: 0, r: 0.155, sq: 1.28 },
    { x: 0, y: 1.10, z: 0, r: 0.135, sq: 1.05 },
    { x: 0, y: 1.28, z: 0, r: 0.16, sq: 1.25 },
    { x: 0, y: 1.46, z: -0.01, r: 0.185, sq: 1.55 },
    { x: 0, y: 1.58, z: -0.02, r: 0.1, sq: 1.2 },
    { x: 0, y: 1.66, z: 0, r: 0.05, sq: 1.0 },
  ], { radial: 14 });
  weightBlend(torso, [S('pelvis'), S('spine01'), S('spine02'), S('chest'), S('neck')]);
  add(torso, M.cloth);

  // --- layered iron chest plate over the robe (asymmetric, one shoulder heavier) ---
  const chestPlate = plate(0.34, 0.26, 0.20, 0.03);
  chestPlate.translate(0, 1.40, 0.02);
  weightBlend(chestPlate, [S('chest'), S('spine02')]);
  add(chestPlate, M.iron);
  const gorget = plate(0.16, 0.06, 0.14, 0.02); gorget.translate(0, 1.56, 0.02);
  weightSingle(gorget, boneOf('chest')); add(gorget, M.gold);

  // --- legs ---
  for (const s of ['L', 'R']) {
    const sign = s === 'L' ? 1 : -1;
    const leg = sweepTube([
      { x: sign * 0.10, y: 0.94, z: 0, r: 0.11 },
      { x: sign * 0.11, y: 0.50, z: 0.01, r: 0.085 },
      { x: sign * 0.11, y: 0.10, z: -0.02, r: 0.07 },
    ], { radial: 10 });
    weightBlend(leg, [S('pelvis'), S('thigh' + s), S('shin' + s), S('foot' + s)]);
    add(leg, M.cloth);
    // chunky boot
    const boot = plate(0.13, 0.12, 0.24, 0.02);
    boot.translate(sign * 0.11, 0.06, 0.04);
    weightBlend(boot, [S('foot' + s), S('toe' + s)]);
    add(boot, M.iron);
    // boot buckle
    const bk = plate(0.1, 0.03, 0.04, 0.01); bk.translate(sign * 0.11, 0.12, 0.16);
    weightSingle(bk, boneOf('foot' + s)); add(bk, M.gold);
  }

  // --- arms (start at shoulder, taper to wrist) ---
  for (const s of ['L', 'R']) {
    const sign = s === 'L' ? 1 : -1;
    const arm = sweepTube([
      { x: sign * 0.21, y: 1.53, z: 0, r: 0.075 },
      { x: sign * 0.27, y: 1.28, z: 0.02, r: 0.062 },
      { x: sign * 0.31, y: 1.05, z: 0.04, r: 0.05 },
    ], { radial: 9 });
    weightBlend(arm, [S('clavicle' + s), S('upperArm' + s), S('lowerArm' + s), S('hand' + s)]);
    add(arm, M.cloth);
    // forearm bracer
    const br = plate(0.1, 0.16, 0.1, 0.02);
    br.translate(sign * 0.29, 1.16, 0.03);
    weightSingle(br, boneOf('lowerArm' + s)); add(br, M.iron);
    // glove/fist
    const gl = plate(0.08, 0.09, 0.1, 0.015);
    gl.translate(sign * 0.31, 1.0, 0.04);
    weightSingle(gl, boneOf('hand' + s)); add(gl, M.leather);
  }

  // --- head + hood ---
  const skull = new THREE.SphereGeometry(0.1, 14, 12);
  skull.scale(0.92, 1.16, 0.98); skull.translate(0, 1.75, 0.02);
  weightSingle(skull, boneOf('head')); add(skull, M.skin);
  const hood = cowl(0.2, 0.3, 0.6);
  hood.translate(0, 1.58, 0.0);
  weightBlend(hood, [S('head'), S('neck'), S('chest')]);
  add(hood, M.cloth);
  const crest = spike(0.16, 0.028, 0.4);
  crest.rotateX(-0.5); crest.translate(0, 1.86, -0.06);
  weightSingle(crest, boneOf('head')); add(crest, M.iron);

  // --- asymmetric pauldrons (LEFT large + spike, RIGHT small) — the silhouette move ---
  const bigCap = plate(0.2, 0.12, 0.2, 0.03); bigCap.translate(0.24, 1.56, 0);
  weightSingle(bigCap, boneOf('clavicleL')); add(bigCap, M.iron);
  const bigCap2 = plate(0.16, 0.08, 0.16, 0.02); bigCap2.translate(0.25, 1.64, 0);
  weightSingle(bigCap2, boneOf('clavicleL')); add(bigCap2, M.iron);
  const pspike = spike(0.22, 0.04, 0.5); pspike.rotateZ(0.7); pspike.rotateX(-0.2); pspike.translate(0.30, 1.62, 0);
  weightSingle(pspike, boneOf('clavicleL')); add(pspike, M.bone);
  const pgold = plate(0.05, 0.13, 0.16, 0.01); pgold.translate(0.15, 1.55, 0);
  weightSingle(pgold, boneOf('clavicleL')); add(pgold, M.gold);
  const smallCap = plate(0.13, 0.09, 0.15, 0.02); smallCap.translate(-0.22, 1.55, 0);
  weightSingle(smallCap, boneOf('clavicleR')); add(smallCap, M.iron);

  // --- belt + buckle ---
  const belt = new THREE.TorusGeometry(0.17, 0.035, 8, 20); belt.rotateX(Math.PI / 2); belt.scale(1.25, 1, 1); belt.translate(0, 0.98, 0);
  weightSingle(belt, boneOf('pelvis')); add(belt, M.leather);
  const buckle = plate(0.09, 0.08, 0.05, 0.01); buckle.translate(0, 0.98, 0.19);
  weightSingle(buckle, boneOf('pelvis')); add(buckle, M.gold);

  // merge into ONE skinned body (groups -> material array)
  const geos = parts.map(p => (p.geo.index ? p.geo.toNonIndexed() : p.geo));
  const merged = mergeGeometries(geos, true);
  merged.computeBoundingSphere();
  const matArr = parts.map(p => p.mat);
  const body = new THREE.SkinnedMesh(merged, matArr);
  body.castShadow = true; body.receiveShadow = true;
  body.frustumCulled = false;
  body.name = 'exileBody';

  const group = new THREE.Group();
  group.name = 'exile';
  body.add(bones[0]);              // root bone must live in the mesh's subtree
  group.add(body);
  body.bind(skeleton);

  // --- weapon: chipped cleaver, parented to the right hand bone (not skinned) ---
  const weapon = new THREE.Group(); weapon.name = 'weapon';
  const blade = new THREE.Mesh(bladeGeo(0.74, 0.2, 0.03), M.iron.clone());
  blade.castShadow = true;
  const guard = new THREE.Mesh(plate(0.16, 0.04, 0.06, 0.01), M.gold); guard.castShadow = true; guard.position.y = -0.02;
  const grip = new THREE.Mesh(sweepTube([{ x: 0, y: -0.02, z: 0, r: 0.022 }, { x: 0, y: -0.22, z: 0, r: 0.02 }], { radial: 8 }), M.leather);
  grip.castShadow = true;
  const runeMat = M.gold.clone(); runeMat.emissive = new THREE.Color(0xff7a2a); runeMat.emissiveIntensity = 1.6;
  const rune = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), runeMat); rune.position.set(0, 0.24, 0.02);
  weapon.add(blade, guard, grip, rune);
  // seat in the palm: weapon origin sits at the wrist bone; small local offset only.
  weapon.position.set(0.0, 0.02, 0.04);
  weapon.rotation.set(0.7, 0.1, 0.18);
  bones[boneOf('handR')].add(weapon);

  return { group, body, skeleton, bones, boneOf, weapon, mats: M, rune };
}

// build the cloak + belt sash cloths (call after buildExile, given its bones)
export function buildCloths(rig) {
  const clavL = rig.bones[rig.boneOf('clavicleL')];
  const chest = rig.bones[rig.boneOf('chest')];
  const pelvis = rig.bones[rig.boneOf('pelvis')];
  // cape hangs from the upper back — anchor offsets in chest-local space
  const capeCols = 7, capeRows = 9;
  const capeMat = charMat('cloth', { repeat: [2, 3] });
  capeMat.color.multiplyScalar(0.82);        // slightly darker outer cloak
  capeMat.side = THREE.DoubleSide;
  const halfW = 0.44;
  const anchors = [];
  chest.updateWorldMatrix(true, false);
  const invChest = new THREE.Matrix4().copy(chest.matrixWorld).invert();
  for (let c = 0; c < capeCols; c++) {
    const t = c / (capeCols - 1);
    // spread across the shoulders, tucked slightly behind (-z) and up
    _tmp.set((t - 0.5) * halfW * 1.6, 1.52, -0.14).applyMatrix4(invChest);
    anchors.push(_tmp.clone());
  }
  const cape = new Cloth({
    cols: capeCols, rows: capeRows, width: halfW * 1.6, height: 0.95, mat: capeMat,
    anchorBone: chest, anchorOffsets: anchors, gravity: -9.2, stiffness: 4, drag: 0.9,
  });

  // belt sash — a short strip off the front-left of the pelvis
  const sashCols = 3, sashRows = 6;
  const sashMat = charMat('cloth', { repeat: [1, 2] });
  sashMat.color.multiplyScalar(0.7);
  sashMat.side = THREE.DoubleSide;
  pelvis.updateWorldMatrix(true, false);
  const invPel = new THREE.Matrix4().copy(pelvis.matrixWorld).invert();
  const sashAnchors = [];
  for (let c = 0; c < sashCols; c++) {
    _tmp.set(0.02 + (c / (sashCols - 1)) * 0.14, 0.98, 0.16).applyMatrix4(invPel);
    sashAnchors.push(_tmp.clone());
  }
  const sash = new Cloth({
    cols: sashCols, rows: sashRows, width: 0.14, height: 0.5, mat: sashMat,
    anchorBone: pelvis, anchorOffsets: sashAnchors, gravity: -8, stiffness: 3, drag: 0.84,
  });

  return { cape, sash };
}

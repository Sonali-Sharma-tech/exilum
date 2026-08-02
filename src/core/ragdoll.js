// Verlet / position-based-dynamics ragdoll over an entity's bone chain. Spawned
// on death (rubric §7: "death: not a fade-out"). One particle per bone, distance
// constraints hold bone lengths, a per-joint cone limit stops unnatural bending,
// ground collision + damping settle it into a convincing corpse. Bone LOCAL
// transforms are written back each step from the simulated world positions, so
// the existing skinned mesh deforms correctly and no geometry is rebuilt.
//
// Degrades gracefully: no SkinnedMesh / <2 bones -> returns null (never throws),
// and it never crashes if entity.mesh is a plain mesh or missing.
import * as THREE from 'three';
import { groundHeight } from './collision.js';

const DT = 1 / 60;
const GRAVITY = 26;                 // m/s^2 — snappier than earth, ARPG feel
const DAMP = 0.985;                 // velocity retention per step (air drag)
const GROUND_FRICTION = 0.55;       // horizontal velocity kept on ground contact
const CONE = 1.9;                   // max joint bend from parent dir (radians)
const ITER = 4;                     // constraint relaxation passes per step
const SETTLE_EPS = 0.0009;          // per-step motion (sq) below which we sleep
const SETTLE_FRAMES = 26;           // consecutive calm steps before sleeping

// Module-scope scratch — zero allocation inside step().
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pInv = new THREE.Matrix4();
const _mw = new THREE.Matrix4();
const _ml = new THREE.Matrix4();
const _scl = new THREE.Vector3();

function findSkinned(obj) {
  let found = null;
  obj.traverse((o) => { if (!found && o.isSkinnedMesh && o.skeleton) found = o; });
  return found;
}

export class Ragdoll {
  constructor(entity, skinned) {
    this.entity = entity;
    this.mesh = skinned;
    this.alive = true;
    this._settled = false;
    this._calm = 0;

    const bones = skinned.skeleton.bones;
    const n = bones.length;
    this.bones = bones;

    // Ensure every bone world matrix is current before we sample rest state.
    skinned.updateWorldMatrix(true, true);

    // Index bones so parent lookups are O(1).
    const index = new Map();
    for (let i = 0; i < n; i++) index.set(bones[i], i);

    this.parent = new Int32Array(n);       // parent bone index or -1
    this.child = new Int32Array(n);        // primary child bone index or -1
    this.pos = new Array(n);
    this.prev = new Array(n);
    this.restQuat = new Array(n);          // bone world quat at rest
    this.restFwd = new Array(n);           // unit dir bone->child at rest
    this.baseScale = new Array(n);         // preserved local scale
    this.constraints = [];                 // [aIdx, bIdx, restLen]

    for (let i = 0; i < n; i++) {
      const b = bones[i];
      const p = index.has(b.parent) ? index.get(b.parent) : -1;
      this.parent[i] = p;
      this.child[i] = -1;
      this.pos[i] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      this.prev[i] = this.pos[i].clone();
      this.restQuat[i] = new THREE.Quaternion();
      b.matrixWorld.decompose(_a, this.restQuat[i], _b);
      this.restFwd[i] = new THREE.Vector3(0, 1, 0);
      this.baseScale[i] = b.scale.clone();
    }
    // Wire primary child (first child bone) + distance constraints.
    for (let i = 0; i < n; i++) {
      const p = this.parent[i];
      if (p >= 0) {
        if (this.child[p] < 0) this.child[p] = i;
        this.constraints.push(p, i, this.pos[p].distanceTo(this.pos[i]));
      }
    }
    // Rest forward = dir from bone to its primary child (in world space).
    for (let i = 0; i < n; i++) {
      const ci = this.child[i];
      if (ci >= 0) {
        _a.copy(this.pos[ci]).sub(this.pos[i]);
        if (_a.lengthSq() > 1e-8) this.restFwd[i].copy(_a).normalize();
      }
    }

    // Writeback order: parents before children (by hierarchy depth).
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const depth = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let d = 0, p = this.parent[i];
      while (p >= 0) { d++; p = this.parent[p]; }
      depth[i] = d;
    }
    this.order.sort((x, y) => depth[x] - depth[y]);

    // Give death a shove: inherit the entity's velocity + a small upward pop.
    const v = entity.vel;
    for (let i = 0; i < n; i++) {
      if (v) this.prev[i].copy(this.pos[i]).addScaledVector(v, -DT);
      this.prev[i].y -= 0.02;
    }
    entity.ragdolling = true;
  }

  get settled() { return this._settled; }

  step() {
    if (!this.alive || this._settled) return;
    const n = this.bones.length;
    let motion = 0;

    // 1) Verlet integrate.
    for (let i = 0; i < n; i++) {
      const p = this.pos[i], pr = this.prev[i];
      _a.copy(p).sub(pr).multiplyScalar(DAMP);   // velocity * damping
      pr.copy(p);
      p.add(_a);
      p.y -= GRAVITY * DT * DT;
    }

    // 2) Relax constraints (distance + joint cone) several passes.
    for (let it = 0; it < ITER; it++) {
      const cs = this.constraints;
      for (let k = 0; k < cs.length; k += 3) {
        const a = this.pos[cs[k]], b = this.pos[cs[k + 1]], rest = cs[k + 2];
        _a.copy(b).sub(a);
        const d = _a.length();
        if (d > 1e-6) {
          const diff = (d - rest) / d * 0.5;
          _a.multiplyScalar(diff);
          a.add(_a); b.sub(_a);
        }
      }
      // Cone limit: keep each segment within CONE of its parent segment dir.
      for (let i = 0; i < n; i++) {
        const p = this.parent[i], gp = p >= 0 ? this.parent[p] : -1;
        if (p < 0 || gp < 0) continue;
        _a.copy(this.pos[p]).sub(this.pos[gp]);     // parent segment dir
        _b.copy(this.pos[i]).sub(this.pos[p]);      // this segment dir
        const la = _a.length(), lb = _b.length();
        if (la < 1e-5 || lb < 1e-5) continue;
        _a.multiplyScalar(1 / la); _b.multiplyScalar(1 / lb);
        let dot = _a.dot(_b); if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
        const ang = Math.acos(dot);
        if (ang > CONE) {
          _axis.copy(_a).cross(_b);
          if (_axis.lengthSq() < 1e-8) _axis.set(0, 0, 1); else _axis.normalize();
          _q.setFromAxisAngle(_axis, CONE);
          _c.copy(_a).applyQuaternion(_q).multiplyScalar(lb);   // clamped dir
          this.pos[i].copy(this.pos[p]).add(_c);
        }
      }
    }

    // 3) Ground collision + friction.
    for (let i = 0; i < n; i++) {
      const p = this.pos[i], pr = this.prev[i];
      const g = groundHeight(p.x, p.z) + 0.05;
      if (p.y < g) {
        p.y = g;
        pr.x += (p.x - pr.x) * (1 - GROUND_FRICTION);
        pr.z += (p.z - pr.z) * (1 - GROUND_FRICTION);
        if (pr.y > p.y) pr.y = p.y;   // kill downward carry
      }
    }

    // 4) Write bone local transforms from world particle positions, parents first.
    for (let oi = 0; oi < n; oi++) {
      const i = this.order[oi];
      const b = this.bones[i];
      const ci = this.child[i];

      if (ci >= 0) {
        _fwd.copy(this.pos[ci]).sub(this.pos[i]);
        if (_fwd.lengthSq() > 1e-8) {
          _fwd.normalize(); _rest.copy(this.restFwd[i]);
          _q.setFromUnitVectors(_rest, _fwd);          // delta rest->current
          _q2.copy(_q).multiply(this.restQuat[i]);     // target world quat
        } else _q2.copy(this.restQuat[i]);
      } else {
        _q2.copy(this.restQuat[i]);                    // leaf: keep rest orient
      }

      // Compose target world matrix, convert to local via parent's world matrix.
      _mw.compose(this.pos[i], _q2, this.baseScale[i]);
      const par = b.parent;
      if (par) { _pInv.copy(par.matrixWorld).invert(); _ml.multiplyMatrices(_pInv, _mw); }
      else _ml.copy(_mw);
      _ml.decompose(b.position, b.quaternion, _scl);
      b.updateWorldMatrix(false, false);               // refresh for children
    }

    // 5) Settle detection.
    for (let i = 0; i < n; i++) {
      _a.copy(this.pos[i]).sub(this.prev[i]);
      motion += _a.lengthSq();
    }
    motion /= n;
    if (motion < SETTLE_EPS) { if (++this._calm >= SETTLE_FRAMES) this._settled = true; }
    else this._calm = 0;
  }

  remove() { this.alive = false; }
}

/** Build a ragdoll from an entity's skinned skeleton, or null if it has none. */
export function makeRagdoll(entity) {
  try {
    const root = entity && entity.mesh;
    if (!root || typeof root.traverse !== 'function') return null;
    const skinned = findSkinned(root);
    if (!skinned || !skinned.skeleton || !skinned.skeleton.bones ||
        skinned.skeleton.bones.length < 2) return null;
    return new Ragdoll(entity, skinned);
  } catch (e) {
    console.error('[physics] ragdoll build failed', e);
    return null;
  }
}

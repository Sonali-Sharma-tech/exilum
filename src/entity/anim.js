// anim.js — hand-keyframed animation for the exile. Owner: CharacterRig.
// §8 targets: NO linear interpolation on organic motion (sparse pose keys are baked
// into dense samples shaped by easing functions); weight & momentum (distance-driven
// stride so feet plant, torso counter-rotation vs hips); always-present additive
// breathing/sway/head-look; smooth directional turn lean; cloth handled by rig.Cloth.
// A guarded 2-bone foot-lock IK pins the planted foot so it can't slide on the ground.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// easing (organic — never constant-velocity)
// ---------------------------------------------------------------------------
const EASE = {
  linear: t => t,
  io: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  out: t => 1 - (1 - t) * (1 - t),
  in: t => t * t,
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic: t => t * t * t,
  back: t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

// ---------------------------------------------------------------------------
// clip authoring: sparse eased pose keys -> dense baked tracks over ALL bones
// (every bone gets a track so the mixer resets it each frame, making the
//  procedural additive layer safe from accumulation).
// ---------------------------------------------------------------------------
const _e0 = new THREE.Euler();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _qs = new THREE.Quaternion();
function eul(arr, q) { _e0.set(arr ? arr[0] : 0, arr ? arr[1] : 0, arr ? arr[2] : 0, 'XYZ'); return q.setFromEuler(_e0); }

function buildClip(rig, name, dur, keys, fps = 32) {
  keys = keys.slice().sort((a, b) => a.t - b.t);
  const names = rig.bones.map(b => b.name);
  const nSamp = Math.max(2, Math.round(dur * fps) + 1);
  const times = new Float32Array(nSamp);
  for (let i = 0; i < nSamp; i++) times[i] = (i / (nSamp - 1)) * dur;
  const posBones = new Set();
  for (const k of keys) if (k.pos) for (const b in k.pos) posBones.add(b);

  const seg = (ts) => {
    let hi = 1; while (hi < keys.length - 1 && keys[hi].t < ts) hi++;
    const k0 = keys[hi - 1], k1 = keys[hi];
    const span = Math.max(1e-5, k1.t - k0.t);
    const lt = THREE.MathUtils.clamp((ts - k0.t) / span, 0, 1);
    return { k0, k1, a: (EASE[k1.ease] || EASE.io)(lt) };
  };

  const tracks = [];
  for (const nm of names) {
    const rest = rig.bones[rig.boneOf(nm)].position;
    const qv = new Float32Array(nSamp * 4);
    for (let i = 0; i < nSamp; i++) {
      const { k0, k1, a } = seg(times[i]);
      eul(k0.rot && k0.rot[nm], _q0); eul(k1.rot && k1.rot[nm], _q1);
      _qs.copy(_q0).slerp(_q1, a);
      qv[i * 4] = _qs.x; qv[i * 4 + 1] = _qs.y; qv[i * 4 + 2] = _qs.z; qv[i * 4 + 3] = _qs.w;
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${nm}.quaternion`, times, qv));
    if (posBones.has(nm)) {
      const pv = new Float32Array(nSamp * 3);
      for (let i = 0; i < nSamp; i++) {
        const { k0, k1, a } = seg(times[i]);
        const p0 = (k0.pos && k0.pos[nm]) || null, p1 = (k1.pos && k1.pos[nm]) || null;
        const x0 = rest.x + (p0 ? p0[0] : 0), y0 = rest.y + (p0 ? p0[1] : 0), z0 = rest.z + (p0 ? p0[2] : 0);
        const x1 = rest.x + (p1 ? p1[0] : 0), y1 = rest.y + (p1 ? p1[1] : 0), z1 = rest.z + (p1 ? p1[2] : 0);
        pv[i * 3] = x0 + (x1 - x0) * a; pv[i * 3 + 1] = y0 + (y1 - y0) * a; pv[i * 3 + 2] = z0 + (z1 - z0) * a;
      }
      const t = new THREE.VectorKeyframeTrack(`${nm}.position`, times, pv);
      t.setInterpolation(THREE.InterpolateSmooth);
      tracks.push(t);
    }
  }
  return new THREE.AnimationClip(name, dur, tracks);
}

// ---------------------------------------------------------------------------
// pose library (radians). Missing bones = rest. Left is +X, forward is +Z.
// ---------------------------------------------------------------------------
const STANCE = {
  pelvis: [0.03, 0, 0], spine01: [0.03, 0, 0], spine02: [0.02, 0, 0], chest: [-0.02, 0, 0],
  neck: [0.06, 0, 0], head: [0.10, 0, 0],
  clavicleL: [0, 0, -0.05], upperArmL: [0.06, 0, 0.20], lowerArmL: [-0.30, 0.1, 0.12], handL: [0, 0, 0],
  clavicleR: [0, 0, 0.05], upperArmR: [0.14, 0, -0.24], lowerArmR: [-0.55, -0.15, -0.10], handR: [-0.15, 0, 0],
  thighL: [-0.04, 0, 0.03], shinL: [0.10, 0, 0], footL: [-0.04, 0, 0],
  thighR: [0.03, 0, -0.03], shinR: [0.07, 0, 0], footR: [-0.02, 0, 0],
};
const merge = (...o) => Object.assign({}, ...o);

function idleClip(rig) {
  return buildClip(rig, 'idle', 4.2, [
    { t: 0, ease: 'io', rot: STANCE, pos: { pelvis: [0, -0.008, 0] } },
    { t: 1.6, ease: 'io', rot: merge(STANCE, { pelvis: [0.03, 0.02, 0.012], spine02: [0.02, -0.03, 0.01], head: [0.10, 0.10, 0] }), pos: { pelvis: [0.012, 0.004, 0] } },
    { t: 2.9, ease: 'io', rot: merge(STANCE, { pelvis: [0.03, -0.015, -0.01], head: [0.10, -0.06, 0] }), pos: { pelvis: [-0.008, -0.006, 0] } },
    { t: 4.2, ease: 'io', rot: STANCE, pos: { pelvis: [0, -0.008, 0] } },
  ]);
}

function walkClip(rig) {
  const k = (L, R, spineY, sway) => ({
    thighL: [L.th, 0, 0.03], shinL: [L.sh, 0, 0], footL: [L.ft, 0, 0],
    thighR: [R.th, 0, -0.03], shinR: [R.sh, 0, 0], footR: [R.ft, 0, 0],
    upperArmL: [-L.arm * 0.9 + 0.06, 0, 0.18], lowerArmL: [-0.34, 0, 0.1],
    upperArmR: [-R.arm * 0.55 + 0.14, 0, -0.22], lowerArmR: [-0.6, -0.1, -0.1],
    pelvis: [0.05, spineY, sway * 0.4], spine01: [0.05, -spineY * 0.6, -sway * 0.3],
    spine02: [0.03, -spineY * 1.1, 0], chest: [0.0, -spineY * 1.3, 0], neck: [0.06, spineY * 0.5, 0], head: [0.10, 0, 0],
  });
  const CF = { th: -0.5, sh: 0.16, ft: 0.22, arm: 0.5 };
  const MD = { th: 0.0, sh: 0.06, ft: 0.0, arm: 0.0 };
  const TO = { th: 0.46, sh: 0.5, ft: -0.36, arm: -0.5 };
  const SW = { th: -0.26, sh: 0.98, ft: 0.12, arm: 0.28 };
  return buildClip(rig, 'walk', 1.0, [
    { t: 0.0, ease: 'io', rot: k(CF, TO, 0.12, 1), pos: { pelvis: [0.02, -0.02, 0] } },
    { t: 0.25, ease: 'io', rot: k(MD, SW, 0.0, 0), pos: { pelvis: [0.0, 0.02, 0] } },
    { t: 0.5, ease: 'io', rot: k(TO, CF, -0.12, -1), pos: { pelvis: [-0.02, -0.02, 0] } },
    { t: 0.75, ease: 'io', rot: k(SW, MD, 0.0, 0), pos: { pelvis: [0.0, 0.02, 0] } },
    { t: 1.0, ease: 'io', rot: k(CF, TO, 0.12, 1), pos: { pelvis: [0.02, -0.02, 0] } },
  ]);
}

function runClip(rig) {
  const k = (L, R, spineY) => ({
    thighL: [L.th, 0, 0.04], shinL: [L.sh, 0, 0], footL: [L.ft, 0, 0],
    thighR: [R.th, 0, -0.04], shinR: [R.sh, 0, 0], footR: [R.ft, 0, 0],
    upperArmL: [-L.arm + 0.05, 0, 0.22], lowerArmL: [-0.95, 0, 0.15],
    upperArmR: [-R.arm * 0.7 + 0.1, 0, -0.26], lowerArmR: [-1.0, -0.1, -0.1],
    pelvis: [0.22, spineY, 0], spine01: [0.2, -spineY * 0.6, 0], spine02: [0.16, -spineY * 1.2, 0],
    chest: [0.1, -spineY * 1.5, 0], neck: [-0.02, 0, 0], head: [0.04, 0, 0],
  });
  const CF = { th: -0.82, sh: 0.3, ft: 0.24, arm: 0.9 };
  const PS = { th: 0.05, sh: 0.9, ft: -0.1, arm: 0.1 };
  const TO = { th: 0.62, sh: 0.7, ft: -0.5, arm: -0.9 };
  const SW = { th: -0.5, sh: 1.5, ft: 0.2, arm: 0.5 };
  return buildClip(rig, 'run', 0.66, [
    { t: 0.0, ease: 'io', rot: k(CF, TO, 0.16), pos: { pelvis: [0, -0.05, 0] } },
    { t: 0.165, ease: 'out', rot: k(PS, SW, 0), pos: { pelvis: [0, 0.07, 0] } },
    { t: 0.33, ease: 'io', rot: k(TO, CF, -0.16), pos: { pelvis: [0, -0.05, 0] } },
    { t: 0.495, ease: 'out', rot: k(SW, PS, 0), pos: { pelvis: [0, 0.07, 0] } },
    { t: 0.66, ease: 'io', rot: k(CF, TO, 0.16), pos: { pelvis: [0, -0.05, 0] } },
  ]);
}

function attack1Clip(rig) {
  const wind = merge(STANCE, {
    pelvis: [0.02, -0.35, 0], spine01: [0.02, -0.3, 0.05], spine02: [-0.05, -0.35, 0.08], chest: [-0.1, -0.4, 0.1],
    upperArmR: [-2.3, -0.2, -0.5], lowerArmR: [-1.1, 0, 0], handR: [-0.3, 0, 0],
    upperArmL: [0.3, 0, 0.5], lowerArmL: [-0.7, 0, 0.3], head: [0.0, -0.25, 0],
    thighR: [0.12, 0, -0.05], shinR: [0.2, 0, 0],
  });
  const strike = merge(STANCE, {
    pelvis: [0.08, 0.42, 0], spine01: [0.14, 0.36, -0.05], spine02: [0.2, 0.42, -0.1], chest: [0.24, 0.5, -0.12],
    upperArmR: [0.5, 0.2, -0.35], lowerArmR: [-0.15, 0, 0], handR: [0.2, 0, 0],
    upperArmL: [0.1, 0, 0.25], lowerArmL: [-0.5, 0, 0.1], head: [0.28, 0.2, 0],
    thighL: [0.12, 0, 0.05], thighR: [-0.1, 0, -0.05], shinL: [0.25, 0, 0],
  });
  return buildClip(rig, 'attack1', 0.72, [
    { t: 0.0, ease: 'out', rot: STANCE },
    { t: 0.22, ease: 'back', rot: wind },
    { t: 0.34, ease: 'inCubic', rot: strike },
    { t: 0.52, ease: 'out', rot: merge(strike, { spine02: [0.12, 0.2, 0], upperArmR: [0.2, 0, -0.1] }) },
    { t: 0.72, ease: 'io', rot: STANCE },
  ]);
}

function attack2Clip(rig) {
  const wind = merge(STANCE, {
    pelvis: [0, 0.4, 0], spine02: [0, 0.5, 0], chest: [0, 0.55, 0],
    upperArmR: [0.2, 0.6, 0.2], lowerArmR: [-1.3, 0, 0], handR: [0, 0.3, 0],
    upperArmL: [0.2, 0, 0.4], head: [0.05, 0.35, 0],
  });
  const strike = merge(STANCE, {
    pelvis: [0.04, -0.45, 0], spine02: [0.06, -0.55, 0], chest: [0.08, -0.62, 0],
    upperArmR: [0.1, -0.7, -0.4], lowerArmR: [-0.3, 0, 0], handR: [0, -0.3, 0],
    upperArmL: [0.15, 0, 0.3], head: [0.12, -0.35, 0], thighR: [-0.08, 0, 0],
  });
  return buildClip(rig, 'attack2', 0.68, [
    { t: 0.0, ease: 'out', rot: STANCE },
    { t: 0.20, ease: 'back', rot: wind },
    { t: 0.30, ease: 'inCubic', rot: strike },
    { t: 0.48, ease: 'out', rot: merge(strike, { chest: [0.06, -0.3, 0] }) },
    { t: 0.68, ease: 'io', rot: STANCE },
  ]);
}

function castClip(rig) {
  const gather = merge(STANCE, {
    pelvis: [-0.05, 0, 0], spine01: [-0.08, 0, 0], spine02: [-0.06, 0, 0], chest: [-0.05, 0, 0],
    upperArmL: [-1.4, 0, 0.7], lowerArmL: [-1.5, 0, 0.2], handL: [0, 0, 0],
    upperArmR: [-0.5, 0, -0.4], lowerArmR: [-1.4, 0, 0], head: [-0.05, 0, 0],
    thighL: [-0.06, 0, 0], thighR: [0.06, 0, 0],
  });
  const release = merge(STANCE, {
    pelvis: [0.1, 0, 0], spine01: [0.14, 0, 0], spine02: [0.16, 0, 0], chest: [0.18, 0, 0],
    upperArmL: [-1.7, 0, 0.2], lowerArmL: [-0.2, 0, 0], handL: [0.3, 0, 0],
    upperArmR: [-0.9, 0, -0.2], lowerArmR: [-1.0, 0, 0], head: [0.22, 0, 0],
  });
  return buildClip(rig, 'cast', 0.9, [
    { t: 0.0, ease: 'out', rot: STANCE },
    { t: 0.30, ease: 'io', rot: gather },
    { t: 0.42, ease: 'inCubic', rot: release },
    { t: 0.62, ease: 'out', rot: merge(release, { spine02: [0.06, 0, 0], upperArmL: [-1.2, 0, 0.3] }) },
    { t: 0.9, ease: 'io', rot: STANCE },
  ]);
}

function rollClip(rig) {
  const tuck = {
    pelvis: [0.6, 0, 0], spine01: [0.5, 0, 0], spine02: [0.6, 0, 0], chest: [0.55, 0, 0],
    neck: [0.3, 0, 0], head: [0.4, 0, 0],
    thighL: [-1.5, 0, 0.05], shinL: [1.7, 0, 0], footL: [0.3, 0, 0],
    thighR: [-1.5, 0, -0.05], shinR: [1.7, 0, 0], footR: [0.3, 0, 0],
    upperArmL: [-0.6, 0, 0.5], lowerArmL: [-1.6, 0, 0.2],
    upperArmR: [-0.6, 0, -0.5], lowerArmR: [-1.6, 0, -0.2],
  };
  const exit = merge(STANCE, { pelvis: [0.25, 0, 0], spine01: [0.2, 0, 0], thighL: [-0.4, 0, 0], thighR: [-0.4, 0, 0], shinL: [0.6, 0, 0], shinR: [0.6, 0, 0] });
  return buildClip(rig, 'roll', 0.34, [
    { t: 0.0, ease: 'inCubic', rot: STANCE, pos: { pelvis: [0, 0, 0] } },
    { t: 0.12, ease: 'out', rot: tuck, pos: { pelvis: [0, -0.35, 0] } },
    { t: 0.24, ease: 'io', rot: merge(tuck, { pelvis: [0.4, 0, 0] }), pos: { pelvis: [0, -0.28, 0] } },
    { t: 0.34, ease: 'out', rot: exit, pos: { pelvis: [0, -0.05, 0] } },
  ]);
}

function hitClip(rig) {
  const flinch = merge(STANCE, {
    pelvis: [-0.12, 0.1, 0], spine01: [-0.18, 0.12, 0.05], spine02: [-0.2, 0.15, 0.06], chest: [-0.22, 0.18, 0.08],
    neck: [-0.15, 0.1, 0], head: [-0.28, 0.15, 0],
    upperArmL: [0.3, 0, 0.5], upperArmR: [0.3, 0, -0.4], lowerArmL: [-0.6, 0, 0.2], lowerArmR: [-0.7, 0, -0.2],
    thighL: [0.08, 0, 0], thighR: [-0.05, 0, 0],
  });
  return buildClip(rig, 'hit', 0.36, [
    { t: 0.0, ease: 'out', rot: STANCE },
    { t: 0.1, ease: 'inCubic', rot: flinch },
    { t: 0.36, ease: 'out', rot: STANCE },
  ]);
}

function deathClip(rig) {
  const stagger = merge(STANCE, { pelvis: [-0.2, 0.1, 0.05], spine01: [-0.25, 0, 0.08], chest: [-0.3, 0.1, 0.1], head: [-0.3, 0.1, 0], upperArmL: [0.5, 0, 0.6], upperArmR: [0.5, 0, -0.6] });
  const buckle = { pelvis: [0.3, 0, 0.1], spine01: [0.2, 0, 0.1], spine02: [0.15, 0, 0.05], chest: [0.1, 0, 0], head: [0.3, 0, 0.1], thighL: [-1.3, 0, 0.1], shinL: [1.7, 0, 0], thighR: [-1.2, 0, -0.1], shinR: [1.6, 0, 0], upperArmL: [0.2, 0, 0.4], upperArmR: [0.2, 0, -0.4] };
  const collapse = { pelvis: [0.1, 0.2, 0.4], spine01: [0.3, 0.1, 0.3], spine02: [0.2, 0, 0.2], chest: [0.1, 0, 0.1], neck: [0.2, 0, 0.2], head: [0.35, 0.2, 0.3], thighL: [-0.9, 0, 0.3], shinL: [1.2, 0, 0], thighR: [-0.5, 0, -0.2], shinR: [0.8, 0, 0], upperArmL: [0.6, 0, 1.0], lowerArmL: [-0.3, 0, 0.3], upperArmR: [0.5, 0, -0.8], lowerArmR: [-0.4, 0, -0.2] };
  return buildClip(rig, 'death', 1.35, [
    { t: 0.0, ease: 'out', rot: STANCE, pos: { pelvis: [0, 0, 0] } },
    { t: 0.22, ease: 'back', rot: stagger, pos: { pelvis: [0, 0.02, -0.05] } },
    { t: 0.6, ease: 'inCubic', rot: buckle, pos: { pelvis: [0, -0.55, 0] } },
    { t: 1.35, ease: 'out', rot: collapse, pos: { pelvis: [0.05, -0.72, 0.15] } },
  ]);
}

export const CLIP_BUILDERS = { idle: idleClip, walk: walkClip, run: runClip, attack1: attack1Clip, attack2: attack2Clip, cast: castClip, roll: rollClip, hit: hitClip, death: deathClip };
export const ONESHOTS = {
  attack1: { strike: 0.34 }, attack2: { strike: 0.30 }, cast: { strike: 0.42 },
  roll: { strike: -1 }, hit: { strike: -1, soft: true }, death: { strike: -1, sticky: true },
};

// ---------------------------------------------------------------------------
// shared temps + helpers for additive layer and IK (module scope = no per-frame alloc)
// ---------------------------------------------------------------------------
const _qDelta = new THREE.Quaternion(), _eDelta = new THREE.Euler();
const _qP = new THREE.Quaternion(), _qPi = new THREE.Quaternion();
const _aim = new THREE.Vector3();
const _ikA = new THREE.Vector3(), _ikB = new THREE.Vector3(), _ikC = new THREE.Vector3(), _ikD = new THREE.Vector3(), _ikK = new THREE.Vector3();
export function addRot(bone, x, y, z) { _eDelta.set(x, y, z, 'XYZ'); _qDelta.setFromEuler(_eDelta); bone.quaternion.multiply(_qDelta); }
export function shortAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// aim a bone so its rest child-axis (bone-local unit vector) points along worldDir.
// parent.matrixWorld MUST be current before calling.
function aimBone(bone, worldDir, restAxis) {
  bone.parent.getWorldQuaternion(_qP);
  _qPi.copy(_qP).invert();
  const tl = _aim.copy(worldDir).applyQuaternion(_qPi).normalize();
  bone.quaternion.setFromUnitVectors(restAxis, tl);
}

// analytic 2-bone IK: place `end` joint at `target` (world), knee bending toward `pole`.
function solveTwoBone(H, root, mid, target, pole, l1, l2, rootAxis, midAxis) {
  const toT = _ikA.subVectors(target, H);
  let dist = toT.length();
  const maxd = (l1 + l2) * 0.998, mind = Math.abs(l1 - l2) + 0.02;
  dist = THREE.MathUtils.clamp(dist, mind, maxd);
  toT.normalize();
  const cosHip = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const hipAngle = Math.acos(cosHip);
  let bendAxis = _ikB.crossVectors(toT, pole);
  if (bendAxis.lengthSq() < 1e-6) bendAxis.crossVectors(toT, _ikC.set(1, 0, 0));
  bendAxis.normalize();
  const thighDir = _ikC.copy(toT).applyAxisAngle(bendAxis, hipAngle);
  const K = _ikK.copy(H).addScaledVector(thighDir, l1);
  aimBone(root, thighDir, rootAxis);
  root.updateWorldMatrix(false, false);
  const shinDir = _ikD.copy(target).sub(K).normalize();
  aimBone(mid, shinDir, midAxis);
  mid.updateWorldMatrix(false, false);
}

export { aimBone, solveTwoBone };

// ---------------------------------------------------------------------------
// controller — blend tree, one-shots with strike callbacks, additive layer, foot IK
// ---------------------------------------------------------------------------
const _fwd = new THREE.Vector3(), _hip = new THREE.Vector3(), _ank = new THREE.Vector3();
const _tgt = new THREE.Vector3(), _blend = new THREE.Vector3(), _pole = new THREE.Vector3();
const _fkT = new THREE.Quaternion(), _fkS = new THREE.Quaternion(), _ikT = new THREE.Quaternion(), _ikS = new THREE.Quaternion();
const _nrm = new THREE.Vector3();

export class AnimController {
  constructor(rig) {
    this.rig = rig;
    this.mixer = new THREE.AnimationMixer(rig.body);
    this.actions = {};
    this.dur = {};
    for (const [n, build] of Object.entries(CLIP_BUILDERS)) {
      const clip = build(rig);
      const a = this.mixer.clipAction(clip);
      this.actions[n] = a; this.dur[n] = clip.duration;
      if (ONESHOTS[n]) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.enabled = false; }
      else { a.setLoop(THREE.LoopRepeat, Infinity); a.setEffectiveWeight(n === 'idle' ? 1 : 0); a.play(); }
    }
    this.actions.walk.paused = true; this.actions.run.paused = true;   // phase-driven

    this.phase = 0; this.walkStride = 1.55; this.runStride = 3.05;
    this.locoMix = 1; this.active = null; this.dead = false;
    this.breath = Math.random() * 6.28;
    this.headYaw = 0; this.lean = 0;

    // foot-lock IK state + constant bone axes (child-local direction)
    const axis = (child) => rig.bones[rig.boneOf(child)].position.clone().normalize();
    this.legLen = {
      L: [this._d('thighL', 'shinL'), this._d('shinL', 'footL')],
      R: [this._d('thighR', 'shinR'), this._d('shinR', 'footR')],
    };
    this.axis = { thighL: axis('shinL'), shinL: axis('footL'), thighR: axis('shinR'), shinR: axis('footR') };
    this.foot = { L: { locked: false, lock: new THREE.Vector3(), w: 0 }, R: { locked: false, lock: new THREE.Vector3(), w: 0 } };
    this.ikEnabled = true;

    // ---- additive-layer base pose (the standing-still drift fix) ----------------
    //
    // `_additive` and `_footIK` MULTIPLY into bone quaternions. That is only safe if the
    // mixer rewrites every bone it owns each frame. It does not.
    //
    // `PropertyMixer.apply` skips `binding.setValue` when the mixed value is unchanged
    // from the previous frame. While standing, `idle`'s chest/spine/neck/head tracks are
    // effectively CONSTANT, so after the first frame Three.js stops writing them — and the
    // additive delta then compounds on its own output, frame after frame.
    //
    // Measured: mixer wrote `chest` on 0 of 73 frames standing, but 89 of 90 walking.
    // Standing, `chest.x` integrated to +36 deg and `spine01.z` past -146 deg (wrapping
    // through 180), folding the spine ~83 deg forward. Every bone the additive layer
    // touches drifted; legs and pelvis, which it barely touches, stayed exact.
    //
    // Fix: keep our own copy of the mixer's output for exactly those bones. Each frame we
    // restore it BEFORE `mixer.update`, so the mixer's skip is harmless (the value it
    // would have written is already there), then snapshot it AFTER the mixer and apply the
    // additive layer to that clean base. The additive layer therefore never sees its own
    // previous result.
    this._addBones = ['pelvis', 'spine01', 'spine02', 'chest', 'neck', 'head',
                      'clavicleL', 'clavicleR',
                      // foot IK writes these two pairs
                      'thighL', 'shinL', 'thighR', 'shinR'];
    this._base = new Map();
    for (const n of this._addBones) {
      const b = rig.bones[rig.boneOf(n)];
      if (b) this._base.set(b, b.quaternion.clone());
    }

    this.mixer.addEventListener('finished', (e) => {
      if (this.active && e.action === this.active.action && !this.active.sticky) this.active = null;
    });
  }
  _d(a, b) { return this.rig.bones[this.rig.boneOf(a)].position.distanceTo(this.rig.bones[this.rig.boneOf(b)].position) || 0.4; }

  play(name, onStrike) {
    const a = this.actions[name]; if (!a) return;
    const info = ONESHOTS[name];
    a.reset(); a.enabled = true; a.paused = false; a.time = 0; a.setEffectiveWeight(info.soft ? 0.62 : (1 - this.locoMix)); a.play();
    this.active = { name, action: a, strike: info.strike, struck: info.strike < 0, onStrike, sticky: !!info.sticky, soft: !!info.soft };
    if (info.sticky) this.dead = true;
  }
  revive() { this.dead = false; this.active = null; this.actions.death.enabled = false; this.actions.death.stop(); }
  get busy() { return !!this.active && !this.active.soft; }

  // params: { dt, speed, aimYaw, facing, turnRate, groundY, accel }
  update(p) {
    const dt = Math.min(p.dt, 1 / 30);
    const sp = p.speed;
    const runW = THREE.MathUtils.clamp((sp - 2.4) / 2.7, 0, 1);
    const moveW = THREE.MathUtils.clamp(sp / 1.1, 0, 1);
    const walkW = moveW * (1 - runW), idleW = 1 - moveW;
    const stride = this.walkStride + (this.runStride - this.walkStride) * runW;
    if (sp > 0.05) this.phase = (this.phase + (sp / stride) * dt) % 1;

    const wantLoco = (this.active && !this.active.soft) ? 0 : 1;
    this.locoMix += (wantLoco - this.locoMix) * (1 - Math.exp(-16 * dt));

    this.actions.idle.setEffectiveWeight(idleW * this.locoMix);
    this.actions.walk.setEffectiveWeight(walkW * this.locoMix);
    this.actions.run.setEffectiveWeight(runW * this.locoMix);
    this.actions.walk.time = this.phase * this.dur.walk;
    this.actions.run.time = this.phase * this.dur.run;

    if (this.active) {
      const a = this.active.action;
      a.setEffectiveWeight(this.active.sticky ? 1 : (this.active.soft ? 0.62 : (1 - this.locoMix)));
      if (!this.active.struck && a.time >= this.active.strike) { this.active.struck = true; this.active.onStrike && this.active.onStrike(); }
    }
    // decay any finished/cleared one-shots back to 0 so their last frame stops bleeding
    for (const n in ONESHOTS) {
      const a = this.actions[n];
      if (this.active && this.active.action === a) continue;
      if (a.getEffectiveWeight() > 0) {
        const w = Math.max(0, a.getEffectiveWeight() - dt * 8);
        a.setEffectiveWeight(w);
        if (w <= 0.001 && n !== 'death') { a.enabled = false; }
      }
    }

    // Restore the mixer's own output for every bone the additive layer / IK will touch.
    // Without this, a bone the mixer chose not to rewrite (because its track value did not
    // change) still carries LAST frame's additive delta, and the new delta compounds on it.
    for (const [bone, q] of this._base) bone.quaternion.copy(q);

    this.mixer.update(dt);

    // Snapshot the clean, mixer-authored pose. This is the base the additive layer and the
    // foot IK are allowed to modify, and it is what gets restored next frame.
    for (const [bone, q] of this._base) q.copy(bone.quaternion);

    if (!this.dead) this._additive(p, dt, runW, moveW);
    this.rig.group.updateMatrixWorld(true);
    if (!this.dead && !this.busy && this.ikEnabled) this._footIK(p);
  }

  _additive(p, dt, runW, moveW) {
    const B = this.rig.bones, bi = (n) => B[this.rig.boneOf(n)];
    this.breath += dt * (1.1 + runW * 1.8);
    const amp = 1 - moveW * 0.5;
    const br = Math.sin(this.breath);
    addRot(bi('chest'), br * 0.035 * amp, 0, 0);
    addRot(bi('spine02'), br * 0.02 * amp, 0, Math.sin(this.breath * 0.5) * 0.012 * amp);
    addRot(bi('spine01'), 0, 0, Math.sin(this.breath * 0.47 + 1) * 0.014 * amp);
    addRot(bi('clavicleL'), 0, 0, br * 0.02 * amp); addRot(bi('clavicleR'), 0, 0, -br * 0.02 * amp);

    const dy = shortAngle((p.aimYaw ?? p.facing) - p.facing);
    const tgtYaw = THREE.MathUtils.clamp(dy, -0.7, 0.7);
    this.headYaw += (tgtYaw - this.headYaw) * (1 - Math.exp(-8 * dt));
    addRot(bi('head'), 0.04 * amp, this.headYaw * 0.6, 0);
    addRot(bi('neck'), 0, this.headYaw * 0.35, 0);

    const tgtLean = THREE.MathUtils.clamp((p.turnRate || 0) * 0.14, -0.28, 0.28);
    this.lean += (tgtLean - this.lean) * (1 - Math.exp(-10 * dt));
    addRot(bi('pelvis'), 0, 0, this.lean);
    addRot(bi('spine01'), 0, -this.lean * 0.3, -this.lean * 0.4);
    addRot(bi('chest'), 0, -this.lean * 0.5, -this.lean * 0.5);
    const fl = THREE.MathUtils.clamp((p.accel || 0) * 0.01, -0.1, 0.16);
    addRot(bi('spine01'), fl, 0, 0);
  }

  _footIK(p) {
    const groundY = p.groundY ?? 0;
    const clear = 0.05;
    _fwd.set(Math.sin(p.facing), 0, Math.cos(p.facing));
    for (const s of ['L', 'R']) {
      const thigh = this.rig.bones[this.rig.boneOf('thigh' + s)];
      const shin = this.rig.bones[this.rig.boneOf('shin' + s)];
      const foot = this.rig.bones[this.rig.boneOf('foot' + s)];
      const [l1, l2] = this.legLen[s];
      _hip.setFromMatrixPosition(thigh.matrixWorld);
      _ank.setFromMatrixPosition(foot.matrixWorld);
      const st = this.foot[s];
      const planted = (_ank.y - groundY) < 0.14;
      if (planted && !st.locked) { st.locked = true; st.lock.set(_ank.x, groundY + clear, _ank.z); }
      else if (!planted) st.locked = false;
      st.w += ((planted ? 1 : 0) - st.w) * 0.4;
      if (st.w < 0.02) continue;
      if (st.locked) _tgt.copy(st.lock); else _tgt.set(_ank.x, Math.max(_ank.y, groundY + clear), _ank.z);
      _blend.lerpVectors(_ank, _tgt, st.w);
      _fkT.copy(thigh.quaternion); _fkS.copy(shin.quaternion);
      solveTwoBone(_hip, thigh, shin, _blend, _pole.copy(_fwd), l1, l2, this.axis['thigh' + s], this.axis['shin' + s]);
      if (!isFinite(thigh.quaternion.x) || !isFinite(shin.quaternion.x)) { thigh.quaternion.copy(_fkT); shin.quaternion.copy(_fkS); continue; }
      _ikT.copy(thigh.quaternion); _ikS.copy(shin.quaternion);
      thigh.quaternion.copy(_fkT).slerp(_ikT, st.w);
      shin.quaternion.copy(_fkS).slerp(_ikS, st.w);
      thigh.updateWorldMatrix(false, false); shin.updateWorldMatrix(false, false); foot.updateWorldMatrix(false, false);
    }
  }
}

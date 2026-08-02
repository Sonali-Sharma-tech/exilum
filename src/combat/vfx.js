import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';
import { ParticleSystem, SPAWN } from './particles.js';
import { VfxScreenPass } from '../render/shaders/vfx/screen.js';
import { pickFrame } from '../gen/sprites.js';

/**
 * VFXParticles — the visual half of §7. Every particle, trail, decal, dynamic
 * light and screen-space hit is spawned from here in response to the event bus.
 *
 * Philosophy (measured PoE2 ground truth + parent guidance): effects are the
 * ONLY licensed saturation in a near-black world, so they must be few, large,
 * bright, ADDITIVE and — above all — they must LIGHT THE FLOOR. A single impact
 * that genuinely illuminates surrounding geometry beats a thousand additive
 * dots. Restraint on count; generosity on per-particle craft and real light.
 *
 * All event payloads are read SYNCHRONOUSLY and copied into pool buffers as
 * scalars; no payload object or Vector3 is ever retained (combat reuses a ring
 * of payloads with zero alloc, and this respects that).
 */

// --- tunables live under CFG.vfx (our own section; added if absent) ---
CFG.vfx ??= {
  poolAdditive: 4000, poolAlpha: 2500,
  bloodDecals: 96, groundFx: 56, ribbons: 48, lights: 8,
  light: { impact: 14, crit: 20, explosion: 40, beam: 20, nova: 34, loot: 10, levelup: 34, aura: 7 },
  telegraphWindup: 0.9,
  bloodLife: 22,          // seconds ground blood persists then fades
  deathDecalLife: 40,
  screenDecay: 4.2,
};
const VC = CFG.vfx;

// -------- damage-typed palette. Cores are LINEAR and exceed 1.0 so additive
// spell VFX blow past the bloom threshold (CFG.graphics.bloom.threshold 0.78).
const PAL = {
  physical:  { core: [2.4, 2.4, 2.7], tail: [0.60, 0.63, 0.78], light: 0xbcccff },
  fire:      { core: [6.2, 2.1, 0.45], tail: [1.5, 0.30, 0.06], light: 0xff7420 },
  cold:      { core: [1.5, 3.4, 6.2], tail: [0.35, 0.85, 1.7], light: 0x54a6ff },
  lightning: { core: [4.4, 3.8, 6.6], tail: [1.2, 1.05, 2.1], light: 0xa98cff },
  chaos:     { core: [2.6, 4.4, 1.0], tail: [0.60, 1.25, 0.28], light: 0x8fd028 },
  void:      { core: [4.2, 0.8, 4.4], tail: [1.05, 0.18, 1.15], light: 0xd23af0 },
  holy:      { core: [6.2, 4.4, 1.6], tail: [1.7, 1.15, 0.42], light: 0xffcf58 },
  blood:     { core: [0.52, 0.03, 0.03], tail: [0.16, 0.008, 0.008], light: 0x400000 },
};
// synonyms used by combat's damage `type` strings and effect kinds
const TYPE_ALIAS = { phys: 'physical', frost: 'cold', ice: 'cold', shock: 'lightning',
  elec: 'lightning', poison: 'chaos', gold: 'holy', light: 'holy' };

function palOf(type) { return PAL[TYPE_ALIAS[type] || type] || PAL.physical; }

let sys = null;
let screenPass = null;
let screenImpact = 0, screenHitT = 0;
let lastLevel = 1;
// normalized effect power (0..1) from combat emits; drives attached-light intensity
// primarily (NOT particle count — fewer/better per parent guidance). Set per-event.
let PW = 1;
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// blood-spray de-dup guard (combat may emit BOTH DAMAGE_DEALT and VFX 'blood')
let lastBloodT = -1, lastBloodX = 1e9, lastBloodZ = 1e9;

// module-scope temps — zero allocation in hot paths
const _proj = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _arc = new Float32Array(26 * 3);
const _qbuf = [];

// ring-colour scratch (bright additive), set by applyRingColor before a ground ring
let ringR = 1, ringG = 1, ringB = 1;

function groundY(x, z, fallback) {
  const l = World.level;
  const h = (l && l.heightAt) ? l.heightAt(x, z) : (fallback ?? 0);
  return h + 0.035;
}
function hexR(h) { return ((h >> 16) & 255) / 255; }
function hexG(h) { return ((h >> 8) & 255) / 255; }
function hexB(h) { return (h & 255) / 255; }

/** Set SPAWN start/end colour; returns the light hex for this effect. */
function applyColor(type, hex, gain) {
  if (hex != null && hex >= 0) {
    const r = hexR(hex), g = hexG(hex), b = hexB(hex);
    SPAWN.r0 = r * gain; SPAWN.g0 = g * gain; SPAWN.b0 = b * gain;
    SPAWN.r1 = r * 0.5; SPAWN.g1 = g * 0.5; SPAWN.b1 = b * 0.5;
    return hex;
  }
  const p = palOf(type);
  SPAWN.r0 = p.core[0]; SPAWN.g0 = p.core[1]; SPAWN.b0 = p.core[2];
  SPAWN.r1 = p.tail[0]; SPAWN.g1 = p.tail[1]; SPAWN.b1 = p.tail[2];
  return p.light;
}
function setWhite(gain) {
  SPAWN.r0 = SPAWN.g0 = SPAWN.b0 = gain;
  SPAWN.r1 = SPAWN.g1 = SPAWN.b1 = gain * 0.35;
}
function applyRingColor(hex, p) {
  if (hex != null && hex >= 0) { ringR = hexR(hex) * 3; ringG = hexG(hex) * 3; ringB = hexB(hex) * 3; }
  else { ringR = p.core[0]; ringG = p.core[1]; ringB = p.core[2]; }
}

// ---------------------------------------------------- particle archetypes
// Colour is whatever SPAWN currently holds (set via applyColor before a group).
function pFlash(x, y, z, size, life, add = true) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = SPAWN.vy = SPAWN.vz = 0;
  SPAWN.drag = 1; SPAWN.gravity = 0; SPAWN.life = life;
  SPAWN.sizeStart = size * 0.55; SPAWN.sizeEnd = size;
  SPAWN.rot0 = Math.random() * 6.283; SPAWN.spin = 0;
  SPAWN.frame = pickFrame('flash', Math.random()); SPAWN.flags = 0; SPAWN.additive = add;
  sys.emit();
}
function pGlow(x, y, z, vx, vy, vz, s0, s1, life, add = true) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 2.4; SPAWN.gravity = 0; SPAWN.life = life;
  SPAWN.sizeStart = s0; SPAWN.sizeEnd = s1;
  SPAWN.rot0 = Math.random() * 6.283; SPAWN.spin = (Math.random() - 0.5) * 1.2;
  SPAWN.frame = pickFrame('glow', Math.random()); SPAWN.flags = 0; SPAWN.additive = add;
  sys.emit();
}
function pSpark(x, y, z, vx, vy, vz, size, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 4.5; SPAWN.gravity = 0.6; SPAWN.life = life;
  SPAWN.sizeStart = size; SPAWN.sizeEnd = size * 0.35;
  SPAWN.rot0 = 0; SPAWN.spin = 0;
  SPAWN.frame = pickFrame('spark', Math.random()); SPAWN.flags = 1 | 4; SPAWN.additive = true;
  sys.emit();
}
function pEmber(x, y, z, vx, vy, vz, size, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 1.3; SPAWN.gravity = 1.35; SPAWN.life = life;
  SPAWN.sizeStart = size; SPAWN.sizeEnd = size * 0.5;
  SPAWN.rot0 = 0; SPAWN.spin = 0;
  SPAWN.frame = pickFrame('ember', Math.random()); SPAWN.flags = 2; SPAWN.additive = true;
  sys.emit();
}
function pShard(x, y, z, vx, vy, vz, size, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 3.2; SPAWN.gravity = 0.4; SPAWN.life = life;
  SPAWN.sizeStart = size; SPAWN.sizeEnd = size * 0.6;
  SPAWN.rot0 = 0; SPAWN.spin = 0;
  SPAWN.frame = pickFrame('shard', Math.random()); SPAWN.flags = 1 | 4; SPAWN.additive = true;
  sys.emit();
}
function pSmoke(x, y, z, vx, vy, vz, s0, s1, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 1.5; SPAWN.gravity = -0.16; SPAWN.life = life;
  SPAWN.sizeStart = s0; SPAWN.sizeEnd = s1;
  SPAWN.rot0 = Math.random() * 6.283; SPAWN.spin = (Math.random() - 0.5) * 0.5;
  SPAWN.frame = pickFrame('smoke', Math.random()); SPAWN.flags = 8; SPAWN.additive = false;
  sys.emit();
}
function pDust(x, y, z, vx, vy, vz, s0, s1, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 3.0; SPAWN.gravity = 0.05; SPAWN.life = life;
  SPAWN.sizeStart = s0; SPAWN.sizeEnd = s1;
  SPAWN.rot0 = Math.random() * 6.283; SPAWN.spin = (Math.random() - 0.5) * 0.6;
  SPAWN.frame = pickFrame('dust', Math.random()); SPAWN.flags = 8; SPAWN.additive = false;
  sys.emit();
}
function pBlood(x, y, z, vx, vy, vz, size, life) {
  SPAWN.px = x; SPAWN.py = y; SPAWN.pz = z;
  SPAWN.vx = vx; SPAWN.vy = vy; SPAWN.vz = vz;
  SPAWN.drag = 1.1; SPAWN.gravity = 2.6; SPAWN.life = life;
  SPAWN.sizeStart = size; SPAWN.sizeEnd = size * 0.7;
  SPAWN.rot0 = 0; SPAWN.spin = 0;
  SPAWN.frame = pickFrame('blood', Math.random()); SPAWN.flags = 1; SPAWN.additive = false;
  sys.emit();
}

// ---------------------------------------------------------- lights & screen
function attachLight(x, y, z, hex, base, life, dist, flicker, priority) {
  const l = sys.acquireLight(priority);
  if (!l) return null;
  l.light.position.set(x, y + 0.45, z);
  l.light.color.setRGB(hexR(hex), hexG(hex), hexB(hex));
  l.light.distance = dist; l.light.decay = 2;
  l.base = base * (0.45 + 0.55 * PW); l.life = life; l.flicker = flicker || 0; l.steady = false; l._owner = null;
  return l;
}
function punch(intensity, x, y, z, type, hex) {
  if (!screenPass) return;
  screenImpact = Math.min(1, screenImpact + intensity);
  screenHitT = 0;
  if (World.camera) {
    _proj.set(x, y + 0.6, z).project(World.camera);
    screenPass.setFocus(_proj.x * 0.5 + 0.5, _proj.y * 0.5 + 0.5);
  }
  const lh = (hex != null && hex >= 0) ? hex : palOf(type).light;
  screenPass.setTint(hexR(lh), hexG(lh), hexB(lh));
}
// spread a unit-ish random direction (optionally biased upward) into _dir
function randHemi(biasUp) {
  const a = Math.random() * 6.283;
  const uy = biasUp ? (0.15 + Math.random() * 0.85) : (Math.random() * 2 - 1);
  const rr = Math.sqrt(Math.max(0, 1 - uy * uy));
  _dir.set(Math.cos(a) * rr, uy, Math.sin(a) * rr);
}

// ------------------------------------------------------------- effect kinds
function kImpact(x, y, z, dx, dy, dz, s, type, hex, dur, crit) {
  const yy = y + 0.55;
  const light = applyColor(type, hex, 3.2);
  const n = crit ? 12 : 7;                       // coloured spark burst — few, punchy
  for (let i = 0; i < n; i++) {
    randHemi(true);
    const sp = (crit ? 8 : 5.5) + Math.random() * 5;
    pSpark(x, yy, z, _dir.x * sp, _dir.y * sp + 1.5, _dir.z * sp, (crit ? 0.5 : 0.36) * s, 0.22 + Math.random() * 0.22);
  }
  setWhite(crit ? 5.5 : 3.6);                    // bright white core flash
  pFlash(x, yy, z, (crit ? 2.3 : 1.5) * s, crit ? 0.19 : 0.14);
  applyColor(type, hex, 2.6);
  pGlow(x, yy, z, 0, 0, 0, 0.6 * s, 1.6 * s, 0.2);
  const gy = groundY(x, z, y);                    // dust kick at ground
  for (let i = 0; i < 3; i++) {
    randHemi(false);
    pDust(x, gy + 0.15, z, _dir.x * 2, 0.3 + Math.random(), _dir.z * 2, 0.5 * s, 1.3 * s, 0.5 + Math.random() * 0.3);
  }
  attachLight(x, yy, z, light, crit ? VC.light.crit : VC.light.impact, crit ? 0.5 : 0.42, crit ? 18 : 15, 0.2, crit ? 2 : 1);
  if (crit) punch(0.5, x, y, z, type, hex);
}

function kFireImpact(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const t = type || 'fire';
  const yy = y + 0.6;
  const light = applyColor(t, hex, 3.0);
  for (let i = 0; i < 4; i++) {                   // fireball core — big soft swelling glows
    randHemi(true);
    pGlow(x, yy, z, _dir.x * 2, _dir.y * 2 + 1, _dir.z * 2, 1.4 * s, 3.4 * s, 0.36 + Math.random() * 0.15);
  }
  setWhite(6.0); pFlash(x, yy, z, 3.4 * s, 0.16);
  applyColor(t, hex, 2.8);                        // ember shower
  for (let i = 0; i < 16; i++) {
    randHemi(true);
    const sp = 4 + Math.random() * 9;
    pEmber(x, yy, z, _dir.x * sp, _dir.y * sp + 3, _dir.z * sp, 0.28 + Math.random() * 0.24, 0.6 + Math.random() * 0.7);
  }
  SPAWN.r0 = 0.10; SPAWN.g0 = 0.085; SPAWN.b0 = 0.075; SPAWN.r1 = 0.02; SPAWN.g1 = 0.018; SPAWN.b1 = 0.016;
  for (let i = 0; i < 6; i++) {                   // rising warm-grey smoke
    randHemi(true);
    pSmoke(x, yy + 0.3, z, _dir.x * 1.4, 1.4 + Math.random(), _dir.z * 1.4, 1.6 * s, 4.2 * s, 1.1 + Math.random() * 0.6);
  }
  const gy = groundY(x, z, y);
  const p = palOf(t);
  sys.emitScorch(0.09, 0.05, 0.04, x, gy, z, 2.6 * s, Math.random() * 6.28, 8.0, Math.random());
  applyRingColor(hex, p);
  sys.groundFx.emit(sys.now, 6, 0, ringR, ringG, ringB, x, gy, z, 3.4 * s, 0, 0.5, 0, Math.random());
  attachLight(x, yy, z, light, VC.light.explosion, 0.62, 26, 0.35, 3);
  punch(0.85, x, y, z, t, hex);
  bus.emit(EV.CAMERA_SHAKE, 0.5);
}

function kSlamRing(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const t = type || 'physical';
  const gy = groundY(x, z, y);
  const p = palOf(t);
  applyRingColor(hex, p);
  sys.groundFx.emit(sys.now, 6, 0, ringR, ringG, ringB, x, gy, z, 3.8 * s, 0, 0.55, 0, Math.random());
  sys.emitScorch(0.08, 0.06, 0.05, x, gy, z, 2.4 * s, Math.random() * 6.28, 6.0, Math.random());
  SPAWN.r0 = 0.11; SPAWN.g0 = 0.10; SPAWN.b0 = 0.088; SPAWN.r1 = 0.02; SPAWN.g1 = 0.018; SPAWN.b1 = 0.015;
  for (let i = 0; i < 18; i++) {                  // dust ring racing outward on the ground
    const a = (i / 18) * 6.283 + Math.random() * 0.3;
    const sp = 6 + Math.random() * 4;
    pDust(x, gy + 0.2, z, Math.cos(a) * sp, 0.8 + Math.random() * 0.8, Math.sin(a) * sp, 1.2 * s, 3.4 * s, 0.7 + Math.random() * 0.4);
  }
  const light = applyColor(t, hex, 2.6);          // upward debris shards
  for (let i = 0; i < 10; i++) {
    randHemi(true);
    const sp = 3 + Math.random() * 6;
    pShard(x, gy + 0.2, z, _dir.x * sp, _dir.y * sp + 5, _dir.z * sp, 0.3 * s, 0.4 + Math.random() * 0.4);
  }
  attachLight(x, y + 0.5, z, light, VC.light.nova, 0.55, 24, 0.28, 3);
  punch(0.7, x, y, z, t, hex);
  bus.emit(EV.CAMERA_SHAKE, 0.45);
}

function kNova(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const t = type || 'lightning';
  const yy = y + 0.5;
  const gy = groundY(x, z, y);
  const p = palOf(t);
  applyRingColor(hex, p);
  sys.groundFx.emit(sys.now, 6, 0, ringR, ringG, ringB, x, gy, z, 4.6 * s, 0, 0.6, 0, Math.random());
  const light = applyColor(t, hex, 3.0);
  setWhite(5.0); pFlash(x, yy, z, 3.0 * s, 0.18); applyColor(t, hex, 2.8);
  for (let i = 0; i < 22; i++) {                  // flat radial spark ring
    const a = (i / 22) * 6.283;
    const sp = 8 + Math.random() * 6;
    pSpark(x, yy, z, Math.cos(a) * sp, 0.6 + Math.random(), Math.sin(a) * sp, 0.42 * s, 0.3 + Math.random() * 0.25);
  }
  attachLight(x, yy, z, light, VC.light.nova, 0.52, 24, 0.3, 3);
  punch(0.7, x, y, z, t, hex);
}

function kBeam(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const t = type || 'fire';
  _dir.set(dx, dy, dz);
  if (_dir.lengthSq() < 1e-6) _dir.set(1, 0, 0);
  _dir.normalize();
  const len = s > 1.2 ? s : 12;
  const light = applyColor(t, hex, 3.0);
  const step = 0.85, count = Math.min(24, (len / step) | 0);
  for (let i = 0; i <= count; i++) {
    const d = i * step;
    const px = x + _dir.x * d, py = y + 0.5 + _dir.y * d, pz = z + _dir.z * d;
    pGlow(px, py, pz, 0, 0, 0, 0.9 * s, 0.5 * s, 0.09, true);
    if ((i & 1) === 0) pSpark(px, py, pz, _dir.x * 0.3, 1.5 + Math.random() * 2, _dir.z * 0.3, 0.4 * s, 0.16);
  }
  const tx = x + _dir.x * len, ty = y + 0.5 + _dir.y * len, tz = z + _dir.z * len;
  setWhite(5.0); pFlash(tx, ty, tz, 1.6 * s, 0.1); applyColor(t, hex, 2.6);
  attachLight(x + _dir.x * len * 0.5, y + 0.5, z + _dir.z * len * 0.5, light, VC.light.beam, 0.14, 18, 0.45, 2);
}

function kBeamTip(x, y, z, dx, dy, dz, s, type, hex) {
  const light = applyColor(type || 'fire', hex, 2.8);
  const yy = y + 0.4;
  for (let i = 0; i < 6; i++) { randHemi(true); const sp = 3 + Math.random() * 4; pSpark(x, yy, z, _dir.x * sp, _dir.y * sp + 1, _dir.z * sp, 0.32 * s, 0.16); }
  setWhite(4.0); pFlash(x, yy, z, 1.1 * s, 0.1);
  attachLight(x, yy, z, light, VC.light.impact, 0.35, 15, 0.25, 1);
}

function kChainArc(x, y, z, dx, dy, dz, s, type, hex) {
  const t = type || 'lightning';
  _dir.set(dx, dy, dz);
  if (_dir.lengthSq() < 1e-6) _dir.set(1, 0, 0);
  _dir.normalize();
  const len = s > 1.2 ? s : 6;
  _side.crossVectors(_dir, _up).normalize();
  const light = applyColor(t, hex, 3.2);
  const segs = 8;
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const lat = (Math.random() - 0.5) * 0.9 * Math.sin(f * Math.PI);
    const vert = (Math.random() - 0.5) * 0.6;
    const px = x + _dir.x * len * f + _side.x * lat;
    const py = y + 0.6 + vert;
    const pz = z + _dir.z * len * f + _side.z * lat;
    pShard(px, py, pz, _side.x * lat * 6, vert * 4, _side.z * lat * 6, 0.34 * s, 0.12 + Math.random() * 0.08);
  }
  attachLight(x + _dir.x * len * 0.5, y + 0.6, z + _dir.z * len * 0.5, light, VC.light.beam, 0.16, 18, 0.5, 2);
}

function kCleaveArc(x, y, z, dx, dy, dz, s, type, hex) {
  const t = type || 'physical';
  _dir.set(dx, dy, dz);
  if (_dir.lengthSq() < 1e-6) _dir.set(1, 0, 0);
  _dir.normalize();
  const rad = (s > 0.6 ? s : 2.0);
  const base = Math.atan2(_dir.z, _dir.x);
  const spread = 2.1;                             // ~120 degrees
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = base - spread * 0.5 + spread * (i / (N - 1));
    const o = i * 3;
    _arc[o] = x + Math.cos(a) * rad;
    _arc[o + 1] = y + 0.9 + Math.sin((i / (N - 1)) * Math.PI) * 0.25;
    _arc[o + 2] = z + Math.sin(a) * rad;
  }
  const r = sys.acquireRibbon(1);
  if (r) {
    r.setPoints(_arc, N);
    r.life = 0.18; r.width = 0.55 * (rad / 2);
    const p = palOf(t);
    if (hex != null && hex >= 0) r.setColorRGB(hexR(hex) * 2.4, hexG(hex) * 2.4, hexB(hex) * 2.4);
    else r.setColorRGB(p.core[0], p.core[1], p.core[2]);
  }
  applyColor(t, hex, 2.4);                         // spark spray along the swing
  for (let i = 0; i < 6; i++) {
    const a = base - spread * 0.5 + spread * Math.random();
    pSpark(x + Math.cos(a) * rad, y + 0.9, z + Math.sin(a) * rad, Math.cos(a) * 4, 1 + Math.random() * 2, Math.sin(a) * 4, 0.34, 0.18);
  }
}

function kMuzzle(x, y, z, dx, dy, dz, s, type, hex) {
  const t = type || 'fire';
  const light = applyColor(t, hex, 3.0);
  _dir.set(dx, dy, dz); if (_dir.lengthSq() > 1e-6) _dir.normalize();
  // soft additive glow core is the DOMINANT element (not a lens-flare star)
  applyColor(t, hex, 3.0);
  pGlow(x, y + 0.5, z, _dir.x * 2, _dir.y * 2, _dir.z * 2, 0.9 * s, 1.7 * s, 0.2);
  pGlow(x, y + 0.5, z, _dir.x * 3, _dir.y * 3, _dir.z * 3, 0.5 * s, 1.0 * s, 0.14);
  // small bright accent flash, NOT a big star
  setWhite(3.4); pFlash(x, y + 0.5, z, 0.8 * s, 0.09); applyColor(t, hex, 2.8);
  for (let i = 0; i < 5; i++) { randHemi(true); const sp = 2 + Math.random() * 4; pSpark(x, y + 0.5, z, _dir.x * 4 + _dir.x * sp, _dir.y * sp + 1, _dir.z * 4 + _dir.z * sp, 0.3 * s, 0.14); }
  attachLight(x, y + 0.5, z, light, VC.light.impact, 0.3, 15, 0.25, 1);
}

function kLance(x, y, z, dx, dy, dz, s, type, hex) {
  kMuzzle(x, y, z, dx, dy, dz, s, type, hex);
  _dir.set(dx, dy, dz); if (_dir.lengthSq() > 1e-6) _dir.normalize();
  applyColor(type || 'cold', hex, 2.8);
  for (let i = 0; i < 4; i++) pShard(x, y + 0.5, z, _dir.x * 16, _dir.y * 16, _dir.z * 16, 0.5 * s, 0.14);
}

function kProjTrail(x, y, z, dx, dy, dz, s, type, hex) {
  applyColor(type || 'fire', hex, 2.6);
  pEmber(x, y + 0.4, z, (Math.random() - 0.5) * 1.2, 0.6 + Math.random(), (Math.random() - 0.5) * 1.2, 0.22 * (s || 1), 0.4 + Math.random() * 0.3);
  if (Math.random() < 0.5) pGlow(x, y + 0.4, z, 0, 0, 0, 0.5 * (s || 1), 0.2, 0.18);
}

function kDustPuff(x, y, z, dx, dy, dz, s) {
  const gy = groundY(x, z, y);
  SPAWN.r0 = 0.12; SPAWN.g0 = 0.10; SPAWN.b0 = 0.088; SPAWN.r1 = 0.02; SPAWN.g1 = 0.018; SPAWN.b1 = 0.015;
  for (let i = 0; i < 5; i++) { randHemi(false); pDust(x, gy + 0.1, z, _dir.x * 1.6, 0.4 + Math.random(), _dir.z * 1.6, 0.6 * (s || 1), 1.8 * (s || 1), 0.6 + Math.random() * 0.4); }
}

function kEmberShower(x, y, z, dx, dy, dz, s, type, hex) {
  applyColor(type || 'fire', hex, 2.8);
  for (let i = 0; i < 12; i++) { randHemi(true); const sp = 2 + Math.random() * 6; pEmber(x, y + 0.5, z, _dir.x * sp, _dir.y * sp + 3, _dir.z * sp, 0.24, 0.6 + Math.random() * 0.6); }
}

function kMagicCircle(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const t = type || 'holy';
  const gy = groundY(x, z, y);
  const p = palOf(t);
  let r = p.core[0], g = p.core[1], b = p.core[2];
  if (hex != null && hex >= 0) { r = hexR(hex) * 3; g = hexG(hex) * 3; b = hexB(hex) * 3; }
  const life = dur > 0 ? dur : 3.0;
  sys.emitMagicCircle(r, g, b, x, gy, z, (s > 0.5 ? s : 2.4), Math.random() * 6.28, life, Math.random());
  attachLight(x, gy + 0.3, z, p.light, VC.light.aura, life, 16, 0.15, 1);
}

function kTelegraph(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const gy = groundY(x, z, y);
  let r = 3.0, g = 0.25, b = 0.12;                // danger red by default
  if (hex != null && hex >= 0) { r = hexR(hex) * 3; g = hexG(hex) * 3; b = hexB(hex) * 3; }
  const life = dur > 0 ? dur : VC.telegraphWindup;
  sys.emitTelegraph(r, g, b, x, gy, z, (s > 0.5 ? s : 2.2), Math.random() * 6.28, life, life, Math.random());
  // telegraphs had NO light — attach one so the danger pool spills onto the floor
  const trad = (s > 0.5 ? s : 2.2);
  attachLight(x, gy + 0.25, z, (hex != null && hex >= 0) ? hex : 0xff4020, VC.light.aura * 1.4, life, trad * 3.0, 0.2, 1);
}

function kFrost(x, y, z, dx, dy, dz, s, type, hex, dur) {
  const light = applyColor('cold', hex, 3.0);      // cold burst + chill aura
  const yy = y + 0.5;
  setWhite(4.0); pFlash(x, yy, z, 1.8 * s, 0.16); applyColor('cold', hex, 2.6);
  for (let i = 0; i < 12; i++) { randHemi(true); const sp = 3 + Math.random() * 6; pShard(x, yy, z, _dir.x * sp, _dir.y * sp + 1, _dir.z * sp, 0.4 * s, 0.3 + Math.random() * 0.3); }
  attachLight(x, yy, z, light, VC.light.impact, 0.45, 16, 0.2, 2);
  spawnAura(CHILL, x, y, z, 'cold', -1);
}

// ------------------------------------------------------- persistent emitters
const IGNITE = 1, CHILL = 2, SHOCK = 3, BLEED = 4, POISON = 5, LOOT = 6;
const EMITTER_CAP = 64;
const EMITTERS = [];
for (let i = 0; i < EMITTER_CAP; i++) {
  EMITTERS.push({ active: false, kind: 0, x: 0, y: 0, z: 0, birth: 0, life: 1, rate: 20,
    acc: 0, hex: 0xffffff, seed: 0, entity: null, light: null, data: 0, glowT: 0 });
}
function freeEmitter() { for (const e of EMITTERS) if (!e.active) return e; return null; }

function nearestEntity(x, z, radius) {
  const h = World.hash;
  if (!h) return null;
  const out = h.query(x, z, radius, _qbuf);
  let best = null, bd = radius * radius;
  for (const e of out) {
    if (!e.alive) continue;
    const dx = e.pos.x - x, dz = e.pos.z - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function spawnAura(kind, x, y, z, type, hex) {
  const ent = nearestEntity(x, z, 1.6);
  for (const e of EMITTERS) {          // dedupe: refresh existing aura of same kind on same entity
    if (e.active && e.kind === kind && ent && e.entity === ent) { e.birth = sys.now; return; }
  }
  const em = freeEmitter();
  if (!em) return;
  const p = palOf(type);
  em.active = true; em.kind = kind; em.x = x; em.y = y; em.z = z;
  em.birth = sys.now; em.life = 0.75; em.acc = 0; em.entity = ent;
  em.hex = (hex != null && hex >= 0) ? hex : p.light; em.seed = Math.random(); em.light = null; em.glowT = 0;
  em.rate = kind === SHOCK ? 24 : 22;
}

function spawnPoisonField(x, y, z, s, hex, dur) {
  const gy = groundY(x, z, y);
  const p = palOf('chaos');
  let r = p.core[0], g = p.core[1], b = p.core[2];
  if (hex != null && hex >= 0) { r = hexR(hex) * 3; g = hexG(hex) * 3; b = hexB(hex) * 3; }
  const life = dur > 0 ? dur : 5.0;
  sys.emitDotField(r * 0.5, g * 0.5, b * 0.5, x, gy, z, (s > 0.5 ? s : 3.0), 0, life, Math.random());
  const em = freeEmitter();
  if (!em) return;
  em.active = true; em.kind = POISON; em.x = x; em.y = gy; em.z = z;
  em.birth = sys.now; em.life = life; em.acc = 0; em.entity = null;
  em.hex = p.light; em.seed = Math.random(); em.light = null; em.data = (s > 0.5 ? s : 3.0);
  em.rate = 18;
}

function spawnLootBeam(x, y, z, hex, s) {
  const gy = groundY(x, z, y);
  for (const e of EMITTERS) {           // reuse an existing beam at ~same spot
    if (e.active && e.kind === LOOT) {
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz < 1.0) { e.birth = sys.now; return; }
    }
  }
  const em = freeEmitter();
  if (!em) return;
  em.active = true; em.kind = LOOT; em.x = x; em.y = gy; em.z = z;
  em.birth = sys.now; em.life = 90; em.acc = 0; em.entity = null;
  em.hex = (hex != null && hex >= 0) ? hex : 0xffcf58; em.seed = Math.random();
  em.light = null; em.data = (s > 0.4 ? s : 1); em.glowT = 0;
}
function killLootBeamNear(x, z) {
  for (const e of EMITTERS) {
    if (e.active && e.kind === LOOT) {
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz < 2.5) releaseEmitter(e);
    }
  }
}
function releaseEmitter(e) {
  if (e.light && e.light.steady && e.light._owner === e) {
    e.light.active = false; e.light.light.visible = false; e.light.light.intensity = 0; e.light._owner = null;
  }
  e.active = false; e.entity = null; e.light = null;
}
function ensureSteadyLight(em, base, dist, flicker) {
  let l = em.light;
  if (!(l && l.active && l._owner === em)) {
    l = sys.acquireLight(0);            // lowest priority: combat always preempts
    if (!l) { em.light = null; return; }
    l._owner = em; l.steady = true; l.flicker = flicker; l.base = base; l.life = 1; l.birth = sys.now;
    l.light.color.setRGB(hexR(em.hex), hexG(em.hex), hexB(em.hex));
    l.light.distance = dist; l.light.decay = 2;
    em.light = l;
  }
  l.light.position.set(em.x, em.y + 0.6, em.z);
}

function updateEmitters(dt, now) {
  for (const em of EMITTERS) {
    if (!em.active) continue;
    if (em.entity) {
      if (!em.entity.alive) { releaseEmitter(em); continue; }
      em.x = em.entity.pos.x; em.y = em.entity.pos.y; em.z = em.entity.pos.z;
    }
    const n = (now - em.birth) / em.life;
    if (n >= 1) { releaseEmitter(em); continue; }
    em.acc += dt;
    const period = 1 / em.rate;
    let guard = 0;
    while (em.acc >= period && guard++ < 4) { em.acc -= period; emitAuraParticle(em); }
    // persistent effects light the floor CONTINUOUSLY (parent point 2): ignite, DoT/caustic field, loot
    if (em.kind === IGNITE) ensureSteadyLight(em, VC.light.aura, 9, 0.5);
    else if (em.kind === LOOT) ensureSteadyLight(em, VC.light.loot, 11, 0.12);
    else if (em.kind === POISON) ensureSteadyLight(em, VC.light.aura, Math.max(9, (em.data || 3) * 3.2), 0.25);
  }
}

function emitAuraParticle(em) {
  const x = em.x, y = em.y, z = em.z;
  if (em.kind === IGNITE) {
    applyColor('fire', em.hex, 2.8);
    const a = Math.random() * 6.283, rr = Math.random() * 0.4;
    pEmber(x + Math.cos(a) * rr, y + 0.4 + Math.random() * 0.8, z + Math.sin(a) * rr,
      Math.cos(a) * 0.4, 1.2 + Math.random() * 1.2, Math.sin(a) * 0.4, 0.2 + Math.random() * 0.12, 0.45 + Math.random() * 0.35);
    if (Math.random() < 0.3) pGlow(x, y + 0.5, z, 0, 1, 0, 0.6, 0.2, 0.3);
  } else if (em.kind === CHILL) {
    applyColor('cold', em.hex, 2.4);
    const a = Math.random() * 6.283, rr = 0.3 + Math.random() * 0.5;
    pShard(x + Math.cos(a) * rr, y + 1.0 + Math.random() * 0.4, z + Math.sin(a) * rr,
      Math.cos(a) * 0.3, -0.6 - Math.random(), Math.sin(a) * 0.3, 0.22, 0.5 + Math.random() * 0.3);
  } else if (em.kind === SHOCK) {
    applyColor('lightning', em.hex, 3.0);
    randHemi(false);
    pShard(x, y + 0.6 + Math.random() * 0.6, z, _dir.x * 6, _dir.y * 6, _dir.z * 6, 0.24, 0.1 + Math.random() * 0.1);
  } else if (em.kind === BLEED) {
    applyColor('blood', -1, 1);
    const a = Math.random() * 6.283, rr = Math.random() * 0.3;
    pBlood(x + Math.cos(a) * rr, y + 0.6, z + Math.sin(a) * rr, Math.cos(a) * 1.2, 0.4, Math.sin(a) * 1.2, 0.22, 0.5);
    if (Math.random() < 0.25) { const gy = groundY(x, z, y); sys.emitDecalBlood(pickFrame('blood', Math.random()), PAL.blood.core[0], PAL.blood.core[1], PAL.blood.core[2], x + (Math.random() - 0.5), gy, z + (Math.random() - 0.5), 0.7 + Math.random() * 0.5, Math.random() * 6.28, VC.bloodLife * 0.4, Math.random()); }
  } else if (em.kind === POISON) {
    applyColor('chaos', em.hex, 2.4);
    const a = Math.random() * 6.283, rr = Math.random() * em.data * 0.9;
    pGlow(x + Math.cos(a) * rr, y + 0.1 + Math.random() * 0.3, z + Math.sin(a) * rr, 0, 0.6 + Math.random() * 0.6, 0, 0.35, 0.7, true);
  } else if (em.kind === LOOT) {
    SPAWN.r0 = hexR(em.hex) * 3.2; SPAWN.g0 = hexG(em.hex) * 3.2; SPAWN.b0 = hexB(em.hex) * 3.2;
    SPAWN.r1 = hexR(em.hex) * 0.8; SPAWN.g1 = hexG(em.hex) * 0.8; SPAWN.b1 = hexB(em.hex) * 0.8;
    const jx = (Math.random() - 0.5) * 0.18, jz = (Math.random() - 0.5) * 0.18;
    SPAWN.px = em.x + jx; SPAWN.py = em.y + 0.1; SPAWN.pz = em.z + jz;
    SPAWN.vx = 0; SPAWN.vy = 4 + Math.random() * 1.5; SPAWN.vz = 0;
    SPAWN.drag = 0.5; SPAWN.gravity = 0; SPAWN.life = 0.9;
    SPAWN.sizeStart = 0.7 * em.data; SPAWN.sizeEnd = 0.35 * em.data;
    SPAWN.rot0 = 0; SPAWN.spin = 0; SPAWN.frame = pickFrame('glow', Math.random());
    SPAWN.flags = 1; SPAWN.additive = true; sys.emit();
    if (Math.random() < 0.4) pEmber(em.x + jx, em.y + 0.2, em.z + jz, 0, 2 + Math.random() * 2, 0, 0.16, 0.8);
    em.glowT -= 1 / em.rate;
    if (em.glowT <= 0) {
      em.glowT = 0.5;
      sys.emitLootGlow(hexR(em.hex) * 2.5, hexG(em.hex) * 2.5, hexB(em.hex) * 2.5, em.x, em.y, em.z, 1.8 * em.data, 0, 0.55, Math.random());
    }
  }
}

// -------------------------------------------------------------------- blood
function sprayBlood(x, y, z, dx, dy, dz, amount) {
  if (sys.now - lastBloodT < 0.04) {   // de-dup near-simultaneous sprays at one spot
    const ddx = x - lastBloodX, ddz = z - lastBloodZ;
    if (ddx * ddx + ddz * ddz < 0.25) return;
  }
  lastBloodT = sys.now; lastBloodX = x; lastBloodZ = z;
  const yy = y + 0.6;
  const big = amount > 60;
  applyColor('blood', -1, 1);
  _dir.set(dx, dy, dz);
  if (_dir.lengthSq() < 1e-6) randHemi(true); else _dir.normalize();
  const n = big ? 12 : 7;
  for (let i = 0; i < n; i++) {
    const sp = 3 + Math.random() * 6;
    const jx = _dir.x + (Math.random() - 0.5) * 0.8;
    const jy = Math.abs(_dir.y) + 0.4 + Math.random() * 0.6;
    const jz = _dir.z + (Math.random() - 0.5) * 0.8;
    pBlood(x, yy, z, jx * sp, jy * sp, jz * sp, 0.22 + Math.random() * 0.16, 0.55 + Math.random() * 0.3);
  }
  const gy = groundY(x, z, y);         // ground decal — defer to PropsDress if present, else our own
  let handled = false;
  if (World.decals && typeof World.decals.addBloodDecal === 'function') {
    try { World.decals.addBloodDecal(x, gy, z, (big ? 1.6 : 1.0)); handled = true; } catch (e) { handled = false; }
  }
  if (!handled) {
    sys.emitDecalBlood(pickFrame('blood', Math.random()),
      PAL.blood.core[0], PAL.blood.core[1], PAL.blood.core[2],
      x, gy, z, (big ? 1.5 : 1.0) + Math.random() * 0.4, Math.random() * 6.28, VC.bloodLife, Math.random());
  }
}

function kDeath(x, y, z, dx, dy, dz, s, type, hex) {
  sprayBlood(x, y, z, dx, dy, dz, 90);            // heavy burst + accumulating decals + lingering pool (§7)
  const gy = groundY(x, z, y);
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * 6.283, rr = Math.random() * 1.2;
    sys.emitDecalBlood(pickFrame('blood', Math.random()),
      PAL.blood.core[0], PAL.blood.core[1], PAL.blood.core[2],
      x + Math.cos(a) * rr, gy, z + Math.sin(a) * rr, 0.8 + Math.random() * 0.7, Math.random() * 6.28, VC.bloodLife, Math.random());
  }
  sys.emitDecalBlood(pickFrame('blood', Math.random()),
    PAL.blood.core[0] * 0.8, PAL.blood.core[1], PAL.blood.core[2],
    x, gy, z, 2.2 * (s || 1), Math.random() * 6.28, VC.deathDecalLife, Math.random());
  SPAWN.r0 = 0.10; SPAWN.g0 = 0.09; SPAWN.b0 = 0.078; SPAWN.r1 = 0.02; SPAWN.g1 = 0.017; SPAWN.b1 = 0.014;
  for (let i = 0; i < 5; i++) { randHemi(false); pDust(x, gy + 0.15, z, _dir.x * 1.5, 0.3 + Math.random(), _dir.z * 1.5, 0.7, 2.0, 0.7); }
}

function kLevelUp(px, py, pz) {
  PW = 1;                              // full-power event; not routed through dispatch/onVfxSpawn
  const x = World.player ? World.player.pos.x : (px || 0);
  const y = World.player ? World.player.pos.y : (py || 0);
  const z = World.player ? World.player.pos.z : (pz || 0);
  const gy = groundY(x, z, y);
  applyRingColor(0xffcf58, palOf('holy'));
  sys.groundFx.emit(sys.now, 6, 0, ringR, ringG, ringB, x, gy, z, 4.0, 0, 0.8, 0, Math.random());
  sys.emitMagicCircle(PAL.holy.core[0], PAL.holy.core[1], PAL.holy.core[2], x, gy, z, 2.6, 0, 1.6, Math.random());
  setWhite(6.0); pFlash(x, y + 1.0, z, 3.0, 0.3); applyColor('holy', -1, 3.0);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * 6.283;
    pEmber(x + Math.cos(a) * 0.5, y + 0.3, z + Math.sin(a) * 0.5, Math.cos(a) * 2, 5 + Math.random() * 4, Math.sin(a) * 2, 0.26, 1.0 + Math.random() * 0.6);
  }
  for (let i = 0; i < 10; i++) pGlow(x, y + 0.4 + i * 0.18, z, 0, 3, 0, 0.9, 0.3, 0.5);
  attachLight(x, y + 1.0, z, 0xffcf58, VC.light.levelup, 1.2, 24, 0.22, 3);
  punch(0.4, x, y, z, 'holy', 0xffcf58);
}

// ---------------------------------------------------------------- dispatch
const KIND = {
  impact: (x, y, z, dx, dy, dz, s, t, h, d) => kImpact(x, y, z, dx, dy, dz, s, t, h, d, false),
  crit:   (x, y, z, dx, dy, dz, s, t, h, d) => kImpact(x, y, z, dx, dy, dz, s, t, h, d, true),
  fireImpact: kFireImpact,
  fireball: kMuzzle,
  muzzle: kMuzzle,
  lance: kLance,
  slamRing: kSlamRing,
  nova: kNova,
  beam: kBeam,
  beamTip: kBeamTip,
  chainArc: kChainArc,
  cleaveArc: kCleaveArc,
  frost: kFrost,
  projTrail: kProjTrail,
  dustPuff: kDustPuff,
  emberShower: kEmberShower,
  magicCircle: kMagicCircle,
  telegraph: kTelegraph,
  death: kDeath,
  levelup: kLevelUp,
  blood: (x, y, z, dx, dy, dz) => sprayBlood(x, y, z, dx, dy, dz, 40),
  ignite: (x, y, z, dx, dy, dz, s, t, h) => spawnAura(IGNITE, x, y, z, 'fire', h),
  chill: (x, y, z, dx, dy, dz, s, t, h) => spawnAura(CHILL, x, y, z, 'cold', h),
  shock: (x, y, z, dx, dy, dz, s, t, h) => spawnAura(SHOCK, x, y, z, 'lightning', h),
  bleed: (x, y, z, dx, dy, dz, s, t, h) => spawnAura(BLEED, x, y, z, 'blood', h),
  poisonField: (x, y, z, dx, dy, dz, s, t, h, d) => spawnPoisonField(x, y, z, s, h, d),
  poisonTick: (x, y, z, dx, dy, dz, s, t, h) => { applyColor('chaos', h, 2.4); for (let i = 0; i < 3; i++) { randHemi(true); pGlow(x, y + 0.4, z, _dir.x, _dir.y + 1, _dir.z, 0.3, 0.15, 0.4, true); } },
  lootBeam: (x, y, z, dx, dy, dz, s, t, h) => spawnLootBeam(x, y, z, h, s),
  lootPickup: (x, y, z, dx, dy, dz, s, t, h) => { killLootBeamNear(x, z); applyColor('holy', h, 2.8); for (let i = 0; i < 8; i++) { randHemi(true); const sp = 2 + Math.random() * 4; pSpark(x, y + 0.3, z, _dir.x * sp, _dir.y * sp + 3, _dir.z * sp, 0.3, 0.4); } },
};
// combat/ai kind synonyms -> canonical kinds
const ALIAS = {
  melee: 'impact', hit: 'impact', slash: 'cleaveArc', cleave: 'cleaveArc',
  slam: 'slamRing', aoe: 'slamRing', explosion: 'fireImpact', muzzleflash: 'muzzle',
  chain: 'chainArc', circle: 'magicCircle', dust: 'dustPuff', ember: 'emberShower',
  levelUp: 'levelup', ground: 'telegraph',
};

function dispatch(kind, px, py, pz, dx, dy, dz, scale, type, hex, dur) {
  const fn = KIND[kind] || KIND[ALIAS[kind]];
  if (!fn) return;
  fn(px, py, pz, dx, dy, dz, scale, type, hex, dur);
}

// ------------------------------------------------------------ event handlers
function onVfxSpawn(p) {
  if (!sys || !p) return;
  const pos = p.pos, dir = p.dir;
  const px = pos ? pos.x : 0, py = pos ? pos.y : 0, pz = pos ? pos.z : 0;
  const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 0;
  const scale = p.scale != null ? p.scale : 1;
  const hex = p.color != null ? p.color : -1;
  PW = p.power != null ? clamp01(p.power) : 1;
  dispatch(p.kind, px, py, pz, dx, dy, dz, scale, p.type || null, hex, p.duration != null ? p.duration : 0);
}

function onDamage(p) {
  if (!sys || !p) return;
  const pos = p.pos; if (!pos) return;
  const type = p.type || 'physical';
  // physical/bleed/chaos hits gush blood; elemental hits get their own VFX via VFX_SPAWN
  const t = TYPE_ALIAS[type] || type;
  if (t === 'physical' || t === 'blood' || t === 'chaos') {
    randHemi(true);
    sprayBlood(pos.x, pos.y, pos.z, _dir.x, _dir.y, _dir.z, p.amount || 20);
  }
  if (p.crit) punch(0.35, pos.x, pos.y, pos.z, type, p.color != null ? p.color : -1);
}

function onDied(p) {
  if (!sys || !p) return;
  const e = p.entity, pos = p.pos || (e && e.pos); if (!pos) return;
  let dx = 0, dy = 0.4, dz = 0;
  if (e && e.vel) { dx = e.vel.x; dz = e.vel.z; }
  const s = e ? Math.min(1.6, (e.radius || 0.5) * 2) : 1;
  kDeath(pos.x, pos.y, pos.z, dx, dy, dz, s, null, -1);
}

function onLootDrop(p) {
  if (!sys || !p) return;
  const pos = p.pos; if (!pos) return;    // brief sparkle + glow only; LootSystem owns the standing pillar
  const gy = groundY(pos.x, pos.z, pos.y);
  applyColor('holy', -1, 2.6);
  for (let i = 0; i < 6; i++) { randHemi(true); const sp = 2 + Math.random() * 3; pSpark(pos.x, gy + 0.2, pos.z, _dir.x * sp, _dir.y * sp + 2, _dir.z * sp, 0.28, 0.4); }
  sys.emitLootGlow(PAL.holy.core[0], PAL.holy.core[1], PAL.holy.core[2], pos.x, gy, pos.z, 1.4, 0, 0.7, Math.random());
}

// ----------------------------------------------------------------- system
export default {
  name: 'vfx',
  init({ scene, camera, renderer }) {
    sys = new ParticleSystem(scene, camera, VC);
    screenPass = new VfxScreenPass();
    const size = renderer.getSize(new THREE.Vector2());
    screenPass.setAspect(size.x / Math.max(1, size.y));
    // Expose for RenderPipeline to adopt into its composer (we do NOT own a composer).
    World.vfxScreenPass = screenPass;
    lastLevel = World.stats ? World.stats.level : 1;
    bus.on(EV.VFX_SPAWN, onVfxSpawn);
    bus.on(EV.DAMAGE_DEALT, onDamage);
    bus.on(EV.ENTITY_DIED, onDied);
    bus.on(EV.LOOT_DROP, onLootDrop);
  },
  frame(dt, t) {
    if (!sys) return;
    // watch for level-up (stat-driven burst; no dedicated event in the contract)
    if (World.stats && World.stats.level > lastLevel) { lastLevel = World.stats.level; kLevelUp(); }
    updateEmitters(dt, sys.now + dt);   // emitters use the about-to-be-advanced clock
    sys.update(dt);                     // advances sys.now, flushes buffers, updates ribbons/lights
    // screen feedback decay + advance
    if (screenPass) {
      screenHitT += dt;
      screenImpact *= Math.exp(-VC.screenDecay * dt);
      if (screenImpact < 0.002) screenImpact = 0;
      screenPass.setImpact(screenImpact);
      screenPass.setHitTime(screenHitT);
    }
  },
  resize(w, h) { if (screenPass) screenPass.setAspect(w / Math.max(1, h)); },
  dispose() {
    bus.off(EV.VFX_SPAWN, onVfxSpawn);
    bus.off(EV.DAMAGE_DEALT, onDamage);
    bus.off(EV.ENTITY_DIED, onDied);
    bus.off(EV.LOOT_DROP, onLootDrop);
    if (sys) sys.dispose();
    if (screenPass) screenPass.dispose();
    sys = null; screenPass = null; World.vfxScreenPass = null;
  },
};

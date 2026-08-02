// EXILIUM — combat orchestrator (owner: CombatSkills)
// Owns: skill execution, damage resolution, hit detection vs World.hash, the
// 5-channel impact orchestration, hitstop/shake scaled by damage & crit, status
// ailments, death (ragdoll + lingering decal), knockback/stagger, boss telegraphs.
//
// I own the TIMING & IMPACT half of rubric §7. Every meaningful hit fires FIVE
// simultaneous channels:
//   (a) flash            -> EV.VFX_SPAWN {kind:'crit'|hit} + pooled decaying PointLight
//   (b) particle burst   -> EV.VFX_SPAWN {kind: blood/element}
//   (c) screen-space     -> EV.CAMERA_SHAKE (scaled by damage/crit)
//   (d) decal            -> EV.VFX_SPAWN {kind:'blood'} + my own pooled ground decal
//   (e) audio-shaped      -> EV.SFX_PLAY {id} + EV.DAMAGE_DEALT (HUD number) + EV.HITSTOP
import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';
import { moveCapsule, spawnRagdoll } from '../core/physics.js';
import { computeDamage, mulberry32 } from './damage.js';
import { Projectiles } from './projectiles.js';
import { SKILLS, KEY_TO_SKILL, resolveSkill, TYPE_COLOR, BLOOD_COLOR } from './skills.js';

// EnemyAI requests enemy hits through this bus string (agreed contract).
const EV_ENEMY_ATTACK = 'combat:enemyAttack';

// Impact tuning (config only exposes hitStopMs/critMultiplier; the rest live here).
//
// These are ~3x SHORTER than the values first shipped, for two reasons.
//
// 1. The clock had a unit bug (see core/clock.js): the freeze deadline was held in SIM
//    time while sim ran at the frozen scale, so every duration here was multiplied by
//    1/scale ≈ 16.5x in real time. A 62 ms "normal hit" froze for 963 ms and a 210 ms
//    crit slam for 3,473 ms — measured. The clock now deadlines in real time.
// 2. Even correctly timed, the old ceiling was too long for an ARPG. At 8+ hits/second in
//    a pack, a 210 ms freeze consumes a fifth of every second; the game reads as heavy
//    rather than responsive. Reference ARPG hitstop sits in the 20-80 ms band.
//
// Resulting real-time freezes (weight x severity ramp, capped):
//     Cleave (w 1.00)        ~28 ms,  crit ~42 ms
//     Ground Slam (w 1.80)   ~50 ms,  crit ~70 ms (at the cap — still THUMPS)
//     Void Beam (w 0.28)     ~14 ms   (floor — sustained, never punchy)
const HITSTOP_MAX = 70;           // ms ceiling — a crit slam lands here
const HITSTOP_MIN = 14;           // ms — lightest impact still reads
const CRIT_HITSTOP = 1.5;         // crit extends the freeze without stalling the fight
const CRIT_SHAKE = 1.7;
const SHAKE_MAX = 1.0;
const DECAL_POOL = 28;
const LIGHT_POOL = 12;
const LIGHT_LIFE = 0.26;          // s — impact flash decay
const DOT_INTERVAL = 0.25;        // s — DoT flush cadence (~4 damage numbers/sec/type)

// ---- module-scope temporaries (zero per-frame allocation) --------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _dashDelta = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// per-cast impact aggregation so an AoE emits ONE hitstop/shake, not one per target
let _agg = false, _aggHitstop = 0, _aggShake = 0;

let projectiles = null;
const rng = mulberry32(0x1a2b3c4d);

// player offensive profile — recomputed when character level changes
const playerProfile = { level: 0, added: 0, increased: 0, more: 1, critChance: 0, critMulti: CFG.combat.critMultiplier, accuracy: 1200, penetration: 0 };
function refreshProfile() {
  const lvl = World.stats.level || 1;
  if (playerProfile.level === lvl) return;
  playerProfile.level = lvl;
  playerProfile.added = 6 + lvl * 2.5;
  playerProfile.increased = (lvl - 1) * 5;              // +5% increased per level
  playerProfile.critChance = 0.05 + lvl * 0.004;
  playerProfile.accuracy = 1150 + lvl * 34;
}

// ---- pooled ground decals (the lingering death/impact stain, rubric §7) -------
let decalTex = null;
const decals = [];
let _decalHead = 0;
function makeBloodTexture() {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;
  const grad = g.createRadialGradient(cx, cy, 4, cx, cy, s * 0.46);
  grad.addColorStop(0, 'rgba(70,6,8,0.95)');
  grad.addColorStop(0.5, 'rgba(96,10,12,0.8)');
  grad.addColorStop(1, 'rgba(40,4,6,0)');
  g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, s * 0.46, 0, Math.PI * 2); g.fill();
  // irregular lobes + spatter droplets so it never reads as a clean circle
  for (let i = 0; i < 10; i++) {
    const a = rng() * Math.PI * 2, r = s * (0.24 + rng() * 0.2);
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r, rr = s * (0.05 + rng() * 0.09);
    const lg = g.createRadialGradient(px, py, 1, px, py, rr);
    lg.addColorStop(0, 'rgba(84,8,10,0.85)'); lg.addColorStop(1, 'rgba(60,6,8,0)');
    g.fillStyle = lg; g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2, r = s * (0.36 + rng() * 0.12);
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r, rr = s * (0.01 + rng() * 0.03);
    g.fillStyle = `rgba(72,6,8,${0.5 + rng() * 0.4})`;
    g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function initDecals(scene) {
  decalTex = makeBloodTexture();
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < DECAL_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: decalTex, transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.visible = false; m.renderOrder = 1;
    scene.add(m);
    decals.push({ mesh: m, life: 0, maxLife: 1 });
  }
}
function dropDecal(x, y, z, size, maxLife) {
  const d = decals[_decalHead = (_decalHead + 1) % DECAL_POOL];
  d.mesh.visible = true;
  d.mesh.position.set(x, y + 0.03, z);
  d.mesh.rotation.z = rng() * Math.PI * 2;
  d.mesh.scale.set(size, size, 1);
  d.life = 0; d.maxLife = maxLife;
  d.mesh.material.opacity = 0.92;
}

// ---- pooled decaying impact point-lights (the "spells light the floor" flash) --
const lights = [];
let _lightHead = 0;
function initLights(scene) {
  for (let i = 0; i < LIGHT_POOL; i++) {
    const L = new THREE.PointLight(0xffffff, 0, 9, 2);   // decay=2 -> inverse-square
    L.castShadow = false; L.visible = false;
    scene.add(L);
    lights.push({ light: L, life: 0, maxLife: LIGHT_LIFE, peak: 0 });
  }
}
function flashLight(x, y, z, color, intensity, range) {
  const l = lights[_lightHead = (_lightHead + 1) % LIGHT_POOL];
  l.light.visible = true;
  l.light.color.setHex(color);
  l.light.position.set(x, y + 0.5, z);
  l.light.distance = range;
  l.peak = intensity; l.light.intensity = intensity;
  l.life = 0; l.maxLife = LIGHT_LIFE;
}

// ---- status ailment registry ------------------------------------------------
function statusOf(e) {
  return e.status || (e.status = {
    ignite: null, bleed: null, chill: 0, chillDur: 0,
    freeze: 0, shock: 0, shockDur: 0, poison: [],
    // DoT damage accumulates continuously but is flushed on a cadence (DOT_INTERVAL)
    // so we emit ~4 damage numbers/sec, not 60 — zero per-frame alloc, no number spam.
    fireAcc: 0, physAcc: 0, chaosAcc: 0, dotT: 0,
  });
}
// Apply one ailment packet from a hit. `hitDmg` scales DoT magnitude.
function applyAilment(e, ail, hitDmg) {
  if (!ail || !e.alive) return;
  if (rng() >= (ail.chance == null ? 1 : ail.chance)) return;
  const s = statusOf(e);
  const mag = ail.mag || 0.3, dur = ail.dur || 3;
  switch (ail.type) {
    case 'ignite': {                                     // fire DoT, strongest replaces
      const dps = (hitDmg * mag) / dur;
      if (!s.ignite || dps > s.ignite.dps) s.ignite = { dps, t: dur, type: 'fire' };
      bus.emit(EV.VFX_SPAWN, { kind: 'ignite', pos: e.pos, color: TYPE_COLOR.fire, scale: 1 });
      break;
    }
    case 'bleed': {                                      // physical DoT, strongest replaces
      const dps = (hitDmg * mag) / dur;
      if (!s.bleed || dps > s.bleed.dps) s.bleed = { dps, t: dur, type: 'physical' };
      bus.emit(EV.VFX_SPAWN, { kind: 'bleed', pos: e.pos, color: BLOOD_COLOR, scale: 1 });
      break;
    }
    case 'poison': {                                     // chaos DoT, STACKS
      const dps = (hitDmg * mag) / dur;
      if (s.poison.length < 40) s.poison.push({ dps, t: dur });
      e._poisonStacks = s.poison.length;
      bus.emit(EV.VFX_SPAWN, { kind: 'poisonTick', pos: e.pos, color: TYPE_COLOR.chaos, scale: 0.8 });
      break;
    }
    case 'chill':                                        // slow, strongest & refresh
      if (mag >= s.chill || dur >= s.chillDur) { s.chill = Math.max(s.chill, mag); s.chillDur = Math.max(s.chillDur, dur); }
      e.chill = s.chill;
      bus.emit(EV.VFX_SPAWN, { kind: 'frost', pos: e.pos, color: TYPE_COLOR.cold, scale: 0.7 });
      break;
    case 'freeze':                                       // hard CC, refresh longest
      s.freeze = Math.max(s.freeze, dur);
      e.frozen = true;
      bus.emit(EV.VFX_SPAWN, { kind: 'frost', pos: e.pos, color: TYPE_COLOR.cold, scale: 1.1 });
      break;
    case 'shock':                                        // damage amp, strongest & refresh
      if (mag >= s.shock) s.shock = mag;
      s.shockDur = Math.max(s.shockDur, dur);
      e.shock = s.shock;
      bus.emit(EV.VFX_SPAWN, { kind: 'shock', pos: e.pos, color: TYPE_COLOR.lightning, scale: 0.8 });
      break;
  }
}

// Tick all active ailments on an entity. DoT accrues every frame but only applies
// (and emits a number) on the DOT_INTERVAL cadence. Zero per-frame allocation.
function tickStatus(e, dt) {
  const s = e.status; if (!s) return;
  if (s.ignite) { s.fireAcc += s.ignite.dps * dt; if ((s.ignite.t -= dt) <= 0) s.ignite = null; }
  if (s.bleed) { s.physAcc += s.bleed.dps * dt; if ((s.bleed.t -= dt) <= 0) s.bleed = null; }
  if (s.poison.length) {
    for (let i = s.poison.length - 1; i >= 0; i--) {
      const p = s.poison[i]; s.chaosAcc += p.dps * dt;
      if ((p.t -= dt) <= 0) { s.poison[i] = s.poison[s.poison.length - 1]; s.poison.pop(); }
    }
    e._poisonStacks = s.poison.length;
  }
  // flush accumulated DoT on the cadence (one damage number per type per interval)
  s.dotT += dt;
  if (s.dotT >= DOT_INTERVAL) {
    s.dotT -= DOT_INTERVAL;
    if (s.fireAcc >= 1 && e.alive) { const d = s.fireAcc; s.fireAcc = 0; applyDamageRaw(e, d, 'fire', 'ignite'); }
    if (s.physAcc >= 1 && e.alive) { const d = s.physAcc; s.physAcc = 0; applyDamageRaw(e, d, 'physical', 'bleed'); }
    if (s.chaosAcc >= 1 && e.alive) { const d = s.chaosAcc; s.chaosAcc = 0; applyDamageRaw(e, d, 'chaos', 'poison'); }
  }
  if (s.chillDur > 0) { if ((s.chillDur -= dt) <= 0) { s.chill = 0; e.chill = 0; } }
  if (s.freeze > 0) { if ((s.freeze -= dt) <= 0) { e.frozen = false; } }
  if (s.shockDur > 0) { if ((s.shockDur -= dt) <= 0) { s.shock = 0; e.shock = 0; } }
}

// ---- damage → the 5 impact channels -----------------------------------------

// Build a full damage spec from a skill's packet + a caster profile.
function buildSpec(dmg, prof, canMiss) {
  return {
    base: dmg.base, type: dmg.type,
    added: (dmg.added || 0) + (prof ? prof.added : 0),
    increased: (dmg.increased || 0) + (prof ? prof.increased : 0),
    more: (dmg.more == null ? 1 : dmg.more) * (prof ? prof.more : 1),
    critChance: (dmg.critChance || 0) + (prof ? prof.critChance : 0),
    critMulti: prof ? prof.critMulti : CFG.combat.critMultiplier,
    penetration: (dmg.penetration || 0) + (prof ? prof.penetration : 0),
    canMiss: !!canMiss,
    accuracy: prof ? prof.accuracy : 1000,
  };
}

// Hitstop/shake as an explicit non-linear function of how big the hit was relative
// to the target. severity^0.6 front-loads the curve so even modest hits read, then
// the skill's weight and a crit (×2 freeze) stack on top. Every impact hit freezes.
export function impactFor(finalDmg, crit, maxHp, weights) {
  const severity = Math.min(1, finalDmg / Math.max(1, maxHp || finalDmg));
  const ramp = Math.pow(severity, 0.6);                 // front-loaded response
  const w = weights ? weights.hitstop : 1;
  const ws = weights ? weights.shake : 1;
  // base freeze scales the reference 62ms by skill weight & severity, floored so it reads
  let hs = Math.max(HITSTOP_MIN * w, CFG.combat.hitStopMs * w * ramp);
  if (crit) hs *= CRIT_HITSTOP;                          // a crit lands at ~2× the freeze
  let sh = Math.max(0.05 * ws, 0.13 * ws * (0.4 + ramp * 1.4));
  if (crit) sh *= CRIT_SHAKE;
  return { hitstop: Math.min(HITSTOP_MAX, hs), shake: Math.min(SHAKE_MAX, sh), crit };
}

/**
 * Resolve one hit and fire the impact channels.
 * @param target entity
 * @param spec   damage spec (from buildSpec)
 * @param srcPos Vector3 origin of the hit (for knockback direction & decal)
 * @param opts   { impact, weights, ailments, hitDmgForAil, knockback, stagger, vfxHit, sfxHit, color, dmgScale }
 */
function applyHit(target, spec, srcPos, opts) {
  if (!target || !target.alive) return;
  const bd = computeDamage(spec, target, rng);

  if (!bd.hit) {                                          // graze/miss — minimal feedback
    bus.emit(EV.VFX_SPAWN, { kind: 'miss', pos: target.pos, color: 0x888888, scale: 0.5 });
    bus.emit(EV.SFX_PLAY, { id: 'miss', pos: target.pos });
    return;
  }

  let amount = bd.final;
  if (opts.dmgScale && opts.dmgScale !== 1) amount = Math.max(0, Math.round(amount * opts.dmgScale));
  const crit = bd.crit, type = spec.type, pos = target.pos;

  // apply to health (prefer the entity's own hurt() so its brain can react)
  if (typeof target.hurt === 'function') target.hurt(amount, { type, crit, source: opts.source });
  else target.hp -= amount;

  // (e) HUD number + audio timing
  bus.emit(EV.DAMAGE_DEALT, { target, amount, crit, type, pos });
  bus.emit(EV.SFX_PLAY, { id: opts.sfxHit || 'hit', pos, gain: crit ? 1 : 0.8 });

  if (opts.impact !== false) {
    const pw = Math.min(1, (opts.power || 0.5) * (crit ? 1.5 : 1));   // normalized 0..1 for VFX scaling
    // (a) flash — VFX + a real decaying point light so the hit lights nearby geometry
    bus.emit(EV.VFX_SPAWN, { kind: crit ? 'crit' : (opts.vfxHit || 'impact'), pos, color: opts.color || TYPE_COLOR[type] || 0xffffff, scale: crit ? 1.5 : 1, power: pw });
    flashLight(pos.x, pos.y, pos.z, opts.color || TYPE_COLOR[type] || 0xffffff, crit ? 10 : 5.5, crit ? 11 : 8);
    // (b) particle burst — blood for creatures, element spray otherwise
    bus.emit(EV.VFX_SPAWN, { kind: target.kind === 'prop' ? 'debris' : 'blood', pos, color: target.kind === 'prop' ? 0x9a8f7a : BLOOD_COLOR, scale: crit ? 1.4 : 1, power: pw });
    // (c)+(e) screen-space shake + hitstop, scaled by damage & crit (aggregated per cast)
    const imp = impactFor(amount, crit, target.maxHp, opts.weights);
    if (_agg) { if (imp.hitstop > _aggHitstop) _aggHitstop = imp.hitstop; if (imp.shake > _aggShake) _aggShake = imp.shake; }
    else emitImpactFeel(imp);
    // (d) decal — transient splatter to VFX; the LINGERING stain is my pooled decal on heavier hits
    if (amount > (target.maxHp || 100) * 0.12 || crit) dropDecal(pos.x, pos.y, pos.z, 1.1 + (crit ? 0.6 : 0), 6.5);
  }

  // ailments
  if (opts.ailments) for (let i = 0; i < opts.ailments.length; i++) applyAilment(target, opts.ailments[i], opts.hitDmgForAil || amount);

  // knockback + stagger (proportional to damage), wall-respecting via moveCapsule
  if (opts.knockback) applyKnockback(target, srcPos, opts.knockback, amount, opts.stagger || 0);

  // death
  if (target.hp <= 0 && target.alive) killEntity(target, pos);
}

function emitImpactFeel(imp) {
  // impact hits always fire both screen-space channels; the curve floors guarantee
  // the freeze is perceptible. DoT ticks never reach here (they pass impact:false).
  if (imp.shake > 0) bus.emit(EV.CAMERA_SHAKE, imp.shake);
  if (imp.hitstop > 0) bus.emit(EV.HITSTOP, imp.hitstop);
}

// Fixed non-crit tick damage (DoT / field) — 3 lighter channels, no hitstop/shake.
function applyDamageRaw(target, amount, type, sfxTag) {
  if (!target || !target.alive || amount <= 0) return;
  const a = Math.max(1, Math.round(amount));
  if (typeof target.hurt === 'function') target.hurt(a, { type, dot: true });
  else target.hp -= a;
  bus.emit(EV.DAMAGE_DEALT, { target, amount: a, crit: false, type, pos: target.pos });
  if (sfxTag) bus.emit(EV.SFX_PLAY, { id: sfxTag, pos: target.pos, gain: 0.35 });   // soft DoT tick
  if (target.hp <= 0 && target.alive) killEntity(target, target.pos);
}

function applyKnockback(target, srcPos, scalar, dmg, staggerScalar) {
  if (target.kind === 'player') { target.stagger = Math.max(target.stagger || 0, 0.12 * scalar); return; }
  _kb.set(target.pos.x - srcPos.x, 0, target.pos.z - srcPos.z);
  const len = _kb.length();
  if (len < 1e-3) _kb.set(Math.cos(target.facing || 0), 0, Math.sin(target.facing || 0));
  else _kb.multiplyScalar(1 / len);
  // displacement scales with damage fraction, clamped; heavy skills push hard
  const frac = Math.min(1, dmg / Math.max(1, target.maxHp || 100));
  const push = scalar * (0.5 + frac * 2.2);
  _kb.multiplyScalar(push);
  moveCapsule(target, _kb);
  target.stagger = Math.max(target.stagger || 0, 0.18 + scalar * 0.4 + staggerScalar * 0.5);
}

function killEntity(e, pos) {
  if (!e.alive) return;
  e.alive = false; e.hp = 0;
  if (e.faction === 'monster') World.stats.kills = (World.stats.kills || 0) + 1;
  // NOTE: the player's loss condition is NOT emitted here. `player.js:hurt()` sets
  // `alive = false` itself, so applyDamage's `if (target.hp <= 0 && target.alive)` guard is
  // already false and this function never runs for the player. An emit placed here was
  // unreachable dead code — GAME_LOST lives in player.js `hurt()` instead.
  // death de-dup with EnemyAI (whoever kills sets the flag first)
  if (!e._diedEmitted) {
    e._diedEmitted = true;
    bus.emit(EV.ENTITY_DIED, { entity: e, pos });
  }
  // ragdoll — guarded, physics.spawnRagdoll may be a stub returning null
  try { spawnRagdoll && spawnRagdoll(e); } catch (_) { /* physics not ready */ }
  // lingering blood pool (rubric §7: death is never a fade-out) + death burst
  dropDecal(pos.x, pos.y, pos.z, 2.0 + (e.radius || 0.4) * 1.5, 14);
  bus.emit(EV.VFX_SPAWN, { kind: 'death', pos, color: BLOOD_COLOR, scale: 1.4 + (e.radius || 0.4), power: Math.min(1, 0.6 + (e.radius || 0.4)) });
  bus.emit(EV.SFX_PLAY, { id: 'death', pos });
  if (e === World.boss) World.boss = null;
}

// ---- faction / shape helpers -------------------------------------------------
function canTarget(source, e) {
  if (!e || !e.alive) return false;
  if (e === source) return false;
  if (e.kind === 'prop') return !source || source.faction === 'player';   // player breaks props
  return !source || e.faction !== source.faction;                          // never friendly-fire
}

// ---- channels (beams), fields (DoT ground), pending windup resolves ----------
const channels = [];        // { skill, source, until, next, spec }
const fields = [];          // { pos, radius, until, next, tickRate, spec, ailments, source, color, mesh? }
const pending = [];         // { at, fn }

// ---- skill executors ---------------------------------------------------------
const queryBuf = [];

function coneHit(skill, spec, source, origin, dir) {
  const sh = skill.shape, range = sh.range, half = (sh.angle || 1.6) / 2;
  World.hash.query(origin.x, origin.z, range + 1.5, queryBuf);
  beginAgg();
  const ang = Math.atan2(dir.x, dir.z);
  let any = false;
  for (let i = 0; i < queryBuf.length; i++) {
    const e = queryBuf[i]; if (!canTarget(source, e)) continue;
    const dx = e.pos.x - origin.x, dz = e.pos.z - origin.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > range + (e.radius || 0.4)) continue;
    let da = Math.atan2(dx, dz) - ang; da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > half) continue;
    hitTarget(e, spec, origin, skill); any = true;
  }
  endAgg(any);
}

function circleHit(skill, spec, source, center, dir) {
  const range = skill.shape.range;
  World.hash.query(center.x, center.z, range + 1.5, queryBuf);
  beginAgg();
  let any = false;
  for (let i = 0; i < queryBuf.length; i++) {
    const e = queryBuf[i]; if (!canTarget(source, e)) continue;
    const dx = e.pos.x - center.x, dz = e.pos.z - center.z;
    if (dx * dx + dz * dz > (range + (e.radius || 0.4)) * (range + (e.radius || 0.4))) continue;
    hitTarget(e, spec, center, skill); any = true;
  }
  endAgg(any);
}

function beamTick(ch) {
  const skill = ch.skill, source = ch.source;
  const origin = source.pos;
  const facing = source.facing || 0;
  _v.set(Math.sin(facing), 0, Math.cos(facing));       // beam re-aims to current facing
  const length = skill.shape.length, halfW = skill.shape.width / 2;
  World.hash.query(origin.x + _v.x * length * 0.5, origin.z + _v.z * length * 0.5, length * 0.5 + 2, queryBuf);
  beginAgg();
  let any = false;
  for (let i = 0; i < queryBuf.length; i++) {
    const e = queryBuf[i]; if (!canTarget(source, e)) continue;
    const rx = e.pos.x - origin.x, rz = e.pos.z - origin.z;
    const along = rx * _v.x + rz * _v.z;                // projection onto beam axis
    if (along < 0 || along > length) continue;
    const perp = Math.abs(rx * _v.z - rz * _v.x);       // perpendicular distance
    if (perp > halfW + (e.radius || 0.4)) continue;
    hitTarget(e, ch.spec, origin, skill); any = true;
  }
  endAgg(any);
  // beam visual + tip
  bus.emit(EV.VFX_SPAWN, { kind: 'beam', pos: origin, dir: _v, scale: length, color: skill.vfx.color, power: powerFor(skill) });
}

function hitTarget(e, spec, srcPos, skill) {
  applyHit(e, spec, srcPos, {
    impact: skill.deliver !== 'field',
    weights: skill.impact,
    ailments: skill.ailments,
    knockback: skill.knockback,
    stagger: skill.stagger || 0,
    vfxHit: skill.vfx.hit,
    sfxHit: skill.sfx.hit,
    color: skill.vfx.color,
    power: powerFor(skill),
    source: World.player,
  });
}

function beginAgg() { _agg = true; _aggHitstop = 0; _aggShake = 0; }
function endAgg(any) {
  _agg = false;
  if (!any) return;
  emitImpactFeel({ hitstop: _aggHitstop, shake: _aggShake, crit: _aggHitstop >= CFG.combat.hitStopMs });
}
// Normalized skill "power" (0..1) for VFX scaling — derived from the skill's impact
// weight so a heavier skill emits a bigger effect. Memoized; crit boost applied at hit.
const _powerCache = new Map();
function powerFor(skill) {
  let p = _powerCache.get(skill.id);
  if (p == null) { p = Math.max(0.12, Math.min(1, (skill.impact ? skill.impact.hitstop : 1) / 1.8)); _powerCache.set(skill.id, p); }
  return p;
}

// Memoized per-skill game-feel payload handed to projectiles (no per-cast alloc).
const _feelCache = new Map();
function feelFor(skill) {
  let f = _feelCache.get(skill.id);
  if (!f) {
    f = { weights: skill.impact, ailments: skill.ailments || null, knockback: skill.knockback || 0, vfxHit: skill.vfx.hit, sfxHit: skill.sfx.hit, power: powerFor(skill) };
    _feelCache.set(skill.id, f);
  }
  return f;
}

function executeSkill(skill, source, origin, dir) {
  refreshProfile();
  const canMiss = skill.deliver === 'cone' || skill.deliver === 'dash';
  const spec = buildSpec(skill.dmg, playerProfile, canMiss);

  // cast VFX + sfx (anticipation strike)
  const pw = powerFor(skill);
  bus.emit(EV.VFX_SPAWN, { kind: skill.vfx.cast, pos: origin, dir, scale: 1, color: skill.vfx.color, power: pw });
  bus.emit(EV.SFX_PLAY, { id: skill.sfx.cast, pos: origin });

  switch (skill.deliver) {
    case 'cone': {
      // alternate the arc a touch so attack1/attack2 read differently
      _v.copy(dir).applyAxisAngle(UP, (rng() - 0.5) * 0.18);
      coneHit(skill, spec, source, origin, _v);
      break;
    }
    case 'circle': circleHit(skill, spec, source, origin, dir); break;
    case 'nova': {
      circleHit(skill, spec, source, source.pos, dir);
      bus.emit(EV.VFX_SPAWN, { kind: 'nova', pos: source.pos, scale: skill.shape.range, color: skill.vfx.color, power: pw });
      break;
    }
    case 'projectile':
      projectiles.spawn(spec, skill.projectile, source, origin, dir, feelFor(skill));
      break;
    case 'beam': {
      // refresh an existing channel for this source+skill rather than stacking
      const now = World.time;
      let ch = null;
      for (let i = 0; i < channels.length; i++) if (channels[i].source === source && channels[i].skill === skill) { ch = channels[i]; break; }
      if (ch) { ch.until = now + skill.channel.duration; }
      else channels.push({ skill, source, spec, until: now + skill.channel.duration, next: now, tickRate: skill.channel.tickRate });
      break;
    }
    case 'field': {
      const f = skill.field, now = World.time;
      fields.push({ pos: origin.clone(), radius: f.radius, until: now + f.duration, next: now, tickRate: f.tickRate, spec, ailments: skill.ailments, source, color: skill.vfx.color });
      bus.emit(EV.VFX_SPAWN, { kind: 'poisonField', pos: origin, scale: f.radius, color: skill.vfx.color, power: pw });
      break;
    }
    case 'dash': {
      const dsh = skill.dash, p = source;
      _dashDelta.copy(dir).setY(0).normalize().multiplyScalar(dsh.distance);
      moveCapsule(p, _dashDelta);                        // teleport, wall-respecting
      p._iframesUntil = World.time + dsh.iframes;         // dodge window
      bus.emit(EV.VFX_SPAWN, { kind: 'blink', pos: p.pos, dir, scale: 1.2, color: skill.vfx.color, power: pw });
      // arrival displacement nova
      World.hash.query(p.pos.x, p.pos.z, dsh.arriveRadius + 1.2, queryBuf);
      beginAgg();
      let any = false;
      for (let i = 0; i < queryBuf.length; i++) {
        const e = queryBuf[i]; if (!canTarget(source, e)) continue;
        const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
        if (dx * dx + dz * dz > dsh.arriveRadius * dsh.arriveRadius) continue;
        hitTarget(e, spec, p.pos, skill); any = true;
      }
      endAgg(any);
      break;
    }
  }
}

// ---- cast validation (cost / cooldown / GCD) --------------------------------
const cd = Object.create(null);   // skillId -> readyAt
let gcdUntil = 0;

function tryCast(ref, origin, dir) {
  const skill = resolveSkill(ref);
  const p = World.player;
  if (!skill || !p || !p.alive) return false;
  const now = World.time;
  if (now < gcdUntil) return false;                       // global cooldown
  if (now < (cd[skill.id] || 0)) return false;            // per-skill cooldown
  if ((p.mana || 0) < (skill.cost || 0)) {                // mana gate
    bus.emit(EV.UI_TOAST, { text: 'Not enough mana', tier: 'warn' });
    bus.emit(EV.SFX_PLAY, { id: 'fizzle' });
    return false;
  }
  p.mana -= skill.cost || 0;
  gcdUntil = now + CFG.combat.globalCooldown;
  if (skill.cooldown) cd[skill.id] = now + skill.cooldown;

  // origin/dir defensive defaults (CharacterRig sends fresh clones, but guard anyway)
  _v2.copy(origin || p.pos);
  const d = dir ? _v.copy(dir) : _v.set(Math.sin(p.facing || 0), 0, Math.cos(p.facing || 0));
  d.y = 0; if (d.lengthSq() < 1e-6) d.set(0, 0, 1); d.normalize();
  executeSkill(skill, p, _v2, d);
  return true;
}

// ---- enemy attacks (EnemyAI requests via 'combat:enemyAttack') ---------------
const enemyProfile = { added: 0, increased: 0, more: 1, critChance: 0.04, critMulti: 1.5, accuracy: 1000, penetration: 0 };

function resolveEnemyAttack(payload) {
  const { attacker, skill, origin, dir, target } = payload;
  if (!attacker || !attacker.alive) return;
  const dmg = { base: skill.damage || 10, type: skill.type || 'physical', critChance: enemyProfile.critChance };
  const spec = buildSpec(dmg, enemyProfile, true);
  const src = origin || attacker.pos;
  const radius = payload.radius || skill.radius || 0;
  const weights = { hitstop: skill.heavy ? 1.4 : 0.6, shake: skill.heavy ? 1.3 : 0.6 };

  const hitOne = (t) => {
    if (!canTarget(attacker, t)) return;
    if (t.kind === 'player' && World.time < (t._iframesUntil || 0)) {   // dodged
      bus.emit(EV.VFX_SPAWN, { kind: 'blink', pos: t.pos, scale: 0.6, color: 0x9fd0ff });
      bus.emit(EV.SFX_PLAY, { id: 'dodge', pos: t.pos });
      return;
    }
    applyHit(t, spec, src, {
      impact: true, weights,
      ailments: skill.ailments || null,
      knockback: skill.knockback || 0.2, stagger: skill.stagger || 0,
      vfxHit: 'impact', sfxHit: skill.sfx || 'hit_enemy',
      color: TYPE_COLOR[dmg.type], power: skill.heavy ? 0.85 : 0.4, source: attacker,
    });
  };

  if (radius > 0) {                                       // AoE: hit all player-faction in radius
    World.hash.query(src.x, src.z, radius + 1.5, queryBuf);
    beginAgg();
    let any = false;
    for (let i = 0; i < queryBuf.length; i++) {
      const e = queryBuf[i];
      const dx = e.pos.x - src.x, dz = e.pos.z - src.z;
      if (dx * dx + dz * dz > (radius + (e.radius || 0.4)) * (radius + (e.radius || 0.4))) continue;
      if (canTarget(attacker, e)) { hitOne(e); any = true; }
    }
    endAgg(any);
  } else {
    hitOne(target || World.player);
  }
}

function onEnemyAttack(payload) {
  if (!payload || !payload.skill) return;
  const w = payload.skill.windup || 0;
  if (w > 0) {                                            // telegraphed heavy — wind-up window
    const src = payload.origin || (payload.attacker && payload.attacker.pos);
    if (src) {
      bus.emit(EV.VFX_SPAWN, { kind: 'telegraph', pos: src, dir: payload.dir, scale: payload.radius || payload.skill.radius || 3, color: payload.skill.telegraphColor || 0xff4020, power: Math.min(1, 0.5 + w) });
      bus.emit(EV.SFX_PLAY, { id: 'windup', pos: src });
    }
    // shake ramps slightly during the wind-up so the blow reads as incoming
    bus.emit(EV.CAMERA_SHAKE, 0.06);
    pending.push({ at: World.time + w, fn: () => resolveEnemyAttack(payload) });
  } else {
    resolveEnemyAttack(payload);
  }
}

// ---- boss tracking -----------------------------------------------------------
function trackBoss() {
  if (World.boss && World.boss.alive) return;
  if (World.boss && !World.boss.alive) World.boss = null;
  const ents = World.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.alive && e.isBoss === true && e.kind === 'enemy' && e.archetype === 'boss') { World.boss = e; return; }
  }
}

// ---- HUD-facing combat state (skill bar / cooldown sweeps / mana) ------------
function buildBar() {
  const order = ['lmb', 'q', 'f', 'e', 'r', '1', '2', '3', '4'];   // 'w' freed for WASD move
  const bar = [];
  for (const key of order) {
    const s = SKILLS[KEY_TO_SKILL[key]]; if (!s) continue;
    bar.push({ id: s.id, name: s.name, key, cost: s.cost, cooldown: s.cooldown });
  }
  return bar;
}
function exposeCombat() {
  const bar = buildBar();
  World.combat = {
    bar,
    globalCooldown: CFG.combat.globalCooldown,
    gcd() { const r = gcdUntil - World.time; return { remain: Math.max(0, r), frac: Math.max(0, Math.min(1, r / CFG.combat.globalCooldown)) }; },
    cooldown(id) {
      const s = SKILLS[id]; const dur = s ? s.cooldown : 0;
      const r = (cd[id] || 0) - World.time;
      return { remain: Math.max(0, r), dur, frac: dur > 0 ? Math.max(0, Math.min(1, r / dur)) : 0 };
    },
    ready(id) {
      const s = SKILLS[id]; if (!s) return false;
      const p = World.player;
      return World.time >= gcdUntil && World.time >= (cd[id] || 0) && (p ? (p.mana || 0) >= (s.cost || 0) : false);
    },
    cast: (ref) => tryCast(ref, World.player && World.player.pos, null),   // HUD/testing entry
  };
}

// ---- system module -----------------------------------------------------------
export default {
  name: 'combat',
  init(c) {
    const scene = c.scene;
    initDecals(scene);
    initLights(scene);
    projectiles = new Projectiles(scene, (target, spec, srcPos, proj, scale) => {
      // projectile hit callback — resolve with the owning skill's feel payload
      const f = proj.feel;
      applyHit(target, spec, srcPos, {
        impact: true,
        weights: f ? f.weights : { hitstop: 1, shake: 0.9 },
        ailments: f ? f.ailments : null,
        knockback: f ? f.knockback : 0.2, stagger: 0,
        vfxHit: f ? f.vfxHit : 'impact', sfxHit: f ? f.sfxHit : 'hit',
        color: proj.color, dmgScale: scale || 1, power: f ? f.power : 0.6,
        source: proj.source,
      });
    });
    exposeCombat();

    bus.on(EV.PLAYER_CAST, ({ skill, origin, dir }) => tryCast(skill, origin, dir));
    bus.on(EV_ENEMY_ATTACK, onEnemyAttack);
  },

  fixed(dt) {
    const now = World.time;

    // 1) pending windup resolves (telegraphed enemy/boss heavies)
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now >= pending[i].at) { const fn = pending[i].fn; pending[i] = pending[pending.length - 1]; pending.pop(); fn(); }
    }

    // 2) channels (beams)
    for (let i = channels.length - 1; i >= 0; i--) {
      const ch = channels[i];
      if (now >= ch.until || !ch.source.alive) { channels[i] = channels[channels.length - 1]; channels.pop(); continue; }
      while (now >= ch.next) { beamTick(ch); ch.next += ch.tickRate; }
    }

    // 3) fields (ground DoT)
    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      if (now >= f.until) { fields[i] = fields[fields.length - 1]; fields.pop(); continue; }
      while (now >= f.next) {
        f.next += f.tickRate;
        World.hash.query(f.pos.x, f.pos.z, f.radius + 1.2, queryBuf);
        for (let j = 0; j < queryBuf.length; j++) {
          const e = queryBuf[j]; if (!canTarget(f.source, e)) continue;
          const dx = e.pos.x - f.pos.x, dz = e.pos.z - f.pos.z;
          if (dx * dx + dz * dz > f.radius * f.radius) continue;
          const bd = computeDamage(f.spec, e, rng);
          applyDamageRaw(e, bd.final, f.spec.type, 'tick_poison');
          if (f.ailments) for (let k = 0; k < f.ailments.length; k++) applyAilment(e, f.ailments[k], bd.final);
        }
        bus.emit(EV.VFX_SPAWN, { kind: 'poisonTick', pos: f.pos, scale: f.radius, color: f.color, power: 0.3 });
      }
    }

    // 4) projectiles
    projectiles.fixed(dt);

    // 5) status ailments + stagger decay on every live entity
    const ents = World.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      if (e.status) tickStatus(e, dt);
      if (e.stagger > 0) { e.stagger -= dt; if (e.stagger < 0) e.stagger = 0; }
    }

    // 6) boss reference for the HUD boss bar
    trackBoss();

    // 7) resource regen (combat owns the mana economy)
    const p = World.player;
    if (p && p.alive) {
      p.mana = Math.min(p.maxMana, (p.mana || 0) + CFG.player.manaRegen * dt);
      p.hp = Math.min(p.maxHp, p.hp + CFG.player.lifeRegen * dt);
    }
  },

  frame(dt) {
    projectiles.frame();
    // decay pooled impact lights (quadratic ease-out for a snappy flash)
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]; if (!l.light.visible) continue;
      l.life += dt;
      const k = 1 - l.life / l.maxLife;
      if (k <= 0) { l.light.visible = false; l.light.intensity = 0; }
      else l.light.intensity = l.peak * k * k;
    }
    // fade pooled decals (hold, then fade tail)
    for (let i = 0; i < decals.length; i++) {
      const d = decals[i]; if (!d.mesh.visible) continue;
      d.life += dt;
      if (d.life >= d.maxLife) { d.mesh.visible = false; continue; }
      const tail = d.maxLife * 0.4;
      const rem = d.maxLife - d.life;
      d.mesh.material.opacity = rem < tail ? 0.92 * (rem / tail) : 0.92;
    }
  },
};

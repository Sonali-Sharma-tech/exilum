// player.js — the exile the player controls. Owner: CharacterRig.
// Assembles the procedural skinned rig (rig.js) + hand-keyframed animation (anim.js),
// drives click-to-move locomotion with acceleration/friction + terrain following, a
// dodge roll with i-frames + root motion, and attack/skill input that emits
// EV.PLAYER_CAST on the STRIKE frame (combat owns all damage). Sets World.player to the
// exact contract entity shape. Talks only via bus/World — no subsystem imports.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { Input } from '../core/input.js';
import * as Physics from '../core/physics.js';        // namespace: robust to physics write order
import { CFG } from '../core/config.js';
import { bus, EV } from '../core/events.js';
import { buildExile, buildCloths } from './rig.js';
import { AnimController, shortAngle } from './anim.js';

// ---- module-scope temps (zero per-frame allocation) ----
const _dest = new THREE.Vector3();
let _holdT = 0;                  // seconds remaining of input-destination suppression
let _wasKeyMove = false;         // true while WASD is driving `_dest`, so release can clear it
const _to = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _rollDir = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _capA = new THREE.Vector3(), _capB = new THREE.Vector3();
const _origin = new THREE.Vector3(), _castDir = new THREE.Vector3();
const _imp = new THREE.Vector3();
// 'w' -> 'f'. W is MOVE FORWARD now; leaving it here made W both walk AND cast Storm Lance
// on the same keypress, and left F unread on this path.
const SKILL_KEYS = ['q', 'f', 'e', 'r', '1', '2', '3', '4'];
const clothCtx = { capA: _capA, capB: _capB, capR: 0.26, wind: 0.4, ground: 0, t: 0 };

function approach(a, b, step) { const d = b - a; return Math.abs(d) <= step ? b : a + Math.sign(d) * step; }

const S = {
  p: null, rig: null, anim: null, cape: null, sash: null,
  facing: 0, turnRate: 0, speed: 0, accelMag: 0,
  rollT: 0, rollCd: 0, attackNext: 1, gcd: 0, castPending: null,
};

export default {
  name: 'player',

  init({ scene }) {
    const rig = buildExile();
    const cloths = buildCloths(rig);
    const anim = new AnimController(rig);
    S.rig = rig; S.anim = anim; S.cape = cloths.cape; S.sash = cloths.sash;

    scene.add(rig.group);
    scene.add(cloths.cape.mesh);
    scene.add(cloths.sash.mesh);

    // register every lit material for CSM sun+shadow (guarded — boot order varies)
    if (World.registerCSMMaterial) {
      const seen = new Set();
      rig.group.traverse((o) => {
        const m = o.material; if (!m) return;
        (Array.isArray(m) ? m : [m]).forEach((mm) => { if (mm && !seen.has(mm)) { seen.add(mm); World.registerCSMMaterial(mm); } });
      });
      for (const c of [cloths.cape, cloths.sash]) if (!seen.has(c.mesh.material)) { seen.add(c.mesh.material); World.registerCSMMaterial(c.mesh.material); }
    }

    // spawn — prefer level start; fall back to origin, y from terrain if known
    const start = World.level?.playerStart;
    const pos = new THREE.Vector3(start ? start.x : 0, 0, start ? start.z : 0);
    pos.y = World.level?.heightAt ? World.level.heightAt(pos.x, pos.z) : (start ? start.y : 0);

    const p = {
      id: 0, kind: 'player', faction: 'player',
      pos, vel: new THREE.Vector3(),
      radius: CFG.player.radius, height: CFG.player.height,
      hp: CFG.player.maxLife, maxHp: CFG.player.maxLife,
      mana: CFG.player.maxMana, maxMana: CFG.player.maxMana,
      alive: true, facing: 0, mesh: rig.group, stagger: 0, armour: 10,
      _iframesUntil: 0,
      hurt: (amount, opts) => hurt(amount, opts),
    };
    S.p = p; _dest.copy(pos);
    rig.group.position.copy(pos);
    World.player = p; World.add(p);

    // reposition when the level (re)builds
    bus.on(EV.LEVEL_READY, ({ level }) => {
      const st = level?.playerStart; if (!st) return;
      p.pos.set(st.x, level.heightAt ? level.heightAt(st.x, st.z) : st.y, st.z);
      _dest.copy(p.pos); p.vel.set(0, 0, 0);
      rig.group.position.copy(p.pos);
    });

    // Teleport that also clears the click-to-move destination.
    //
    // `_dest` is module-scoped and persists, so setting `World.player.pos` directly
    // leaves the old target intact and the player WALKS BACK to it. That silently
    // corrupted the measurement bench: after teleporting to a station the player
    // drifted up to 12 world units during the 9s settle (traced: velocity -1.7 then
    // -4.0, arriving somewhere else entirely), so every station was measuring
    // wherever the player walked to rather than the station coordinate. Any external
    // repositioning — bench, debug, cutscene, waypoint — must go through this.
    World.teleportPlayer = (x, z) => {
      const y = World.level?.heightAt ? World.level.heightAt(x, z) : p.pos.y;
      p.pos.set(x, y, z);
      p.vel.set(0, 0, 0);
      _dest.set(x, y, z);          // the critical line: no stale target to walk to
      _holdT = 1.5;                // and suppress a held/stuck RMB from re-targeting it
      rig.group.position.copy(p.pos);
      return p.pos;
    };
  },

  fixed(dt, t) {
    const p = S.p; if (!p) return;
    World.time = t;

    // ---- cooldown timers ----
    if (S.rollCd > 0) S.rollCd -= dt;
    if (S.gcd > 0) S.gcd -= dt;

    // ---- gather latched input intents (set in frame(), consumed here) ----
    const intent = this._intent || (this._intent = { roll: false, attack: false, skill: null });

    // ---- aim toward cursor (horizontal) ----
    _aim.set(Input.ground.x - p.pos.x, 0, Input.ground.z - p.pos.z);
    const aimYaw = _aim.lengthSq() > 1e-4 ? Math.atan2(_aim.x, _aim.z) : S.facing;

    const busy = S.anim.busy;                 // attack/cast/roll lock (hit is soft)

    // ---- ROLL (dodge) ----
    if (p.alive && S.rollT <= 0 && intent.roll && S.rollCd <= 0 && !busy) {
      _rollDir.copy(_moveDir);
      if (_rollDir.lengthSq() < 1e-4) _rollDir.set(Math.sin(aimYaw), 0, Math.cos(aimYaw));
      _rollDir.normalize();
      S.rollT = CFG.player.rollTime;
      S.rollCd = CFG.player.rollCooldown;
      p._iframesUntil = t + CFG.player.rollTime * 0.72;
      S.facing = Math.atan2(_rollDir.x, _rollDir.z);
      S.anim.play('roll');
      if (S.cape) S.cape.addImpulse(_imp.copy(_rollDir).multiplyScalar(-6.5));
    }

    // ---- ATTACK / SKILL (only when idle-able) ----
    if (p.alive && !busy && S.rollT <= 0) {
      if (intent.skill && S.gcd <= 0) {
        const skill = intent.skill;
        S.gcd = CFG.combat.globalCooldown;
        S.anim.play('cast', () => emitCast(p, skill, aimYaw));
        S.facing = aimYaw;
      } else if ((intent.attack || Input.lmb) && S.gcd <= 0) {
        const which = S.attackNext; S.attackNext = which === 1 ? 2 : 1;
        S.gcd = CFG.combat.globalCooldown;
        S.anim.play(which === 1 ? 'attack1' : 'attack2', () => emitCast(p, 'lmb', aimYaw));
        S.facing = aimYaw;
      }
    }
    intent.roll = false; intent.attack = false; intent.skill = null;

    // ---- MOVEMENT ----
    const rolling = S.rollT > 0;
    if (rolling) {
      // root-motion dodge: ease speed down across the roll
      S.rollT -= dt;
      const k = THREE.MathUtils.clamp(S.rollT / CFG.player.rollTime, 0, 1);
      const spd = CFG.player.rollSpeed * (0.35 + 0.65 * k);
      p.vel.set(_rollDir.x * spd, 0, _rollDir.z * spd);
      _delta.copy(p.vel).multiplyScalar(dt);
    } else {
      // hold-RMB (or last click) sets a persistent destination.
      //
      // `_holdT` suppresses this briefly after an external teleport. A held RMB (or a
      // synthetic mouse state left behind by automation) rewrites `_dest` to the
      // cursor's ground point EVERY frame, so clearing `_dest` inside teleportPlayer
      // is not enough on its own — the very next frame re-targets and the player walks
      // off again with `vel` still reading ~0 at sample time. Measured: 7 world units
      // of drift over a 9s settle at a station that held perfectly for the first 3.5s.
      if (Input.rmb && _holdT <= 0) _dest.copy(Input.ground);
      if (_holdT > 0) _holdT -= dt;

      // --- WASD, camera-relative -------------------------------------------------
      // In an isometric view the world axes are rotated by the camera yaw, so world-space
      // WASD would send you diagonally for no reason a player can see. Project the keys
      // onto screen axes instead: W is "up the screen" regardless of world orientation.
      //
      // The camera sits at offset (sin(yaw)cos(el)d, sin(el)d, cos(yaw)cos(el)d) and looks
      // back down that vector, so the horizontal into-screen direction is
      // -(sin yaw, 0, cos yaw) and screen-right is its perpendicular (cos yaw, 0, -sin yaw).
      const yaw = CFG.camera.yawDeg * Math.PI / 180;
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      let kx = 0, kz = 0;
      if (Input.down('w')) { kx -= sy; kz -= cy; }
      if (Input.down('s')) { kx += sy; kz += cy; }
      if (Input.down('d')) { kx += cy; kz -= sy; }
      if (Input.down('a')) { kx -= cy; kz += sy; }
      const kMag = Math.hypot(kx, kz);
      if (kMag > 1e-4 && _holdT <= 0) {
        // Keys OVERRIDE any click destination, and we clear `_dest` to the current position
        // so releasing them does not resume walking to a stale click target — the same
        // stale-`_dest` failure mode documented above for teleports.
        kx /= kMag; kz /= kMag;
        _dest.set(p.pos.x + kx * 2.5, p.pos.y, p.pos.z + kz * 2.5);
        _wasKeyMove = true;
      } else if (_wasKeyMove) {
        _dest.copy(p.pos);
        _wasKeyMove = false;
      }
      _to.set(_dest.x - p.pos.x, 0, _dest.z - p.pos.z);
      const dist = _to.length();
      const stopDist = p.radius * 0.4;
      const canMove = p.alive && !busy && dist > stopDist;
      if (canMove) { _moveDir.copy(_to).multiplyScalar(1 / dist); }
      else _moveDir.set(0, 0, 0);
      const tx = _moveDir.x * CFG.player.moveSpeed, tz = _moveDir.z * CFG.player.moveSpeed;
      const rate = (canMove ? CFG.player.accel : CFG.player.friction) * dt;
      const nvx = approach(p.vel.x, tx, rate), nvz = approach(p.vel.z, tz, rate);
      // acceleration magnitude for anim forward-lean
      S.accelMag = Math.hypot(nvx - p.vel.x, nvz - p.vel.z) / Math.max(dt, 1e-4) * (canMove ? 1 : -0.4);
      p.vel.set(nvx, 0, nvz);
      _delta.copy(p.vel).multiplyScalar(dt);
      if (dist <= stopDist && !canMove) { p.vel.x *= 0.5; p.vel.z *= 0.5; }
    }

    // slide-collide + terrain follow via physics (moveCapsule sets pos; groundY optional)
    if (Physics.moveCapsule) Physics.moveCapsule(p, _delta); else p.pos.add(_delta);
    const gy = (typeof p.groundY === 'number' && isFinite(p.groundY)) ? p.groundY
      : (World.level?.heightAt ? World.level.heightAt(p.pos.x, p.pos.z) : 0);
    p.pos.y = gy;

    S.speed = Math.hypot(p.vel.x, p.vel.z);

    // ---- FACING smooth-damp (never snap) + turn rate for lean ----
    let want = S.facing;
    if (busy) want = aimYaw;
    else if (S.speed > 0.2 && !rolling) want = Math.atan2(p.vel.x, p.vel.z);
    else if (rolling) want = Math.atan2(_rollDir.x, _rollDir.z);
    const diff = shortAngle(want - S.facing);
    const k = 1 - Math.exp(-(rolling ? 22 : 13) * dt);
    const step = diff * k;
    S.facing += step;
    S.turnRate = step / Math.max(dt, 1e-4);
    p.facing = S.facing;
    S.aimYaw = aimYaw;

    // ---- regen ----
    if (p.alive) {
      p.hp = Math.min(p.maxHp, p.hp + CFG.player.lifeRegen * dt);
      p.mana = Math.min(p.maxMana, p.mana + CFG.player.manaRegen * dt);
      if (p.stagger > 0) p.stagger = Math.max(0, p.stagger - dt);
    }
  },

  frame(dt, t) {
    const p = S.p; if (!p || !S.rig) return;

    // latch edge inputs here (frame always runs; edges cleared after all frames)
    const intent = this._intent || (this._intent = { roll: false, attack: false, skill: null });
    if (Input.pressed(' ')) intent.roll = true;
    if (Input.lmbEdge) intent.attack = true;
    for (const key of SKILL_KEYS) if (Input.pressed(key)) intent.skill = key;

    // sync group transform to the sim state (feet at pos)
    S.rig.group.position.copy(p.pos);
    S.rig.group.rotation.set(0, S.facing, 0);

    // if physics has ragdolled us, hand the skeleton over
    if (p.ragdolling) return;

    // animate
    S.anim.update({
      dt, speed: S.speed, aimYaw: S.aimYaw ?? S.facing, facing: S.facing,
      turnRate: S.turnRate, groundY: p.pos.y, accel: S.accelMag,
    });

    // rune ember pulse on the blade (subtle emissive life)
    if (S.rig.rune) S.rig.rune.material.emissiveIntensity = 1.3 + Math.sin(t * 3.1) * 0.5;

    // ---- cloth: cape + sash ----
    const pelvis = S.rig.bones[S.rig.boneOf('pelvis')];
    const neck = S.rig.bones[S.rig.boneOf('neck')];
    pelvis.getWorldPosition(_capA);
    neck.getWorldPosition(_capB);
    clothCtx.ground = p.pos.y;
    clothCtx.wind = 0.35 + Math.sin(t * 0.7) * 0.18 + S.speed * 0.03;
    clothCtx.t = t;
    if (S.cape) S.cape.update(dt, clothCtx);
    if (S.sash) S.sash.update(dt, clothCtx);
  },
};

// ---- helpers ----
function emitCast(p, skill, aimYaw) {
  // origin = chest muzzle (up + slightly forward along facing); dir = horizontal aim
  const fy = p.facing;
  _castDir.set(Math.sin(aimYaw), 0, Math.cos(aimYaw));
  if (_castDir.lengthSq() < 1e-6) _castDir.set(Math.sin(fy), 0, Math.cos(fy));
  _castDir.normalize();
  _origin.set(p.pos.x + _castDir.x * 0.32, p.pos.y + 1.3, p.pos.z + _castDir.z * 0.32);
  bus.emit(EV.PLAYER_CAST, { skill, origin: _origin.clone(), dir: _castDir.clone() });
}

function hurt(amount, opts) {
  const p = S.p; if (!p || !p.alive) return 0;
  if (World.time < p._iframesUntil) return 0;   // dodged (i-frames)
  const dmg = Math.max(0, amount || 0);
  p.hp -= dmg;
  p.stagger = Math.min(0.5, (p.stagger || 0) + 0.18);
  if (S.cape && opts && opts.dir) S.cape.addImpulse(_imp.set(opts.dir.x || 0, 0, opts.dir.z || 0).multiplyScalar(5));
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false;
    S.anim.play('death');
    // THE LOSS CONDITION, emitted HERE and not in combat's killEntity. This function sets
    // `alive = false` itself, so by the time applyDamage() tests
    // `if (target.hp <= 0 && target.alive)` the flag is already false and killEntity is
    // never reached for the player. An emit placed there was unreachable dead code: the
    // player died, the death animation played, and the run simply continued around the
    // corpse. Verified by dying on purpose and watching GAME_LOST never fire.
    const s = World.stats || {};
    bus.emit(EV.GAME_LOST, {
      kills: s.kills ?? 0, level: s.level ?? 1, xp: s.xp ?? 0,
      seconds: World.time ?? 0,
      // combat.js passes `{ type, crit, source }` — `source` is the attacker ENTITY, so the
      // display name comes off its brain's behaviour (the same field the boss toast uses)
      // or its archetype. My first version read opts.sourceName/attackerName, which do not
      // exist anywhere, so every death reported the "the dark" fallback.
      killer: (opts?.source?._brain?.beh?.name)
           || (opts?.source?.archetype)
           || (opts?.dot ? 'lingering venom' : 'the dark'),
    });
  } else if (!S.anim.busy) {
    S.anim.play('hit');
  }
  return dmg;
}

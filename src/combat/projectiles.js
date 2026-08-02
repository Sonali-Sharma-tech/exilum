// EXILIUM — projectile system (owner: CombatSkills)
// Pooled, fixed-step integrated, zero allocation after warm-up. Behaviours:
// pierce, chain, fork, homing, detonate-on-impact, max lifetime. Collision via
// raycastWorld() (walls) + World.hash (entities). Combat injects the hit resolver.
//
// World.projectiles is kept as a COMPACT array of *live* projectiles (swap-remove),
// so VFXParticles' ribbon auto-attach only ever sees active ones. The visible core
// is an unlit additive mesh (no CSM needed); embers/ribbon are VFX's job.
//
// Each projectile carries an opaque `feel` payload (weights/ailments/knockback/
// vfxHit/sfxHit) supplied by combat, so the hit callback resolves with the owning
// skill's game feel without projectiles.js knowing anything about skills.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { raycastWorld } from '../core/physics.js';

const POOL = 256;                 // hard pool ceiling; recycles oldest if exhausted
const SUBSTEP = 1 / 120;          // integrate finer than the sim tick for fast shots
const CORE_SEG = 8;
const PROJ_LIGHTS = 4;            // pooled lights that ride the brightest hero orbs
const UP = new THREE.Vector3(0, 1, 0);

// Module-scope temporaries — hoisted so the hot loop never allocates.
const _step = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _to = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _q = [];                    // reused spatial-hash query buffer

// Reused VFX payload ring — trail bursts mutate these, VFX copies synchronously.
const RING = 32;
const _payloads = [];
const _pv = [];
let _ringi = 0;
for (let i = 0; i < RING; i++) {
  _pv.push(new THREE.Vector3());
  _payloads.push({ kind: '', pos: _pv[i], dir: null, scale: 1, color: 0xffffff });
}
function trail(kind, x, y, z, color, scale) {
  const i = _ringi = (_ringi + 1) % RING;
  const p = _payloads[i];
  p.kind = kind; p.pos.set(x, y, z); p.color = color; p.scale = scale; p.dir = null;
  bus.emit(EV.VFX_SPAWN, p);
}

class Projectile {
  constructor(scene) {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, 1);
    this.color = 0xffffff;
    this.type = 'physical';
    this.radius = 0.4;
    this.alive = false;
    this.spec = null;             // damage packet (from skill)
    this.feel = null;             // opaque game-feel payload (from combat)
    this.source = null;           // caster entity
    this.faction = 'player';
    this.pierce = 0; this.chain = 0; this.chainRange = 6; this.chainVfx = null;
    this.fork = 0; this.forkAngle = 0.4;
    this.homing = 0; this.homingRange = 12;
    this.detonate = null;
    this.life = 0; this.maxLife = 2;
    this.gravity = 0;
    this.trailKind = null; this.trailColor = 0xffffff; this.trailRate = 0.03; this._trailAcc = 0;
    this.hitSet = new Set();      // entities already hit (pierce/chain de-dup)
    this._age = 0;

    const g = new THREE.SphereGeometry(1, CORE_SEG, CORE_SEG);
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }
  reset() {
    this.alive = false; this.mesh.visible = false;
    this.hitSet.clear(); this.spec = null; this.source = null; this.feel = null;
    this.life = 0; this._trailAcc = 0;
  }
}

export class Projectiles {
  constructor(scene, onHit) {
    this.scene = scene;
    this.onHit = onHit;           // (target, spec, srcPos, projectile, scale) => void, from combat
    this.pool = [];
    this.live = World.projectiles; // share the array VFX watches
    this.live.length = 0;
    for (let i = 0; i < POOL; i++) this.pool.push(new Projectile(scene));
    // A few pooled PointLights follow the brightest hero orbs so a fireball/seeker
    // genuinely lights the floor while flying (rubric §7). SkyAtmos-approved.
    this.projLights = [];
    for (let i = 0; i < PROJ_LIGHTS; i++) {
      const L = new THREE.PointLight(0xffffff, 0, 10, 2);
      L.castShadow = false; L.visible = false;
      scene.add(L);
      this.projLights.push(L);
    }
  }

  _acquire() {
    for (let i = 0; i < POOL; i++) if (!this.pool[i].alive) return this.pool[i];
    let oldest = this.live[0];    // exhausted — recycle the oldest live one
    for (const p of this.live) if (p._age > oldest._age) oldest = p;
    this._retire(oldest);
    return oldest;
  }

  _applyMesh(p) {
    const m = p.mesh;
    m.visible = true;
    m.material.color.setHex(p.color);
    m.scale.setScalar(p.radius * 1.6);
    m.position.copy(p.pos);
  }

  /**
   * Spawn from a skill's projectile spec.
   * @param spec    damage packet
   * @param projDef delivery def (speed/radius/lifetime/pierce/chain/fork/homing/detonate/trail)
   * @param source  caster entity
   * @param origin  Vector3 (caller owns; we copy)
   * @param dir     Vector3 (caller owns; we copy)
   * @param feel    opaque game-feel payload passed straight to the hit callback
   */
  spawn(spec, projDef, source, origin, dir, feel) {
    const p = this._acquire();
    p.alive = true; p._age = 0;
    p.pos.copy(origin);
    p.dir.copy(dir).setY(0).normalize();
    p.vel.copy(p.dir).multiplyScalar(projDef.speed);
    p.gravity = projDef.gravity || 0;
    p.radius = projDef.radius || 0.4;
    p.maxLife = projDef.lifetime || 2;
    p.life = 0;
    p.spec = spec; p.source = source; p.feel = feel || null;
    p.faction = (source && source.faction) || 'player';
    p.type = spec.type || 'physical';
    p.pierce = projDef.pierce || 0;
    p.chain = projDef.chain || 0;
    p.chainRange = projDef.chainRange || 6;
    p.chainVfx = projDef.chainVfx || null;
    p.fork = projDef.fork || 0;
    p.forkAngle = projDef.forkAngle || 0.4;
    p.homing = projDef.homing || 0;
    p.homingRange = projDef.homingRange || 12;
    p.detonate = projDef.detonate || null;
    p.color = (projDef.trail && projDef.trail.color) || 0xffffff;
    p.trailKind = projDef.trail ? projDef.trail.kind : null;
    p.trailColor = projDef.trail ? projDef.trail.color : 0xffffff;
    p.trailRate = projDef.trail ? (projDef.trail.rate || 0.03) : 0.03;
    p._trailAcc = 0;
    p.hitSet.clear();
    this._applyMesh(p);
    this.live.push(p);
    return p;
  }

  // Spawn a fork child by configuring a pooled projectile in place (no allocation).
  // Children are terminal: they fly straight and hit once (no re-fork/chain/pierce).
  _spawnChild(parent, dir) {
    const p = this._acquire();
    p.alive = true; p._age = 0;
    p.pos.copy(parent.pos);
    p.dir.copy(dir).setY(0).normalize();
    p.vel.copy(p.dir).multiplyScalar(parent.vel.length());
    p.gravity = parent.gravity;
    p.radius = parent.radius;
    p.maxLife = parent.maxLife * 0.7;
    p.life = 0;
    p.spec = parent.spec; p.source = parent.source; p.feel = parent.feel;
    p.faction = parent.faction;
    p.type = parent.type;
    p.pierce = 0; p.chain = 0; p.chainRange = parent.chainRange; p.chainVfx = null;
    p.fork = 0; p.forkAngle = parent.forkAngle;
    p.homing = 0; p.homingRange = parent.homingRange;
    p.detonate = null;
    p.color = parent.color;
    p.trailKind = parent.trailKind; p.trailColor = parent.trailColor; p.trailRate = parent.trailRate;
    p._trailAcc = 0;
    p.hitSet.clear();
    this._applyMesh(p);
    this.live.push(p);
    return p;
  }

  _retire(p) {
    const i = this.live.indexOf(p);
    if (i >= 0) { this.live[i] = this.live[this.live.length - 1]; this.live.pop(); }
    p.reset();
  }

  // Nearest hostile within range not already excluded — for chain/homing.
  _nearestFoe(p, x, z, range, excludeSet) {
    World.hash.query(x, z, range, _q);
    let best = null, bestD = range * range;
    for (let i = 0; i < _q.length; i++) {
      const e = _q[i];
      if (!e.alive || e === p.source) continue;
      if (e.faction === p.faction) continue;
      if (e.kind === 'prop') continue;
      if (excludeSet && excludeSet.has(e)) continue;
      const dx = e.pos.x - x, dz = e.pos.z - z, d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _canHitEntity(p, e) {
    if (!e.alive || e === p.source) return false;
    if (p.hitSet.has(e)) return false;
    if (e.kind === 'prop') return p.faction === 'player';   // player breaks props
    return e.faction !== p.faction;                          // never friendly-fire
  }

  // Splash at (x,z). Fresh targets only (respects faction/prop rules). Falloff to rim.
  _detonate(p, x, z) {
    const det = p.detonate; if (!det) return;
    trail('impact', x, p.pos.y, z, p.color, det.radius * 0.6);
    World.hash.query(x, z, det.radius, _q);
    for (let i = 0; i < _q.length; i++) {
      const e = _q[i];
      if (!e.alive || e === p.source || e.faction === p.faction) continue;
      if (e.kind === 'prop' && p.faction !== 'player') continue;
      const dx = e.pos.x - x, dz = e.pos.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > det.radius) continue;
      const f = 1 - (det.falloff || 0.3) * (d / det.radius);
      this.onHit(e, p.spec, p.pos, p, Math.max(0.25, f));
    }
  }

  _onEntityHit(p, e) {
    p.hitSet.add(e);
    this.onHit(e, p.spec, p.pos, p, 1);

    if (p.detonate) { this._detonate(p, e.pos.x, e.pos.z); this._retire(p); return; }

    if (p.fork > 0) {                                 // split into off-axis children
      const n = p.fork;
      for (let k = 0; k < n; k++) {
        const a = (k - (n - 1) / 2) * p.forkAngle;
        _steer.copy(p.dir).applyAxisAngle(UP, a);
        this._spawnChild(p, _steer);
      }
      this._retire(p);
      return;
    }

    if (p.chain > 0) {                                // redirect to a new foe
      const foe = this._nearestFoe(p, e.pos.x, e.pos.z, p.chainRange, p.hitSet);
      if (foe) {
        p.chain--;
        _to.set(foe.pos.x - e.pos.x, 0, foe.pos.z - e.pos.z).normalize();
        p.dir.copy(_to); p.vel.copy(_to).multiplyScalar(p.vel.length());
        p.pos.set(e.pos.x, p.pos.y, e.pos.z);
        if (p.chainVfx) trail(p.chainVfx, e.pos.x, p.pos.y, e.pos.z, p.color, 1);
        return;
      }
      this._retire(p);
      return;
    }

    if (p.pierce > 0) { p.pierce--; return; }         // pass through until spent
    this._retire(p);
  }

  // Fixed-step integration. Called once per sim tick with dt (1/60). Zero allocation.
  fixed(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p.alive) continue;
      p.life += dt; p._age += dt;
      if (p.life >= p.maxLife) {
        if (p.detonate) this._detonate(p, p.pos.x, p.pos.z);
        this._retire(p);
        continue;
      }

      if (p.homing > 0) {                             // bounded-rate steer toward nearest foe
        const foe = this._nearestFoe(p, p.pos.x, p.pos.z, p.homingRange, null);
        if (foe) {
          _to.set(foe.pos.x - p.pos.x, 0, foe.pos.z - p.pos.z);
          const len = _to.length();
          if (len > 1e-3) {
            _to.multiplyScalar(1 / len);
            const speed = p.vel.length();
            _steer.copy(_to).sub(p.dir).multiplyScalar(Math.min(1, p.homing * dt));
            p.dir.add(_steer).setY(0).normalize();
            p.vel.copy(p.dir).multiplyScalar(speed);
          }
        }
      }

      if (p.gravity) p.vel.y -= p.gravity * dt;

      // sub-stepped sweep so fast shots don't tunnel through thin targets/walls
      let remaining = dt, retired = false;
      while (remaining > 1e-5 && p.alive) {
        const s = Math.min(SUBSTEP, remaining); remaining -= s;
        _prev.copy(p.pos);
        _step.copy(p.vel).multiplyScalar(s);
        p.pos.add(_step);

        const dist = _step.length();
        if (dist > 1e-4) {                            // wall collision (raycastWorld may stub to null)
          const hit = raycastWorld(_prev, p.dir, dist + p.radius);
          if (hit && hit.dist <= dist + p.radius) {
            _hitPos.copy(hit.point || p.pos);
            p.pos.copy(_hitPos);
            if (p.detonate) this._detonate(p, p.pos.x, p.pos.z);
            trail(p.trailKind || 'impact', p.pos.x, p.pos.y, p.pos.z, p.color, 1);
            this._retire(p); retired = true; break;
          }
        }

        World.hash.query(p.pos.x, p.pos.z, p.radius + 1.2, _q);
        for (let j = 0; j < _q.length; j++) {
          const e = _q[j];
          if (!this._canHitEntity(p, e)) continue;
          const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
          const rr = p.radius + (e.radius || 0.4);
          if (dx * dx + dz * dz <= rr * rr) {
            this._onEntityHit(p, e);
            if (!p.alive) retired = true;
            break;
          }
        }
        if (retired) break;
      }
      if (retired || !p.alive) continue;

      if (p.trailKind) {                              // embers on top of VFX's ribbon
        p._trailAcc += dt;
        if (p._trailAcc >= p.trailRate) {
          p._trailAcc = 0;
          trail(p.trailKind, p.pos.x, p.pos.y, p.pos.z, p.trailColor, 1);
        }
      }
      p.mesh.position.copy(p.pos);
    }
  }

  // Smooth render pulse of the visible core + move the pooled lights onto the
  // brightest hero orbs (those that detonate) so they light the floor while flying.
  frame() {
    const t = World.time;
    let li = 0;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      p.mesh.scale.setScalar(p.radius * 1.6 * (1 + Math.sin(t * 30 + i) * 0.12));
      if (li < PROJ_LIGHTS && p.detonate) {           // heavy orbs carry a travelling light
        const L = this.projLights[li++];
        L.visible = true;
        L.color.setHex(p.color);
        L.position.set(p.pos.x, p.pos.y + 0.4, p.pos.z);
        L.intensity = 4.5 + Math.sin(t * 24 + i) * 0.6;
        L.distance = 9;
      }
    }
    for (; li < PROJ_LIGHTS; li++) this.projLights[li].visible = false;   // park unused
  }

  clear() { for (let i = this.live.length - 1; i >= 0; i--) this._retire(this.live[i]); }
}

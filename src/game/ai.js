// ai.js — EnemyAI system. Owns: coarse nav grid + flow-field pathing (shared as
// World.nav), the encounter Director, LOD animation, and XP-on-death. Enemies steer
// with separation via World.hash and move through moveCapsule; attacks route through
// CombatSkills (bus 'combat:enemyAttack'). Owner: EnemyAI.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { spawnRagdoll } from '../core/physics.js';
import { prewarm, ARCHETYPE_KEYS } from '../gen/enemygen.js';
import { TelegraphPool } from './enemies.js';
import { Director } from './director.js';

// ── binary min-heap for Dijkstra integration field ───────────────────────────
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(idx, cost) { const a = this.a; a.push({ idx, cost }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].cost <= a[i].cost) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; const n = a.length;
      for (;;) { let l = i * 2 + 1, r = l + 1, s = i;
        if (l < n && a[l].cost < a[s].cost) s = l; if (r < n && a[r].cost < a[s].cost) s = r;
        if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } }
    return top; }
}

// ── coarse nav grid + flow field toward the player (wall-aware) ───────────────
// One shared Dijkstra integration field feeds all enemies; recomputed a few times
// per second only when the player changes cell. Enemies read the gradient.
class Nav {
  constructor(level) {
    this.ready = false;
    this.level = level;
    const b = level?.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    this.cell = 1.7;
    this.pad = 2;
    this.minX = b.minX - this.pad; this.minZ = b.minZ - this.pad;
    this.cols = Math.max(4, Math.min(300, Math.ceil((b.maxX - b.minX + this.pad * 2) / this.cell)));
    this.rows = Math.max(4, Math.min(300, Math.ceil((b.maxZ - b.minZ + this.pad * 2) / this.cell)));
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.cost = new Float32Array(n);       // integration field (distance-to-player)
    this.cost.fill(Infinity);
    this.done = new Uint8Array(n);         // settled-set: each cell finalized once (O(cells), float-drift immune)
    // sample walkability at each cell centre
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const x = this.minX + (c + 0.5) * this.cell, z = this.minZ + (r + 0.5) * this.cell;
      const walk = level?.walkable ? level.walkable(x, z) : true;
      this.blocked[r * this.cols + c] = walk ? 0 : 1;
    }
    this.heap = new MinHeap();
    this.lastGoal = -1;
    this.recomputeT = 0;
    this.ready = true;
  }

  _ci(x, z) {
    const c = ((x - this.minX) / this.cell) | 0, r = ((z - this.minZ) / this.cell) | 0;
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  walkableAt(x, z) { const i = this._ci(x, z); return i < 0 ? true : this.blocked[i] === 0; }

  // Dijkstra from the goal cell across walkable cells (8-connected, diagonal cost √2)
  _integrate(goalIdx) {
    const cost = this.cost; cost.fill(Infinity);
    const done = this.done; done.fill(0);
    const heap = this.heap; heap.a.length = 0;
    if (goalIdx < 0 || this.blocked[goalIdx]) {
      // snap goal to nearest walkable cell if it landed in a wall
      goalIdx = this._nearestWalkable(goalIdx);
      if (goalIdx < 0) return;
    }
    cost[goalIdx] = 0; heap.push(goalIdx, 0);
    const cols = this.cols, rows = this.rows;
    while (heap.size) {
      const { idx } = heap.pop();
      if (done[idx]) continue;          // finalize each cell exactly once
      done[idx] = 1;
      const cc = cost[idx];
      const c = idx % cols, r = (idx / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nc = c + dc, nr = r + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc; if (this.blocked[ni] || done[ni]) continue;
        if (dr && dc) { // no corner-cutting through wall diagonals
          if (this.blocked[r * cols + nc] || this.blocked[nr * cols + c]) continue;
        }
        const step = (dr && dc) ? 1.41421356 : 1;
        const ncost = cc + step;
        if (ncost < cost[ni]) { cost[ni] = ncost; heap.push(ni, ncost); }
      }
    }
  }

  _nearestWalkable(idx) {
    if (idx < 0) return -1;
    const cols = this.cols, rows = this.rows;
    const c0 = idx % cols, r0 = (idx / cols) | 0;
    for (let rad = 1; rad < 8; rad++) {
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
        const nc = c0 + dc, nr = r0 + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc; if (!this.blocked[ni]) return ni;
      }
    }
    return -1;
  }

  update(dt, goalPos) {
    if (!goalPos) return;
    this.recomputeT -= dt;
    const gi = this._ci(goalPos.x, goalPos.z);
    // recompute when player changes cell, throttled to a few Hz
    if ((gi !== this.lastGoal && this.recomputeT <= 0) || this.lastGoal < 0) {
      this.lastGoal = gi; this.recomputeT = 0.28;   // ~3.5 Hz max
      this._integrate(gi);
    }
  }

  // steepest descent: point toward the lowest-cost 8-neighbour (wall-robust; a
  // central-difference gradient mis-fires across the cost discontinuity at walls).
  sampleFlow(x, z, out) {
    const cols = this.cols, rows = this.rows, cost = this.cost, blocked = this.blocked;
    const c = ((x - this.minX) / this.cell) | 0, r = ((z - this.minZ) / this.cell) | 0;
    if (c < 0 || r < 0 || c >= cols || r >= rows) { out.set(0, 0); return out; }
    const here = cost[r * cols + c];
    let bx = 0, bz = 0, best = isFinite(here) ? here : Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nc = c + dc, nr = r + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc; if (blocked[ni]) continue;
      if (dr && dc && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue; // no corner-cut
      const v = cost[ni];
      if (v < best) { best = v; bx = dc; bz = dr; }
    }
    if (bx === 0 && bz === 0) { out.set(0, 0); return out; }
    const len = Math.hypot(bx, bz);
    out.set(bx / len, bz / len); return out;
  }
}

// ── LOD helpers ───────────────────────────────────────────────────────────────
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();

export default {
  name: 'ai',

  init({ scene, camera }) {
    this.scene = scene; this.camera = camera;
    this.enabled = false;
    this._tick = 0; this._fno = 0;
    // build & cache all archetype models/skeletons/clips up front (init-time cost)
    prewarm(ARCHETYPE_KEYS);
    this.telegraph = new TelegraphPool(scene, 56);
    this.env = { scene, telegraph: this.telegraph };
    this.director = new Director(this.env);

    // once the level exists, build the nav grid and arm the director
    const arm = (level) => {
      World.nav = new Nav(level);
      this.director.setup(level);
      this.enabled = true;
    };
    if (World.level) arm(World.level);
    else bus.on(EV.LEVEL_READY, ({ level }) => arm(level || World.level));

    // XP on death (loot rolls its own drop; we award XP once — guarded by _xpAwarded)
    bus.on(EV.ENTITY_DIED, ({ entity }) => {
      if (!entity || entity.faction !== 'monster' || entity._xpAwarded) return;
      entity._xpAwarded = true;
      const base = entity.isBoss ? 4200 : Math.round(entity.maxHp * 0.6);
      const rmul = entity.rarity === 'rare' ? 2.5 : entity.rarity === 'magic' ? 1.6 : 1;
      const amount = Math.round(base * rmul);
      bus.emit(EV.XP_GAIN, { amount });
      if (World.stats) {
        World.stats.kills = (World.stats.kills || 0) + 1;
        // ACTUALLY BANK THE XP. EV.XP_GAIN was emitted with an amount, and both the
        // XP bar and the audio system listened for it — but only to trigger a
        // shimmer and a sound. Nothing anywhere in the codebase ever wrote to
        // World.stats.xp, so 16 kills still read xp:0 and the player could never
        // level. Six visual critics would never catch this; only playing it does.
        World.stats.xp = (World.stats.xp || 0) + amount;
        // Level up, carrying the remainder so nothing is lost, and looping in case a
        // boss award spans several levels at once.
        let guard = 0;
        while (World.stats.xp >= World.stats.xpNext && guard++ < 20) {
          World.stats.xp -= World.stats.xpNext;
          World.stats.level = (World.stats.level || 1) + 1;
          // PoE-ish curve: each level costs ~28% more than the last.
          World.stats.xpNext = Math.round(World.stats.xpNext * 1.28);
          bus.emit(EV.UI_TOAST, { text: `Level ${World.stats.level}`, tier: 'levelup' });
          bus.emit(EV.VFX_SPAWN, { kind: 'levelup', pos: World.player?.pos?.clone?.() });
          bus.emit(EV.SFX_PLAY, { id: 'level_up' });
        }
      }
      // ragdoll from skeleton (guard: physics may be a stub returning null)
      try { spawnRagdollSafe(entity); } catch (_) { /* stub */ }
    });
  },

  // fixed 1/60: nav refresh, AI decisions (staggered), steering + movement
  fixed(dt) {
    if (!this.enabled) return;
    this._tick++;
    const p = World.player;
    if (World.nav) World.nav.update(dt, p?.pos);

    const list = this.director.enemies;
    for (let i = 0; i < list.length; i++) {
      const en = list[i];
      en.think(dt);   // internally throttled + staggered by decideEvery
      en.move(dt);    // steering + separation + moveCapsule, every step for smoothness
    }
    this.director.fixed(dt);
  },

  // variable frame: telegraph decals + LOD animation (skip off-screen, rate by dist)
  frame(dt) {
    if (!this.enabled) return;
    this._fno = (this._fno + 1) | 0;
    this.telegraph.update(dt);
    const cam = this.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const p = World.player?.pos;
    const list = this.director.enemies;
    for (let i = 0; i < list.length; i++) {
      const en = list[i]; const m = en.model; if (!m) continue;
      en.syncTransform();                        // cheap, every frame — no positional stutter
      // frustum cull: skip mixer entirely when off-screen (still accumulate time)
      _sphere.center.set(en.e.pos.x, en.e.pos.y + en.e.height * 0.5, en.e.pos.z);
      _sphere.radius = en.e.height;
      const visible = _frustum.intersectsSphere(_sphere);
      // Clamp the carried accumulator. An enemy off-screen for 30s should enter
      // frame at a plausible pose, not "catch up" half a minute of animation.
      en._animAccum = Math.min((en._animAccum || 0) + dt, 0.5);
      if (!visible) { continue; }                // off-screen: no animation work at all
      // distance LOD: near=every frame, mid=every ~3 frames, far=every ~6 frames
      const d = p ? en.e.pos.distanceToSquared(p) : 0;
      const stride = en.isBoss ? 1 : d > 900 ? 6 : d > 289 ? 3 : 1;
      // First visible frame MUST pose the skeleton regardless of stride: an enemy
      // that has never been animated is still at bind pose, and the stride gate
      // could hold it there for up to 6 frames (~100ms) in full view — reading as
      // a T-pose pop as it enters frame.
      if (!en._posedOnce) { en._posedOnce = true; }
      else if ((this._fno + (en.e.id | 0)) % stride !== 0) continue;
      en.animate(en._animAccum);
      en._animAccum = 0;
    }
  },
};

// ragdoll helper isolated so a stub physics module (spawnRagdoll -> null) can't crash death handling
function spawnRagdollSafe(entity) {
  spawnRagdoll?.(entity);
}

// objective.js — a compass arrow pointing at the run's goal, with distance.
//
// Why: the level is fully traversable — a radius-aware flood fill from spawn reaches
// 15063 of 15063 clear cells, 100% — but the minimap carries fog-of-war with a 17-unit
// reveal radius, so a player has no way to know which of seven rooms holds the boss. You
// slide off a wall, take the wrong corridor, and the map *feels* impassable when it is
// actually just unmarked. This is a wayfinding fix, not a geometry one.
//
// The arrow lives at the bottom-centre of the screen and rotates in SCREEN space, which is
// the only frame the player can act on: at yaw 42 the world axes are rotated, so a
// world-space arrow would point somewhere the WASD keys do not go.
//
// It hides itself once you are inside the arena (the goal is then on screen) and once the
// run is over.
import { bus, EV } from '../core/events.js';
import { World } from '../core/world.js';
import { CFG } from '../core/config.js';
import { el, svg } from './theme.js';

const HIDE_WITHIN = 26;        // world units — inside the arena the boss is visible

export class Objective {
  constructor(root) {
    this.node = el('div', null, root);
    this.node.id = 'objective';

    const g = svg('svg', { viewBox: '0 0 40 40' }, this.node);
    this.dial = svg('g', { transform: 'rotate(0 20 20)' }, g);
    // a slim gothic chevron, gold with a dark outline so it reads on any floor
    svg('path', { d: 'M20 4 L30 26 L20 21 L10 26 Z',
      fill: '#c9a227', stroke: '#050505', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, this.dial);
    svg('path', { d: 'M20 4 L20 21', fill: 'none', stroke: '#f0d97a',
      'stroke-width': 1, opacity: .75 }, this.dial);

    this.label = el('div', 'ob-label', this.node);
    this.dist = el('div', 'ob-dist', this.node);
    this.label.textContent = 'THE SUNDER';

    this.over = false;
    this._offWon = bus.on(EV.GAME_WON, () => { this.over = true; this.node.style.display = 'none'; });
    this._offLost = bus.on(EV.GAME_LOST, () => { this.over = true; this.node.style.display = 'none'; });
    this._shownDist = -1;
    this._goal = null;
  }

  _findGoal() {
    // The arena room is the goal; `boss: true` marks it in the level contract.
    const rooms = World.level?.rooms;
    if (!rooms) return null;
    const a = rooms.find((r) => r && (r.boss === true || r.kind === 'arena'));
    return a?.center ?? null;
  }
  // ── goal flow field ────────────────────────────────────────────────────────
  // Built ONCE, because the level is static (seed 1337). A BFS out from the arena over the
  // radius-aware clearance grid gives every cell its distance-to-goal; the arrow then points
  // downhill, i.e. along a route the player can actually walk.
  //
  // Why this is necessary rather than pointing straight at the arena: measured from the spot
  // a greedy walker stalls at (56.8, 4.8), the true path is 48 units against a 42.3 straight
  // line — a detour ratio of only 1.14 — but it runs down a corridor at z≈1. Standing at
  // z=4.8 you must move −z about 4 units BEFORE going +x. An arrow aimed at the goal points
  // +x into a wall there, which is exactly the "cannot traverse the map" report: the path
  // exists (a radius-aware flood fill reaches 15063/15063 clear cells) and the guidance was
  // pointing into geometry.
  _buildField() {
    const W = World.level;
    if (!W?.walkable || !this._goal) return false;
    const R = (World.player?.radius) || 0.42;
    const clear = (x, z) => {
      if (!W.walkable(x, z)) return false;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        if (!W.walkable(x + Math.cos(a) * R, z + Math.sin(a) * R)) return false;
      }
      return true;
    };
    const STEP = 1.0;                        // 1u cells: ~24k cells, built once, ~30ms
    const minX = -40, minZ = -80, spanX = 200, spanZ = 170;
    const cols = Math.ceil(spanX / STEP), rows = Math.ceil(spanZ / STEP);
    const open = new Uint8Array(cols * rows);
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        open[cz * cols + cx] = clear(minX + cx * STEP, minZ + cz * STEP) ? 1 : 0;
      }
    }
    const dist = new Int32Array(cols * rows).fill(-1);
    const gx = Math.round((this._goal.x - minX) / STEP);
    const gz = Math.round((this._goal.z - minZ) / STEP);
    const start = gz * cols + gx;
    if (!open[start]) return false;
    // BFS outward from the goal — head is an index, so this is O(n) with no shift()
    const q = new Int32Array(cols * rows);
    let head = 0, tail = 0;
    q[tail++] = start; dist[start] = 0;
    while (head < tail) {
      const c = q[head++];
      const cx = c % cols, cz = (c - cx) / cols;
      const d = dist[c] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nz = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const n = nz * cols + nx;
        if (dist[n] !== -1 || !open[n]) continue;
        dist[n] = d; q[tail++] = n;
      }
    }
    this._field = { dist, cols, rows, minX, minZ, STEP };
    return true;
  }

  /** Downhill direction on the field at a world point, or null if off-grid. */
  _flowDir(x, z) {
    const f = this._field;
    if (!f) return null;
    const cx = Math.round((x - f.minX) / f.STEP), cz = Math.round((z - f.minZ) / f.STEP);
    if (cx < 1 || cz < 1 || cx >= f.cols - 1 || cz >= f.rows - 1) return null;
    let bestD = Infinity, bx = 0, bz = 0;
    // 8-neighbour so the arrow can indicate diagonals, which WASD can express
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const d = f.dist[(cz + dz) * f.cols + (cx + dx)];
        if (d < 0) continue;
        if (d < bestD) { bestD = d; bx = dx; bz = dz; }
      }
    }
    if (bestD === Infinity) return null;
    return { x: bx, z: bz, dist: bestD * f.STEP };
  }

  frame() {
    if (this.over) return;
    const p = World.player;
    if (!p) return;
    if (!this._goal) this._goal = this._findGoal();
    const g = this._goal;
    if (!g) { this.node.style.display = 'none'; return; }
    if (!this._field && !this._fieldFailed) {
      if (!this._buildField()) this._fieldFailed = true;
    }

    const dx = g.x - p.pos.x, dz = g.z - p.pos.z;
    const d = Math.hypot(dx, dz);

    // Once the boss is engaged, the arrow has done its job.
    if (d < HIDE_WITHIN || World.boss) {
      if (this.node.style.display !== 'none') this.node.style.display = 'none';
      return;
    }
    if (this.node.style.display === 'none') this.node.style.display = 'flex';

    // World -> screen. The camera looks along -(sin yaw, cos yaw) horizontally, so screen-up
    // is that vector and screen-right its perpendicular — the same basis the WASD keys use in
    // player.js, so the arrow and the controls always agree.
    //
    // The direction is the FLOW FIELD's downhill step when available, falling back to the
    // straight bearing only if the field failed to build. That difference is the whole point:
    // at (56.8, 4.8) the straight bearing is +x into a wall, while the flow step is −z into
    // the corridor mouth that actually leads to the arena.
    const flow = this._flowDir(p.pos.x, p.pos.z);
    const fx = flow ? flow.x : dx;
    const fz = flow ? flow.z : dz;

    const yaw = CFG.camera.yawDeg * Math.PI / 180;
    const up = -(fx * Math.sin(yaw) + fz * Math.cos(yaw));   // +ve => screen top (W)
    const right = (fx * Math.cos(yaw) - fz * Math.sin(yaw)); // +ve => screen right (D)
    const deg = Math.atan2(right, up) * 180 / Math.PI;       // 0 = up, clockwise positive
    this.dial.setAttribute('transform', `rotate(${deg.toFixed(1)} 20 20)`);

    // Distance ALONG THE PATH when we have a field — a straight-line number reads as "close"
    // while you are the wrong side of a wall, which is misleading in exactly the place the
    // player is most likely to be lost.
    const dR = Math.round(flow ? flow.dist : d);
    if (dR !== this._shownDist) { this._shownDist = dR; this.dist.textContent = `${dR}m`; }
  }

  dispose() { this._offWon?.(); this._offLost?.(); }
}

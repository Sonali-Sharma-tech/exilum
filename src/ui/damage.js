// Floating damage numbers. On EV.DAMAGE_DEALT: spawn a world-to-screen projected
// number that arcs up on an ease curve and fades. Crits are bigger/brighter with
// a distinct treatment. Coloured by damage type. Capped, with rapid same-target
// hits merged so numbers never steal focus (rubric §7).
import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { el, dmgColor, fmt } from './theme.js';

const MAX = 26;            // hard cap on simultaneous numbers
const MERGE_MS = 130;      // same-target hits within this window accumulate
const _v = new THREE.Vector3();

export class DamageNumbers {
  constructor(root) {
    this.layer = el('div', null, root); this.layer.id = 'dmg-layer';
    this.pool = [];
    this.live = [];
    this.recent = new Map();   // targetId -> active number (for merging)
    for (let i = 0; i < MAX; i++) {
      const n = el('div', 'dmg', this.layer);
      n.style.display = 'none';
      this.pool.push({ node: n, active: false });
    }
    this._off = bus.on(EV.DAMAGE_DEALT, (d) => this.spawn(d));
  }

  spawn(d) {
    if (!d || !d.pos) return;
    const now = performance.now();
    const amount = Math.max(0, d.amount || 0);
    const tid = d.target && d.target.id;

    // merge rapid hits on the same target
    if (tid != null) {
      const r = this.recent.get(tid);
      if (r && r.active && now - r.born < MERGE_MS && r.crit === !!d.crit && r.type === d.type) {
        r.total += amount;
        r.born = now;                     // extend merge window
        r.age = Math.min(r.age, 0.12);    // re-pop
        r.pos.copy(d.pos);
        r._punch = 1;
        return;
      }
    }

    const slot = this._acquire();
    if (!slot) return;
    slot.active = true;
    slot.total = amount;
    slot.crit = !!d.crit;
    slot.type = d.type || 'physical';
    slot.born = now;
    slot.age = 0;
    slot.life = slot.crit ? 1.15 : 0.92;
    slot.pos = (slot.pos || new THREE.Vector3()).copy(d.pos);
    slot.pos.y += (World.player && d.target === World.player) ? 1.2 : 1.35;
    // arc: random lateral drift + upward rise, in screen px
    slot.vx = (Math.random() - 0.5) * 46;
    slot.rise = slot.crit ? 92 : 66;
    slot._punch = 1;
    slot.tid = tid;

    const col = slot.crit ? dmgColor('crit') : dmgColor(slot.type);
    slot.node.className = 'dmg' + (slot.crit ? ' crit' : '');
    slot.node.style.color = col;
    slot.node.style.display = 'block';
    slot._text = '';
    this.live.push(slot);
    if (tid != null) this.recent.set(tid, slot);
  }

  _acquire() {
    for (const p of this.pool) if (!p.active) return p;
    // all busy — steal the oldest
    let oldest = null;
    for (const p of this.live) if (!oldest || p.age > oldest.age) oldest = p;
    if (oldest) { this._release(oldest); return oldest; }
    return null;
  }

  _release(slot) {
    slot.active = false;
    slot.node.style.display = 'none';
    const i = this.live.indexOf(slot);
    if (i >= 0) this.live.splice(i, 1);
    if (slot.tid != null && this.recent.get(slot.tid) === slot) this.recent.delete(slot.tid);
  }

  frame(dt) {
    if (!this.live.length) return;
    const cam = World.camera;
    if (!cam) return;
    const W = window.innerWidth, H = window.innerHeight;

    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      s.age += dt;
      if (s.age >= s.life) { this._release(s); continue; }

      const u = s.age / s.life;               // 0..1
      // ease-out rise: fast then settling
      const riseEase = 1 - Math.pow(1 - u, 2.4);
      // project world pos to screen
      _v.copy(s.pos).project(cam);
      if (_v.z > 1) { this._release(s); continue; }  // behind camera
      const sx = (_v.x * 0.5 + 0.5) * W + s.vx * u;
      const sy = (-_v.y * 0.5 + 0.5) * H - s.rise * riseEase;

      // punch scale on birth/merge, decaying
      if (s._punch > 0) s._punch = Math.max(0, s._punch - dt * 5);
      const punch = s.crit ? 1.15 : 1.0;
      const scale = punch + s._punch * (s.crit ? 0.5 : 0.32);
      // fade: hold, then ease out in the last 45%
      const alpha = u < 0.55 ? 1 : 1 - Math.pow((u - 0.55) / 0.45, 1.8);

      s.node.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      s.node.style.opacity = alpha.toFixed(3);

      const txt = fmt(s.total) + (s.crit ? '<span class="crit-mark">!</span>' : '');
      if (txt !== s._text) { s.node.innerHTML = txt; s._text = txt; }
    }
  }

  dispose() { this._off?.(); }
}

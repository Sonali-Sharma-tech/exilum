// Toggleable debug overlay (F3): fps, frame time, draw calls, triangles, entity
// count, active particles. Reads World.renderer.info + World.__ENGINE/window.
// Batched text writes at ~5Hz; zero layout churn.
import { World } from '../core/world.js';
import { el } from './theme.js';

export class DebugOverlay {
  constructor(root) {
    this.box = el('div', null, root); this.box.id = 'debug';
    el('div', 'd-title', this.box).textContent = 'EXILIUM · F3';
    this.rows = {};
    for (const [k, label] of [
      ['fps', 'fps'], ['ft', 'frame'], ['calls', 'draws'], ['tris', 'tris'],
      ['ent', 'entities'], ['part', 'particles'], ['geo', 'geometries'], ['tex', 'textures'],
    ]) {
      const r = el('div', 'd-row', this.box);
      el('span', 'd-k', r).textContent = label;
      this.rows[k] = el('span', 'd-v' + (k === 'fps' ? ' d-fps' : ''), r);
    }
    this.visible = false;
    this._acc = 0; this._frames = 0; this._ftSum = 0; this._ftPeak = 0;
    this._onKey = (e) => { if (e.key === 'F3') { e.preventDefault(); this.toggle(); } };
    addEventListener('keydown', this._onKey);
  }

  toggle() { this.visible = !this.visible; this.box.classList.toggle('show', this.visible); }

  frame(dt) {
    // accumulate every frame (cheap), display at 5Hz
    this._frames++; this._ftSum += dt; if (dt > this._ftPeak) this._ftPeak = dt;
    if (!this.visible) { this._acc += dt; if (this._acc > 0.2) { this._acc = 0; this._frames = 0; this._ftSum = 0; this._ftPeak = 0; } return; }
    this._acc += dt;
    if (this._acc < 0.2) return;

    const avg = this._ftSum / Math.max(1, this._frames);
    const fps = 1 / Math.max(1e-4, avg);
    const set = (k, v) => { if (this.rows[k].textContent !== v) this.rows[k].textContent = v; };

    set('fps', fps.toFixed(0));
    const fCls = fps >= 58 ? '' : fps >= 45 ? ' warn' : ' bad';
    if (this.rows.fps.className !== 'd-v d-fps' + fCls) this.rows.fps.className = 'd-v d-fps' + fCls;
    set('ft', `${(avg * 1000).toFixed(1)}ms ↑${(this._ftPeak * 1000).toFixed(0)}`);

    const info = World.renderer && World.renderer.info;
    if (info) {
      set('calls', String(info.render.calls));
      set('tris', fmtN(info.render.triangles));
      set('geo', String(info.memory.geometries));
      set('tex', String(info.memory.textures));
    }

    let ents = 0;
    for (const e of World.entities) if (e.alive) ents++;
    set('ent', String(ents));

    set('part', String(readParticles()));

    this._acc = 0; this._frames = 0; this._ftSum = 0; this._ftPeak = 0;
  }

  dispose() { removeEventListener('keydown', this._onKey); }
}

function fmtN(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

// Active particles are owned by VFX; probe the common exposure points.
function readParticles() {
  const eng = World.__ENGINE || window.__ENGINE;
  const c = World.vfx?.activeParticles ?? World.vfx?.active ?? World.particles?.active
    ?? World.__particles ?? (eng && eng.particles);
  return typeof c === 'number' ? c : (c && c.length) || 0;
}

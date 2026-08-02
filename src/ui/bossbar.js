// Boss health bar: top-centre, forged gold frame. Appears when World.boss is set.
// Segment ticks, phase pips (light at 66% / 33%), and a delayed "damage taken"
// ghost bar behind the fill. Resistance text beneath (per art direction).
// Fill + ghost animate with scaleX (compositor-only).
import { World } from '../core/world.js';
import { el, damp, clamp01, fmt } from './theme.js';

const SEGMENTS = 24;

export class BossBar {
  constructor(root) {
    this.box = el('div', 'forged', root); this.box.id = 'bossbar';
    el('div', 'flourish tl', this.box).appendChild(flourish());
    el('div', 'flourish tr', this.box).appendChild(flourish());

    this.name = el('div', 'boss-name', this.box);
    const track = el('div', 'boss-track', this.box);
    this.ghost = el('div', 'boss-ghost', track);
    this.fill = el('div', 'boss-fill', track);
    for (let i = 1; i < SEGMENTS; i++) {
      const t = el('div', 'boss-tick', track);
      t.style.left = (i / SEGMENTS * 100) + '%';
      // phase boundaries thicker
      if (i === Math.round(SEGMENTS / 3) || i === Math.round(2 * SEGMENTS / 3)) {
        t.style.width = '2px'; t.style.background = 'rgba(240,217,122,.6)'; t.style.zIndex = 5;
      }
    }
    this.phase = el('div', 'boss-phase', track);
    this.res = el('div', null, this.box);
    this.res.style.cssText = 'text-align:center;font-size:10px;letter-spacing:.14em;color:#9a8f6e;margin-top:5px;text-transform:uppercase;font-variant:small-caps';

    this.disp = 1; this.ghostV = 1; this.shown = false; this._ghostDelay = 0;
    this._name = ''; this._phaseTxt = '';
  }

  frame(dt) {
    const b = World.boss;
    const alive = b && b.alive !== false && (b.maxHp || b.hp);
    if (!alive) {
      if (this.shown) {
        this.shown = false;
        this.box.classList.remove('show');
        this.box.style.opacity = '0';
        this.box.style.transform = 'translateX(-50%) translateY(-14px)';
      }
      return;
    }
    if (!this.shown) {
      this.shown = true;
      this.box.classList.add('show');
      this.disp = this.ghostV = clamp01(b.hp / Math.max(1, b.maxHp));
      requestAnimationFrame(() => {
        this.box.style.opacity = '1';
        this.box.style.transform = 'translateX(-50%) translateY(0)';
      });
    }

    const frac = clamp01((b.hp || 0) / Math.max(1, b.maxHp || 1));
    // main fill snaps quickly toward true value
    const prev = this.disp;
    this.disp = damp(this.disp, frac, 12, dt);
    this.fill.style.transform = `scaleX(${this.disp.toFixed(4)})`;

    // ghost bar: holds, then drains slowly to reveal damage taken
    if (frac < prev - 0.0005) this._ghostDelay = 0.5;   // took damage -> pause the ghost
    if (this._ghostDelay > 0) this._ghostDelay -= dt;
    else this.ghostV = damp(this.ghostV, this.disp, 3.2, dt);
    if (this.ghostV < this.disp) this.ghostV = this.disp;
    this.ghost.style.transform = `scaleX(${this.ghostV.toFixed(4)})`;

    // name (only on change)
    const nm = b.name || 'Unnamed Horror';
    if (nm !== this._name) { this._name = nm; this.name.textContent = nm; }

    // phase pips
    const phases = b.phases || 3;
    const cur = b.phase || (frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3);
    const ptxt = `Phase ${cur} / ${phases}`;
    if (ptxt !== this._phaseTxt) { this._phaseTxt = ptxt; this.phase.textContent = ptxt; }

    // resistance / hp line beneath — read the boss's own resists when exposed
    const r = b.res || b.resistances || { fire: 40, cold: 40, lightning: 40, chaos: 25 };
    const rtxt = `${fmt(b.hp)} / ${fmt(b.maxHp)}   —   Fire ${r.fire ?? 40}%  ·  Cold ${r.cold ?? 40}%  ·  Lightning ${r.lightning ?? r.light ?? 40}%  ·  Chaos ${r.chaos ?? 25}%`;
    if (rtxt !== this._res) { this._res = rtxt; this.res.textContent = rtxt; }
  }
}

function flourish() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 30 30'); s.setAttribute('width', '30'); s.setAttribute('height', '30');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M2 2 L14 2 M2 2 L2 14 M2 2 Q10 4 12 12 Q4 10 2 2Z');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#c9a227'); p.setAttribute('stroke-width', '1.4');
  s.appendChild(p);
  return s;
}

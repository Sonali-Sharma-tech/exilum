// XP bar: thin, bottom-edge, PoE-style segmented, with a level readout and a
// satisfying shimmer-swept fill on EV.XP_GAIN. Reads World.stats.
// Fill animates with scaleX (compositor-only), never width (no layout thrash).
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { el, clamp01, damp } from './theme.js';

const SEGMENTS = 40;

export class XpBar {
  constructor(root) {
    this.wrap = el('div', null, root); this.wrap.id = 'xpbar';
    this.fill = el('div', 'xp-fill', this.wrap);
    for (let i = 1; i < SEGMENTS; i++) {
      const s = el('div', 'xp-seg', this.wrap);
      s.style.left = (i / SEGMENTS * 100) + '%';
    }
    this.shine = el('div', 'xp-shine', this.wrap);
    this.level = el('div', null, root); this.level.id = 'xplevel';

    this.disp = 0; this.target = 0; this._lvl = -1; this._shineT = 0;
    this._off = bus.on(EV.XP_GAIN, () => { this._shineT = 0.9; });
  }

  frame(dt) {
    const st = World.stats || { level: 1, xp: 0, xpNext: 1 };
    this.target = clamp01((st.xp || 0) / Math.max(1, st.xpNext || 1));
    // a level-up can drop xp fraction; snap-catch so the fill doesn't run backwards oddly
    this.disp = damp(this.disp, this.target, 6, dt);
    this.fill.style.transform = `scaleX(${this.disp.toFixed(4)})`;

    if (st.level !== this._lvl) {
      this._lvl = st.level;
      this.level.textContent = `Level ${st.level}`;
    }

    if (this._shineT > 0) {
      this._shineT -= dt;
      const p = 1 - this._shineT / 0.9;             // 0..1
      const x = -120 + p * (window.innerWidth + 240);
      this.shine.style.transform = `translateX(${x}px)`;
      this.shine.style.opacity = Math.sin(p * Math.PI).toFixed(3);
    } else if (this.shine.style.opacity !== '0' && this.shine.style.opacity !== '') {
      this.shine.style.opacity = '0';
    }
  }

  dispose() { this._off?.(); }
}

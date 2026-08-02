// Pickup toasts on EV.UI_TOAST {text, tier?, color?}. Rarity-coloured, stacking
// at the screen edge, auto-expiring. Pooled nodes; transform/opacity only.
import { bus, EV } from '../core/events.js';
import { el, rarityOf, hexCss } from './theme.js';

const MAX = 7;
const LIFE = 3.6;      // seconds visible before auto-expire

export class Toasts {
  constructor(root) {
    this.wrap = el('div', null, root); this.wrap.id = 'toasts';
    this.pool = []; this.live = [];
    for (let i = 0; i < MAX + 2; i++) {
      const n = el('div', 'toast', this.wrap);
      const t = el('span', 't-txt', n);
      n.style.display = 'none';
      this.pool.push({ node: n, txt: t, active: false, age: 0 });
    }
    this._off = bus.on(EV.UI_TOAST, (d) => this.push(d));
  }

  push(d) {
    if (!d || !d.text) return;
    let slot = this.pool.find((p) => !p.active);
    if (!slot) { slot = this.live[0]; if (slot) this._retire(slot, true); slot = this.pool.find((p) => !p.active); }
    if (!slot) return;

    const col = d.color != null ? hexCss(d.color) : rarityOf(d.tier || 'normal').color;
    slot.active = true; slot.age = 0; slot.state = 'in';
    slot.txt.textContent = d.text;
    slot.node.style.color = col;                 // border uses currentColor
    slot.node.style.display = 'block';
    slot.node.classList.remove('in', 'out');
    // move to top of stack visually
    this.wrap.insertBefore(slot.node, this.wrap.firstChild);
    this.live.push(slot);
    // enforce cap
    while (this.live.length > MAX) this._retire(this.live[0], false);
    requestAnimationFrame(() => { if (slot.active) slot.node.classList.add('in'); });
  }

  _retire(slot, immediate) {
    slot.state = 'out';
    slot.node.classList.remove('in'); slot.node.classList.add('out');
    const done = () => {
      slot.active = false; slot.node.style.display = 'none';
      slot.node.classList.remove('out');
      const i = this.live.indexOf(slot); if (i >= 0) this.live.splice(i, 1);
    };
    if (immediate) done(); else slot._retireAt = performance.now() + 260;
  }

  frame(dt) {
    if (!this.live.length) return;
    const now = performance.now();
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      if (s.state === 'out') { if (s._retireAt && now >= s._retireAt) { s.active = false; s.node.style.display = 'none'; s.node.classList.remove('out'); this.live.splice(i, 1); } continue; }
      s.age += dt;
      if (s.age >= LIFE) this._retire(s, false);
    }
  }

  dispose() { this._off?.(); }
}

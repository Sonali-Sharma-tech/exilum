// Skill bar: forged slots with generated icon art, a REAL radial cooldown wedge
// (SVG clock-wipe, not an opacity fade), mana-cost tinting, insufficient-mana /
// locked states, and keybind labels.
//
// Cast reconciliation: EV.PLAYER_CAST is authoritative when combat is wired —
// the first cast observed flips `castWired` and permanently disables the local
// input-press fallback, so exactly ONE path starts each cooldown / mana spend.
// Until then (combat/player stubbed) the input-press path drives feedback.
import { Input } from '../core/input.js';
import { PAL, el, svg, drawIcon } from './theme.js';
import { SKILLS } from './skills.js';

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const R = 75; // wedge radius in a 0..100 viewBox (over-covers the square corners)

function wedgePath(frac) {
  if (frac <= 0) return '';
  if (frac >= 0.9999) frac = 0.9999;
  const e = 1 - frac;
  const a0 = (-90 + e * 360) * Math.PI / 180;
  const a1 = (-90 + 360) * Math.PI / 180;
  const x0 = 50 + R * Math.cos(a0), y0 = 50 + R * Math.sin(a0);
  const x1 = 50 + R * Math.cos(a1), y1 = 50 + R * Math.sin(a1);
  const large = frac > 0.5 ? 1 : 0;
  return `M50 50 L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export class SkillBar {
  constructor(root, vitals) {
    this.vitals = vitals;
    this.castWired = false;
    this.bar = el('div', 'forged', root);
    this.bar.id = 'skillbar';
    this.slots = SKILLS.map((def) => this._buildSlot(def));
  }

  _buildSlot(def) {
    const box = el('div', 'skill', this.bar);
    const size = 48;
    const cv = el('canvas', null, box);
    cv.width = cv.height = Math.round(size * DPR);
    drawIcon(cv.getContext('2d'), def.icon, def.color, cv.width);

    const g = svg('svg', { class: 'cd-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none' }, box);
    g.style.overflow = 'visible';
    const wedge = svg('path', { d: '', fill: 'rgba(0,0,0,.66)' }, g);
    const hand = svg('line', { x1: 50, y1: 50, x2: 50, y2: -25, stroke: PAL.goldLite, 'stroke-width': 1.4, opacity: 0 }, g);

    const flash = el('div', 'flash', box);
    const cdText = el('div', 'cd-text', box);
    if (def.mana > 0) { const m = el('div', 'mana-cost', box); m.textContent = def.mana; }
    const key = el('div', 'key', box); key.textContent = def.label;

    return { def, box, wedge, hand, flash, cdText, cd: 0, flashT: 0, cooling: false, noMana: false, _secs: null };
  }

  _startCooldown(s, color) {
    s.cd = s.def.cd; s.flashT = 0.16;
    s.flash.style.background = `radial-gradient(circle,${color},transparent 70%)`;
  }

  // local input attempt (only when combat isn't emitting PLAYER_CAST)
  _tryCast(s) {
    if (s.cd > 0.02) return;
    if (this.vitals.mana < s.def.mana) {
      s.flashT = 0.18;
      s.flash.style.background = 'radial-gradient(circle,rgba(255,90,78,.6),transparent 70%)';
      return;
    }
    this.vitals.mana = Math.max(0, this.vitals.mana - s.def.mana);
    this._startCooldown(s, s.def.color);
  }

  // authoritative cast from EV.PLAYER_CAST
  onCast(idx) {
    this.castWired = true;
    const s = this.slots[idx]; if (!s || s.cd > 0.02) return;
    this.vitals.mana = Math.max(0, this.vitals.mana - s.def.mana);
    this._startCooldown(s, s.def.color);
  }

  frame(dt) {
    const v = this.vitals;
    for (const s of this.slots) {
      if (!this.castWired) {
        const pressed = s.def.slot === 'lmb' ? Input.lmbEdge : Input.pressed(s.def.key);
        if (pressed) this._tryCast(s);
      }

      if (s.cd > 0) {
        s.cd -= dt; if (s.cd < 0) s.cd = 0;
        const frac = s.def.cd > 0 ? s.cd / s.def.cd : 0;
        if (!s.cooling) { s.cooling = true; s.box.classList.add('cooling'); s.hand.style.opacity = '0.8'; }
        s.wedge.setAttribute('d', wedgePath(frac));
        const secs = s.cd >= 1 ? String(Math.ceil(s.cd)) : s.cd.toFixed(1);
        if (secs !== s._secs) { s.cdText.textContent = secs; s._secs = secs; }
        const ang = (-90 + (1 - frac) * 360) * Math.PI / 180;
        s.hand.setAttribute('x2', (50 + R * Math.cos(ang)).toFixed(1));
        s.hand.setAttribute('y2', (50 + R * Math.sin(ang)).toFixed(1));
      } else if (s.cooling) {
        s.cooling = false; s.box.classList.remove('cooling');
        s.wedge.setAttribute('d', ''); s.hand.style.opacity = '0'; s._secs = null;
      }

      const noMana = v.mana < s.def.mana;
      if (noMana !== s.noMana) { s.noMana = noMana; s.box.classList.toggle('no-mana', noMana); }

      if (s.flashT > 0) {
        s.flashT -= dt;
        s.flash.style.opacity = Math.max(0, s.flashT / 0.16).toFixed(3);
      } else if (s.flash.style.opacity !== '0' && s.flash.style.opacity !== '') {
        s.flash.style.opacity = '0';
      }
    }
  }
}

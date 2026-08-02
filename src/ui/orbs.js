// Life & mana orbs — the signature PoE element. Canvas liquid surface with a
// curved wave meniscus, internal caustic motion, reserve/degen bands, and an
// ornate SVG metal frame. Fill smooth-damps toward the target on change.
import { PAL, el, svg, fmt, clamp01, damp } from './theme.js';

const DPR = Math.min(window.devicePixelRatio || 1, 2);

export class Orb {
  constructor(kind, root) {
    this.kind = kind;                 // 'life' | 'mana'
    this.size = 152;
    this.disp = 1;                    // displayed fill 0..1 (damped)
    this.target = 1;
    this.reserve = 0;                 // reserved fraction (bottom dim band)
    this.degen = false;               // draining -> surface streak
    this.low = false;
    this.value = 0; this.max = 1;
    this._lastVal = 0;
    this._degenT = 0;

    const c = kind === 'life'
      ? { fill: PAL.life, deep: PAL.lifeDeep, lite: PAL.lifeLite }
      : { fill: PAL.mana, deep: PAL.manaDeep, lite: PAL.manaLite };
    this.col = c;

    this.box = el('div', `orb ${kind}`, root);
    this.box.style.width = this.box.style.height = this.size + 'px';

    this.canvas = el('canvas', 'orb-liquid', this.box);
    this.canvas.width = this.canvas.height = Math.round(this.size * DPR);
    this.x = this.canvas.getContext('2d');

    this._buildFrame();
    this.valEl = el('div', 'orb-val', this.box);
    this.r = (this.size * 0.5 - 10);  // inner glass radius (css px)
  }

  _buildFrame() {
    const s = this.size, cx = s / 2, cy = s / 2;
    const g = svg('svg', { class: 'orb-frame', viewBox: `0 0 ${s} ${s}` }, this.box);
    const defs = svg('defs', null, g);
    const grad = svg('linearGradient', { id: `og-${this.kind}`, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    svg('stop', { offset: '0',   'stop-color': PAL.goldLite }, grad);
    svg('stop', { offset: '.5',  'stop-color': PAL.gold }, grad);
    svg('stop', { offset: '1',   'stop-color': PAL.goldDeep }, grad);
    const inner = svg('radialGradient', { id: `oi-${this.kind}`, cx: '.5', cy: '.5', r: '.5' }, defs);
    svg('stop', { offset: '.86', 'stop-color': 'rgba(0,0,0,0)' }, inner);
    svg('stop', { offset: '1',   'stop-color': this.col.deep, 'stop-opacity': '.9' }, inner);

    // colored inner rim (reads life/mana at a glance)
    svg('circle', { cx, cy, r: s * 0.5 - 8, fill: 'none', stroke: this.col.fill, 'stroke-width': 3, opacity: .28 }, g);
    // dark bevel between glass and ring
    svg('circle', { cx, cy, r: s * 0.5 - 6, fill: 'none', stroke: '#000', 'stroke-width': 3 }, g);
    // main gold ring
    svg('circle', { cx, cy, r: s * 0.5 - 3, fill: 'none', stroke: `url(#og-${this.kind})`, 'stroke-width': 6,
      filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.7))' }, g);
    // top-left specular highlight arc on the ring
    const rr = s * 0.5 - 3;
    const a0 = Math.PI * 1.05, a1 = Math.PI * 1.65;
    const p = `M ${cx + Math.cos(a0) * rr} ${cy + Math.sin(a0) * rr} A ${rr} ${rr} 0 0 1 ${cx + Math.cos(a1) * rr} ${cy + Math.sin(a1) * rr}`;
    svg('path', { d: p, fill: 'none', stroke: PAL.goldLite, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: .8 }, g);
    // vignette darkening at glass edge
    svg('circle', { cx, cy, r: s * 0.5 - 8, fill: `url(#oi-${this.kind})` }, g);
    // rivets
    const rivR = s * 0.5 - 3;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
      const rx = cx + Math.cos(a) * rivR, ry = cy + Math.sin(a) * rivR;
      svg('circle', { cx: rx, cy: ry, r: 2.1, fill: '#0a0a0a', stroke: PAL.goldDeep, 'stroke-width': .8 }, g);
    }
  }

  set(value, max, opts) {
    this.value = value; this.max = Math.max(1, max);
    this.target = clamp01(value / this.max);
    if (opts) { this.reserve = opts.reserve || 0; }
    // detect degen (value dropping without a discrete hit)
    if (value < this._lastVal - 0.5) this._degenT = 0.5;
    this._lastVal = value;
    this.low = this.target < 0.35 && this.kind === 'life';
    this.box.classList.toggle('lowlife', this.low);
  }

  frame(dt, t) {
    this.disp = damp(this.disp, this.target, 9, dt);
    if (this._degenT > 0) this._degenT -= dt;
    this.degen = this._degenT > 0;
    this._draw(t);
    // nameplate: only touch text when it changes (avoid layout churn)
    const txt = `${fmt(this.value)} / ${fmt(this.max)}`;
    if (txt !== this._txt) { this.valEl.textContent = txt; this._txt = txt; }
  }

  _draw(t) {
    const x = this.x, s = this.canvas.width, r = (this.r) * DPR, cx = s / 2, cy = s / 2;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, s, s);
    x.save();
    // clip to glass circle
    x.beginPath(); x.arc(cx, cy, r, 0, 7); x.clip();

    // dark glass backing
    const bg = x.createRadialGradient(cx - r * .3, cy - r * .3, r * .1, cx, cy, r);
    bg.addColorStop(0, '#0c0e14'); bg.addColorStop(1, '#020306');
    x.fillStyle = bg; x.fillRect(cx - r, cy - r, r * 2, r * 2);

    const fill = this.disp;
    const surfaceY = cy + r - fill * (2 * r);   // y of liquid surface
    const col = this.col;

    if (fill > 0.001) {
      // wave meniscus: two summed sines scrolling in opposite directions
      const amp = r * 0.04 * (0.6 + 0.4 * Math.sin(t * 0.7));
      x.beginPath();
      x.moveTo(cx - r, cy + r);
      x.lineTo(cx - r, surfaceY);
      const steps = 26, span = 2 * r;
      for (let i = 0; i <= steps; i++) {
        const px = cx - r + (i / steps) * span;
        const w = Math.sin((i / steps) * 6.28 * 2 + t * 2.1) * amp
                + Math.sin((i / steps) * 6.28 * 3.5 - t * 1.3) * amp * 0.5;
        x.lineTo(px, surfaceY + w);
      }
      x.lineTo(cx + r, cy + r);
      x.closePath();

      const lg = x.createLinearGradient(0, surfaceY, 0, cy + r);
      lg.addColorStop(0, col.lite);
      lg.addColorStop(0.14, col.fill);
      lg.addColorStop(1, col.deep);
      x.fillStyle = lg; x.fill();

      // internal caustic motion — drifting glow blobs (clipped by fill path)
      x.save(); x.clip();
      x.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const bx = cx + Math.sin(t * (0.5 + i * 0.27) + i * 2) * r * 0.5;
        const by = surfaceY + (0.35 + i * 0.22) * (cy + r - surfaceY) + Math.cos(t * 0.6 + i) * r * 0.12;
        const br = r * (0.22 + 0.05 * Math.sin(t + i));
        const gb = x.createRadialGradient(bx, by, 0, bx, by, br);
        gb.addColorStop(0, col.lite); gb.addColorStop(1, 'rgba(0,0,0,0)');
        x.globalAlpha = 0.16; x.fillStyle = gb;
        x.beginPath(); x.arc(bx, by, br, 0, 7); x.fill();
      }
      x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';

      // reserve band: dim + hatch at the bottom
      if (this.reserve > 0.001) {
        const rh = this.reserve * (2 * r);
        x.fillStyle = 'rgba(0,0,0,.42)';
        x.fillRect(cx - r, cy + r - rh, r * 2, rh);
        x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1.5;
        for (let hx = -r; hx < r * 2; hx += 8) {
          x.beginPath(); x.moveTo(cx + hx, cy + r); x.lineTo(cx + hx + rh, cy + r - rh); x.stroke();
        }
      }
      x.restore();

      // bright specular line along the surface
      x.save();
      x.beginPath();
      for (let i = 0; i <= steps; i++) {
        const px = cx - r + (i / steps) * span;
        const w = Math.sin((i / steps) * 6.28 * 2 + t * 2.1) * amp
                + Math.sin((i / steps) * 6.28 * 3.5 - t * 1.3) * amp * 0.5;
        x[i ? 'lineTo' : 'moveTo'](px, surfaceY + w);
      }
      x.strokeStyle = col.lite; x.lineWidth = 2 * DPR; x.globalAlpha = 0.75;
      x.shadowColor = col.lite; x.shadowBlur = 8 * DPR; x.stroke();
      x.restore();

      // degen streak: faint downward-flowing warm band just under the surface
      if (this.degen) {
        x.save(); x.globalAlpha = 0.3 * (this._degenT / 0.5);
        const dg = x.createLinearGradient(0, surfaceY, 0, surfaceY + r * 0.4);
        dg.addColorStop(0, this.kind === 'life' ? '#ff8a5a' : '#8fd0ff'); dg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = dg; x.fillRect(cx - r, surfaceY, r * 2, r * 0.4); x.restore();
      }
    }

    // top glass reflection (over everything, inside glass)
    const rf = x.createRadialGradient(cx - r * 0.34, cy - r * 0.44, r * 0.02, cx - r * 0.34, cy - r * 0.44, r * 0.8);
    rf.addColorStop(0, 'rgba(255,255,255,.20)'); rf.addColorStop(0.4, 'rgba(255,255,255,.04)'); rf.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = rf; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();

    x.restore();
  }
}

// Minimap: top-right, canvas (never DOM nodes). Pre-renders World.level
// walkability once on LEVEL_READY into an offscreen bitmap, then each throttled
// tick draws a player-centred, yaw-rotated sub-view with fog-of-war reveal and
// crisp fixed-size blips for player / enemies / loot.
import { CFG } from '../core/config.js';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { PAL, el, svg } from './theme.js';
import { Input } from '../core/input.js';

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const VIEW_RADIUS = 36;       // world units shown from centre to edge
// How far along the cursor's direction the scout reveal lands. Must exceed the player's own
// REVEAL_RADIUS or it reveals nothing new — the cursor's raw ground point tops out at ~7.5
// units from the player at this camera, well inside the 17 he already clears.
const SCOUT_DISTANCE = 27;
const REVEAL_RADIUS = 17;     // fog reveal radius (world units) around the PLAYER
const HZ = 14;                // update rate (throttled, not per-frame)

export class Minimap {
  constructor(root) {
    this.box = el('div', 'forged', root); this.box.id = 'minimap';
    this.size = 190;
    this.canvas = el('canvas', null, this.box);
    this.inner = this.size - 8;
    this.canvas.width = this.canvas.height = Math.round(this.inner * DPR);
    this.x = this.canvas.getContext('2d');

    this._buildFrame();
    this.zone = el('div', 'mm-zone', this.box); this.zone.textContent = 'The Sunder';

    this.map = null; this.fog = null; this.mapScale = 1;
    this.bounds = null;
    this._acc = 0; this._lastReveal = { x: 1e9, z: 1e9 };
    this._lastCursorReveal = { x: 1e9, z: 1e9 };
    this._off = bus.on(EV.LEVEL_READY, () => this._bake());
    if (World.level) this._bake();
  }

  _buildFrame() {
    const s = this.size;
    const g = svg('svg', { class: 'mm-frame', viewBox: `0 0 ${s} ${s}` }, this.box);
    const defs = svg('defs', null, g);
    const grad = svg('linearGradient', { id: 'mm-ring', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    svg('stop', { offset: '0', 'stop-color': PAL.goldLite }, grad);
    svg('stop', { offset: '.5', 'stop-color': PAL.gold }, grad);
    svg('stop', { offset: '1', 'stop-color': PAL.goldDeep }, grad);
    const r = s / 2 - 4;
    svg('circle', { cx: s / 2, cy: s / 2, r: r + 2, fill: 'none', stroke: '#000', 'stroke-width': 5 }, g);
    svg('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', stroke: 'url(#mm-ring)', 'stroke-width': 3,
      filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.8))' }, g);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      svg('circle', { cx: s / 2 + Math.cos(a) * (r + 1), cy: s / 2 + Math.sin(a) * (r + 1), r: 2.4,
        fill: '#0a0a0a', stroke: PAL.goldDeep, 'stroke-width': .8 }, g);
    }
    // N marker
    svg('circle', { cx: s / 2, cy: 6, r: 6, fill: '#0a0a0a', stroke: PAL.gold, 'stroke-width': 1 }, g);
    const nt = svg('text', { x: s / 2, y: 9, 'text-anchor': 'middle', 'font-size': 8, fill: PAL.goldLite }, g);
    nt.textContent = 'N';
  }

  _bake() {
    const lvl = World.level; if (!lvl || !lvl.bounds || !lvl.walkable) return;
    const b = lvl.bounds; this.bounds = b;
    const spanX = Math.max(1, b.maxX - b.minX), spanZ = Math.max(1, b.maxZ - b.minZ);
    const maxSpan = Math.max(spanX, spanZ);
    const scale = Math.min(this.inner * DPR / (2 * VIEW_RADIUS), 1000 / maxSpan);
    this.mapScale = scale;
    const mw = Math.max(2, Math.ceil(spanX * scale)), mh = Math.max(2, Math.ceil(spanZ * scale));

    const map = document.createElement('canvas'); map.width = mw; map.height = mh;
    const mx = map.getContext('2d');
    const img = mx.createImageData(mw, mh), d = img.data;
    for (let py = 0; py < mh; py++) {
      const wz = b.minZ + py / scale;
      for (let px = 0; px < mw; px++) {
        const wx = b.minX + px / scale;
        const i = (py * mw + px) * 4;
        if (lvl.walkable(wx, wz)) {
          // warm dark floor with mild variation
          const n = ((px * 13 + py * 7) % 11) * 2;
          d[i] = 46 + n; d[i + 1] = 40 + n; d[i + 2] = 30; d[i + 3] = 235;
        } else { d[i + 3] = 0; }
      }
    }
    mx.putImageData(img, 0, 0);
    // gold-tinted edge on walls (cheap: outline via shadow pass)
    this.map = map;

    const fog = document.createElement('canvas'); fog.width = mw; fog.height = mh;
    const fx = fog.getContext('2d');
    fx.fillStyle = 'rgba(4,5,8,.94)'; fx.fillRect(0, 0, mw, mh);
    this.fog = fog; this.fogx = fx;
    this._lastReveal.x = 1e9;
  }

  _reveal(px, pz, radius) {
    if (!this.fog) return;
    const s = this.mapScale, b = this.bounds;
    const cx = (px - b.minX) * s, cy = (pz - b.minZ) * s;
    const r = (radius ?? REVEAL_RADIUS) * s;
    const g = this.fogx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    this.fogx.save();
    this.fogx.globalCompositeOperation = 'destination-out';
    this.fogx.fillStyle = g;
    this.fogx.beginPath(); this.fogx.arc(cx, cy, r, 0, 7); this.fogx.fill();
    this.fogx.restore();
  }

  frame(dt) {
    this._acc += dt;
    if (this._acc < 1 / HZ) return;
    this._acc = 0;
    const p = World.player; const x = this.x;
    const S = this.canvas.width, C = S / 2;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, S, S);
    // circular clip + backdrop
    x.save();
    x.beginPath(); x.arc(C, C, C - 1, 0, 7); x.clip();
    x.fillStyle = '#030407'; x.fillRect(0, 0, S, S);

    if (this.map && p && this.bounds) {
      // Reveal around the PLAYER as he moves.
      if (Math.hypot(p.pos.x - this._lastReveal.x, p.pos.z - this._lastReveal.z) > 2) {
        this._reveal(p.pos.x, p.pos.z);
        this._lastReveal.x = p.pos.x; this._lastReveal.z = p.pos.z;
      }
      // ── CURSOR-DRIVEN DISCOVERY (scouting) ─────────────────────────────────
      // Sweeping the mouse scouts the map. Previously the fog lifted ONLY around the player,
      // so with a 17-unit reveal radius and seven rooms you could stand in a doorway and have
      // no idea what lay beyond it — the cursor contributed nothing to discovery.
      //
      // MEASURED CONSTRAINT that shaped this: `Input.ground` (the cursor projected onto the
      // play surface) never gets far from the player. At 1568x1015 with the camera at
      // distance 21 and fov 30, the cursor's ground point reaches only ~5.1 units at the
      // screen's horizontal edge and ~7.5 at a corner. The player's own reveal radius is 17,
      // so revealing AT the cursor is always strictly inside what he already reveals — it
      // could never expose anything new. A naive "reveal where the cursor points" is a no-op,
      // and measuring it is the only reason I know that.
      //
      // So the cursor sets a DIRECTION and we scout along it, out to SCOUT_DISTANCE. Sweeping
      // the mouse around the character therefore sweeps a revealed annulus beyond his own
      // radius, which is what "cursor movement helps discover the area" actually needs.
      const cg = Input.ground;
      if (cg) {
        let dxc = cg.x - p.pos.x, dzc = cg.z - p.pos.z;
        const len = Math.hypot(dxc, dzc);
        if (len > 0.6) {
          dxc /= len; dzc /= len;
          const sx2 = p.pos.x + dxc * SCOUT_DISTANCE;
          const sz2 = p.pos.z + dzc * SCOUT_DISTANCE;
          if (Math.hypot(sx2 - this._lastCursorReveal.x, sz2 - this._lastCursorReveal.z) > 4) {
            // Smaller than the player's own reveal: looking somewhere hints at it, walking
            // there maps it properly.
            this._reveal(sx2, sz2, REVEAL_RADIUS * 0.55);
            this._lastCursorReveal.x = sx2; this._lastCursorReveal.z = sz2;
          }
        }
      }
      const view = S / (2 * VIEW_RADIUS);            // display px per world unit
      const conv = view / this.mapScale;             // map-px -> display-px
      const b = this.bounds;
      x.save();
      x.translate(C, C);
      x.rotate(this.rot);
      x.scale(conv, conv);
      x.translate(-(p.pos.x - b.minX) * this.mapScale, -(p.pos.z - b.minZ) * this.mapScale);
      x.imageSmoothingEnabled = true;
      x.drawImage(this.map, 0, 0);
      x.globalAlpha = 1;
      x.drawImage(this.fog, 0, 0);
      x.restore();

      // blips (computed in rotated screen space, fixed pixel size)
      const cos = Math.cos(this.rot), sin = Math.sin(this.rot);
      const project = (wx, wz) => {
        const dx = wx - p.pos.x, dz = wz - p.pos.z;
        return [C + (dx * cos - dz * sin) * view, C + (dx * sin + dz * cos) * view];
      };
      // loot
      const loot = World.loot || [];
      x.fillStyle = PAL.goldLite;
      for (const it of loot) {
        const lp = it.pos || it.position; if (!lp) continue;
        if (Math.hypot(lp.x - p.pos.x, lp.z - p.pos.z) > VIEW_RADIUS) continue;
        const [bx, by] = project(lp.x, lp.z);
        x.beginPath(); x.arc(bx, by, 2.4 * DPR, 0, 7); x.fill();
      }
      // enemies
      for (const e of World.entities) {
        if (!e.alive || e.kind !== 'enemy') continue;
        if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) > VIEW_RADIUS) continue;
        const [bx, by] = project(e.pos.x, e.pos.z);
        const boss = World.boss && (e === World.boss);
        x.fillStyle = boss ? '#ff9a3c' : '#e0322b';
        x.beginPath(); x.arc(bx, by, (boss ? 4 : 2.6) * DPR, 0, 7); x.fill();
      }
      // player arrow (points up; map rotates beneath)
      x.save(); x.translate(C, C);
      x.fillStyle = '#f3e6c2'; x.strokeStyle = '#000'; x.lineWidth = 1 * DPR;
      x.beginPath();
      x.moveTo(0, -6 * DPR); x.lineTo(4.4 * DPR, 5 * DPR); x.lineTo(0, 2.4 * DPR); x.lineTo(-4.4 * DPR, 5 * DPR);
      x.closePath(); x.fill(); x.stroke();
      x.restore();
    }
    // inner vignette
    const vg = x.createRadialGradient(C, C, C * 0.55, C, C, C);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.6)');
    x.fillStyle = vg; x.fillRect(0, 0, S, S);
    x.restore();
  }

  dispose() { this._off?.(); }
}

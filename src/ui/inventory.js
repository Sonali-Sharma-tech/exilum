// Inventory panel (toggle I): PoE-style grid with per-item width/height
// footprints, drag-and-drop with valid/invalid placement highlighting, an
// equipped-slot paperdoll, and stack counts on currency. Reads/mutates
// World.inventory ONLY through LootSystem's functions — never touches item data.
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { el, drawIcon, rarityOf, hexCss } from './theme.js';

const CELL = 42;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// map an item's slot/base to an icon glyph
const SLOT_ICON = {
  weapon: 'slash', offhand: 'rune', helm: 'nova', body: 'shock', gloves: 'bolt',
  boots: 'arrow', belt: 'shock', amulet: 'rune', ring1: 'rune', ring2: 'rune',
  ring: 'rune', flask: 'flame',
};
// paperdoll layout (px within a 210x330 board)
const DOLL = {
  helm:   [84, 4, 42, 42],  amulet: [138, 26, 34, 34],
  weapon: [10, 66, 54, 96], body: [78, 60, 54, 78], offhand: [146, 66, 54, 96],
  gloves: [10, 172, 54, 54], belt: [78, 148, 54, 34], boots: [146, 172, 54, 54],
  ring1:  [30, 234, 34, 34], ring2: [146, 234, 34, 34],
  flask1: [10, 286, 30, 40], flask2: [46, 286, 30, 40], flask3: [82, 286, 30, 40],
  flask4: [118, 286, 30, 40], flask5: [154, 286, 30, 40],
};
const SLOT_LABEL = { weapon: 'WEAPON', offhand: 'OFF', helm: 'HELM', body: 'BODY', gloves: 'GLOVES',
  belt: 'BELT', boots: 'BOOTS', amulet: 'AMULET', ring1: 'RING', ring2: 'RING',
  flask1: 'I', flask2: 'II', flask3: 'III', flask4: 'IV', flask5: 'V' };

export class Inventory {
  constructor(root, tooltip) {
    this.tooltip = tooltip;
    this.scrim = el('div', 'clickable', root); this.scrim.id = 'inv-scrim';
    this.panel = el('div', 'forged clickable', root); this.panel.id = 'inventory';
    el('div', 'panel-title', this.panel).textContent = 'Inventory';

    const cols = el('div', 'inv-cols', this.panel);
    this.doll = el('div', 'paperdoll', cols);
    this.gridWrap = el('div', 'grid-wrap', cols);
    this.grid = el('div', 'inv-grid', this.gridWrap);

    this.open = false;
    this.gc = 12; this.gr = 5;
    this.itemEls = new Map();     // id -> {node, canvas}
    this.eqEls = {};              // slot -> {node, ph, canvas}
    this.drag = null;
    this._dirty = true;
    this._sigAcc = 0;

    this._buildDoll();
    this._buildGrid();

    // interaction
    this.scrim.addEventListener('pointerdown', () => this.toggle(false));
    this._onKey = (e) => { if (e.key.toLowerCase() === 'i') { e.preventDefault(); this.toggle(); } };
    addEventListener('keydown', this._onKey);
    this._onMove = (e) => this._dragMove(e);
    this._onUp = (e) => this._dragEnd(e);
    this._offPick = bus.on(EV.LOOT_PICKUP, () => { this._dirty = true; });
  }

  toggle(force) {
    this.open = force != null ? force : !this.open;
    this.panel.classList.toggle('open', this.open);
    this.scrim.classList.toggle('open', this.open);
    if (this.open) {
      this._dirty = true; this._rebuild();
      requestAnimationFrame(() => {
        this.panel.style.opacity = '1'; this.scrim.style.opacity = '1';
        this.panel.style.transform = 'translate(-50%,-50%) scale(1)';
      });
    } else {
      this.panel.style.opacity = '0'; this.scrim.style.opacity = '0';
      this.panel.style.transform = 'translate(-50%,-50%) scale(.96)';
      this.tooltip.hide();
      this._cancelDrag();
    }
  }

  _buildDoll() {
    const slots = (World.inventory && World.inventory.slots) || Object.keys(DOLL);
    this.doll.style.width = '210px'; this.doll.style.height = '330px';
    for (const slot of slots) {
      const g = DOLL[slot]; if (!g) continue;
      const n = el('div', 'eq-slot clickable', this.doll);
      n.style.cssText += `left:${g[0]}px;top:${g[1]}px;width:${g[2]}px;height:${g[3]}px`;
      const ph = el('div', 'eq-ph', n); ph.textContent = SLOT_LABEL[slot] || slot;
      const cv = el('canvas', null, n); cv.style.display = 'none';
      cv.width = g[2] * DPR; cv.height = g[3] * DPR;
      n.addEventListener('pointerdown', (e) => this._grabEquip(e, slot));
      n.dataset.slot = slot;
      this.eqEls[slot] = { node: n, ph, canvas: cv };
    }
  }

  _buildGrid() {
    const inv = World.inventory;
    this.gc = inv?.grid?.cols || 12; this.gr = inv?.grid?.rows || 5;
    this.grid.style.gridTemplateColumns = `repeat(${this.gc}, ${CELL}px)`;
    this.grid.style.gridTemplateRows = `repeat(${this.gr}, ${CELL}px)`;
    this.grid.style.width = this.gc * CELL + 'px';
    this.grid.style.height = this.gr * CELL + 'px';
    this.grid.textContent = '';
    for (let i = 0; i < this.gc * this.gr; i++) el('div', 'inv-cell', this.grid);
    this.grid.addEventListener('pointerdown', (e) => this._grabGrid(e));
  }

  _iconKind(item) {
    const base = item.base || {};
    const s = (base.slot || '').replace(/[0-9]/g, '');
    if (item.stack || item.maxStack) return 'rune';
    return SLOT_ICON[base.slot] || SLOT_ICON[s] || 'rune';
  }

  _paintIcon(cv, item, w, h) {
    cv.width = Math.max(2, Math.round(w * DPR)); cv.height = Math.max(2, Math.round(h * DPR));
    const col = item.color != null ? hexCss(item.color) : rarityOf(item.rarity).color;
    drawIcon(cv.getContext('2d'), this._iconKind(item), col, Math.min(cv.width, cv.height));
  }

  // Rebuild grid item nodes + equip slots from World.inventory state.
  _rebuild() {
    const inv = World.inventory;
    if (this.gc !== (inv?.grid?.cols || 12) || this.gr !== (inv?.grid?.rows || 5)) this._buildGrid();

    // equipped paperdoll
    for (const slot in this.eqEls) {
      const e = this.eqEls[slot];
      const item = inv && inv.equip ? inv.equip[slot] : null;
      if (item) {
        e.ph.style.display = 'none'; e.canvas.style.display = 'block';
        const r = e.node.getBoundingClientRect();
        this._paintIcon(e.canvas, item, r.width, r.height);
        const col = item.color != null ? hexCss(item.color) : rarityOf(item.rarity).color;
        e.node.style.color = col; e.node.dataset.item = item.id;
      } else {
        e.ph.style.display = 'block'; e.canvas.style.display = 'none'; delete e.node.dataset.item;
      }
    }

    // bag items
    const items = inv && inv.items ? [...inv.items.values()] : [];
    const seen = new Set();
    for (const item of items) {
      if (item.x == null || item.y == null) continue;   // equipped/loose items skip the grid
      seen.add(item.id);
      let rec = this.itemEls.get(item.id);
      const w = (item.base?.w || 1) * CELL, h = (item.base?.h || 1) * CELL;
      if (!rec) {
        const node = el('div', 'inv-item clickable', this.grid);
        const canvas = el('canvas', null, node);
        const stack = el('div', 'stack', node);
        rec = { node, canvas, stack }; this.itemEls.set(item.id, rec);
        node.dataset.item = item.id;
      }
      rec.node.style.left = item.x * CELL + 'px';
      rec.node.style.top = item.y * CELL + 'px';
      rec.node.style.width = w + 'px'; rec.node.style.height = h + 'px';
      const col = item.color != null ? hexCss(item.color) : rarityOf(item.rarity).color;
      rec.node.style.color = col;
      this._paintIcon(rec.canvas, item, w, h);
      const n = item.stack || (World.inventory?.currency && item.base?.key && World.inventory.currency.get(item.base.key)?.count);
      rec.stack.textContent = (n && n > 1) ? n : '';
    }
    // remove stale
    for (const [id, rec] of this.itemEls) {
      if (!seen.has(id)) { rec.node.remove(); this.itemEls.delete(id); }
    }
    this._dirty = false;
  }

  // cheap change signature to catch external mutations while open
  _signature() {
    const inv = World.inventory; if (!inv) return 0;
    let s = (inv.items ? inv.items.size : 0) * 131;
    if (inv.grid && inv.grid.cells) { const c = inv.grid.cells; for (let i = 0; i < c.length; i += 7) s = (s + c[i] * (i + 1)) | 0; }
    if (inv.equip) for (const k in inv.equip) if (inv.equip[k]) s = (s + inv.equip[k].id) | 0;
    return s;
  }

  // ── Drag & drop ────────────────────────────────────────────────────────
  _itemById(id) { return World.inventory?.items?.get?.(id) || null; }

  _grabGrid(e) {
    const idEl = e.target.closest('.inv-item'); if (!idEl) return;
    const id = +idEl.dataset.item; const item = this._itemById(id); if (!item) return;
    if (e.button === 2) { e.preventDefault(); this._quickEquip(id); return; }
    const gr = this.grid.getBoundingClientRect();
    const grabCx = Math.floor((e.clientX - gr.left) / CELL) - item.x;
    const grabCy = Math.floor((e.clientY - gr.top) / CELL) - item.y;
    this._startDrag(item, idEl, e, grabCx, grabCy, null);
  }

  _grabEquip(e, slot) {
    const inv = World.inventory; const item = inv?.equip?.[slot]; if (!item) return;
    if (e.button === 2) { e.preventDefault(); inv.unequip?.(slot); this._dirty = true; this._rebuild(); return; }
    this._startDrag(item, this.eqEls[slot].node, e, 0, 0, slot);
  }

  _startDrag(item, sourceEl, e, gx, gy, fromSlot) {
    this._cancelDrag();
    this.tooltip.hide();
    const w = (item.base?.w || 1) * CELL, h = (item.base?.h || 1) * CELL;
    const ghost = el('div', 'inv-ghost', this.panel.parentElement);
    ghost.style.width = w + 'px'; ghost.style.height = h + 'px';
    const col = item.color != null ? hexCss(item.color) : rarityOf(item.rarity).color;
    ghost.style.color = col; ghost.style.boxShadow = `inset 0 0 0 1px ${col}`;
    const cv = el('canvas', null, ghost); this._paintIcon(cv, item, w, h);
    if (sourceEl) sourceEl.classList.add('dragging');
    const hi = el('div', 'place-hi', this.grid);
    hi.style.display = 'none';
    this.drag = { item, sourceEl, ghost, hi, gx, gy, fromSlot, w, h };
    this._dragMove(e);
    addEventListener('pointermove', this._onMove);
    addEventListener('pointerup', this._onUp);
  }

  _targetCell(e) {
    const gr = this.grid.getBoundingClientRect();
    const cx = Math.floor((e.clientX - gr.left) / CELL) - this.drag.gx;
    const cy = Math.floor((e.clientY - gr.top) / CELL) - this.drag.gy;
    const inGrid = e.clientX >= gr.left && e.clientX <= gr.right && e.clientY >= gr.top && e.clientY <= gr.bottom;
    return { cx, cy, inGrid };
  }

  _equipSlotAt(e) {
    for (const slot in this.eqEls) {
      const r = this.eqEls[slot].node.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return slot;
    }
    return null;
  }

  _dragMove(e) {
    const d = this.drag; if (!d) return;
    d.ghost.style.transform = `translate(${e.clientX - d.w / 2}px,${e.clientY - d.h / 2}px)`;

    // clear equip highlights
    for (const s in this.eqEls) this.eqEls[s].node.classList.remove('hi', 'bad');

    const eqSlot = this._equipSlotAt(e);
    if (eqSlot) {
      d.hi.style.display = 'none';
      const ok = this._slotFits(d.item, eqSlot);
      this.eqEls[eqSlot].node.classList.add(ok ? 'hi' : 'bad');
      return;
    }
    const { cx, cy, inGrid } = this._targetCell(e);
    if (!inGrid) { d.hi.style.display = 'none'; return; }
    const inv = World.inventory;
    const w = (d.item.base?.w || 1), h = (d.item.base?.h || 1);
    let ok = cx >= 0 && cy >= 0 && cx + w <= this.gc && cy + h <= this.gr;
    if (ok && inv && typeof inv.canPlace === 'function') {
      try { ok = inv.canPlace(d.item.id ?? d.item, cx, cy, d.item.id); } catch (_) { /* keep bounds result */ }
    }
    d.hi.style.display = 'block';
    d.hi.className = 'place-hi ' + (ok ? 'ok' : 'bad');
    d.hi.style.left = cx * CELL + 'px'; d.hi.style.top = cy * CELL + 'px';
    d.hi.style.width = w * CELL + 'px'; d.hi.style.height = h * CELL + 'px';
  }

  _slotFits(item, slot) {
    const inv = World.inventory;
    const base = (item.base?.slot || '').toLowerCase();
    if (!base) return true;
    if (base === 'ring') return slot === 'ring1' || slot === 'ring2';
    if (base === 'flask') return /^flask/.test(slot);
    return slot === base || (inv?.equip && slot in inv.equip && slot.replace(/[0-9]/g, '') === base);
  }

  _dragEnd(e) {
    const d = this.drag; if (!d) return;
    removeEventListener('pointermove', this._onMove);
    removeEventListener('pointerup', this._onUp);
    const inv = World.inventory;
    let handled = false;

    const eqSlot = this._equipSlotAt(e);
    if (eqSlot && this._slotFits(d.item, eqSlot) && inv?.equipItem) {
      handled = !!inv.equipItem(d.item.id, eqSlot);
    } else if (!eqSlot) {
      const { cx, cy, inGrid } = this._targetCell(e);
      if (inGrid && inv) {
        // stack onto an item already at the drop point?
        const under = this._itemAtCell(cx + d.gx, cy + d.gy, d.item.id);
        if (under && inv.stack && this._stackable(d.item, under)) {
          handled = !!inv.stack(d.item.id, under.id);
        } else if (d.fromSlot && inv.unequip && inv.place) {
          // moving an equipped item back to the bag
          if (inv.canPlace ? inv.canPlace(d.item.id ?? d.item, cx, cy) : true) {
            inv.unequip(d.fromSlot); handled = !!inv.place(d.item.id, cx, cy);
          }
        } else if (inv.move) {
          handled = !!inv.move(d.item.id, cx, cy);
        }
      }
    }

    this._cancelDrag();
    this._dirty = true; this._rebuild();
    if (!handled) { /* invalid drop — state unchanged, DOM already restored by rebuild */ }
  }

  _itemAtCell(cx, cy, ignoreId) {
    const inv = World.inventory; if (!inv?.items) return null;
    for (const it of inv.items.values()) {
      if (it.id === ignoreId || it.x == null) continue;
      const w = it.base?.w || 1, h = it.base?.h || 1;
      if (cx >= it.x && cx < it.x + w && cy >= it.y && cy < it.y + h) return it;
    }
    return null;
  }

  _stackable(a, b) {
    return (a.maxStack > 1 || b.maxStack > 1) && a.base?.key && a.base.key === b.base?.key;
  }

  _quickEquip(id) {
    const inv = World.inventory; if (!inv?.equipItem) return;
    if (inv.equipItem(id)) { this._dirty = true; this._rebuild(); }
  }

  _cancelDrag() {
    const d = this.drag; if (!d) return;
    d.ghost?.remove(); d.hi?.remove();
    d.sourceEl?.classList.remove('dragging');
    for (const s in this.eqEls) this.eqEls[s].node.classList.remove('hi', 'bad');
    this.drag = null;
  }

  // hover tooltips + periodic external-change refresh
  frame(dt) {
    if (!this.open) return;
    this._sigAcc += dt;
    if (this._sigAcc > 0.25) {
      this._sigAcc = 0;
      const sig = this._signature();
      if (this._dirty || sig !== this._sig) { this._sig = sig; this._rebuild(); }
    }
  }

  // called by hud on cursor move when inventory is open
  hover(e) {
    if (!this.open || this.drag) { if (this.drag) this.tooltip.hide(); return; }
    let id = null, rect = null;
    const itemEl = e.target.closest && e.target.closest('.inv-item');
    if (itemEl) { id = +itemEl.dataset.item; rect = itemEl.getBoundingClientRect(); }
    else {
      const slotEl = e.target.closest && e.target.closest('.eq-slot');
      if (slotEl && slotEl.dataset.item) { id = +slotEl.dataset.item; rect = slotEl.getBoundingClientRect(); }
    }
    if (id != null) {
      const item = this._itemById(id) || this._equippedById(id);
      if (item) { this.tooltip.show(item, { x: rect.left, y: rect.top, w: rect.width, h: rect.height }); return; }
    }
    this.tooltip.hide();
  }

  _equippedById(id) {
    const inv = World.inventory; if (!inv?.equip) return null;
    for (const s in inv.equip) if (inv.equip[s] && inv.equip[s].id === id) return inv.equip[s];
    return null;
  }

  dispose() { removeEventListener('keydown', this._onKey); this._offPick?.(); }
}

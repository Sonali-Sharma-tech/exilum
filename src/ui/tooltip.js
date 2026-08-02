// Item tooltip — PoE-style. Renders LootSystem's describe(item) output:
// rarity-coloured header, base type, item level, an implicit block separated by
// a divider, then prefixes/suffixes, requirements at the bottom. Follows the
// cursor, flips at screen edges, never clips off-screen.
import { World } from '../core/world.js';
import { el, rarityOf, hexCss } from './theme.js';

export class Tooltip {
  constructor(root) {
    this.node = el('div', null, root); this.node.id = 'tooltip';
    this.head = el('div', 'tt-head', this.node);
    this.base = el('div', 'tt-base', this.node);
    this.body = el('div', 'tt-body', this.node);
    this.shown = false;
    this.item = null;
    this.x = 0; this.y = 0;
    this.anchor = null;   // optional {x,y,w,h} element rect to attach to (inventory)
  }

  // Resolve item → structured description via LootSystem, defensively.
  _describe(item) {
    const inv = World.inventory;
    if (inv && typeof inv.describe === 'function') { try { return inv.describe(item); } catch (e) { /* fall through */ } }
    // Fallback: build lines from the item's own precomputed fields (no affix logic here).
    const lines = [];
    lines.push({ kind: 'name', text: item.name || item.base?.name || 'Unknown', color: hexCss(item.color) });
    if (item.base?.name && item.base.name !== item.name) lines.push({ kind: 'base', text: item.base.name });
    for (const im of item.implicits || []) lines.push({ kind: 'implicit', text: im.text || im });
    const mods = [...(item.prefixes || []), ...(item.suffixes || [])];
    if (mods.length) { lines.push({ kind: 'sep' }); for (const m of mods) lines.push({ kind: 'prefix', text: m.text || m }); }
    if (item.req) {
      const parts = [];
      if (item.req.level) parts.push(`Level ${item.req.level}`);
      if (item.req.str) parts.push(`${item.req.str} Str`);
      if (item.req.dex) parts.push(`${item.req.dex} Dex`);
      if (item.req.int) parts.push(`${item.req.int} Int`);
      if (parts.length) { lines.push({ kind: 'sep' }); lines.push({ kind: 'req', text: 'Requires ' + parts.join(', ') }); }
    }
    return {
      name: item.name || item.base?.name, color: item.color,
      rarity: item.rarity, base: item.base?.name, ilvl: item.ilvl, lines,
    };
  }

  show(item, anchorRect) {
    if (!item) return this.hide();
    if (item === this.item && this.shown) { this.anchor = anchorRect || this.anchor; return; }
    this.item = item;
    this.anchor = anchorRect || null;
    const d = this._describe(item) || {};
    const rc = d.color != null ? hexCss(d.color) : (rarityOf(d.rarity || item.rarity).color);

    // Header
    this.head.textContent = d.name || item.name || 'Item';
    this.head.style.color = rc;
    this.head.style.textShadow = `0 0 10px ${rc}55, 0 1px 2px #000`;
    this.head.style.fontVariant = 'small-caps';

    // Base + ilvl subline
    const baseName = d.base || item.base?.name || '';
    const ilvl = d.ilvl ?? item.ilvl;
    this.base.textContent = baseName + (ilvl != null ? `   ·   Item Level ${ilvl}` : '');
    this.base.style.display = baseName || ilvl != null ? 'block' : 'none';

    // Body from lines[] (preferred). Rebuild once per item (not per frame).
    this.body.textContent = '';
    const lines = d.lines || [];
    for (const ln of lines) {
      if (ln.kind === 'name' || ln.kind === 'base') continue; // shown in head/subline
      if (ln.kind === 'sep') { el('div', 'tt-sep', this.body); continue; }
      const row = el('div', `tt-line ${ln.kind || ''}`, this.body);
      row.textContent = ln.text || '';
      if (ln.color != null) row.style.color = typeof ln.color === 'number' ? hexCss(ln.color) : ln.color;
    }
    // rarity footer stamp
    const foot = el('div', 'tt-sub', this.body);
    foot.textContent = rarityOf(d.rarity || item.rarity).name;

    this.node.style.display = 'block';
    this.node.style.borderColor = '#000';
    this.node.style.boxShadow = `inset 0 0 0 1px ${rc}44, 0 8px 30px rgba(0,0,0,.85)`;
    this.shown = true;
    this._reposition();
    // fade in via opacity only
    requestAnimationFrame(() => { this.node.style.opacity = '1'; });
  }

  hide() {
    if (!this.shown) return;
    this.shown = false; this.item = null; this.anchor = null;
    this.node.style.opacity = '0';
    this.node.style.display = 'none';
  }

  setCursor(x, y) { this.x = x; this.y = y; if (this.shown && !this.anchor) this._reposition(); }

  _reposition() {
    const n = this.node;
    const w = n.offsetWidth || 240, h = n.offsetHeight || 160;
    const vw = window.innerWidth, vh = window.innerHeight, pad = 12;
    let px, py;
    if (this.anchor) {
      // attach beside an inventory cell; flip left if it would clip right
      const a = this.anchor;
      px = a.x + a.w + 10;
      if (px + w > vw - pad) px = a.x - w - 10;
      if (px < pad) px = pad;
      py = a.y;
    } else {
      px = this.x + 18; py = this.y + 18;
      if (px + w > vw - pad) px = this.x - w - 18;   // flip horizontally
      if (py + h > vh - pad) py = this.y - h - 6;    // flip vertically
    }
    py = Math.max(pad, Math.min(py, vh - h - pad));
    px = Math.max(pad, Math.min(px, vw - w - pad));
    n.style.transform = `translate(${px}px,${py}px)`;
  }
}

// EXILIUM — loot orchestrator: physics-tossed drops, ground labels, pickup,
// loot beams, and the grid inventory data model. Owner: LootSystem.
//
// PoE's core dopamine loop: the drop arcs out of the corpse, settles with a
// bounce, plants a rarity-coloured label + beam, and the pickup is a small
// event with sound, VFX, and (for rares) a camera kick. Loot tokens are
// SELF-EMISSIVE — in a world that is a bright island inside darkness, the loot
// IS a motivated light source, and saturation here is rubric-sanctioned (§2/§7).

import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { Input } from '../core/input.js';
import { spawnRigidBody } from '../core/physics.js';
import {
  RARITY, generateItem, generateUnique, generateCurrency, describeItem, rarityColor, rarityCss,
} from './items.js';

// ---------------------------------------------------------------------------
// Local tunables (config.js is core-owned; loot keeps its own knobs here).
// ---------------------------------------------------------------------------
const LCFG = {
  maxDrops: 56,             // hard cap on live ground drops (recycle oldest)
  pickupRadius: 2.2,        // auto-pickup radius for currency
  clickReach: 6.5,          // max distance to click-pickup gear
  gravity: 22,              // fallback ballistic gravity (m/s^2)
  restitution: 0.42,        // bounce energy retained
  tossSpeed: 3.4,           // initial outward+up speed
  tossSpread: 2.2,          // horizontal scatter radius around corpse
  settleVel: 0.5,           // speed below which fallback drop sleeps
  pickableDelay: 0.22,      // seconds before a drop can be picked (let it arc)
  labelCull: 46,            // world distance beyond which labels hide (non-Alt)
  labelFadeStart: 22,       // distance where label opacity begins to fall
  crystalLift: 0.26,        // gem centre height above token origin
  grid: { cols: 12, rows: 5 },
};

// ---------------------------------------------------------------------------
// Module-scope temporaries — ZERO allocation in per-frame hot loops.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _proj = new THREE.Vector3();

let scene = null;
let camera = null;

// ===========================================================================
// SHARED PROCEDURAL TEXTURES (built once).
// ===========================================================================
function makeGlowTexture() {
  const s = 128;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeRingTexture() {
  const s = 128;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.14, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.92, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let GLOW_TEX = null;
let RING_TEX = null;

// A small faceted gem — an elongated bipyramid catches light like a cut stone.
let GEM_GEO = null;
function makeGemGeometry() {
  const g = new THREE.OctahedronGeometry(0.2, 0);
  g.scale(0.8, 1.35, 0.8);
  g.computeVertexNormals();
  return g;
}

// ===========================================================================
// TOKEN POOL — each token = { group, gem, gemMat, glow, glowMat, ring, ringMat }
// ===========================================================================
const tokenPool = [];
function buildToken() {
  const group = new THREE.Group();
  group.visible = false;

  const gemMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c, emissive: 0xffffff, emissiveIntensity: 2.2,
    roughness: 0.28, metalness: 0.35,
  });
  const gem = new THREE.Mesh(GEM_GEO, gemMat);
  gem.position.y = LCFG.crystalLift;
  gem.castShadow = false; gem.receiveShadow = false;
  group.add(gem);

  const glowMat = new THREE.SpriteMaterial({
    map: GLOW_TEX, color: 0xffffff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.9,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(1.15, 1.15, 1.15);
  glow.position.y = LCFG.crystalLift;
  group.add(glow);

  // Ground ring lives in the SCENE (not the group) so it stays flat while the
  // token tumbles under physics. Positioned each frame beneath the token.
  const ringMat = new THREE.MeshBasicMaterial({
    map: RING_TEX, color: 0xffffff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.5, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;

  scene.add(group);
  scene.add(ring);
  const tok = { group, gem, gemMat, glow, glowMat, ring, ringMat, inUse: false };
  tokenPool.push(tok);
  return tok;
}
function acquireToken() {
  for (const t of tokenPool) if (!t.inUse) { t.inUse = true; return t; }
  const t = buildToken(); t.inUse = true; return t;
}
function releaseToken(t) {
  t.inUse = false;
  t.group.visible = false;
  t.ring.visible = false;
}

// ===========================================================================
// LABEL POOL — DOM nodes inside our own container in #ui-root.
// ===========================================================================
let labelContainer = null;
const labelPool = [];
function injectStyles() {
  if (document.getElementById('loot-label-styles')) return;
  const st = document.createElement('style');
  st.id = 'loot-label-styles';
  st.textContent = `
  #loot-labels { position:absolute; inset:0; pointer-events:none;
    font-family:"Cinzel","Trajan Pro",Georgia,serif; z-index:12; }
  #loot-labels .ll { position:absolute; transform:translate(-50%,-50%);
    pointer-events:auto; cursor:pointer; white-space:nowrap; user-select:none;
    padding:2px 9px; border-radius:2px; letter-spacing:.02em; text-align:center;
    background:linear-gradient(180deg,rgba(6,7,10,.82),rgba(6,7,10,.66));
    border:1px solid rgba(0,0,0,.6); box-shadow:0 1px 4px rgba(0,0,0,.7);
    transition:opacity .08s linear; will-change:transform,opacity; }
  #loot-labels .ll .n { display:block; font-weight:600; line-height:1.15;
    text-shadow:0 1px 2px #000,0 0 3px #000; }
  #loot-labels .ll .st { font-weight:400; opacity:.85; }
  #loot-labels .ll.beam { border-color:currentColor; }
  #loot-labels .ll.beam .n { text-shadow:0 0 6px currentColor,0 1px 2px #000; }
  #loot-labels .ll.hi { outline:1px solid rgba(255,255,255,.55); }`;
  document.head.appendChild(st);
}
function buildLabel() {
  const el = document.createElement('div');
  el.className = 'll';
  const n = document.createElement('span'); n.className = 'n';
  el.appendChild(n);
  el.style.display = 'none';
  el._name = n;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (el._drop) tryPickup(el._drop, true);
  });
  labelContainer.appendChild(el);
  labelPool.push(el);
  return el;
}
function acquireLabel() {
  for (const el of labelPool) if (!el._busy) { el._busy = true; el.style.display = ''; return el; }
  const el = buildLabel(); el._busy = true; el.style.display = ''; return el;
}
function releaseLabel(el) {
  el._busy = false; el._drop = null; el.style.display = 'none';
}

// ===========================================================================
// DROPS
// ===========================================================================
const drops = [];   // active ground drops

function borderColorFor(item) {
  // Slightly darkened rarity colour reads as a bezel; currency uses its tint.
  return item.css;
}

function spawnItemDrop(item, pos) {
  if (drops.length >= LCFG.maxDrops) {
    // Recycle the oldest un-picked drop to keep the field bounded.
    const oldest = drops.shift();
    if (oldest) destroyDrop(oldest, false);
  }

  const tok = acquireToken();
  const col = new THREE.Color(item.currencyKey ? (item.tint ?? item.color) : item.color);

  // Rarity-tuned emissive glow — brighter for rarer, currency has a warm tan.
  const glowMul = item.rarity === 'unique' ? 3.1
    : item.rarity === 'rare' ? 2.6
    : item.rarity === 'magic' ? 2.1
    : item.rarity === 'currency' ? 2.0 : 1.7;
  tok.gemMat.emissive.copy(col);
  tok.gemMat.emissiveIntensity = glowMul;
  tok.glowMat.color.copy(col);
  tok.glowMat.opacity = item.rarity === 'normal' ? 0.55 : 0.85;
  tok.ringMat.color.copy(col);
  tok.ringMat.opacity = item.rarity === 'normal' ? 0.28 : 0.5;
  const gemScale = item.rarity === 'unique' ? 1.35 : item.rarity === 'rare' ? 1.2 : 1.0;
  tok.gem.scale.setScalar(gemScale);
  tok.glow.scale.setScalar(1.15 * gemScale);
  tok.ring.scale.setScalar(item.rarity === 'normal' ? 0.7 : item.rarity === 'rare' || item.rarity === 'unique' ? 1.15 : 0.9);

  // Landing target: a walkable scatter point around the corpse.
  const ground = (x, z) => World.level?.heightAt ? World.level.heightAt(x, z) : 0;
  const ang = Math.random() * Math.PI * 2;
  const rad = LCFG.tossSpread * (0.35 + Math.random() * 0.65);
  let tx = pos.x + Math.cos(ang) * rad;
  let tz = pos.z + Math.sin(ang) * rad;
  if (World.level?.walkable && !World.level.walkable(tx, tz)) { tx = pos.x; tz = pos.z; }

  const startY = (pos.y ?? ground(pos.x, pos.z)) + 0.6;
  tok.group.position.set(pos.x, startY, pos.z);
  tok.group.rotation.set(0, Math.random() * Math.PI * 2, 0);
  tok.group.visible = true;
  tok.ring.visible = true;

  // Initial toss velocity: outward + up, biased toward landing target.
  const dx = tx - pos.x, dz = tz - pos.z;
  const dl = Math.hypot(dx, dz) || 1;
  const vel = new THREE.Vector3(
    (dx / dl) * LCFG.tossSpeed * 0.6 + (Math.random() - 0.5),
    LCFG.tossSpeed * (0.9 + Math.random() * 0.4),
    (dz / dl) * LCFG.tossSpeed * 0.6 + (Math.random() - 0.5),
  );

  // Hand off to the real physics engine when available; else ballistic fallback.
  let handle = null;
  try {
    handle = spawnRigidBody({
      mesh: tok.group, pos: tok.group.position, vel,
      angVel: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4),
      radius: 0.22, restitution: LCFG.restitution, friction: 0.7, persistent: true, ttl: 0,
    });
  } catch (_) { handle = null; }

  const drop = {
    item, tok, handle,
    // Fallback ballistic state (only used when handle is null).
    fb: handle ? null : { vel, settled: false, spin: (Math.random() - 0.5) * 3 },
    age: 0, pickable: false, picked: false,
    beamed: false, label: null, screenY: 0,
  };
  drops.push(drop);

  bus.emit(EV.LOOT_DROP, { pos: tok.group.position.clone(), tier: item.rarity });
  bus.emit(EV.SFX_PLAY, { id: item.currencyKey ? 'loot_currency' : 'loot_drop', pos: tok.group.position.clone(), gain: 0.7 });
  return drop;
}

function emitBeam(drop) {
  if (drop.beamed) return;
  if (drop.item.rarity !== 'rare' && drop.item.rarity !== 'unique') return;
  drop.beamed = true;
  bus.emit(EV.VFX_SPAWN, {
    kind: 'lootBeam',
    pos: drop.tok.group.position.clone(),
    color: drop.item.color,
    scale: drop.item.rarity === 'unique' ? 1.35 : 1.0,
  });
}

function destroyDrop(drop, picked) {
  drop.picked = picked;
  if (drop.handle?.remove) { try { drop.handle.remove(); } catch (_) {} }
  releaseToken(drop.tok);
  if (drop.label) { releaseLabel(drop.label); drop.label = null; }
  const i = drops.indexOf(drop);
  if (i >= 0) drops.splice(i, 1);
}

// ===========================================================================
// DROP TABLES — rarity weights + counts scale with monster tier.
// Rares/bosses drop meaningfully better loot; rares stay genuinely uncommon.
// ===========================================================================
const DROP_TABLES = {
  normal: { drops: [0, 0, 0, 1], currency: 0.10, ilvlBonus: 0,
    rarity: { normal: 78, magic: 19, rare: 3, unique: 0 } },
  magic:  { drops: [0, 1, 1, 2], currency: 0.28, ilvlBonus: 1,
    rarity: { normal: 62, magic: 30, rare: 8, unique: 0 } },
  rare:   { drops: [1, 2, 2, 3], currency: 0.6, ilvlBonus: 2,
    rarity: { normal: 40, magic: 40, rare: 19, unique: 1 } },
  unique: { drops: [2, 3, 3, 4], currency: 0.85, ilvlBonus: 3,
    rarity: { normal: 26, magic: 44, rare: 28, unique: 2 } },
  boss:   { drops: [4, 5, 5, 6], currency: 1.0, ilvlBonus: 5,
    rarity: { normal: 8, magic: 40, rare: 46, unique: 6 } },
};
function pickWeighted(weights) {
  let total = 0; for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return 'normal';
}
function pickCount(arr) { return arr[(Math.random() * arr.length) | 0]; }

function monsterTier(entity) {
  if (!entity) return 'normal';
  if (entity.isBoss) return 'boss';
  const r = entity.rarity;
  if (r === 'unique') return 'boss';       // non-boss uniques still drop rich
  if (r === 'rare' || r === 'magic' || r === 'normal') return r;
  // Heuristic fallback if AI didn't stamp rarity: toughness proxy.
  const hp = entity.maxHp || 0;
  if (hp >= 4000) return 'boss';
  if (hp >= 900) return 'rare';
  if (hp >= 260) return 'magic';
  return 'normal';
}

function rollDrops(entity, pos) {
  const table = DROP_TABLES[monsterTier(entity)] || DROP_TABLES.normal;
  const baseIlvl = Math.max(1, (World.stats?.level || 1) + table.ilvlBonus + ((Math.random() * 3 - 1) | 0));

  const n = pickCount(table.drops);
  for (let i = 0; i < n; i++) {
    const rk = pickWeighted(table.rarity);
    let item;
    if (rk === 'unique') item = generateUnique(baseIlvl);
    else item = generateItem({ ilvl: baseIlvl, rarity: rk });
    spawnItemDrop(item, pos);
  }
  // Currency roll (independent of the gear count).
  if (Math.random() < table.currency) {
    const isBoss = table === DROP_TABLES.boss;
    const cnt = isBoss ? 1 + ((Math.random() * 3) | 0) : (Math.random() < 0.2 ? 2 : 1);
    spawnItemDrop(generateCurrency(null, cnt), pos);
  }
}

// ===========================================================================
// PICKUP
// ===========================================================================
function playerPos() { return World.player?.pos || null; }

function tryPickup(drop, fromClick) {
  if (!drop || drop.picked || !drop.pickable) return false;
  const pp = playerPos();
  if (pp) {
    const d = Math.hypot(drop.tok.group.position.x - pp.x, drop.tok.group.position.z - pp.z);
    const reach = fromClick ? LCFG.clickReach : LCFG.pickupRadius;
    if (d > reach) {
      if (fromClick) bus.emit(EV.UI_TOAST, { text: 'Out of range', tier: 'normal', color: rarityColor('normal') });
      return false;
    }
  }
  const item = drop.item;
  const ok = Inventory.add(item);
  if (!ok) {
    bus.emit(EV.UI_TOAST, { text: 'Inventory full', tier: 'normal', color: rarityColor('normal') });
    return false;
  }

  // Feedback: toast + sfx + pickup VFX flourish. Rare/unique get a camera kick.
  const tier = item.rarity;
  const label = item.currencyKey && item.stack > 1 ? `${item.name} x${item.stack}` : item.name;
  bus.emit(EV.LOOT_PICKUP, { item });
  bus.emit(EV.UI_TOAST, { text: label, tier, color: item.color });
  const sfx = item.currencyKey ? 'loot_currency'
    : tier === 'unique' ? 'loot_pickup_unique'
    : tier === 'rare' ? 'loot_pickup_rare' : 'loot_pickup_common';
  bus.emit(EV.SFX_PLAY, { id: sfx, pos: drop.tok.group.position.clone(), gain: 0.85 });
  bus.emit(EV.VFX_SPAWN, { kind: 'lootPickup', pos: drop.tok.group.position.clone(), color: item.color });
  if (tier === 'rare' || tier === 'unique') {
    bus.emit(EV.CAMERA_SHAKE, tier === 'unique' ? 0.16 : 0.1);
  }

  destroyDrop(drop, true);
  return true;
}

// ===========================================================================
// INVENTORY DATA MODEL — grid + equip slots + currency, server-authoritative.
// World.inventory exposes read state + mutation helpers for UIHud to render.
// ===========================================================================
const EQUIP_SLOTS = ['weapon', 'offhand', 'helm', 'body', 'gloves', 'boots', 'belt', 'amulet',
  'ring1', 'ring2', 'flask1', 'flask2', 'flask3', 'flask4', 'flask5'];

const Inventory = {
  grid: { cols: LCFG.grid.cols, rows: LCFG.grid.rows, cells: new Int32Array(LCFG.grid.cols * LCFG.grid.rows) },
  items: new Map(),        // id -> item (bag only)
  equip: {},               // slot -> item|null
  currency: new Map(),     // currencyKey -> { item, count } (active stack ref)

  _idx(x, y) { return y * this.grid.cols + x; },
  _fits(item) { const b = item.base; return { w: b.w || 1, h: b.h || 1 }; },

  canPlace(idOrItem, x, y, ignoreId = 0) {
    const target = (idOrItem && idOrItem.base) ? idOrItem : this.items.get(idOrItem);
    if (!target) return false;
    const { w, h } = this._fits(target);
    if (x < 0 || y < 0 || x + w > this.grid.cols || y + h > this.grid.rows) return false;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
      const occ = this.grid.cells[this._idx(x + dx, y + dy)];
      if (occ !== 0 && occ !== ignoreId && occ !== target.id) return false;
    }
    return true;
  },

  _stamp(item, x, y, val) {
    const { w, h } = this._fits(item);
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.grid.cells[this._idx(x + dx, y + dy)] = val;
  },

  _findFree(item) {
    const { w, h } = this._fits(item);
    for (let y = 0; y + h <= this.grid.rows; y++)
      for (let x = 0; x + w <= this.grid.cols; x++)
        if (this.canPlace(item, x, y)) return { x, y };
    return null;
  },

  place(id, x, y) {
    const item = this.items.get(id);
    if (!item) return false;
    if (!this.canPlace(item, x, y, id)) return false;
    if (item.x >= 0) this._stamp(item, item.x, item.y, 0);
    this._stamp(item, x, y, item.id);
    item.x = x; item.y = y;
    return true;
  },
  move(id, x, y) { return this.place(id, x, y); },

  add(item) {
    // Currency merges into an existing stack of the same key when possible.
    if (item.currencyKey) {
      let remaining = item.stack || 1;
      for (const other of this.items.values()) {
        if (other.currencyKey !== item.currencyKey) continue;
        const room = other.maxStack - other.stack;
        if (room <= 0) continue;
        const moved = Math.min(room, remaining);
        other.stack += moved; remaining -= moved;
        this.currency.set(item.currencyKey, { item: other, count: other.stack });
        if (remaining <= 0) return true;
      }
      if (remaining <= 0) return true;
      item.stack = remaining;
    }
    const spot = this._findFree(item);
    if (!spot) return false;
    this.items.set(item.id, item);
    this._stamp(item, spot.x, spot.y, item.id);
    item.x = spot.x; item.y = spot.y;
    if (item.currencyKey) this.currency.set(item.currencyKey, { item, count: item.stack });
    return true;
  },

  _slotFor(item) {
    const s = item.slot;
    if (s === 'ring') return this.equip.ring1 ? (this.equip.ring2 ? 'ring1' : 'ring2') : 'ring1';
    if (s === 'flask') { for (let i = 1; i <= 5; i++) if (!this.equip['flask' + i]) return 'flask' + i; return 'flask1'; }
    if (s === 'weapon') return 'weapon';
    if (s === 'offhand') return 'offhand';
    return EQUIP_SLOTS.includes(s) ? s : null;
  },

  equipItem(id, slot = null) {
    const item = this.items.get(id);
    if (!item) return false;
    const dst = slot || this._slotFor(item);
    if (!dst || !EQUIP_SLOTS.includes(dst)) return false;
    // Remove from bag grid.
    if (item.x >= 0) this._stamp(item, item.x, item.y, 0);
    this.items.delete(item.id);
    item.x = -1; item.y = -1;
    // Swap out whatever was equipped back into the bag.
    const prev = this.equip[dst] || null;
    this.equip[dst] = item;
    if (prev) { const spot = this._findFree(prev); if (spot) { this.items.set(prev.id, prev); this._stamp(prev, spot.x, spot.y, prev.id); prev.x = spot.x; prev.y = spot.y; } }
    return true;
  },

  unequip(slot) {
    const item = this.equip[slot];
    if (!item) return false;
    const spot = this._findFree(item);
    if (!spot) return false;
    this.equip[slot] = null;
    this.items.set(item.id, item);
    this._stamp(item, spot.x, spot.y, item.id);
    item.x = spot.x; item.y = spot.y;
    return true;
  },

  stack(srcId, dstId) {
    const a = this.items.get(srcId), b = this.items.get(dstId);
    if (!a || !b || !a.currencyKey || a.currencyKey !== b.currencyKey) return false;
    const room = b.maxStack - b.stack;
    if (room <= 0) return false;
    const moved = Math.min(room, a.stack);
    b.stack += moved; a.stack -= moved;
    if (a.stack <= 0) { this._stamp(a, a.x, a.y, 0); this.items.delete(a.id); }
    this.currency.set(b.currencyKey, { item: b, count: b.stack });
    return true;
  },

  drop(id) {
    const item = this.items.get(id) || Object.values(this.equip).find((e) => e && e.id === id);
    if (!item) return false;
    if (item.x >= 0) this._stamp(item, item.x, item.y, 0);
    this.items.delete(item.id);
    for (const s of EQUIP_SLOTS) if (this.equip[s]?.id === item.id) this.equip[s] = null;
    if (item.currencyKey && this.currency.get(item.currencyKey)?.item === item) this.currency.delete(item.currencyKey);
    item.x = -1; item.y = -1;
    const pp = playerPos();
    if (pp) spawnItemDrop(item, _v.set(pp.x, pp.y + 0.4, pp.z));
    return true;
  },

  describe(item) { return describeItem(item); },
};
// Public wrapper aligning method names with the locked UIHud contract.
World.inventory = {
  grid: Inventory.grid,
  items: Inventory.items,
  equip: Inventory.equip,        // slot -> item|null (renderer reads this)
  currency: Inventory.currency,
  slots: EQUIP_SLOTS,
  place: (id, x, y) => Inventory.place(id, x, y),
  move: (id, x, y) => Inventory.move(id, x, y),
  canPlace: (id, x, y, ignoreId) => Inventory.canPlace(id, x, y, ignoreId),
  equipItem: (id, slot) => Inventory.equipItem(id, slot),   // action (equip is the slots data above)
  unequip: (slot) => Inventory.unequip(slot),
  stack: (a, b) => Inventory.stack(a, b),
  drop: (id) => Inventory.drop(id),
  add: (item) => Inventory.add(item),
  describe: (item) => Inventory.describe(item),
};

// ===========================================================================
// LABEL LAYOUT — project, cull, distance-fade, collision-offset, Alt-show-all.
// ===========================================================================
const _visible = [];   // reused scratch for label collision pass
const _bySy = (a, b) => a._sy - b._sy;   // hoisted comparator (no per-frame closure)

function projectToScreen(pos3, out) {
  _proj.copy(pos3).project(camera);
  if (_proj.z > 1) return false;   // behind camera
  out.x = (_proj.x * 0.5 + 0.5) * innerWidth;
  out.y = (-_proj.y * 0.5 + 0.5) * innerHeight;
  return true;
}
const _scr = { x: 0, y: 0 };

function updateLabels() {
  const altHeld = Input.down('alt') || Input.down('altgraph');
  const pp = playerPos();
  _visible.length = 0;

  for (const drop of drops) {
    // Anchor the label just above the gem.
    _v2.copy(drop.tok.group.position); _v2.y += LCFG.crystalLift + 0.55;
    const onScreen = projectToScreen(_v2, _scr);
    let dist = Infinity;
    if (pp) dist = Math.hypot(drop.tok.group.position.x - pp.x, drop.tok.group.position.z - pp.z);

    if (!onScreen || (!altHeld && dist > LCFG.labelCull)) {
      if (drop.label) { releaseLabel(drop.label); drop.label = null; }
      continue;
    }
    if (!drop.label) {
      drop.label = acquireLabel();
      const item = drop.item;
      const stackTxt = item.currencyKey && item.stack > 1 ? ` <span class="st">x${item.stack}</span>` : '';
      drop.label._name.innerHTML = item.name + stackTxt;
      drop.label.style.color = item.css;
      const beam = item.rarity === 'rare' || item.rarity === 'unique';
      drop.label.className = 'll' + (beam ? ' beam' : '');
      drop.label._drop = drop;
    }
    drop._sx = _scr.x; drop._sy = _scr.y; drop._dist = dist;
    _visible.push(drop);
  }

  // Distance-based scale + opacity; nearest reachable gets a highlight ring.
  let nearest = null, nearD = LCFG.clickReach;
  for (const drop of _visible) {
    if (drop._dist < nearD && drop.pickable) { nearD = drop._dist; nearest = drop; }
  }

  // Collision offsetting: sort top-to-bottom, push overlaps downward.
  _visible.sort(_bySy);
  const LH = 26; // approx label height incl. gap
  for (let i = 0; i < _visible.length; i++) {
    const drop = _visible[i];
    let y = drop._sy;
    for (let j = 0; j < i; j++) {
      const o = _visible[j];
      if (Math.abs(o._sx - drop._sx) < 120 && y - o._layY < LH) y = o._layY + LH;
    }
    drop._layY = y;

    const el = drop.label;
    const altHeldNow = altHeld;
    let op = 1;
    if (!altHeldNow) {
      if (drop._dist > LCFG.labelFadeStart) {
        const t = (drop._dist - LCFG.labelFadeStart) / (LCFG.labelCull - LCFG.labelFadeStart);
        op = 1 - Math.min(1, t) * 0.72;
      }
    }
    const scale = Math.max(0.72, Math.min(1.12, 1.28 - drop._dist * 0.016));
    el.style.opacity = op.toFixed(3);
    el.style.left = drop._sx.toFixed(1) + 'px';
    el.style.top = y.toFixed(1) + 'px';
    el.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(3)})`;
    el.style.fontSize = drop.item.rarity === 'unique' || drop.item.rarity === 'rare' ? '14px' : '12.5px';
    if (nearest === drop) el.classList.add('hi'); else el.classList.remove('hi');
  }
}

// ===========================================================================
// FALLBACK BALLISTICS — only runs for drops whose handle is null.
// ===========================================================================
function stepFallback(drop, dt) {
  const fb = drop.fb;
  if (fb.settled) return;
  const g = drop.tok.group;
  const p = g.position;
  fb.vel.y -= LCFG.gravity * dt;
  const nx = p.x + fb.vel.x * dt;
  const nz = p.z + fb.vel.z * dt;
  // Wall guard: if the next horizontal step leaves walkable ground, bounce back.
  if (World.level?.walkable && !World.level.walkable(nx, nz)) {
    fb.vel.x *= -0.4; fb.vel.z *= -0.4;
  } else {
    p.x = nx; p.z = nz;
  }
  p.y += fb.vel.y * dt;
  const gy = World.level?.heightAt ? World.level.heightAt(p.x, p.z) : 0; // token origin rests on ground
  if (p.y <= gy) {
    p.y = gy;
    if (fb.vel.y < 0) fb.vel.y = -fb.vel.y * LCFG.restitution;
    fb.vel.x *= 0.72; fb.vel.z *= 0.72;
    const speed = fb.vel.length();
    if (speed < LCFG.settleVel && fb.vel.y < LCFG.settleVel) { fb.settled = true; fb.vel.set(0, 0, 0); }
  }
  // Keep within level bounds.
  const b = World.level?.bounds;
  if (b) { p.x = Math.max(b.minX + 0.5, Math.min(b.maxX - 0.5, p.x)); p.z = Math.max(b.minZ + 0.5, Math.min(b.maxZ - 0.5, p.z)); }
}

function isSettled(drop) {
  return drop.handle ? (drop.handle.sleeping || !drop.handle.alive) : drop.fb.settled;
}

// ===========================================================================
// SYSTEM MODULE
// ===========================================================================
export default {
  name: 'loot',

  init(ctx) {
    scene = ctx.scene; camera = ctx.camera;
    GLOW_TEX = makeGlowTexture();
    RING_TEX = makeRingTexture();
    GEM_GEO = makeGemGeometry();

    // Pre-warm a modest token pool.
    for (let i = 0; i < 20; i++) buildToken();

    // DOM label container in #ui-root (our own node — UIHud owns #hud-root).
    injectStyles();
    const uiRoot = document.getElementById('ui-root') || document.body;
    labelContainer = document.createElement('div');
    labelContainer.id = 'loot-labels';
    uiRoot.appendChild(labelContainer);
    for (let i = 0; i < 24; i++) buildLabel();

    // Seed equip slots as empty.
    for (const s of EQUIP_SLOTS) Inventory.equip[s] = null;

    // The one true trigger: something died -> roll its loot.
    bus.on(EV.ENTITY_DIED, ({ entity, pos }) => {
      const p = pos || entity?.pos;
      if (!p) return;
      rollDrops(entity, _v.copy(p));
    });
  },

  fixed(dt) {
    // Advance fallback ballistics (physics engine handles its own bodies).
    for (const drop of drops) {
      drop.age += dt;
      if (drop.fb) stepFallback(drop, dt);
      if (!drop.pickable && drop.age >= LCFG.pickableDelay) drop.pickable = true;
      if (isSettled(drop)) emitBeam(drop);
    }
    // Proximity auto-pickup for currency (gear needs a click).
    const pp = playerPos();
    if (pp) {
      for (let i = drops.length - 1; i >= 0; i--) {
        const drop = drops[i];
        if (!drop.pickable || !drop.item.currencyKey) continue;
        const d = Math.hypot(drop.tok.group.position.x - pp.x, drop.tok.group.position.z - pp.z);
        if (d <= LCFG.pickupRadius) tryPickup(drop, false);
      }
    }
  },

  frame(dt, t) {
    // Idle motion + ground ring tracking (physics owns settled transforms;
    // we add a gentle spin/bob to the gem only once it is at rest).
    for (const drop of drops) {
      const tok = drop.tok;
      const settled = isSettled(drop);
      if (settled) {
        tok.gem.rotation.y += dt * 0.9;
        tok.gem.position.y = LCFG.crystalLift + Math.sin(t * 2 + drop.item.id) * 0.05;
        tok.glow.position.y = tok.gem.position.y;
      }
      // Ground ring follows beneath the token, snapped flat on terrain.
      const gp = tok.group.position;
      const gy = (World.level?.heightAt ? World.level.heightAt(gp.x, gp.z) : 0) + 0.02;
      tok.ring.position.set(gp.x, gy, gp.z);
      tok.ring.visible = tok.group.visible;
      // Subtle glow pulse.
      const pulse = 0.8 + Math.sin(t * 3 + drop.item.id * 1.7) * 0.12;
      tok.glowMat.opacity = (drop.item.rarity === 'normal' ? 0.5 : 0.82) * pulse;
    }
    updateLabels();
  },

  resize() { /* labels reproject every frame from innerWidth/innerHeight */ },
};

// EXILIUM HUD — DOM-based, into #ui-root. Owns life/mana orbs, skill bar with
// cooldown sweeps, XP bar, minimap, floating damage numbers, item tooltips,
// inventory grid, boss health bar, toasts, and an F3 debug overlay.
//
// Dark gothic, gold-on-black. Communicates ONLY via the bus + World. Never
// imports another subsystem. All per-frame work is transform/opacity + canvas;
// DOM writes are guarded on change so the HUD never thrashes layout (<1ms/frame).
import './hud.css';
import { CFG } from '../core/config.js';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { el, svg, installTextures } from './theme.js';
import { skillIndexFrom } from './skills.js';
import { Orb } from './orbs.js';
import { SkillBar } from './skillbar.js';
import { XpBar } from './xpbar.js';
import { DamageNumbers } from './damage.js';
import { Tooltip } from './tooltip.js';
import { Inventory } from './inventory.js';
import { Minimap } from './minimap.js';
import { BossBar } from './bossbar.js';
import { Toasts } from './toasts.js';
import { DebugOverlay } from './debug.js';
import { EndScreen } from './endscreen.js';
import { FpsMeter } from './fpsmeter.js';
import { Objective } from './objective.js';

const vitals = { life: 1, maxLife: 1, lifeReserve: 0, mana: 1, maxMana: 1, manaReserve: 0, ownsMana: false };

let root, orbLife, orbMana, skillbar, xpbar, dmg, tooltip, inventory, minimap, bossbar, toasts, debug, endscreen, fpsmeter, objective, cursor;
let widgets = [];
let cursorPos = { x: -100, y: -100 };
let started = false;

function buildCursor() {
  cursor = el('div', null, root); cursor.id = 'cursor';
  const g = svg('svg', { viewBox: '0 0 26 26' }, cursor);
  // ornate gothic pointer: gold arrow with dark outline + a small cross-guard flourish
  svg('path', { d: 'M3 2 L3 20 L8 15 L11.5 22 L14.5 20.6 L11.2 13.8 L18 13.6 Z',
    fill: '#c9a227', stroke: '#050505', 'stroke-width': 1.4, 'stroke-linejoin': 'round',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.8))' }, g);
  svg('path', { d: 'M3 2 L3 20 L8 15', fill: 'none', stroke: '#f0d97a', 'stroke-width': .8, opacity: .7 }, g);
}

function updateVitals(dt) {
  const p = World.player;
  const maxLife = (p && p.maxHp) || CFG.player.maxLife;
  const life = p && typeof p.hp === 'number' ? p.hp : maxLife;
  vitals.maxLife = maxLife; vitals.life = Math.max(0, life);
  vitals.lifeReserve = frac(p && (p.lifeReserved ?? p.reservedLife), maxLife);

  // Mana: prefer an authoritative player value; else simulate regen so the orb
  // + skill gating stay live even while player/combat are stubbed.
  const maxMana = (p && p.maxMana) || CFG.player.maxMana;
  vitals.maxMana = maxMana;
  if (p && typeof p.mana === 'number') {
    vitals.mana = Math.max(0, p.mana); vitals.ownsMana = true;
  } else {
    vitals.ownsMana = false;
    // seed to full the first time we simulate (mana starts full, not empty)
    if (!vitals._manaSeeded) { vitals.mana = maxMana; vitals._manaSeeded = true; }
    else vitals.mana = Math.min(maxMana, vitals.mana + CFG.player.manaRegen * dt);
  }
  vitals.manaReserve = frac(p && (p.manaReserved ?? p.reservedMana), maxMana);
}

// normalise a reserve value that may be a fraction (0..1) or an absolute amount
function frac(v, max) {
  if (!v || max <= 0) return 0;
  return v <= 1 ? v : Math.min(1, v / max);
}

export default {
  name: 'hud',

  init(ctx) {
    installTextures();
    root = el('div', null, document.getElementById('ui-root'));
    root.id = 'hud-root';

    orbLife = new Orb('life', root);
    orbMana = new Orb('mana', root);
    skillbar = new SkillBar(root, vitals);
    xpbar = new XpBar(root);
    dmg = new DamageNumbers(root);
    tooltip = new Tooltip(root);
    inventory = new Inventory(root, tooltip);
    minimap = new Minimap(root);
    bossbar = new BossBar(root);
    toasts = new Toasts(root);
    debug = new DebugOverlay(root);
    endscreen = new EndScreen(root);
    fpsmeter = new FpsMeter(root);
    objective = new Objective(root);
    buildCursor();

    widgets = [skillbar, xpbar, dmg, minimap, bossbar, toasts, inventory, debug, fpsmeter, objective];

    // authoritative cast → drive cooldown/mana (skillbar disables its fallback)
    bus.on(EV.PLAYER_CAST, (d) => {
      const idx = skillIndexFrom(d && (d.skill ?? d));
      if (idx >= 0) skillbar.onCast(idx);
    });

    // cursor + tooltip follow the pointer; inventory hover drives item tooltips
    addEventListener('pointermove', (e) => {
      cursorPos.x = e.clientX; cursorPos.y = e.clientY;
      if (cursor) cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
      tooltip.setCursor(e.clientX, e.clientY);
      inventory.hover(e);
    }, { passive: true });
    addEventListener('pointerdown', (e) => { inventory.hover(e); }, { passive: true });
  },

  frame(dt, t) {
    if (!started && window.__EXILIUM_READY) started = true;
    updateVitals(dt);

    // skillbar first so mana spends land in this frame before the orb draws
    skillbar.frame(dt);

    orbLife.set(vitals.life, vitals.maxLife, { reserve: vitals.lifeReserve });
    orbMana.set(vitals.mana, vitals.maxMana, { reserve: vitals.manaReserve });
    orbLife.frame(dt, t);
    orbMana.frame(dt, t);

    xpbar.frame(dt);
    dmg.frame(dt);
    minimap.frame(dt);
    bossbar.frame(dt);
    toasts.frame(dt);
    inventory.frame(dt);
    debug.frame(dt);
    fpsmeter.frame(dt);
    objective.frame(dt);
  },

  resize() { /* orbs/minimap are fixed-size canvases; projection reads live dims */ },
};

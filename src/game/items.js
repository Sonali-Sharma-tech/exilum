// EXILIUM — item generation: base types, implicits, rarity, naming, tooltip data.
// Owner: LootSystem. Pure data + generation; no THREE, no side effects.
// PoE's identity is its loot: the base, the roll, the colour, the name.

import { rollAffixes, UNIQUE_MODS } from './affixes.js';

// ---------------------------------------------------------------------------
// Rarity — EXACT PoE colour coding (hex ints for THREE, css strings for DOM).
// ---------------------------------------------------------------------------
export const RARITY = {
  normal: { key: 'normal', hex: 0xc8c8c8, css: '#c8c8c8', maxPrefix: 0, maxSuffix: 0 },
  magic:  { key: 'magic',  hex: 0x8888ff, css: '#8888ff', maxPrefix: 1, maxSuffix: 1 },
  rare:   { key: 'rare',   hex: 0xffff77, css: '#ffff77', maxPrefix: 3, maxSuffix: 3 },
  unique: { key: 'unique', hex: 0xaf6025, css: '#af6025', maxPrefix: 0, maxSuffix: 0 },
};
export const CURRENCY = { key: 'currency', hex: 0xaa9e82, css: '#aa9e82' };
export const GEM = { key: 'gem', hex: 0x1ba29b, css: '#1ba29b' };

export function rarityColor(rarityKey) {
  if (rarityKey === 'currency') return CURRENCY.hex;
  if (rarityKey === 'gem') return GEM.hex;
  return (RARITY[rarityKey] || RARITY.normal).hex;
}
export function rarityCss(rarityKey) {
  if (rarityKey === 'currency') return CURRENCY.css;
  if (rarityKey === 'gem') return GEM.css;
  return (RARITY[rarityKey] || RARITY.normal).css;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers.
// ---------------------------------------------------------------------------
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rf = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
function weightedPick(list, weightOf) {
  let total = 0;
  for (const it of list) total += weightOf(it);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const it of list) { r -= weightOf(it); if (r <= 0) return it; }
  return list[list.length - 1];
}

// ---------------------------------------------------------------------------
// Base types. Each: key, name, slot, grid w/h, level/attr requirements, tags
// (drive affix pools), a base-stat block, and a rolled implicit.
// slot ∈ weapon | offhand | helm | body | gloves | boots | belt | amulet | ring | flask | currency
// ---------------------------------------------------------------------------
export const BASES = [
  // ---- one-hand weapons ---------------------------------------------------
  { key: 'rustedSword', name: 'Rusted Sword', slot: 'weapon', hand: 1, w: 2, h: 3, req: { level: 1, str: 8, dex: 8, int: 0 },
    tags: ['weapon', 'melee', 'sword'], weapon: { physMin: 5, physMax: 11, crit: 5, aps: 1.55 } },
  { key: 'glintDagger', name: 'Glinting Dagger', slot: 'weapon', hand: 1, w: 1, h: 3, req: { level: 1, str: 0, dex: 9, int: 6 },
    tags: ['weapon', 'melee', 'dagger'], weapon: { physMin: 3, physMax: 12, crit: 6.5, aps: 1.6 } },
  { key: 'stoneHammer', name: 'Stone Hammer', slot: 'weapon', hand: 1, w: 2, h: 3, req: { level: 3, str: 14, dex: 0, int: 0 },
    tags: ['weapon', 'melee', 'mace'], weapon: { physMin: 9, physMax: 16, crit: 5, aps: 1.25 } },
  { key: 'driftwoodWand', name: 'Driftwood Wand', slot: 'weapon', hand: 1, w: 1, h: 3, req: { level: 1, str: 0, dex: 0, int: 12 },
    tags: ['weapon', 'caster', 'wand'], weapon: { physMin: 3, physMax: 7, crit: 7, aps: 1.4 } },
  { key: 'drearySceptre', name: 'Dreary Sceptre', slot: 'weapon', hand: 1, w: 2, h: 3, req: { level: 3, str: 10, dex: 0, int: 10 },
    tags: ['weapon', 'caster', 'sceptre', 'melee'], weapon: { physMin: 6, physMax: 13, crit: 6, aps: 1.4 } },

  // ---- two-hand weapons ---------------------------------------------------
  { key: 'corrodedBlade', name: 'Corroded Blade', slot: 'weapon', hand: 2, w: 2, h: 4, req: { level: 5, str: 17, dex: 17, int: 0 },
    tags: ['weapon', 'melee', 'sword', 'twohand'], weapon: { physMin: 12, physMax: 22, crit: 5, aps: 1.45 } },
  { key: 'stoneAxe', name: 'Stone Axe', slot: 'weapon', hand: 2, w: 2, h: 4, req: { level: 6, str: 21, dex: 9, int: 0 },
    tags: ['weapon', 'melee', 'axe', 'twohand'], weapon: { physMin: 16, physMax: 26, crit: 5, aps: 1.3 } },
  { key: 'gnarledBranch', name: 'Gnarled Branch', slot: 'weapon', hand: 2, w: 2, h: 4, req: { level: 1, str: 14, dex: 0, int: 14 },
    tags: ['weapon', 'caster', 'staff', 'twohand'], weapon: { physMin: 10, physMax: 20, crit: 6.5, aps: 1.3 } },
  { key: 'crudeBow', name: 'Crude Bow', slot: 'weapon', hand: 2, w: 2, h: 4, req: { level: 1, str: 0, dex: 14, int: 0 },
    tags: ['weapon', 'bow', 'twohand'], weapon: { physMin: 6, physMax: 14, crit: 6, aps: 1.4 } },

  // ---- body armour --------------------------------------------------------
  { key: 'plateVest', name: 'Plate Vest', slot: 'body', w: 2, h: 3, req: { level: 1, str: 12, dex: 0, int: 0 },
    tags: ['armour', 'body', 'ar'], def: { type: 'ar', base: 34 } },
  { key: 'shabbyJerkin', name: 'Shabby Jerkin', slot: 'body', w: 2, h: 3, req: { level: 1, str: 0, dex: 12, int: 0 },
    tags: ['armour', 'body', 'ev'], def: { type: 'ev', base: 34 } },
  { key: 'simpleRobe', name: 'Simple Robe', slot: 'body', w: 2, h: 3, req: { level: 1, str: 0, dex: 0, int: 12 },
    tags: ['armour', 'body', 'es'], def: { type: 'es', base: 14 } },

  // ---- helm ---------------------------------------------------------------
  { key: 'ironHat', name: 'Iron Hat', slot: 'helm', w: 2, h: 2, req: { level: 1, str: 8, dex: 0, int: 0 },
    tags: ['armour', 'helm', 'ar'], def: { type: 'ar', base: 15 } },
  { key: 'leatherCap', name: 'Leather Cap', slot: 'helm', w: 2, h: 2, req: { level: 1, str: 0, dex: 8, int: 0 },
    tags: ['armour', 'helm', 'ev'], def: { type: 'ev', base: 15 } },
  { key: 'vineCirclet', name: 'Vine Circlet', slot: 'helm', w: 2, h: 2, req: { level: 1, str: 0, dex: 0, int: 8 },
    tags: ['armour', 'helm', 'es'], def: { type: 'es', base: 7 } },

  // ---- gloves -------------------------------------------------------------
  { key: 'ironGauntlets', name: 'Iron Gauntlets', slot: 'gloves', w: 2, h: 2, req: { level: 1, str: 8, dex: 0, int: 0 },
    tags: ['armour', 'gloves', 'ar'], def: { type: 'ar', base: 12 } },
  { key: 'rawhideGloves', name: 'Rawhide Gloves', slot: 'gloves', w: 2, h: 2, req: { level: 1, str: 0, dex: 8, int: 0 },
    tags: ['armour', 'gloves', 'ev'], def: { type: 'ev', base: 12 } },
  { key: 'woolGloves', name: 'Wool Gloves', slot: 'gloves', w: 2, h: 2, req: { level: 1, str: 0, dex: 0, int: 8 },
    tags: ['armour', 'gloves', 'es'], def: { type: 'es', base: 5 } },

  // ---- boots --------------------------------------------------------------
  { key: 'ironGreaves', name: 'Iron Greaves', slot: 'boots', w: 2, h: 2, req: { level: 1, str: 8, dex: 0, int: 0 },
    tags: ['armour', 'boots', 'ar'], def: { type: 'ar', base: 12 } },
  { key: 'rawhideBoots', name: 'Rawhide Boots', slot: 'boots', w: 2, h: 2, req: { level: 1, str: 0, dex: 8, int: 0 },
    tags: ['armour', 'boots', 'ev'], def: { type: 'ev', base: 12 } },
  { key: 'woolShoes', name: 'Wool Shoes', slot: 'boots', w: 2, h: 2, req: { level: 1, str: 0, dex: 0, int: 8 },
    tags: ['armour', 'boots', 'es'], def: { type: 'es', base: 5 } },

  // ---- belt ---------------------------------------------------------------
  { key: 'leatherBelt', name: 'Leather Belt', slot: 'belt', w: 2, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['belt'], implicitMod: { render: (v) => `+${v[0]} to maximum Life`, rolls: [[20, 30]] } },
  { key: 'heavyBelt', name: 'Heavy Belt', slot: 'belt', w: 2, h: 1, req: { level: 8, str: 0, dex: 0, int: 0 },
    tags: ['belt'], implicitMod: { render: (v) => `+${v[0]} to Strength`, rolls: [[15, 25]] } },
  { key: 'chainBelt', name: 'Chain Belt', slot: 'belt', w: 2, h: 1, req: { level: 4, str: 0, dex: 0, int: 0 },
    tags: ['belt'], implicitMod: { render: (v) => `${v[0]}% increased Stun and Block Recovery`, rolls: [[10, 16]] } },

  // ---- rings --------------------------------------------------------------
  { key: 'ironRing', name: 'Iron Ring', slot: 'ring', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['ring', 'jewelry'], implicitMod: { render: (v) => `Adds ${v[0]} to ${v[1]} Physical Damage to Attacks`, rolls: [[1, 2], [3, 5]] } },
  { key: 'coralRing', name: 'Coral Ring', slot: 'ring', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['ring', 'jewelry'], implicitMod: { render: (v) => `+${v[0]} to maximum Life`, rolls: [[20, 30]] } },
  { key: 'pauaRing', name: 'Paua Ring', slot: 'ring', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['ring', 'jewelry'], implicitMod: { render: (v) => `+${v[0]} to maximum Mana`, rolls: [[20, 30]] } },
  { key: 'goldRing', name: 'Gold Ring', slot: 'ring', w: 1, h: 1, req: { level: 20, str: 0, dex: 0, int: 0 },
    tags: ['ring', 'jewelry'], implicitMod: { render: (v) => `${v[0]}% increased Rarity of Items found`, rolls: [[4, 8]] } },

  // ---- amulet -------------------------------------------------------------
  { key: 'coralAmulet', name: 'Coral Amulet', slot: 'amulet', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['amulet', 'jewelry'], implicitMod: { render: (v) => `+${v[0]} Life Regenerated per second`, rolls: [[2, 4]] } },
  { key: 'jadeAmulet', name: 'Jade Amulet', slot: 'amulet', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['amulet', 'jewelry'], implicitMod: { render: (v) => `+${v[0]} to Dexterity`, rolls: [[20, 30]] } },
  { key: 'lapisAmulet', name: 'Lapis Amulet', slot: 'amulet', w: 1, h: 1, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['amulet', 'jewelry'], implicitMod: { render: (v) => `+${v[0]} to Intelligence`, rolls: [[20, 30]] } },

  // ---- flasks -------------------------------------------------------------
  { key: 'lifeFlask', name: 'Life Flask', slot: 'flask', w: 1, h: 2, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['flask', 'lifeflask'], flask: { restore: 'life', amount: 70, duration: 6 },
    implicitMod: { render: (v) => `Recovers ${v[0]} Life over 6.00 seconds`, rolls: [[70, 70]] } },
  { key: 'manaFlask', name: 'Mana Flask', slot: 'flask', w: 1, h: 2, req: { level: 1, str: 0, dex: 0, int: 0 },
    tags: ['flask', 'manaflask'], flask: { restore: 'mana', amount: 50, duration: 5 },
    implicitMod: { render: (v) => `Recovers ${v[0]} Mana over 5.00 seconds`, rolls: [[50, 50]] } },
  { key: 'quicksilverFlask', name: 'Quicksilver Flask', slot: 'flask', w: 1, h: 2, req: { level: 4, str: 0, dex: 0, int: 0 },
    tags: ['flask', 'utilityflask'], flask: { restore: 'speed', amount: 40, duration: 4 },
    implicitMod: { render: (v) => `${v[0]}% increased Movement Speed`, rolls: [[40, 40]] } },
];
export const BASE_BY_KEY = new Map(BASES.map((b) => [b.key, b]));
const EQUIP_BASES = BASES.filter((b) => b.slot !== 'flask' && b.slot !== 'currency');

// ---------------------------------------------------------------------------
// Currency — weighted drop table. Common orbs frequent, mirror vanishingly rare.
// ---------------------------------------------------------------------------
export const CURRENCIES = [
  { key: 'scroll',      name: 'Scroll of Wisdom',    weight: 320, maxStack: 40, tint: 0x8a7f66, desc: 'Identifies an item.' },
  { key: 'portal',      name: 'Portal Scroll',       weight: 160, maxStack: 40, tint: 0x7f8ea3, desc: 'Creates a portal to town.' },
  { key: 'transmute',   name: 'Orb of Transmutation', weight: 150, maxStack: 40, tint: 0x9aa0b4, desc: 'Upgrades a normal item to magic.' },
  { key: 'augment',     name: 'Orb of Augmentation', weight: 120, maxStack: 30, tint: 0x8fa2c4, desc: 'Adds a modifier to a magic item.' },
  { key: 'alteration',  name: 'Orb of Alteration',   weight: 110, maxStack: 20, tint: 0x6c8fc0, desc: 'Rerolls a magic item.' },
  { key: 'chromatic',   name: 'Chromatic Orb',       weight: 95,  maxStack: 20, tint: 0xb08fc0, desc: 'Reforges the colour of sockets.' },
  { key: 'fusing',      name: 'Orb of Fusing',       weight: 80,  maxStack: 20, tint: 0xc08a5a, desc: 'Reforges links between sockets.' },
  { key: 'alchemy',     name: 'Orb of Alchemy',      weight: 55,  maxStack: 10, tint: 0xd0c060, desc: 'Upgrades a normal item to rare.' },
  { key: 'chance',      name: 'Orb of Chance',       weight: 60,  maxStack: 20, tint: 0xc7b878, desc: 'Upgrades a normal item to a random rarity.' },
  { key: 'regal',       name: 'Regal Orb',           weight: 22,  maxStack: 10, tint: 0xd8b0e0, desc: 'Upgrades a magic item to rare.' },
  { key: 'chaos',       name: 'Chaos Orb',           weight: 30,  maxStack: 10, tint: 0xc0a0d8, desc: 'Reforges a rare item with new modifiers.' },
  { key: 'vaal',        name: 'Vaal Orb',            weight: 16,  maxStack: 10, tint: 0xd05050, desc: 'Corrupts an item, unpredictably.' },
  { key: 'exalted',     name: 'Exalted Orb',         weight: 4,   maxStack: 10, tint: 0xe0c060, desc: 'Adds a new modifier to a rare item.' },
  { key: 'divine',      name: 'Divine Orb',          weight: 2,   maxStack: 10, tint: 0xf0e0a0, desc: 'Rerolls the values of modifiers.' },
  { key: 'mirror',      name: 'Mirror of Kalandra',  weight: 0.06, maxStack: 5, tint: 0xd8f0ff, desc: 'Creates a mirrored copy of an item.' },
];
const CUR_BY_KEY = new Map(CURRENCIES.map((c) => [c.key, c]));

// ---------------------------------------------------------------------------
// Uniques — fixed base + fixed mods + fixed name (the "always the same" thrill).
// ---------------------------------------------------------------------------
export const UNIQUES = [
  { name: 'Goldrim',    baseKey: 'leatherCap',  flavour: 'Wealth comes to those who seek it.' },
  { name: 'Wanderlust', baseKey: 'woolShoes',   flavour: 'The journey is the reward.' },
  { name: 'Meginord\u2019s Girdle', baseKey: 'heavyBelt', flavour: 'The blood of Meginord courses through my veins.' },
  { name: 'Blackheart', baseKey: 'ironRing',    flavour: 'A heart of coal, a soul of ash.' },
  { name: 'The Pariah', baseKey: 'coralRing',   flavour: 'Alone, unwanted, unbroken.' },
  { name: 'Reaper\u2019s Pursuit', baseKey: 'stoneAxe', flavour: 'The harvest never ends.' },
];

// ---------------------------------------------------------------------------
// Rare-name word pools — evocative two-word names, second word by item class.
// ---------------------------------------------------------------------------
const RARE_FIRST = ['Corpse', 'Doom', 'Blood', 'Vengeance', 'Gloom', 'Rage', 'Storm', 'Grim', 'Soul', 'Dread',
  'Viper', 'Behemoth', 'Pain', 'Havoc', 'Morbid', 'Onslaught', 'Woe', 'Brimstone', 'Carrion', 'Sorrow',
  'Bramble', 'Kraken', 'Spirit', 'Hate', 'Damnation', 'Victory', 'Dragon', 'Phoenix', 'Maelstrom', 'Wyrm',
  'Rune', 'Skull', 'Ghoul', 'Torment', 'Entropy', 'Empyrean', 'Loath', 'Death', 'Golem', 'Eagle'];
const RARE_SECOND = {
  weapon:  ['Bane', 'Render', 'Cleaver', 'Sunder', 'Spike', 'Edge', 'Fang', 'Wound', 'Thirst', 'Song', 'Piercer', 'Roar', 'Gutter', 'Reaver', 'Slayer', 'Wreath'],
  armour:  ['Guard', 'Ward', 'Cloak', 'Shell', 'Veil', 'Aegis', 'Carapace', 'Hide', 'Cover', 'Mantle', 'Skin', 'Shroud', 'Wall', 'Bastion'],
  jewelry: ['Charm', 'Torc', 'Loop', 'Knot', 'Circle', 'Grip', 'Whorl', 'Clasp', 'Bead', 'Idol', 'Sigil', 'Talisman', 'Band', 'Gyre'],
  belt:    ['Bind', 'Girdle', 'Coil', 'Lash', 'Buckle', 'Hold', 'Clasp', 'Wrap'],
  other:   ['Relic', 'Remnant', 'Vestige', 'Token', 'Fragment', 'Echo'],
};
function rareClass(base) {
  if (base.slot === 'weapon') return 'weapon';
  if (base.slot === 'body' || base.slot === 'helm' || base.slot === 'gloves' || base.slot === 'boots') return 'armour';
  if (base.slot === 'ring' || base.slot === 'amulet') return 'jewelry';
  if (base.slot === 'belt') return 'belt';
  return 'other';
}
function composeRareName(base) {
  return `${pick(RARE_FIRST)} ${pick(RARE_SECOND[rareClass(base)] || RARE_SECOND.other)}`;
}

// Magic name: [prefix word] Base [of suffix]. At least one affix guaranteed.
function composeMagicName(base, prefixes, suffixes) {
  const word = prefixes[0]?.word;
  const of = suffixes[0]?.of;
  let n = base.name;
  if (word) n = `${word} ${n}`;
  if (of) n = `${n} ${of}`;
  return n;
}

// ---------------------------------------------------------------------------
// Implicit roll — from base.implicitMod or derived from weapon/def block.
// ---------------------------------------------------------------------------
function rollImplicit(base) {
  const out = [];
  if (base.implicitMod) {
    const vals = base.implicitMod.rolls.map((r) => ri(r[0], r[1]));
    out.push({ text: base.implicitMod.render(vals), values: vals });
  }
  return out;
}

// Roll the base defensive/offensive numbers into concrete display stats.
function rollBaseStats(base, ilvl) {
  const q = 1 + Math.min(0.9, ilvl * 0.012); // higher ilvl bases roll a touch stronger
  if (base.weapon) {
    const w = base.weapon;
    return {
      kind: 'weapon',
      physMin: Math.round(w.physMin * q),
      physMax: Math.round(w.physMax * q),
      crit: w.crit,
      aps: w.aps,
    };
  }
  if (base.def) {
    return { kind: 'armour', defType: base.def.type, def: Math.round(base.def.base * q) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// generateItem — the workhorse. Returns a fully-rolled item object.
//   opts: { ilvl, rarity, baseKey? }
// ---------------------------------------------------------------------------
let _itemSeq = 1;
export function generateItem({ ilvl = 1, rarity = 'normal', baseKey = null } = {}) {
  const base = (baseKey && BASE_BY_KEY.get(baseKey)) ||
    weightedPick(EQUIP_BASES, (b) => 1 / (1 + Math.max(0, b.req.level - ilvl) * 0.5));
  const rar = RARITY[rarity] ? rarity : 'normal';
  const item = {
    id: _itemSeq++,
    base,
    slot: base.slot,
    rarity: rar,
    ilvl: Math.max(1, ilvl),
    req: { ...base.req },
    stats: rollBaseStats(base, ilvl),
    implicits: rollImplicit(base),
    prefixes: [],
    suffixes: [],
    corrupted: false,
    x: -1, y: -1, // grid position, assigned on placement
  };

  if (rar === 'magic' || rar === 'rare') {
    const maxP = RARITY[rar].maxPrefix;
    const maxS = RARITY[rar].maxSuffix;
    // magic: guarantee at least one affix; rare: at least four for weight.
    const minTotal = rar === 'magic' ? 1 : 4;
    const rolled = rollAffixes(base.tags, item.ilvl, maxP, maxS, minTotal);
    item.prefixes = rolled.prefixes;
    item.suffixes = rolled.suffixes;
    // Affix mods can raise the level requirement (highest-tier mod gates it).
    let maxModLvl = base.req.level;
    for (const a of [...rolled.prefixes, ...rolled.suffixes]) {
      maxModLvl = Math.max(maxModLvl, Math.round(a.ilvl * 0.8));
    }
    item.req.level = Math.min(item.ilvl, Math.max(base.req.level, maxModLvl));
  }

  item.name = rar === 'rare' ? composeRareName(base)
    : rar === 'magic' ? composeMagicName(base, item.prefixes, item.suffixes)
    : base.name;
  item.color = rarityColor(rar);
  item.css = rarityCss(rar);
  return item;
}

// ---------------------------------------------------------------------------
// generateUnique — fixed name, fixed base, fixed mod set.
// ---------------------------------------------------------------------------
export function generateUnique(ilvl = 1, def = null) {
  const u = def || pick(UNIQUES);
  const base = BASE_BY_KEY.get(u.baseKey);
  const mods = UNIQUE_MODS[u.name] || { prefixes: [], suffixes: [] };
  const item = {
    id: _itemSeq++,
    base,
    slot: base.slot,
    rarity: 'unique',
    ilvl: Math.max(1, ilvl),
    req: { ...base.req },
    stats: rollBaseStats(base, ilvl),
    implicits: rollImplicit(base),
    prefixes: mods.prefixes.map((m) => rollFixed(m, 'prefix')),
    suffixes: mods.suffixes.map((m) => rollFixed(m, 'suffix')),
    corrupted: false,
    flavour: u.flavour,
    name: u.name,
    color: RARITY.unique.hex,
    css: RARITY.unique.css,
    x: -1, y: -1,
  };
  return item;
}
function rollFixed(m, kind) {
  const vals = (m.rolls || []).map((r) => ri(r[0], r[1]));
  return { kind, group: m.group || m.render.toString(), tier: 0, tierName: 'Unique', text: m.render(vals), values: vals };
}

// ---------------------------------------------------------------------------
// generateCurrency — weighted table; returns a stackable currency item.
// ---------------------------------------------------------------------------
export function generateCurrency(key = null, count = 1) {
  const c = (key && CUR_BY_KEY.get(key)) || weightedPick(CURRENCIES, (x) => x.weight);
  return {
    id: _itemSeq++,
    base: { key: c.key, name: c.name, slot: 'currency', w: 1, h: 1 },
    slot: 'currency',
    rarity: 'currency',
    currencyKey: c.key,
    ilvl: 1,
    req: { level: 1, str: 0, dex: 0, int: 0 },
    stack: Math.min(count, c.maxStack),
    maxStack: c.maxStack,
    tint: c.tint,
    flavour: c.desc,
    stats: null,
    implicits: [],
    prefixes: [],
    suffixes: [],
    name: c.name,
    color: CURRENCY.hex,
    css: CURRENCY.css,
    x: -1, y: -1,
  };
}

// ---------------------------------------------------------------------------
// describeItem — structured tooltip data for UIHud (no rendering here).
// Returns { name, rarity, color, css, base, ilvl, req, implicits, prefixes,
//           suffixes, flavour, lines[] } where each line is a typed segment.
// ---------------------------------------------------------------------------
export function describeItem(item) {
  const lines = [];
  const push = (kind, text, extra) => lines.push({ kind, text, ...(extra || {}) });

  push('name', item.name, { color: item.color, css: item.css });
  if (item.rarity !== 'normal' && item.rarity !== 'currency' && item.name !== item.base.name) {
    push('base', item.base.name);
  }
  push('sep');

  // Base offensive / defensive block.
  if (item.stats?.kind === 'weapon') {
    const s = item.stats;
    push('stat', `Physical Damage: ${s.physMin}-${s.physMax}`, { hl: true });
    push('stat', `Critical Strike Chance: ${s.crit.toFixed(2)}%`);
    push('stat', `Attacks per Second: ${s.aps.toFixed(2)}`);
    const dps = ((s.physMin + s.physMax) / 2) * s.aps;
    push('stat', `Physical DPS: ${dps.toFixed(1)}`, { hl: true });
    push('sep');
  } else if (item.stats?.kind === 'armour') {
    const label = item.stats.defType === 'ar' ? 'Armour'
      : item.stats.defType === 'ev' ? 'Evasion Rating' : 'Energy Shield';
    push('stat', `${label}: ${item.stats.def}`, { hl: true });
    push('sep');
  } else if (item.slot === 'currency') {
    push('stat', `Stack Size: ${item.stack}/${item.maxStack}`);
    push('sep');
  }

  // Requirements.
  const r = item.req;
  const reqParts = [`Level ${r.level}`];
  if (r.str) reqParts.push(`${r.str} Str`);
  if (r.dex) reqParts.push(`${r.dex} Dex`);
  if (r.int) reqParts.push(`${r.int} Int`);
  if (item.slot !== 'currency') { push('req', `Requires ${reqParts.join(', ')}`); push('sep'); }

  // Implicit mods (rendered with the implicit separator style).
  if (item.implicits.length) {
    for (const m of item.implicits) push('implicit', m.text);
    if (item.prefixes.length || item.suffixes.length) push('sep');
  }

  // Explicit affixes.
  for (const a of item.prefixes) push('prefix', a.text, { tier: a.tier, tierName: a.tierName });
  for (const a of item.suffixes) push('suffix', a.text, { tier: a.tier, tierName: a.tierName });

  if (item.flavour) { push('sep'); push('flavour', item.flavour); }

  return {
    name: item.name,
    rarity: item.rarity,
    color: item.color,
    css: item.css,
    base: item.base.name,
    ilvl: item.ilvl,
    req: { ...item.req },
    implicits: item.implicits.map((m) => ({ text: m.text })),
    prefixes: item.prefixes.map((a) => ({ text: a.text, tier: a.tier, tierName: a.tierName })),
    suffixes: item.suffixes.map((a) => ({ text: a.text, tier: a.tier, tierName: a.tierName })),
    flavour: item.flavour || null,
    lines,
  };
}

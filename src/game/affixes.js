// EXILIUM — affix system: PoE-style prefixes/suffixes with tiers, weighted
// rolls, mutually-exclusive groups, and per-rarity counts.
// Owner: LootSystem. Pure data + rolling; no THREE, no side effects.
//
// Model (mirrors PoE):
//   - An affix is a "group" (mutually exclusive — only one tier of a group can
//     appear on an item, and only one mod per group).
//   - Each affix has tiers; a tier has ilvl (min item level), weight, and one
//     or more roll ranges [min,max]. Higher tiers require higher ilvl and roll
//     lower weight (rarer) but stronger values.
//   - pools: tags the mod can roll on (item eligible if it shares ANY tag).
//   - Prefix tiers carry a `word` (the item-name prefix); suffix tiers carry
//     an `of` phrase (the "of ..." item-name suffix).

const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// ---------------------------------------------------------------------------
// PREFIXES — additive/increased offence & defence, flat life/mana/es, etc.
// ---------------------------------------------------------------------------
export const PREFIXES = [
  {
    group: 'LocalPhysDamagePct', pools: ['weapon'],
    render: (v) => `${v[0]}% increased Physical Damage`,
    tiers: [
      { ilvl: 1,  weight: 1000, word: 'Burnished', name: 'Glinting',  rolls: [[15, 25]] },
      { ilvl: 11, weight: 800,  word: 'Polished',  name: 'Gleaming',  rolls: [[26, 40]] },
      { ilvl: 23, weight: 500,  word: 'Honed',     name: 'Annealed',  rolls: [[41, 55]] },
      { ilvl: 35, weight: 260,  word: 'Serrated',  name: 'Razor-sharp', rolls: [[56, 74]] },
      { ilvl: 50, weight: 120,  word: 'Wicked',    name: 'Tempered',  rolls: [[75, 100]] },
    ],
  },
  {
    group: 'LocalFlatPhys', pools: ['weapon'],
    render: (v) => `Adds ${v[0]} to ${v[1]} Physical Damage`,
    tiers: [
      { ilvl: 2,  weight: 1000, word: 'Jagged',   name: 'of Ruin',   rolls: [[2, 4], [5, 8]] },
      { ilvl: 15, weight: 700,  word: 'Barbed',   name: 'of Rending', rolls: [[5, 9], [11, 16]] },
      { ilvl: 30, weight: 380,  word: 'Vicious',  name: 'of Havoc',  rolls: [[10, 16], [20, 30]] },
      { ilvl: 45, weight: 150,  word: 'Bloodthirsty', name: 'of Carnage', rolls: [[17, 26], [34, 50]] },
    ],
  },
  {
    group: 'AddedFireDamage', pools: ['weapon'],
    render: (v) => `Adds ${v[0]} to ${v[1]} Fire Damage`,
    tiers: [
      { ilvl: 8,  weight: 700, word: 'Heated',    name: 'of Ash',    rolls: [[2, 4], [6, 10]] },
      { ilvl: 25, weight: 400, word: 'Smouldering', name: 'of Cinders', rolls: [[6, 11], [16, 24]] },
      { ilvl: 42, weight: 180, word: 'Blasting',  name: 'of Immolation', rolls: [[14, 22], [34, 50]] },
    ],
  },
  {
    group: 'IncSpellDamage', pools: ['caster'],
    render: (v) => `${v[0]}% increased Spell Damage`,
    tiers: [
      { ilvl: 4,  weight: 800, word: 'Apprentice\u2019s', name: 'Mystic',   rolls: [[10, 19]] },
      { ilvl: 20, weight: 500, word: 'Adept\u2019s',      name: 'Arcane',   rolls: [[20, 29]] },
      { ilvl: 38, weight: 240, word: 'Occultist\u2019s',  name: 'Runic',    rolls: [[30, 42]] },
      { ilvl: 55, weight: 90,  word: 'Runic',      name: 'Fabled',   rolls: [[43, 58]] },
    ],
  },
  {
    group: 'MaxLife', pools: ['armour', 'belt', 'jewelry', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]} to maximum Life`,
    tiers: [
      { ilvl: 1,  weight: 1000, word: 'Hale',      name: 'Healthy',  rolls: [[10, 19]] },
      { ilvl: 11, weight: 800,  word: 'Healthy',   name: 'Sanguine', rolls: [[20, 29]] },
      { ilvl: 22, weight: 500,  word: 'Sanguine',  name: 'Stalwart', rolls: [[30, 44]] },
      { ilvl: 36, weight: 260,  word: 'Stalwart',  name: 'Robust',   rolls: [[45, 64]] },
      { ilvl: 54, weight: 100,  word: 'Vigorous',  name: 'Athlete\u2019s', rolls: [[65, 89]] },
    ],
  },
  {
    group: 'MaxMana', pools: ['armour', 'jewelry', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]} to maximum Mana`,
    tiers: [
      { ilvl: 1,  weight: 900, word: 'Dewy',      name: 'Misty',    rolls: [[15, 24]] },
      { ilvl: 13, weight: 650, word: 'Misty',     name: 'Azure',    rolls: [[25, 39]] },
      { ilvl: 30, weight: 340, word: 'Azure',     name: 'Opalescent', rolls: [[40, 59]] },
      { ilvl: 48, weight: 120, word: 'Opaline',   name: 'Prophet\u2019s', rolls: [[60, 84]] },
    ],
  },
  {
    group: 'LocalArmour', pools: ['ar'],
    render: (v) => `+${v[0]} to Armour`,
    tiers: [
      { ilvl: 1,  weight: 1000, word: 'Rusted',    name: 'Plated',   rolls: [[8, 18]] },
      { ilvl: 12, weight: 700,  word: 'Plated',    name: 'Ironclad', rolls: [[19, 40]] },
      { ilvl: 28, weight: 380,  word: 'Ironclad',  name: 'Girded',   rolls: [[41, 78]] },
      { ilvl: 45, weight: 140,  word: 'Fortified', name: 'Bastion\u2019s', rolls: [[79, 140]] },
    ],
  },
  {
    group: 'LocalEvasion', pools: ['ev'],
    render: (v) => `+${v[0]} to Evasion Rating`,
    tiers: [
      { ilvl: 1,  weight: 1000, word: 'Salvaged',  name: 'Stippled', rolls: [[8, 18]] },
      { ilvl: 12, weight: 700,  word: 'Stippled',  name: 'Padded',   rolls: [[19, 40]] },
      { ilvl: 28, weight: 380,  word: 'Nimble',    name: 'Sprinter\u2019s', rolls: [[41, 78]] },
      { ilvl: 45, weight: 140,  word: 'Blurred',   name: 'Phantom',  rolls: [[79, 140]] },
    ],
  },
  {
    group: 'LocalEnergyShield', pools: ['es'],
    render: (v) => `+${v[0]} to maximum Energy Shield`,
    tiers: [
      { ilvl: 2,  weight: 900, word: 'Ghostly',    name: 'Halation', rolls: [[4, 9]] },
      { ilvl: 14, weight: 620, word: 'Halation',   name: 'Radiant',  rolls: [[10, 19]] },
      { ilvl: 30, weight: 320, word: 'Radiant',    name: 'Warding',  rolls: [[20, 36]] },
      { ilvl: 48, weight: 110, word: 'Vaporous',   name: 'Seraphim\u2019s', rolls: [[37, 60]] },
    ],
  },
];

// ---------------------------------------------------------------------------
// SUFFIXES — resistances, attributes, attack/cast speed, crit, regen, etc.
// ---------------------------------------------------------------------------
export const SUFFIXES = [
  {
    group: 'FireResist', pools: ['armour', 'belt', 'jewelry', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]}% to Fire Resistance`,
    tiers: [
      { ilvl: 1,  weight: 1000, of: 'of the Whelp',   name: 'of the Whelp',   rolls: [[6, 11]] },
      { ilvl: 12, weight: 700,  of: 'of the Salamander', name: 'of the Salamander', rolls: [[12, 17]] },
      { ilvl: 30, weight: 400,  of: 'of the Drake',   name: 'of the Drake',   rolls: [[18, 23]] },
      { ilvl: 48, weight: 160,  of: 'of the Dragon',  name: 'of the Dragon',  rolls: [[24, 30]] },
    ],
  },
  {
    group: 'ColdResist', pools: ['armour', 'belt', 'jewelry', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]}% to Cold Resistance`,
    tiers: [
      { ilvl: 1,  weight: 1000, of: 'of the Inuit',   name: 'of the Inuit',   rolls: [[6, 11]] },
      { ilvl: 12, weight: 700,  of: 'of the Yeti',    name: 'of the Yeti',    rolls: [[12, 17]] },
      { ilvl: 30, weight: 400,  of: 'of the Walrus',  name: 'of the Walrus',  rolls: [[18, 23]] },
      { ilvl: 48, weight: 160,  of: 'of the Polar Bear', name: 'of the Polar Bear', rolls: [[24, 30]] },
    ],
  },
  {
    group: 'LightningResist', pools: ['armour', 'belt', 'jewelry', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]}% to Lightning Resistance`,
    tiers: [
      { ilvl: 1,  weight: 1000, of: 'of the Cloud',   name: 'of the Cloud',   rolls: [[6, 11]] },
      { ilvl: 12, weight: 700,  of: 'of the Squall',  name: 'of the Squall',  rolls: [[12, 17]] },
      { ilvl: 30, weight: 400,  of: 'of the Storm',   name: 'of the Storm',   rolls: [[18, 23]] },
      { ilvl: 48, weight: 160,  of: 'of the Tempest', name: 'of the Tempest', rolls: [[24, 30]] },
    ],
  },
  {
    group: 'Strength', pools: ['armour', 'jewelry', 'belt', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]} to Strength`,
    tiers: [
      { ilvl: 1,  weight: 900, of: 'of the Brute',  name: 'of the Brute',  rolls: [[8, 12]] },
      { ilvl: 18, weight: 600, of: 'of the Wrestler', name: 'of the Wrestler', rolls: [[13, 17]] },
      { ilvl: 36, weight: 300, of: 'of the Bear',   name: 'of the Bear',   rolls: [[18, 22]] },
      { ilvl: 55, weight: 110, of: 'of the Lion',   name: 'of the Lion',   rolls: [[23, 30]] },
    ],
  },
  {
    group: 'Dexterity', pools: ['armour', 'jewelry', 'belt', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]} to Dexterity`,
    tiers: [
      { ilvl: 1,  weight: 900, of: 'of the Mongoose', name: 'of the Mongoose', rolls: [[8, 12]] },
      { ilvl: 18, weight: 600, of: 'of the Fox',    name: 'of the Fox',    rolls: [[13, 17]] },
      { ilvl: 36, weight: 300, of: 'of the Falcon', name: 'of the Falcon', rolls: [[18, 22]] },
      { ilvl: 55, weight: 110, of: 'of the Panther', name: 'of the Panther', rolls: [[23, 30]] },
    ],
  },
  {
    group: 'Intelligence', pools: ['armour', 'jewelry', 'belt', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `+${v[0]} to Intelligence`,
    tiers: [
      { ilvl: 1,  weight: 900, of: 'of the Student', name: 'of the Student', rolls: [[8, 12]] },
      { ilvl: 18, weight: 600, of: 'of the Prodigy', name: 'of the Prodigy', rolls: [[13, 17]] },
      { ilvl: 36, weight: 300, of: 'of the Savant', name: 'of the Savant', rolls: [[18, 22]] },
      { ilvl: 55, weight: 110, of: 'of the Genius', name: 'of the Genius', rolls: [[23, 30]] },
    ],
  },
  {
    group: 'AttackSpeed', pools: ['weapon', 'gloves'],
    render: (v) => `${v[0]}% increased Attack Speed`,
    tiers: [
      { ilvl: 1,  weight: 700, of: 'of Skill',    name: 'of Skill',    rolls: [[5, 7]] },
      { ilvl: 20, weight: 420, of: 'of Ease',     name: 'of Ease',     rolls: [[8, 10]] },
      { ilvl: 40, weight: 180, of: 'of Fervour',  name: 'of Fervour',  rolls: [[11, 13]] },
      { ilvl: 58, weight: 70,  of: 'of Celerity', name: 'of Celerity', rolls: [[14, 17]] },
    ],
  },
  {
    group: 'CastSpeed', pools: ['caster'],
    render: (v) => `${v[0]}% increased Cast Speed`,
    tiers: [
      { ilvl: 4,  weight: 600, of: 'of Talking',  name: 'of Talking',  rolls: [[5, 8]] },
      { ilvl: 24, weight: 340, of: 'of Menace',   name: 'of Menace',   rolls: [[9, 12]] },
      { ilvl: 44, weight: 130, of: 'of Rapidity', name: 'of Rapidity', rolls: [[13, 16]] },
    ],
  },
  {
    group: 'CritChance', pools: ['weapon'],
    render: (v) => `${v[0]}% increased Critical Strike Chance`,
    tiers: [
      { ilvl: 8,  weight: 500, of: 'of Needling', name: 'of Needling', rolls: [[10, 20]] },
      { ilvl: 30, weight: 260, of: 'of Incision', name: 'of Incision', rolls: [[21, 35]] },
      { ilvl: 50, weight: 90,  of: 'of Piercing', name: 'of Piercing', rolls: [[36, 50]] },
    ],
  },
  {
    group: 'LifeRegen', pools: ['armour', 'jewelry', 'belt', 'body', 'helm', 'gloves', 'boots'],
    render: (v) => `${v[0]} Life Regenerated per second`,
    tiers: [
      { ilvl: 3,  weight: 600, of: 'of Restoration', name: 'of Restoration', rolls: [[2, 4]] },
      { ilvl: 20, weight: 340, of: 'of Regrowth',    name: 'of Regrowth',    rolls: [[5, 8]] },
      { ilvl: 40, weight: 130, of: 'of Rejuvenation', name: 'of Rejuvenation', rolls: [[9, 14]] },
    ],
  },
  {
    group: 'MoveSpeed', pools: ['boots'],
    render: (v) => `${v[0]}% increased Movement Speed`,
    tiers: [
      { ilvl: 1,  weight: 500, of: 'of the Wind',  name: 'of the Wind',  rolls: [[10, 14]] },
      { ilvl: 20, weight: 280, of: 'of the Gale',  name: 'of the Gale',  rolls: [[15, 19]] },
      { ilvl: 40, weight: 90,  of: 'of Blurring',  name: 'of Blurring',  rolls: [[20, 25]] },
    ],
  },
  {
    group: 'ItemRarity', pools: ['armour', 'jewelry', 'helm', 'gloves', 'boots'],
    render: (v) => `${v[0]}% increased Rarity of Items found`,
    tiers: [
      { ilvl: 5,  weight: 300, of: 'of Plenty',   name: 'of Plenty',   rolls: [[6, 10]] },
      { ilvl: 30, weight: 160, of: 'of Fortune',  name: 'of Fortune',  rolls: [[11, 16]] },
      { ilvl: 55, weight: 55,  of: 'of Wealth',   name: 'of Wealth',   rolls: [[17, 24]] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Fixed unique mod sets (referenced by items.js generateUnique by unique name).
// ---------------------------------------------------------------------------
export const UNIQUE_MODS = {
  'Goldrim': {
    prefixes: [{ group: 'u_evasion', render: (v) => `+${v[0]} to Evasion Rating`, rolls: [[30, 60]] }],
    suffixes: [
      { group: 'u_allres', render: (v) => `+${v[0]}% to all Elemental Resistances`, rolls: [[30, 40]] },
      { group: 'u_rarity', render: (v) => `${v[0]}% increased Rarity of Items found`, rolls: [[30, 30]] },
    ],
  },
  'Wanderlust': {
    prefixes: [{ group: 'u_mana', render: (v) => `+${v[0]} to maximum Mana`, rolls: [[10, 20]] }],
    suffixes: [
      { group: 'u_ms', render: (v) => `${v[0]}% increased Movement Speed`, rolls: [[20, 20]] },
      { group: 'u_freeze', render: () => `Cannot be Frozen`, rolls: [] },
    ],
  },
  'Meginord\u2019s Girdle': {
    prefixes: [{ group: 'u_str', render: (v) => `+${v[0]} to Strength`, rolls: [[25, 35]] }],
    suffixes: [
      { group: 'u_phys', render: (v) => `${v[0]}% increased Physical Damage`, rolls: [[15, 25]] },
      { group: 'u_firered', render: () => `20% additional Fire Damage taken`, rolls: [] },
    ],
  },
  'Blackheart': {
    prefixes: [{ group: 'u_chaos', render: (v) => `Adds ${v[0]} to ${v[1]} Chaos Damage to Attacks`, rolls: [[3, 5], [7, 10]] }],
    suffixes: [
      { group: 'u_lifelow', render: (v) => `${v[0]}% increased Damage while on Low Life`, rolls: [[10, 15]] },
      { group: 'u_leech', render: () => `0.2% of Physical Attack Damage Leeched as Life`, rolls: [] },
    ],
  },
  'The Pariah': {
    prefixes: [],
    suffixes: [{ group: 'u_scaling', render: (v) => `${v[0]}% increased Rarity per unset Ring socket`, rolls: [[8, 12]] }],
  },
  'Reaper\u2019s Pursuit': {
    prefixes: [
      { group: 'u_physpct', render: (v) => `${v[0]}% increased Physical Damage`, rolls: [[80, 110]] },
      { group: 'u_flatphys', render: (v) => `Adds ${v[0]} to ${v[1]} Physical Damage`, rolls: [[10, 15], [22, 30]] },
    ],
    suffixes: [
      { group: 'u_leech', render: () => `0.4% of Physical Attack Damage Leeched as Life`, rolls: [] },
      { group: 'u_onkill', render: () => `Gain a Frenzy Charge on Kill`, rolls: [] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Eligibility + tier selection.
// ---------------------------------------------------------------------------
function poolMatches(pools, tags) {
  for (const p of pools) if (tags.includes(p)) return true;
  return false;
}

// Highest tier whose ilvl requirement <= item ilvl. Returns {tier, index}|null.
function bestTier(mod, ilvl) {
  let best = null, idx = -1;
  for (let i = 0; i < mod.tiers.length; i++) {
    const t = mod.tiers[i];
    if (t.ilvl <= ilvl) { if (!best || t.ilvl > best.ilvl) { best = t; idx = i; } }
  }
  return best ? { tier: best, index: idx } : null;
}

// Build the eligible weighted pool for one affix kind, excluding used groups.
function buildPool(list, tags, ilvl, usedGroups) {
  const out = [];
  for (const mod of list) {
    if (usedGroups.has(mod.group)) continue;
    if (!poolMatches(mod.pools, tags)) continue;
    const bt = bestTier(mod, ilvl);
    if (!bt) continue;
    out.push({ mod, tier: bt.tier, tierIndex: bt.index, weight: bt.tier.weight });
  }
  return out;
}

function weightedPick(pool) {
  let total = 0;
  for (const e of pool) total += e.weight;
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const e of pool) { r -= e.weight; if (r <= 0) return e; }
  return pool[pool.length - 1];
}

// tierName like "T2" — higher tier number == weaker (PoE convention: T1 best).
function tierLabel(mod, tierIndex) {
  return `T${mod.tiers.length - tierIndex}`;
}

function rollOne(entry, kind) {
  const vals = entry.tier.rolls.map((r) => ri(r[0], r[1]));
  return {
    kind,
    group: entry.mod.group,
    tier: mod2tier(entry),
    tierName: tierLabel(entry.mod, entry.tierIndex),
    word: kind === 'prefix' ? entry.tier.word : undefined,
    of: kind === 'suffix' ? entry.tier.of : undefined,
    name: entry.tier.name,
    ilvl: entry.tier.ilvl,
    text: entry.mod.render(vals),
    values: vals,
  };
}
function mod2tier(entry) { return entry.mod.tiers.length - entry.tierIndex; }

// ---------------------------------------------------------------------------
// rollAffixes — the public entry. Returns { prefixes:[], suffixes:[] }.
//   tags:       item tag array
//   ilvl:       item level (gates tiers)
//   maxPrefix:  cap prefixes (0/1/3)
//   maxSuffix:  cap suffixes (0/1/3)
//   minTotal:   guaranteed minimum affix count (magic:1, rare:4)
// ---------------------------------------------------------------------------
export function rollAffixes(tags, ilvl, maxPrefix, maxSuffix, minTotal = 0) {
  const prefixes = [];
  const suffixes = [];
  const usedGroups = new Set();

  // Target counts: bias toward "full" on rares, at least minTotal overall.
  let nP, nS;
  if (maxPrefix === 1 && maxSuffix === 1) {
    // magic: 1..2 affixes, split.
    const total = Math.random() < 0.55 ? 2 : 1;
    if (total === 2) { nP = 1; nS = 1; }
    else if (Math.random() < 0.5) { nP = 1; nS = 0; } else { nP = 0; nS = 1; }
  } else {
    // rare: weighted toward more affixes.
    nP = weightedCount(maxPrefix);
    nS = weightedCount(maxSuffix);
    while (nP + nS < minTotal) {
      if (nP < maxPrefix && (nS >= maxSuffix || Math.random() < 0.5)) nP++;
      else if (nS < maxSuffix) nS++;
      else if (nP < maxPrefix) nP++;
      else break;
    }
  }

  for (let i = 0; i < nP; i++) {
    const pool = buildPool(PREFIXES, tags, ilvl, usedGroups);
    const e = weightedPick(pool);
    if (!e) break;
    usedGroups.add(e.mod.group);
    prefixes.push(rollOne(e, 'prefix'));
  }
  for (let i = 0; i < nS; i++) {
    const pool = buildPool(SUFFIXES, tags, ilvl, usedGroups);
    const e = weightedPick(pool);
    if (!e) break;
    usedGroups.add(e.mod.group);
    suffixes.push(rollOne(e, 'suffix'));
  }

  // Guarantee minTotal even if a pool ran dry on one side.
  while (prefixes.length + suffixes.length < minTotal) {
    const canP = prefixes.length < maxPrefix;
    const canS = suffixes.length < maxSuffix;
    let added = false;
    if (canP) {
      const e = weightedPick(buildPool(PREFIXES, tags, ilvl, usedGroups));
      if (e) { usedGroups.add(e.mod.group); prefixes.push(rollOne(e, 'prefix')); added = true; }
    }
    if (!added && canS) {
      const e = weightedPick(buildPool(SUFFIXES, tags, ilvl, usedGroups));
      if (e) { usedGroups.add(e.mod.group); suffixes.push(rollOne(e, 'suffix')); added = true; }
    }
    if (!added) break; // no more eligible mods
  }

  return { prefixes, suffixes };
}

// Weighted affix count toward the cap: fuller items are rarer but favoured.
function weightedCount(max) {
  if (max <= 0) return 0;
  const r = Math.random();
  if (max === 3) { return r < 0.15 ? 1 : r < 0.5 ? 2 : 3; }
  if (max === 2) { return r < 0.4 ? 1 : 2; }
  return 1;
}

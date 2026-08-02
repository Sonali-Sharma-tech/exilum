// EXILIUM — skill catalog (owner: CombatSkills)
// Data-driven skill definitions. combat.js reads these; it never hardcodes a skill.
// PoE2 identity: skills feel weighty and MECHANICALLY DISTINCT — a cleave is not a
// recoloured fireball. Each entry declares its own delivery (cone/beam/nova/field/
// projectile/dash), its damage packet, its ailments, and its game-feel weights.
//
// Schema (every field optional unless noted):
//   id, name, key           input binding (key is informational; combat maps keys->id)
//   cost                    mana spent on a successful cast
//   cooldown                seconds; per-skill, on top of the global cooldown
//   castTime                anticipation window (s) before the strike resolves
//   recovery                lockout after the strike (s) — feeds animation pacing
//   channel                 { duration, tickRate } — makes it a held beam
//   dmg                     { base, type, critChance, penetration, added?, increased?, more? }
//   deliver                 'cone'|'circle'|'nova'|'beam'|'field'|'projectile'|'dash'
//   shape                   geometry for hitscan deliveries (range/angle/width/length)
//   projectile              spec consumed by projectiles.js
//   field                   { radius, duration, tickRate } for ground DoT
//   dash                    { distance, duration, iframes } for mobility
//   ailments                [{ type, chance, mag, dur }] applied per hit
//   knockback               0..1 base knockback scalar
//   impact                  { hitstop, shake } base game-feel weights (scaled by dmg/crit)
//   vfx                     { cast, hit, color } VFX_SPAWN kinds + saturated colour
//   sfx                     { cast, hit } SFX_PLAY ids

// Saturated ailment/element palette — bright against the desaturated world (rubric §2/§7).
export const TYPE_COLOR = {
  physical:  0xe9edf2,
  fire:      0xff6a1e,
  cold:      0x74c8ff,
  lightning: 0xffe259,
  chaos:     0xb14dff,
};
export const BLOOD_COLOR = 0xd21f24;

export const SKILLS = {
  // 1) MELEE CLEAVE — wide physical arc sweep. Weighty, knockback, hits everything in front.
  cleave: {
    id: 'cleave', name: 'Cleave', key: 'lmb',
    cost: 0, cooldown: 0, castTime: 0.14, recovery: 0.18,
    dmg: { base: 46, type: 'physical', critChance: 0.06, penetration: 0 },
    deliver: 'cone',
    shape: { type: 'cone', range: 3.1, angle: 1.9 },   // ~109° sweep
    ailments: [{ type: 'bleed', chance: 0.25, mag: 0.35, dur: 4 }],
    knockback: 0.5,
    impact: { hitstop: 1.0, shake: 1.0 },
    vfx: { cast: 'cleaveArc', hit: 'impact', color: TYPE_COLOR.physical },
    sfx: { cast: 'swing_heavy', hit: 'hit_flesh' },
  },

  // 2) RANGED PROJECTILE — a single heavy fireball that detonates in a small AoE and ignites.
  fireball: {
    id: 'fireball', name: 'Fireball', key: 'q',
    cost: 18, cooldown: 0, castTime: 0.26, recovery: 0.12,
    dmg: { base: 72, type: 'fire', critChance: 0.08, penetration: 0 },
    deliver: 'projectile',
    projectile: {
      speed: 26, radius: 0.5, lifetime: 1.7, gravity: 0,
      pierce: 0, chain: 0, fork: 0, homing: 0,
      detonate: { radius: 2.6, falloff: 0.4 },        // splash on impact/expire
      trail: { kind: 'projTrail', color: TYPE_COLOR.fire, rate: 0.02 },
    },
    ailments: [{ type: 'ignite', chance: 0.9, mag: 0.5, dur: 4 }],
    knockback: 0.25,
    impact: { hitstop: 1.15, shake: 1.05 },
    vfx: { cast: 'muzzle', hit: 'fireImpact', color: TYPE_COLOR.fire },
    sfx: { cast: 'cast_fire', hit: 'impact_fire' },
  },

  // 3) PIERCING + CHAINING PROJECTILE — a fast lightning lance that punches through the
  //    first target then arcs to nearby foes. Low per-hit, high total in a pack.
  stormLance: {
    // key 'w' -> 'f': W is now MOVE FORWARD (WASD locomotion in player.js). Every other
    // skill key was already clear of WASD; only this one collided.
    id: 'stormLance', name: 'Storm Lance', key: 'f',
    cost: 22, cooldown: 0, castTime: 0.2, recovery: 0.1,
    dmg: { base: 40, type: 'lightning', critChance: 0.09, penetration: 12 },
    deliver: 'projectile',
    projectile: {
      speed: 46, radius: 0.42, lifetime: 1.1, gravity: 0,
      pierce: 1, chain: 3, chainRange: 6.5, homing: 0,
      trail: { kind: 'projTrail', color: TYPE_COLOR.lightning, rate: 0.015 },
      chainVfx: 'chainArc',
    },
    ailments: [{ type: 'shock', chance: 0.6, mag: 0.15, dur: 4 }],
    knockback: 0.12,
    impact: { hitstop: 0.7, shake: 0.7 },
    vfx: { cast: 'muzzle', hit: 'lance', color: TYPE_COLOR.lightning },
    sfx: { cast: 'cast_lightning', hit: 'impact_lightning' },
  },

  // 4) AOE GROUND SLAM — big radial shockwave, huge knockback + stagger, the heaviest feel.
  groundSlam: {
    id: 'groundSlam', name: 'Ground Slam', key: 'e',
    cost: 30, cooldown: 2.4, castTime: 0.34, recovery: 0.26,
    dmg: { base: 118, type: 'physical', critChance: 0.10, penetration: 0 },
    deliver: 'circle',
    shape: { type: 'circle', range: 5.0 },
    ailments: [{ type: 'bleed', chance: 0.4, mag: 0.5, dur: 5 }],
    knockback: 1.0, stagger: 1.2,
    impact: { hitstop: 1.8, shake: 1.9 },               // this one should THUMP
    vfx: { cast: 'slamRing', hit: 'impact', color: TYPE_COLOR.physical },
    sfx: { cast: 'slam', hit: 'hit_heavy' },
  },

  // 5) CHANNELLED BEAM — held chaos beam, continuous ticks along a rectangle, builds poison.
  voidBeam: {
    id: 'voidBeam', name: 'Void Beam', key: 'r',
    cost: 14, cooldown: 0.6, castTime: 0.12, recovery: 0.1,
    channel: { duration: 1.6, tickRate: 0.09 },
    dmg: { base: 22, type: 'chaos', critChance: 0.05, penetration: 0 },
    deliver: 'beam',
    shape: { type: 'rect', length: 15, width: 1.3 },
    ailments: [{ type: 'poison', chance: 1.0, mag: 0.4, dur: 2.2 }],
    knockback: 0.04,
    impact: { hitstop: 0.28, shake: 0.5 },              // sustained, not punchy
    vfx: { cast: 'beam', hit: 'beamTip', color: TYPE_COLOR.chaos },
    sfx: { cast: 'beam_loop', hit: 'impact_chaos' },
  },

  // 6) NOVA / BURST — instant cold ring from the player, chills the pack and can freeze.
  frostNova: {
    id: 'frostNova', name: 'Frost Nova', key: '1',
    cost: 26, cooldown: 3.0, castTime: 0.16, recovery: 0.2,
    dmg: { base: 64, type: 'cold', critChance: 0.08, penetration: 0 },
    deliver: 'nova',
    shape: { type: 'circle', range: 4.6 },
    ailments: [{ type: 'chill', chance: 1.0, mag: 0.4, dur: 3 }, { type: 'freeze', chance: 0.35, mag: 0.6, dur: 1.4 }],
    knockback: 0.3,
    impact: { hitstop: 1.0, shake: 1.0 },
    vfx: { cast: 'nova', hit: 'frost', color: TYPE_COLOR.cold },
    sfx: { cast: 'nova_cold', hit: 'impact_cold' },
  },

  // 7) DoT FIELD — lingering caustic ground that ticks chaos + poison to anything standing in it.
  causticField: {
    id: 'causticField', name: 'Caustic Field', key: '2',
    cost: 34, cooldown: 4.0, castTime: 0.28, recovery: 0.18,
    dmg: { base: 18, type: 'chaos', critChance: 0.04, penetration: 0 },
    deliver: 'field',
    field: { radius: 3.2, duration: 5.0, tickRate: 0.4 },
    ailments: [{ type: 'poison', chance: 1.0, mag: 0.5, dur: 2 }],
    knockback: 0,
    impact: { hitstop: 0.12, shake: 0.18 },
    vfx: { cast: 'poisonField', hit: 'poisonTick', color: TYPE_COLOR.chaos },
    sfx: { cast: 'cast_chaos', hit: 'tick_poison' },
  },

  // 8) MOBILITY / UTILITY — a blink dash with i-frames that erupts a small displacement nova
  //    on arrival (utility first, tiny payload second). Respects walls via moveCapsule.
  blink: {
    id: 'blink', name: 'Blink Step', key: 'space',
    cost: 20, cooldown: 1.1, castTime: 0.0, recovery: 0.08,
    dmg: { base: 30, type: 'lightning', critChance: 0.05, penetration: 0 },
    deliver: 'dash',
    dash: { distance: 6.5, duration: 0.16, iframes: 0.28, arriveRadius: 2.4 },
    ailments: [{ type: 'shock', chance: 0.3, mag: 0.1, dur: 2 }],
    knockback: 0.4,
    impact: { hitstop: 0.5, shake: 0.6 },
    vfx: { cast: 'blink', hit: 'nova', color: TYPE_COLOR.lightning },
    sfx: { cast: 'blink', hit: 'impact_lightning' },
  },

  // 9) FORK PROJECTILE — glacial shards that split into two on the first hit, chilling a spread.
  glacialShards: {
    id: 'glacialShards', name: 'Glacial Shards', key: '3',
    cost: 24, cooldown: 0, castTime: 0.22, recovery: 0.12,
    dmg: { base: 34, type: 'cold', critChance: 0.07, penetration: 0 },
    deliver: 'projectile',
    projectile: {
      speed: 34, radius: 0.4, lifetime: 1.2, gravity: 0,
      pierce: 0, chain: 0, fork: 2, forkAngle: 0.42, homing: 0,
      trail: { kind: 'projTrail', color: TYPE_COLOR.cold, rate: 0.02 },
    },
    ailments: [{ type: 'chill', chance: 0.8, mag: 0.3, dur: 2.5 }],
    knockback: 0.15,
    impact: { hitstop: 0.7, shake: 0.65 },
    vfx: { cast: 'muzzle', hit: 'frost', color: TYPE_COLOR.cold },
    sfx: { cast: 'cast_cold', hit: 'impact_cold' },
  },

  // 10) HOMING SEEKER — a slow chaos orb that curves toward the nearest foe; area detonation.
  hexSeeker: {
    id: 'hexSeeker', name: 'Hex Seeker', key: '4',
    cost: 28, cooldown: 1.6, castTime: 0.24, recovery: 0.12,
    dmg: { base: 58, type: 'chaos', critChance: 0.07, penetration: 8 },
    deliver: 'projectile',
    projectile: {
      speed: 16, radius: 0.55, lifetime: 3.0, gravity: 0,
      pierce: 0, chain: 0, fork: 0, homing: 6.5, homingRange: 14,
      detonate: { radius: 2.9, falloff: 0.35 },
      trail: { kind: 'projTrail', color: TYPE_COLOR.chaos, rate: 0.025 },
    },
    ailments: [{ type: 'poison', chance: 0.9, mag: 0.6, dur: 3 }],
    knockback: 0.2,
    impact: { hitstop: 1.05, shake: 0.95 },
    vfx: { cast: 'muzzle', hit: 'impact', color: TYPE_COLOR.chaos },
    sfx: { cast: 'cast_chaos', hit: 'impact_chaos' },
  },
};

// Key -> skill id. combat.js resolves EV.PLAYER_CAST {skill} through this if `skill`
// is a raw input key; a direct skill id passes through unchanged.
export const KEY_TO_SKILL = {
  lmb: 'cleave', attack: 'cleave',
  // 'w' REMOVED, 'f' added: W is movement now. This table is the real binding — changing
  // only `stormLance.key` left KEY_TO_SKILL['f'] undefined, so buildBar() silently skipped
  // the slot (8 slots instead of 9) and pressing F resolved through a different path to
  // Fireball. Caught by listening for the PLAYER_CAST event rather than inferring from mana,
  // which regen (14.5/s) had been masking.
  q: 'fireball', f: 'stormLance', e: 'groundSlam', r: 'voidBeam',
  '1': 'frostNova', '2': 'causticField', '3': 'blink', '4': 'hexSeeker',
  space: 'blink', roll: 'blink',
};

export function resolveSkill(ref) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref.id ? (SKILLS[ref.id] || ref) : ref;
  return SKILLS[ref] || SKILLS[KEY_TO_SKILL[ref]] || null;
}

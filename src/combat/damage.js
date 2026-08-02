// EXILIUM — damage pipeline (owner: CombatSkills)
// PoE-style, deterministic, inspectable. No allocation on the hot path:
// computeDamage writes into a reused breakdown object and returns it.
//
// Layer order (this order is load-bearing — changing it changes balance):
//   base -> +added(flat) -> *(1 + increased/100) -> *more(product)
//        -> crit roll -> mitigation (armour | resistance) -> shock -> accuracy
//
// Determinism: pass an rng() -> [0,1). Same inputs + same rng stream => same result.
import { CFG } from '../core/config.js';

export const DMG_TYPES = ['physical', 'fire', 'cold', 'lightning', 'chaos'];
export const ELEMENTS = ['fire', 'cold', 'lightning'];

// Armour diminishing curve: reduction = armour / (armour + K * rawHit).
// Big hits punch through armour; chip hits are heavily mitigated (PoE behaviour).
export const ARMOUR_K = 10;
export const MAX_PHYS_REDUCTION = 0.90;     // armour is never a full wall
export const RES_CAP = 0.90;                // clamp resist high side
export const RES_FLOOR = -1.0;              // -100% res => double damage
export const EVASION_EXP = 0.8;             // entropy-free accuracy curve exponent
export const MIN_HIT_CHANCE = 0.05;         // you can always graze

// Physical reduction from armour against a specific raw hit.
export function armourReduction(armour, rawHit) {
  if (armour <= 0 || rawHit <= 0) return 0;
  return Math.min(MAX_PHYS_REDUCTION, armour / (armour + ARMOUR_K * rawHit));
}

// Multiplier a resistance applies to an incoming elemental/chaos hit.
// penetration ignores that many resistance percentage points.
export function resistFactor(resists, type, penetration = 0) {
  const raw = (resists && resists[type]) || 0;
  const eff = Math.max(RES_FLOOR * 100, Math.min(RES_CAP * 100, raw - penetration));
  return 1 - eff / 100;
}

// Chance to land, accuracy vs evasion (PoE-style, no entropy accumulator here).
export function hitChance(accuracy, evasion) {
  if (accuracy <= 0) return MIN_HIT_CHANCE;
  if (evasion <= 0) return 1;
  const c = accuracy / (accuracy + Math.pow(evasion / 4, EVASION_EXP));
  return Math.max(MIN_HIT_CHANCE, Math.min(1, c));
}

// Reused breakdown — read it immediately after the call (or copy what you need).
const _bd = {
  hit: false, crit: false, type: 'physical',
  base: 0, added: 0, flat: 0, afterIncrease: 0, afterMore: 0, afterCrit: 0,
  reduction: 0, resist: 1, shock: 0, mitigated: 0, final: 0, overkill: 0,
};

/**
 * @param spec {
 *   base, type, added?, increased?, more?, hits?,
 *   critChance?, critMulti?, canMiss?, accuracy?, penetration?
 * }
 * @param target entity: { armour?, resists?, evasion?, shock?, maxHp?, hp? }
 * @param rng    () -> [0,1)
 * @returns the shared breakdown object
 */
export function computeDamage(spec, target, rng) {
  const bd = _bd;
  const type = spec.type || 'physical';
  bd.type = type;
  bd.base = spec.base || 0;
  bd.added = spec.added || 0;

  // 1) additive flat, 2) increased (additive pool), 3) more (multiplicative)
  const flat = bd.base + bd.added;
  const incr = 1 + (spec.increased || 0) / 100;
  const moreM = spec.more == null ? 1 : spec.more;
  bd.flat = flat;
  bd.afterIncrease = flat * incr;
  bd.afterMore = bd.afterIncrease * moreM;

  // 4) crit — roll first so the pre-mitigation number is what we crit-scale
  const critChance = spec.critChance || 0;
  const crit = critChance > 0 && rng() < critChance;
  const critMulti = crit ? (spec.critMulti || CFG.combat.critMultiplier) : 1;
  bd.crit = crit;
  bd.afterCrit = bd.afterMore * critMulti;

  // 5) accuracy — spells set canMiss=false; attacks roll to hit
  let hit = true;
  if (spec.canMiss) {
    hit = rng() < hitChance(spec.accuracy || 1000, (target && target.evasion) || 0);
  }
  bd.hit = hit;
  if (!hit) {
    bd.reduction = 0; bd.resist = 1; bd.shock = 0; bd.mitigated = 0; bd.final = 0; bd.overkill = 0;
    return bd;
  }

  // 6) mitigation — physical uses armour vs this specific hit; ele/chaos use resist
  let mit = bd.afterCrit;
  if (type === 'physical') {
    const red = armourReduction((target && target.armour) || 0, bd.afterCrit);
    bd.reduction = red; bd.resist = 1;
    mit *= 1 - red;
  } else {
    const rf = resistFactor(target && target.resists, type, spec.penetration || 0);
    bd.reduction = 0; bd.resist = rf;
    mit *= rf;
  }

  // 7) shock amplifies all damage taken by the target
  const shock = (target && target.shock) || 0;
  bd.shock = shock;
  mit *= 1 + shock;

  bd.mitigated = mit;
  bd.final = Math.max(0, Math.round(mit));
  const hp = target && target.hp != null ? target.hp : bd.final;
  bd.overkill = Math.max(0, bd.final - hp);
  return bd;
}

// Small, fast, seedable PRNG so combat rolls are reproducible in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

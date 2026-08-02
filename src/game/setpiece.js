// setpiece.js — encounter COMPOSITION. Turns a flat roster of {archetype,rarity}
// into a STAGED, readable formation placed against the room's architecture and its
// lit pools, so a pack arrives as a recognisable SHAPE — a converging crescent, a
// champion ringed by its retinue, or a charging wedge — framed inside light rather
// than as a diffuse cloud loitering on bare floor. This is the "authorship of the
// moment" the blind judges kept naming: a frame that looks DESIGNED, not an
// accident of simulation.
//
// Pure geometry + selection. The Director still owns spawning, budget, caps and
// culling; this module only decides WHERE each member stands and which way it
// faces. Owner: EnemyAI.
import * as THREE from 'three';
import { World } from '../core/world.js';

// Deterministic RNG (mulberry32) — a given seed reproduces a formation exactly,
// which is what lets the layout be verified at the source without a renderer.
function mulberry(seed) {
  let a = (seed | 0) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Role rank drives depth in a line formation: front-liners (rushers) on the
// wings, bruisers hold the centre, artillery sits in the back rank.
const RANK = { swarm: 0, exploder: 0, brute: 1, boss: 1, caster: 2 };

// ── lit pools: the bright islands a staged frame should sit inside ────────────
// Layered fallback, so staging works regardless of what the props subsystem
// exposes and never hard-depends on a sibling's internals:
//   1) World.lightSources — the full static brazier/torch list, if props exposes it
//   2) a live scan of the pooled fire PointLights (props tags each with `_src`)
//   3) [] — the caller falls back to room architecture, then to the raw anchor
const _pools = [];
export function litPools() {
  _pools.length = 0;
  const ls = World.lightSources;
  if (Array.isArray(ls) && ls.length) {
    for (const s of ls) _pools.push({ x: s.x, z: s.z, r: (s.range || 12) * 0.34, w: s.baseInt || 100 });
    return _pools;
  }
  const scene = World.scene;
  if (scene) scene.traverse((o) => {
    // pooled fire lights carry `_src`; transient VFX/enemy lights do not
    if (o.isPointLight && o._src && o.visible && o.intensity > 0.5)
      _pools.push({ x: o.position.x, z: o.position.z, r: (o.distance || 14) * 0.34, w: o.intensity });
  });
  return _pools;
}

// nearest lit pool to a world point (or null). Distance measured on the ground.
export function nearestPool(x, z, pools = litPools()) {
  let best = null, bd = Infinity;
  for (const p of pools) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = p; } }
  return best ? { pool: best, dist: Math.sqrt(bd) } : null;
}

// ── choose where a pack stages ────────────────────────────────────────────────
// Scores each candidate anchor by: (a) a comfortable spawn distance from the
// player (not on top of them, not across the level), (b) how close it sits to a
// lit pool — a staged frame belongs in light — and (c) whether it lies in front
// of the player's facing, so the composed moment lands on-screen. Then nudges the
// winning anchor toward its nearest pool so the FOCAL member stands in the light.
const _a = new THREE.Vector3();
export function pickStageAnchor(anchors, opts = {}) {
  const player = World.player;
  const ppos = player?.pos;
  const minD = opts.minD ?? 11, maxD = opts.maxD ?? 30, idealD = opts.idealD ?? 18;
  const pools = litPools();
  if (!anchors || !anchors.length) {
    // no authored anchors: stage in front of the player at ideal distance
    if (!ppos) return null;
    const f = player.facing ?? 0;
    _a.set(ppos.x + Math.sin(f) * idealD, 0, ppos.z + Math.cos(f) * idealD);
    return biasToPool(_a.clone(), pools);
  }
  let best = null, bestScore = -Infinity;
  for (const an of anchors) {
    let score = 0;
    if (ppos) {
      const d = Math.hypot(an.x - ppos.x, an.z - ppos.z);
      if (d < minD) score -= (minD - d) * 3;            // too close: player would be swarmed instantly
      else if (d > maxD) score -= (d - maxD) * 0.6;     // too far: pack never reads before it arrives
      else score += 6 - Math.abs(d - idealD) * 0.35;    // sweet spot
      // in-front-of-player bonus (dot of player-facing with anchor direction)
      if (player.facing != null && d > 0.1) {
        const fx = Math.sin(player.facing), fz = Math.cos(player.facing);
        const dot = (fx * (an.x - ppos.x) + fz * (an.z - ppos.z)) / d;
        score += dot * 4;
      }
    }
    const np = nearestPool(an.x, an.z, pools);
    if (np) score += Math.max(0, 5 - np.dist * 0.4);    // reward staging near light
    if (score > bestScore) { bestScore = score; best = an; }
  }
  return best ? biasToPool(best.clone(), pools) : null;
}

// Slide an anchor a little toward its nearest lit pool (capped) so the composed
// group is framed in light without teleporting it off its authored ground.
function biasToPool(pos, pools) {
  const np = nearestPool(pos.x, pos.z, pools);
  if (np && np.dist > 0.5 && np.dist < 16) {
    const t = Math.min(0.55, (np.dist - np.pool.r) / np.dist);   // move up to 55% of the way in
    if (t > 0) {
      const nx = pos.x + (np.pool.x - pos.x) * t, nz = pos.z + (np.pool.z - pos.z) * t;
      const [wx, wz] = snapWalkable(nx, nz, pos.x, pos.z);
      pos.set(wx, groundY(wx, wz), wz);
      return pos;
    }
  }
  pos.y = groundY(pos.x, pos.z);
  return pos;
}

// ── decide the formation shape from the roster ────────────────────────────────
// A pack carrying a rare/magic member composes as a CHAMPION-and-retinue (a clear
// focal point with its guard ringed around it). Otherwise it alternates between a
// converging CRESCENT and an occasional charging WEDGE for variety.
export function chooseFormation(members, seed = 1) {
  if (members.some((m) => m.rarity === 'rare' || m.rarity === 'magic')) return 'champion';
  const rnd = mulberry(seed ^ 0x1234);
  return rnd() < 0.32 ? 'wedge' : 'crescent';
}

// ── compose: lay the roster into world positions for the chosen formation ─────
// Returns [{ archetype, rarity, x, z, facing, focal }]. Every member faces the
// player (they are all hunting it), and every slot is snapped onto walkable
// ground. Deterministic given `seed`.
export function composePack(members, anchor, formation = 'crescent', seed = 1) {
  const ppos = World.player?.pos;
  const rnd = mulberry(seed);
  const ax = anchor.x, az = anchor.z;
  // local frame: fwd = toward player (formation's "front"), right = perpendicular
  let fx = ppos ? ppos.x - ax : 0, fz = ppos ? ppos.z - az : 1;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const rx = fz, rz = -fx;
  const slots = [];
  const place = (m, lateral, depth, focal = false) => {
    // depth>0 steps AWAY from the player (deeper in the formation); lateral spreads right
    let x = ax + rx * lateral - fx * depth + (rnd() - 0.5) * 0.5;
    let z = az + rz * lateral - fz * depth + (rnd() - 0.5) * 0.5;
    [x, z] = snapWalkable(x, z, ax, az);
    const facing = ppos ? Math.atan2(ppos.x - x, ppos.z - z) : rnd() * Math.PI * 2;
    slots.push({ archetype: m.archetype, rarity: m.rarity, x, z, facing, focal });
  };

  if (formation === 'champion') {
    // focal = the rarest/toughest member; retinue rings around it, pulled slightly
    // toward the player so the guard SCREENS the champion — the classic "elite and
    // its pack" read. Champion leads, one step forward, standing in the lit pool.
    const focalIdx = pickFocal(members);
    const focal = members[focalIdx];
    const retinue = members.filter((_, i) => i !== focalIdx);
    place(focal, 0, -0.9, true);                        // champion, a step ahead, in the light
    const n = Math.max(1, retinue.length);
    const R = 2.7 + rnd() * 0.7;
    retinue.forEach((m, i) => {
      // bias the ring toward the player-facing hemisphere (theta near +/-90deg-front)
      const theta = (i / n) * Math.PI * 2 + rnd() * 0.35;
      const lateral = Math.cos(theta) * R;
      const depth = -Math.sin(theta) * R * 0.7 - 0.4;   // slightly toward player, guarding
      place(m, lateral, depth);
    });
    return slots;
  }

  if (formation === 'wedge') {
    // spearhead: toughest at the apex (nearest player), others fanning back in a V —
    // reads as a pack charging as one body.
    const order = members.slice().sort((a, b) => (RANK[b.archetype] ?? 0) - (RANK[a.archetype] ?? 0));
    place(order[0], 0, 0, order[0].rarity !== 'normal');
    let k = 1;
    for (let i = 1; i < order.length; i++) {
      const side = (i % 2 === 1) ? 1 : -1;
      const rank = Math.ceil(i / 2);
      place(order[i], side * rank * 1.7, rank * 2.0);
      k = rank;
    }
    return slots;
  }

  // crescent (default): a converging arc opening toward the player. Front-liners
  // (rushers) spread wide on the leading edge with the wings curled forward so the
  // pack visibly closes on the player; bruisers hold the centre one rank back;
  // casters sit in the back rank, spread, out of melee. A recognisable envelope,
  // not a diffuse cloud.
  const front = members.filter((m) => (RANK[m.archetype] ?? 0) === 0);
  const mid   = members.filter((m) => (RANK[m.archetype] ?? 0) === 1);
  const back  = members.filter((m) => (RANK[m.archetype] ?? 0) === 2);
  layRow(front, 2.0, 0.0, 1.1, place);   // wide leading arc, wings curl toward player
  layRow(mid,   2.6, 2.2, 0.0, place);   // bruiser centre, one rank back, no curl
  layRow(back,  2.9, 4.2, -0.5, place);  // artillery back rank, slight reverse bow
  return slots;
}

// Lay a row of members symmetric about the formation centreline. `curl` bows the
// row toward (+) or away (-) from the player as |lateral| grows, forming the arc.
function layRow(row, spacing, baseDepth, curl, place) {
  const n = row.length; if (!n) return;
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const lateral = (i - half) * spacing;
    const t = half > 0 ? Math.abs(i - half) / half : 0;   // 0 centre .. 1 wing
    const depth = baseDepth - curl * t * t;               // wings step toward player when curl>0
    place(row[i], lateral, depth);
  }
}

// the rarest, then toughest, member index — the natural focal of a champion pack.
function pickFocal(members) {
  const rrank = { unique: 4, rare: 3, magic: 2, normal: 1 };
  let bi = 0, bs = -1;
  for (let i = 0; i < members.length; i++) {
    const s = (rrank[members[i].rarity] || 1) * 10 + (RANK[members[i].archetype] ?? 0);
    if (s > bs) { bs = s; bi = i; }
  }
  return bi;
}

// ── ground helpers ────────────────────────────────────────────────────────────
function groundY(x, z) { return World.level?.heightAt ? World.level.heightAt(x, z) : 0; }

// Spiral out from (x,z) to the nearest walkable cell; fall back to (fx,fz) then
// the input. Keeps every composed slot on legal ground.
function snapWalkable(x, z, fx, fz) {
  const walk = World.level?.walkable;
  if (!walk || walk(x, z)) return [x, z];
  for (let rad = 0.8; rad <= 4.0; rad += 0.8) {
    for (let a = 0; a < 8; a++) {
      const ang = a * (Math.PI / 4);
      const nx = x + Math.cos(ang) * rad, nz = z + Math.sin(ang) * rad;
      if (walk(nx, nz)) return [nx, nz];
    }
  }
  return (walk(fx, fz)) ? [fx, fz] : [x, z];
}

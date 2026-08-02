#!/usr/bin/env node
// SOURCE probe for the cool-island lever — no camera, no renderer. Owner: CoolIsland.
//
// The acceptance question metrics can't fully answer ("does the cool region read as a
// LIT POOL with falloff, or a flat WASH?") reduces to ONE tonemap-independent geometric
// fact: the cool PointLight's floor-irradiance profile. THREE punctual decay=2 + finite
// range:  E(rho) = I * h / d^3 * [saturate(1 - (d/range)^4)]^2,  d = sqrt(rho^2 + h^2),
// h = mount height above floor, rho = horizontal distance from the light's ground point.
// The h/d^3 Lambert*inverse-square term is EXACT for a flat floor; the window is THREE's
// getDistanceAttenuation verbatim. Absolute scale carries one constant common to every
// light, so PROFILE SHAPE and light:light RATIOS are exact — which is all an island test
// needs. It does NOT predict rendered HUE or screen-space spatialVariation (ACES shifts
// hue +20-30deg; world-space variance was measured to move OPPOSITE the screen metric).
// Those come from the actual render via analyze.mjs. This tool answers only: rim or wash.
//
// A FILL: range ~= room diagonal (window never bites inside the room) AND/OR high mount
//         (inverse-cube core spread soft) -> E nearly flat across the floor, lifts the
//         dark corners, evens the frame, kills spatialVariation.
// An ISLAND: tighter range (a hard dark rim lands INSIDE the frame) + lower mount (core
//         radius ~ h, peak ~ I/h^2) + higher mult to hold the cool fraction -> a compact
//         bright core falling to a visible dark rim = a lit/unlit boundary = structure.
//
// usage: coolprobe.mjs <crypt|arena> [mult offsetFrac height rangeMul]   (omit to read current)
import { generateDungeon, KIND } from '../src/world/dungeon.js';

const SKYLIGHT_BASE = 300;            // sky.js skylightBase
// Current committed SKY.coolPool values (sky.js) — the defaults this probe reads.
const CURRENT = {
  crypt: { mult: 3.2, offsetFrac: 0.52, height: 11, rangeMul: 1.5 },
  arena: { mult: 4.0, offsetFrac: 0.50, height: 8,  rangeMul: 1.35 },
};
const DIR = { x: -1, z: -1 };         // SKY.coolPool.dir (toward camera-far)

const roomName = process.argv[2] || 'crypt';
const KMAP = { crypt: KIND.CRYPT, arena: KIND.ARENA, nave: KIND.NAVE };
const L = generateDungeon(1337, { wallHeight: 5.5 });
const rm = L.rooms.find((r) => r.kind === KMAP[roomName]);
if (!rm) { console.error('no room', roomName); process.exit(2); }

const radius = rm.radius || 8, fy = rm.floorY ?? 0;
const hw = rm.hw, hd = rm.hd, cx = rm.cx, cz = rm.cz;

const a = process.argv.slice(3).map(Number);
const cp = a.length === 4
  ? { mult: a[0], offsetFrac: a[1], height: a[2], rangeMul: a[3] }
  : CURRENT[roomName];

const I = SKYLIGHT_BASE * cp.mult;
const h = cp.height;
const range = radius * cp.rangeMul;
const dl = Math.hypot(DIR.x, DIR.z) || 1;
const off = radius * cp.offsetFrac;
const lx = cx + (DIR.x / dl) * off, lz = cz + (DIR.z / dl) * off;   // cool light ground point

// Floor irradiance from the cool light at horizontal distance rho.
function Ecool(rho) {
  const d = Math.hypot(rho, h);
  const w = Math.max(0, 1 - Math.pow(d / range, 4));
  return I * h / (d * d * d) * (w * w);
}
const peak = Ecool(0);

// Radius where E falls to a fraction of peak (island: these land INSIDE the room half-span).
function radiusAt(frac) {
  const t = peak * frac;
  for (let rho = 0; rho <= range; rho += 0.05) if (Ecool(rho) < t) return +rho.toFixed(2);
  return null;
}

// Room-floor coverage: sample the room rect, fraction of walkable floor above frac*peak.
function coverage(frac) {
  const t = peak * frac; let hit = 0, tot = 0;
  for (let x = cx - hw; x <= cx + hw; x += 0.4)
    for (let z = cz - hd; z <= cz + hd; z += 0.4) {
      tot++; const rho = Math.hypot(x - lx, z - lz); if (Ecool(rho) >= t) hit++;
    }
  return +(100 * hit / tot).toFixed(1);
}

// Distance from the cool light ground point to each room edge midpoint & the far corner,
// vs range: does the pool reach (and flood) the walls, or fall dark before them?
const toFarCorner = Math.max(
  Math.hypot((cx + hw) - lx, (cz + hd) - lz), Math.hypot((cx - hw) - lx, (cz - hd) - lz),
  Math.hypot((cx + hw) - lx, (cz - hd) - lz), Math.hypot((cx - hw) - lx, (cz + hd) - lz));
const toNearCorner = Math.min(
  Math.hypot((cx + hw) - lx, (cz + hd) - lz), Math.hypot((cx - hw) - lx, (cz - hd) - lz),
  Math.hypot((cx + hw) - lx, (cz - hd) - lz), Math.hypot((cx - hw) - lx, (cz + hd) - lz));

const prof = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((rho) =>
  rho <= range + 2 ? { rho, E: +Ecool(rho).toFixed(3), pct: +(100 * Ecool(rho) / peak).toFixed(1) } : null).filter(Boolean);

console.log(JSON.stringify({
  room: roomName, params: cp,
  geom: { radius, hw, hd, roomHalfMin: Math.min(hw, hd), floorY: fy,
          coolLightGround: { x: +lx.toFixed(2), z: +lz.toFixed(2) }, mountAboveFloor: h,
          range: +range.toFixed(2), offsetDist: +off.toFixed(2) },
  peakE: +peak.toFixed(3),
  // Island diagnostics:
  coreRadius50pct: radiusAt(0.5),   // core: where E halves. Island wants this SMALL (~ h).
  rim20pct: radiusAt(0.2),          // rim: where E hits 20%. Island wants this INSIDE roomHalfMin.
  rim10pct: radiusAt(0.1),
  coverage50pct: coverage(0.5),     // % of room floor above half-peak. Island: SMALL. Fill: LARGE.
  coverage20pct: coverage(0.2),     // % above 20%. Fill floods -> ~100.
  reach: { toNearCorner: +toNearCorner.toFixed(2), toFarCorner: +toFarCorner.toFixed(2),
           rangeCutsBeforeFarCorner: range < toFarCorner,   // true => a dark rim exists on the far side
           rangeCutsBeforeNearCorner: range < toNearCorner },
  profile: prof,
}, null, 1));

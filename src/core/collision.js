// Level collision primitives shared by physics.js (capsule move, rigid bodies,
// ragdolls). Everything here is grid-based against World.level's walkable()/
// heightAt() point tests — the level is a tile world (CFG.world.tile metres per
// cell) with axis-aligned walls, so axis-separated sliding is exact. Every
// function guards a null / half-built level: LevelForge populates World.level in
// parallel, so before it lands we behave as "open flat floor at y=0" rather than
// trapping or crashing callers.
import * as THREE from 'three';
import { World } from './world.js';
import { CFG } from './config.js';

export const TILE = CFG.world.tile;      // metres per dungeon cell
export const STEP_HEIGHT = 0.4;          // max height delta a capsule climbs smoothly

// 8 unit probe directions around a capsule's perimeter, precomputed once.
const PROBE = new Float32Array(16);
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  PROBE[i * 2] = Math.cos(a);
  PROBE[i * 2 + 1] = Math.sin(a);
}

/** Is the point (x,z) on walkable floor? Open floor when the level isn't ready. */
export function isWalkable(x, z) {
  const lvl = World.level;
  if (!lvl || !lvl.walkable) return true;
  return !!lvl.walkable(x, z);
}

/** Floor height at (x,z); 0 when the level isn't ready or returns a bad value. */
export function groundHeight(x, z) {
  const lvl = World.level;
  if (!lvl || !lvl.heightAt) return 0;
  const h = lvl.heightAt(x, z);
  return Number.isFinite(h) ? h : 0;
}

/** Is a capsule of radius r at (x,z) fully clear of walls (centre + 8 rim probes)? */
export function isClear(x, z, r) {
  if (!isWalkable(x, z)) return false;
  for (let i = 0; i < 8; i++) {
    if (!isWalkable(x + PROBE[i * 2] * r, z + PROBE[i * 2 + 1] * r)) return false;
  }
  return true;
}

/** Highest floor beneath a capsule footprint (centre + 4 cardinal rim samples). */
export function maxGroundUnder(x, z, r) {
  let h = groundHeight(x, z);
  let s = groundHeight(x + r, z); if (s > h) h = s;
  s = groundHeight(x - r, z); if (s > h) h = s;
  s = groundHeight(x, z + r); if (s > h) h = s;
  s = groundHeight(x, z - r); if (s > h) h = s;
  return h;
}

/**
 * Can a capsule of radius r stand at (x,z) given it currently rests at feet
 * height refY? Requires the spot to be wall-clear AND the floor under it to be
 * no more than STEP_HEIGHT above the feet (taller = a ledge/wall face to block).
 * Descending is always allowed — gravity / ground-snap handles the drop.
 */
export function canStep(x, z, r, refY) {
  if (!isClear(x, z, r)) return false;
  return maxGroundUnder(x, z, r) - refY <= STEP_HEIGHT;
}

/**
 * De-penetration direction for a capsule wedged in/against geometry. Writes a
 * normalized push (in the XZ plane) into `out` and returns true if blocked.
 * Sums the inward rim-probe hits and pushes away from them.
 */
export function pushOut(x, z, r, out) {
  let nx = 0, nz = 0, blocked = false;
  for (let i = 0; i < 8; i++) {
    if (!isWalkable(x + PROBE[i * 2] * r, z + PROBE[i * 2 + 1] * r)) {
      nx -= PROBE[i * 2]; nz -= PROBE[i * 2 + 1]; blocked = true;
    }
  }
  if (!blocked) { out.set(0, 0, 0); return false; }
  const l = Math.hypot(nx, nz);
  if (l < 1e-5) { out.set(1, 0, 0); return true; } // surrounded — pick an axis
  out.set(nx / l, 0, nz / l);
  return true;
}

/**
 * DDA voxel-march of a ray against the level grid and floor plane. Returns the
 * nearest of {wall hit, floor hit} as {point, normal, dist} or null. Used for
 * line-of-sight and projectile collision — fast enough for several calls/frame.
 */
export function raycast(origin, dir, maxDist = 100) {
  let dx = dir.x, dy = dir.y, dz = dir.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return null;
  const inv = 1 / len; dx *= inv; dy *= inv; dz *= inv;

  const lvl = World.level;
  if (!lvl || !lvl.walkable) {
    // No grid yet: only the flat floor at y=0 can be hit.
    if (dy < 0) {
      const t = -origin.y / dy;
      if (t >= 0 && t <= maxDist) {
        return {
          point: new THREE.Vector3(origin.x + dx * t, 0, origin.z + dz * t),
          normal: new THREE.Vector3(0, 1, 0), dist: t,
        };
      }
    }
    return null;
  }

  let cx = Math.floor(origin.x / TILE);
  let cz = Math.floor(origin.z / TILE);
  if (!isWalkable((cx + 0.5) * TILE, (cz + 0.5) * TILE)) {
    // Origin already inside a wall — degenerate hit facing back along the ray.
    return {
      point: new THREE.Vector3(origin.x, origin.y, origin.z),
      normal: new THREE.Vector3(-dx, 0, -dz), dist: 0,
    };
  }

  const stepX = dx >= 0 ? 1 : -1;
  const stepZ = dz >= 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(TILE / dz) : Infinity;
  const bx = dx >= 0 ? (cx + 1) * TILE : cx * TILE;
  const bz = dz >= 0 ? (cz + 1) * TILE : cz * TILE;
  let tMaxX = dx !== 0 ? (bx - origin.x) / dx : Infinity;
  let tMaxZ = dz !== 0 ? (bz - origin.z) / dz : Infinity;

  let tEnter = 0, guard = 0;
  while (tEnter <= maxDist && guard++ < 4096) {
    const tExit = Math.min(tMaxX, tMaxZ, maxDist);
    // Floor crossing inside the current cell.
    if (dy < 0) {
      const fh = groundHeight((cx + 0.5) * TILE, (cz + 0.5) * TILE);
      const tg = (fh - origin.y) / dy;
      if (tg >= tEnter - 1e-4 && tg <= tExit + 1e-4 && tg <= maxDist) {
        const tt = tg < 0 ? 0 : tg;
        return {
          point: new THREE.Vector3(origin.x + dx * tt, origin.y + dy * tt, origin.z + dz * tt),
          normal: new THREE.Vector3(0, 1, 0), dist: tt,
        };
      }
    }
    // Advance to the next cell boundary.
    let nx = 0, nz = 0;
    if (tMaxX <= tMaxZ) { cx += stepX; tEnter = tMaxX; tMaxX += tDeltaX; nx = -stepX; }
    else { cz += stepZ; tEnter = tMaxZ; tMaxZ += tDeltaZ; nz = -stepZ; }
    if (tEnter > maxDist) break;
    if (!isWalkable((cx + 0.5) * TILE, (cz + 0.5) * TILE)) {
      return {
        point: new THREE.Vector3(origin.x + dx * tEnter, origin.y + dy * tEnter, origin.z + dz * tEnter),
        normal: new THREE.Vector3(nx, 0, nz), dist: tEnter,
      };
    }
  }
  return null;
}

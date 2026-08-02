// terrain.js — bakes the dungeon layout's continuous fields into typed-array
// grids for O(1) per-frame queries (bilinear height, nearest walkable/surface),
// and meshes the natural earthen ground + flooded water surfaces.
import * as THREE from 'three';
import { floorHeightAt, walkableAt, surfaceCodeAt, SURFACE, SURFACE_NAME } from './dungeon.js';

// Module-scope temporaries — zero allocation in the per-frame query path.
const _n = new THREE.Vector3();

export function buildTerrain(layout, opts) {
  const mat = opts.mat;                 // (name) -> registered THREE.Material
  const res = opts.resolution ?? 0.5;   // metres per grid node
  const b = layout.bounds;
  const nx = Math.ceil((b.maxX - b.minX) / res) + 1;
  const nz = Math.ceil((b.maxZ - b.minZ) / res) + 1;
  const inv = 1 / res;

  const height = new Float32Array(nx * nz);
  const walk = new Uint8Array(nx * nz);
  const surf = new Uint8Array(nx * nz);

  // Bake. floorHeightAt/walkableAt/surfaceCodeAt are the layout's analytic fields;
  // we sample them once per node and never touch them again at runtime.
  for (let j = 0; j < nz; j++) {
    const z = b.minZ + j * res;
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const x = b.minX + i * res;
      const h = floorHeightAt(layout, x, z);
      height[row + i] = h;
      walk[row + i] = walkableAt(layout, x, z) ? 1 : 0;
      surf[row + i] = surfaceCodeAt(layout, x, z, h);
    }
  }

  // Ledge pass: a walkable node beside a TRUE height discontinuity (a pit rim,
  // corridor-edge/void bleed, or room-overlap cliff — node Δh over STEEP)
  // becomes an impassable ledge (walkable=0), insetting the walkable region one
  // step back from every cliff. Traversable ramps (altar/dais/stairs, whose
  // per-node Δh stays well under STEEP) are untouched, so heightAt reads a
  // smooth gradient on them and the platform tops stay reachable. This matches
  // PhysicsSim's STEP_HEIGHT ledge model: no walkable→walkable per-frame cliff.
  const STEEP = 0.6;
  const walk0 = walk.slice();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!walk0[idx]) continue;
      const h = height[idx];
      if ((i > 0 && Math.abs(height[idx - 1] - h) > STEEP) ||
          (i < nx - 1 && Math.abs(height[idx + 1] - h) > STEEP) ||
          (j > 0 && Math.abs(height[idx - nx] - h) > STEEP) ||
          (j < nz - 1 && Math.abs(height[idx + nx] - h) > STEEP)) {
        walk[idx] = 0;
      }
    }
  }

  const minX = b.minX, minZ = b.minZ;

  // --- O(1) bilinear height ---
  function heightAt(x, z) {
    let fx = (x - minX) * inv, fz = (z - minZ) * inv;
    if (fx < 0) fx = 0; else if (fx > nx - 1.001) fx = nx - 1.001;
    if (fz < 0) fz = 0; else if (fz > nz - 1.001) fz = nz - 1.001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const r0 = iz * nx + ix, r1 = r0 + nx;
    const h00 = height[r0], h10 = height[r0 + 1], h01 = height[r1], h11 = height[r1 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  // --- O(1) nearest walkable ---
  function walkAt(x, z) {
    let fx = (x - minX) * inv, fz = (z - minZ) * inv;
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > nz - 1) return false;
    return walk[(Math.round(fz)) * nx + Math.round(fx)] === 1;
  }
  // --- O(1) nearest surface code / name ---
  function surfCode(x, z) {
    let fx = (x - minX) * inv, fz = (z - minZ) * inv;
    if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
    if (fz < 0) fz = 0; else if (fz > nz - 1) fz = nz - 1;
    return surf[(Math.round(fz)) * nx + Math.round(fx)];
  }
  function surfaceAt(x, z) { return SURFACE_NAME[surfCode(x, z)]; }

  // Nearest walkable cell to (x,z) — snaps spawns off water/pit/ledge onto safe
  // ground. Ring search over the baked grid; returns {x,z} (input if none near).
  function nearestWalkable(x, z, maxR = 14) {
    if (walkAt(x, z)) return { x, z };
    const ci = Math.round((x - minX) * inv), cj = Math.round((z - minZ) * inv);
    const rMax = Math.ceil(maxR * inv);
    for (let r = 1; r <= rMax; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; // ring only
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          if (walk[j * nx + i] === 1) return { x: minX + i * res, z: minZ + j * res };
        }
      }
    }
    return { x, z };
  }

  // --- Approximate surface normal from the grid (for slope-aware placement) ---
  function normalAt(x, z, out) {
    const e = res;
    const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
    const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
    (out ?? _n).set(hL - hR, 2 * e, hD - hU).normalize();
    return out ?? _n;
  }

  // --- Meshes ---
  const meshes = [];

  // Base earthen understory over the whole footprint: guarantees no void shows
  // through flagstone gaps, and forms the natural floor of courtyard/pit/cistern.
  meshes.push(gridMesh(b.minX, b.maxX, b.minZ, b.maxZ, 1.15, mat('dirt'), (x, z) => heightAt(x, z) - 0.05, true));

  // Cistern silt bed under the flood — wet, low-roughness stone.
  for (const r of layout.rooms) {
    if (r.kind !== 'cistern') continue;
    meshes.push(gridMesh(r.cx - r.hw + 0.4, r.cx + r.hw - 0.4, r.cz - r.hd + 0.4, r.cz + r.hd - 0.4, 0.9, mat('wetStone'), (x, z) => heightAt(x, z) + 0.02, true));
  }

  // Water surfaces (self-animated by MaterialLab). Slight inset from walls.
  const water = [];
  for (const w of layout.waterAreas) {
    const g = new THREE.PlaneGeometry(w.maxX - w.minX, w.maxZ - w.minZ, 1, 1);
    worldUV(g);
    const m = new THREE.Mesh(g, mat('waterSurface'));
    m.rotation.x = -Math.PI / 2;
    m.position.set((w.minX + w.maxX) * 0.5, w.y, (w.minZ + w.maxZ) * 0.5);
    m.receiveShadow = true; m.renderOrder = 1;
    m.name = `water-${w.roomId}`;
    meshes.push(m); water.push(m);
  }

  return {
    nx, nz, res, heightAt, walkAt, surfaceAt, surfCode, normalAt, nearestWalkable, meshes, water,
    height, walk, surf, SURFACE,
    dispose() { for (const m of meshes) { m.geometry.dispose(); } },
  };

  // Build a displaced, world-UV'd grid mesh over a rect, sampling hFn for Y.
  function gridMesh(x0, x1, z0, z1, step, material, hFn, receive) {
    const sx = Math.max(1, Math.round((x1 - x0) / step));
    const sz = Math.max(1, Math.round((z1 - z0) / step));
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, sx, sz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx, wz = pos.getZ(i) + cz;
      pos.setX(i, wx); pos.setZ(i, wz);
      pos.setY(i, hFn(wx, wz));
    }
    geo.computeVertexNormals();
    worldUV(geo);
    const m = new THREE.Mesh(geo, material);
    m.receiveShadow = !!receive; m.castShadow = false;
    return m;
  }
}

// World-space UVs (1 uv = 1 world unit) + uv2 for aoMap. MaterialLab owns .repeat,
// so equal texel density everywhere with zero stretch on arbitrary-size meshes.
export function worldUV(geo) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i);
    uv[i * 2 + 1] = pos.getZ(i);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv2', new THREE.BufferAttribute(uv.slice(), 2));
}

// dungeon.js — procedural layout brain for the ruined cathedral/crypt complex.
// Pure data + O(1) field sampling. No THREE meshes are built here; level.js turns
// the build-plan into merged/instanced geometry and terrain.js bakes the
// height/walkable/surface fields into typed arrays for per-frame lookups.
import * as THREE from 'three';

// Seeded RNG (mulberry32) — one stream, a seed fully reproduces a level.
export class RNG {
  constructor(seed = 1337) { this.s = seed >>> 0; }
  next() {
    let t = (this.s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
}

// Surface enum — shared with terrain grid + AudioProc footsteps.
export const SURFACE = { STONE: 0, WETSTONE: 1, WATER: 2, RUBBLE: 3, WOOD: 4, GRASS: 5 };
export const SURFACE_NAME = ['stone', 'wetstone', 'water', 'rubble', 'wood', 'grass'];

export const KIND = {
  ENTRY: 'entry', NAVE: 'nave', CRYPT: 'crypt', CISTERN: 'cistern',
  COURTYARD: 'courtyard', COLLAPSED: 'collapsed', ARENA: 'arena',
};
// Rooms whose floor is natural earth/silt (terrain.js meshes these); the rest
// are paved with flagstone slabs by level.js.
const NATURAL = new Set([KIND.COURTYARD, KIND.CISTERN]);

// Value noise for floor subsidence — nothing in a ruin is perfectly flat.
function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
export function fbm(x, z, seed) {
  return 0.62 * vnoise(x, z, seed) + 0.28 * vnoise(x * 2.1 + 11, z * 2.1 - 7, seed ^ 0x9e3779b1)
    + 0.14 * vnoise(x * 4.3 - 3, z * 4.3 + 19, seed ^ 0x85ebca6b);
}
export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function inRoom(r, x, z) { return Math.abs(x - r.cx) <= r.hw && Math.abs(z - r.cz) <= r.hd; }
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 1e-6 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return { d: Math.hypot(px - cx, pz - cz), t };
}
function rectExit(r, tox, toz) {
  const dx = tox - r.cx, dz = toz - r.cz;
  const tx = dx !== 0 ? r.hw / Math.abs(dx) : Infinity;
  const tz = dz !== 0 ? r.hd / Math.abs(dz) : Infinity;
  const t = Math.min(tx, tz);
  return { x: r.cx + dx * t, z: r.cz + dz * t, edge: tx < tz ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N') };
}

export function generateDungeon(seed = 1337, cfg = {}) {
  const rng = new RNG(seed);
  const WALL_H = cfg.wallHeight ?? 5.5;

  // Rooms placed along a +X spine, branches on ±Z. Axis-aligned rects keep wall
  // building + world-UV clean; the fixed iso yaw turns the +X spine into a
  // diagonal leading line receding to the arena focal point.
  const J = () => rng.range(-3.5, 3.5);
  const def = [
    { kind: KIND.ENTRY,     cx: 0,   cz: 0,   hw: 8,  hd: 8,  floorY: 0.0 },
    { kind: KIND.NAVE,      cx: 36,  cz: 0,   hw: 19, hd: 9,  floorY: 0.0 },
    { kind: KIND.CRYPT,     cx: 40,  cz: -31, hw: 11, hd: 10, floorY: -2.1 },
    { kind: KIND.CISTERN,   cx: 56,  cz: 32,  hw: 12, hd: 11, floorY: -2.2, waterY: -1.6 },
    { kind: KIND.COURTYARD, cx: 74,  cz: -33, hw: 14, hd: 13, floorY: 0.25 },
    { kind: KIND.COLLAPSED, cx: 90,  cz: 24,  hw: 12, hd: 11, floorY: 0.0 },
    { kind: KIND.ARENA,     cx: 100, cz: 0,   hw: 18, hd: 17, floorY: 0.0 },
  ];
  const rooms = def.map((d, i) => {
    const cx = d.cx + (i === 0 ? 0 : J());
    const cz = d.cz + (i === 0 || i === 1 || i === 6 ? 0 : J());
    const hw = d.hw + rng.range(-1, 2), hd = d.hd + rng.range(-1, 2);
    const floorY = d.floorY + (i === 0 ? 0 : rng.range(-0.15, 0.15));
    const r = {
      id: i, kind: d.kind, cx, cz, hw, hd, floorY,
      radius: Math.hypot(hw, hd), flooded: d.waterY != null,
      waterY: d.waterY ?? null, natural: NATURAL.has(d.kind),
      boss: d.kind === KIND.ARENA, features: [], doorways: [],
    };
    buildFeatures(r, rng);
    return r;
  });

  // Connectivity: designed adjacency, union-find repair, then loop edges.
  const wanted = [[0, 1], [1, 2], [1, 3], [3, 5], [4, 5], [5, 6], [1, 6]];
  const parent = rooms.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const edges = [];
  const addEdge = (a, b) => { edges.push([a, b]); union(a, b); };
  for (const [a, b] of wanted) { if (find(a) !== find(b)) addEdge(a, b); else if (rng.chance(0.5)) edges.push([a, b]); }
  for (let i = 0; i < rooms.length; i++) {
    if (find(i) === find(0)) continue;
    let best = -1, bd = Infinity;
    for (let j = 0; j < rooms.length; j++) {
      if (find(j) !== find(0)) continue;
      const d = Math.hypot(rooms[i].cx - rooms[j].cx, rooms[i].cz - rooms[j].cz);
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) addEdge(i, best);
  }
  if (rng.chance(0.7)) edges.push([2, 4]);

  const corridors = [];
  for (const [ai, bi] of edges) {
    const a = rooms[ai], b = rooms[bi];
    const ea = rectExit(a, b.cx, b.cz), eb = rectExit(b, a.cx, a.cz);
    const width = rng.range(4.5, 6.5);
    corridors.push({ a: ai, b: bi, ax: ea.x, az: ea.z, bx: eb.x, bz: eb.z, width, floorA: a.floorY, floorB: b.floorY });
    a.doorways.push({ x: ea.x, z: ea.z, edge: ea.edge, w: width + 2 });
    b.doorways.push({ x: eb.x, z: eb.z, edge: eb.edge, w: width + 2 });
  }

  const walls = [], columns = [], arches = [], stairs = [], rubble = [], chunks = [], gates = [];
  for (const r of rooms) buildWalls(r, walls, rubble, gates, rng, WALL_H);
  buildColumns(rooms, columns, arches, chunks, rubble, rng);
  buildFeatureGeometry(rooms, corridors, stairs, rubble, chunks, rng);

  const waterAreas = [];
  for (const r of rooms) {
    if (r.flooded) waterAreas.push({ minX: r.cx - r.hw + 0.5, maxX: r.cx + r.hw - 0.5, minZ: r.cz - r.hd + 0.5, maxZ: r.cz + r.hd - 0.5, y: r.waterY, roomId: r.id });
  }
  const arena = rooms.find((r) => r.kind === KIND.ARENA);
  const gq = rng.int(0, 3), gsx = gq & 1 ? 1 : -1, gsz = gq & 2 ? 1 : -1, gy = arena.floorY - 0.45;
  arena.gutter = { sx: gsx, sz: gsz, y: gy };
  waterAreas.push({
    minX: gsx > 0 ? arena.cx + arena.hw * 0.28 : arena.cx - arena.hw + 1,
    maxX: gsx > 0 ? arena.cx + arena.hw - 1 : arena.cx - arena.hw * 0.28,
    minZ: gsz > 0 ? arena.cz + arena.hd * 0.28 : arena.cz - arena.hd + 1,
    maxZ: gsz > 0 ? arena.cz + arena.hd - 1 : arena.cz - arena.hd * 0.28,
    y: gy, roomId: arena.id,
  });

  const spawns = [];
  const alt = arena.features.find((f) => f.type === 'altar');
  spawns.push(new THREE.Vector3(arena.cx - (alt ? alt.rOuter + 3 : 6), 0, arena.cz));
  const ringN = rng.int(5, 6), rr = (alt ? alt.rOuter : 8) + 3.5;
  for (let i = 0; i < ringN; i++) {
    const ang = (i / ringN) * Math.PI * 2 + rng.range(-0.2, 0.2);
    spawns.push(new THREE.Vector3(arena.cx + Math.cos(ang) * rr, 0, arena.cz + Math.sin(ang) * rr));
  }
  for (const r of rooms) {
    if (r.kind === KIND.ENTRY || r.kind === KIND.ARENA) continue;
    const n = r.kind === KIND.NAVE ? 3 : rng.int(2, 3);
    for (let i = 0; i < n; i++) spawns.push(new THREE.Vector3(r.cx + rng.range(-r.hw * 0.55, r.hw * 0.55), 0, r.cz + rng.range(-r.hd * 0.55, r.hd * 0.55)));
  }
  const entry = rooms[0];
  const playerStart = new THREE.Vector3(entry.cx, 0, entry.cz);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.cx - r.hw); maxX = Math.max(maxX, r.cx + r.hw);
    minZ = Math.min(minZ, r.cz - r.hd); maxZ = Math.max(maxZ, r.cz + r.hd);
  }
  const M = 9;
  const bounds = { minX: minX - M, maxX: maxX + M, minZ: minZ - M, maxZ: maxZ + M };

  return { seed, rooms, corridors, walls, columns, arches, stairs, rubble, chunks, gates, waterAreas, spawns, playerStart, bounds, wallHeight: WALL_H };
}

// --- Per-room height features (mounds/pits/pools) — the vertical interest. ---
function buildFeatures(r, rng) {
  switch (r.kind) {
    case KIND.NAVE:
      r.features.push({ type: 'strip', halfW: 2.6, dh: 0.28 });
      r.features.push({ type: 'aisle', dh: -0.4 });
      break;
    case KIND.ARENA: {
      const rIn = rng.range(4.5, 5.5), rOut = rIn + rng.range(3.5, 4.5);
      r.features.push({ type: 'altar', x: r.cx + rng.range(-1.5, 1.5), z: r.cz + rng.range(-1.5, 1.5), r: rIn, rOuter: rOut, dh: rng.range(1.25, 1.6) });
      break;
    }
    case KIND.COURTYARD: {
      const rIn = rng.range(3.5, 4.5);
      r.features.push({ type: 'dais', x: r.cx + rng.range(-3, 3), z: r.cz + rng.range(-3, 3), r: rIn, rOuter: rIn + 4, dh: rng.range(0.8, 1.1) });
      r.features.push({ type: 'mound', x: r.cx + rng.range(-r.hw * 0.5, r.hw * 0.5), z: r.cz + rng.range(-r.hd * 0.5, r.hd * 0.5), r: 2, rOuter: 5, dh: 0.5 });
      break;
    }
    case KIND.COLLAPSED: {
      r.features.push({ type: 'pit', x: r.cx + rng.range(-3, 4), z: r.cz + rng.range(-3, 4), r: rng.range(3.5, 4.5), rOuter: rng.range(6, 7), depth: rng.range(3.0, 3.6) });
      r.features.push({ type: 'slab', x: r.cx - rng.range(3, 6), z: r.cz - rng.range(3, 6), r: 3, rOuter: 5.5, dh: rng.range(0.6, 0.9) });
      break;
    }
    case KIND.CISTERN:
      r.features.push({ type: 'bowl', x: r.cx, z: r.cz, r: 2.5, rOuter: Math.min(r.hw, r.hd), depth: 0.55 });
      break;
    case KIND.CRYPT:
      r.features.push({ type: 'mound', x: r.cx + rng.range(-4, 4), z: r.cz + rng.range(-4, 4), r: 1.6, rOuter: 4, dh: 0.4 });
      break;
    default: break;
  }
}

// Continuous height field. Called once per grid cell by terrain.js, then cached.
export function floorHeightAt(layout, x, z) {
  const { rooms, corridors } = layout;
  let best = null, bestScore = -Infinity;
  for (const r of rooms) {
    if (!inRoom(r, x, z)) continue;
    const score = -(((x - r.cx) / r.hw) ** 2 + ((z - r.cz) / r.hd) ** 2);
    if (score > bestScore) { bestScore = score; best = { y: roomHeight(r, x, z), src: r }; }
  }
  for (const c of corridors) {
    const s = segDist(x, z, c.ax, c.az, c.bx, c.bz);
    if (s.d > c.width * 0.5) continue;
    const y = c.floorA + (c.floorB - c.floorA) * s.t;
    const score = -s.d * 0.35 + 0.2;
    if (score > bestScore) { bestScore = score; best = { y, src: c }; }
  }
  if (best) return best.y + subside(layout, x, z, best.src);
  let nd = Infinity, ny = 0;
  for (const r of rooms) {
    const dx = Math.max(Math.abs(x - r.cx) - r.hw, 0), dz = Math.max(Math.abs(z - r.cz) - r.hd, 0);
    const d = Math.hypot(dx, dz);
    if (d < nd) { nd = d; ny = r.floorY; }
  }
  return ny - Math.min(nd * 0.12, 1.4) + subside(layout, x, z, null) * 0.5;
}

function roomHeight(r, x, z) {
  let y = r.floorY;
  for (const f of r.features) {
    switch (f.type) {
      case 'strip':
        if (Math.abs(z - r.cz) < f.halfW) y += f.dh * (1 - Math.abs(z - r.cz) / f.halfW);
        break;
      case 'aisle':
        y += f.dh * smoothstep(r.hd - 3.5, r.hd - 0.5, Math.abs(z - r.cz));
        break;
      case 'altar': case 'dais': case 'mound': case 'slab': {
        const d = Math.hypot(x - f.x, z - f.z);
        y += f.dh * (1 - smoothstep(f.r, f.rOuter, d));
        break;
      }
      case 'pit': {
        const d = Math.hypot(x - f.x, z - f.z);
        y -= f.depth * (1 - smoothstep(f.r, f.rOuter, d));
        break;
      }
      case 'bowl': {
        const d = Math.hypot(x - f.x, z - f.z);
        y -= f.depth * (1 - smoothstep(f.rOuter * 0.4, f.rOuter, d));
        break;
      }
      default: break;
    }
  }
  return y;
}

function subside(layout, x, z, src) {
  const kind = src && src.kind ? src.kind : null;
  let amp = 0.06;
  if (kind === KIND.COURTYARD) amp = 0.16;
  else if (kind === KIND.COLLAPSED) amp = 0.12;
  else if (kind === KIND.CISTERN) amp = 0.10;
  return (fbm(x * 0.22, z * 0.22, layout.seed) - 0.5) * 2 * amp;
}

// Walkability. Footprint minus wall borders / pits / deep water.
export function walkableAt(layout, x, z) {
  const { rooms, corridors } = layout;
  let onFoot = false, room = null;
  for (const c of corridors) { if (segDist(x, z, c.ax, c.az, c.bx, c.bz).d <= c.width * 0.5) { onFoot = true; break; } }
  if (!onFoot) {
    for (const r of rooms) { if (Math.abs(x - r.cx) <= r.hw - 0.7 && Math.abs(z - r.cz) <= r.hd - 0.7) { onFoot = true; room = r; break; } }
  } else {
    for (const r of rooms) if (inRoom(r, x, z)) { room = r; break; }
  }
  if (!onFoot) return false;
  if (room) {
    for (const f of room.features) if (f.type === 'pit' && Math.hypot(x - f.x, z - f.z) < f.r + 0.4) return false;
    if (room.flooded && floorHeightAt(layout, x, z) < room.waterY - 0.9) return false;
  }
  return true;
}

// Surface classification for footsteps / material selection.
export function surfaceCodeAt(layout, x, z, h) {
  const { rooms } = layout;
  if (h == null) h = floorHeightAt(layout, x, z);
  for (const w of layout.waterAreas) if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ && h < w.y) return SURFACE.WATER;
  let room = null;
  for (const r of rooms) if (inRoom(r, x, z)) { room = r; break; }
  if (!room) {
    for (const w of layout.waterAreas) if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ && h < w.y + 0.25) return SURFACE.WETSTONE;
    return SURFACE.STONE;
  }
  if (room.flooded && h < room.waterY + 0.3) return SURFACE.WETSTONE;
  switch (room.kind) {
    case KIND.COURTYARD: return fbm(x * 0.4, z * 0.4, layout.seed ^ 99) > 0.55 ? SURFACE.GRASS : SURFACE.STONE;
    case KIND.COLLAPSED: return SURFACE.RUBBLE;
    case KIND.CISTERN: return SURFACE.WETSTONE;
    default: return SURFACE.STONE;
  }
}

// Walls: perimeter runs split around doorways, jagged/collapsed/tilted.
function buildWalls(r, walls, rubble, gates, rng, WALL_H) {
  const sides = [
    { edge: 'N', a: [r.cx - r.hw, r.cz - r.hd], b: [r.cx + r.hw, r.cz - r.hd], nx: 0, nz: -1 },
    { edge: 'S', a: [r.cx - r.hw, r.cz + r.hd], b: [r.cx + r.hw, r.cz + r.hd], nx: 0, nz: 1 },
    { edge: 'W', a: [r.cx - r.hw, r.cz - r.hd], b: [r.cx - r.hw, r.cz + r.hd], nx: -1, nz: 0 },
    { edge: 'E', a: [r.cx + r.hw, r.cz - r.hd], b: [r.cx + r.hw, r.cz + r.hd], nx: 1, nz: 0 },
  ];
  const openAir = r.kind === KIND.COURTYARD;
  for (const s of sides) {
    const horiz = s.a[1] === s.b[1];
    const p0 = horiz ? s.a[0] : s.a[1], p1 = horiz ? s.b[0] : s.b[1];
    const gaps = [];
    for (const d of r.doorways) {
      const on = (s.edge === 'N' || s.edge === 'S') ? Math.abs(d.z - s.a[1]) < 1.5 : Math.abs(d.x - s.a[0]) < 1.5;
      if (!on) continue;
      const c = horiz ? d.x : d.z;
      gaps.push([c - d.w * 0.5, c + d.w * 0.5, true]);
      gates.push(makeGate(r, s, c, WALL_H));
    }
    const nGap = openAir ? rng.int(2, 3) : rng.int(0, 2);
    for (let i = 0; i < nGap; i++) {
      const gc = rng.range(p0 + 3, p1 - 3), gw = rng.range(2.5, openAir ? 7 : 4.5);
      gaps.push([gc - gw * 0.5, gc + gw * 0.5, false]);
    }
    gaps.sort((a, b) => a[0] - b[0]);
    const flush = (from, to) => {
      let x = from;
      while (to - x > 0.8) {
        const segLen = Math.min(rng.range(3.5, 6.5), to - x);
        const midP = x + segLen * 0.5;
        const mx = horiz ? midP : s.a[0], mz = horiz ? s.a[1] : midP;
        const dmg = rng.next();
        const h = WALL_H * (openAir ? rng.range(0.35, 0.7) : rng.range(0.72, 1.02));
        walls.push({
          x: mx, z: mz, len: segLen, thick: rng.range(0.85, 1.15), height: h,
          rot: horiz ? 0 : Math.PI / 2, tilt: rng.range(-0.05, 0.05) + (dmg > 0.7 ? rng.range(-0.09, 0.09) : 0),
          crown: rng.range(0.5, 1.4), seed: (rng.next() * 1e9) | 0, buttress: !openAir && rng.chance(0.28),
          nx: s.nx, nz: s.nz,
        });
        if (rng.chance(0.5)) rubble.push({ x: mx + s.nx * rng.range(0.6, 1.6), z: mz + s.nz * rng.range(0.6, 1.6), scale: rng.range(0.5, 1.2), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
        x += segLen + rng.range(0, 0.6);
      }
    };
    let cur = p0;
    for (const g of gaps) { flush(cur, Math.max(cur, g[0])); cur = Math.max(cur, g[1]); if (g[2]) placeDoorRubble(r, s, (g[0] + g[1]) * 0.5, rubble, rng); }
    flush(cur, p1);
  }
}
function makeGate(r, s, c, WALL_H) {
  const horiz = s.a[1] === s.b[1];
  return { x: horiz ? c : s.a[0], z: horiz ? s.a[1] : c, rot: horiz ? 0 : Math.PI / 2, span: 4.6, height: WALL_H * 0.92, baseY: r.floorY };
}
function placeDoorRubble(r, s, c, rubble, rng) {
  const horiz = s.a[1] === s.b[1];
  const x = horiz ? c : s.a[0], z = horiz ? s.a[1] : c;
  if (rng.chance(0.6)) rubble.push({ x: x + rng.range(-1, 1), z: z + rng.range(-1, 1), scale: rng.range(0.6, 1.1), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
}

// Columns + arches + fallen chunks. Irregular spacing, collapse, lean, crack.
function buildColumns(rooms, columns, arches, chunks, rubble, rng) {
  const nave = rooms.find((r) => r.kind === KIND.NAVE);
  if (nave) {
    const rowZ = nave.hd - 2.2;
    for (const sgn of [-1, 1]) {
      let x = nave.cx - nave.hw + 3;
      while (x < nave.cx + nave.hw - 3) {
        const z = nave.cz + sgn * rowZ + rng.range(-0.5, 0.5);
        if (rng.chance(0.22)) {
          const fall = rng.range(0, 6.28);
          for (let k = 0; k < rng.int(2, 4); k++) chunks.push({ x: x + Math.cos(fall) * k * 1.5, z: z + Math.sin(fall) * k * 1.5, scale: rng.range(0.8, 1.2), rot: fall + rng.range(-0.4, 0.4), variant: rng.int(0, 3) });
          rubble.push({ x, z, scale: rng.range(0.9, 1.4), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
        } else {
          columns.push({ x, z, height: rng.range(4.6, 5.6), radius: rng.range(0.5, 0.66), variant: rng.int(0, 3), tilt: rng.chance(0.35) ? rng.range(0.03, 0.12) : rng.range(-0.02, 0.02), tiltDir: rng.range(0, 6.28), rot: rng.range(0, 6.28), scale: rng.range(0.92, 1.12) });
          rubble.push({ x: x + rng.range(-1, 1), z: z + rng.range(-1, 1), scale: rng.range(0.4, 0.8), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
        }
        x += rng.range(5.5, 7.5);
      }
    }
    const std = columns.filter((c) => Math.abs(c.z - nave.cz) > 2);
    for (const a of std) {
      const partner = std.find((b) => b !== a && Math.abs(b.x - a.x) < 2.5 && Math.sign(b.z - nave.cz) !== Math.sign(a.z - nave.cz));
      if (partner && a.z < nave.cz && rng.chance(0.55)) {
        arches.push({ x: (a.x + partner.x) * 0.5, z: nave.cz, span: Math.abs(partner.z - a.z), height: Math.min(a.height, partner.height) + rng.range(1.6, 2.4), rot: 0, broken: rng.chance(0.55), baseY: nave.floorY, seed: (rng.next() * 1e9) | 0 });
      }
    }
    for (let i = 0; i < rng.int(3, 5); i++) chunks.push({ x: nave.cx + rng.range(-nave.hw * 0.7, nave.hw * 0.7), z: nave.cz + rng.range(-2, 2), scale: rng.range(1.1, 1.8), rot: rng.range(0, 6.28), variant: rng.int(0, 3) });
  }
  const arena = rooms.find((r) => r.kind === KIND.ARENA);
  if (arena) {
    const alt = arena.features.find((f) => f.type === 'altar');
    const cx = alt ? alt.x : arena.cx, cz = alt ? alt.z : arena.cz;
    const ringR = (alt ? alt.rOuter : 9) + 3.2, n = 8;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rng.range(-0.08, 0.08);
      const px = cx + Math.cos(ang) * ringR * rng.range(0.92, 1.08);
      const pz = cz + Math.sin(ang) * ringR * rng.range(0.92, 1.08);
      if (Math.abs(px - arena.cx) > arena.hw - 2 || Math.abs(pz - arena.cz) > arena.hd - 2) continue;
      if (rng.chance(0.25)) { chunks.push({ x: px, z: pz, scale: rng.range(1, 1.5), rot: ang, variant: rng.int(0, 3) }); continue; }
      columns.push({ x: px, z: pz, height: rng.range(5.4, 6.6), radius: rng.range(0.6, 0.78), variant: rng.int(0, 3), tilt: rng.chance(0.3) ? rng.range(0.03, 0.1) : 0, tiltDir: ang, rot: rng.range(0, 6.28), scale: rng.range(1, 1.2) });
    }
  }
}

// Stairs at real height transitions + altar/dais approaches.
function buildFeatureGeometry(rooms, corridors, stairs, rubble, chunks, rng) {
  for (const c of corridors) {
    const dy = c.floorB - c.floorA;
    if (Math.abs(dy) < 0.7) continue;
    const dx = c.bx - c.ax, dz = c.bz - c.az, L = Math.hypot(dx, dz) || 1;
    stairs.push({ x: (c.ax + c.bx) * 0.5, z: (c.az + c.bz) * 0.5, dirX: dx / L, dirZ: dz / L, width: c.width, run: L * 0.7, yLow: Math.min(c.floorA, c.floorB), yHigh: Math.max(c.floorA, c.floorB), seed: (rng.next() * 1e9) | 0 });
  }
  for (const r of rooms) {
    for (const f of r.features) {
      if (f.type === 'altar' || f.type === 'dais') {
        const ang = r.kind === KIND.ARENA ? Math.PI : rng.range(0, 6.28);
        stairs.push({ x: f.x + Math.cos(ang) * (f.rOuter - 0.5), z: f.z + Math.sin(ang) * (f.rOuter - 0.5), dirX: -Math.cos(ang), dirZ: -Math.sin(ang), width: f.r * 1.4, run: f.rOuter - f.r, yLow: r.floorY, yHigh: r.floorY + f.dh, seed: (rng.next() * 1e9) | 0, radial: true });
        for (let i = 0; i < rng.int(2, 4); i++) { const a = rng.range(0, 6.28), d = f.r + rng.range(0.5, 2); rubble.push({ x: f.x + Math.cos(a) * d, z: f.z + Math.sin(a) * d, scale: rng.range(0.6, 1.2), rot: rng.range(0, 6.28), variant: rng.int(0, 2) }); }
      }
      if (f.type === 'pit') {
        for (let i = 0; i < rng.int(4, 7); i++) { const a = rng.range(0, 6.28), d = f.r + rng.range(-0.5, 1.5); chunks.push({ x: f.x + Math.cos(a) * d, z: f.z + Math.sin(a) * d, scale: rng.range(0.8, 1.6), rot: rng.range(0, 6.28), variant: rng.int(0, 3) }); }
      }
    }
    if (r.kind === KIND.COLLAPSED || r.kind === KIND.CRYPT) {
      for (let i = 0; i < rng.int(4, 8); i++) rubble.push({ x: r.cx + rng.range(-r.hw * 0.8, r.hw * 0.8), z: r.cz + rng.range(-r.hd * 0.8, r.hd * 0.8), scale: rng.range(0.5, 1.3), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
    }
    // Corner rubble accumulation in every enclosed room.
    if (r.kind !== KIND.COURTYARD) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (!rng.chance(0.6)) continue;
        rubble.push({ x: r.cx + sx * (r.hw - rng.range(1, 2.5)), z: r.cz + sz * (r.hd - rng.range(1, 2.5)), scale: rng.range(0.7, 1.5), rot: rng.range(0, 6.28), variant: rng.int(0, 2) });
      }
    }
  }
}

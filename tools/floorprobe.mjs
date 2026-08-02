#!/usr/bin/env node
// SOURCE probe for the floor bond bias — no camera, no renderer.
//
// Replicates the EXACT `fr` draw sequence of emitRoomFloors (level.js) so the slab
// footprints it produces are byte-identical to what renders, then rasterises the room
// floor top-down into an occupancy grid (stone=1, joint/gap=0) and measures directional
// gradient energy. The screen "corduroy" is the projection of the joint GEOMETRY (proven:
// the anisotropy survives stripping every floor map), so joint-edge anisotropy in world
// space is the mechanism the screen metric sees through the iso projection.
//
// Measures gradient energy crossing each world axis and each world 45-degree diagonal:
//   Gx  crosses HEAD joints (constant-x mortar lines, staggered)
//   Gz  crosses BEDDING joints (constant-z mortar lines — the long full-width lines)
// A strict running bond => Gz dominant (long collinear bedding lines). v2 should push
// Gz/Gx toward 1 (isotropy) WITHOUT reducing total joint energy (that would be deleting
// structure, not decorrelating it).
//
// usage: floorprobe.mjs <room=nave|arena|crypt> <bond=baseline|v2> [seedXor=0x71005eed]
import { generateDungeon, KIND, RNG } from '../src/world/dungeon.js';

const roomName = process.argv[2] || 'nave';
const bond = process.argv[3] || 'v2';
const seedXor = process.argv[4] ? Number(process.argv[4]) : 0x71005eed;
const v2 = bond === 'v2';

const layout = generateDungeon(1337, { wallHeight: 5.5 });
const KMAP = { nave: KIND.NAVE, arena: KIND.ARENA, crypt: KIND.CRYPT, entry: KIND.ENTRY };
const room = layout.rooms.find((r) => r.kind === KMAP[roomName]);
if (!room) { console.error('no room', roomName); process.exit(2); }

// pitBlocks — identical to level.js
function pitBlocks(r, x, z) {
  for (const f of r.features) if (f.type === 'pit' && Math.hypot(x - f.x, z - f.z) < f.r + 0.6) return true;
  return false;
}

// Reproduce emitRoomFloors for ONE room, collecting placed slab footprints.
// The RNG is the SHARED fr stream over ALL paved rooms, so to get a given room's
// footprints byte-identical we must run the stream from the start over every paved room
// in order and only KEEP the target room's slabs. draw-for-draw faithful.
const PAVED = new Set([KIND.ENTRY, KIND.NAVE, KIND.CRYPT, KIND.COLLAPSED, KIND.ARENA]);
const GAP = 0.12;
const fr = new RNG((seedXor ^ ((layout.seed ?? 1337) | 0)) >>> 0);
const slabs = [];   // {jx,jz,w,d} for the TARGET room only

for (const r of layout.rooms) {
  if (!PAVED.has(r.kind)) continue;
  const keep = r === room;
  const x0 = r.cx - r.hw + 0.5, x1 = r.cx + r.hw - 0.5;
  const z0 = r.cz - r.hd + 0.5, z1 = r.cz + r.hd - 0.5;
  const missP = r.kind === KIND.COLLAPSED ? 0.2 : 0.07;
  let z = z0;
  while (z < z1 - 0.35) {
    let rowD = fr.range(v2 ? 1.15 : 1.3, v2 ? 2.35 : 2.1);
    if (z + rowD > z1) rowD = z1 - z;
    const czRow = z + rowD * 0.5;
    let x = x0 + fr.range(0, v2 ? 2.9 : 1.7);
    while (x < x1 - 0.3) {
      let sw = fr.range(1.5, 2.9);
      if (fr.chance(0.12)) sw *= fr.range(1.25, 1.6);
      if (x + sw > x1) sw = x1 - x;
      const cxS = x + sw * 0.5;
      let sd = rowD, czS = czRow;
      if (v2) {
        // env-tunable knobs (defaults == level.js current v2) for cheap sweeping
        const P = process.env;
        const dLo = +(P.DEPTH_LO ?? 0.86), dHi = +(P.DEPTH_HI ?? 1.34);
        const dblP = +(P.DOUBLE_P ?? 0.14), dblLo = +(P.DOUBLE_LO ?? 1.55), dblHi = +(P.DOUBLE_HI ?? 2.05);
        const jzF = +(P.JZFRAC ?? 0.30);
        let depth = rowD * fr.range(dLo, dHi);
        if (fr.chance(dblP)) depth *= fr.range(dblLo, dblHi);
        const jz2 = rowD * jzF;
        czS = czRow + fr.range(-jz2, jz2);
        let lo = czS - depth * 0.5, hi = czS + depth * 0.5;
        lo = Math.max(lo, z0 - 0.4); hi = Math.min(hi, z1 + 0.4);
        sd = Math.max(0.6, hi - lo); czS = (lo + hi) * 0.5;
        fr.range(0, 0.006);           // yMicro (consumed; irrelevant to footprint)
      }
      const jx = cxS + fr.range(-0.05, 0.05), jz = czS + fr.range(-0.05, 0.05);
      if (sw > 0.7 && sd > 0.7 && !pitBlocks(r, jx, jz) && !fr.chance(missP)) {
        if (fr.chance(0.26)) fr.range(0.03, 0.14);          // sink
        const gjx = GAP + fr.range(0, 0.10) + (fr.chance(0.10) ? fr.range(0.10, 0.30) : 0);
        const gjz = GAP + fr.range(0, 0.10) + (fr.chance(0.10) ? fr.range(0.10, 0.30) : 0);
        const w = Math.max(0.5, sw - gjx), d = Math.max(0.5, sd - gjz);
        fr.range(-0.03, 0.03); fr.range(0, 0.035); fr.range(0, 6.28);   // box rotY,tilt,tiltDir
        // stoneFloor is ATLAS -> slabAtlasUV: int + next(mirror) + next(ccu) + next(ccv)
        // crypt is cobble (TINTED) -> slabUV: int + next(ou) + next(ov)
        const atlas = (r.kind !== KIND.CRYPT && r.kind !== KIND.COLLAPSED);
        if (atlas) { fr.int(0, 3); fr.next(); fr.next(); fr.next(); }
        else { fr.int(0, 3); fr.next(); fr.next(); }
        fr.next(); fr.next();                                // paintSlab val,warm
        if (keep) slabs.push({ jx, jz, w, d });
      }
      x += sw + GAP + fr.range(0, 0.14);
    }
    z += rowD + fr.range(0, 0.12);
  }
}

// Rasterise footprints into a top-down occupancy grid over the room's paved rect.
const RES = 10;                                   // px per world unit
const bx0 = room.cx - room.hw + 0.5, bx1 = room.cx + room.hw - 0.5;
const bz0 = room.cz - room.hd + 0.5, bz1 = room.cz + room.hd - 0.5;
const W = Math.round((bx1 - bx0) * RES), H = Math.round((bz1 - bz0) * RES);
const occ = new Uint8Array(W * H);
for (const s of slabs) {
  const gx0 = Math.max(0, Math.floor((s.jx - s.w * 0.5 - bx0) * RES));
  const gx1 = Math.min(W, Math.ceil((s.jx + s.w * 0.5 - bx0) * RES));
  const gz0 = Math.max(0, Math.floor((s.jz - s.d * 0.5 - bz0) * RES));
  const gz1 = Math.min(H, Math.ceil((s.jz + s.d * 0.5 - bz0) * RES));
  for (let gz = gz0; gz < gz1; gz++) for (let gx = gx0; gx < gx1; gx++) occ[gz * W + gx] = 1;
}

// Directional joint-edge energy: count of occupancy transitions crossing a direction,
// at a step matching a mortar width (~1-2 px). Use step=1 (edge detector on the mask).
function edgeEnergy(dx, dz) {
  let e = 0, n = 0;
  for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    const nx = gx + dx, nz = gz + dz;
    if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
    e += occ[gz * W + gx] !== occ[nz * W + nx] ? 1 : 0; n++;
  }
  return e / Math.max(n, 1);
}
const Gx = edgeEnergy(1, 0);      // crosses head (constant-x) joints
const Gz = edgeEnergy(0, 1);      // crosses bedding (constant-z) joints — the corduroy
const Gd = edgeEnergy(1, 1);      // world main diagonal
const Ga = edgeEnergy(1, -1);     // world anti-diagonal
const occupancy = occ.reduce((a, b) => a + b, 0) / (W * H);

console.log(JSON.stringify({
  room: roomName, bond, seedXor: '0x' + (seedXor >>> 0).toString(16), slabCount: slabs.length,
  gridWH: [W, H], occupancy: +occupancy.toFixed(4),
  Gx_headJoints: +Gx.toFixed(5), Gz_beddingJoints: +Gz.toFixed(5),
  GzOverGx_beddingBias: +(Gz / Math.max(Gx, 1e-9)).toFixed(4),
  Gdiag: +Gd.toFixed(5), Ganti: +Ga.toFixed(5),
  diagOverAnti: +(Gd / Math.max(Ga, 1e-9)).toFixed(4),
  totalJointEnergy: +((Gx + Gz + Gd + Ga)).toFixed(5),
}, null, 2));

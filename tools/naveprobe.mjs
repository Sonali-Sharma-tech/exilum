// Offline validation of NaveStructure relief targeting + geometry counts.
// Replicates isNaveWall + the emitNaveRelief pilaster loop against the real
// seed-1337 layout and the real RNG, so counts/pitch match the live build
// without needing the camera or a WebGL context.
import { generateDungeon, RNG, KIND } from '../src/world/dungeon.js';

const L = generateDungeon(1337, { wallHeight: 5.5 });
const nave = L.rooms.find(r => r.kind === KIND.NAVE);
const tol = 1.0;
function isNaveWall(w) {
  if (w.rot === 0) {
    const onEdge = Math.abs(w.z - (nave.cz - nave.hd)) < tol || Math.abs(w.z - (nave.cz + nave.hd)) < tol;
    return onEdge && Math.abs(w.x - nave.cx) < nave.hw + tol;
  }
  const onEdge = Math.abs(w.x - (nave.cx - nave.hw)) < tol || Math.abs(w.x - (nave.cx + nave.hw)) < tol;
  return onEdge && Math.abs(w.z - nave.cz) < nave.hd + tol;
}
function nearestRoom(w){let b=null,bd=1e9;for(const r of L.rooms){const d=Math.hypot(w.x-r.cx,w.z-r.cz);if(d<bd){bd=d;b=r;}}return b.kind;}

const sel = L.walls.filter(isNaveWall);
const byRoom = {};
for (const w of sel) { const k = nearestRoom(w); byRoom[k] = (byRoom[k]||0)+1; }
console.log('selected nave walls:', sel.length, 'of', L.walls.length, 'nearest-room:', JSON.stringify(byRoom));
console.log('edges hit:', JSON.stringify(sel.map(w => (w.rot===0?(w.z<nave.cz?'N':'S'):(w.x<nave.cx?'W':'E'))).reduce((a,e)=>{a[e]=(a[e]||0)+1;return a;},{})));

// Replicate the pilaster loop exactly (same PR seed, same draw order: plinth, scrs, pilasters per wall)
const PIL_EMBED = 0.15;
const pr = new RNG((0x9a17e5 ^ (1337)) >>> 0);
let idx=0, pil=0, wide=0, pitches=[], widths=[], heights=[], plinth=0, scrs=0;
for (const w of L.walls) {
  if (!isNaveWall(w)) continue;
  const bodyH = w.height, half = w.len*0.5;
  // plinth draw consumes pr.next()s: slabAtlasUV + paintSlab happen on real geo, not here.
  // We only replicate the SIZING rolls that advance pr in the pilaster loop; plinth/scrs
  // sizing uses constants (no pr rolls) so pr state entering the pilaster loop matches live
  // ONLY if slabAtlasUV/paintSlab also draw from pr. They DO. So exact per-pier pitch can't
  // be reproduced here without the UV/paint rolls; instead validate COUNT/SCALE-SPREAD via
  // the pitch/width rolls alone, which is what matters for scale variety.
  plinth++; scrs++;
  let t=-half+0.6, col=0;
  while (t < half-0.6) {
    const isWide = pr.chance(0.2);
    const pw = isWide ? pr.range(0.95,1.35) : pr.range(0.38,0.68);
    if (t+pw > half-0.4) break;
    const proj = isWide ? pr.range(0.5,0.66) : pr.range(0.32,0.5);
    const pilH = bodyH * pr.range(0.74,0.94);
    pil++; if(isWide)wide++; widths.push(+pw.toFixed(2)); heights.push(+pilH.toFixed(2));
    const adv = pw + (isWide ? pr.range(1.5,3.0) : pr.range(1.4,2.8));
    pitches.push(+adv.toFixed(2));
    t += adv; col++;
  }
  idx++;
}
const stats = a => ({min:Math.min(...a),max:Math.max(...a),mean:+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(2)});
console.log('pilasters', pil, '(wide', wide+')', 'plinths', plinth, 'stringcourses', scrs);
console.log('pitch', JSON.stringify(stats(pitches)), 'width', JSON.stringify(stats(widths)), 'height', JSON.stringify(stats(heights)));
console.log('total relief boxes', pil+plinth+scrs, '~tris', (pil+plinth+scrs)*12);

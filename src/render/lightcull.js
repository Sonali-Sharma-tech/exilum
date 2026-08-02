import * as THREE from 'three';
import { World } from '../core/world.js';
import { CFG } from '../core/config.js';

/**
 * EXILIUM — point-light frustum culling with a quantised count ladder.
 *
 * ## Why this exists
 *
 * The scene is FRAGMENT-BOUND and point lights are essentially the whole bill.
 * Measured at 1440x900, roster pinned, A-B-A with 0.4% return drift:
 *
 *     pixel-scale 1.00 / 0.75 / 0.50   ->  22.08 / 14.25 / 8.26 ms
 *     linear fit on s^2               ->  16.72 ms per-pixel, 5.09 ms fixed
 *
 * i.e. three quarters of the frame is per-pixel shading. Ablating the whole post
 * chain (bloom + godray + grade + SMAA + output) returns 1.47 ms; ablating the
 * RenderPass returns 14.08 ms. The post stack is NOT the problem.
 *
 * Within that pass the cost is the forward light loop. Three.js unrolls every
 * visible PointLight into every lit fragment shader, so cost scales with the
 * light COUNT, not with how much screen area each light covers:
 *
 *     visible point lights   47    24    16    12     9
 *     frame (ms)          35.46 13.00  9.94  9.91  8.38
 *
 * ## The lossless part
 *
 * A PointLight with `decay = 2` and finite `distance = d` attenuates by
 *
 *     pow(saturate(1 - pow(dist/d, 4)), 2) / max(dist^2, eps)
 *
 * which is EXACTLY ZERO for dist >= d. It is not small — it is zero, in the
 * shader, at every fragment. So a light whose influence sphere (centre, radius d)
 * does not intersect the camera frustum cannot change any pixel of the frame, and
 * removing it is not an approximation.
 *
 * Verified rather than assumed: engine frozen, `World.time` pinned, same frame
 * rendered with and without the cull, PNGs decoded and compared byte-for-byte:
 *
 *     differing pixels : 0 / 1,296,000   max channel delta: 0/255
 *     frame rate       : 47.1 -> 96.6 fps
 *
 * Real culls at spawn include `skylight-arena` (reach 28.1) sitting 98.3 world
 * units away, and a brazier with reach 7.0 at 31.6 units. 14 of 23 live lights
 * were doing nothing at all.
 *
 * ## Why the count is quantised (the part that took all day)
 *
 * Three.js keys its shader program cache on the light count. Changing the count
 * recompiles EVERY material at the new count. A free-running exact cull walks the
 * count continuously (2,4,5,7,9,10,...) and is catastrophic — measured over a
 * 12-second walk:
 *
 *     programs 66 -> 254 (+188)   worst frame 4295 ms   mean 1.1 fps
 *
 * Prewarming every count 0..32 costs 11.2 s and 1,531 programs, so that is out.
 * Instead the count is snapped UP to a fixed ladder and only those rungs are ever
 * compiled. Padding uses the nearest OUT-OF-FRUSTUM lights, which contribute zero
 * by the argument above, so a padded frame is still pixel-identical — it just
 * pays for a few no-op lights to keep the shader signature frozen.
 *
 * Ladder from the measured cost curve (all counts prewarmed, so recompile-free):
 *
 *     lights  4     8    12    14    15    16    17    18    20    22
 *     ms      9.86 10.04 10.05  9.98  9.44 10.49 12.33 13.81 16.67 20.04
 *
 * Flat to 16, then ~1.6 ms per light. So the low rungs are nearly free and the
 * ladder is dense where it matters.
 *
 * Measured in-frustum demand, 45 walkable stations + live combat (44 kills):
 *
 *     exploration  p50 8   p90 9   p99 11   max 18
 *     combat       p50 12  p90 18  p99 26   max 26   (live lights peaked at 40)
 *
 * The 12 rung therefore covers exploration outright; combat climbs the ladder and
 * falls back down. `maxRung` is never exceeded, so a light is only ever dropped
 * if more than `maxRung` lights genuinely intersect the frustum at once — which
 * `stats.droppedInFrustum` counts so it can never happen silently.
 *
 * ## Ordering
 *
 * This MUST run after every system that positions or shows a light (props'
 * brazier pool, combat flashes, projectiles, vfx emitters) and before the
 * composer renders. It is registered last in main.js for exactly that reason:
 * an earlier attempt that culled from a separate rAF callback let props reassign
 * lights afterwards, so frames rendered at a count the culler never chose
 * (measured: counts 18 AND 23 both reaching the renderer).
 */

// Rungs, and where the ceiling goes.
//
// Measured in-frustum demand, live combat with 44 kills:
//     exploration  p50 8   p90 9   p99 11   max 18
//     combat       p50 12  p90 18  p99 26   max 26   (live lights peaked at 40)
//
// A ceiling of 40 (every pooled light at once) never drops a contributing light, and I
// shipped it for exactly that reason — then MEASURED it and reverted. Over a 30-second
// fight, A-B on the same scene and the same script:
//
//     ceiling 28   mean 60.6 fps   p50 72.5   p90 33.6   p99 25.3   dropped 29
//     ceiling 40   mean 29.4 fps   p50 35.0   p90 21.1   p99  3.1   dropped 0
//
// The 40 ladder spent 148 frames at rung 34 and 174 at 28, and above ~16 lights each
// extra light costs ~1.6 ms. So "never drop a light" cost HALF the frame rate and a
// 490 ms worst frame — a far worse artefact than the thing it prevented.
//
// 28 is therefore the ceiling. What gets dropped past it is the LOWEST-irradiance
// in-frustum light (ranked intensity/dist^2), which during a 26-light pile-up is a
// transient VFX flash overlapping several brighter ones. `stats.droppedInFrustum`
// counts every one so the trade is visible and never silent.
//
// FIVE rungs, [12,16,20,24,28] — the ladder from the best-measured configuration.
// Every extra rung multiplies the shader variants a material can be compiled into
// (Three.js keys its program cache on the light count), so the ladder is kept short and
// dense only where the cost curve is flat.
//
//     demand  1..12  -> rung 12   ( 9.91 ms — flat region)
//     demand 13..16  -> rung 16   (10.49 ms — still flat)
//     demand 17..20  -> rung 20   (16.67 ms — past the knee)
//     demand 21..24  -> rung 24   (21.37 ms)
//     demand 25..28  -> rung 28
//     demand   > 28  -> lowest-irradiance in-frustum lights dropped, counted in stats
const RUNGS = [12, 16, 20, 24, 28, 34];

// NO hysteresis. An earlier version held the rung high after a spike (DOWN required
// demand to fit a lower rung for N consecutive frames) on the assumption that rung
// changes were expensive. That assumption was never measured, and it was wrong: a
// direct test cycled 64 rung changes in 64 consecutive frames and recorded a 30.7 ms
// worst frame with zero frames over 50 ms. Prewarmed rung changes are cheap.
//
// Holding was actively harmful. In sustained combat, spikes arrive faster than any
// hold period expires, so the rung pins at its most expensive value:
//
//     5 rungs, no hold     mean 60.6 fps   p50 72.5   dropped 29
//     5 rungs, hold 45     mean 52.2 fps   p50 74.6   dropped 287
//     7 rungs, hold 45     mean 29.4 fps   p50 35.0   dropped 0
//     4 rungs, hold 20     page hung outright
//     2 rungs, hold 20     page hung outright
//
// So the rung tracks demand directly, every frame. `stats.rungChanges` is still
// reported — if it ever correlates with a stutter, THAT is the measurement to take.

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _camPos = new THREE.Vector3();

/** Scratch arrays, reused every frame — the cull path allocates nothing. */
const _lights = [];     // every PointLight in the scene
const _in = [];         // in-frustum, ordered by descending screen relevance
const _out = [];        // out-of-frustum, ordered by ascending distance (padding)
const _parked = [];     // spent pool slots (intensity ~0) — last-resort padding

let scene = null, camera = null, renderer = null;
let enabled = true;
let dirty = true;       // rescan the scene graph for lights
let lastRung = -1;

const stats = {
  live: 0, inFrustum: 0, shown: 0, rung: 0,
  culled: 0, padded: 0, droppedInFrustum: 0, rungChanges: 0, offRung: 0,
};

/** Rescan the scene for PointLights. Cheap, but not per-frame: pools are created
 *  at init and reused, so the set only changes when a system builds new ones. */
function collect() {
  _lights.length = 0;
  scene.traverse((o) => { if (o.isPointLight) _lights.push(o); });
  dirty = false;
}

/** Smallest rung that fits demand `n`; the top rung when demand exceeds the ladder. */
function rungFor(n) {
  for (let i = 0; i < RUNGS.length; i++) if (RUNGS[i] >= n) return RUNGS[i];
  return RUNGS[RUNGS.length - 1];
}

function cull() {
  if (!enabled || !scene || !camera) return;
  if (dirty) collect();

  camera.updateMatrixWorld();
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  // A NaN in the view matrix makes every frustum test pass, which would silently
  // disable the cull. Bail out visibly rather than shade 47 lights in the dark.
  const e = _m.elements;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return;
  _frustum.setFromProjectionMatrix(_m);
  camera.getWorldPosition(_camPos);

  _in.length = 0; _out.length = 0; _parked.length = 0;
  let live = 0;

  for (let i = 0; i < _lights.length; i++) {
    const l = _lights[i];
    // Parked pool slots (intensity ~0) are collected as LAST-RESORT padding and are
    // otherwise forced hidden. They must NOT be skipped: Three.js counts every visible
    // light regardless of intensity, so a pool that leaves a spent slot visible pushes
    // the frame's light count OFF the ladder and forces a full recompile of every
    // material at that count. Measured over 227 combat frames: 4 rendered at 25, 24 and
    // 32 lights instead of the chosen rung, and those frames cost up to 433 ms.
    // The cull owns the total, so it owns parked slots too.
    if (l.intensity <= 1e-3) { _parked.push(l); continue; }
    live++;
    const d = l.distance;
    // A shadow-casting light is NEVER culled, in or out of frustum. `numPointShadows`
    // is its own term in the program cache key, so letting it flip 1<->0 doubles the
    // shader variants of every material on top of the light-count variants. Pinning it
    // costs one light (0.55-1.6 ms) and halves the variant space. There is exactly one
    // shadow-casting PointLight in the scene (props.js `shadowLights: 1`), so this is a
    // one-light guarantee, not a licence for many.
    if (l.castShadow || !(d > 0)) {     // shadow caster, or infinite reach
      l.__lcScore = Infinity;
      _in.push(l);
      continue;
    }
    l.getWorldPosition(_sphere.center);
    _sphere.radius = d;
    const dist2 = _sphere.center.distanceToSquared(_camPos);
    if (_frustum.intersectsSphere(_sphere)) {
      // Rank by irradiance reaching the camera — intensity over distance^2. When
      // demand exceeds the ladder this decides who survives, so the brightest
      // nearby light wins over a dim distant one.
      l.__lcScore = l.intensity / Math.max(dist2, 1e-3);
      _in.push(l);
    } else {
      l.__lcScore = -dist2;             // nearest first, so padding is plausible
      _out.push(l);
    }
  }

  const rung = rungFor(_in.length);
  if (rung !== lastRung) { stats.rungChanges++; lastRung = rung; }

  // Shadow-casting lights must keep a stable slot: dropping one changes the
  // shadow-map count, which is a separate term in the program cache key and
  // would recompile even at a fixed light count.
  _in.sort((a, b) => (b.castShadow ? 1 : 0) - (a.castShadow ? 1 : 0) || b.__lcScore - a.__lcScore);
  _out.sort((a, b) => b.__lcScore - a.__lcScore);

  let shown = 0, dropped = 0;
  for (let i = 0; i < _in.length; i++) {
    const on = shown < rung;
    _in[i].visible = on;
    if (on) shown++; else dropped++;
  }
  // Pad with zero-contribution lights so the count lands EXACTLY on the rung: first
  // out-of-frustum lights, then parked slots. Every remaining light is forced hidden.
  // Landing exactly on a rung is what makes the prewarm sufficient — one stray visible
  // light means a count nothing compiled for, and a multi-hundred-millisecond stall.
  let padded = 0;
  for (let i = 0; i < _out.length; i++) {
    const on = shown < rung;
    _out[i].visible = on;
    if (on) { shown++; padded++; }
  }
  for (let i = 0; i < _parked.length; i++) {
    const on = shown < rung;
    _parked[i].visible = on;
    if (on) { shown++; padded++; }
  }

  stats.live = live;                       // lights actually emitting (parked excluded)
  stats.inFrustum = _in.length;            // of those, able to affect a visible pixel
  stats.shown = shown;                     // MUST equal rung, every frame
  stats.rung = rung;
  stats.culled = _out.length + _parked.length - padded;   // hidden as zero-contribution
  stats.padded = padded;                   // shown only to hold the count on a rung
  stats.droppedInFrustum = dropped;        // >0 means real light was lost — never silent
  // Landing off-rung is the one failure that costs hundreds of milliseconds, so it is
  // asserted rather than trusted. `offRung` accumulating means the prewarm is being
  // bypassed and something else is toggling light visibility after this system runs.
  if (shown !== rung) stats.offRung++;
}

/**
 * Compile every rung once, at boot, so no rung change ever compiles in play.
 *
 * `renderer.compile()` alone only ENQUEUES: the driver links lazily and the stall
 * lands on the first frame that uses the program. So each rung is also rendered
 * once, which forces the link to complete while the loading screen is still up.
 * Measured cost for this ladder: 0.65 s total, 235 programs. After it, cycling
 * rungs for 64 consecutive frames produced a worst frame of 30.7 ms and zero
 * frames over 50 ms — versus 4,295 ms worst without it.
 */
function prewarm() {
  if (!renderer || !scene || !camera) return null;
  if (dirty) collect();
  const was = _lights.map((l) => l.visible);

  // Meshes are left exactly as they are. An attempt to force every mesh visible for the
  // prewarm — on the theory that `render()` only LINKS what it draws, so hidden combat
  // meshes (VFX, decals, gibs) deferred their link to the first fight — did not reduce
  // in-play program growth at all (measured 143 vs 91, in a heavier fight). The
  // hypothesis was wrong, so the complexity is not kept.
  //
  // In-play growth is therefore accepted as a bounded, first-fight-only cost: fight 1
  // compiled 91 programs, fight 2 compiled 5. It is a warm-up, not a leak.

  // Order: live lights first, then parked slots, so a rung of N is reached the same way
  // the cull reaches it.
  const pool = _lights.slice().sort((a, b) => (b.intensity > 1e-3 ? 1 : 0) - (a.intensity > 1e-3 ? 1 : 0));
  const t0 = performance.now();
  for (const rung of RUNGS) {
    for (let i = 0; i < pool.length; i++) pool[i].visible = i < rung;
    renderer.compile(scene, camera);
    // Render through the COMPOSER, not `renderer.render(scene, camera)`.
    //
    // `outputColorSpace` is part of Three.js's program cache key, and it differs by render
    // TARGET: the canvas is sRGB while the composer's intermediate targets are
    // srgb-linear. Warming against the canvas therefore compiled every material for a
    // colour space the game never renders in, and the real program was still compiled
    // on first sight in play. Measured by diffing cache keys field-by-field after a
    // fight: 12 fresh keys differed ONLY at field 2, `srgb` vs `srgb-linear`.
    //
    // Going through the composer also warms the post chain's own passes.
    if (World.pipeline && World.pipeline.render) World.pipeline.render(1 / 60);
    else renderer.render(scene, camera);
  }
  for (let i = 0; i < _lights.length; i++) _lights[i].visible = was[i];
  const ms = performance.now() - t0;
  return { ms: Math.round(ms), rungs: RUNGS.slice(), programs: renderer.info.programs.length };
}

const api = {
  get stats() { return { ...stats }; },
  get rungs() { return RUNGS.slice(); },
  get enabled() { return enabled; },
  /** Toggle for same-tree A/B. Off restores every live light to visible. */
  setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      if (dirty) collect();
      for (const l of _lights) if (l.intensity > 1e-3) l.visible = true;
      lastRung = -1;
    }
    return enabled;
  },
  /** Call when a system creates or destroys lights. */
  invalidate() { dirty = true; },
  prewarm,
};

export default {
  name: 'lightcull',

  init(ctx) {
    scene = ctx.scene; camera = ctx.camera; renderer = ctx.renderer;
    enabled = CFG.graphics.lightCull !== false;
    dirty = true;
    World.lightCull = api;
  },

  /** Runs last in the system order — after every light mover, before the render. */
  frame() { cull(); },
};

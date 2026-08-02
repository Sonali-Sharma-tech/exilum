# Exilium — current state

**Play it:** `http://127.0.0.1:5188/` (already running). To restart: `cd ~/Desktop/exilium && npm run dev`

**Controls** — WASD movement, verified by playing:

| input | action |
|---|---|
| **W A S D** | **move** — camera-relative, so W is always "up the screen" |
| **left-click** | attack (Cleave) |
| right-click (hold) | walk to cursor (still works) |
| `Q` `F` `E` `R` | Fireball · Storm Lance · Ground Slam · Void Beam |
| `1` `2` `3` `4` | Frost Nova · Caustic Field · Blink Step · Hex Seeker |
| `Space` | dodge roll |
| wheel | zoom · `I` inventory |

**Storm Lance moved from `W` to `F`** so W could be movement. That remap touched four files —
`combat/skills.js` (the skill's `key`), `combat/skills.js` `KEY_TO_SKILL` (the real binding),
`entity/player.js` `SKILL_KEYS`, and `ui/skills.js` + `combat/combat.js` for the HUD. Missing the
`KEY_TO_SKILL` entry silently produced an **8-slot bar instead of 9**; missing the `SKILL_KEYS` one
made `W` **both walk and cast** on the same press. Both fixed and verified — bar shows 9 slots with
`f:Storm Lance`, and W/A/S/D cast nothing.

## Latest session: centring, FPS meter, performance, traversal

| complaint | fix | evidence |
|---|---|---|
| character not centred | rigid camera follow, aim at the player not the cursor-lead point | **offX 0, offY 0** — still, moving at 5.1, cursor in far corner |
| want an FPS counter | `ui/fpsmeter.js`, always visible top-left | "34 FPS · 29.6ms · 1% low 28" |
| increase FPS | `shadowLights` 3→1, enemy `castShadow` off | **14.6 → 34 fps**; 1% low 10 → 28 |
| can't traverse the map | `ui/objective.js` — compass following a walkable flow field | followed alone from spawn, closed 72.9 of 98.8 units |

**Centring had two causes.** `cam.lookAt(target)` aimed at the *cursor-biased* point, so any
`lookAhead` pushed the character off-centre by design. And `cam.position.lerp(desired, 1−exp(−6.5·dt))`
let the camera **lag while walking** — a first-order lag settles at `v/k`, so at speed 5.1 with k=6.5
the camera sat a permanent **~0.78 units behind** in the direction of travel. Both removed; shake now
applies to position only so impacts jolt the view without moving the look target.

**The performance bottleneck was shadow cube maps.** Hooking `renderer.render` (my earlier reads of
`renderer.info` were taken *outside* the render loop and reported `calls: 1`):

```
renderCallsPerFrame  3481
trianglesPerFrame    6,160,228
visible scene tris     512,410     ← a 12x multiplier
```

A point-light shadow is a **cube — six passes** — while the CSM sun is three cascades, so
`shadowLights: 3` was **18 of the frame's 21 shadow passes**. Cost is linear at ~1.9 fps per caster
(3→35.1, 2→36.3, 1→38.6, 0→40.8, return leg 34.9). Took 1, not 0: zero was +16.5% but deletes every
contact shadow, and "objects read as pasted onto the floor" is the defect two judges named.

**Traversal was never geometry.** Two flood fills from spawn: point-test 4153/4155, and
**radius-aware for the 0.42 capsule 15063/15063 — 100%**. Collision response is correct too; holding
`S` at the stuck spot moved dx +0.11, dz +3.5, sliding along the wall exactly as intended. **My own
earlier "stuck" test was the bug** — I held `w`, which moves **−x**, while the arena is at **+x**.

The real defect was wayfinding: the minimap reveals only 17 units and nothing marked the goal. And a
goal-bearing arrow is *not* sufficient — from (56.8, 4.8) the true path is 48 units vs 42.3 straight
(ratio 1.14) but runs down a corridor at z≈1, so you must go **−z first**; an arrow at the goal points
**+x into a wall**. The compass now follows a **BFS flow field built once from the arena**, and shows
**path** distance rather than straight-line.

## The game is now completable

**It had no ending.** A boss existed (`Ordolth, the Sundered`, 2600 hp, 3 phases, staged entrance with
a guard wedge) and set `bossDefeated = true` on death — but nothing consumed that flag, and because
`bossActive()` is `bossSpawned && !bossDefeated`, killing the boss made it return **false**, which
**re-opened the wave spawn gate**. Beating the final boss put you back in endless mode.

And the loss condition was worse: `player.js:hurt()` sets `alive = false` itself, so `applyDamage`'s
`if (target.hp <= 0 && target.alive)` guard was already false and `killEntity` **never ran for the
player**. A defeat emit placed there was unreachable dead code — the player died, the death animation
played, and the run continued around the corpse.

| path | result |
|---|---|
| kill the boss | *"THE SUNDER IS BROKEN / VICTORY / Ordolth, the Sundered lies dead on the arena floor"* + run stats |
| die | *"THE DARK TAKES YOU / YOU DIED / slain by a Gnawing Wretch"* + run stats |
| press `R` | full restart — hp 1200/1200, kills 0, level 1, end screen gone |

The arena is at world **(98.8, 0)**, radius 25.2 — walk in and the boss stages its entrance.

Shipped: `EV.GAME_WON`/`EV.GAME_LOST`, the `runOver` gate in `director.js`, the defeat emit at the real
death site in `player.js`, a new `ui/endscreen.js` + its CSS, and **display names for all four enemy
archetypes** (only the boss had one, so deaths read "slain by swarm").

## Playability fixes (this session)

| complaint | fix | evidence |
|---|---|---|
| "move should be WASD" | camera-relative WASD in `player.js` | A measured (−0.74,+0.67) vs expected (−0.743,+0.669) — exact |
| "can't see my character" | camera `distance` 26 → **21** | 73px → **91px** tall; config's own target is PoE2's ~97px |
| "mouse sensitivity way too much" | `lookAhead` 0.16 → **0.04** | cursor was dragging the whole view every frame |
| "super laggy" | `maxActive` 90 → **30**, quality → **medium** | 30 hostiles: **7.1 → 13.8 fps**, ~2× |

**On the character:** I built the rim light `config.js` had been asking for in a comment for rounds
(`charRim` in `sky.js`, cool-white, behind and above, tight 5u range). Then measurement said the
premise was wrong — even the *shipped* lights already gave **1.57× body** and **4.37× edge**
separation from the floor, and pushing rim past 20 made the silhouette **worse** (edge 4.37 → 3.52)
because a rim at range 5 lifts the floor faster than the figure. **The fix was size, not contrast.**
The 26 came from a 720p measurement and under-delivers at 900p.

**On the lag — what I refused to ship.** A frustum-culling change measured **+32% (14.5 → 19.2 fps)**
and would have been the biggest single win. It **did not reproduce**: re-run went 15 → 14 → 13.6, the
opposite direction. The first number was **monster-count drift** — the spawner keeps adding even
while existing monsters are frozen, so I had compared a 21-hostile leg against a 30-hostile leg.
Once I hard-pinned the roster at 22, the *same* `ultra` setting read **14.8 then 12.7 fps: a ±14%
noise floor**, which also invalidates `high` vs `ultra` as distinguishable. Only `medium` (+29%,
outside the band) survived.

Also measured: **half resolution gives zero gain** (15.1 vs 15.2) — this is CPU-bound, not
pixel-bound. Shadows cost ~25% and enemy meshes ~25%, both cleanly reversible. All figures are
headless software GL with no GPU; absolute fps on real hardware will be far higher.

**Why frame-measurement missed all four:** thirteen rounds of gates were taken on *frozen frames
with combat disabled*. Two of these defects were input bindings, one was a 720p-derived constant, one
was frame time under live load. None are visible in a still frame.

## Where it stands

| | |
|---|---|
| Code | 65 JS modules, ~20,200 lines, zero runtime deps beyond three.js |
| Build | clean, ~350ms |
| Boot | ~8s, level generates in 142ms, 7 rooms, seed 1337 |
| Runtime | zero page errors; 46 point lights, 54 light casters, 58 enemies |
| Objective gates | **29/30** across five camera stations |
| Blind A/B vs real PoE2 | **PoE2 4/4**, two independent judges, both high confidence |

Everything is procedurally generated — no downloaded art, no external assets.

## What Round 13 actually changed

Five agents shipped into `sky.js`, `props.js`, `level.js`, `materials.js`, `lighting.js`.

**Landed:** `modeSepPerLuma` — the "bright island in darkness" property the rubric ranks first — now clears
the 2.08 reference floor at **all five stations**. Crypt 1.46 → 2.85, arena 1.71 → 3.09; both previously
failed. On the judges' cropped view our arena (2.92) beats `poe2-11` (2.43) and `poe2-05` (1.87), and our
nave-lit `localContrastPerLuma` (0.7087) beats `poe2-07` (0.6473) — the first times we have beaten
references on either metric.

**Fixed a bug of mine:** the cool-island intensity (3840) was derived analytically for **one** source; the
config shipped **three**. Three overlapping r=9 pools became a saturated teal flood, and gates fell to
26/30. Frame-verified A/B put `count: 1` ahead on every metric — `modeSepPerLuma` *rises* 2.48 → 3.00,
because overlapping pools destroy the separation they add. Shipped `count: 1` and arena `mult 14.0 → 9.0`.
Back to 29/30.

## Three findings that reframe the remaining work

**1. A protocol gate was 96% exposure.** `localContrast` moves **+55.2%** under a pure ×1.25 exposure change,
and `correlation(localContrast, meanLuminance) = +0.963` across our stations. Agents had been "fixing" it by
adding light. On the invariant form the verdict reverses: **ours 0.49–0.59, references 0.73–0.99.** Twelve
rounds of judges saying "flat" and "washed" were right while the instrument read green. Replaced by
`localContrastPerLuma`.

**2. Our fine detail is at parity; we are 5.5× short on LARGE steps.** `fineStepEnergyAbs` ours 0.00166 vs
refs 0.00175 — **1.05×**. But `largeStepCountPct` ours 0.94% vs refs 5.22%. Per frame it is worse: nave-lit
0.20% vs `poe2-07`'s 4.16%, **20× fewer**. "Reads as pasted-on" is exactly what a frame looks like when
objects lack large luminance steps at their boundaries. Adding more texture would move a metric already at
parity and leave the real gap untouched.

**3. The striping was in the wrong CHANNEL for thirteen rounds.** Three judges called the floors "combed
diagonal striation"; two fixes failed. At 3× it is **1-pixel parallel diagonal streaks, teal and red** — our
two light colours, so they are shading artifacts, not albedo. Godray refuted (identical with it off).
Under-filtering refuted (**anisotropy is 16, the hardware max, mipmaps on**). **Floor normal maps confirmed
— stripping them removes ~45%.**

And the amount of detail was never the problem: **`poe2-07` has nearly 2× more high-frequency chroma than
we do.** Only its *direction* differs. Chroma autocorrelation along vs across the streak:

| frame | ratio |
|---|---|
| ours, floor patch | **1.270** |
| ours, normals stripped | 1.095 |
| poe2-07 / poe2-09 / poe2-11 | **0.959 / 1.013 / 1.002** |

Round 12 measured **luminance** anisotropy, got 1.086 inside the reference range, and correctly declared it
fixed. **The defect is chroma, and nothing ever measured chroma directionality.**

`detail.chromaCoherence` is now in the analyzer, gate **0.98–1.01**. It agrees with the blind verdicts
per-station: the judge praised the crypt as "the one frame that earns respect — genuinely normal-mapped
cobblestone" and the crypt **passes at 1.0035**; it named striping in nave-lit and arena, which are
**1.0587 and 1.0270**, our two worst.

## Next round, in priority order

1. **Floor normal-map generator** (`materials.js`) — kill the directional pattern. Gate on
   `chromaCoherence` 0.98–1.01. Highest-value fix: it is the one defect three independent judges named
   across four rounds and it is now located precisely.
2. **Courtyard light-casters** (`props.js`) — see `NEXT_ROUND_ITEM_1.md`. Root cause found in code: the
   courtyard (`radIn 12.65 < 15`) is not `guaranteeRing`, so its braziers are scatter-rejected. Pool
   measures **0.0000**. It is also the only station *below* the ACES inflection, so structure added there is
   amplified rather than compressed.
3. **Large-step deficit** — bigger silhouettes against contrasting backdrops, harder shadow terminators,
   contact darkening. Note `shadowLights: 3` of 54 casters, and every skylight/cool pool is
   `castShadow = false`. **Naively enabling more shadow casters makes it far worse** (crypt large-steps
   2.79% → 0.02%) — they over-occlude. Needs designed shadow casters, not more of them.

## Reference docs

- `MEASUREMENT_NOTES.md` (190KB) — every metric, confound, and correction, including the **ACES inflection
  at x = 0.1203**: below it the tonemap expands scene steps, above it it compresses them. Three of four
  stations operate past it, unmeasured for thirteen rounds.
- `NEXT_ROUND_ITEM_1.md` — the courtyard diagnosis, complete with implementation plan.
- `CAPTURE_PROTOCOL.md` — the six pins that make a measurement comparable. Violate one and the number is an
  anecdote.
- `POE2_RUBRIC.md`, `CRITIC_PROTOCOL.md` — targets and judging method.

## Honest assessment

This is a real, playable isometric ARPG with a serious rendering stack, and it loses a blind A/B against
PoE2 4/4 with both judges at high confidence. It will keep losing: PoE2 is ~100 developers × 7 years of
hand-authored art on a proprietary engine.

What changed this round is that **the gap is no longer mysterious.** It is three located, measured numbers —
`pool/ambient 0.29 vs 1.71`, `largeStepCountPct 0.94 vs 5.22`, `chromaCoherence 1.057 vs 0.99` — each with a
named file to fix and a gate to verify against. Two of the three were invisible to every instrument this
project had until today.


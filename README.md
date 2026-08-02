# SUNDERFALL

An isometric action RPG that runs in the browser. Three.js, no game engine, and **no art assets** —
every texture, mesh, animation, and sound is generated procedurally at load time.

```bash
npm install
npm run dev        # http://localhost:5188
```

## Controls

| input | action |
|---|---|
| **W A S D** | move — camera-relative, so `W` is always "up the screen" |
| **left-click** | attack (Cleave) |
| right-click (hold) | walk to cursor |
| `Q` `F` `E` `R` | Fireball · Storm Lance · Ground Slam · Void Beam |
| `1` `2` `3` `4` | Frost Nova · Caustic Field · Blink Step · Hex Seeker |
| `Space` | dodge roll (i-frames) |
| mouse wheel | zoom · `I` inventory · `F3` debug overlay |

Follow the compass at the bottom of the screen to **The Sunder**, the boss arena. Kill
**Ordolth, the Sundered** to win. Die and you start over. `R` restarts from either end screen.

## What's in here

A complete game loop — generate a dungeon, fight through it, find loot, level up, beat a
three-phase boss — built on a from-scratch engine layer.

**Rendering.** Cascaded shadow maps, ACES filmic tonemapping, GTAO ambient occlusion with a
separate contact-AO pass, SMAA, god rays, bloom, coloured aerial-perspective fog, an
image-based-lighting ambient term, and a screen-space cutaway that punches a dithered hole in any
wall standing between the camera and the player.

**Procedural content.** A seeded dungeon generator (7 room types, walls/columns/props/decals), a
stone atlas with albedo + normal + ORM maps painted on canvas, a skinned character rig with
hand-keyframed animation clips, four enemy archetypes plus a boss, and an item system with affixes
and rarity tiers.

**Simulation.** Fixed-timestep loop with interpolation, capsule-vs-grid collision with per-axis
sliding and step-up, a spatial hash for neighbour queries, ragdolls, a flow-field pathfinder shared
by every enemy, and an encounter director that composes packs into readable formations rather than
spawning them at random.

**Audio.** Synthesised through the Web Audio API — no sound files.

## The interesting part: it was built against measurements, not vibes

The renderer was tuned over 13 rounds against a numeric rubric, with blind A/B comparisons against
real Path of Exile 2 frames judged by agents who didn't know which side was which. `tools/analyze.mjs`
is a zero-dependency frame analyser (it decodes PNG by hand) that reports exposure, colour balance,
step-energy distribution, and structure metrics.

**PoE2 still wins those blind comparisons 4/4.** That was never really in doubt — it's ~100 developers
× 7 years on a proprietary engine against procedural generation in a browser. What the process
produced instead is a precise account of *why*, and most of the value in this repo is in
`MEASUREMENT_NOTES.md` (220KB of it): the wrong turns, the metrics that had to be thrown away, and the
bugs that only measurement could find.

A few examples of what that turned up:

- **A protocol gate was 96% brightness.** `localContrast` moved +55.2% under a pure exposure change,
  and correlated with mean luminance at **+0.963**. Agents had been "fixing" it by adding light for
  rounds. On the exposure-invariant form the verdict reversed completely.
- **Fine detail was already at reference parity (1.05×); the deficit was large steps — 5.5× short.**
  "Reads as pasted-on" is what a frame looks like when objects lack strong luminance steps at their
  boundaries. Adding more texture would have moved a metric already at parity.
- **Three judges called the floors "corduroy striped" and two separate fixes failed** — because every
  instrument measured *luminance* anisotropy, which was correctly in range. The defect was in
  **chroma** directionality, which nothing had ever measured.
- **The ACES inflection sits at linear input x = 0.1203.** Below it the tonemap expands scene steps;
  above it it compresses them. Three of four camera stations were operating past it, unmeasured for
  thirteen rounds.
- **A "+32% fps" win didn't reproduce** — it was monster-count drift between A/B legs. Pinning the
  roster took the noise floor from ±14% to ±0.4%, which retroactively invalidated several earlier
  "wins".
- **The character-not-centred bug was `devicePixelRatio`.** `setSize(w, h, false)` skips the canvas
  CSS size, and a canvas's attributes are its intrinsic size, so on a Retina display it rendered 2×
  too large and you saw the top-left quarter. Three of my own tests agreed it was centred — all three
  measured canvas space, not screen space.

## Layout

```
src/core/      engine, fixed-step clock, input, physics, collision, spatial hash, ragdoll
src/render/    renderer pipeline, sky + lighting, camera, wall cutaway, shaders
src/world/     dungeon generator, level builder, props, terrain, decals
src/entity/    player rig, skeletal animation
src/combat/    damage model, skills, projectiles, particles, VFX
src/game/      enemy AI, encounter director, loot, items, affixes, set-pieces
src/gen/       procedural materials, character/enemy/prop/sprite generators, noise
src/ui/        HUD — orbs, skill bar, minimap, inventory, boss bar, FPS meter, end screen
src/audio/     Web Audio synthesis
tools/         frame analysers and capture harnesses
```

`refs/` (Path of Exile 2 press screenshots used as measurement targets) and `shots/` (capture output)
are gitignored. They're Grinding Gear Games' material and not ours to redistribute — everything here
was measured *against* them and contains none of them.

## Docs

- **`MEASUREMENT_NOTES.md`** — the full record. Every metric, confound, and correction.
- **`STATE.md`** — current state and what's next.
- **`CAPTURE_PROTOCOL.md`** — the six conditions that make two frame measurements comparable.
- **`POE2_RUBRIC.md`** — the numeric targets.
- **`NEXT_ROUND_ITEM_1.md`** — the highest-value open defect, diagnosed down to the line of code.

## Licence

MIT. Path of Exile 2 is a trademark of Grinding Gear Games; this project is unaffiliated and uses
their published screenshots only as private local reference during development.

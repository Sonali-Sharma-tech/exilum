# Capture protocol — the definition of a comparable measurement

Two agents measured "the crypt" in good faith and got `structurePerLuma` 0.0778 and 0.163 — a 2×
difference on the same code. Neither was wrong; **"the crypt" was never a well-defined population.**

A number without this protocol attached is an anecdote, not a baseline.

## The six things that must match

| # | Condition | Why it matters |
|---|---|---|
| 1 | **Station coordinate** | `crypt` is `(40.2, -30.7)`. The older `(40, -31)` sits on a collider and drifts 6+ units. |
| 2 | **Teleport method** | `World.teleportPlayer(x, z)`. Never `player.pos.set()` — a persistent `_dest` makes the player walk back, measured 12 world units of drift. |
| 3 | **Settle criterion** | ≥9 **simulated** seconds, polled from `World.time`, teleport re-asserted every ~1.2s, final drift ≤1.0u or the reading is discarded. |
| 4 | **Foreground** | `page.bringToFront()` first. rAF is suspended in a background tab, freezing `World.time` and every `uTime` effect while `document.hidden` reads false and FPS still reports 60. |
| 5 | **Combat state** | `ai.enabled = false`, `combat.enabled = false`, transient lights zeroed. Combat VFX are emissive and land directly in the hue and step populations. |
| 6 | **Window** | HUD excluded. `analyze.mjs` handles this internally for the step metrics (scene window y 12–72%, x 8–92%). Hand-rolled instruments must match it. |

## Reference stations

```
nave-lit    (34,   2)
nave-wide   (38,   0)
courtyard   (75, -36)
crypt       (40.2, -30.7)
arena       (99,   0)
```

## What is fixed and what is not

- **Level seed is fixed at 1337** (`generateDungeon(seed = 1337)`). Rooms, walls, columns and prop
  placement are identical across every capture ever taken in this project.
- **The floor stream is separately seeded** (`fr = new RNG(0x71005eed ^ layout.seed)`). Changing that
  constant reseeds every slab width, row depth, bond phase and missing-slab roll — a *different
  floor* from the same distribution, not the same floor decorrelated.
- **Generator variance at fixed parameters is UNQUANTIFIED.** Twelve rounds of single-sample
  comparisons assumed it was zero. It happened to be safe only because the seed is hard-coded.

## HMR does not apply build-time values

| change | hot-applies? |
|---|---|
| shader uniforms (AO radius/scale, grade params) | **yes** — read per-frame |
| `World.lighting` intensities and colours | **yes** — read per-frame |
| light `range` / `baseInt` | **no** — copied into `lightSources` at placement |
| baked textures | **no** — double-cached: atlas in `materials.js`, cloned material in `level.js` |
| geometry (joints, prop placement) | **no** — constructed at level build |
| runtime `material.map = null` + `needsUpdate` | **yes** — mutates the live object |

**After writing a value, read it back off the live object and confirm it equals what you wrote.**
"Saved", "built" and "in effect" are three distinct states and only the third matters.

## Reporting

Lead with the **same-tree A/B delta** — toggle your change on/off from one pinned camera seconds
apart. Drift is common-mode and cancels, so the delta survives other agents committing under you.
Absolute numbers drift as the tree moves; always state the capture time alongside them.

## Metrics and their traps

```
largeStepEnergyPct   SHARE.    Goodhartable — stripping all floor textures pushes it past target
                               while producing the flat "plastic" look the judges condemned.
allStepEnergyAbs     QUANTITY. Correlates +0.880 with meanLuminance, so it mostly reports
                               brightness. Reference floor 0.00268.
fineStepEnergyAbs    GUARD.    Ours 0.00089-0.00223, references 0.00081-0.00208 — we are AT
                               reference. Must stay FLAT. If it falls, detail was deleted.
structurePerLuma     TARGET.   allStepEnergyAbs / meanLuminance. Brightness-independent:
                               verified flat (0.163/0.165/0.158) across a 2.4x intensity sweep.
                               Ours 0.064-0.129, references 0.188-0.609.
```

Read the pair, never the headline alone:

- `structurePerLuma` **up** + `fineStepEnergyAbs` **flat** → structure added. The win.
- `structurePerLuma` **flat** + `allAbs` up → brightness only. Honest, helps a gate, not the look.
- `structurePerLuma` **up** + `fineStepEnergyAbs` **down** → detail deleted. The Goodhart failure.

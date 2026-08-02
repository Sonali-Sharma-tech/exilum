# Next round, item 1: the courtyard has NO light-casters

**Status:** diagnosed completely, not fixed. `src/world/props.js` was held by a live agent
(`CoolIsland`, coupled with `sky.js`) with uncommitted edits in flight, and the courtyard is outside
that agent's crypt+arena scope. Handed forward rather than collided with.

**Why this is the highest-value single fix identified in 13 rounds:** it is the only station where the
deficit is *absence* rather than degree. Everywhere else we argue about pool/ambient 0.29 vs 1.71.
Here the numerator is literally zero.

## Five independent confirmations

| evidence | value | reference range |
|---|---|---|
| pool (centre − outer) | **0.0000** | 0.0715 – 0.1822 |
| centre/outer ratio | **0.65** (INVERTED — corners brighter than centre) | 1.84 – 3.54 |
| `localContrastPerLuma` | **0.517** (our worst station) | floor 0.728 |
| radial vignette falloff | **−0.450** (inverted; every reference strongly positive) | 0.467 – 0.781 |
| `sky.js` comment, written before any of this was measured | *"the room's large-step POOL structure needs actual light-casters and is owned by props.js, not here"* | — |

Plus a sixth, from a different direction: the AA/grade agent swept **every** SMAA threshold and grade
lever at this station, **shipped nothing**, and concluded independently — *"root cause confirmed =
courtyard has zero light-casters (props.js), not an AA/grade problem."* SMAA threshold moved raw
`localContrast` by +0.00007 across 0.22→0.40; there were **zero crawl crossings even at T=0.04**,
because the courtyard's structural boundaries are near-black-on-near-black and sit below the
threshold entirely.

**You cannot post-process, sharpen, or grade a pool that does not exist.** That is why every lever
tried at this station has been dead.

## Current state

The courtyard is the one **open-air, deliberately brazier-free** room. Its only light is a single
skylight, already dimmed and tightened by an earlier round:

```
col  = (0.46, 0.54, 0.66)     // desaturated blue-grey moon
mult = 0.45                   // 0.30x the prior open intensity
range multiplier 1.7 -> 0.78  // range ~57 -> ~26 over an ~18.6-radius room
```

That fix was real and landed (measured vis 87 → 45, spVar 0.42 → 0.73). It removed the *flood*. It
could not create a *pool*, because a skylight is one source and the room needs casters.

## Constraints — measured, not guessed

- **Motivated for open-air night.** Not braziers (the room is brazier-free by design). Perimeter wall
  sconces facing inward, or a fire-basket set-piece.
- **Tight range, high intensity** — the validated island mechanism (p10 flat, dynRange up; confirmed
  +2.6% `modeSepPerLuma` at tight range). A wide caster recreates the flood that had to be dimmed 0.30×.
- **Frame it at screen centre.** At an off-centre-framed pool, raising intensity put **10× more energy
  in the OUTER zone than the centre** (+0.0030 vs +0.0003) and made the radial ratio *worse*.
  Position matters more than intensity.
- **Headroom:** `visiblePct` 45 with a 60 ceiling (15 points to spend); `spatialVariation` 0.73 with a
  0.60 floor. Both were only just cleared — do not regress them.
- **Checklist per step:** the six protocol gates **plus `structurePerLuma` plus `meanLuminance`**. The
  six-gate guard would miss an SPL regression, and SPL is the round's target.

## The one place the tonemap is on our side

The ACES inflection is at linear input **x = 0.1203** — below it the tonemap *expands* scene steps,
above it it *compresses* them.

| station | lit level | vs inflection |
|---|---|---|
| **courtyard** | **0.0780** | **+0.042 headroom — EXPANSIVE** |
| nave-lit | 0.1215 | −0.001 (at it) |
| crypt | 0.1683 | −0.048 (past — paying ~10% tax) |
| arena | 0.1874 | −0.067 (past — paying ~10% tax) |

**The courtyard is the only station below the inflection.** Structure added there is *amplified* by the
tonemap rather than compressed. A pool landing the lit region near 0.10–0.12 gets maximum benefit;
pushing past 0.12 starts paying the same ~10% compression tax the crypt already pays. Every other
station is fighting the curve. This one is not, yet.

## Ownership note

Four separate agents — two read-only judges, one fixer on another file, and the owner itself —
independently produced the same ownership mapping from their own briefs when asked. The owner
confirmed uncommitted edits in flight. **Asking before editing cost one message and prevented a
two-writer collision on a coupled file.**


## Code-level root cause (better than the black-box measurement)

Produced by the pool agent from reading `placeRooms`, and it explains the **inverted** vignette
mechanically rather than just observing it:

> `placeRooms` runs a ring loop for every room, **but the courtyard (radIn 12.65 < 15) is NOT
> `guaranteeRing`**, so its ring braziers go through `farEnough` and get **rejected by the scatter's
> occupancy marks** — the same bug that starved the arena. Even if they survived, they would sit at
> `d = radIn*0.78 ≈ 9.9` — **the PERIMETER**, which *worsens* the inverted vignette — at **range 16, a
> FLOOD in a 12.6-radius room.** So the ring path is **doubly wrong** here: wrong placement *and* wrong
> range.

**That is the −0.450 falloff signature, derived from code.** The casters are not merely absent — the code
path that would place them puts them at the perimeter with a flood range. Two instruments, opposite ends,
one cause.

## Implementation plan (agreed, constraints accepted unprompted)

- Dedicated **courtyard central fire-pit block** — 2 braziers clustered near centre at `d ≈ 3.5`
  (combat clearance + screen-centre read)
- **Occupancy-bypassed** so they are guaranteed, not scatter-rejected
- **Per-room tight range override ≈ 9** — lights the inner court, falls dark toward the 12.6 edges and
  corners, producing a *positive* vignette and a real island
- Modest intensity via the existing `POOL_CORE_SCALE`
- Total casters **54 → 56** — targeted, not a broad 80+ wash
- Build-verify, then measure on-frame; **not claimed verified without a frame**

## Ownership resolution

Two agents attempted to claim `props.js` — myself (believing it unowned) and the pool agent (on
**expired Round-12 ownership**). Both were stopped before writing. The file belongs to the cool-island
agent this round, coupled with `sky.js`, and it had **uncommitted edits in flight** (arena ring revert,
`rebuildSkylights` re-trigger in `onLevel`) while holding the camera mid-capture. A write would have
corrupted a live A/B and made its results unattributable.

**Two near-collisions in fifteen minutes, both caught by asking rather than by discovering damage
afterwards.** The owner's explicit *"PLEASE DON'T TOUCH props.js"* is what prevented the first.

**Next round this work belongs to the pool agent by right of diagnosis** — it found the bug, holds the
validated island lever, and accepted every constraint before being asked.

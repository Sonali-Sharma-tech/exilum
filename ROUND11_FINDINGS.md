# Round 11 — what actually separates our frames from PoE2

Two blind judges went 4/4 against us, both naming the same root cause in different
words: *"flat, unlit, tiled albedo… objects sit pasted onto the floor"* (JudgeA) and
*"a flat uniform ambient fill with no falloff… evenly-lit cardboard"* (JudgeB).

This round found the measurable quantity behind that verdict, and it is not what any
of the previous three rounds assumed.

## The metric: large-step energy share

`localContrast` is a **mean** |Laplacian|, and a mean cannot distinguish "many small
steps" from "few large ones". Measuring the step-size **distribution** was decisive:

| step bucket | ours | poe2-07 | ratio |
|---|---|---|---|
| <0.01 | **71.5%** of steps | 53.0% | **0.74x** |
| 0.01–0.02 | 16.8% | 18.3% | 1.09x |
| 0.02–0.04 | 9.2% | 14.2% | 1.55x |
| 0.04–0.08 | 2.0% | 9.5% | **4.70x** |
| >0.08 | 0.5% | 5.0% | **9.52x** |

**We have MORE fine grain than PoE2 and 4.7–9.5x fewer large steps.** Share of gradient
energy from steps >0.04: references **49.4–82.6%**, ours **11.3–37.4%** — zero overlap
across six references and five stations, our best station below the weakest reference.

This retrospectively explains three failed rounds: every prior attempt added
*micro*-detail, i.e. added to the one bucket where we already exceeded the reference,
and that bucket carries little energy.

## The mechanism: range/spacing, not geometry and not brightness

Two hypotheses died on measurement:

- **Not geometric clutter.** The nave has **8.7x more** geometry per unit area than the
  crypt (479.4 vs 55.3 trisPerArea) and scores **3x worse** (15.62% vs 47.40%).
- **Not brightness.** Our mean luminance (0.0304) is *higher* than the references'
  (0.0285). At equal brightness they carry 2.3x more variation per unit brightness. And
  the courtyard is our *brightest* station with our *worst* score.

What predicts the score is the ratio of light **range** to caster **spacing**:

| room | casters | nnMedian | range | **range/spacing** | largeStepEnergyPct |
|---|---|---|---|---|---|
| crypt | 5 | 15.63 | 15 | **0.96** | **47.40%** |
| arena | 3 | 10.51 | 14 | 1.33 | 26.4% |
| nave | 7 | 7.40 | 15 | **2.03** | **15.62%** |

Monotonic. When range ≈ spacing, each pool ends where the next begins and the floor
reads bright-core → dim-midpoint → bright-core. When range ≫ spacing, pools blanket each
other and sum to a smooth wash. **The crypt was our best station by accident of room
dimensions.**

Confirmed by an accidental ablation: an agent's light-freeze regex zeroed the crypt's
fire pools, and its score collapsed **47.40% → 2.82% (17x)** with all geometry and
textures unchanged.

## The fix

Per-type, asymmetric — the nave has one brazier plus ~11 tightly-packed fillers, so the
**fillers** were the wash:

```
lightRange:   brazier 22->16,  torch 15->7,  sconce 14->6.5,  candle 9->4
lightBaseInt: brazier 155->190, torch 74->105, sconce 62->88,  candle 26->40
```

`range` on a `decay=2` PointLight is a hard **cutoff**, not a scale, so shrinking it
removes the dim outer skirt — exactly the sub-0.01 haze we hold in excess — while
leaving pool cores untouched. The intensity raise holds mean irradiance flat. **Pure
redistribution: same light, concentrated.**

Predicted analytically, then measured live after reload — matching to the decimal:

| room | cv (variation) | darkFrac | meanIrr |
|---|---|---|---|
| nave | 1.30 → **1.78** | 0.00 → 0.13 | 8.49 → 8.43 |
| crypt | 1.37 → 1.69 | 0.00 → 0.09 | 8.59 → 9.28 |
| courtyard | 1.76 → 2.16 | 0.00 → 0.30 | 7.14 → 7.69 |
| arena | 2.27 → 3.48 | 0.24 → 0.75 | 2.55 → 2.27 |

## Companion changes this round

- **Recessed masonry joints — WALLS ONLY, shipped.** Run joints 0.14wu base + jitter +
  occasional spall to ~0.42; course joints 0.16wu base; recess depth 0.145–0.235wu, biased
  deep. Plus per-block face tilt (0–0.030 rad) so whole *faces* differ in brightness from
  their neighbours — large steps at block boundaries rather than fine within-face detail.
  Depth was agreed against the AO kernel's ground sampling distance (1 AO texel ≈ 0.034wu,
  so joints must exceed ~0.10wu to resolve at all); two agents settled that constraint
  between themselves *before* either built, converting a probable mutual null result into
  two changes that reinforce.

  Measured, same-tree A/B with camera/lighting/AO common-mode: **localContrast +5.8%**
  (nave-lit 0.02008 → 0.02124) and **+4.6%** (nave-wide 0.01724 → 0.01803), both above the
  2.4% noise floor, with **fineStepEnergyAbs flat** (0.002153 → 0.002162) — the anti-Goodhart
  guard confirming structure was *added*, not detail deleted. Cost: **zero draw-call delta**
  (6672 both states — per-course backing merges into the existing `wallAshlar` batch rather
  than fragmenting it) and +8.15% scene triangles. Merlons byte-identical at 7008 tris in
  every state. Light-leak invariant held by a per-course opaque backing slab, verified
  visually on a dark-side exterior frame beside a lit brazier and analytically by overlap
  geometry.

  **The floor application of the same idiom was reverted** — see MEASUREMENT_NOTES.md. The
  wall captures also under-report the large-step payoff (+0.8pp) because they were taken on
  the *original* wide-pool lighting where the nave had zero dark floor for recesses to
  self-shadow into; the payoff compounds only on the assembled tree.
- **AO retune** 0.18 → 0.12 radius, 1.25 → 1.8 scale. The original kernel was 3.5–20x
  *wider than a mortar joint*, so it integrated seam and open floor together — that is
  the "uniform darkening" JudgeB named, as geometry rather than taste. The retune flipped
  the nave from −2.32pp to +1.49pp on the flat tree.
- **Courtyard exposure**: skylight dimmed 0.30x and range 56.8 → 26, clearing both of its
  failing gates (vis% 86.97 → 42.4 against a 60 ceiling; spVar 0.415 → 0.73 against a
  0.60 floor).
- **No texture change.** The striping defect was proven geometric, not textural — the
  baked atlas is isotropic in memory (structure-tensor coherence 0.043, random dominant
  orientation per cell, power spectrum equal in all four directions) and the screen-space
  anisotropy **survives stripping every floor map**.

## The metric trap worth remembering

`largeStepEnergyPct` alone is Goodhartable: **stripping all floor textures pushes it to
46%, past target, while producing the exact flat "plastic" look the judges condemned.**

A paired *share* guard does not fix it — both shares divide by the same denominator, so
deleting grain mechanically raises one and lowers the other, and maps-OFF **passes** a
paired share target. The guard has to be **absolute**: `fineStepEnergyAbs`, mean fine-step
energy per pixel, which *falls* when detail is deleted and is unmoved by adding
boundaries.

And the absolute numbers overturned the shares entirely — in absolute terms our fine
detail (0.00131–0.00284) sits **at or below** the references (0.00081–0.00208). We never
had excess grain; our *denominator* was small. A planned grain-trim was cancelled on that
basis.

**Final target:**
```
allStepEnergyAbs    RAISE  0.0020 -> 0.0049+   (reference floor)
fineStepEnergyAbs   HOLD   0.0013-0.0028      (already at reference — do not reduce)
largeStepEnergyPct  rises as a CONSEQUENCE, not a thing to optimise directly
```


---

# Corrections after the final bench — read these before acting on anything above

Several conclusions above were superseded by measurements taken after they were written.
Recorded here rather than edited away, because the sequence is the useful part.

## 1. Gates: 25/30, every station 5/6

Up from 24/30. **First time no station sits below 5/6** (the courtyard came up from 4/6).
Captured pinned at drift 0, 9.6+ simulated seconds, combat frozen and transient lights zeroed.

Remaining failures: `localContrast` at four stations, and the arena now overshoots
`visiblePct` (66.88 vs a 60 ceiling) — a deliberate trade, since its `meanLuminance` was
*failing* at 0.0062 before the arena light fix.

## 2. `largeStepEnergyPct` fell against the pre-round baselines, and the cause is still open

crypt 47.40 → 11.01, nave-lit 15.62 → 8.67, arena 41.44 → 16.44. Eliminated as causes:

| candidate | test | verdict |
|---|---|---|
| combat VFX inflating the old numbers | same tree/camera, combat toggled | **0.5pp** (11.10 vs 10.60) — not it |
| the light-range tightening | reverted ranges, re-measured | **worse** (crypt 11.01 → 8.1) — the change is worth +2.9pp |
| the sky.js teal rotation | runtime colour swap, same camera | **doubles** lgStep (6.09 → 12.24) — it helps |

Still open: wall joints, the AO retune, or a J-series baseline that is not comparable for a
reason not yet identified.

## 3. The real deficit is total gradient ENERGY, not large-step SHARE

The teal-rotation test exposed a genuine tension. It raises the large-step *share* while
lowering `meanLuminance` 0.0205 → 0.0151 and therefore **absolute** step energy 0.002056 →
0.001150. A darker frame has smaller absolute gradients but a larger fraction that are big.

Our crypt `allStepEnergyAbs` is **0.001139 against a 0.00268 reference floor — 2.4x short.**

So several changes this round improved the headline share *by darkening the frame*, which moves
the quantity that actually needs to reach the reference in the wrong direction. **The pair must
be read together.**

**The lever for next round:** brighter lit pools against equally dark surroundings — raise
pool-core intensity, do not lower ambient or shift hue. Range tightening is the only change
this round that raised the share *without* costing luminance.

## 4. I optimised a proxy I never validated

Most of this round improved `cv`, the coefficient of variation of world-space irradiance over
each room's floor. It rose from 1.30 to 1.78 at the nave and I verified that live to the
decimal. But `largeStepEnergyPct` — screen-space rendered luminance steps — went *down*.

I validated that `cv` responded to my change. I never validated that `cv` **predicts**
`largeStepEnergyPct`. Those are different claims, and the round's calibration rested on the one
I did not test. The change survives only because a direct revert test showed it net-positive
anyway.

# Round 12 — the round that found the mechanism

Round 11 ended with the defect quantified but its cause unknown: we shipped 96.4% warm / 3.2% cool
against the references' 58–68 / 22–27, and `localContrast` failed at four of five stations after three
rounds of trying to fix it.

Round 12 found *why*, and the answer unified two findings that had looked separate for six rounds.

## 1. A target metric that cannot be gamed

`largeStepEnergyPct` is a **share** and is Goodhartable — stripping every floor texture pushes it past
target while producing the flat "plastic" look both blind judges condemned. `allStepEnergyAbs` is a
**quantity** but correlates **+0.880** with `meanLuminance`, so it mostly reports brightness.

```
structurePerLuma = allStepEnergyAbs / meanLuminance
```

Darkening lowers numerator and denominator together. Brightening was measured as a **bound, not a
trend**: across 1.0/1.8/2.4× at the crypt and 1.0/1.5/2.0× at the nave it stays inside a 4.2–4.7% band
with the sign consistently **negative** (−2 to −5%), never positive. **Only real structure moves it.**

Ours 0.064–0.129 (mean 0.085). References 0.187–0.608 (mean 0.362). **4.3× short — and every
resolution correction found later moved that to ≥4.6×.**

The killer datapoint: **poe2-10 is darker than our crypt** (meanL 0.0143 vs 0.0146) with 2.4× the
absolute step energy. Brightness was never the differentiator.

## 2. Excess fine grain and the large-step deficit are ONE mechanism

We carried *more* sub-0.01 steps than PoE2 (71.5% vs 53.0%) and 4.7–9.5× *fewer* steps above 0.04.
That looked like two problems. Measuring **edge width** showed it is one:

| | median W | sharp ≤2px | n edges |
|---|---|---|---|
| ours | 3–4 px | 12–23% | 9.7k–20k |
| poe2 | **2 px** | **50–61%** | 19k–62k |

**A soft edge is a step-splitter** — it takes one large luminance step and spreads it into several small
ones. Switching SMAA off raised `allStepEnergyAbs` (+2.4% arena, +4.0% crypt) while `fineStepEnergyAbs`
stayed **flat**: energy *moved* from the fine bucket into the large bucket. No detail added, none
deleted.

**So twelve rounds of adding micro-detail were pushing on the wrong end of a single mechanism.**

## 3. Why a dark art direction fights its own antialiasing

SMAA runs last, on display-sRGB, with `SMAA_THRESHOLD = 0.1`. sRGB is perceptually spaced, so a fixed
threshold is a wildly different **linear** delta by brightness:

| sRGB level | +0.1 sRGB spans | as % of local level |
|---|---|---|
| 0.10 | 0.02308 linear | **230%** |
| 0.20 | 0.04013 | 121% |
| 0.50 | 0.10451 | 49% |

Our frames sit at sRGB **0.13–0.21**. SMAA is effectively asked "is this boundary bigger than the entire
local brightness?" and answers yes for **every shadow-band boundary we have**. It predicts the crypt —
our darkest station, lowest base sharpness at 27.6% — is blended hardest, which matches.

Our grimdark art direction and our AA default were chosen independently. The interaction was invisible
to both.

## 4. The floor striping root cause, after six eliminated hypotheses

Eliminated across two rounds: texture recipe, filtering, atlas twinning, posterisation, minification
aliasing, joint recession.

**The actual cause:** the strict running bond laid every slab in a row at ONE `czRow` and ONE `rowD`, so
slab top/bottom edges were **collinear across the full room width** — a dead-straight full-width bedding
joint at semi-regular Z pitch, projecting under the iso camera as the diagonal corduroy. Confirmed at
the source: **bedding-bias `Gz/Gx` = 1.25**.

Fixed by giving each slab its own depth and z-centre so a row's bedding edges no longer form one line:

| room | before | after |
|---|---|---|
| nave | 1.25 | **0.98** |
| crypt | 1.23 | **0.96** |
| arena | 1.29 | **0.97** |

Effect 0.27 vs seed-noise 0.07 = **3.8×**. Cost: **−2.4% tris, zero draw-call delta**, walls
byte-identical.

## 5. "Neutral" has two independent causes

`analyze.mjs` classifies `warm` = hue 340–65 ∧ sat>0.10, `cool` = hue 170–280 ∧ sat>0.06,
**`neutral` = everything else**. So hues in **65–170** and **280–340** count neutral *at any
saturation*. The references use both routes (40–67% low-saturation, 14–47% hue-gap).

This redirected two agents off the wrong lever. It also made the crossover-ridge design work: **teal**
warm→cool mixing sweeps through the 65–170 green gap and lands NEUTRAL across three of seven mix
ratios, where a **blue** cool source yields none — it goes warm straight to cool. The intuitive "cold
blue shaft" would have silently broken the design.

## Shipped

| file | change | evidence |
|---|---|---|
| `sky.js` | teal cool pools, crypt+arena, offset so cool:warm *sweeps* the floor | naves verified unmoved (A/B within noise) |
| `props.js` | crypt pool-core 1.5×, room-scoped | allAbs +7.5%, fineAbs flat; naves byte-identical *and* geometrically unreachable (33.3u vs 16u range) |
| `props.js` | arena ring 5→3 | visiblePct 66.88 → **55.13**, meanL 0.0364 (3× floor) |
| `level.js` | v2 broken-ashlar bond | Gz/Gx 1.25 → 0.97, 3.8× signal-to-noise |
| `pipeline.js` | **deliberately unchanged** | grade exonerated by four checks; the available fix would have manufactured grey mud from saturated fire |

## What made this round trustworthy

**Six of my own hypotheses were refuted by measurement**: global intensity raise, inner-ring tightening,
GTAO denoise as the edge-softener, AO resolution, the satFloor gate, and the lit-fraction explanation
for a phantom nave drift.

**Three agents voluntarily downgraded their own results.** One retracted a headline number as doubly
contaminated (a warm aura decal that survived combat-freeze, plus a DPR-inflated capture). One flagged
its own "2× margin" as optimistic on realising its tab captured at 1365×768. One declined to ship a
change **its own metrics favoured** because the crops showed thin-geometry crawl.

**And `hardEdgeRatio` — our aliasing guard — stayed green while thin geometry visibly crawled.** A guard
that does not move when the defect it guards against is introduced is worse than no guard, because it
licenses the change. Only the crop caught it.

## Open

1. **`SMAA_THRESHOLD` raised** — mechanism identified and quantified; sweep in flight at round's end.
   The largest known unexploited lever.
2. **Structure deficit ≥4.6×** on `structurePerLuma`. Neither brightness nor hue moves it; it needs more
   lit/unlit boundaries and more genuine surface relief.
3. **A fixed pixel window is not a fixed population.** The prescribed acceptance window stopped being
   floor-dominant when another subsystem brightened a dais into it — same coordinates, same code,
   different content.

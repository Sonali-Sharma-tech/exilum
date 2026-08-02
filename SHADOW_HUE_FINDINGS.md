# Shadow hue — why "flat purple wash" was a hue problem, and what the target is

A blind judge said our shadows were "a uniform cool-purple fill... darkness lacks
receding depth; corners read evenly lit rather than falling away." Two things
followed, and both were counter-intuitive.

## 1. The percept was NOT about luminance

My first instinct was that "flat" meant insufficient luminance variation in
shadow. Measuring the spread within the dark half of the frame:

| | dark-band spread |
|---|---|
| ours | **40.0×** |
| poe2-07 | 15.1× |
| poe2-09 | 12.5× |
| poe2-05 | 8.1× |

Our shadows carried **three times more** internal luminance structure than the
reference, and our dark-band midpoint (0.00227) nearly matched poe2-07's
(0.00221). Had I acted on the instinct I would have spent a round raising shadow
contrast that was already 3× the reference — making it worse while believing I was
fixing the named defect.

The governing property was **hue variance**. Circular standard deviation of hue
over the shadow band (max channel 8–55/255, saturation ≥ 0.05):

| | n | mean hue | hue spread | mean sat |
|---|---|---|---|---|
| ours | 63044 | **307° (magenta)** | **55.1°** | 0.410 |
| poe2-07 | 103759 | 349° | 91.7° | 0.414 |
| poe2-09 | 91992 | 156° | 106.5° | 0.387 |
| poe2-05 | 127657 | 195° | 45.8° | 0.391 |

Saturation matched almost exactly (0.410 vs 0.414) — so this was never about how
*colourful* the shadows were. Ours were all **one** colour, and that colour was
literally magenta-purple, exactly the word the judge used. Uniform hue makes a
region read as a single wash regardless of luminance variation, because the eye
groups by colour.

## 2. Warm-dominance and hue-spread are NOT in tension

The agent doing the work reported a structural conflict: it argued that a
warm-dominant room is inherently one-hue, so my two targets (~85/11 warm/cool for
a firelit interior, and ~85° hue spread) could not both be met. That was a
reasonable hypothesis and it was worth testing rather than accepting.

Measured across six PoE2 gameplay frames:

| frame | shadow spread | shadow warm% | shadow cool% |
|---|---|---|---|
| poe2-05 | 45.8 | 5.6 | 79.5 |
| poe2-07 | **91.7** | **53.5** | 34.2 |
| poe2-09 | **106.5** | 34.2 | 53.3 |
| poe2-10 | 35.0 | 43.4 | 6.2 |
| poe2-11 | **84.4** | **58.0** | 32.6 |
| poe2-12 | 27.0 | 14.1 | 1.4 |

**correlation(shadow warm%, shadow spread) = +0.57** — positive, not negative.
poe2-07 reaches 91.7° at 53.5% warm; poe2-11 reaches 84.4° at 58.0% warm. Both
are warm-dominant *and* high-spread simultaneously.

### The actual mechanism

Compare the cool column against the spread column:

- Every **high-spread** frame carries a substantial cool **minority**: 34.2%,
  53.3%, 32.6%.
- Every **low-spread** frame has a starved one: poe2-10 at 6.2% cool → 35°;
  poe2-12 at 1.4% → 27°.
- poe2-05 shows the inverse failure: 79.5% cool and only 5.6% warm gives just
  45.8°, because it is one-hue in the *other* direction.

So spread does not come from balancing warm against cool 50/50, and it does not
require abandoning warm dominance. It comes from a warm **majority** coexisting
with a genuine cool **minority in real quantity** — roughly 55/33 is the shape
that produces ~90°.

## The corrected target

Our nave measured 82/11. The warm majority was right; the **cool minority at 11%
was starved**, and that is what capped hue spread at 61°.

**Target: hold warm dominant, but raise the shadow cool fraction to ~30–35%.**
Not a global re-cool — the distinction is *majority* versus *presence*. Moving
82/11 → 55/33 keeps warm winning while giving the cool lobe enough mass to widen
the distribution toward 85–90°.

Cool must be present in real quantity where it is **motivated** — up-facing
surfaces, deep corners away from fire, water, under the broken vault — while
brazier-facing surfaces stay firmly warm.

## Method note

Measure hue spread as the circular standard deviation over pixels with max channel
in 8–55/255 and saturation ≥ 0.05. The band matters: hue is meaningless in
near-black and unstable in near-neutral pixels, and including either produces
numbers that move for reasons unrelated to the art.

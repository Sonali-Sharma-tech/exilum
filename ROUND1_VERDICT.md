# Round 1 verdict — blind comparison LOST, twice

## The blind test, and its result

Two 2-up sheets, each pairing one of our frames against a real official PoE2
screenshot. Panels labelled only `A`/`B`, both normalised to identical 1280x720
so resolution could not bias the call, neutral grey gutter, left/right decided by
a seeded coin flip, answer key written to a separate file the judges were
forbidden to read.

| sheet | our frame | real PoE2 | judge's pick | correct? | confidence |
|---|---|---|---|---|---|
| blind-A | panel A (`01-establishing`) | panel B (`poe2-05`) | **B** | **yes** | 0.98 |
| blind-B | panel B (`03-combat`) | panel A (`poe2-09`) | **A** | **yes** | 0.90 |

**Both judges correctly identified the commercial product. We lost both
comparisons.** Neither said "cannot tell", which was an explicitly permitted
answer. The user's bar — that a blind judge prefer ours, or at minimum be unable
to distinguish it — is NOT met at round 1.

## What the judges actually saw

### The single most damning tell (judge A, 0.98 confidence)

> "Panel A's floor is a Voronoi cell grid where EVERY tile carries the identical
> repeated squiggle/worm bump-noise at the same frequency, and the mortar between
> them is a uniform flat black void with no dirt, chips or occlusion depth — the
> textbook tiling-noise-on-cells procedural signature."

This is a **repetition** failure, not a resolution failure. It is a sharper
diagnosis than my own metric produced, and it invalidates the hypothesis I was
pursuing (see below).

### Darkness has no shape — both judges, independently

Judge A: *"flat featureless near-black wash: darkness with no shape, no ambient
structure, no receding geometry."*

This is precisely the consequence of approximating real-time GI with a constant
ambient term. PoE2 uses **Radiance Cascades** (Sannikov, ExileCon 2023) — its
dark regions carry subtle coloured bounce structure rather than being a void.

### Combat frame was a broken capture — my error, not the game's

Judge B: *"for a combat frame it contains no enemy, no player character, and no
active spell effect at all — just an empty lit room."*

Correct, and it is my fault. I teleported the player next to the brightest
brazier to measure lit-surface detail and left the 49 live enemies behind, then
captured that as the combat frame. The game had 28 enemies on screen swarming the
player two captures earlier. **Judge B's verdict is valid but it judged my
mistake, not the product.** That frame must be re-captured and re-judged before
any conclusion about our combat presentation is drawn.

## A hypothesis I got wrong, recorded because it cost real time

I computed that textures were 9x over-dense — 512 texels/world-unit against 56
screen-px/world-unit, forcing mip level ~3.2, so a 2048px hero stone map renders
at an effective 224px. The arithmetic is correct.

**The conclusion drawn from it was wrong.** I predicted that lowering texel
density would recover micro-detail. Sweeping every material's `repeat` across a
6.7x range (factor 1.0 -> 0.15) moved measured `localContrast` from 0.00386 to
0.00406 — flat, within noise.

Why: scaling `repeat` changes the *scale* of the repeat, never the fact that the
tile repeats identically. Local contrast was low because the same pattern sits on
every tile, so there is no *variation between* tiles at any scale. Judge A saw in
one look what my sweep took four captures to disprove.

Lesson: the metric said "no micro detail" and I read it as "detail too fine to
resolve" when it meant "detail identical everywhere". A number told me a surface
was wrong; a human-style look told me *why*.

## Where we actually stand (measured, gameplay frame)

| metric | PoE2 target | ours | verdict |
|---|---|---|---|
| visiblePct | 12-60 (med 25) | 20.14 | PASS |
| pureBlack% | 0.5-11 (med 4.7) | 11.00 | PASS (at ceiling) |
| meanLuminance | 0.012-0.09 | 0.019 | PASS |
| contrast | >=40 (med 93) | 6629 | far over — check mid-tone loss |
| spatialVariation | >=0.60 (med 1.04) | 1.196 | PASS, beats PoE2 |
| hardEdgeRatio | <=0.010 (PoE2 0.0048) | 0.0050 | PASS, matches PoE2 |
| shadowSaturation | >=0.15 (med 0.41) | 0.564 | PASS |
| **localContrast** | **>=0.012 (med 0.0197)** | **0.0085** | **FAIL** |
| **satVisible** | **0.24-0.58 (med 0.49)** | **0.634** | **FAIL** |
| **warm / cool** | **61 / 22** | **90.5 / 7.9** | **FAIL** |

The lighting *architecture* is right — pool-of-light structure, true blacks,
motivated sources, clean AA, cool-carrying shadows. What fails is **surface
individuation, colour balance, and structure inside the darkness.**

## Fix priority for round 2

1. **Break texture repetition** (judge A's damning tell). Per-tile variation:
   hash-per-cell offset/rotation/tint, per-instance wear, dirt in the mortar
   instead of flat black void. This is the single highest-leverage change.
2. **Give darkness shape.** Ambient/IBL gradient with directional bounce, cheap
   irradiance approximation, or in-shadow detail — the GI design consequence.
3. **Restore the cool half of the temperature split** (90.5/7.9 -> nearer 61/22).
4. **Pull satVisible under 0.58.**
5. **Re-capture the combat frame properly** with enemies actually engaged, and
   re-run blind-B. The current result judged an empty room.

# Critic brief — shared context for every critique round

Handed verbatim to each critic agent. Kept on disk so every round briefs critics
identically; a score delta between rounds must reflect the pixels, not a
differently-worded prompt.

## What you are looking at

`~/Desktop/exilium` — an isometric ARPG in Three.js, built from scratch this
session, targeting Path of Exile 2 visual quality. All art is procedural: no
downloaded textures, models, or audio. Textures are generated on canvas/GPU,
geometry in code, animation hand-keyframed, audio synthesized in WebAudio.

Frames to score are in `shots/`:
- `01-establishing.png` — default gameplay framing
- `02-materials-closeup.png` — narrow-FOV crop for surface detail
- `03-combat.png` — mid-combat with VFX active
- `04-ui.png` — HUD and inventory

## Your instruments, in priority order

1. **`refs/poe2-05.jpg` .. `refs/poe2-12.jpg`** — real PoE2 gameplay screenshots,
   official, from the Steam store API. **Open them.** This is the actual bar. Do
   not score against your recollection of PoE2; score against these files.
2. **`POE2_RUBRIC.md`** — read the `MEASURED GROUND TRUTH` table at the top FIRST.
   It supersedes the prose below it. The prose was written from model memory
   without web access and several of its numbers are demonstrably wrong; the table
   is measured from the reference frames.
3. **`refs/VISUAL_ANALYSIS.md`** — structural observations of the reference frames.
4. **`node tools/analyze.mjs shots/<frame>.png`** — objective metrics with hints
   calibrated to the measured targets. Validated: it passes real PoE2 frames clean
   and fails our grey-box baseline on five counts.
5. **`CRITIC_PROTOCOL.md`** — the procedure and the exact JSON output shape.

## Corrections you must apply to the old rubric prose

If you score against these stale claims you will penalise us for correctly
matching real PoE2:

| Stale claim in the prose | Measured reality |
|---|---|
| "saturation 8-22%, world should be grey" | lit pixels measure **0.49** saturation; PoE2's lit areas are RICH. Darkness carries the grimness, not greyness |
| "key:fill 6:1-15:1" | measured **93:1** (range 49-362) |
| ">8% pure black = crushed = FAIL" | PoE2 measures up to **10.3%** pure black; genuine darkness is load-bearing |
| "shadows must be BLUE, grey = fail" | measured shadow hue median **69 deg = WARM**. Chroma follows the motivating light; a firelit crypt has warm shadows. Grey is still wrong |
| "pitch 48-56 deg, auto-fail above 65" | real frames read **50-62 deg**; do not auto-fail at 65 |
| "local contrast >0.004 passes" | PoE2 measures **0.0197**; 0.004 is 5x too lenient |
| "spatial variation >0.18 passes" | PoE2 measures **1.04**; 0.18 is 6x too lenient |

## The criterion that matters most

**Visible-pixel fraction.** Real PoE2 gameplay frames have only **12-60%** of
pixels bright enough to read colour in (median 25%), and 0.5-10.3% at literal
0,0,0. PoE2 is *a bright island inside darkness where every light has a visible
in-world source*.

Our grey-box baseline measured 99.5% visible with 0.00% true black. If the frame
you are scoring is evenly lit, that is the finding, it outranks everything else,
and no amount of texture or post-processing quality compensates for it.

## Disposition

Per `CRITIC_PROTOCOL.md`: you are a hostile art director. Default position is
**this frame is a 55 and the burden of proof is on the pixels**. You are not here
to encourage — an inflated score terminates the improvement loop and ships a worse
game, so harshness IS the helpful act.

- Every deduction needs a **pixel location and an observation**. "Lighting is
  flat" is useless. "The wall at x~420,y~300 and the floor beside it differ by
  under 5% luminance despite the brazier 3 units away — inverse-square falloff is
  not being applied" is actionable.
- Every *credit* also needs evidence. Awarding 85 to a category because it "looks
  nice" is inflation.
- **If you cannot see a required feature, it is absent.** Do not assume it is
  present but subtle.
- Report exactly **three fixes**, ranked by visual impact per unit of work, each
  naming the file and parameter. The implementers have limited iterations.
- Score categories not visible in your frame as `null`, not 0, and renormalise.

## Output

Exactly the JSON in `CRITIC_PROTOCOL.md`, no prose around it. Include
`wouldPassBlindComparison` and `blindComparisonNote` honestly: if this frame and a
real PoE2 screenshot were shown side by side unlabelled, which reads as the
commercial product, and what gives it away.

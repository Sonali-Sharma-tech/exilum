# PoE2 Visual Reference Rubric — the bar every frame is scored against

---

# MEASURED GROUND TRUTH (supersedes conflicting prose below)

**Provenance:** 24 official Path of Exile 2 screenshots pulled from the Steam
store API (appid 2694490) on 2026-08-01, verified as genuine 1920x1080 JPEGs,
converted to PNG and measured with `tools/analyze.mjs`. Statistics below are the
median over the 8 in-game gameplay frames (`refs/png/poe2-05..12.png`); atlas,
passive-tree and menu frames were excluded because we do not render those.

**These numbers OVERRIDE the reconstructed targets in the sections below.** The
original rubric was authored without web access and says so; several of its
numeric claims are contradicted by measurement. Where this section and a later
section disagree, THIS SECTION WINS.

| Metric | Measured PoE2 (median / range) | Original rubric claim | Verdict |
|---|---|---|---|
| Contrast ratio p95/p05 | **93:1** (49-362) | 6:1-15:1 | **rubric WRONG** — real PoE2 is far higher contrast |
| Dynamic range | **6.5 stops** (5.6-8.5) | ~2.5-4 stops | **rubric WRONG** |
| Mean luminance (linear) | **0.023** (0.014-0.080) | not stated | frames are genuinely VERY dark |
| Pure-black pixels | **4.7%** (0.04-10.3%) | ">8% = crushed = FAIL" | **rubric WRONG** — real PoE2 hits 10.3% |
| Mean saturation, all px | **0.41** (0.19-0.54) | 0.08-0.22 | **rubric WRONG** |
| Mean saturation, visible px only | **0.49** (0.24-0.57) | 0.08-0.22 | **rubric WRONG** — lit areas are RICHLY coloured |
| Visible pixels (max chan >= 40) | **25%** (12-85%) | not stated | **the single most important number here** |
| Shadow hue angle | **69 deg** (1.5-204) | 170-280 (cool) | **rubric OVERSTATED** — firelit scenes have WARM shadows |
| Shadow saturation | **0.41** (0.18-0.64) | ">0.06 or grey = FAIL" | rubric direction right, threshold far too low |
| Local contrast (Laplacian) | **0.0197** (0.011-0.067) | ">0.004 to pass" | rubric threshold far too lenient |
| Spatial variation | **1.04** (0.75-1.55) | ">0.18 to pass" | rubric threshold far too lenient |
| Hard-edge ratio | **0.0048** (0.0033-0.026) | "jaggies = auto-fail" | use 0.0048 as the reference, not zero |

## What the measurements actually mean

1. **PoE2 is mostly black.** Only ~25% of pixels are bright enough to read colour
   in. The frame is a **tight pool of light inside genuine darkness**, with heavy
   vignetting. An evenly-lit frame is the amateur tell — our grey-box baseline
   measured 99.5% visible pixels, which is precisely backwards.
2. **What IS lit is richly coloured**, not desaturated. The correct statement is
   NOT "low saturation everywhere" — it is "**most of the frame is black, and the
   lit 25% is saturated**". Sodium-orange firelight, deep blood reds, cold blue
   steel, desaturated dark-green foliage.
3. **Contrast is enormous** — ~93:1, not 15:1. Brazier-lit stone beside true
   black. Do not "lift the shadows for detail"; PoE2 does not.
4. **Shadow hue follows the motivating light.** In torch/brazier scenes the
   ambient bounce is WARM, so shadows read warm-neutral. The cool-shadow rule
   holds only where the motivating fill is skylight or arcane light. Do NOT
   force blue shadows into a firelit crypt.
5. **Micro detail target is 0.0197 local contrast** — 5x the old passing
   threshold, and ~280x our grey-box baseline's 0.00007.

## Revised numeric pass bands (use THESE)

```
contrastRatio      >= 40        (target ~93, do not fear 150+)
dynamicRangeStops  >= 5.0       (target ~6.5)
meanLuminance      0.012 - 0.09 (dark; above 0.12 is washed out for gameplay)
pureBlackPct       0.5 - 11     (0 means no true darkness = fail; >14 is crushed)
visiblePct         12 - 60      (>75 = evenly lit = the amateur tell = FAIL)
satVisible         0.24 - 0.58  (lit areas must be RICH, not grey)
localContrast      >= 0.012     (target 0.0197)
spatialVariation   >= 0.60      (target 1.04 — real pools of light)
hardEdgeRatio      <= 0.010     (PoE2 sits at 0.0048)
shadowSaturation   >= 0.15      (grey shadows still wrong; hue may be warm OR cool)
```

## Camera, re-examined against the real frames

The original rubric claims pitch 48-56 deg and auto-fails above 65 deg. The
gameplay reference frames read **steeper than that** — closer to 55-65 deg, with
very little wall-front visible and a near-plan view of the ground. `refs/png/
poe2-05.png` and `poe2-09.png` are the clearest examples.
**Revised:** pitch 50-62 deg is correct; do not auto-fail at 65. Perspective (not
orthographic) with a narrow FOV remains correct and is confirmed by visible
convergence on tall geometry.



**Provenance note:** this rubric is distilled from training knowledge of Path of
Exile 2 (Early Access, Nov 2024 onward). Web search and fetch were both
unavailable in the session that authored it, so these are *not* fetched,
citable measurements — they are a practitioner's reconstruction of PoE2's
visual language. Numbers marked (approx) are targets to render against, not
claims about GGG's actual engine values.

Critics: score against THIS document, not against your personal taste, and not
against "does it look like a nice three.js demo". A nice three.js demo scores
40/100 here.

---

## 0. The one-sentence identity

PoE2 looks like **a grimly beautiful oil painting of a decaying world, lit by
few, motivated, warm light sources against cold shadow, where every surface has
been weathered by something that actually happened to it.**

Every rubric item below is a consequence of that sentence.

---

## 1. Camera & projection (weight: 10)

| Property | Target | Why it matters |
|---|---|---|
| Projection | **Perspective**, narrow FOV (approx 28–38°) | PoE2 is NOT orthographic. It has visible parallax and slight convergence on tall geometry. Pure ortho reads instantly as "hobby isometric". |
| Pitch | approx **48–56°** below horizontal | Shallower than classic 2:1 iso. You see the *fronts* of walls and character chests, not just their tops. |
| Yaw | fixed, scene-authored (approx 30–45°) | Never free-orbit during gameplay. |
| Camera height | approx 18–26 world units above the player | |
| Player screen position | slightly **above** centre (approx 0.45 of height) | Gives more forward visibility. |
| Roll | exactly 0 | |
| Zoom | subtle, clamped; smooth-damped, never snapping | |

**Auto-fail:** orthographic projection. **Auto-fail:** pitch steeper than 65°
(reads top-down, kills all silhouette).

## 2. Colour & tone (weight: 15)

- **Global saturation is LOW.** Base environment sits around **8–22%
  saturation**. The world is stone, mud, rusted iron, bone, wet timber.
- **Saturation is a currency, spent only on:** magic VFX, blood, gold/loot
  beams, fire, and rare focal props. If the ground is as colourful as a
  fireball, the fireball has no impact.
- **Temperature split is mandatory and is the signature move:** warm key
  (approx 2600–3400K, amber/sodium) versus cool ambient/shadow (approx
  6500–9000K, blue-teal). Shadows must be **blue-ish, never grey, never black**.
- **Deep blacks but not crushed:** darkest meaningful pixel approx **8–18/255**,
  with detail still legible inside it. Pure 0,0,0 in a lit area = fail.
- **Highlight rolloff is filmic**, never clipped to flat white sheets.
- Tonemapping: **ACES filmic** (or better), sRGB output, correct linear
  workflow throughout. `NoToneMapping` = auto-fail.

**Auto-fail:** a frame that reads as "colourful". **Auto-fail:** grey shadows.

## 3. Lighting (weight: 15)

- **Few lights, all motivated.** Every light must have a visible in-world
  source: brazier, rift, torch, moon, lava, the player's own spell. A light
  with no source object is a fail.
- **High contrast ratio:** key-to-fill approx **6:1 to 15:1**. Flat, evenly-lit
  scenes are the #1 tell of amateur work.
- **Ambient must be directional/spatial**, not a constant term.
  `AmbientLight` alone = auto-fail. Use IBL / hemispheric gradient.
- **Shadows: soft, contact-accurate.** A character's feet must be visibly
  *joined* to the ground with darkening. Floating characters = auto-fail.
- Light falloff **inverse-square, physically plausible**, with visible pools of
  light and genuine darkness between them.
- Bloom exists but is **restrained and thresholded** — only genuinely emissive
  things bloom. Global haze-bloom over the whole frame = fail.
- Volumetric light shafts / god rays where atmosphere is motivated.

## 4. Materials & textures (weight: 15)

- **Full PBR:** albedo, roughness, metalness, normal, AO, height. Missing
  roughness variation = auto-fail (uniform roughness is the flattest possible
  look).
- **Roughness must vary spatially** within a single surface — worn edges are
  smoother, recesses are rougher and dirtier.
- **Triplanar or properly UV'd**, never stretched. Visible UV stretch = fail.
- **Weathering must be directional and causal:** water streaks run *down*.
  Moss grows on *north/shadowed* faces and in crevices. Wear appears on
  *walkable* surfaces and *grabbed* edges. Random noise-dirt = fail.
- **Edge wear / cavity darkening** present on all hard-surface props.
- Texel density consistent across props (no one crisp rock beside a blurry one).
- Detail at **three scales**: macro form, mid pattern, micro grain. Missing
  micro grain reads as plastic.
- Wet/damp surfaces where drainage implies them, with darker albedo AND lower
  roughness.

## 5. Geometry, silhouette & composition (weight: 10)

- **Silhouette reads at a glance** — the eye must parse player, enemy, and
  hazard instantly at gameplay zoom.
- **No untextured primitives visible.** A raw box/sphere/cylinder with flat
  colour = auto-fail. This is the single most common tell.
- Deliberate composition: leading lines, framing verticals, a clear focal area,
  depth layering (fore/mid/background with distinct value separation).
- **Broken symmetry** — a perfectly regular grid of props is a fail.
- Vertical interest: PoE2 uses stairs, ledges, and height changes constantly.
  A flat plane arena is a fail.
- Props must **sit** in the world: partially buried, leaning, settled, with
  debris accumulated at their base.

## 6. Atmosphere & post (weight: 10)

- **Depth fog / aerial perspective is mandatory** and must be *coloured*, not
  grey — it carries the cool half of the temperature split.
- Particulate in air: dust motes, embers, drifting spores, rain. A dead-still
  atmosphere is a fail.
- SSAO — present, subtle, contact-focused, no dark halos.
- Post chain: bloom (thresholded), tonemap, vignette (subtle), chromatic
  aberration (barely perceptible or absent), film grain (very subtle).
- **No aliasing on high-contrast edges.** Jaggies = auto-fail.
- Screen-space reflections or approximation on wet/polished surfaces.

## 7. VFX & combat feel (weight: 15)

- **Impact requires 5 simultaneous channels:** flash + particle burst +
  screen-space feedback (shake/tint) + decal + audio-shaped timing. Fewer than
  4 present = fail.
- **Anticipation → strike → recovery** timing on every attack. No instant,
  windup-free hits.
- Spell VFX are **additive, bright, saturated** against the desaturated world,
  with genuine light contribution onto nearby geometry (a fireball MUST light
  the floor).
- Hit-stop / micro-freeze on heavy connections.
- Death: not a fade-out. Ragdoll or directional stagger, plus a lingering decal.
- Numbers/telegraphs legible without stealing focus.
- Particle sprites must be **soft-edged and varied**, never hard squares.

## 8. Animation (weight: 10)

- No linear interpolation on anything organic. Ease curves everywhere.
- Weight and momentum: acceleration, foot planting, torso counter-rotation.
- Idle breathing / secondary motion always present — a static idle = fail.
- Directional turn transitions, not instant snapping to a new facing.
- Secondary motion on cloth/hair/straps.

---

## Scoring protocol (critics MUST follow exactly)

Score each of the 8 categories **0–100**, then compute the weighted total.

```
total = Σ(category_score × weight) / 100
```

### Calibration anchors — use these, do not drift

- **95–100** — indistinguishable from a PoE2 marketing screenshot. Reserve this.
  If you are tempted to give it, re-read section 4 and look harder at roughness.
- **85–94** — shippable AAA. A player would not question it.
- **70–84** — strong indie / AA. Competent, clearly not GGG.
- **50–69** — good three.js demo. Reads as a tech demo, not a game.
- **30–49** — obvious hobby project. Flat lighting or untextured primitives.
- **0–29** — grey boxes.

### Hard rules for critics

1. **Start skeptical.** Your default assumption is that the frame is a 55 until
   evidence in the pixels moves it. Do not award points for effort or intent.
2. **Cite pixel evidence.** "Lighting is flat" is useless. "The left wall at
   x≈300 and the floor beside it differ by under 5% luminance despite the
   brazier being 3 units from the wall — falloff is not being applied" is
   actionable. Every deduction needs a location and an observation.
3. **Any auto-fail condition caps the category at 40** regardless of other merit.
4. **Do not inflate to be encouraging.** An inflated score ends the improvement
   loop early and ships a worse game. Being harsh IS the helpful act here.
5. **If you cannot see a required feature, it is absent.** Do not assume it is
   there but subtle.
6. Report the **three highest-leverage fixes**, ordered by visual impact per
   unit of work — not a laundry list of everything imperfect.

### Verdict field

`PASS` only if weighted total ≥ the caller's stated bar AND no auto-fail is
active. Otherwise `FAIL`, with the three fixes.

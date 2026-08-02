# The blind verdict, first — because it is the answer to the question asked

Two independent critics judged four pairs of frames. Each pair was our frame against
a real PoE2 frame, sides randomised per pair, filenames carrying no origin, and the
answer key withheld on disk. They were told one frame was a shipped AAA game and one
was an in-development Three.js renderer, and asked to pick the better-looking frame
and then guess which was commercial.

**Both judges went 4/4. PoE2 won every pair, all eight verdicts "decisive", all
"high confidence".** We did not win a single frame, and neither judge hesitated.

They were run independently, with different briefs — one weighted to art direction,
one to rendering-engineering tells — and converged on the same root cause:

> **JudgeA:** "lighting-driven material response… the in-development set uses flat,
> unlit, tiled albedo with no normal detail, no contact shadows, and a single ambient
> wash — so stone never reads as stone and objects sit pasted onto the floor rather
> than resting on it."

> **JudgeB:** "Motivated light transport. The winning set drives every frame from
> physically-plausible emissive sources with inverse-square-style falloff… the losing
> set substitutes a flat uniform ambient fill with no falloff, detached/absent
> contact shadows, and uniform roughness — so surfaces never respond to orientation
> and the scene reads as evenly-lit cardboard."

Specific defects they named, and what I could confirm:

| defect | status |
|---|---|
| Boss renders as featureless matte-black silhouette | **Confirmed as a lighting bug and fixed.** Not a material fault — zero dark non-emissive untextured materials exist in the scene. Character-height irradiance measured **2.608 at 3.7u from fire → exactly 0.000 at 17.9u**. Any actor beyond ~15u of a brazier was unlit. |
| Floors show parallel-ridge periodicity / tiling | **Confirmed, cause unknown.** I found this independently at 4× zoom before either judge reported it. One hypothesis (minification aliasing) is eliminated. |
| Flat ambient with no falloff; no contact shadows | **Confirmed** by the irradiance collapse above. This is the same root cause as the black boss. |
| "Large untextured dark-blue plane like a raw collision mesh" | **Not verified.** Named by one judge only; I ran out of session before isolating it. Worth checking first next round. |
| Uniform roughness / no orientation response | **Not verified.** |

The blind result is the honest headline: **a harsh critic, given no hints, picks PoE2
every time and is not close to fooled.** Everything below is what the instruments say
and what I changed.

---

# Exilium — final state, honestly reported

A playable isometric ARPG in Three.js with an entirely procedural art pipeline (no
downloaded assets: every texture, mesh, animation clip and sound is generated at
runtime), graded against real Path of Exile 2 reference frames by blind critics.

**It is not Path of Exile 2.** PoE2 is roughly 100 developers × 7 years on a
proprietary engine with terabytes of hand-authored art. This is a renderer and a
game built in one session. What follows is what actually holds up and what does not.

## Gate results — measured on a verified-clean harness

Five stations x six metrics, captured with all three harness guards active (see
*Harness*). **Every earlier number this session was measured on a broken bench and is
void**, including a 27/30 I published mid-session before finding the drift bug.

Final shipped configuration (`J`: face-frequency fix + character fill at 0.42):

| station | vis% | satVis | blk% | locC | spVar | meanL | pass |
|---|---|---|---|---|---|---|---|
| nave-lit | 34.82 | 0.373 | 5.18 | 0.00893 x | 0.8168 | 0.0203 | 5/6 |
| nave-wide | 33.95 | 0.424 | 2.13 | 0.00910 x | 1.3277 | 0.0225 | 5/6 |
| courtyard | 86.97 x | 0.319 | 1.14 | 0.01266 | 0.4154 x | 0.0471 | 4/6 |
| crypt | 42.06 | 0.505 | 4.00 | 0.01152 x | 0.9657 | 0.0265 | 5/6 |
| arena | 26.76 | 0.530 | 3.53 | 0.01104 x | 1.3749 | 0.0275 | 5/6 |

**24/30.** Gates: vis 12-60, satVis <=0.58, blk 0.5-11, locC >=0.012, spVar >=0.60,
meanL 0.012-0.075. Session start was 13/30.

### A tradeoff I made deliberately, against the metric

Three configurations were measured on the clean harness:

| config | gates | what it is |
|---|---|---|
| H | **25/30** | face-frequency fix only, no character fill |
| I | 24/30 | fill at 0.85 intensity / 13u range |
| J | 24/30 | **shipped** — fill at 0.42 / 11u |

**H scores one gate higher than what I shipped.** I chose J anyway. The fill costs
arena's `locC` (0.01273 -> 0.01104, an 8% miss on a 0.012 gate) because *any* fill in
dark regions compresses the lit-to-unlit ratio that `localContrast` measures. What it
buys is that actors stop rendering as pure black cut-outs — the defect both blind
judges independently ranked as the single worst thing in our frames, and a **gameplay**
bug rather than a cosmetic one, since enemies were invisible on unlit ground.

Halving 0.85 -> 0.42 recovered most of the contrast (crypt 0.00780 -> 0.01152, arena
0.00925 -> 0.01104) while keeping the visibility fix, which is why J ships rather
than I. A metric that punishes fixing an invisible-enemy bug is measuring the wrong
thing at that moment, and I would rather be honest that I overrode it than quietly
report 25/30 with black mannequins in frame.

### The one defect that dominates

`locC` (local contrast — micro-detail energy) misses at **three of five** stations,
clustered at 0.0089–0.0110 against a 0.012 gate. The analyzer's own top verdict says
it plainly: *"no micro detail… surfaces read as untextured plastic."*

I attempted one fix — halving the `face` relief field from 128/64 to 64/32 texel
frequency, on the hypothesis that minification aliasing was eating the detail. It
earned **+1 gate** (arena reached 6/6, crypt +0.0018, courtyard −0.0005) and is kept
on that evidence. But **the hypothesis was wrong**: the visible defect it targeted —
regular parallel diagonal striping on grazing-angle stone, plainly visible at 4×
zoom — did not change. Halving the noise frequency would have visibly changed the
stripe period had the stripes come from that field. They did not.

**So the striping's true source is unidentified and this defect is open.** My
attempt to isolate it (stripping albedo/normal maps to separate geometry from
texture) produced a frame of a completely different subject because the camera had
moved between captures, and I discarded the result rather than reason from it. That
was the right call and it is also the honest end state: I know the defect is real, I
know one plausible cause is eliminated, and I do not know the cause.

## Harness — three real bugs found in my own instrument

This was the most valuable output of the session, and it is worth more than the
gate delta. `MEASUREMENT_NOTES.md` records eight errors in full; three were in the
measurement rig itself and silently corrupted every number taken before them.

1. **`World.player.pos.set()` does not reposition the player.** `_dest` in
   `player.js` is module-scoped and persists, so click-to-move still holds the old
   target and the player **walks back to it** during the settle. Traced: placed at
   (40, −31), accelerated to −4.0 u/s, arrived at (29.6, −21.2) — **12 world units
   away**. Every station was measuring wherever the player walked to. This is why
   the crypt appeared to have zero fire lights within 22u while the nave had six:
   the "crypt station" was sampling a corridor outside the crypt. 145 fire sources
   were near the real crypt the whole time, and I had already begun investigating
   the light pool and prop scatter as suspects — both innocent.
   **Fix:** `World.teleportPlayer(x, z)` sets position, zeroes velocity, and clears
   `_dest`.

2. **A held/stuck RMB re-targets the destination every frame.** Clearing `_dest`
   once is insufficient — line 163 rewrites it from the cursor's ground point on the
   next frame, so the player walks off again with `vel` still reading ~0 at sample
   time. Measured 7u of drift at a station that held perfectly for its first 3.5s.
   **Fix:** a 1.5s suppression window (`_holdT`) after any teleport, plus the bench
   re-asserts the station every 1.2s so drift can never accumulate.

3. **`requestAnimationFrame` is suspended in a background tab**, which freezes
   `World.time` and every `uTime`-driven effect (fire, mist, dust) — while
   `document.hidden` still reads `false` and the FPS counter still reports 60. A
   wall-clock settle can therefore capture a completely unsettled scene and it looks
   like an art defect. But a naive "did 9 seconds pass?" check is *also* wrong: the
   crypt runs at 20–28fps and advances only ~65% of real-time, so it wrongly
   discards a good station.
   **Fix:** gate on **simulated** seconds, polled, with a wall ceiling, declaring a
   stall only when the clock is genuinely flat across consecutive samples.

All three now assert in `tools/bench.js`, which **discards** a station rather than
publish a corrupted reading. They fired correctly on the final run: two stations
were rejected for drift and one for a stalled clock, and had to be re-captured.

## Findings that are load-bearing

### Shadow "flatness" was a hue problem, not a luminance problem

A blind judge called our shadows "a uniform cool-purple fill… corners read evenly
lit rather than falling away." The instinct is to raise shadow contrast. That would
have been wrong: our dark-band luminance spread was **40.0×** against poe2-07's
**15.1×** — we already had *three times* the reference's internal shadow structure.

The governing property was hue *variance*: ours 55.1° circular spread at mean hue
**307° (magenta)** versus poe2-07's 91.7° at 349°. Shadow **saturation matched
almost exactly** (0.410 vs 0.414), so this was never about how colourful the shadows
were — they were all *one* colour, and that colour was literally magenta.

### Warm-dominance and hue-spread are NOT in tension

An agent reported a structural conflict: a warm-dominant room is inherently one-hue,
so high warm% and high hue-spread can't coexist. Tested across six PoE2 frames:
**correlation(shadow warm%, shadow spread) = +0.57 — positive.** poe2-07 reaches
91.7° at 53.5% warm; poe2-11 reaches 84.4° at 58.0% warm.

The mechanism: every high-spread frame carries a substantial cool **minority**
(34.2%, 53.3%, 32.6%); every low-spread frame has a starved one (6.2% → 35°, 1.4% →
27°). Spread needs a dominant majority *plus* a genuine minority in real quantity —
about **55/33**. Full derivation in `SHADOW_HUE_FINDINGS.md`.

### The stone-twinning defect was fixed at source

Judge: "adjacent stones read as the same stone with only rotation differing." Cause:
the whole floor sampled **one** seamless texture, so any neighbour was an offset of
the same field. Fix: 4 independent stone cells baked into one 2048 atlas (2×2 ×
1024px), selected per-slab, × 8 rotation/mirror classes = **32 distinct
appearances** from a single texture upload — no extra draw call.

Adjacent-slab same-cell went **100% → 0%** (measured over 1200 pairs). Density is
~205 texels/wu against the pre-atlas build's ~198, matched deliberately so
decorrelation cost nothing in sharpness — verified: floor luminance occupies **100%
of its range** (6–185), i.e. no posterisation, with anisotropy at the hardware max
of 16.

## What I would do next, in order

1. **Find the striping's real source.** Re-run the map-strip isolation with the
   camera pinned, then bisect: geometry normals → vertex colour → AO → tonemap.
   It's the most visible remaining defect and it plausibly gates `locC` too.
2. **Land the 55/33 shadow-hue target.** The mechanism is measured and the levers
   are identified (moon brightness/saturation dominates; fog and hemiSky barely
   move it). An agent got the *ratio* to 45/35 but its cool lobe sat at 240–270°
   blue-purple, only ~115° from warm, capping spread at 57 — where PoE2's teal
   150–240° sits ~180° away and reaches 90.
3. **Fix courtyard's two misses** (vis 86.4 over the 60 ceiling; spVar 0.399 under
   0.60) — it is the only station below 5/6.

## Smoke test — the shipped build

Verified on the final configuration, headless Chromium:

- **Boots clean in 7.9s**, `__EXILIUM_ERROR` null throughout.
- **Movement works** — click-to-move and external teleport both hold position.
- **Combat is live** — firing Q/W/E/R spawned 411 transient VFX objects and player HP
  moved 1200 -> 1192, so damage resolution and enemy retaliation are both running.
- **Frame rate** (median over 8 samples per station): nave-lit 21, courtyard 30,
  crypt 30, arena 31. Below 60 but playable; this is a headless tab, not
  representative of a real GPU.
- **The character fill costs 0 fps** — measured by A/B toggling it at the arena, 30
  both ways. A transient 17fps reading occurred only with 411 VFX objects alive at
  once immediately after firing four skills.

## What exists

Procedural throughout — no downloaded assets. Every texture is baked at runtime from
noise primitives, every mesh generated, every animation clip hand-authored as
keyframes, all audio synthesised via Web Audio.

- **Renderer**: PBR with ACES tonemapping, CSM cascaded shadows, SSAO, bloom, SMAA,
  god rays, colour grading, analytic sky dome with aerial-perspective fog.
- **World**: procedural modular dungeon (7 room kinds: entry, nave, crypt, cistern,
  courtyard, collapsed, arena), instanced clutter under a 260-instance cap, decals,
  water surfaces, a 4-cell stone atlas x 8 rotation/mirror classes.
- **Game**: click-to-move with capsule collision, dodge-roll with root motion, 4
  skills, enemy AI with a director, loot with rarity tiers and affixes, HUD with
  orbs/skill bar/minimap/boss health, ragdoll physics, procedural audio.
- **Lighting**: 12-light pool reassigned by camera distance from ~1491 fire sources,
  per-room skylight pools, and the actor fill added this session.

## Two open defects, with the hypotheses I eliminated

I am recording these as **unresolved** rather than claiming a fix, because in both
cases I could see the defect, a blind judge named it independently, and every
quantitative hypothesis I tested came back clean.

### 1. Floor striping — parallel diagonal ridges on grazing-angle stone

Visible at 4x zoom; JudgeB called it "parallel-ridge periodicity", JudgeA "flat
repeating cobble". **Eliminated:** minification aliasing of the `face` relief field.
Halving its frequency (128/64 -> 64/32) changed the *metric* (+1 gate) but the stripe
period did not visibly change, which it would have if that field were the source.
Anisotropy is at the hardware max (16) with trilinear mips, so filtering is not the
cause either. **Still unknown.** Next step: strip albedo/normal maps with the camera
*pinned* (my attempt moved the camera and produced a frame of a different subject,
which I discarded), then bisect geometry normals -> vertex colour -> AO -> tonemap.

### 2. Wall "stacked untextured cubes with a light/dark checker"

JudgeA's exact words, and visible in the shipped frame. I hypothesised `perBlock *
0.22` on luminance was too strong. **Both tests refuted it:**

| | normalised adjacent-block jump | alternation rate |
|---|---|---|
| ours | 0.2785 | 0.4226 |
| poe2-07 | 0.3509 | 0.4124 |
| poe2-11 | 0.2173 | 0.4828 |

Our block-to-block *amplitude* sits between the two references, our wall mean
luminance (25.9) nearly matches poe2-07 (26.2), and our *alternation* rate — the
actual defining property of a checkerboard, since a checkerboard is about sign
flipping rather than magnitude — also sits between them. So the per-block variation
is neither too strong nor too regular.

Which means the percept comes from something I did not measure. The most likely
remaining candidates, in order: **absent mortar-line geometry** (blocks meeting with
a pure albedo seam and no recessed joint, so nothing reads as a *course*), **no
per-block relief** (the block face is planar, so it cannot self-shadow), and **no
contact shadow at the wall-floor junction** (JudgeA: "objects sit pasted onto the
floor"). All three are geometry, not texture — which is consistent with the striping
test also pointing away from texture.

**The honest summary of both: I know these defects are real, I have eliminated the
obvious causes, and I did not find the true ones.** Two wrong hypotheses each,
recorded so the next round does not re-test them.

## Running it

```bash
cd ~/Desktop/exilium
npm run dev                 # dev server, http://127.0.0.1:5188
# or the production build:
npx vite build && cd dist && python3 -m http.server 5212
```

Both verified booting clean with `__EXILIUM_ERROR` null. **Note:** `vite preview`
silently failed to bind in this environment (returned 405 on every asset with an empty
log while another process held the port) — serve `dist/` with a plain static server
instead, which was verified working.

Controls: right-mouse or click to move, Q/W/E/R skills, LMB basic attack, Space to
dodge-roll.

## Measurement artifacts

- `FINAL_REPORT.md` — this file
- `MEASUREMENT_NOTES.md` — all ten measurement errors, with the habits that catch them
- `SHADOW_HUE_FINDINGS.md` — the hue-variance derivation and the +0.57 correlation
- `blind/` — the four blind pairs and `KEY.json` (the answer key, withheld from judges)
- `shots/` — station captures per configuration: `G` (baseline), `H` (face fix),
  `I` (fill 0.85), `J` (fill 0.42, shipped), `DIST-final.png` (production bundle)
- `tools/bench.js` — the harness, now with all three guards

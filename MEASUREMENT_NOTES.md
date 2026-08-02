# Measurement methodology — and three errors I made in it

Recorded because the measurement apparatus produced wrong conclusions three
separate times this session, and each error is easy to repeat.

## Error 1 — comparing frames captured at different camera positions

I compared a round-1 frame against a round-2 frame and reported that
`localContrast` had dropped, implying the texture work had regressed. The two
frames had different camera positions and therefore different lit-area fractions
(pureBlack 11% vs 27%). `localContrast` is a luminance-Laplacian, so it tracks
exposure and lit-area far more strongly than it tracks texture quality. **That
comparison measured the camera, not the change.**

Fix: `tools/bench.js` pins five fixed world positions so every round photographs
the same pixels.

## Error 2 — a hypothesis that was arithmetically right and causally wrong

I computed that textures were 9x over-dense — 512 texels/world-unit against 56
screen-px/world-unit, forcing mip level ~3.2, so a 2048px hero map renders at an
effective 224px. **The arithmetic was correct.** I concluded that lowering texel
density would recover the missing micro-detail.

I then swept every material's `.repeat` across a 6.7x range (factor 1.0 -> 0.15).
`localContrast` measured 0.00386 / 0.00395 / 0.00386 / 0.00406 — flat within
noise. The hypothesis was disproved by its own test.

Why it was wrong: scaling `repeat` changes the *scale* of the repeat, never the
fact that the tile repeats identically. A blind judge diagnosed the real cause in
one look — "every Voronoi tile carries the identical bump-noise at the same
frequency" — which is a *repetition* problem, not a *resolution* problem. The
metric said "no micro detail" and I read it as "detail too fine to resolve" when
it meant "detail identical everywhere".

The eventual fix (FixRepetition) was mid-frequency height variation on stone
FACES: the height field had low-frequency form and per-texel grain that mips to
flat, but nothing in the 16-48 texel band that survives minification, so the
Sobel normal only fired at mortar seams. Face-interior post-mip Laplacian +130%.

## Error 3 — measurement noise larger than the signal

This is the worst one. After three rounds of "fixes" I ran the obvious control I
should have run first: **the same station, three consecutive captures, with no
code change at all.**

| metric | run 0 | run 1 | run 2 | spread |
|---|---|---|---|---|
| visiblePct | 14.27 | 34.94 | 17.40 | **93%** |
| meanLuminance | 0.0133 | 0.0339 | 0.0149 | **99.5%** |
| pureBlack% | 18.21 | 8.54 | 9.29 | **80.5%** |
| localContrast | 0.0086 | 0.0125 | 0.0087 | **40%** |
| satVisible | 0.5585 | 0.3780 | 0.5566 | **36%** |

The noise was larger than most of the deltas I had been attributing to fixes.
Rounds 4, 5 and 6 scored 18/30, 18/30, 17/30 gated metrics — a spread that is
indistinguishable from this noise. **Those three rounds of comparison were not
evidence.**

Cause: live combat. Transient VFX and enemy-attack PointLights fire between
captures; the lit-light count swung 20 -> 32 -> 20 with no code change. Enemy
emissive glows and rarity auras add to it.

Fix: `tools/bench.js` now freezes the AI, despawns enemies, and zeroes transient
VFX lights before capturing an ENVIRONMENT station, then waits 1.4s for particle
pools and light envelopes to drain. After the fix:

| metric | noise before | noise after |
|---|---|---|
| satVisible | 36.3% | **1.2%** |
| localContrast | 40.0% | **6.1%** |
| meanLuminance | 99.5% | **16.3%** |
| visiblePct | 93.1% | 39.1% |
| pureBlack% | 80.5% | 70.3% |

`satVisible` and `localContrast` became reliable immediately. `visiblePct` and
`pureBlack%` did not, and **my first diagnosis of why was wrong** — see error 4.

## Error 4 — I misdiagnosed my own residual noise, then tested it and found out

I attributed the leftover `visiblePct` (39%) and `pureBlack` (70%) noise to
drifting atmospheric dust motes crossing the visibility threshold, and wrote that
down as settled. Brazier flicker was measured at only 3.9%, which seemed to
support it by elimination.

So I pinned the two animated `uTime` uniforms (dust field, ground mist) to a fixed
phase, redefining the property so per-frame writes could not override it. **The
noise got WORSE** — `pureBlack` went from 70% to 148% spread.

Looking at the actual series rather than just the summary statistic showed the real
pattern: run 0 was a wild outlier on every metric (blk 38.4 vs 9-11 for later
runs) and the series then converged. That is not a random-drift signature. That is
**settling**.

The cause is the follow-camera. It is an exponential spring, so after the player
is teleported to a bench station the camera approaches its framing
*asymptotically* over many seconds. My 3s settle was photographing a camera still
in motion — and since framing determines how much lit geometry is on screen, that
dominated both metrics far more than any subsystem change.

Fix: a 9s settle. Nothing else.

| metric | 3s settle | 9s settle |
|---|---|---|
| pureBlack% | 70.3% | **8.4%** |
| visiblePct | 39.1% | **11.4%** |
| meanLuminance | 16.3% | **6.6%** |
| localContrast | 6.1% | **2.4%** |
| satVisible | 1.2% | **0.7%** |

**Every metric is now trustworthy, including the two I had written off.** The
uniform pin was reverted — it was not the fix, and mutating a shared uniform's
property descriptor is risk without benefit.

The lesson compounds error 3 rather than replacing it. There I learned to measure
the noise floor before believing a delta. Here I learned that having a noise
number is not the same as knowing its *cause*, and that a plausible cause reached
by elimination is still a guess. **Looking at the series instead of the summary
statistic is what exposed it** — a spread of 70% hides the difference between
"random scatter" and "one outlier then convergence", and those have opposite
fixes.

## Standing rules

1. Never compare frames from different camera positions.
2. Before believing a delta, measure the no-change noise floor for that metric.
3. A metric can be numerically correct and causally misleading — `localContrast`
   is low both when texture is flat AND when the frame is dark. Disambiguate
   before acting.
4. Freeze non-deterministic systems before measuring anything they can influence.
4b. **Let the scene SETTLE, and look at the series, not just the spread.** An
   exponential follow-camera converges asymptotically; a summary statistic cannot
   distinguish one settling outlier from genuine scatter, and the two have
   opposite remedies.
5. Prefer a deterministic probe at the source (FixRepetition measured its
   texture's post-mip Laplacian directly) over a whole-frame render metric, which
   mixes in every other subsystem's contribution.


## Error #6 — comparing a whole-frame statistic against a shadow-band target

I told an agent its shadow cool fraction was starved at 11% and to raise it to
~33%. The 11% was a **whole-frame** warm/cool statistic; the shadow-band figure
was cool **75%** — flooded, not starved. The correct move was the exact opposite
of what I instructed: warm the shadow band (warm 14 → ~55, cool 75 → ~35).

The agent caught it, and caught it the right way: it had calibrated its
shadow-band method against a reference frame first, reproducing poe2-07 at
55.5/34.4 versus my independently measured 53.5/34.2 — agreement within a point on
both channels. A method that reproduces a known reference is a method worth acting
on, including when it contradicts the person who set the target.

This is structurally identical to error #1 (comparing two different camera
positions): **a number from one measurement domain used against a threshold derived
from another.** Whole-frame warm/cool is dominated by lit brazier stone and says
almost nothing about the shadow band. I had broadcast this exact lesson to the team
four times before committing it myself while writing a target.

The underlying finding survived intact — spread needs a dominant majority plus a
genuine minority in real quantity (~55/33), and that is direction-agnostic. Only
which side you approach it from changed. It also re-aligned with ground truth I had
measured earlier and then lost sight of: PoE2 firelit interior shadows are **warm**,
median hue ~69°. A cool-flooded shadow band contradicts that directly, and my
target would have deepened the contradiction.

**Habit:** before using a measured number as a target, state the exact pixel
population it was computed over, and confirm the target threshold was derived over
that same population. "11% cool" and "cool ≥ 30%" were never about the same pixels.

## Error #5 — trusting that a setup did what it was asked

`World.player.pos.set(x, y, z)` does not reposition the player. `_dest` in
player.js is module-scoped and persists, so click-to-move still holds the previous
target and the player **walks back to it** during the settle. Traced at the crypt
station: placed at (40, −31), accelerated to −4.0 u/s, arrived at (29.6, −21.2) —
**twelve world units away** — then stopped.

Consequences: every station reading taken this way measured wherever the player
walked to. The crypt "station" was sampling a corridor 12u outside the crypt, which
is why it appeared to have zero fire lights within 22u while the nave had six. There
were 145 fire sources near the actual crypt the whole time. I had already begun
investigating the light pool and prop scatter as suspects — both innocent.

What exposed it: predicting the vignette accounted for 4.5 points of pure black,
sweeping it to zero, and getting under 2. The failed prediction is what redirected
the search. A confirmed prediction would have closed the investigation on the wrong
cause.

**Fix on disk:** `World.teleportPlayer(x, z)` sets position, zeroes velocity, and
clears `_dest`. Verified zero drift over a full 9s settle. `tools/bench.js` now uses
it and **asserts post-settle that the player is within 1.0u of the station**,
discarding the reading if not.

**Habit — the one that would have caught four of six errors:** after establishing a
measurement condition, *measure that the condition holds* before measuring the thing
you care about. I asked for the player at (40, −31) and never once checked it was
there.


## Errors #7 and #8 — two wrong ways to measure "banding"

An agent was cancelled mid-fix on a suspected minification banding regression, so I
picked up the defect. My first two measurements both produced a false positive.

**#7 — the measurement window included the HUD.** I sampled y 0.55–0.95 of the
frame to catch the floor at grazing angle. The HUD occupies the bottom strip, and
flat UI graphics produce long runs of identical luminance — precisely the signature
of posterisation. `maxRun` came out 98px against the references' 18–24. I nearly
reported flat UI vector art as a texture artifact.

**#8 — comparing distinct-level counts across different luminance ranges.** On
floor-only pixels ours showed **180** distinct levels against both references'
**250**, and mean run 1.32 vs 1.09. That reads as posterisation. It is not: our
floor spans L=6–185 while the references span L=6–255. **A surface that dark cannot
have 250 levels.** The correct metric is occupancy of the range actually present:

| | L range | span | present | occupancy |
|---|---|---|---|---|
| ours | 6–185 | 180 | 180 | **100.0%** |
| poe2-07 | 6–255 | 250 | 250 | 100.0% |
| poe2-11 | 6–255 | 250 | 250 | 100.0% |

Every level in our range is present. Identical occupancy to the reference. The
"deficit" was entirely an artifact of comparing a count against a threshold derived
over a wider range — the same shape as errors #1 and #6.

**What the residual signal actually was.** After both corrections one signal
survived: 43 runs of ≥25 identical pixels, all at L=8–9, clustered at one location.
I cropped that region at 3× and looked at it: **an unlit doorway void framed by
stone.** A genuinely dark architectural opening, correctly rendered. Anisotropy was
independently confirmed at the hardware max of 16 with trilinear mips, so filtering
was already optimal and could not have been the cause either.

**Conclusion: banding does not reproduce.** The atlas ships at grid=2 × 1024px,
density ~205 texels/wu against the pre-atlas shipped build's ~198 — matched
deliberately, so decorrelation cost nothing in sharpness.

**Habit:** a level/bucket count is only comparable between two images if both span
the same range. Normalise to occupancy of the range present, or compare only within
a fixed range. And when an aggregate verdict disagrees with a single outlier
statistic, *look at the pixels* before believing either — cropping the region
answered in one glance what two rounds of statistics had confused.

## Tally

Eight measurement errors in one session, and **six** share one shape: a number
compared against a threshold derived over a different population — different camera
position (#1), different pixel domain (#6), different luminance range (#8),
different UI-vs-scene content (#7). The other two came from trusting a setup without
verifying it held (#5) and from a causally-wrong-but-arithmetically-correct
hypothesis (#2).

Two habits would have caught all eight:
1. **State the exact pixel population** a number was computed over, and confirm the
   threshold was derived over that same population.
2. **Verify the measurement condition actually holds** before measuring the thing
   you care about.

## Errors #9 and #10 — two refuted hypotheses on the wall checkerboard

A blind judge said our walls read as "stacked untextured cubes in a white/dark
checker." I hypothesised the per-block luminance term (`perBlock * 0.22`) was too
strong — that I had fixed stone twinning and overshot into checkerboarding.

**#9 — measured amplitude, which was fine.** Normalised adjacent-block luminance jump:
ours 0.2785, poe2-07 0.3509, poe2-11 0.2173. Ours sits *between* the references, and
wall mean luminance (25.9) nearly matches poe2-07 (26.2). The amplitude is correct.

**#10 — realised amplitude was the wrong property, measured alternation, also fine.**
A checkerboard is defined by *sign alternation*, not magnitude. Gradient sign-flip
rate: ours 0.4226, poe2-07 0.4124, poe2-11 0.4828. Again between the references.

Both hypotheses refuted. The percept is real — I can see it and a judge named it
without prompting — but it is not per-block colour variance in either amplitude or
regularity. The remaining candidates are all *geometry*: absent mortar-line relief,
planar block faces that cannot self-shadow, and no contact shadow at the wall-floor
junction. Notably the floor-striping investigation also pointed away from texture,
toward geometry.

**Habit:** when a hypothesis is refuted, check whether you measured the property the
percept is actually *about*. "Too much variance" and "too regular a variance" are
different claims needing different instruments, and I initially conflated them. And
when two independent investigations both point away from the same subsystem
(texture), believe the convergence.

## Final tally

Ten measurement errors in one session. **Six** share one shape: a number compared
against a threshold derived over a different population — different camera position
(#1), different pixel domain (#6), different luminance range (#8), UI-vs-scene content
(#7). Two came from trusting a setup without verifying it held (#5, and the sim-clock
stall). Two came from measuring a property adjacent to, but not identical with, the
one the percept was about (#2, #9/#10).

Three habits would have caught nearly all of them:
1. **State the exact pixel population** a number was computed over, and confirm the
   threshold was derived over that same population.
2. **Verify the measurement condition actually holds** before measuring what you care
   about — the bench now asserts position drift AND simulated-clock advance, and
   discards a station rather than publish a corrupted reading.
3. **Name the property the percept is about** before choosing an instrument. Then when
   a hypothesis is refuted, re-ask whether the instrument matched the claim.


## Round 11 — the "raw collision mesh" complaint, three candidates eliminated

A blind judge reported *"a large untextured dark-blue plane sitting mid-scene like a
raw collision mesh that never got a material"* in the nave, and called it the single
most damning tell in our frame. It was carried into this round unverified. Three
candidates are now eliminated by read-only scene inspection (no camera needed, so it
cost nothing and did not contend with the agents holding the tab):

1. **No stray untextured mesh exists.** Only two large (>25 sq units) untextured
   meshes in the entire scene, and neither is bluish: `atmos-mist` (220x220,
   ShaderMaterial, correctly transparent) and one invisible 6.3x6.9 mesh. A search
   specifically for large surfaces with `b > r*1.15 && b > g*1.05` returned **zero**.

2. **The water planes are not the culprit by position.** Two exist, at 34.8 and 52.1
   world units from the nave centre — `water-3` (25.8u across) and `water-6` (12.5u).
   Neither sits mid-nave.

3. **The water is not frozen.** This was my best hypothesis: water is a large flat
   plane, and I had already proven rAF suspension freezes `uTime` effects, so a
   frozen water surface would render as exactly "a flat blue plane". My probe found
   `MeshStandardMaterial` with **zero uniforms and no time value**, which appeared to
   confirm a dead animation. It did not: water animates by scrolling `map.offset` and
   `normalMap.offset` in `materials.frame()` (a `_animated` list, lines 857-861),
   which is the correct technique for a `MeshStandardMaterial` and invisible to a
   uniform-based probe. **My instrument was looking for the wrong mechanism.**

That last one is the same error shape as the rest of this file: I chose an instrument
matched to my assumption (shader uniforms) rather than to the property (does the
surface animate). The corrected check is to sample `map.offset` twice and see if it
moved.

Note `PlaneGeometry(w, h, 1, 1)` gives water a single unsubdivided quad, so it can
never have geometric wave displacement — but a scrolling normal map on a flat quad is
a legitimate and cheap approach for a small pool at isometric distance, so this is a
deliberate tradeoff, not a bug.

**Status: unresolved with three candidates ruled out.** The remaining possibility I
find most plausible is that the judge was describing a real surface reading badly
rather than a missing material — a large dark floor or water plane at grazing angle
with too little detail to read as a material at all, which would be consistent with
the `localContrast` deficit that misses at four of five stations.


## Round 11 — the 40-60 degree "hue rotation" that does not exist

A previous round concluded our rendered shadow cool lobe sat at **240-270deg
blue-purple** while every PoE2 reference sits at **~205deg teal**, and that the fix
was to find and compensate the rotation. Our committed `SKY_MOON` is
`(0.020, 0.540, 0.880)` — **hue 203.7, already teal**. So something appeared to
rotate hue by 40-60 degrees between the light and the pixel. I tested both candidate
stages analytically, with no camera and no renderer.

**Albedo multiplication — ruled out.** Componentwise product of the light with the
actual recipe albedos:

| surface | albedo | result hue | rotation |
|---|---|---|---|
| stoneFloor (h34 s.15 l.32) | (0.368, 0.326, 0.272) | 196.3 | −7.7 |
| stoneWall (h212 s.10 l.30) | (0.270, 0.298, 0.330) | 207.3 | +3.3 |
| cobble (h28 s.16 l.28) | (0.325, 0.277, 0.235) | 197.2 | −6.8 |

Every result stays teal. Warm stone albedo does not swing a teal light to purple.

**The colour grade — ruled out, by checking the math rather than the comment.**
`gradeShader.js` claims "hue is NEVER shifted (chroma-only)". That claim is true of
every operation present:

- `color *= uGain` — scalar multiply; hue-preserving.
- `color += uLift * shadowW` — adds the **same scalar to all three channels**. Hue
  depends on channel *differences* and on `max−min`; an equal offset leaves `g−b` and
  `max−min` unchanged, so hue is preserved **exactly** and only saturation drops.
- `color = mix(vec3(l), color, satMul)` — moves along the grey axis; hue-preserving
  by construction.
- `pow(color, vec3(uGamma))` — the only per-channel nonlinearity, and at `uGamma =
  1.02` the shift is a fraction of a degree.

The LGG config is scalar throughout (`lift 0.014, gamma 1.02, gain 1.03`), so no
per-channel tint exists anywhere in the chain.

**Conclusion: there is no mechanism that rotates hue by 40-60 degrees.** The
240-270 figure almost certainly describes a tree state that never existed on disk —
it was measured against a cancelled agent's *uncommitted* experimental moon
`(0.06, 0.34, 0.60)`, which is genuinely blue-purple. The committed value is teal.

**The error, and it is mine:** I passed an inherited number into a new round's brief
without confirming it described the tree being measured. That is error #1's shape one
level up — a threshold derived over one population (an uncommitted experiment) applied
to another (the shipped tree). An agent could have spent a full round compensating for
a rotation that was not there, and a compensating pre-rotation would then have been
actively wrong.

**Habit:** an inherited baseline is an unverified claim. Re-measure it on the current
tree before optimising against it, especially when it came from a session whose work
did not land.


## Round 11 — a phantom defect created by my own grep syntax

I nearly reported that `OutputPass` was missing from the composer chain, which would
have meant ACES tonemapping never ran and would plausibly have explained the
courtyard's compressed 2.4x dynamic range. It was a complete phantom.

What happened: I ran `grep -rn "OutputPass\|ToneMapping\|outputColorSpace"` — GNU BRE
alternation with an escaped pipe. **The embedded shell does not support that**, so the
pattern matched literally and returned nothing. I read "no matches" as "not present".

`OutputPass` is in fact imported on line 11 and added on line 133, correctly ordered
after bloom and before the grade pass — which is exactly what the file's own comment
claims and what the design requires, since the grade operates in display-referred
sRGB. There is no double-tonemap and no missing tonemap.

Two things worth keeping:

1. **A tool returning "nothing found" is a claim that needs the same scrutiny as a
   measurement.** Zero results can mean absence, or it can mean the query was
   malformed. I have a catalogued habit of confirming that a measurement condition
   holds before trusting a measurement; the same applies to a search. Use `grep -E`
   for alternation, or the built-in grep tool which takes Rust regex.

2. The near-miss is the same shape as the stale-baseline error earlier this round:
   I was primed by a real symptom (the courtyard's flat range) and a mechanism that
   would elegantly explain it, so a null result felt like confirmation rather than a
   query failure. **A hypothesis you want to be true lowers your standard of evidence
   for it.** The courtyard's range deficit is real, but tonemapping is not its cause.

Incidental finding while reading the chain: a **second GTAOPass already exists**
(`contactPass`, constructed at line 327, added at line 130) alongside the main
`gtaoPass`. So the "add a tighter second AO term" idea I put in an agent's brief was
already implemented — another case of a brief written from assumption rather than from
reading the file first.


## Round 11 — reading a live tree and mistaking new work for old

I broadcast to four agents that a second GTAOPass "already exists" in pipeline.js and
that the agent assigned to AO should tune it rather than add another. It was that
agent's **own work from this session**. I read the file mid-round, found code I did not
remember, and assumed it predated the round.

Three of my errors this round share one shape, and it is a new one for this file:
**trusting a snapshot without establishing when it was taken.**

1. The 240-270deg hue baseline described an *uncommitted* tree from a cancelled
   session — work that never landed on disk.
2. A grep "found nothing" because the syntax was malformed, not because the code was
   absent.
3. Code read mid-round was assumed to be pre-existing when it was minutes old.

With several agents editing concurrently, reading the tree tells you the **present**,
not the baseline. A file is not a stable reference during a parallel round.

## The AO finding — a judge complaint reduced to a measured geometric fact

Both blind judges independently named uniform darkening. JudgeB's exact contrast was
that the reference has *"ambient occlusion sitting in the actual displaced rock cracks
rather than as a uniform darkening"*. The cause turned out to be a kernel-scale
mismatch, quantified by the AO agent:

- The broad GTAO pass runs at **radius 0.42 world units ≈ 20 AO texels**.
- A mortar joint is **3.5-20x narrower than that kernel**.
- An occlusion kernel wider than the feature integrates the seam together with the
  open floor beside it, so it **cannot darken the seam differentially** — it darkens
  the whole neighbourhood equally.

That is the uniform-darkening defect, as geometry rather than as taste.

**Ground sampling distance, and a cross-agent constraint that prevented a null
round.** I had flagged a risk: GTAO is screen-space, so it can only occlude what it
can resolve in depth. If the masonry agent cut joints shallower than the AO agent's
resolution, both changes would fail, each agent would see a null result, and neither
would know the other was the reason. The two agents settled it directly:

- 1 AO texel ≈ **0.034wu** on the ground, **0.048wu** vertical
- therefore joints must be ≥ **0.10wu deep** and ≥ **0.12wu wide** to resolve
- the masonry joints land at **0.14-0.22wu** — clears it with margin

**Habit:** when two subsystems must meet at a physical scale, make them agree on the
number BEFORE either builds. A shared constraint stated up front converts a probable
mutual null result into two changes that reinforce each other.


## Round 11 — why localContrast resisted three rounds: it is an ABSOLUTE metric

This is the most useful thing found this round and it reframes a gate that has failed
at four of five stations across three rounds.

An agent measured that stripping the floor texture maps **raises** rendered
localContrast by ~3x (nave-lit 0.0174 -> 0.0473, crypt 0.0133 -> 0.0394) and inferred
that baked detail mips flat at distance and suppresses contrast. The measurement is
correct; the inference needed one more step.

Checking the metric's definition in `tools/analyze.mjs`:

```js
const localContrast = lapSum / Math.max(lapN, 1);   // mean |Laplacian(luminance)|
```

**Absolute mean Laplacian magnitude — no normalisation by mean luminance.** So
multiplying a lit surface by a dark albedo scales its absolute gradients down
proportionally. Our stone albedo luminances:

| material | albedo luminance |
|---|---|
| stoneFloor (h34 s.15 l.32) | 0.3313 |
| stoneWall (h212 s.10 l.30) | 0.2944 |
| cobble (h28 s.16 l.28) | 0.2842 |

Predicted suppression from albedo alone: **1 / 0.33 = 3.0x**. Observed: **2.72x and
2.96x**. Albedo scaling accounts for essentially the entire effect — the textures are
not destroying detail; an absolute metric on a deliberately dark surface simply scores
lower.

### The consequence, which is strategic

**You cannot win this gate by adding micro-detail to dark surfaces.** A 3x-darker
surface needs 3x the relative structure to score the same absolute number. That is why
three rounds of texture work barely moved it, and why halving the face-relief
frequency last round moved only one station.

What raises an absolute luminance gradient is a bigger absolute luminance **range** —
genuinely bright pixels adjacent to genuinely dark ones. poe2-07 scores 0.0197 and its
lit areas are brighter than ours; reference dynamic ranges are 17x and 101x against our
courtyard's 2.4x.

Two mechanisms therefore work, and both are geometry/lighting rather than texture:

1. **Restore dynamic range.** Bright where light reaches, genuinely dark where it does
   not. This raises absolute gradients at *every* station simultaneously — so the
   courtyard exposure fix is also a localContrast fix.
2. **Create gradients geometrically.** A lit slab face beside a shadowed recessed joint
   is a real luminance step that does not depend on texture surviving minification.
   Recessed joints plus a tight AO kernel produce exactly this.

**Habit:** before optimising a metric, read its definition. Absolute versus normalised
determines whether a dark art direction is fighting you, and three rounds were spent
on the wrong mechanism for want of a two-minute look at the formula.


## Round 11 — I retracted my own synthesis within the hour: we are NOT dark

Twenty minutes after broadcasting the "localContrast is absolute, therefore our dark
art direction fights the gate, therefore restore brightness/range" synthesis to four
agents, I checked the premise I had never tested: **are we actually darker than PoE2?**

We are not.

| frame | locC | meanL | locC/meanL |
|---|---|---|---|
| poe2-05 | 0.01630 | 0.0177 | 0.921 |
| poe2-07 | 0.01935 | 0.0255 | 0.759 |
| poe2-09 | 0.02025 | 0.0278 | 0.728 |
| poe2-10 | 0.01419 | 0.0143 | 0.992 |
| poe2-11 | 0.02008 | 0.0202 | 0.994 |
| poe2-12 | 0.06704 | 0.0657 | 1.020 |
| **ours nave-lit** | 0.00893 | 0.0203 | **0.440** |
| **ours crypt** | 0.01152 | 0.0265 | **0.435** |
| **ours arena** | 0.01104 | 0.0275 | **0.401** |
| **ours courtyard** | 0.01266 | 0.0471 | **0.269** |

mean meanLuminance: refs **0.0285**, ours **0.0304** — we are slightly *brighter*.
mean locC/meanL: refs **0.902**, ours **0.386**.

At essentially identical brightness, PoE2 carries **2.3x more local luminance
variation per unit brightness**. Normalising for brightness does not rescue us; it is
the cleanest statement of the deficit. **We genuinely lack structure.**

**The decisive datum**, which kills the brightness theory outright: the courtyard is
our *brightest* station (meanL 0.0471, 65% above the reference mean) and has our
*worst* locC/meanL (0.269). If brightness bought structure, the courtyard would be our
best localContrast station. It is our worst. We had already run that experiment by
accident.

### What survived and what did not

- **Survived:** localContrast is an absolute mean |Laplacian|, unnormalised. And
  albedo scaling genuinely explains the maps-ON/OFF 3x ratio (predicted 3.0x from
  albedo luminance 0.33; observed 2.72x and 2.96x).
- **Retracted:** extrapolating from "absolute metric" to "we fail because we are
  dark". The 3x map-strip ratio and the 2.3x reference deficit are **different
  phenomena** and I conflated them.

That conflation is error #1's shape for the tenth time: **a mechanism derived over one
comparison applied to a different comparison.** Knowing the failure mode by heart and
having catalogued it nine times did not prevent committing it again — which is the
strongest argument yet for the habit being a *checklist step* rather than a thing to
remember.

**Habit:** when a mechanism explains comparison A, state explicitly which comparison it
was derived over before applying it to comparison B. And check the premise that makes
the conclusion follow — "we are dark" was load-bearing, unstated, and false.

**Consequence for the round:** the geometry agents were on the correct axis and I
nearly talked them off it. Structure must be *added*, not brightened into visibility.


## Round 11 — the localContrast deficit is DEPTH, not COUNT (why three rounds failed)

The single most actionable measurement of the project. Distribution of adjacent-pixel
luminance **step sizes**, nave-lit vs poe2-07, HUD excluded:

| step bucket | ours count% | poe2 count% | ratio | ours energy% | poe2 energy% |
|---|---|---|---|---|---|
| <0.01 | **71.53%** | 53.01% | **0.74x** | 24.6% | 9.7% |
| 0.01–0.02 | 16.77% | 18.30% | 1.09x | 26.4% | 13.0% |
| 0.02–0.04 | 9.15% | 14.23% | 1.55x | 27.4% | 20.0% |
| 0.04–0.08 | 2.02% | 9.50% | **4.70x** | 11.5% | 25.9% |
| >0.08 | 0.52% | 4.96% | **9.52x** | 10.0% | 31.3% |

**The deficit is not uniform across step sizes — it is almost entirely in the large
steps.** We are at parity or better below 0.02 and catastrophically short above 0.04:
4.7x fewer medium-large steps, 9.5x fewer large ones.

**And we have MORE fine grain than PoE2, not less** — 71.53% of our steps are under
0.01 versus PoE2's 53.01%. We are *noisier* at the fine scale and *flatter* at the
coarse scale.

The energy columns show why this dominates the metric: PoE2 draws **57.2%** of its
total gradient energy from steps above 0.04; we draw **21.5%**. Our energy is spread
thinly across a haze of sub-0.01 steps contributing 24.6% of our energy against PoE2's
9.7%.

### This retrospectively explains three failed rounds

Every previous attempt at this gate added **micro**-detail — finer grain, higher
frequency relief, more noise. **We were adding to the one bucket where we already
exceed the reference**, and that bucket carries little energy. Halving the face-relief
frequency moved exactly one station, for precisely this reason.

### The corrected instruction

- **One joint producing a >0.08 luminance step is worth ~20 that produce 0.01 steps**,
  by energy. Prioritise joint DEPTH and the lighting contrast across a joint over joint
  density.
- **Do not increase joint count or add finer surface detail.** Already over-supplied.
- The target is a rendered luminance step >0.04, ideally >0.08, ACROSS each joint —
  a recess deep enough that its interior is genuinely shadowed while the adjacent slab
  face stays lit. Bias to the deep end of the 0.14–0.22wu range.
- Per-slab face relief is worth more when it makes whole FACES differ in brightness
  from their neighbours (a large step at the slab boundary) than when it adds
  within-face texture (small steps).
- For AO: the acceptance test is whether the step ACROSS a joint exceeds 0.04, **not**
  whether mean darkening increased. Softly dimming a neighbourhood produces many small
  steps — the defect. Darkening a joint interior while leaving the face lit produces one
  large step — the fix.
- For lighting: a defined pool EDGE (lit stone beside deep shadow) produces large steps;
  a smooth falloff produces small ones.

**Habit:** when a metric aggregates a distribution, look at the DISTRIBUTION, not the
mean. "We lack local contrast" and "we lack *large* local contrast steps while having
an excess of small ones" imply opposite fixes, and the mean cannot distinguish them.
Three rounds were spent on the wrong end of the histogram.


### It generalises: zero overlap across all six references and all five stations

Share of gradient **energy** from luminance steps >0.04:

| reference | energy% | | ours | energy% |
|---|---|---|---|---|
| poe2-05 | 49.8% | | nave-lit | 21.6% |
| poe2-07 | 57.3% | | nave-wide | 17.1% |
| poe2-09 | 57.4% | | crypt | **37.4%** |
| poe2-10 | **49.4%** | | arena | 26.4% |
| poe2-11 | 68.0% | | courtyard | **11.3%** |
| poe2-12 | 82.6% | | | |

Reference range **49.4–82.6%**; ours **11.3–37.4%**. **Our best station is below the
weakest reference.** Not one of our frames overlaps one of theirs. Step-count deficit
7.3x (refs 18.52% of steps >0.04, ours 2.53%); energy deficit 2.7x.

**Acceptance target adopted for the round:** share of gradient energy from steps >0.04,
**22.8% → 45%+**. Brightness-independent, subsystem-agnostic, measurable on any frame.

Two corroborations that this is the real defect rather than an artifact:

1. The **courtyard** is our worst station here (11.3%), and independently our worst on
   locC/meanL (0.269), and independently the only station below 5/6 gates. Three
   instruments agree on which station is worst.
2. The **crypt** is our best (37.4%) and is the station with the most geometric clutter
   — sarcophagi, rubble, broken vaulting. **More geometry, more large steps.** The
   proposed mechanism appears in the data unprompted, which is the strongest available
   evidence that recessed joints and per-face relief are the right fix.


### The metric had to exclude the HUD — full-frame flattered us 3x

My first implementation of `largeStepEnergyPct` measured the full frame. Full-frame,
ours read **47.91%** against poe2-07's **56.98%** — a small gap that would have declared
this defect nearly solved. HUD-excluded:

| | full-frame | HUD-excluded |
|---|---|---|
| ours nave-lit | 47.91% | **15.62%** |
| poe2-07 | 56.98% | **54.50%** |

**The reference barely moves; ours collapses by 32 points.** Our HUD is itself a large-
step generator — hard-edged gold orb rims, crisp skill-icon borders, the minimap frame
— and PoE2's frames carry far less of that per pixel. The HUD is also the one thing no
renderer change can affect, so including it measures the wrong population by
definition. This is the **fourth** time the HUD has corrupted a measurement in this
project; it is now excluded inside the tool so nobody has to remember.

Authoritative baselines (scene window y 12–72%, x 8–92%):

| frame | largeStepEnergyPct | largeStepCountPct |
|---|---|---|
| ours courtyard | **3.97%** | 0.12% |
| ours nave-lit | 15.62% | 0.19% |
| ours crypt | **47.40%** | 0.81% |
| poe2-10 | 48.57% | 1.43% |
| poe2-07 | 54.50% | 4.19% |

Two things this reveals:

1. **The crypt is already at reference level** (47.40% vs poe2-10's 48.57%). Our most
   geometrically cluttered station has nearly closed the gap on the metric that
   separates us everywhere else — the strongest available evidence that geometric
   clutter is the mechanism, and a working proof of concept to copy.
2. **The courtyard at 3.97% is ~1/12 of the weakest reference** — not merely our worst
   station but a different regime.

The **count** column refines the earlier "depth over count" conclusion: poe2-07 has
4.19% of steps >0.04 against nave-lit's 0.19% — a **22x count deficit** while energy is
3.5x short. So the references have *many more* large steps, each contributing less
individually. The instruction is therefore **many deep steps** — every joint and slab
boundary producing a real step — not a few dramatic features per room.


### The mechanism is LIT/UNLIT BOUNDARY DENSITY — not geometric clutter (I was wrong)

I had told three agents the crypt's 47.40% proved geometric clutter was the mechanism.
Measuring geometry density per room refuted my own claim:

| room | trisPerArea | objPerArea | largeStepEnergyPct |
|---|---|---|---|
| nave | **479.4** | 0.339 | **15.62%** |
| crypt | **55.3** | 0.238 | **47.40%** |
| courtyard | 27.5 | 0.173 | 3.97% |

**The crypt has 8.7x LESS geometry density than the nave and scores 3x better.**

Floor irradiance distribution explains it:

| room | p10 | median | p90 | zeroFrac | contrast |
|---|---|---|---|---|---|
| crypt | 0.000 | 0.000 | 0.688 | **0.88** | huge |
| nave | 0.891 | 5.687 | 19.716 | **0.09** | 22.1 |
| entry | 2.676 | 10.383 | 25.767 | 0.01 | 9.6 |

**The crypt has 88% of its floor at zero irradiance with small bright pools; the nave
has 9% and is near-uniformly lit.** Every lit-pool boundary is a large luminance step.
The crypt is full of them; the nave has almost none.

This explains every data point:
- crypt: 88% dark + small pools → many boundaries → 47.40%
- nave: 9% dark, evenly lit → few boundaries → 15.62% *despite 8.7x the geometry*
- courtyard: no fire-pool structure at all → 3.97%, our worst
- and poe2-07's large-step **count** of 4.19% vs our 0.19% — the references are full of
  small hard-edged light pools.

**Consequence:** a recessed joint only produces a large step if its interior is unlit
while the face beside it is lit. In a room that is 91% lit at uniform intensity there
is little darkness available to fill the recess — which is exactly why the nave's 479
trisPerArea buys it nothing today. Geometry and lighting are **multiplicative**, not
alternatives. AO is the exception: it creates boundaries by occlusion regardless of how
uniform the fill is, making it the highest-leverage change for an evenly-lit room.

### The Goodhart trap on this metric

An agent measured that stripping the floor maps raises largeStepEnergyPct to **46.04%
(nave-lit) and 44.25% (crypt)** — at or past the 45% target. **And maps-OFF is exactly
the flat "untextured plastic" look both blind judges condemned.**

So the metric can be maximised by *deleting* detail into the original failure mode. It
is **necessary but not sufficient**: large steps must be added BESIDE textured surfaces,
never by removing the fine detail that makes stone read as stone. The agent that found
this refused to make the edit and escalated instead, which is the correct call.

**Habit:** before adopting a metric as a target, find the degenerate solution that
maximises it. If a change that obviously worsens the artifact can satisfy the metric,
the metric needs a companion guard — here, the fine-grain buckets must not *fall* while
the large-step share rises.


### The corrected target is a PAIR, and the Goodhart warning was half right

Adding the fine-grain guard produced numbers that partly lift the Goodhart concern:

| frame | large% | fine% |
|---|---|---|
| ours courtyard | 3.97 | **74.32** |
| ours nave-lit | 15.62 | **67.36** |
| ours crypt | 47.40 | 38.33 |
| poe2-10 | 48.57 | 30.29 |
| poe2-07 | 54.50 | 18.83 |
| poe2-11 | 53.36 | 16.93 |

**We have a large SURPLUS of fine grain, not a deficit at risk.** References draw
17–30% of gradient energy from sub-0.01 steps; we draw 38–74%. The courtyard draws
three quarters of its energy from a haze of near-invisible micro-steps.

So the Goodhart warning was right about the *degenerate* case (strip all texture → fine
→ 0 → plastic) but both the agent and I missed a large healthy middle: **reducing our
excess fine grain toward the reference range is not Goodharting, it is converging on the
reference on both axes at once.** 67% → 35% lands beside poe2-10's 30.29%. 67% → 3% is
the plastic failure. Completely different changes — and only a *paired* metric
distinguishes them.

**Adopted two-sided target:**

```
largeStepEnergyPct  >= 45%      (references 48.6 - 54.5)
fineStepEnergyPct    17 - 35%   (references 16.9 - 30.3)
```

Large alone is satisfiable by deleting texture. Fine alone is satisfiable by changing
nothing. Together they describe the reference and nothing else does.

A useful diagnostic falls out of the pair: a recessed joint *converts* fine haze into a
large step, so energy moves from one bucket to the other and **both metrics improve
together**. If large rises while fine stays at 67%, structure was layered on top of the
haze. If large rises AND fine falls toward 30%, the haze was replaced by structure —
which is what the reference looks like.

**Habit:** when a single metric has a degenerate maximiser, the fix is usually not a
warning but a *second* metric that the degenerate solution fails. Then the pair is the
target and the guard cannot be forgotten under time pressure.


### The decisive ablation, produced by accident

An agent reported apologetically that its light-freeze regex matched only lights named
brazier/torch/sconce/candle, so it had **zeroed the crypt's fire-pool lights**, and that
its crypt absolute read 2.82% against my 47.40%.

That is not an artifact — it is an **ablation study**:

| crypt condition | largeStepEnergyPct |
|---|---|
| with fire pools | **47.40%** |
| fire pools zeroed | **2.82%** |
| | **17x** |

Same room, same geometry, same textures, same camera. The only change is whether the
lit/unlit pool structure exists. Remove it and the crypt collapses from best-in-project
(essentially reference-level) to worst-in-project — **below even the courtyard** — with
all 118 prop instances and every texture still present. Large-step energy fell **94%**.

**Lit/unlit boundary density is the mechanism.** Geometry without pooled lighting
produces almost nothing. My "geometric clutter is the mechanism" claim is now doubly
refuted: first by the nave carrying 8.7x the geometry at a third the score, now by a
17x within-room ablation.

It also explains that agent's negative AO result (−2.32 at nave-lit): its A/B ran on a
de-pooled crypt and on near-uniformly-lit naves (zeroFrac 0.09). **AO cannot manufacture
a large step where there is no darkness available to fill the recess.** Its own
diagnosis — that its r=0.18 kernel added a soft sub-0.04 *ramp* rather than a step, in
the wrong bucket — is consistent, and its retune (radius 0.18→0.12, below the ~0.15
joint spacing so open floor stays lit; scale 1.25→1.8 to drive interiors genuinely dark)
follows the mechanism correctly.

**Lesson: a reported "artifact" that changes one variable by a large factor is an
experiment.** Read contamination reports for what they accidentally isolate.

### Third band correction from an incomplete sample

I published `largeStepEnergyPct >= 45%` from a partial reference sample. The full set:

| frame | large% | fine% |
|---|---|---|
| poe2-05 | **32.88** | 33.62 |
| poe2-07 | 54.50 | 18.83 |
| poe2-09 | 58.72 | 15.76 |
| poe2-10 | 48.57 | 30.29 |
| poe2-11 | 53.36 | 16.93 |
| poe2-12 | 77.61 | 4.71 |

**poe2-05 is a genuine PoE2 frame scoring 32.88%** — my threshold would have marked the
reference itself as failing. Corrected band:

```
largeStepEnergyPct  >= 40%  in-family;  >= 50% matches the median reference
fineStepEnergyPct    5 - 34%
```

Third time this round I set a threshold from an incomplete sample and had to widen it.
**Habit: derive a band from the FULL reference set before publishing, never from the two
frames closest to hand.**


### The courtyard: same fire-source count as the crypt, 12x worse score

Counting actual fire **sources** per room (not the 12 live pool lights):

| room | fireSources | per 100 sq units | largeStepEnergyPct |
|---|---|---|---|
| entry | 319 | 139.48 | — |
| nave | 250 | 33.75 | 15.62% |
| cistern | 167 | 26.65 | — |
| collapsed | 140 | 24.94 | — |
| **crypt** | **118** | 23.86 | **47.40%** |
| **courtyard** | **119** | 17.33 | **3.97%** |
| arena | 215 | 17.02 | — |

**The courtyard is not starved of fire sources** — it has 119, essentially the crypt's
118, at the same order of density. The crypt scores 12x better.

The courtyard's pools are not missing, they are **erased**. Its luminance distribution:
p05 **0.1281**, dynamic range **2.4x**, against poe2-05's p05 0.0147 at 17.3x. Nothing
in the courtyard is dark. Its 119 fire sources sit in a room whose skylight fills every
shadow to ~0.20, and **a bright pool on a bright floor is not a boundary.**

Self-consistent across both rooms:
- crypt: 88% of floor at zero irradiance → 118 sources → 118 hard boundaries → 47.40%
- courtyard: 0% at zero irradiance → 119 sources → no boundaries → 3.97%
- **same source count, opposite outcome; the only difference is whether darkness exists
  for the pools to contrast against**

This makes the courtyard fix purely **subtractive**: stop filling the shadows. No new
lights, no new occluders, no restructuring. Dim the skylight and global fill until p05
falls toward 0.03–0.05 and the existing 119 sources produce pool structure by
themselves.

**One cause, four failing measurements:** vis% 86.97 (ceiling 60), spVar 0.4154 (floor
0.60), largeStepEnergyPct 3.97%, fineStepEnergyPct 74.32%.

### A sequencing risk worth recording

An agent identified that two independent fine-grain reducers — geometric joints
converting fine haze to large steps, and a texture grain trim — **stack**, and could
punch through the 17% fine floor into the plastic regime. It proposed contingent
sequencing: land geometry first, measure, and trim grain only if fine remains above
35%. Adopted. It also noted `fineStepEnergyPct` is a **screen** metric (mip- and
lighting-dependent), so landing it precisely needs a re-bake plus pinned capture rather
than an analytical guess.

**Habit:** when two changes move the same metric in the same direction, sequence them
and re-measure between, rather than shipping both and discovering the overshoot after.


### The share-vs-quantity error: I read a ratio as an amount, twice

An agent noticed that `fineStepEnergyPct` and `largeStepEnergyPct` **divide by the same
denominator**, so they are not independent — deleting fine grain shrinks the denominator
and mechanically raises large% while lowering fine%. I verified it, and it is worse than
reported: **the maps-OFF plastic failure PASSES my paired target outright** (large 46.04%
≥ 40 ok, fine 11.53% within 5–34 ok). My companion guard was decorative.

Replaced with an absolute, denominator-independent measure — `detail.fineStepEnergyAbs`,
mean fine-step energy per sampled pixel. The absolute numbers invert the conclusion:

| frame | fineStepEnergyAbs | allStepEnergyAbs |
|---|---|---|
| ours nave-lit | 0.001349 | 0.002003 |
| ours crypt | 0.001312 | 0.003423 |
| ours courtyard | 0.002840 | 0.003821 |
| poe2-07 | 0.001491 | 0.007915 |
| poe2-05 | 0.001662 | 0.004942 |
| poe2-11 | 0.002082 | 0.012298 |

**We do not have excess fine grain.** In absolute terms our fine detail (0.00131–0.00284)
sits at or slightly *below* the references (0.00149–0.00208). The nave has **less** fine
detail than poe2-07, not 2–4x more.

My "massive surplus of fine grain" claim was an artifact of reading a **share** as if it
were a **quantity**. Our fine share looked huge (67–74% vs 17–30%) only because our
denominator is tiny. Acting on it would have pushed us *below* reference on the one axis
where we already match, while making both share metrics look better — the exact Goodhart
failure the guard was meant to prevent. I nearly instructed an agent into it.

**The real deficit is total gradient energy and it is entirely large steps:** ours
0.0020–0.0038 vs reference 0.0049–0.0123, a 2–3x shortfall, with our fine component
already at parity. **100% of the gap is missing large steps.**

Final corrected target:

```
fineStepEnergyAbs   HOLD 0.0013-0.0028   (already at reference — do not reduce)
allStepEnergyAbs    RAISE 0.0020 -> 0.0049+
largeStepEnergyPct  rises as a CONSEQUENCE, not a thing to optimise directly
```

**Habit:** a percentage is a ratio, not an amount. Before comparing shares between two
populations, check the denominators — and when a share looks anomalous, compute the
absolute quantity before drawing any conclusion. This is the same population-mismatch
family as error #1, in its most disguised form yet: the two numbers were computed over
the same pixels, with the same instrument, and were still not comparable.

**Meta-observation for the round:** two agents were more useful by *refusing* to edit
than by editing — one proving its subsystem was not the cause and handing off clean
evidence, the other refusing an unbounded change and escalating the design question.


### Final absolute reference band (fourth and last correction)

Derived from the **complete** six-frame reference set:

| frame | allStepEnergyAbs | fineStepEnergyAbs |
|---|---|---|
| poe2-10 | **0.002683** | 0.000813 |
| poe2-05 | 0.004942 | 0.001662 |
| poe2-09 | 0.007180 | 0.001132 |
| poe2-07 | 0.007915 | 0.001491 |
| poe2-11 | 0.012298 | 0.002082 |
| poe2-12 | 0.034539 | 0.001625 |
| **reference band** | **0.00268 – 0.03454** | **0.00081 – 0.00208** |

Per-station verdicts, which are **not uniform** — the reason aggregate framing kept
misleading me:

- **nave-lit** — allAbs 0.00200 is *below* the reference floor (0.00268): genuinely short
  on total energy. fineAbs 0.00135 is mid-band: fine detail correct. → add large steps,
  remove nothing.
- **crypt** — allAbs 0.00342 in band, fineAbs 0.00131 mid-band → **passes on absolutes.**
  Our best station, confirmed a third independent way.
- **courtyard** — allAbs 0.00382 **in band**, fineAbs 0.00284 **above** the reference max
  (0.00208) → it *has* reference-level gradient energy, but in the **wrong bucket**:
  spread as sub-0.01 haze across a uniformly-lit plane instead of concentrated into hard
  lit/unlit boundaries (largeStepEnergyPct 3.97%).

That courtyard diagnosis is the sharpest statement of the defect anywhere in these notes:
**it is not short of energy and not underlit — its energy is distributed wrong.**
Converting haze into boundaries requires no new energy, only redistribution, which is
exactly what removing the shadow fill accomplishes: same 119 sources, same total energy,
now with darkness for the pools to read against.

**Four band corrections in one round**, each from an incomplete sample. The habit that
would have prevented all four: compute the band over the full reference set *once*,
before publishing any target.


### Counting glowing geometry instead of light-casters

I broadcast per-room "fire source" counts (nave 250, crypt 118, courtyard 119) and built
a density argument on them. They were wrong. The probe traversed for
`emissiveIntensity > 0.5` meshes, which counts **flame-lick InstancedMesh instances and
embers** — geometry that GLOWS but casts **no floor irradiance**.

Clustering the nave's 250 licks at a 1.6u single-link threshold gave **43 clusters at 5.8
licks each**. An agent reading the authoritative registry (`World.lightSources`, which
feeds the 12 pooled PointLights) found **51 light-casters across all seven rooms** — so
even my clustered figure was still counting non-casters.

The `range/spacing = 3.58` figure came from a *different* probe that filtered
`isPointLight && intensity > 0`, i.e. genuine casters, and that population is correct.
But it carries a subtler bias: **the 12-light pool is selected by camera proximity**
(`reassignLights` picks the nearest `maxLights=12`), so those 14 casters are the densest
cluster in the level near where the camera sat. Their 4.2u spacing describes *local*
density at one station, not the level average — and with 51 casters over 7 rooms the
average is far lower.

Both facts can hold at once, and it took an agent's challenge to separate them:
- 3.58x overlap is **real for the rendered frame** at that station, since those are the
  lights actually lighting it. The nave wash is genuine.
- Calibrating a **global** range reduction from a locally-dense sample would over-tighten
  where casters are sparser, risking `meanLuminance` below the 0.012 floor.

Incidental finding: `lightSpacing = 7.2` **is** enforced for braziers (`farEnough` +
`markOcc`) but **not** for torches/sconces/candles, which use a smaller per-type
`meta.gap`. So caster spacing may be bimodal — well-spaced braziers with tightly-packed
smaller sources between them — and the correct fix may be per-**type** rather than global.

**Habit:** "how many light sources are there" has at least three different answers in a
renderer — glowing meshes, registered sources, and currently-pooled lights — and they
differ here by 30x (1547 emissive instances, 51 registered casters, 12 pooled). Name
which one a number refers to, every time. And when a population is selected by proximity
to the camera, any statistic over it is a *local* statistic, never a global one.


### range/spacing predicts the score monotonically — the mechanism, quantified

Per-room light-**casters** from `World.lightSources` (51 total across 7 rooms):

| room | casters | per 100sq | nnMedian | range | **range/spacing** | largeStepEnergyPct |
|---|---|---|---|---|---|---|
| **crypt** | 5 | 1.01 | 15.63 | 15 | **0.96** | **47.40%** |
| arena | 3 | 0.24 | 10.51 | 14 | 1.33 | 26.4% |
| courtyard | 5 | 0.73 | 8.86 | 15 | 1.69 | 3.97% |
| **nave** | 7 | 0.94 | 7.40 | 15 | **2.03** | **15.62%** |
| entry | 5 | 2.18 | 3.83 | 15 | 3.92 | — |
| cistern | 11 | 1.75 | 4.15 | 15 | 3.61 | — |
| collapsed | 7 | 1.25 | 6.16 | 14 | 2.27 | — |

**Monotonic across every unconfounded room:** 0.96 → 47.40%, 1.33 → 26.4%, 2.03 → 15.62%.

The crypt is not our best station because of clutter (it has 8.7x *less* geometry than the
nave) nor because it has more lights (5 casters vs the nave's 7). **It wins because its
casters sit 15.6u apart with a 15u range, so each pool ends almost exactly where the next
begins** — textbook pooled lighting, arrived at by accident from room dimensions.

The nave has the *same* 15u range at 7.4u spacing, so every pool blankets its neighbours
and 7 casters produce one smooth wash instead of 7 pools.

The **courtyard** is the sole outlier (ratio 1.69 but 3.97%) and it is explained: its
skylight fill erases whatever pool structure exists. Confirmed independently — dimming the
skylight fixes `visiblePct` and `spatialVariation` but leaves largeStep at 2–3. **Two
independent defects in one room.**

### Why shrinking range is safer than dimming

A `PointLight` with `decay = 2` falls off as 1/(1+d²), and `range` is a hard **cutoff**,
not a scale. Shrinking range does **not** dim the pool core — it removes only the dim
outer skirt. And that skirt is precisely the sub-0.01 fine haze we hold in excess. So
range-tightening converts haze into boundaries **without touching core brightness**:
`allStepEnergyAbs` rises, `fineStepEnergyAbs` stays flat, which is exactly the corrected
target's asymmetry.

Dimming, by contrast, lowers `meanLuminance` toward its 0.012 floor while leaving a wash a
wash.

**Habit:** when a spatial parameter and a spacing both exist, their RATIO is usually the
governing quantity, not either one alone. Three rounds treated light intensity as the lever
when range/spacing was the actual control — and the ratio was discoverable from the scene
graph at any point without a single capture.


### The "crypt is 88% dark" comparison was invalid — camera-dependent light pool

I claimed the crypt had 88% of its floor at zero irradiance against the nave's 9%, and
built a darkness-based explanation on it. **Invalid.** That probe used the **12 lit pool
lights**, and the pool is selected by camera proximity. When it ran, the player was at the
**arena** — so the crypt's casters were not pooled and the crypt merely *appeared* dark. I
was measuring "how much of room X is lit while the camera sits in room Y", for two rooms,
neither of which held the camera.

Recomputing from the full registry (camera-independent):

| room | casters | dark@1.0 | meanIrr@1.0 | dark@0.55 | meanIrr@0.55 |
|---|---|---|---|---|---|
| nave | 7 | **0.00** | 6.71 | 0.18 | 5.45 |
| crypt | 5 | **0.00** | 6.85 | 0.16 | 5.79 |
| courtyard | 5 | 0.00 | 6.34 | 0.32 | 5.35 |
| arena | 3 | 0.55 | 1.14 | 0.78 | 0.85 |
| entry | 5 | 0.00 | 11.92 | 0.18 | 10.40 |
| cistern | 11 | 0.00 | 13.31 | 0.14 | 11.47 |
| collapsed | 7 | 0.00 | 9.57 | 0.14 | 8.23 |

**The crypt is not dark.** With all casters lit it has zero dark floor, identical to the
nave. So darkness is *not* why it scores 47.40%.

**The corrected mechanism is lighting VARIATION, not darkness.** Crypt spacing 15.63 with
range 15 means its pools just barely touch, so the floor reads bright-core → dim-midpoint →
bright-core. The nave at spacing 7.4 with range 15 has pools blanketing each other into a
smooth sum. "Creates darkness" was the wrong framing; "creates variation" is right — and
range/spacing is precisely what controls it.

The main finding survives because its two inputs come from sound populations: range/spacing
from the camera-independent registry, and largeStepEnergyPct from captures taken with the
camera **at** each station. The monotonic correlation stands.

It also **derives** the fix factor rather than guessing it: at 0.55 the nave's dark fraction
becomes 0.18 against the crypt's 0.16 — the nave acquires almost exactly the crypt's
structure.

**Habit:** any quantity computed from a camera-proximity-selected subset is a statement
about the camera's position as much as the subject's. Before comparing two rooms, verify
the measurement did not depend on which room the camera occupied — and prefer the
camera-independent registry when one exists.


### HMR does not apply build-time values — a change can be inert while appearing committed

After committing the per-type light range change and confirming a green build, the live
registry still reported the **old** values (brazier 22, torch 15). Cause: `lightSources`
entries **copy** `range` and `baseInt` at placement time inside `placeOne`, so hot-replacing
the `P` constant does nothing to already-placed casters. The values are baked at level
build; only a **full page reload** re-runs placement.

I caught it only because I read the value back off the live object instead of trusting the
save. Any measurement taken after an HMR save may be measuring the **pre-change** tree while
you believe it is post-change.

The distinction that matters: values read **per-frame** (shader uniforms, `World.lighting`)
hot-apply; values **copied into a registry or baked into geometry at build time** (light
ranges, prop placement, textures, mesh construction) do not.

After a full reload the change landed and matched the analytical prediction exactly:

| room | predicted cv / dark | measured live cv / dark |
|---|---|---|
| nave | 1.78 / 0.13 | **1.78 / 0.13** |
| arena | 3.48 / 0.75 | **3.48 / 0.75** |
| courtyard | 2.16 / 0.30 | **2.16 / 0.30** |
| crypt | 1.69 / 0.09 | **1.69 / 0.09** |

Every room to the decimal — the analytical irradiance model is validated end-to-end against
the live scene, so lighting-structure changes can now be predicted without a capture.

Live registry composition: 51 casters — **29 torch**, 15 sconce, 5 brazier, 2 candle.
Torches are 57% of all casters and took the deepest cut (15 → 7), consistent with the
diagnosis that the wash was dense fillers.

**Habit:** after writing a value, read it back off the live object and confirm it equals what
you wrote. This is the second time this round the same habit would have saved a wasted
measurement (the first was the stale 240–270° hue baseline). "The build is green" and "the
change is in effect" are different claims.


### The HMR trap generalised: a per-subsystem map of what hot-applies

An agent traced the exact freeze path for baked textures, which is worse than the light
case because it is **double-cached**:

1. `getStoneAtlas` caches the baked atlas in `materials.js` `_atlasCache`.
2. `level.js` `atlasMat()` clones a material, assigns `atlas.map/normalMap/roughnessMap/
   aoMap` **at level-build time**, and caches that material in `level.js`'s own
   `_atlasCache`.
3. Scene meshes hold references to those material objects.

So on HMR, even if the atlas re-bakes, the built floor meshes still point at the **old**
material and texture objects. A `materials.js` edit needs a full reload to measure, exactly
like geometry.

**What hot-applies vs what does not:**

| change | hot-applies? | why |
|---|---|---|
| shader uniforms (AO radius/scale, grade params) | **yes** | read per-frame |
| `World.lighting` intensities / colours | **yes** | read per-frame |
| light `range` / `baseInt` in props config | **no** | copied into `lightSources` at placement |
| baked textures (materials.js) | **no** | double-cached atlas + cloned material at build |
| geometry (level.js joints, prop placement) | **no** | constructed at level build |
| runtime `material.map = null` + `needsUpdate` | **yes** | mutates the live object |

That last row is why the strip-maps A/B evidence stands: it toggled the live material
rather than editing source, from the same pinned camera seconds apart. And the analytical
probes re-bake fresh in Node with no HMR involved at all. The agent verified its **own**
measurements were not caught by the trap rather than assuming immunity — which is the part
worth copying.

**Habit:** before measuring a change, ask whether the value is read per-frame or captured at
build time. If captured at build time, reload. Then read the value back off the live object
to confirm. "Saved" → "built" → "in effect" are three distinct states and only the third
matters.


### Fill compression: a mechanism that does not exist at our exposure

I promoted an agent's flagged-as-unquantified hypothesis into an instruction: that a strong
constant ambient fill compresses highlight steps post-tonemap, so cutting `envIntensity`
0.72 / `hemi` 0.13 would convert existing pool structure into rendered step energy at every
station. I asked the lighting agent to do it mid-commit.

Then I modelled it. Rendered step = `aces((L_hi+F)*k) - aces((L_lo+F)*k)`, with `k`
calibrated so the measured nave irradiance 8.43 lands at its measured rendered luminance
0.0203:

| fill (linear) | nave pool step | vs zero-fill |
|---|---|---|
| 0.00 | 0.04390 | 100.0% |
| 0.20 | 0.04447 | 101.3% |
| 0.50 | 0.04530 | **103.2%** |

**Adding fill slightly INCREASES rendered step energy.** At our exposure we sit far down in
the ACES **toe**, which is expansive; the compressive shoulder is nowhere near our floor
values of 0.02–0.04 rendered. Cutting global fill would have *reduced* step energy while
pushing `meanLuminance` toward its 0.012 floor — actively harmful, and it would have consumed
an agent's commit.

I reasoned from "ACES is compressive at the top end" without checking **where our actual
pixel values sit on the curve**.

**The durable form of the proof** (found independently by the agent, and better than my
numeric table): calibrate the combined gain from two measured anchors — nave meanIrr 8.43
→ measured rendered meanL 0.0203, giving k = 3.62e-3 and an operating input x = 0.0305 —
then take the **sign of the second derivative** of the ACES curve there. It is **convex**.
Convex means the curve is *expansive* at that point, so a constant offset applied to two
inputs necessarily *widens* their output separation. This is not an empirical observation
that compression "didn't happen"; it is a proof that it **cannot** happen at this exposure,
independent of what value the fill takes. Two independent calibrations of k from the same
measured anchors agreed, which pins the model to measurement rather than to either of our
assumptions.

### The mis-specified prediction behind it

I had pre-registered: "if largeStepEnergyPct moves less than the range/spacing math predicts,
the residual is fill compression." The arena gave cv +53% but largeStepEnergyPct +15%, and I
read that gap as confirmation. But the two quantities are not proportional and never were:

- **cv** — coefficient of variation of *irradiance*, sampled over a room's whole walkable
  floor, in *world space*, from the registry.
- **largeStepEnergyPct** — share of *adjacent-pixel luminance-step* energy in a *screen-space*
  window, post-albedo, post-tonemap, over everything in frame including walls, props and
  characters.

Different populations, different spaces, different pixel sets. There was no basis for
treating their ratio as a diagnostic, so the "prediction" tested an assumption I had invented.
**Pre-registering a prediction does not make it well-formed** — it only fixes it in advance.

**Habit:** before using a curve's behaviour as an argument, locate your actual values on it.
And before treating two metrics as proportional, state the transformation between them; if you
cannot write it down, the ratio is not a diagnostic.


### The floor-relief revert: the same idiom did not transfer from walls to floors

Recessed mortar joints shipped successfully on **walls** (+8.15% scene triangles, **zero**
draw-call delta, merlons byte-identical). The identical idiom applied to **floors** was
measured and **reverted**: floor diag/anti moved 0.836 → 0.815, i.e. *further* from the 1.06
reference target, with ~zero large-step energy added.

This was predicted when the scope was expanded: *"the running bond is the SOURCE of the
anti-diagonal bias, so consider whether your recess alone fixes the direction or merely
deepens it. A strictly staggered bond has a consistent diagonal axis through its joint
pattern; recessing those joints could make the existing directionality MORE visible rather
than less."* Recessing a joint pattern that is itself the source of the directionality
amplifies it.

**The floor striping defect therefore remains OPEN.** Status:

- **Root cause established:** the running-bond slab *grid geometry* in `buildFloors` —
  proven three independent ways (atlas isotropic in memory with structure-tensor coherence
  0.043 and random per-cell dominant orientation; screen-space anisotropy survives stripping
  every floor map; power spectrum peaks equally in U/V/diagonal/anti-diagonal).
- **Eliminated:** texture recipe, texture filtering (anisotropy already at hardware max 16
  with trilinear mips), atlas twinning (0% adjacent same-cell over 1200 pairs), posterisation
  (100% range occupancy), minification aliasing of the face relief field, and now joint
  recession.
- **Unknown:** what geometric change breaks the anti-diagonal bias *without* deepening it.
- **Next hypothesis:** bond **phase** rather than joint depth — vary the running-bond row
  phase (an existing `fr.range(0, 1.7)` jitter may be too weak) so no single diagonal axis
  dominates, or break the strict row structure entirely.

**Habit:** an idiom that fixed one surface is a hypothesis on the next surface, not a
solution. The walls' joints ran across a bond whose direction was incidental; the floor's
joints run along the axis that *is* the defect.


## Round 11 final bench — 25/30, and an unexplained regression

Captured pinned (drift 0 at all five stations), 9.6+ simulated seconds, **combat frozen and
transient lights zeroed**, 39–41fps, boot green.

| station | vis | satV | blk | locC | spVar | meanL | lgStep | allAbs | pass |
|---|---|---|---|---|---|---|---|---|---|
| nave-lit | 27.14 | 0.409 | 9.07 | 0.00843 ✗ | 0.9086 | 0.0185 | 8.67 | 0.001558 | 5/6 |
| nave-wide | 27.10 | 0.411 | 4.61 | 0.00905 ✗ | 1.4420 | 0.0228 | 8.79 | 0.001458 | 5/6 |
| courtyard | 41.22 | 0.476 | 1.38 | 0.00881 ✗ | 0.8850 | 0.0258 | 6.51 | 0.001821 | 5/6 |
| crypt | 26.75 | 0.570 | 6.50 | 0.00729 ✗ | 1.0733 | 0.0146 | 11.01 | 0.001139 | 5/6 |
| arena | 66.88 ✗ | 0.525 | 0.93 | 0.01256 | 0.8057 | 0.0350 | 16.44 | 0.004508 | 5/6 |

**25/30, up from 24/30 — and for the first time every station is 5/6**, with the courtyard up
from 4/6. The arena now overshoots `visiblePct` (66.88 vs a 60 ceiling), which is my arena
light fix trading one gate for another; the right trade, since its `meanLuminance` was
*failing* at 0.0062 before.

### The unexplained part

`largeStepEnergyPct` fell hard against the pre-round J-series baselines: crypt 47.40 → 11.01,
nave-lit 15.62 → 8.67, arena 41.44 → 16.44. Two candidates eliminated:

1. **Not a combat-population artifact.** Same tree, same camera, only combat toggled: **11.10%
   ON vs 10.60% OFF.** Combat contributes 0.5pp, not 36.
2. **Not the range tightening.** Reverting `lightRange` to the originals and re-measuring made
   it **worse**: crypt 11.01 → 8.1, nave 8.67 → 7.2, arena 16.44 → 14.79. So the range change
   is worth about **+2.9pp** at the crypt and was restored.

Remaining suspects: the wall joints, the AO retune, the sky.js teal rotation, or something
about the J-series captures not yet identified. The teal rotation moved `SKY_MOON` and
`HEMI_SKY` substantially and `largeStepEnergyPct` is a *luminance*-step metric, so a hue
rotation that shifts luminance distribution is the leading suspect — **untested, and not
asserted.**

### The deeper lesson: I optimised a proxy that moved the opposite way

I spent most of this round improving `cv` — the coefficient of variation of **world-space
irradiance** sampled over each room's walkable floor, from the light registry. It rose
substantially (nave 1.30 → 1.78) and I verified it live to the decimal.

But the target metric, `largeStepEnergyPct`, measures **screen-space rendered luminance
steps** over everything in frame. `cv` went up while the metric it was supposed to predict
went **down**. The range revert proved the direction was still net-positive, so the change
survives — but the proxy was not measuring what I believed, and I published a "pre-registered
prediction" that assumed proportionality between them.

**Habit:** a proxy earns trust only by being shown to track the target across at least two
points. I validated that `cv` responded to my change; I never validated that `cv` predicts
`largeStepEnergyPct`. Those are different claims, and the whole round's calibration rested on
the one I did not test.


### The teal rotation cleared — and a real share-vs-quantity tension

My leading suspect for the largeStep regression was the sky.js teal rotation, on the reasoning
that a hue change shifting luminance distribution would move a luminance-step metric. Tested
properly: same tree, same camera, zero drift, combat frozen, only the skylight/hemi colour
swapped back to pre-rotation values at runtime.

| crypt | lgStep | allAbs | locC | meanL | satVisible |
|---|---|---|---|---|---|
| teal (current) | **12.24%** | 0.001150 | 0.00743 | 0.0151 | 0.563 |
| pre-rotation | 6.09% | **0.002056** | 0.00898 | 0.0205 | 0.613 |

**The rotation DOUBLES largeStepEnergyPct** (6.09 → 12.24) — the opposite of my hypothesis.
Suspect cleared. It also pulls `satVisible` 0.613 → 0.563, which is part of why the crypt still
passes that gate at 0.570 against a 0.58 ceiling.

**But it exposes a genuine engineering tension**, not a measurement error this time: the
rotation lowers `meanLuminance` 0.0205 → 0.0151 and therefore lowers **absolute** step energy
0.002056 → 0.001150, while *raising* the large-step **share**. A darker frame has smaller
absolute gradients, but a larger fraction of them are big.

- `largeStepEnergyPct` (a SHARE) says the rotation is a clear win.
- `allStepEnergyAbs` (a QUANTITY, and the one that must reach the reference floor 0.00268)
  says it costs 44% of our total gradient energy.
- Our crypt `allAbs` is now 0.001139 against that 0.00268 floor — **2.4x short**.

**The honest statement of where the project stands: we are not short of large-step SHARE so
much as short of total rendered gradient ENERGY**, and several changes this round improved the
share by darkening the frame, which moves the quantity the wrong way.

The lever that raises absolute step energy *without* darkening is **brighter lit pools against
equally dark surroundings** — raising pool-core intensity, not lowering ambient or shifting
hue. The range tightening did some of that (+2.9pp at the crypt, verified by revert) and is the
only change this round that raised the share without costing luminance.

**Regression status:** eliminated as causes — combat VFX (0.5pp), the range change (reverting
made it worse), the teal rotation (it helps). Remaining: wall joints, the AO retune, or a
J-series baseline that is not comparable for an unidentified reason.


### The shipped frame is 96.4% warm — the one-hue failure, quantified

Final production build, arena, mid-combat:

| | warm% | cool% | neutral% | shadowHue |
|---|---|---|---|---|
| **ours (shipped)** | **96.4** | **3.2** | 0.4 | 10 |
| poe2-07 | 65.0 | 22.4 | 12.6 | 5 |
| poe2-09 | 57.8 | 26.8 | 15.4 | 175 |
| poe2-11 | 68.1 | 21.7 | 10.1 | 1.5 |

**We have ~7x less cool content than the references.** That is the "monochrome brown wash"
visible in the frame, and it is the *same mechanism* derived from the references earlier this
round: hue spread requires a warm **majority** plus a genuine cool **minority in real
quantity** (~55/33, correlation +0.57). The references sit at 58–68 warm / 22–27 cool — warm
majority, cool minority present. We are at 96/3, which is one-hue by any measure.

Note the shipped frame is otherwise strong: `largeStep 26.10%`, `allStepEnergyAbs 0.005328`
(**above** the 0.00268 reference floor — the best absolute figure measured this round),
`locC 0.01522` (**passing** the 0.012 gate), `meanL 0.0366`, `pureBlack 1.92%`.

**Why the arena specifically:** it is a forge interior lit entirely by fire, and the code
deliberately gave it a *warm* ember-glow skylight fill (to survive a darker grade without
flipping to a cold blue tomb). Warm fire + warm fill = no cool source anywhere. The nave's
teal rotation cannot help a room that has no cool light in it.

**The next round's highest-value change, precisely specified:** give the arena a motivated cool
minority — up-facing surfaces that see sky, deep corners away from fire, or a cold rim from a
non-fire source — targeting ~30% cool while holding the warm majority. This is the same
prescription the reference measurement produced, applied to the one room that never received it.


# ROUND 12

## "Neutral" has two completely different causes, and I briefed only one

I wrote four agent briefs treating `neutralPct` as "low-saturation pixels". Reading
`analyze.mjs`'s actual classifier:

```
warm    = hue 340-65   AND sat > 0.10
cool    = hue 170-280  AND sat > 0.06
neutral = EVERYTHING ELSE
```

**Neutral is a residual category, not a saturation category.** Hues in **65–170**
(yellow-green through cyan-green) and **280–340** (magenta) count as neutral **at any
saturation**, because they fall in the gaps between the warm and cool bands. Two entirely
different routes produce a neutral pixel and I described only one.

Decomposing each frame's neutral mass by *why* each pixel qualifies:

| frame | neutral n | low-sat% | green-gap% | magenta-gap% |
|---|---|---|---|---|
| poe2-07 | 23256 | 42.0 | 30.7 | 27.4 |
| poe2-09 | 24517 | 45.3 | 46.6 | 8.1 |
| poe2-10 | 36682 | 66.8 | 26.7 | 6.5 |
| poe2-11 | 21352 | 39.9 | 13.9 | 46.2 |
| poe2-12 | 133195 | 1.0 | 98.8 | 0.2 |
| **nave-lit** | **14870** | 19.9 | **78.9** | 1.2 |
| **crypt** | **507** | 25.8 | 55.4 | 18.7 |
| **arena** | **364** | 35.4 | 42.0 | 22.5 |

The references use **both** routes (40–67% low-saturation, 14–47% hue-gap). Neither is a trick.

**The actionable finding: the crypt and arena have a COUNT problem, not a composition
problem.** 507 and 364 neutral pixels against the naves' 14,870 and the references'
21,000–36,000 — a **30–60x shortfall in count**, while their internal mix (26/55/19 and
35/42/23) is not far from poe2-07's (42/31/27). There is simply almost nothing there.

## The satFloor hypothesis, killed before an agent spent a round on it

I had briefed that `uSatFloor 0.72` might structurally forbid a neutral population, since
`satMul = mix(0.72, 1.0, smoothstep(0, 0.32, l))` never drops below 0.72. The arithmetic:
a pixel needs source saturation ≤ 0.10/0.72 = **0.139** to land neutral-by-saturation in the
warm band. Two of four stone recipes are already below it (`stoneWall` 0.10, `wetStone` 0.13);
`stoneFloor` 0.15 and `cobble` 0.16 sit just above.

So the grade does **not** structurally forbid neutrals — and the naves prove it empirically by
carrying 14,870 of them through the same grade. The deficit's cause is upstream, in the
lighting.

## Why a merely-desaturated warm light will not work

Componentwise, warm sodium (2900K) × stoneFloor albedo:

| light | resulting sat | class |
|---|---|---|
| saturated sodium | 0.702 | WARM |
| 50% mixed to white | 0.481 | WARM |
| 80% mixed to white | 0.349 | **still WARM** |

Desaturating a warm light does not produce neutral pixels — it produces less-saturated warm
ones. Either the light must be genuinely near-white, or the surface genuinely low-chroma, or
the hue must land in the 65–170 / 280–340 gaps.

**Habit:** read the classifier before optimising a class. "Neutral" sounded self-evidently
like "grey", and that assumption would have sent two agents at the wrong lever — one
rebuilding a saturation curve that was never the constraint, the other desaturating warm
lights that would have stayed warm.


## The Round-11 crypt regression: the room simply went dark

The open item from Round 11 was crypt `largeStepEnergyPct` falling 47.40 → 11.01, with combat
VFX (0.5pp), the light-range change (reverting made it worse) and the teal rotation (it *helps*)
all eliminated. The answer needed no new capture — just the two saved frames:

| luminance bin | 0–10% | 10–20% | 20–30% | 30–40% | 40%+ |
|---|---|---|---|---|---|
| J-crypt (pre) | 64.4 | 28.5 | 5.1 | 0.8 | 1.1 |
| R11F-crypt (post) | **82.8** | 15.8 | 1.2 | 0.1 | 0.1 |

**Pixels above 25% luminance: 3.17% → 0.44%, a 7.2x drop.**

**Large steps live at LIT pool boundaries** — a step >0.04 requires something bright on one
side. Remove the bright side and the steps vanish however good the pool *structure* is. That
reconciles every earlier elimination: the range change improved structure (so reverting it hurt),
the teal rotation improved the share (while lowering absolute luminance), and the net of all
Round-11 changes was a much darker crypt.

It also confirms the standing diagnosis: **we are short of total rendered gradient ENERGY, not of
large-step SHARE.** crypt `allStepEnergyAbs` 0.001139 against a 0.00268 reference floor.

A second-order consequence worth noting: `analyze.mjs` skips pixels with `v <= 0.06`, so in a
frame that is 82.8% near-black, most of the image is not even *eligible* to be classified cool or
neutral. The crypt's 507 neutral pixels may be less about hue than about the room being too dark
for anything to register.

## The crossover ridge only works with a TEAL cool source, not a blue one

An agent proposed producing all three hue populations from a single offset cool pool crossing the
existing warm fill: cool core, low-saturation **neutral** in the warm↔cool crossover ridge, warm
elsewhere. Testing the load-bearing assumption — additive light sum × stoneFloor albedo,
classified with `analyze.mjs`'s own thresholds:

| warm:cool | teal (0.020,0.576,0.638) | bluer (0.35,0.55,0.95) |
|---|---|---|
| 1.00:0.00 | hue 26.2 s0.702 WARM | hue 26.2 s0.702 WARM |
| 0.70:0.30 | hue 38.2 s0.504 WARM | hue 23.4 s0.479 WARM |
| 0.50:0.50 | hue 76.6 s0.310 **NEUTRAL** | hue 15.9 s0.259 WARM |
| 0.30:0.70 | hue 148.1 s0.418 **NEUTRAL** | hue 262.8 s0.100 COOL |
| 0.15:0.85 | hue 166.7 s0.682 **NEUTRAL** | hue 222.1 s0.302 COOL |
| 0.00:1.00 | hue 175.2 s0.961 COOL | hue 216.5 s0.502 COOL |

**Teal yields a neutral band across three of seven mix ratios; blue yields none** — it goes warm
straight to cool.

Mechanism: teal sits ~150° from warm, and the additive path between them **sweeps through the
65–170 green gap** that classifies as neutral. Blue sits ~190° away; that path desaturates and
flips hue sign without crossing the gap.

So the teal moon committed in Round 11 for hue-*spread* reasons is also exactly what makes the
neutral-*count* route viable — two independent lines of work landing on the same value. And the
intuitive choice for a "cold shaft" (clear blue) would have silently broken the design.

Practical consequence: the neutral ridge spans a **wide** 0.30–0.85 cool-fraction range, so a
soft broad falloff spends much of its spatial area inside the band — which is what a 30–60x count
deficit needs. A hard-edged cool pool would produce warm and cool with only a thin ridge between.


## The brightness-independent number: 4.3x short on structure per unit brightness

I had just told an agent its brightening assignment was "the whole round". Overstated, and this
table shows why:

| frame | meanL | allAbs | **allAbs/meanL** | lgStep% |
|---|---|---|---|---|
| ours nave-lit | 0.0185 | 0.001558 | 0.0842 | 8.67 |
| ours nave-wide | 0.0228 | 0.001458 | 0.0639 | 8.79 |
| ours courtyard | 0.0258 | 0.001821 | 0.0706 | 6.51 |
| ours crypt | 0.0146 | 0.001139 | 0.0780 | 11.01 |
| ours arena | 0.0350 | 0.004508 | **0.1288** | 16.44 |
| **poe2-10** | **0.0143** | **0.002683** | **0.1876** | 48.57 |
| poe2-05 | 0.0177 | 0.004942 | 0.2792 | 32.88 |
| poe2-11 | 0.0202 | 0.012298 | 0.6088 | 53.36 |
| poe2-07 | 0.0255 | 0.007915 | 0.3104 | 54.50 |
| poe2-09 | 0.0278 | 0.007180 | 0.2583 | 58.72 |
| poe2-12 | 0.0657 | 0.034539 | 0.5257 | 77.61 |

`correlation(meanLuminance, allStepEnergyAbs) = +0.880` across all 11 frames — brightness *does*
predict absolute step energy. But **mean allAbs/meanL: ours 0.0851, references 0.3617 — a 4.3x
deficit per unit brightness.**

**The killer datapoint: poe2-10 is DARKER than our crypt (0.0143 vs 0.0146) with 2.4x the absolute
step energy and 4.4x the large-step share.** A real PoE2 frame dimmer than our dimmest station
comfortably clears the floor we cannot reach. Brightness is not the differentiator.

### What follows

- Brightening works *along the trend*: at our ratio 0.0851, reaching `allAbs` 0.00268 needs
  `meanL ≈ 0.0315`, well inside the 0.075 gate. So it can legitimately clear the absolute floor —
  but by being **bright**, not by being **structured**, and the per-unit deficit would be untouched.
- The useful diagnostic is therefore **`allAbs/meanL`**, which is brightness-independent and is the
  cleanest single number for "do we look like PoE2". A change that raises `allAbs` proportionally to
  `meanL` has added brightness without structure — honest, useful for the gate, but not the fix.
- Our best station on that ratio is the **arena** (0.1288), the room with the most geometric clutter
  and the most pooled lighting. The *weakest* reference (poe2-10, 0.1876) still beats it by 46%. So
  the gap is not exotic — it is the same lit-pool-boundary and surface-relief structure, just more of
  it than we have managed.

**Habit:** when a metric correlates with a confound (here brightness at +0.880), divide it out and
look at the residual. The raw number said "get brighter"; the ratio said "brightness is not the
difference", and only one of those is actionable toward the actual goal.


## The grade exonerated — and why a saturation fix would have produced the defect

An agent owning `pipeline.js`/`gradeShader.js` ran four camera-free checks and made **zero source
edits**:

1. **Hue-preserving:** max hue shift **0.13°** across the full circle (only `gamma 1.02`
   contributes). So the deficit is not a hue rotation.
2. **`satFloor 0.72` does not forbid neutrals:** warm needs source sat ≤ 0.139, and the naves carry
   14.4% neutral through the *identical* grade.
3. **The VFX saturation boost strips zero neutrals:** in the HUD-excluded crypt band, the affected
   pixels are 610 scene px, **100% warm fire cores, 0 neutral**; arena 685, same.
4. **The decisive one:** crypt warm pixels are **92.5% at HSV-sat ≥ 0.45, with only ~0.2% below sat
   0.20**; arena 76% above 0.45; the naves ~10% below 0.20.

Point 4 is the finding. **The crypt and arena pixels are not near the neutral boundary — they are
deep in saturated warm.** A saturation-curve change cannot nudge them across a threshold they are
nowhere near; it can only crush them to grey mud, which is Goodhart-in-colour and is precisely the
"monochrome wash" the judges condemned. The agent identified that its own available fix would
*produce* the defect it was asked to remove, and declined.

This closes my satFloor hypothesis with better evidence than my arithmetic had: I showed the grade
*permits* neutrals; the agent showed the pixels are too saturated for permission to matter.

### Two consequences

- **The cool source must be comparable in magnitude to the warm fill**, not a subtle wash. The
  measured mix ratios that cross into NEUTRAL are cool-fraction **0.30–0.85**; below 0.30 cool you
  get a slightly-less-orange warm pixel and no classification change. Combined with the earlier
  finding that even 80%-white light on our stone stays warm at sat 0.35, "add a dim cool fill"
  cannot work.
- **Eligibility:** `analyze.mjs` skips pixels with `v <= 0.06`, and the crypt is 82.8% in its
  darkest luminance bin. Most of that frame is not eligible to be classified as *anything*. So
  brightening does double duty — it raises `allStepEnergyAbs` toward the floor *and* makes pixels
  eligible for hue work to register. The two agents' results are multiplicative, not additive, and
  the ordering matters: measuring the hue change before the brightening lands would under-read it.

**Third instance in this project of an agent being more useful by refusing to edit than by
editing.** The pattern is consistent: each refusal came with a measurement showing the available
fix would move a metric while worsening the artifact.


## Edge WIDTH: PoE2's transitions are twice as sharp, and it explains the step histogram

Measuring, for every significant luminance transition (total change ≥ 0.04), how many pixels the
transition takes to complete. Sharp edges finish in 1–2px; soft edges spread the same step across
many pixels as several small ones. Window y 0.12–0.72, x 0.08–0.92, scanlines every 4px, HUD
excluded.

| frame | n edges | medianW | meanW | sharp (≤2px) % |
|---|---|---|---|---|
| ours nave-lit | 11321 | 4 | 4.23 | 18.3 |
| ours crypt | 9714 | 4 | 4.25 | 12.0 |
| ours arena | 20124 | 3 | 3.89 | 23.3 |
| poe2-07 | 39288 | **2** | 2.50 | **61.5** |
| poe2-10 | 19138 | **2** | 2.69 | **50.0** |
| poe2-11 | 61873 | **2** | 2.54 | **60.0** |

**PoE2's edges are twice as sharp — median 2px vs our 4px, 50–61% completing within 2px against
our 12–23% — and they have 2–6x MORE edges.**

### This may unify two findings that looked separate

A soft edge is a **step-splitter**: it takes one large luminance step and spreads it into several
small ones. Our step histogram already showed exactly that signature — we carry MORE sub-0.01 steps
than PoE2 (71.5% vs 53.0%) and 4.7–9.5x FEWER steps above 0.04. If PoE2 completes a transition in
2px where we take 4, each of our steps is roughly half the magnitude, which moves it out of the
>0.04 bucket and into the fine-grain bucket.

**So our "excess fine grain" and our "large-step deficit" may be the same phenomenon measured two
ways, and edge softening may be the common cause.** That would also explain why every attempt to
add micro-detail failed: the problem was never too little detail, it was detail smeared across too
many pixels.

Suspects, all in the post-process chain: **GTAO at half resolution** (`aoScale 0.5`, upsampled — so
every occlusion edge is 2x soft before it reaches the frame, then denoised at `radius 4, rings 2,
lumaPhi 10`), **SMAA** (morphological AA, applied to the final sRGB image we measure), and
**`PCFSoftShadowMap`**.

**The headroom, and it is counter-intuitive:** `hardEdgeRatio` is our aliasing proxy, and poe2-07
sits at **0.00554 against our 0.00345**. The reference is **sharper AND more aliased than us, and it
looks better.** We have been softer than PoE2 while treating softness as free.

**Habit:** when two metrics both look wrong in complementary directions (too much of X, too little of
Y, where X and Y partition the same total), suspect a single mechanism moving mass between the
buckets rather than two independent deficits.


## The level seed is fixed — historical comparisons were not confounded by generator luck

A worry raised mid-round: if the dungeon is procedurally generated, how much of twelve rounds of
single-sample comparisons is layout luck rather than signal?

`generateDungeon(seed = 1337)` and `new RNG(1337)` — **the seed is fixed**. Every frame captured in
this project shares one identical layout: same rooms, walls, columns, prop placement. The
comparisons are clean on that axis.

The one exception introduced this round is an isolated floor stream,
`fr = new RNG(0x71005eed ^ (layout.seed ?? 1337))`, added as A/B scaffolding so floor variation
cannot perturb walls/columns/rubble. Good isolation — but it has a consequence worth naming: **it
reseeds the entire floor layout.** Every slab width, row depth, bond phase, missing-slab roll and
per-joint jitter is a different draw. The floor is not the baseline floor with better
decorrelation; it is a *different floor* drawn from the same distribution.

So a metric shift measured across that commit includes the reseed, not just the intended fix — and
a sample-of-one layout difference can look exactly like a 2x improvement while not reproducing on
another seed.

**The open, well-posed question:** how much does `structurePerLuma` vary with the floor seed at
fixed parameters? If ±0.01, movements are real. If ±0.05, a meaningful fraction of what this
project has been measuring is layout luck, and several published comparisons sit within noise.

**Habit:** before trusting a single-sample measurement of procedurally generated content, establish
the generator's own variance at fixed parameters. Twelve rounds went by without anyone asking — it
happened to be safe here only because the seed was hard-coded, which was luck rather than
discipline.


## Attributing a metric jump to the wrong agent, from file mtimes

PoolCore reported crypt `structurePerLuma` 0.163 where my baseline said 0.0778. I checked file
mtimes, saw `level.js` at 23:57, and broadcast to four agents that BondPhase's commit "may have
doubled crypt structurePerLuma — possibly the largest single improvement in the project."

BondPhase had not committed `level.js` at all. Its mtime of 23:57 **predates round 12** — that is
round 11's wall-joint work. And `props.js` at 00:32 is almost certainly my **own** range-restore
from the end of round 11.

**So nothing in round 12 explains the discrepancy.** Both my baseline frames and the current tree
are the same code — which means the difference is in the **measurement**, not the tree. That is the
more interesting possibility: two of us measured "the crypt" and got a 2x difference.

Candidates, unresolved: different camera framing at the station; a "baseline" leg that already
included part of the agent's own change; differing combat-frozen or transient-light state; a
window or HUD-exclusion difference in how each of us invoked the analyzer.

**The lesson is the twenty-first instance of the same family:** *"the crypt" is not a
well-defined population* until you fix the camera, the settle, the combat state, and the window.
I published baselines without specifying all four, so two people measuring in good faith could not
reproduce each other.

**Two habits:**
1. A file mtime tells you *when* a file changed, not *who* changed it or *what* changed in it. I had
   already read the diff and seen the bond parameters were untouched — I should have concluded
   "not the bond fix" rather than "probably BondPhase's commit".
2. When publishing a baseline, publish the **capture protocol** with it: station coordinate, settle
   criterion, combat state, window, HUD exclusion. A number without its protocol is not a baseline,
   it is an anecdote.


## Round 12 — what actually landed, read off disk

| file | change | shape |
|---|---|---|
| `sky.js` | offset teal cool pools, crypt + arena only | `skylight-cool-crypt` I960 teal, `skylight-cool-arena` I750 teal, ADD-ONLY, naves structurally untouched with zero range-leak verified in the live scene |
| `props.js` | `POOL_CORE_SCALE = { crypt: 1.5 }` | **per-room** scale applied at placement via `poolCoreScale(f.wx, f.wz)` — not a global intensity raise |
| `props.js` | arena ring 5 → 3 braziers | caster-count reduction for the `visiblePct` overshoot, not a dimming |
| `pipeline.js` | none | grade exonerated with four checks, zero edits |
| `level.js` | none this round | bond fix still uncommitted |
| `materials.js` | none | untouched since Round 11 |

Both `props.js` changes are the surgical version: a per-room scale rather than a global raise, and a
caster-count cut rather than a dimming that would have re-broken `meanLuminance` (the arena was
*failing* at 0.0062 before Round 11's fix). Per-room scoping is what protects the naves, which are
the only stations already at reference on all three hue channels.

The cool-pool magnitudes matter: I960 and I750 are **comparable to the warm fill**, not a subtle
wash. That was a hard requirement — the measured mix ratios that cross into NEUTRAL are
cool-fraction 0.30–0.85, and below 0.30 cool you get a slightly-less-orange warm pixel with no
classification change at all. A dim cool fill could not have worked.

## A coordination cost worth recording

At one point **three of four agents were idle-blocked on a single camera** for ~10 minutes past the
holder's stated ETA, while the holder's work was already committed to disk and its remaining
analysis needed only saved PNGs.

The fix that worked repeatedly this round: **build and validate instruments camera-free against
saved frames, then spend the camera window purely on capture.** One agent built and validated its
entire edge-width instrument offline, reproducing the ours-4px/refs-2px gap exactly, before ever
requesting the tab.

**Habit:** a shared serial resource needs an explicit release condition, not just a claim. "TAKING
CAMERA ~Ns" is a claim; "released, parked at X, settled, combat frozen" is a release. And before
requesting a serial resource, ask what fraction of the work genuinely needs it — most of this
round's analysis did not.


## structurePerLuma is a BOUND, not a trend — brightening cannot raise it

Measured across **1.0 / 1.8 / 2.4x** at the crypt and **1.0 / 1.5 / 2.0x** at the nave:
`structurePerLuma` stays inside a **4.2–4.7% band** (measurement noise) and the **sign is
consistently NEGATIVE, −2 to −5%, never positive** — plausibly because ACES's toe shallows as you
climb it.

So it is not a weak trend. **Brightening does not help and very slightly hurts, at every magnitude
tested.** That upgrades the metric from "should be brightness-independent" to "verified bounded
against brightness across two rooms and five intensity levels with a consistent sign".

**Why this matters more than any single fix:** we now have one metric that cannot be gamed by
either easy lever. Darkening lowers numerator and denominator together. Brightening is empirically
bounded. Anything that moves it has to be real structure. Twelve rounds ran without such a metric,
and at least three of them were spent optimising quantities that moved for the wrong reasons.

**Second-order finding in the same data:** `fineStepEnergyAbs` **rose** under brightening in all
three sweeps. So brightening adds gradient energy *without* deleting detail — a legitimate
gate-clearing move, just not a look-fixing one. Both halves are worth knowing, and it means the
Goodhart guard correctly distinguishes "brighter" from "flatter".

### Round-12 committed results

| change | result |
|---|---|
| crypt pool-core 1.5x | `allStepEnergyAbs` **0.005396** (unboost leg 0.005018, +7.5% from the scale alone), `fineAbs` flat 0.002644 → 0.002666. Clears the 0.00268 reference floor with 2x margin. |
| arena ring 5 → 3 | `visiblePct` **55.13** (under the 60 ceiling) with `meanLuminance` **0.0364** (3x the 0.012 floor). Fixed the overshoot *without* re-breaking meanL — the specific failure mode Round 11's arena fix had been rescuing. |

**A stacking caveat worth recording:** the arena's 55.13 includes another agent's cool pool, worth
roughly **+19 points of visiblePct** versus the isolated leg at 36.2. Two agents' changes stack on
one gate that only one of them owns. Adding a lit pool necessarily makes pixels visible — the same
eligibility effect that makes hue work register at all — so this is intrinsic, not a mistake. But it
means the margin to the ceiling is thinner than either change implies alone.

**Habit:** when two agents change different subsystems that both feed one gate, the gate needs a
single named owner *and* both agents must report it. Neither would have caught this from their own
numbers alone.


### Two levers I put in a brief, both refuted by measurement

**1. "Raise per-type `lightBaseInt`" — refused, correctly.** A global 1.5x shifts nave hue
61/25/14 → 71/16/13 (**+10pt warm**), far past the ~2pt regression tolerance on the only two
stations already at reference, and nave `meanL` 0.064 is already near the 0.075 ceiling. The agent
substituted a **room-scoped** `poolCoreScale`, achieving the floor-margin and eligibility goals with
the naves byte-identical (readback after reload confirmed: crypt brazier 190→285, torch 105→157.5,
sconce 88→132; nave sources unchanged at 190/105/88/40).

The brief's literal instruction would have broken the round's stated regression check. Scoping was
never mentioned in it.

**2. "Tighter inner-ring placement to darken the arena periphery" — refuted by A/B.** My suggested
mechanism does the opposite: at range 16, pulling the 5 pools inward (0.55x) **stacks them at the
centre** — `meanL` 0.039 → 0.146, `visiblePct` 64 → 87, materially *worse*. Range is too large for
tightening to darken corners. **Caster-count reduction is the mechanism that works**, and that is
what shipped (5 → 3, total casters 56 → 54).

I reasoned geometrically about pool placement without accounting for what a 16-unit range does when
you move sources closer together. The agent tested it instead of implementing it.

**Habit:** a brief's suggested *mechanism* is a hypothesis, not part of the requirement. Separate the
acceptance criterion ("arena visiblePct ≤ 60 without meanL falling below 0.012") from the guessed
route to it, and say explicitly that the route is optional. Both of this round's most useful agent
decisions were departures from a literal instruction.


## SMAA is the dominant edge-softener — and both of my suspects were wrong

Ten legs captured at arena + crypt (drift 0, 9 sim-sec settled, combat frozen), all runtime toggles
restored to default and **read back to verify**:

- **SMAA off: +9–12pp sharp-edge fraction, median edge width 3 → 2 at the arena.**
- **GTAO denoise radius: barely matters.** I had told the agent it was "plausibly the single largest
  edge-softener in the chain".
- **AO resolution (half → full): barely matters.** Also named as a prime suspect.

That is the fourth and fifth lever I suggested this round that measurement refuted, alongside global
intensity raise and inner-ring tightening. The pattern is unmistakable: **my mechanism guesses have
been wrong far more often than the agents' measurements.**

### The ship decision is a judgement, not a measurement

Turning SMAA off is not free — it is antialiasing, and removing it will alias. The framing that
matters:

```
hardEdgeRatio    ours 0.00345    poe2-07 0.00554
```

**The reference is SHARPER AND MORE ALIASED than us, and it looks better.** We have ~60% headroom
before exceeding it, and softness has been costing us on the metric that tracks the blind verdict.

But "SMAA off" is the crudest way to spend that headroom, and it is not what PoE2 does — PoE2 plainly
has AA. Three options, in ascending defensibility:

- **(a) SMAA off.** Maximum sharpness and risk. Floors will improve; thin high-contrast geometry
  (chains, merlons, railings, character silhouettes) may crawl — and a blind judge will see crawling
  before it sees a sharper floor.
- **(b) SMAA weakened**, if the pass exposes a threshold or blend strength. Keeps AA on the worst
  edges while letting genuine luminance boundaries survive.
- **(c) TAA**, already supported (`aaMode 'taa'`, `TAARenderPass` constructed). Temporal AA may
  preserve step magnitude better than a morphological filter that explicitly blends across gradients.

**The acceptance test cannot be metrics alone here.** Floors improve with SMAA off by construction;
the question is entirely about thin geometry, which is exactly the population the step metrics
under-weight because it occupies few pixels. This is a case where the crop has to outrank the number.

**Habit:** when a change improves the measured population and threatens an unmeasured one, the
unmeasured population is the acceptance test. Metrics chosen to track a defect will not warn you
about a defect they were not built to see.


## CONFIRMED: excess fine grain and the large-step deficit are ONE mechanism

Ten legs, both stations, all six protocol pins, delta-led:

| | median W | sharp ≤2px | hardEdge | allAbs | fineAbs |
|---|---|---|---|---|---|
| arena base | 3 | 44.2% | 0.00316 | — | — |
| arena SMAA-off | **2** | **55.9%** (+11.7) | 0.00335 | **+2.4%** | **FLAT** |
| crypt base | 3 | 27.6% | 0.00268 | — | — |
| crypt SMAA-off | 3 | **36.9%** (+9.3) | 0.00271 | **+4.0%** | **FLAT** |

- **GTAO denoise R4→R1: zero effect at both stations.**
- **AO half→full res: 0 arena, +4pp crypt.**

Both were my named prime suspects; SMAA, which I ranked third, dominates.

**The signature is unambiguous: `allStepEnergyAbs` RISES while `fineStepEnergyAbs` stays FLAT.** No
detail added, none deleted — **energy moved from the fine bucket into the large bucket.** That is a
step-splitter being switched off.

So our "excess fine grain" (71.5% of steps <0.01 vs PoE2's 53.0%) and our "large-step deficit"
(4.7–9.5x fewer steps >0.04) were never two problems. **One mechanism, measured from two ends** — and
twelve rounds of adding micro-detail were pushing on the wrong end of it.

## The crops overruled the metrics, and the aliasing guard failed silently

SMAA-off wins on **every** metric in the suite. The crops killed it: recessed-slab borders, the fallen
sword, and arena plank silhouettes show hard stairstep crawl. A blind judge would catch that
instantly.

**And `hardEdgeRatio` — our aliasing proxy — did not warn us.** It stayed at 0.00268–0.00335 against a
0.00554 guard in every leg, i.e. comfortably "safe" while thin geometry visibly crawled. The proxy
does not measure the thing that would get us caught.

**Habit:** a guard metric that stays green while the artifact visibly fails is worse than no guard,
because it licenses the change. Before trusting a guard, verify it moves when the defect it guards
against is deliberately introduced. Nobody ever did that for `hardEdgeRatio`.

## The fix that keeps both

`SMAA_THRESHOLD` is a shader **define** (`SMAAShader.js:28`, value `0.1`), patchable via `defines`
before compile. It is the luma-delta above which a boundary is *considered* an edge worth
antialiasing. Raising it produces exactly the discrimination the crops demand:

```
thin high-contrast geometry  -> large luma delta  -> STILL antialiased, no crawl
lit-pool / joint boundaries  -> smaller delta     -> LEFT SHARP
```

SMAA-off gives up the first to get the second. A raised threshold keeps both — and it is
*subtractive*, so unlike a sharpen pass it introduces no halo/ringing failure mode.


## Why a dark art direction fights its own antialiasing

SMAA runs **last** in our chain (post-OutputPass, post-grade) on display-sRGB. sRGB is perceptually
spaced, so a *fixed* threshold means a wildly different **linear** delta depending on pixel
brightness:

| sRGB level | linear | +0.1 sRGB spans | as % of local level |
|---|---|---|---|
| 0.05 | 0.00394 | 0.01567 | **398%** |
| 0.10 | 0.01002 | 0.02308 | **230%** |
| 0.20 | 0.03310 | 0.04013 | 121% |
| 0.35 | 0.10048 | 0.07016 | 70% |
| 0.50 | 0.21404 | 0.10451 | 49% |
| 0.75 | 0.52252 | 0.16955 | 32% |

**Our scene sits at the bottom of that table.** meanLuminance 0.015–0.037 linear converts to sRGB
**0.128 / 0.172 / 0.212**. So at our operating point `SMAA_THRESHOLD = 0.1` spans roughly **120–400%
of the local linear level** — SMAA is effectively asked "is this boundary bigger than the entire local
brightness?" and answers yes for essentially every shadow-band boundary we have.

**This explains the station asymmetry in the measured data.** The crypt is our darkest station, sits
lowest on the curve, and has the lowest base sharpness (27.6% vs the arena's 44.2% — the widest gap in
the set). The darker the room, the more aggressively a fixed sRGB threshold eats its boundaries. It
predicts the threshold fix will help the **crypt more than the arena**, which is falsifiable in legs
already planned.

It also means the useful sweep range is higher than intuition suggests — 0.15 and 0.22 may be timid
when 0.1 already spans 230% of local linear.

**The testable structure of the fix:** thin-geometry crawl comes from *large*-delta edges (a bright
sword against dark stone is a huge sRGB step), while our lit-pool and joint boundaries are
*small*-delta. If those two populations are well separated there is a wide usable window between
"stops blending shadow boundaries" and "starts letting swords crawl". If crawl appears at the same
threshold sharpness arrives, the populations overlap and the approach fails cleanly.

**The general lesson:** a perceptually-spaced threshold applied after tonemapping behaves completely
differently for a dark scene than a bright one. Our grimdark art direction and our AA default were
chosen independently, and the interaction — AA eating precisely the shadow structure the art direction
depends on — was invisible to both.


## A coordination bug I introduced three times: reactive queue re-cutting

Four agents shared one camera. I re-cut the queue **reactively each time an agent reported**, without
tracking what I had already told the others. Result: three separate ordering contradictions, two
agents simultaneously believing they were next, and one agent moved back twice through no fault of
its own.

Each individual message was locally sensible — "you go next because your legs are cheap", "you go
next because you have waited longest". Together they left four agents each holding a *different*
mental model of the queue.

**The fix, and it is structural not behavioural:** a serial resource needs ONE published order that
changes only on an explicit re-publication to everyone. A running sequence of pairwise "you're next"
messages cannot converge, because no agent can see the others' messages and each reasonably assumes
its own is current.

What actually worked, unprompted, from the agents themselves:
- **Release format as a handoff, not just an announcement:** "CAMERA FREE, parked at nave-lit (34,2),
  combat frozen, transients zeroed, settled drift 0 / 9.8 sim-s, floor restored to ship default." The
  next agent starts measuring immediately with no settle cost.
- **Deferring on collision rather than racing:** one agent announced, learned another was mid-capture,
  closed its tab to free the GPU, and waited — correctly noting that opening a second tab would both
  crash the shared GPU *and* contaminate the other's sweep.
- **Restoring and reading back runtime state before releasing:** ten mutated toggles verified back to
  default, so the next agent's measurement was not silently taken against a modified pipeline.

**Habit:** when N agents contend for one resource, publish the full order once, to everyone, and
re-publish the *whole* order if it changes. Never negotiate position pairwise.

## The cool-pool implementation, for the record

```
const cp = SKY.coolPool[rm.kind];              // per-room keying — naves have no entry
const coolCol = SKY_MOON.clone();              // teal ~175, matches the nave moon
const off = (rm.radius || 8) * cp.offsetFrac;  // displaced toward camera-far
cl.castShadow = false;                         // adds no shadow-pass cost
cl.name = 'skylight-cool-' + rm.kind;
```

Three deliberate choices worth keeping: the hue **matches the existing teal moon** so the warm→cool
mix path crosses the 65–170 green gap and the crossover ridge lands NEUTRAL rather than merely cool;
the pool is **offset** rather than concentric so the cool:warm ratio *sweeps* across the floor
producing all three populations as a spatial gradient; and per-room keying means the naves — the only
stations already at reference — are structurally untouchable by this code path.


## The floor striping root cause, finally identified: COLLINEAR BEDDING JOINTS

Six hypotheses were eliminated across two rounds (texture recipe, filtering, atlas twinning,
posterisation, minification aliasing, joint recession). The actual mechanism:

**The strict running bond laid every slab in a row at ONE `czRow` and ONE `rowD`, so slab top and
bottom edges were COLLINEAR across the full room width** — a dead-straight full-width bedding joint
at semi-regular Z pitch. Under the isometric camera those parallel constant-z lines project to the
regular diagonal "corduroy" both blind judges named independently.

Confirmed at the source, not on screen: **bedding-bias `Gz/Gx` = 1.25** — bedding joints carried 25%
more edge energy than head joints.

**The fix (v2, "config-D"):** each slab gets its **own** depth (~1.0x row pitch, jittered) and its own
z-centre (±0.25x pitch), so a row's bedding edges no longer form one collinear line. Row pitch and
running-bond phase also widened. Chosen at the *gentle* regime — deeper jitter grows slabs into
overlap, which buries mortar (occupancy up, joint energy down).

| room | baseline Gz/Gx | v2-D |
|---|---|---|
| nave | ~1.25 | **0.98** |
| crypt | ~1.23 | **0.96** |
| arena | ~1.29 | **0.97** |

Effect **0.27 vs seed-noise sd 0.07 = 3.8x**, reaching near-isotropy (1.0) in every paved room.
Cost: **−120 tris (−2.4%)**, **zero draw-call delta**, `wallAshlar` byte-identical at 40272 tris in
every leg.

## The noise floor, and it invalidates one of my instruments

| quantity | seed-to-seed spread | verdict |
|---|---|---|
| screen small-window diag/anti | **0.348 (sd 0.142)** | **LAYOUT-LUCK DOMINATED** |
| `structurePerLuma` | 0.0017 (~3.6%) | real signal |
| `fineStepEnergyAbs` | 0.000144 | real signal |

**A single-sample small-window diag/anti number is mostly "which slab landed in the patch".** That is
the instrument I prescribed in the brief, and it cannot resolve the fix at one seed. The whole-room
source probe (sd 0.04) is the correct instrument — the "prefer a deterministic probe at the source"
rule, vindicated.

Conversely `structurePerLuma`'s 3.6% spread means **the 0.078-vs-0.19 gap I built the round on IS real
signal.** The metric I invented survived; the metric I prescribed did not.

## My acceptance window stopped measuring what it was chosen to measure

The prescribed window `[900,330,1240,500]` is **no longer floor-dominant** — another agent's pool
brightening put a large lit-dais falloff band inside it (reads diag/anti 1.50, with the floor A/B flat
at 1.4985→1.4997). The inherited 0.77–0.86 baseline was measured *pre-brightening*; **the window
content changed underneath the number.**

This is the CAPTURE_PROTOCOL "different population" error in its most insidious form: the window
coordinates never changed, the code never changed, and the population changed anyway because a
*different subsystem* altered what was visible there.

**Habit:** a fixed pixel window is not a fixed population. When anything changes scene brightness or
composition, re-verify that the window still contains the surface it was chosen for — ideally by
asserting a property of the content (here: floor-dominance) rather than trusting the coordinates.

## The first properly validated proxy in this project

The source probe **predicted config-D would beat baseline AND flagged that the aggressive first cut
would over-correct** — which the screen then confirmed at 0.715, worse than baseline. Two points, both
directions, before shipping. The agent chose the milder config *because* the probe warned it.

That is the standard I set after spending a whole round optimising an unvalidated proxy, and it is the
first time in twelve rounds anyone has met it.


## Two capture contaminants found late, both affecting the bench

**1. `devicePixelRatio` silently overrode the requested viewport.** An agent requested 1600×900 and
got **2000×1125** (DPR 1.25). Consequences: A/B *deltas* survive (common-mode), but absolute numbers
and **every fixed pixel window land on a different part of the scene**. Its prescribed window
`[900,330,1240,500]` mapped to scene-relative x 0.45–0.62 instead of 0.56–0.78.

My own frames verified true 1600×900, so my baselines are clean. Fix for anyone using a fresh tab:
pin `scale: 1` in the viewport, or verify IHDR dims (PNG bytes 16–24) before trusting a window.

**2. Combat-freeze does NOT zero emissive decals.** `ai.enabled=false` and `combat.enabled=false` kill
point lights, but a **warm player-aura VFX decal** survived and occupied ~25% of frame at **96.8%
warm / 2.1 cool / 1.1 neutral**, dragging whole-frame warm from ~61 to 78.4. That single artifact
generated a phantom "+17 warm nave re-colour" that three agents spent time hunting.

The agent retracted its own number as a contaminant rather than defending it — the correct call, and
the fourth retraction-on-evidence this round.

**Protocol additions:** verify capture dimensions before measuring; verify no player VFX decal is in
frame (or park somewhere it cannot appear); prefer whole-frame or content-asserted windows over fixed
pixel rectangles.

## A resolution bias in every ours-vs-reference comparison, favouring us

Our captures are 1600×900; the references are **1920×1080**. A step measured per adjacent pixel-pair
spans *less world distance* at higher resolution, so resolution is not neutral for these metrics.
Downscaling poe2-07 to our resolution with nearest-neighbour:

| poe2-07 | lgStep | allAbs | structurePerLuma | fineAbs |
|---|---|---|---|---|
| @1920×1080 (as used all project) | 54.50% | 0.007915 | 0.3106 | 0.001491 |
| @1600×900 (our resolution) | **56.61%** | **0.008606** | **0.3378** | 0.001531 |

**The reference scores ~4–9% HIGHER at our resolution.** So every comparison in this project has been
slightly *favourable* to us: the true structure deficit is worse than the 4.3× I reported, closer to
**4.6×** if the other references scale similarly.

**Habit:** when comparing frame-derived metrics between sources, match resolution first — or measure
the bias and state its direction. I compared 1600×900 against 1920×1080 for twelve rounds without
checking whether the metric was scale-invariant. It is not.


## Resolution decision: the bench captures at 1920×1080 to match the references

An agent split the metrics by resolution sensitivity, which is the right frame:

| class | metrics | behaviour |
|---|---|---|
| **res-sensitive** | `allStepEnergyAbs`, `structurePerLuma` | adjacent-pixel steps grow as pixels spread in scene-space at lower res. Inflation bounded **1.0x** (pure hard edges, res-invariant) to **~1.4x** (pure smooth gradient, scales ~1/width). |
| **res-independent** | `meanLuminance`, `visiblePct`, `pureBlackPct` | means and fractions over identical framing |
| **always survives** | any same-res A/B delta | common-mode |

That bound is itself diagnostic: **a metric's res-sensitivity reveals whether a frame's energy is in
hard edges or smooth gradients.** Our frames are soft (median edge width 4px vs the references' 2px),
so we sit toward the gradient end — meaning **our numbers inflate MORE at low resolution than the
references' do**, compounding the bias in the same direction.

Combining every correction found in one half-hour:
- references score **4–9% higher** when downscaled to 1600×900 (poe2-07 SPL 0.3106 → 0.3378)
- our own numbers inflate at lower resolution, and *more* than the references' because we are softer
- so the true deficit is worse than the published 4.3x, and **4.6x is a floor, not a ceiling**

**Every correction today moved in the same direction: we are further from PoE2 than the numbers said.**

### Reference band at native 1920×1080 — the bench's comparison basis

| frame | lgStep% | allStepEnergyAbs | structurePerLuma | fineStepEnergyAbs |
|---|---|---|---|---|
| poe2-05 | 32.88 | 0.004942 | 0.2797 | 0.001662 |
| poe2-07 | 54.50 | 0.007915 | 0.3106 | 0.001491 |
| poe2-09 | 58.72 | 0.007180 | 0.2579 | 0.001132 |
| poe2-10 | **48.57** | **0.002683** | **0.1872** | 0.000813 |
| poe2-11 | 53.36 | 0.012298 | 0.6079 | 0.002082 |
| poe2-12 | 77.61 | 0.034539 | 0.5253 | 0.001625 |

poe2-10 is the weakest on every axis and is therefore the in-family floor: **lgStep ≥48.6,
allAbs ≥0.00268, SPL ≥0.187.**

## The behaviour pattern that makes this round trustworthy

In one half-hour, three agents **voluntarily downgraded their own results** without being asked:

- one retracted its nave reading as doubly contaminated (a warm aura decal that survived combat-freeze,
  plus a DPR-inflated capture resolution), explicitly saying "my contribution to this question is a
  retraction, not a data point"
- one flagged its own headline "2x margin" as optimistic once it realised its tab captured at 1365×768
- one declined to ship a change **its own metrics favoured** because the crops showed thin-geometry crawl

Set against that, most of my own hypotheses this round were refuted: global intensity raise,
inner-ring tightening, GTAO denoise as the edge-softener, AO resolution, the satFloor gate, and the
lit-fraction explanation for the nave drift — six, each killed cheaply by someone who measured instead
of assuming. **That ratio is the round working correctly.** The cheapest thing in this project is a
wrong hypothesis killed in ten minutes.


## The SMAA_THRESHOLD sweep — and a prediction scored honestly

12 legs at 1920×1080 scale:1, drift 0, combat frozen. Sharp ≤2px %:

| threshold | arena | crypt |
|---|---|---|
| 0.10 (default) | 46.2 | 24.1 |
| 0.15 | 48.8 | 28.6 |
| **0.22** | **53.0** (+6.8) | **31.3** (+7.2) |
| 0.30 | 55.7 (+9.5) | 31.2 |
| 0.40 | 56.1 | 32.9 |
| SMAA off | 56.9 (+10.7) | 31.7 (+7.6) |

`hardEdgeRatio` **0.0019–0.0026 in every leg including full off**, against a 0.0055 reference — so that
guard never once constrained the sweep. It also never warned about the crawl found by looking at crops.
**A guard that stays green through both the safe and unsafe configurations is not measuring the risk.**

`fineStepEnergyAbs` flat with `allStepEnergyAbs` up throughout: structure, not deletion.

### My prediction was half right, and the wrong half was more informative

I predicted "the crypt gains more" from the sRGB analysis. **It does not** — gains are similar (~7–10pp)
at both stations. What the crypt does is **saturate earlier**: it hits its SMAA-off ceiling at threshold
**0.22**, while the arena needs 0.30–0.40.

That is the sRGB mechanism appearing in the **knee position** rather than the amplitude, and it is the
sharper signature: a darker room's shadow boundaries are smaller sRGB deltas, so a given threshold stops
blending them sooner. Same physics, cleaner evidence — and I would not have thought to look at the knee.

**The decisive number:** at 0.22 the crypt captures **95% of its available headroom** (31.3 vs off's
31.7) while the arena captures 64%. So for our darkest and worst-performing station, **a raised threshold
is as good as no AA at all** — while still antialiasing the thin geometry that made no-AA unshippable.
That is exactly the discrimination the approach was designed to find, and it exists because the two
populations (shadow boundaries, thin geometry) are well separated in sRGB delta.

**Habit for scoring predictions:** record which *aspect* of a mechanism a prediction commits to. I
predicted a magnitude ordering; the mechanism actually manifested in a threshold position. Being wrong
about the observable while right about the cause is a distinct and common outcome, and treating it as
simply "wrong" would have discarded a confirmation.


## A structural tension: hue coverage versus pool-of-light structure

Discovered at the very end of the round, and it reframes the whole approach to the hue defect.

**A cool minority pool fills dark corners. Filling dark corners evens the frame. An evened frame loses
`spatialVariation`** — the pool-of-light structure our own rubric calls the most important single
criterion.

So hue coverage and pool structure are in **direct tension**, and it is intrinsic rather than a tuning
artifact: *the pixels that most need cool are exactly the dark ones whose darkness creates the variation.*

Measured at the crypt:

| cool-pool multiplier | spatialVariation | margin over 0.60 floor | cool% |
|---|---|---|---|
| x1.2 | **0.608** | **+0.008** (inside settle noise of FAILING) | 10.4 |
| x1 (shipped) | **0.655** | +0.055 (real) | 7.7 |

The agent reverted to x1, trading cool 10.4 → 7.7 and warm 73.8 → 78.2 for a gate with genuine margin.
Correct: shipping 0.608 would have shipped a criterion that fails on the next capture, and the extra 2.7
cool missed the 20–27 band anyway.

**The headline win survives the revert intact** — crypt neutral 0.4 → **14.1** (inside the 10–15 reference
band), arena 0.2 → 8.7. That was a 30–60× *count* deficit and it is now in family. It survives because the
crossover ridge depends on the cool:warm **ratio sweeping across the floor**, which the offset geometry
provides at any magnitude — not on pool intensity.

### The likely resolution, for next round

Cool must arrive as a **motivated pool with its own falloff** — a second bright island — rather than as a
fill. Then it **adds** a lit/unlit boundary instead of erasing one, serving `structurePerLuma`,
`spatialVariation` and the cool band simultaneously. A fill fights all three at once.

**Habit:** when a metric resists improvement, check whether the obvious fix is *structurally* opposed to
another metric you also care about. Two agents independently reached ceilings this round — one on hue
spread versus warm dominance, one on cool coverage versus pool variation — and in both cases the ceiling
was real, not a tuning failure. Naming the tension is what makes a different mechanism findable.


## AUTHORITATIVE ROUND-12 BENCH — 29/30, at reference resolution

First bench in the project at **1920×1080, dpr 1 verified**, all six protocol pins, combat frozen, drift 0
at every station, config confirmed **live** (not merely on disk).

| station | vis | satV | blk | locC | spVar | meanL | SPL | pass |
|---|---|---|---|---|---|---|---|---|
| nave-lit | 33.98 | 0.392 | 7.15 | 0.01611 | 1.4211 | 0.0269 | 0.1486 | **6/6** |
| nave-wide | 31.32 | 0.384 | 6.52 | 0.01762 | 1.7724 | 0.0335 | 0.1166 | **6/6** |
| courtyard | 31.55 | 0.456 | 5.17 | 0.01054 ✗ | 1.0527 | 0.0204 | 0.1401 | 5/6 |
| crypt | 52.19 | 0.388 | 2.80 | 0.01519 | 0.6800 | 0.0254 | **0.2076** | **6/6** |
| arena | 59.48 | 0.387 | 1.58 | 0.02096 | 0.9384 | 0.0367 | **0.1978** | **6/6** |

**29/30, up from 25/30.** `localContrast` failed at four stations at round start and now passes at four —
a gate that resisted three entire rounds. Only the courtyard remains, 12% away.

**`structurePerLuma` 0.064–0.129 → 0.117–0.208.** The crypt (0.2076) and arena (0.1978) **exceed poe2-10's
0.1872** — the first time any station has crossed the weakest reference on the metric that cannot be gamed
by darkening or brightening. All five stations clear the 0.00268 `allAbs` floor.

**Neutral pixel count at the crypt: 507 → 33,579 (66×)**, now above the references' 21k–36k. The 30–60×
count deficit is closed.

### Mechanism confirmations from the agents' closing notes

- **SMAA did double duty.** `localContrast` is a luma-Laplacian, so sharper edges raise it *directly* —
  the threshold change moved both `structurePerLuma` and `localContrast`. That explains a recovery I had
  attributed entirely to the lighting and geometry work.
- **The structure gain survived resolution deflation.** An agent's 1365-px reads deflated to 0.208/0.198 at
  1920 and still cleared the floor, so the gain was real rather than low-resolution inflation. Its own
  res-sensitivity caveat, applied against its own headline result, and it held.
- **The arena has ~0.5pt of visPct headroom left** (59.48 vs the 60 ceiling), confirming that shipping the
  safe config was right *and* that next round's cool-island work there must be paired with a warm-trim
  because there is no room to add light.

### What the frame shows that the metrics do not

The monochrome brown wash is **gone** — there is a real temperature story: cool teal-grey stone upper-left,
warm firelight pooling from the right, and the crossover reading as neutral desaturated stone through the
middle, exactly the spatial gradient the mix-ratio arithmetic predicted. The floor no longer shows diagonal
corduroy.

But **the cool region is flat** — hue variety without pool structure. That is the crypt's `spVar 0.6800`,
our weakest station, and it is the tension an agent identified and reverted to protect. **The cool arrived
as a fill, not a second lit island.** And the neutral composition drifted: green-gap 55.4% → **91.3%** of
neutral mass against the references' 14–47%, because the teal ridge works *by* sweeping that gap.

Both caveats point at one well-posed next item: **trim warm → open visPct headroom → raise cool into a true
pool with its own falloff**, paired with some genuinely near-white low-chroma fill to rebalance neutral
character. That serves `spatialVariation`, `structurePerLuma` and the cool band together, where a fill
fights all three.


# ROUND 13

## The blind test was not blind: a HUD tell I never audited

Before the judges finished, I audited the pairs for non-rendering cues. Found one immediately.

**Our frames carry a HUD. Some references do not.** Bright-fraction in the bottom corners (a HUD
orb/bar produces bright hard-edged content there):

| frame | bottom-corner brightFrac | HUD? |
|---|---|---|
| ours (all stations) | 0.1805–0.1819 | yes |
| poe2-05 | 0.1689 | yes |
| poe2-07 | 0.1933 | yes |
| poe2-09 | 0.2238 | yes |
| poe2-10 | 0.1818 | yes |
| **poe2-11** | **0.0000** | **no** |
| poe2-12 | 0.0487 | no |
| poe2-00 | 0.0044 | no |

So the crypt-vs-poe2-11 pair was **identifiable from HUD presence alone** — a judge could name our
frame without looking at a single rendered pixel. Being instructed to "ignore the HUD" does not help
when its mere *existence* is the answer.

Fixed by substituting poe2-10 (brightFrac 0.1818) for poe2-11. The pair now reads 0.1818 vs 0.1819 and
all four pairs are matched.

**The uncomfortable part: the Round-11 blind result — judges 4/4 for PoE2, treated as this project's
headline finding and re-quoted in every summary since — may have been compromised the same way, and I
never checked.** I ran that comparison twice and did not audit whether the pairs were blind.

**Habit:** before trusting a blind comparison, audit the pairs for cues that identify the artifact
*without* engaging the property under test. Presence or absence of UI, aspect framing, compression
signature, colour-space feel, resolution. Round 12 accidentally removed one such cue by matching capture
resolution to the references (1920×1080 both sides) — for twelve rounds before that, ours were 1600×900
and theirs 1920×1080, which is itself a tell.

I also added a question to the judges' brief: **state explicitly whether any non-rendering cue informed
your guess.** Discovering a leak two rounds later is far worse than a judge naming one up front.

## An id collision nearly put two agents in one file

A Round-12 agent (`CoolMinority`) received the Round-13 kickoff broadcast — prior-round agents remain
reachable on IRC — and asked whether `CoolIsland` was a re-tasking of itself or a separate agent, rather
than assuming. It was separate. Had it assumed the former, **two agents would have been editing
`sky.js` simultaneously**, which is precisely what exclusive file ownership exists to prevent.

**Habit:** when broadcasting to `all` with several rounds' agents still alive, name the current roster
explicitly. And an agent asking "is this task mine?" is doing the right thing, not being slow.


## Round-13 blind verdict: 4/4 for PoE2 again — but it named two untouched defects

Four pairs, sides randomised, **resolutions matched at 1920×1080** and **HUD presence matched** (after
the substitution above). A harsh art-director judge won every pair for PoE2 and identified the commercial
frame in all four, confirming the sides were randomised.

Its stated biggest gap, essentially unchanged from Round 11: *"the commercial set's light wraps and decays
across relief-bearing surfaces with dark contact occlusion, while the renderer set lays flat ambient fill
plus isolated hard-edged pools over relief-less tiled albedo, so its floors and props read as
pasted-on."*

**Two rounds of measured work have not moved that verdict.** Worth sitting with rather than explaining
away. But this time it named specifics.

### Defect 1: unmotivated dust motes — named in THREE of four pairs, unprompted

> *"scatters unmotivated bokeh dust orbs mid-frame"* · *"floating bokeh orbs over a dead-flat center
> floor"* · *"orbs hover with no light source to motivate them"* · *"multi-colored floating orbs (blue,
> green, orange) reading as billboard sprites"* — named as the single weakest thing in that frame.

Contrast on the reference: *"drifting sparks that **actually illuminate** nearby debris."*

I counted compact bright isolated blobs before dispatching (ring test: local luminance >2.2× its
surroundings at 10px radius, above the floor line, HUD excluded):

| frame | blobs | | frame | blobs |
|---|---|---|---|---|
| ours nave-lit | 209 | | poe2-07 | 187 |
| ours arena | 106 | | poe2-09 | 98 |
| ours courtyard | 100 | | poe2-05 | 241 |

**Count is not the problem — ours is comparable in every case.** The defect is *character*: ours glow
without illuminating anything. Emissive sprites with no causal relationship to surrounding light. A real
mote brightens inside a pool and vanishes in shadow, and takes its colour from whatever lights it.
Per-particle rainbow colour is the tell.

This is a defect that **no metric in the suite captures** and that twelve rounds of measurement never
surfaced. Only a judge looking at the frame found it.

### Defect 2: colour variety, 2–3× short in every pair

Unique colours, 5-bit-per-channel quantised, sampled every 7th pixel, whole frame:

| pair | ours | reference | gap |
|---|---|---|---|
| pair1 | 4451 | poe2-07: 14444 | **3.25×** |
| pair2 | 4093 | poe2-10: 8494 | **2.08×** |
| pair3 | 5406 | poe2-09: 13454 | **2.49×** |
| pair4 | 3452 | poe2-05: 8374 | **2.43×** |

Systematic, every pair. A real rendering property — material and palette variety — and it aligns exactly
with the judge calling our surfaces *"relief-less tiled albedo"* and *"flat repeated albedo strips"*.

**An open question worth more than the fix:** a narrow palette may be **upstream** of `localContrast` and
`structurePerLuma`. If adjacent surfaces draw from a narrow palette they *cannot* differ much in
luminance — which would mean six rounds of chasing luminance steps were chasing a symptom.

**The constraint that makes it hard:** more colours must not mean more noise. We already carry more
sub-0.01 grain than PoE2 (71.5% of steps vs 53.0%). The references have more distinct colours arranged in
**coherent regions** — different stone beds, soot above braziers, water streaks, moss in damp corners —
not a noisier version of one colour.

**The meta-lesson:** I found both defects by *auditing the blind pairs for fairness*, not by running the
metric suite. The suite has been refined for twelve rounds and misses both. A judge's prose complaint,
converted into a measurement, found in twenty minutes what the instruments never showed.


## The palette-upstream hypothesis: refuted by a within-group correlation

I dispatched an agent with this hypothesis live in its brief: a narrow palette may be **upstream** of
`localContrast` and `structurePerLuma`, because adjacent surfaces drawing from a narrow palette *cannot*
differ much in luminance. If true, six rounds of chasing luminance steps were chasing a symptom.

| frame | uniqColours | structurePerLuma |
|---|---|---|
| ours courtyard | **1660** | 0.1401 |
| ours crypt | 1979 | 0.2076 |
| ours nave-lit | 2361 | 0.1486 |
| ours nave-wide | 2673 | **0.1166** |
| ours arena | 2890 | 0.1978 |
| poe2-10 | 3164 | 0.1872 |
| poe2-05 | 3462 | 0.2797 |
| poe2-12 | 4561 | 0.5253 |
| poe2-09 | 5453 | 0.2579 |
| poe2-11 | 5630 | 0.6079 |
| poe2-07 | 5944 | 0.3106 |

```
all 11 frames:  corr(uniqColours, structurePerLuma) = +0.713
OURS ONLY:      corr = +0.035     <-- essentially zero
REFS ONLY:      corr = +0.445
```

**The pooled +0.713 is a confound, not a mechanism.** Within our own five stations palette variety has
*no* relationship to structure. The pooled figure is almost entirely "the references are better at
everything" — two independent deficits co-occurring because one artifact is better made.

The counterexample sits in our own data: **our courtyard has the fewest colours of any frame (1660) and is
not our worst SPL** (0.1401, better than nave-wide's 0.1166 at 2673 colours). If palette drove luminance
steps that ordering would be impossible.

**Consequences:** the palette defect is real and worth fixing on its own merits — a 4/4 judge named
"relief-less tiled albedo" and we are 2–3× short in every pair — but it will not move the structure
metrics, and those metrics must not judge that work. The structure work is not redundant with it. Both are
needed.

**How close this came to costing a round:** the hypothesis was embedded in an agent's brief as a live
possibility. Had the within-group correlation not been checked, we might have concluded that fixing the
palette would close the structure gap.

**Habit:** when a pooled correlation supports a causal story, compute it **within each group** before
believing it. A strong pooled correlation with a near-zero within-group correlation is telling you about
group membership, not causation. This is Simpson's-paradox shaped and it is the most dangerous member of
the population-mismatch family in this file, because the pooled number *looks* like exactly the evidence
you wanted.


## Both judges 4/4 — and the "striping" they see is SCALE UNIFORMITY, not the bias I fixed

A second independent blind judge (technical brief) also went **4/4**, so PoE2 won **all eight verdicts**
across two judges. It reported our floors still show *"corduroy striping at identical
frequency/orientation"* — on frames that **include** last round's bond fix.

Measuring directional anisotropy in the exact windows it named:

| frame | anisotropy (max dir / min dir) |
|---|---|
| ours arena | **1.086** |
| ours crypt | **1.07** |
| ours nave-lit | 1.215 |
| poe2-07 | 1.062 |
| poe2-09 | 1.097 |

**Our arena and crypt are at reference. The bond fix worked** (source Gz/Gx 1.25 → 0.97; on-screen now
1.07–1.086 against references 1.062–1.097). So "corduroy" was the judge's word for a different property.

Its other phrases name it exactly: *"uniform cell scale"*, *"repeat at fixed periodicity with no
regional/room-scale break-up"*, *"a per-slab procedural material with no large-scale variation layer."*
That is **periodicity and scale uniformity**. Measuring per-scanline autocorrelation and asking how much
the dominant period *varies*:

| frame | lagSpread (period variation between scanlines) |
|---|---|
| ours arena | **0.007** |
| ours nave-lit | **0.014** |
| poe2-07 | 0.170 |
| poe2-09 | 0.167 |
| **ours crypt** | **0.960** |

**Our nave and arena floors repeat at a 12–24× more uniform scale than the references.** Everything is
the same size everywhere. A completely different defect from directional bias, it explains a percept two
judges described independently, and **no metric in the twelve-round suite measures it.**

**The crypt is the counterexample that proves the mechanism:** at 0.96 it is *more* varied than either
reference — and it is the one room that received cool pools last round. **Adding a second light with its
own falloff broke up the scale uniformity**, because a surface lit by two sources at different distances
no longer reads at one scale. That was an unplanned second effect of a hue fix.

Root cause found independently by the materials agent: **all four atlas cells are `base.hue ± 11`** —
every slab is the same tan stone. One line explaining "flat repeated albedo".

## Two judges volunteered corrections to their own verdicts

**The art judge, on being shown contact-shadow depth data:** *"'Dark contact occlusion' was my prose
reaching for a mechanism I never measured — you measured it and we're at reference. The percept was real,
my named cause was a guess dressed as observation."* It then offered a better hypothesis, explicitly
flagged as untested: pasted-on comes from a **lighting mismatch** — prop lit by flat ambient while the
floor carries a directional pool, so they read as two passes even with a dark band between them. No
shared light, no floor-to-prop bounce.

**The technical judge, unprompted:** its "floating contact shadows" meant **characters specifically**, not
props — and in the frame it named, the character is a near-black silhouette on a near-black floor, so the
percept is *"no LIT body to read a contact relationship against"*, not a missing occlusion band. It stated
its primary tell was never contact depth: it was **lighting causality plus relief-less repeated albedo**.

**Habit:** a judge's prose can be right about the percept and wrong about the mechanism — and the same word
("corduroy", "contact shadow") can denote different properties to different observers. Convert the prose
into a measurement *before* acting, and when the measurement clears, look for what else the words could
mean rather than dismissing the complaint.

Also disclosed by both judges: the **HUD is a confirmed non-rendering tell**, and one **identified our
engine class from the frame alone** — "SMAA-class post AA, screen-space bloom sprites for motes, post
vignette". Our post-process chain is itself a fingerprint.


### The judges' closing corrections, and a unification

**The technical judge explicitly retracted its own directional claim:** *"'Identical
frequency/orientation / corduroy' overreached — I asserted DIRECTIONALITY I did not measure, and your
anisotropy numbers refute that specific claim. What I actually SAW and what carries the verdict is the
other half of my phrasing: 'uniform cell scale', 'no large-scale variation layer'. Your lagSpread is the
correct quantification of exactly that percept. Treat my directional language as retracted; my
scale-uniformity language stands and is now numerically confirmed."*

A judge separating which half of its own observation survived measurement, and saying so unprompted, is
the most useful thing a critic can do.

**And a unification offered by the art judge:** multiple sources at different distances buy **both** hue
variety and scale variety. So the cool-island work and the regional-palette work are attacking one root
cause from two sides — *"everything reads at one scale under one light."*

That reframes the round's two independent-looking fixes as complementary:

| defect | measured | mechanism |
|---|---|---|
| hue: 96% warm / 3% cool in fire-only rooms | fixed R12 (neutral count 507 → 33,579) | a second light at a different hue |
| scale: lagSpread 0.007–0.014 vs refs 0.17 | open | a second light at a different **distance** |
| palette: all 4 atlas cells at `base.hue ± 11` | open | different stone beds, not one tan stone |

The crypt already demonstrates the first two together: it received a cool pool and is now the *only* one
of our rooms whose scale variety (0.96) exceeds the references (0.17).

**The durable lesson from this round:** twelve rounds of metric refinement never surfaced either of the two
defects that a fresh pair of eyes named in minutes — unmotivated motes and scale uniformity. Both were
then measurable *once I knew what to measure*. The suite is excellent at tracking defects it was built for
and blind to ones it was not, so **the blind judgement is not a scorecard at the end of a round; it is the
instrument that tells you which instrument to build next.**


### The controlled test: my crypt attribution was wrong in emphasis

A closed-out agent flagged that my "the cool pool broke up scale uniformity" claim rested on a
**cross-station** comparison (crypt 0.96 vs nave 0.007) — the exact between-group confound I had just
warned the team about on the palette hypothesis. It handed over a within-crypt A/B that already existed on
disk and **deliberately declined to build a competing instrument** so the result would use mine and stay
attributable.

| crypt | lagSpread | anisotropy |
|---|---|---|
| cool pool OFF | **0.910** | 1.085 |
| cool pool ON (shipped) | **1.343** | 1.080 |

The pool raises scale variety causally, **+48%**. But **the crypt was already at 0.91 with no pool** — 65×
the naves' 0.014. So the crypt's variety is mostly its **geometry** (rubble, sarcophagi, broken vaulting)
and the pool *amplified* an existing property rather than creating it. Anisotropy is flat across the A/B,
confirming the pool affects scale variety and not directionality.

### The metric is TWO-SIDED, and I published it as a floor

```
ours naves    0.007 - 0.014      12-24x BELOW
REFERENCES    0.167 - 0.170      <-- the target is here, in the MIDDLE
ours crypt    0.910 - 1.343      5-8x ABOVE
```

I published "0.007–0.014 → 0.17", which reads as *raise it as far as you can*. **Wrong.** Pushing the
naves past ~0.17 would overshoot into whatever regime the crypt occupies — and the crypt is our **worst
station on `spatialVariation`** (0.68, barely above its 0.60 floor). Those are plausibly the same
phenomenon: a floor with no coherent scale at all reads as noise rather than as masonry.

Corrected target: **0.15–0.20**, a two-sided window.

**Habit:** when a new metric is introduced from a reference band, check whether our stations bracket the
band or sit entirely on one side. If they bracket it, the metric is two-sided and stating it as a floor
invites overshoot. I had five stations spanning 0.007 to 1.343 around a reference of 0.17 and still
described it as a floor, because the station I was trying to fix happened to be below.

**Third time this project an agent has corrected me on a confound I had just finished warning others
about.** The pattern is consistent enough to be worth naming: warning others about an error class does not
inoculate you against it, and the people best placed to catch you are the ones you just warned.


### The two-sided target, confirmed: scale variety trades against pool structure

I tested the assumption behind my own correction rather than leaving it a hunch:

| station | lagSpread | spatialVariation |
|---|---|---|
| nave-wide | **0.004** | **1.7724** |
| nave-lit | 0.014 | 1.4211 |
| courtyard | 0.660 | 1.0527 |
| arena | 0.007 | 0.9384 |
| crypt | **0.960** | **0.6800** |

**correlation(lagSpread, spatialVariation) = −0.709.** Our lowest-lagSpread station has our *highest*
pool structure; our highest has our *lowest* (0.68, barely over its 0.60 floor). The tradeoff is real and
lagSpread is a two-sided window: target **0.15–0.20**.

**Caveat stated rather than buried:** n=5, and **the arena is off-trend** (lagSpread 0.007 with spVar
0.9384, below both naves). So this is a tendency, not a law — and the arena is evidence the tradeoff can be
*escaped*. Working out why would be worth more than the correlation.

### Three structural tensions, all the same shape

| tension | verdict |
|---|---|
| hue spread vs warm dominance | **not real** — correlation +0.57, they were never opposed |
| cool coverage vs pool variation | real — an agent reverted rather than ship a marginal gain into it |
| scale variety vs pool structure | real — correlation −0.709 |

In both real cases the resolution was **not to pick a side** but to find a mechanism serving both: a cool
pool with its own falloff rather than a fill; multiple sources at different distances rather than one. The
same shape applies to the palette work — **multi-scale stone beds give scale variety without destroying
pool structure, because the variation lives in the material rather than the lighting.**

**Habit:** when two desired properties appear opposed, check whether they are *actually* coupled (compute
the correlation) before accepting a tradeoff — one of three turned out not to be real. And when the
coupling is real, look for a third mechanism rather than a compromise point on the line between them.


## `modeSep`: the fill-versus-island distinction as one number

Chasing "why does the arena escape the tradeoff" produced the round's most actionable measurement.
Luminance distribution over the scene window:

| station | p10 | p50 | p90 | dynRange | brightFrac |
|---|---|---|---|---|---|
| nave-wide | 0.0131 | 0.0603 | 0.2142 | 16.4× | 0.355 |
| nave-lit | 0.0133 | 0.0777 | 0.2264 | 17.0× | 0.410 |
| courtyard | 0.0188 | 0.0771 | 0.2384 | 12.7× | 0.375 |
| **arena** | **0.0536** | 0.1786 | 0.2979 | **5.6×** | 0.485 |
| **crypt** | **0.0451** | 0.1553 | 0.2507 | **5.6×** | 0.504 |
| poe2-07 | 0.0196 | 0.0792 | 0.2782 | 14.2× | 0.318 |
| poe2-09 | 0.0118 | 0.0636 | 0.2966 | 25.2× | 0.300 |

**The arena and crypt — the exact two rooms that received cool pools — have p10 three to four times
higher than every other station and every reference, with dynamic range 5.6× against 14–25×.** The cool
pools **lifted the black floor**. That is the fill-versus-island distinction, quantified: *a fill raises
p10 and compresses dynamic range; an island leaves p10 alone and adds a second bright region.* The
references keep their blacks black (p10 0.012–0.020) and get variety from distinct bright regions.

It also explains why the arena broke the −0.709 trend: it is not escaping the tradeoff, it has the naves'
uniform scale (lagSpread 0.007) **and** the crypt's crushed dynamic range (5.6×) — failing both axes
independently.

### `modeSep` added to the analyzer, and it retires `spatialVariation` as the pool-structure metric

`modeSep` = mean(above-mean pixels) − mean(below-mean pixels), scene window, HUD excluded:

| frame | modeSep | spatialVariation |
|---|---|---|
| ours crypt | 0.0389 | 0.6800 |
| ours nave-wide | 0.0523 | **1.7724** |
| ours arena | 0.0670 | 0.9384 |
| poe2-07 | **0.1463** | 1.5542 |
| poe2-09 | **0.1612** | 1.5530 |

**Ours 0.039–0.067, references 0.146–0.161 — 2.4–3× short with zero overlap.** And decisively:
**poe2-07/09 have `spVar` ~1.55, LOWER than our nave-wide's 1.77, yet nearly 3× the modeSep.** On our best
`spatialVariation` station we were already "beating" the references on that metric while being 3× worse on
the property the rubric actually cares about. **`spatialVariation` measures variance; `modeSep` measures
separation between dark mass and bright mass.**

**This is the fourth metric this project has had to replace or reframe:** `largeStepEnergyPct` was
Goodhartable, `allStepEnergyAbs` was brightness-confounded, `hardEdgeRatio` stayed green while thin
geometry crawled, and now `spatialVariation` reads high on frames with no pool separation. Each was a
reasonable proxy that stopped tracking the percept once we optimised against it.

**Habit:** a metric that has been optimised against for several rounds should be re-validated against the
percept it was chosen to represent. Optimisation pressure finds the gap between a proxy and its target.

### And a coupling I overstated, corrected by a judge

I told the mote agent its work was coupled to the p10 drop — "motes cannot read as motivated over a floor
whose blacks are lifted". The technical judge pointed out it had judged a renderer frame with a genuinely
near-black floor, plenty of dark for a mote to be bright against, and the motes **still** read as sprites
for two reasons independent of contrast: they **illuminate nothing beneath them**, and **per-particle
rainbow colour** (blue, green and orange in one cluster) which no mote taking colour from surrounding
light could show.

So p10 is **necessary but not sufficient**. Two separate defects, both fixable in one file, neither
dependent on another agent. I created a false dependency between two agents and a judge dissolved it.


## The fourth tension, and a resolution that is positional rather than intensity-based

A closed-out agent warned that my "cut rangeMul, raise intensity" advice to the cool-pool agent would
destroy our only landed win: **the wide falloff that reads as fill is the same wide falloff that produced
the neutral crossover-ridge** (crypt 14.1%, inside the 10–15 reference band). I modelled the annulus where
cool-fraction lands in the measured neutral band (0.30–0.85):

| config | ridge area | vs current |
|---|---|---|
| current crypt I=960 R=23.6 | 1084 | 100% |
| tighter I=960 R=12 | 367 | 34% |
| island I=1920 R=12 | 278 | 26% |
| island I=3840 R=12 | 101 | 9% |
| island I=3840 R=8 | **0** | **0%** |

**My advice was refuted by arithmetic, and for a specific reason: `r_outer` is clamped at the range
cutoff.** The annulus is squeezed between a rising inner radius and a fixed outer one until it vanishes.
Worse, at R=8 `r_in == r_out == 8.00` — cool-fraction is still >0.85 where the light hard-cuts, which is a
**discontinuity ring**, a visible hard edge.

**Two lights does not fix it either.** Tight core + dim wide skirt gives ridge area 0 in every variant,
because cool-fraction jumps from >0.99 inside the core cutoff to <0.24 outside — **the neutral band is
skipped entirely**. A ridge needs a gradual falloff *at a specific absolute level*.

### The resolution: neutral is a RATIO, so put the ridge where warm is bright

`cool ≈ warm` is a ratio condition — the band does not have to sit on a dark floor. Placing the tight cool
source *adjacent to* an existing warm pool so their falloffs overlap:

| config | band | width | minLum in band |
|---|---|---|---|
| wide cool fill I=960 R=24, warm sep=26 | 6.0–11.1 | 5.1 | **25.1** |
| tight cool I=3840 R=8, warm FAR sep=26 | 7.5–8.0 | 0.5 | 71.4 |
| tight cool I=3840 R=8, warm NEAR sep=11 | 3.1–6.6 | 3.5 | **250.8** |
| tight cool I=3840 R=8, warm NEAR sep=9 | 2.5–5.4 | 2.9 | **368.9** |
| tight cool I=7680 R=8, warm NEAR sep=10 | 3.6–6.9 | 3.2 | **433.8** |

**The neutral band lives where minLum is 250–434 instead of 25 — a 10–17× brighter neighbourhood.**
Neutrals cost nothing in the darks, and the cool source's hard R=8 cutoff never reaches them, so p10 is
untouched.

**Stated caveat rather than a buried one:** annular area is ~39% per light (2π·4.85·3.5 ≈ 107 vs
2π·8.5·5.1 ≈ 272), so one repositioned source will not hold 14.1% neutral alone. **Two or three tight cool
sources near different warm pools** recovers the count — which is the same *"multiple sources at different
distances"* mechanism the art judge named for hue variety and the palette agent needs for scale variety.
**Three independent findings converge on one action.**

And this is an analytical model of the engine's light form (decay=2, hard cutoff, point sources), not a
frame measurement — **a prediction to verify**, with `modeSep` up, p10 flat, and crypt neutral% still 10–15.

### Four tensions, three real, and every real one resolved by a third mechanism

| tension | verdict | resolution |
|---|---|---|
| hue spread vs warm dominance | not real (+0.57) | — |
| cool coverage vs pool variation | real | a pool with its own falloff, not a fill |
| scale variety vs pool structure | real (−0.709) | material variation, not lighting variation |
| island vs neutral ridge | real (area 1084→0) | **position**, not intensity |

**Habit:** when a tension is real, the answer is never a compromise point on the line between the two
properties — it is a *different mechanism* that decouples them. Three for three.


## Validating a metric BEFORE optimisation pressure hits it — the first time in this project

Five agents were mid-flight optimising against `modeSep`. Rather than wait, I tested it against a pure
exposure change, because **four metrics had already been replaced for exactly this failure**:

| exposure | ×1.0 | ×1.2 | ×1.5 |
|---|---|---|---|
| `modeSep` | 0.1584 | 0.1900 | 0.2352 |
| `modeSep / meanL` | 2.6752 | 2.6748 | 2.6660 |

**It failed — `modeSep` scales ~linearly with brightness**, so an agent could "improve" it by brightening
the frame. `modeSepPerLuma` is invariant (0.5% drift). This is `allStepEnergyAbs` → `structurePerLuma`
repeating for the **fifth** time. Consequence for a shipped result: the pool-core agent's *+14.4% modeSep*
came alongside *+7.5% brightness*, so roughly half was exposure — though **its island conclusion stands**,
because p10-flat and dynRange 29.5→33.9 are exposure-independent signatures a uniform brighten cannot
produce.

### And a worse error of mine: reference-selection bias

I published *"ours 0.039–0.067, references 0.146–0.161, 2.4–3× short with zero overlap."* **I had measured
two references.** With four:

| frame | modeSep | modeSepPerLuma |
|---|---|---|
| ours nave-wide | 0.0523 | **2.9315** |
| ours courtyard | 0.0407 | 2.4445 |
| ours nave-lit | 0.0393 | 2.2815 |
| ours arena | 0.0670 | **1.7097** |
| ours crypt | 0.0389 | **1.4598** |
| poe2-09 | 0.1612 | 4.6564 |
| poe2-07 | 0.1463 | 4.5902 |
| poe2-11 | 0.0862 | 2.6584 |
| poe2-05 | 0.0337 | **2.0837** |

**There is no zero overlap. `poe2-05` is below every station of ours on raw and below three of five on the
invariant form; our nave-wide beats two of four references.** I produced a false universal by measuring the
two brightest, most structured references and generalising — reference-selection bias.

**The honest gate is more useful than the wrong one:** reference floor **2.08**; passing today are
nave-wide 2.93, courtyard 2.44, nave-lit 2.28; failing are **arena 1.71 and crypt 1.46** — *exactly the two
stations that received cool fill pools.* So it is a two-station deficit, not a universal one, and it is the
p10 finding arriving through an exposure-invariant instrument. That is corroboration, not restatement, and
far stronger evidence for the cool-pool fix than my wrong universal was.

**Two habits, both cheap:**
1. **Validate a new metric against a null transform (exposure, resolution, crop) before it drives a
   decision.** Every previous time we found the confound *after* shipping against it.
2. **A gap claim needs the full reference set.** Two samples cannot establish a range, and picking the two
   most extreme produces a confident, wrong universal.


# The biggest finding of the project: a PROTOCOL GATE was 96% exposure

I ran the null-transform test on the six shipped gates, not just my new metric. Pure ×1.25 exposure on one
frame, nothing else changed:

| metric | ×1.0 | ×1.25 | delta | verdict |
|---|---|---|---|---|
| **`localContrast`** | 0.0176 | 0.0273 | **+55.2%** | **CONFOUNDED — and it is a protocol gate** |
| `hardEdgeRatio` | 0.0026 | 0.0059 | **+123.5%** | CONFOUNDED |
| `allStepEnergyAbs` | 0.0039 | 0.0060 | +53.0% | known, already replaced by SPL |
| `modeSep` | 0.0523 | 0.0817 | +56.2% | known, replaced this hour |
| `spatialVariation` | 1.7724 | 1.8095 | +2.1% | ok |
| `structurePerLuma` | 0.1166 | 0.1159 | −0.6% | ok |
| `modeSepPerLuma` | 2.9315 | 3.0566 | +4.3% | ok |
| `fineStepEnergyAbs` | 0.0016 | 0.0016 | +0.4% | ok |

**`correlation(localContrast, meanLuminance) = +0.963` across our five stations.** The gate is almost
entirely reporting brightness.

### What that does to work we shipped and celebrated

`localContrast` failed at 4/5 stations this morning. We ran a round on it. Tonight it passes at 4/5 and I
published *"four gates gained"*. But the agents fixed it largely **by adding light** — pool cores ×1.5, cool
pools, brighter sconces. At 96% correlation with brightness, **most of that recovery was the brightening,
not structure.** I reported a structural win that was substantially an exposure artifact.

### The invariant form reverses the verdict completely

| frame | localContrast | meanLum | **LC/meanL** |
|---|---|---|---|
| nave-lit | 0.01611 | 0.0269 | 0.599 |
| crypt | 0.01519 | 0.0254 | 0.598 |
| arena | 0.02096 | 0.0367 | 0.571 |
| nave-wide | 0.01762 | 0.0335 | 0.526 |
| courtyard | 0.01054 | 0.0204 | 0.517 |
| poe2-11 | 0.02008 | 0.0202 | **0.994** |
| poe2-05 | 0.01630 | **0.0177** | **0.921** |
| poe2-07 | 0.01935 | 0.0255 | 0.759 |
| poe2-09 | 0.02025 | 0.0278 | 0.728 |

**Ours 0.517–0.599, references 0.728–0.994. Our best station is below the references' worst — zero overlap,
all five failing, gap 1.2–1.9×.** The opposite of "29/30 gates, four gained".

### And it explains twelve rounds of judge feedback

**`poe2-05` has the LOWEST mean luminance of any reference (0.0177 — darker than all five of our stations)
and the SECOND-HIGHEST ratio (0.921).** The references achieve their contrast *at low brightness*; we
achieve our gate score *by being brighter*. That is exactly "dark but readable" versus "washed out but
technically contrasty" — and it is why every blind judge called our frames flat, washed and pasted-on while
our instruments read green. **The judges were right and the instrument was wrong, for twelve rounds.**

`detail.localContrastPerLuma` is now the gate. Floor 0.728. All five stations fail it.

**Cross-validation that arrived independently:** the technical judge had noted `poe2-05` is *weakest* on the
island metric yet it judged that pair decisive, concluding material/lighting-causality is an independent
axis it could not name numerically. On LC/meanL, `poe2-05` is **0.921, second strongest of four** against
our best 0.599. An instrument built after its verdict confirmed the axis it inferred from looking.

**Five metrics have now failed this test, and the common cause is single:** every one was an *absolute
luminance-derived quantity measured on frames whose brightness we were actively changing.* Any future metric
of that shape must be normalised at birth.


## The vignette claim: mechanism inverted, premise refuted 4×, and a loophole in my own new gate

Both blind judges independently disclosed our renderer set as having *"a heavier corner vignette"*, and the
technical judge argued a vignette manufactures global contrast with no local contrast, **inflating raw
`localContrast`** while LC/meanL correctly discounts it. I tested it with synthetic vignettes on a real frame:

| vignette | localContrast | meanLum | LC/meanL |
|---|---|---|---|
| ×0.00 | 0.01762 | 0.0335 | 0.5259 |
| ×0.35 | 0.01372 | 0.0249 | 0.5505 |
| ×0.70 | 0.01079 | 0.0186 | **0.5815** |

**Raw `localContrast` goes DOWN 38.8%, not up** — it is a Laplacian mean, and the Laplacian of a smooth
low-frequency gradient is ~0 while the vignette *multiplies corner detail down*. **But LC/meanL rises
+10.6%**, because the vignette cuts mean luminance faster than it cuts local detail. **So the loophole is in
my new gate, not the old one — exactly inverted from the stated mechanism.** I would not have found it
without the claim.

### And the factual premise is refuted by 4×

Radial falloff (centre disc r<0.25 vs outer ring r>0.80):

| frame | centre | corner | falloff |
|---|---|---|---|
| ours nave-lit | 0.1148 | 0.0645 | 0.438 |
| ours crypt | 0.1724 | 0.1075 | 0.376 |
| ours arena | 0.1891 | 0.1337 | 0.293 |
| ours nave-wide | 0.1195 | 0.1018 | 0.148 |
| **ours courtyard** | 0.0836 | 0.1212 | **−0.450** |
| poe2-05 | 0.1665 | 0.0887 | 0.467 |
| poe2-07 | 0.2263 | 0.0763 | 0.663 |
| poe2-09 | 0.3020 | 0.0789 | 0.739 |
| poe2-11 | 0.2213 | 0.0485 | 0.781 |

**Ours mean 0.161; references mean 0.662 — the references have ~4× our vignette, and our heaviest station
(0.438) is below their lightest (0.467).** **Attribution corrected by the judge concerned:** I first wrote
that *both* judges reported this backwards and drew the lesson that "a shared percept can be confidently
wrong in the same direction." The art judge pointed out it had claimed no such thing — its note was
*"commercial frames read more filmic, renderer flatter/more linear"*, which points the **same** way as the
measurement. **One judge had the direction wrong, not two, so the lesson is narrower than I wrote it:** a
single confident percept can be wrong on cause, and the corroborating-sources count matters when drawing a
lesson from agreement. What that judge was seeing is our **dark
corners without a bright centre**: our centres are 0.084–0.189 against their 0.167–0.302. **Their
centre-to-corner range comes from brighter centres, not darker corners** — pool-of-light structure arriving
through a third independent instrument.

### Which forces me to shrink my own headline

A heavy vignette inflates LC/meanL ~+10.6% at 0.70 strength, and **the references carry the heavy vignettes
while ours are light** — so part of their LC/meanL advantage is vignette, not structure. Scaling for a ~0.50
falloff difference (~7–8% of LC/meanL), **my published 1.2–1.9× gap is more honestly 1.13–1.78×.** The
deficit survives, is still universal, and our best (0.599) is still below their worst (0.728) after the
correction — but it is smaller than I said, and a number I *like* gets corrected on the same standard as two
I did not.

### A new unclaimed defect: the courtyard's vignette is INVERTED

**falloff −0.450 — its corners are brighter than its centre (0.1212 vs 0.0836)**, where every reference is
strongly positive. An outdoor courtyard lit brighter at the edges than the middle is the exact inverse of
"pool of light in darkness", and it is very likely why the courtyard is our worst station on LC/meanL
(0.517) and the only one failing `visiblePct`.

**Habit:** test a claim's *mechanism* separately from its *conclusion*. Here the conclusion (vignettes
distort the contrast gate) was right, the mechanism was backwards, and the premise (whose vignette is
heavier) was wrong by 4× — three independent truth values in one sentence from a careful observer.


# The unified prescription: we spend MORE light than PoE2 and put it in the wrong place

Zone luminance by radius, with the total light budget:

| frame | ctr mean | mid | outer | **ctr/outer** | ctr p90 | **TOTAL** |
|---|---|---|---|---|---|---|
| ours nave-lit | 0.1215 | 0.1379 | 0.0736 | 1.65 | 0.2361 | 0.1110 |
| ours courtyard | 0.0780 | 0.1027 | 0.1193 | **0.65** | 0.1268 | 0.1000 |
| ours crypt | 0.1683 | 0.1365 | 0.1284 | 1.31 | 0.2284 | 0.1444 |
| ours arena | 0.1874 | 0.1719 | 0.1424 | 1.32 | 0.2656 | **0.1672** |
| poe2-05 | 0.1568 | 0.0915 | 0.0853 | 1.84 | 0.2515 | 0.1112 |
| poe2-07 | 0.2063 | 0.0871 | 0.0811 | 2.54 | 0.4993 | 0.1248 |
| poe2-09 | 0.2541 | 0.0731 | 0.0719 | **3.54** | 0.4869 | 0.1330 |
| poe2-11 | 0.1925 | 0.1062 | 0.0603 | 3.19 | 0.3604 | 0.1197 |

**Our arena spends more total light than every reference (0.1672 vs max 0.1330) and has the second-worst
pool ratio (1.32 vs 1.84–3.54).** We are not short of light — we are short of contrast between where the
light is and where it isn't.

- centre/outer: **ours 0.65–1.65, references 1.84–3.54**
- centre p90 highlight: **ours 0.127–0.266, references 0.252–0.499**
- **our mid/outer zones are 1.4–2.4× brighter than the references'** (ours 0.074–0.172, refs 0.060–0.106)

`poe2-09` is the cleanest proof: centre 0.2541, outer 0.0719, ratio 3.54, total 0.1330. Our arena: centre
0.1874, outer 0.1424, ratio 1.32, total 0.1672. **It spends 20% less light and gets 2.7× the pool ratio.**

### The prescription, for every station

> **Take light OUT of the mid and outer zones. Put it in the centre. Hold the total, or lower it.**

The excess mid/outer luminance *is* the "flat ambient fill" both judges named, and it is destroying
`localContrastPerLuma`, `modeSepPerLuma` and the pool ratio **simultaneously — three failing metrics, one
cause, one lever.**

**And it explains why brightening keeps failing the invariant gates.** Every agent who added light raised
the centre *and* the ambient together, so the ratio never moved while mean luminance rose — the exact
signature seen five times tonight: raw gate up, invariant gate flat or down.

### Two corrections to my own record, both from the agents concerned

1. **The art judge never made the claim I attributed to it.** Its note was *"commercial frames read more
   filmic, renderer flatter/more linear"* — pointing the **same** way as my 4× measurement. One judge had the
   direction backwards, not two. **Narrower lesson: check the corroborating-source count before drawing a
   lesson from agreement.**
2. **The grade agent's +4.1% survives my vignette loophole.** It toggled only SMAA with the vignette
   common-mode, and its mean luminance went *down* while LC/meanL rose — so the **numerator** rose, the
   opposite of the exploit. Genuine exposure- *and* vignette-invariant structure; small, bounded, and it
   stays in the win column.

The technical judge retracted both parts of its claim unprompted and named the useful residue itself:
**bright-centre absence, not corner darkening.** Its four verdicts never rested on it.


### The lever, named in code — and why it flattens the ratio by construction

There is **no `THREE.AmbientLight` anywhere in `src/`**. The fill is two terms in `src/render/sky.js`:

```
envIntensity: 0.72     // IBL — its own comment says "IBL is now the dominant cool ambient"
hemiIntensity: 0.13    // HemisphereLight, already cut once from 0.22
```

**The mechanism is arithmetic, not aesthetic.** Our 9 `PointLight`s have inverse-square falloff, so they
*make* pools. **IBL and HemisphereLight have no distance falloff at all** — they light the far corners of a
room exactly as much as the centre. Every unit of ambient adds to centre *and* outer equally, raising the
total budget while **driving centre/outer toward 1.0**.

That is why we sit at 1.31–1.65 (courtyard 0.65) against references 1.84–3.54. And it is why **five separate
agents raised raw `localContrast` and got flat-or-negative LC/meanL**: they were adding pool light on top of
a no-falloff floor the pool light cannot escape.

Concretely: `envIntensity` down substantially, point intensities up to hold the centre, total flat or lower.
Our arena spends 0.1672 against `poe2-09`'s 0.1330 for a 2.7× worse ratio — **20% of budget to give back
before reaching parity on spend.**

**Coupling caution:** `envIntensity` also carries the cool half of the colour balance — the teal IBL took
over the orientation-dependent wall/edge lift when `hemiIntensity` was cut, and it is what collapsed the
magenta wash a judge named earlier. A large cut risks `satVisible` under its floor, the mix ratio swinging
warm and losing the neutral-count win, and `blackPct` past 11. **Three-gate-coupled — cut stepwise with all
six gates measured at every step.**

### A protocol rule both judges reached independently, from opposite directions

> **Trust the percept and the located tell. Distrust a judge's volunteered mechanism unless it carries a
> measurement.**

The technical judge's blind first-pass percepts — flat fill, pool absence, relief-less repeated albedo,
non-illuminating motes — **survived every instrument built afterward**. Its errors were exclusively
*post-hoc causal stories added over IRC* (vignette direction, vignette mechanism). The art judge reached the
same rule from the other side with its contact-occlusion retraction. **A judge's located observation is
evidence; a judge's explanation is a hypothesis to test.**


## The decomposition: pool/ambient is 5.9× off, and my "hold the total" was wrong

Since the outer zone is reached by the no-falloff terms but essentially not by point lights, every frame
decomposes: `ambient ≈ outer mean`, `pool ≈ centre − outer`.

| frame | ambient | pool | pool/amb |
|---|---|---|---|
| ours nave-lit | 0.0736 | 0.0479 | 0.65 |
| ours crypt | 0.1284 | 0.0399 | 0.31 |
| ours arena | 0.1424 | 0.0450 | 0.32 |
| **ours courtyard** | 0.1193 | **0.0000** | **0.00** |
| poe2-05 | 0.0853 | 0.0715 | 0.84 |
| poe2-07 | 0.0811 | 0.1252 | 1.54 |
| poe2-11 | 0.0603 | 0.1322 | 2.19 |
| poe2-09 | 0.0719 | 0.1822 | 2.53 |
| **ours mean** | **0.1159** | **0.0332** | **0.29** |
| **refs mean** | **0.0747** | **0.1278** | **1.71** |

**Pool-to-ambient: ours 0.29, references 1.71 — 5.9× off.** One number subsuming the pool-ratio, LC/meanL
and modeSepPerLuma findings.

**Correction to my own prescription:** I said *"hold the total, or lower it."* Wrong — **ambient ×0.64 AND
pool ×3.85, net total ×1.36.** Our totals *look* comparable to the references only because our ambient is
inflated and our pools starved. My instruction would have capped the pool increase at a quarter of what is
needed.

**And it reverses a shipped agent's self-assessment in its favour:** five agents raised light and got flat
invariant gates — *not because adding light was wrong*, but because they added it **without cutting
ambient**, so pool/ambient barely moved. The pool-core ×1.5 was directionally correct and **masked** by a
0.128 ambient floor.

**The courtyard has pool = 0.0000** — its centre (0.0780) is *darker* than its outer (0.1193). Not a weak
pool, a negative one. You cannot post-process a pool that does not exist, which is why every AA and grade
lever tried there was dead.

**Per-station, ambient targets differ:** nave-lit is already at reference ambient (0.0736 vs refs
0.060–0.085) — **its deficit is purely pool starvation.** So the ambient cut is a three-station fix, not a
global one; a global `envIntensity` cut would push the naves *below* reference ambient and cost blackPct.

## The ACES inflection at x = 0.1203 — a systemic fact missed for thirteen rounds

A closed-out agent objected that cutting ambient was *proven counterproductive* in a prior round because
ACES is convex in the toe, so a constant offset widens output separation. It also noted `structurePerLuma`
is the round's **target but not one of the six gates**, so my stepwise guard would not catch an SPL
regression. Measured:

1. **The premise is correct** — ACES f''(0.0305) = **+21.0**, strongly convex.
2. **The mechanism is correct in isolation** — a fixed step with ambient 0.115→0.075 narrows separation to
   **93.1%**.
3. **But at our lit-region operating point it reverses.** Our lit region is at ambient+pool = 0.1491;
   cutting ambient alone moves it to 0.1079 and separation goes to **102.2% — it helps.**
4. **What costs us is the pool raise** — the full prescription puts the lit region at 0.2025 and separation
   falls to **89.5%**.

> **The ACES inflection is at linear input x = 0.1203. Below it the tonemap EXPANDS scene steps; above it it
> COMPRESSES them.**

| station | lit level | headroom to inflection |
|---|---|---|
| courtyard | 0.0780 | +0.0423 (below) |
| nave-lit | 0.1215 | −0.0012 (exactly at) |
| crypt | 0.1683 | −0.0480 (past) |
| arena | 0.1874 | −0.0671 (past) |

**Three of four stations already operate past the inflection, where the tonemap works against every
structural gain** — unmeasured in thirteen rounds, and a partial explanation for why structural fixes keep
under-delivering on SPL.

**The prescription survives but is now priced.** References operate at and past the inflection too
(0.157–0.254) and still carry SPL 0.258–0.311 against our 0.117–0.208 — **they overcome tonemap compression
with far more scene-referred structure.** Getting to pool/ambient 1.71 costs ~10% of step separation, so
**scene structure must rise by more than the 2.21× the SPL ratio implies.**

**The two findings reconcile rather than conflict:** the prior caution was measured at the *ambient* level
and is valid there; the prescription operates on the *ratio* and pays its cost at the *lit* level. What was
wrong was treating "ACES convexity" as a global property — **it has a sign change at 0.1203 and we straddle
it.**

**Guard correction accepted in full:** `structurePerLuma` and `meanLuminance` join the stepwise checklist.
The six-gate guard would have let an SPL regression through — *measuring what is gated rather than what is
targeted*, which is this project's most repeated error.

**And a composition caveat, measured independently:** the radial zones are **screen**-position, so at a
camera whose pool is not screen-centred, raising intensity moves the ratio the *wrong* way (+10.3% outer,
ratio worse). **"Put light in the centre" is partly a composition lever, not purely an intensity one** — and
the ambient cut and pool raise are coupled and must land in the same step.


### The lever scope was wrong, and the courtyard's root cause was in a code comment

**A closed agent caught that my named lever contradicted my own per-station target.** `envIntensity` and
`hemiIntensity` are **global** (`scene.environmentIntensity`, `hemi.intensity`) — no per-room control — so a
cut would hit the naves I had just said to spare. Confirmed in code: **the only per-room fill path is the
`rm.kind` override block in `buildSkylights`.** And the live agent was *already pulling it*: arena warm fill
1.0 → 0.82, crypt 2.3 → 2.05, with a `warmSkyMul` A/B knob wired. **The per-station ambient cut was in
flight on the correct lever before I named the wrong one.** The crypt's fill at `mult 2.05` vs the arena's
0.82 is the largest per-station ambient contributor in the build.

**The courtyard is solved, and it is not a lighting-config defect.** Its skylight was already dimmed and
tightened this round (`mult 0.45`, range multiplier 1.7 → 0.78, i.e. range ~57 → ~26 over an ~18.6-radius
room), measured vis 87 → 45 and spVar 0.42 → 0.73. **And the comment names the residual exactly:** *"the
room's large-step POOL structure needs actual light-casters and is owned by props.js, not here."*

> **The courtyard is the one room with no braziers. Its pool measures 0.0000 because it has no
> light-casters at all** — one dimmed skylight and nothing else, against every reference's 0.0715–0.1822.

Highest-value single fix in the project, diagnosed three independent ways: inverted vignette (−0.450), pool
0.0000, and a code comment that *predicted it in advance*.

### My decomposition's core assumption is refuted by direct measurement

I assumed `outer ≈ pure ambient` because point lights don't reach it. The pool agent toggled **only**
`baseInt` (ambient common-mode) and distributed the pure-pool delta radially:

```
centre +0.0003    mid +0.0032    OUTER +0.0030
```

**Ten times more pool energy landed in the outer zone than the centre**, because the crypt's pools are framed
off-centre. My decomposition scores that as an *ambient* rise. **So crypt ambient 0.128 and arena 0.142 are
part-pool and overstated**, and pool is understated. The 5.9× deficit stands as direction and
magnitude-class, but **the per-station ambient targets I published are not safe to cut against** — forcing
outer to 0.075 would over-cut true IBL into the blackPct and cool-balance risks. Correct method: **measure
the outer zone with point lights OFF** to separate the terms.

### The SPL bound and the ACES inflection are one finding, cross-validated from both ends

The pool agent had measured *"brightening cannot raise SPL, sign slightly negative, plausibly ACES toe
shallowing"* — with no mechanism. **The inflection at x = 0.1203 is the mechanism**, and the crypt's lit
level 0.1683 is past it in the compressive regime, so brightening a crypt lit region *must* reduce relative
separation. Its measured A/B: `allStepEnergyAbs` **+7.5%** with SPL **−4.6%** and modeSepPerLuma +2.6%.
**Analytic prediction and rendered measurement agreeing on a ~10% tonemap tax, derived independently.** Its
"toe shallowing" guess was directionally right but located at the wrong part of the curve.

**What this hour produced:** one protocol gate invalidated as 96% exposure, two exposure-invariant
replacements shipped in the analyzer, a 5.9× lighting deficit quantified, the ACES inflection located at
0.1203 after thirteen rounds of not knowing it existed, the courtyard's root cause found in a comment that
predicted it — and **five of my own published numbers corrected, three by my own instruments and two by
agents already closed out.**


# Round 13 result: 29/30 gates, and the deficit is now DETAIL, not lighting

## What shipped, and one bug I caught in my own prescription

Five agents shipped into `sky.js`, `props.js`, `level.js`, `materials.js` and `lighting.js`. My first
authoritative capture read **26/30** — a regression from 29/30. The cause was mine.

**The cool-island intensity I derived analytically (I=3840, R=8–9) was for a SINGLE source. The shipped
config used `count: 3` at that intensity.** I had separately written *"two or three tight cool sources near
different warm pools recovers the ridge count"* — and never re-derived the intensity for three. Three r=9
pools at 3840 in a ~12-unit room overlapped into a saturated teal **flood** covering two thirds of the
frame: the exact "fill, not island" defect the work existed to remove.

Frame-verified A/B, count as the only variable:

| leg | meanL | vis | LCperLuma | modeSepPerLuma | gates |
|---|---|---|---|---|---|
| crypt count 3 | 0.1068 | 66.4 | 0.3616 | 2.4831 | **4/6** |
| crypt count 2 | 0.0718 | 56.9 | 0.4658 | 2.7824 | 6/6 |
| **crypt count 1** | **0.0507** | 47.0 | **0.5085** | **2.9963** | **6/6** |
| arena count 3 | 0.0810 | 58.2 | 0.4796 | 3.1054 | 5/6 |
| arena count 1, mult 9.0 | 0.0566 | 51.8 | **0.5428** | 2.9729 | **6/6** |

**One source is better on every metric, not merely cheaper — `modeSepPerLuma` RISES (crypt 2.48 → 3.00),
because overlapping pools destroy the separation they add.** Shipped `count: 1` for both rooms and arena
`mult 14.0 → 9.0`.

**A near-miss worth recording:** my first sweep used a *partial* override `{crypt:{mult}}`, which silently
dropped `count`, `coolRange`, `sep` and `offsetFrac` to defaults. It produced beautiful numbers for a config
that wasn't the shipped one, and I nearly reported "the shipped config is fine, it's a light-accumulation
bug." Caught it by counting lights in the scene graph before and after a rebuild: **idempotent, 6 cool
lights both times** — no accumulation. **A partial override of a config object is a different experiment
than the one you think you are running.**

## Authoritative Round 13: 29/30

| station | vis | sat | blk | locC | spVar | meanL | gates |
|---|---|---|---|---|---|---|---|
| nave-lit | 30.83 | 0.399 | 7.64 | 0.01543 | 1.5071 | 0.0262 | 6/6 |
| nave-wide | 25.99 | 0.394 | 7.88 | 0.01479 | 1.7543 | 0.0263 | 6/6 |
| courtyard | 31.87 | 0.459 | 5.50 | **0.01097** | 1.0031 | 0.0200 | 5/6 |
| crypt | 47.44 | 0.530 | 9.21 | 0.02403 | 1.3011 | 0.0488 | 6/6 |
| arena | 51.15 | 0.528 | 4.15 | 0.03020 | 1.3222 | 0.0549 | 6/6 |

The single failure is the courtyard's `localContrast` — the zero-light-casters defect, diagnosed and handed
forward. **`modeSepPerLuma` now clears the 2.08 reference floor at all five stations** (crypt +1.39, arena
+1.38 — both previously failed).

## The real remaining gap, measured on the judges' exact view

Cropping to the analyzer window (HUD removed from both sides) gives the cleanest ours-vs-refs comparison:

| pair | side | identity | LCperLuma | modeSepPerLuma | **SPL** |
|---|---|---|---|---|---|
| 1 | A | ours nave-lit | **0.7087** | 2.4314 | 0.1839 |
| 1 | B | poe2-07 | 0.6473 | 4.5010 | 0.2517 |
| 2 | A | ours crypt | 0.5174 | 2.7168 | 0.0908 |
| 2 | B | poe2-09 | 0.5354 | 3.8340 | 0.2940 |
| 3 | A | poe2-11 | 1.0133 | 2.4303 | 0.4894 |
| 3 | B | ours arena | 0.5322 | **2.9177** | 0.1208 |
| 4 | A | ours courtyard | 0.5303 | **2.4897** | 0.1737 |
| 4 | B | poe2-05 | 0.7905 | 1.8682 | 0.3295 |

**We now beat references on some metrics for the first time:** our nave-lit `LCperLuma` 0.7087 > poe2-07's
0.6473; our arena `modeSepPerLuma` 2.92 > poe2-11's 2.43 and poe2-05's 1.87.

**But `structurePerLuma` is 0.09–0.18 against 0.25–0.49 — we lose all four pairs, 2–3×, with zero
overlap.** That is the most consistent deficit in the entire measurement history, and it is **not lighting**.
SPL is scene-referred detail per unit brightness: material relief, geometric density, texture variety.

**So the diagnosis has moved.** Thirteen rounds attacked lighting, and lighting has largely converged — one
station short of a full gate sweep, and we beat references on two of the three invariant lighting metrics in
at least one pair each. **The remaining gap is authored detail, and it is uniform, large, and untouched.**


## The SPL deficit decomposed: our FINE detail is at parity; we are 5.5x short on LARGE steps

| metric | ours | refs | ratio |
|---|---|---|---|
| `fineStepCountPct` | 90.19 | 80.77 | 0.90× |
| **`largeStepCountPct`** | **0.94** | **5.22** | **5.53× (we are short)** |
| `fineStepEnergyAbs` | 0.00166 | 0.00175 | **1.05× — parity** |
| `allStepEnergyAbs` | 0.00382 | 0.00988 | 2.59× |
| `structurePerLuma` | 0.1423 | 0.3412 | 2.40× |

Per frame the gap is starker: nave-lit **0.20%** large steps vs poe2-07's **4.16%** — **20× fewer.**
Courtyard 0.11% vs poe2-05's 1.71%. Our best is the arena at 2.99% vs poe2-11's 9.32%.

**This inverts the obvious conclusion.** The deficit is *not* missing fine texture — fine step energy is at
**1.05× of reference, i.e. parity**. Nor is it a shortage of edges overall: we have *more* fine steps
(90% vs 81% of all steps). **What we lack is large luminance discontinuities** — the coarse steps produced
by silhouette edges against contrasting backgrounds, hard shadow boundaries, occlusion edges, and abrupt
material changes.

And the `fine/all` energy ratio makes the shape of the problem plain: **ours 0.26–0.62, references
0.13–0.36.** Our step energy is *dominated* by fine detail; theirs is dominated by large structure. We have
the texture and lack the form.

**Why this matters more than any lighting fix:** "reads as pasted-on" is precisely what a frame looks like
when objects lack large luminance steps at their boundaries. A prop with correct albedo and fine grain but
no strong step where it meets the floor has nothing anchoring it in space. Thirteen rounds of judges said
"pasted-on"; this is that percept as a number, and it is 5.5×.

**It is also a different work programme than "add more detail".** Large steps come from: bigger silhouettes
against contrasting backdrops, harder shadow terminators, occlusion contact darkening, fewer but larger
forms, and depth layering that puts a lit surface directly against a dark one. Adding more fine texture
would move `fineStepEnergyAbs` — already at parity — and leave the actual gap untouched.


# The thirteen-round mystery, solved: we were measuring the wrong CHANNEL

Three separate blind judges, across four rounds, described the floors as *"combed diagonal striation"*,
*"corduroy striping"*, *"repeating streaked/moire pattern"*. Two agents fixed it — one adjusted floor bond
phase and gradient direction, one added palette variety — and **the judges kept seeing it.**

## What it actually is

At 3× zoom on a nave floor: **hard 1-pixel diagonal streaks, strictly parallel, coloured teal AND red** —
overlaying otherwise-correct cobble relief. Teal and red are exactly our two light colours (cool IBL, warm
brazier), and **albedo artifacts cannot pick up light colour.** So these are *shading* artifacts.

Mechanisms tested and refuted, in order:
1. **Godray / screen-space smear** — streaks are pixel-identical with `godrayPass.enabled = false`.
2. **Under-filtered textures** (the technical judge's hypothesis) — **anisotropy is 16, the hardware
   maximum, with mipmaps on, on every floor texture** (`kit-stoneFloor`, `kit-cobble` both `aniso=16
   mips=true`). Refuted.
3. **My own crop pipeline** — `crop.mjs` is nearest-neighbour at `scale=1`, bit-exact. Clean.
4. **Floor normal maps** — stripping `normalMap` from all 93 materials at runtime removes most of the
   streaking. **Confirmed, ~45% contribution.**

## And the amount of detail is not the defect — the DIRECTION is

| frame | chromaMean (1px) | chromaP99 |
|---|---|---|
| ours base | 0.01070 | 0.06667 |
| ours, normals stripped | 0.00608 | 0.03529 |
| **poe2-07** | **0.01686** | **0.12549** |
| poe2-09 | 0.00706 | 0.06667 |

**poe2-07 has nearly 2× MORE high-frequency chroma than we do.** More fine chroma detail is what a good
frame looks like. What distinguishes a *streak* is that it is **directionally coherent**.

Chroma autocorrelation ALONG the diagonal vs ACROSS it (a streak correlates along its own length):

| frame | along | across | **ratio** |
|---|---|---|---|
| ours, floor patch | 0.8510 | 0.6703 | **1.270** |
| ours, normals stripped | 0.9520 | 0.8691 | 1.095 |
| poe2-07 | 0.8016 | 0.8363 | **0.959** |
| poe2-09 | 0.9246 | 0.9129 | **1.013** |
| poe2-11 | 0.8850 | 0.8829 | **1.002** |

**Every reference is isotropic at ~1.00 (0.959–1.013). Our floors are 1.270.**

## Why two fixes failed, and it is the same lesson as the exposure confound

**Round 12 measured LUMINANCE ridge anisotropy, got 1.086 against a reference range of 1.062–1.097, and
correctly declared the floors isotropic.** That measurement was right. **The defect is in CHROMA, and no
instrument built in thirteen rounds ever measured chroma directionality.** The judges' percept was correct
and specific the entire time; every instrument aimed at the wrong channel.

`detail.chromaCoherence` now in the analyzer. Full-scene-window values (smaller magnitude than the floor
patch, because floors are only part of the window — which itself confirms the defect is concentrated on
floors):

| frame | chromaCoherence |
|---|---|
| ours base | **1.0566** |
| ours, normals stripped | 1.0180 |
| poe2-05 | 0.9858 |
| poe2-07 | 0.9973 |
| poe2-09 | 1.0017 |
| poe2-11 | 1.0061 |

**Gate: 0.98–1.01.** Ours fails at 1.0566. **Next round's first fix is the floor normal-map generator** —
the directional pattern is in the generated normals, not the albedo, not the filtering, and not the post
chain.

**The lesson, for the third time in this project:** when a percept survives every fix, the instrument is
measuring the wrong *quantity* — not measuring it badly. Exposure-confounded gates hid the contrast deficit;
luminance-only anisotropy hid the chroma streaking. **A judge that keeps naming the same defect after you
have "fixed" it is telling you your instrument is aimed wrong.**


# Playtest: it plays, and playing it found two things measurement never did

Booted the shipped build and actually played it with synthetic input rather than teleporting a frozen
camera around. Results after ~45s of combat:

| | |
|---|---|
| JS errors | **0** |
| Kills | **10** |
| XP earned | **218** |
| Damage taken | 171 (1200 → 1029) |
| Distance travelled | 21 world units from spawn |
| Wave progression | Wave 3 at boot → **Wave 5** |
| Rooms generated | 7 — entry, nave, crypt, cistern, courtyard, collapsed, arena |
| Entities live | 112 (69 hostile, 32 props, 1 player) |

Movement, dash, attack, four skills, mana cost, damage, kills, XP, wave progression and loot all function.

## 1. I had documented the controls wrong, and only playing caught it

I published *"left-click move/attack"* in a summary. **Movement is RIGHT-click** —
`player.js:172` reads `if (Input.rmb && _holdT <= 0) _dest.copy(Input.ground)`. Left-click is the `Cleave`
attack (`skills.js:39`, `key: 'lmb'`).

I spent four tool calls debugging "a bug in the primary control" — dispatching synthetic `PointerEvent`s,
checking which of the **28 canvases** was the WebGL one, verifying events arrived via a spy handler — before
reading the line that assigns `_dest`. The events *were* arriving the whole time; I was pressing the wrong
button. **The bug was in my documentation, and I had written that documentation by inference.**

Worth noting the sequence: I *confirmed* input worked (spy counted `down:1 move:1 up:1`, player nudged 0.045
units), then concluded "it's slow or blocked" and kept debugging the harness. The 0.045-unit nudge was
LMB-attack recoil, not movement. **A weak positive signal sent me down a wrong path that a single grep would
have closed.**

## 2. A performance profile nothing in thirteen rounds had measured

Every previous measurement was a *frozen* frame at a parked camera. Under live combat:

| point | live hostiles | shader programs | fps |
|---|---|---|---|
| boot | 11 | 78 | **14.4** |
| +5s combat | 20 | 154 | 9.1 |
| +10s | 20 | 154 | 7.8 |
| +15s | 30 | 126 tex | 8.0 |
| +20s | 30 | 154 | **7.1** |

**fps halves as live hostiles go 11 → 30.** This is headless software GL (SwiftShader, no GPU), so absolute
numbers are not real-hardware figures — but the *scaling* is, and it is roughly linear in hostile count.

**A false alarm I had to walk back:** a long session showed **722** shader programs and a stalled render loop
(`requestAnimationFrame` never fired in 2s; screenshots timed out at 20s). I suspected an unbounded program
leak. A clean reload disproved it: **programs plateau at 154** once every enemy archetype has spawned its
materials, then stay flat. The 722 came from *my own* test toggles in that session — 93 materials with
`needsUpdate = true` twice for the normal-map A/B, plus `castShadow` flips — each forcing recompiles.
**My instrumentation contaminated the metric I was reading, and only a fresh page separated the two.**

## Why this matters for the visual work

Thirteen rounds of gate measurements were taken on frozen frames with combat disabled — pin 5 of the capture
protocol exists precisely to keep VFX out of the hue and step populations. That is correct for comparing
against still reference frames. **But it means no visual metric in this project has ever been measured under
the conditions a player actually sees:** 30 hostiles, active VFX, projectiles, at 7 fps instead of a settled
frame. The gates describe a photograph of the game, not the game.


# Four gameplay fixes from actual play, and three of my own measurement errors

The user reported: movement should be WASD, cannot see the character, super laggy, mouse
sensitivity far too high. All four were real. Verified by playing: **30 kills, 377 XP, reached
level 2, 0 JS errors.**

## 1. WASD movement

`player.js:172` bound movement to **right-click** (`Input.rmb`). Added camera-relative WASD: at
yaw 42° world-space WASD would send you diagonally for no visible reason, so the keys project
onto screen axes — into-screen is `-(sin yaw, 0, cos yaw)`, screen-right is
`(cos yaw, 0, -sin yaw)`. Verified against expectation:

| key | measured direction | expected |
|---|---|---|
| A | (−0.74, +0.67) | (−cos42°, +sin42°) = (−0.743, +0.669) ✓ |
| D | (0.74, −0.67) | (+cos42°, −sin42°) = (0.743, −0.669) ✓ |

Keys override any click destination and clear `_dest` on release, so letting go does not resume
walking to a stale click target — the same stale-`_dest` failure the file already documents for
teleports.

**The remap was a four-file change and I initially did one file.** `W` was Storm Lance, so it moved
to `F`. Changing `stormLance.key` was not enough:

| file | what was stale | symptom |
|---|---|---|
| `combat/skills.js` `KEY_TO_SKILL` | `w: 'stormLance'`, no `f` | `buildBar()` silently emitted **8 slots instead of 9** — Storm Lance vanished from the HUD |
| `entity/player.js` `SKILL_KEYS` | still listed `'w'` | `W` **both walked and cast** on one keypress |
| `ui/skills.js`, `combat/combat.js` | slot label / cast order | HUD label and ordering |

Both now fixed; bar rebuilds with 9 slots and `f:Storm Lance` in position.

## 2. Character visibility — and the fix was SIZE, not contrast

`config.js` had already diagnosed this in a comment and never acted on it: *"The real fix for
readability is rim light and silhouette, not resolution."* So I built `charRim` in `sky.js` — a
cool-white light behind and above the actor relative to camera, tight range (5u) so it grazes the
silhouette without becoming another ambient fill.

**Then measurement said the premise was wrong.** With the player pinned at a fixed screen position
and floor sampled either side of him at equal depth:

| rim / fill | body/floor | edge(p90)/floor |
|---|---|---|
| 2.6 / 0.42 (shipped) | **1.57** | **4.37** |
| 10 / 0.6 | 1.64 | 4.37 |
| 20 / 1.0 | 1.75 | 3.87 |
| 34 / 1.5 | 1.70 | 3.52 |

Value separation was **never the problem** — even shipped values gave 1.57× body and 4.37× edge.
And **past rim 20 the silhouette reads worse**, because a rim at range 5 lifts the floor faster
than the figure: the same fill-versus-island failure measured on the room lights all round. Took
rim 10 as the knee (gains body separation while holding edge ratio at maximum).

The actual fix was **camera distance 26 → 21**, measured at 1600×900:

| distance | character height | % of frame |
|---|---|---|
| 26 | 73px | 8.1% |
| **21** | **91px** | **10.1%** |
| 17 | 112px | 12.4% |

`config.js`'s own note targets PoE2's ~97px equivalent, so 21 is closest. The 26 value came from a
**720p** measurement and under-delivers at 900p.

**Two of my own measurements were wrong before I got this right.** I first reported a 1.12× ratio
and concluded he was invisible — my sample box included his own cast shadow as "floor". Then a
whole rim sweep produced ratios *below* 1.0, because the player had drifted out of my fixed box
between legs. Only after pinning him on screen and re-deriving the boxes did the numbers hold.

## 3. Mouse sensitivity

`CFG.camera.lookAhead` 0.16 → **0.04**. `camera.js:39-40` biases the camera target by
`(Input.ground − player.pos) * lookAhead` every frame, so the cursor drags the entire view. At 0.16
the character never sat still on screen.

## 4. Lag — and what I refused to ship

Profiled instead of guessing. **Half resolution (800×450) gave zero improvement — 15.1 vs 15.2**,
so this is not pixel-bound; it is CPU-bound. Two levers reproduced cleanly, each ~25%:

| lever | fps | note |
|---|---|---|
| shadows off (21 monsters both legs) | 15.5 → 19.4 | **+25%**, but shadows are core to the look |
| 30 enemy meshes hidden | 14.6 → 18.3 → 14.5 | **+25%**, restored exactly |

Shipped: `enemy.maxActive` **90 → 30** (fps scales ~linearly with hostile count: 11 → 14.4fps,
30 → 7.1fps, so a 90 cap guaranteed single digits), and `QUALITY.level` **ultra → medium**, which
disables GTAO: **17.8 vs an ultra mean of 13.8, +29%**.

**What I did not ship, and why.** A frustum-culling experiment read **14.5 → 19.2 fps (+32%)**,
which would have been the biggest single win. It **did not reproduce** — re-run it went
15 → 14 → 13.6, the opposite direction. The first result was **monster-count drift**: the spawner
keeps adding even while existing monsters are frozen, so legs measured at 21 and 30 hostiles were
being compared as if equal. I also caught `pointCasters: 0` in every leg of a shadow-caster sweep,
meaning that setter never took effect at all.

**The noise floor, once I hard-pinned the roster at 22 by wrapping `World.add`:** the *same*
`ultra` setting read **14.8 then 12.7 fps — ±14%.** That retroactively invalidates `high` vs
`ultra` (13.9 vs 14.8) as a distinguishable result, and it is why only `medium` (+29%, outside the
band) was shipped.

All numbers are headless software GL (SwiftShader, no GPU). Absolute fps on real hardware will be
far higher; the *scaling* is what transfers.

## The methodological point

Thirteen rounds of visual gates were measured on **frozen frames with combat disabled** — correct
for comparing against still reference images. Every one of these four defects was invisible to
that method: two were input bindings, one was a 720p-derived constant, one was frame time under
live load. **Playing the thing found in one session four defects that thirteen rounds of frame
measurement could not see** — and my own errors in this session were all the same shape as the
ones I had spent the round catching in others: uncontrolled variables between A/B legs.


# Finishing the game: it had no ending, and neither terminal state worked

"Finish the game" turned out to be literal. The game was an endless wave arena with **no win
condition and no loss condition** — and both were broken in ways only playing could reveal.

## The win: killing the boss put you back in endless mode

`director.js` already spawned a boss (`Ordolth, the Sundered`, 2600 hp, 3 phases, staged entrance
with a guard wedge) and set `bossDefeated = true` on its death. **Nothing consumed that flag.** And
because `bossActive()` returns `bossSpawned && !bossDefeated`, killing the boss made it return
**false**, which re-opened the spawn gate in `fixed()`:

```
if (this.spawnTimer <= 0 && alive < ... && !this.bossActive())   // ← true again after the kill
```

So beating the final boss resumed wave spawning forever. Added `EV.GAME_WON` + a `runOver` flag
that permanently closes the gate.

## The loss: the player could die and the run just continued

`killEntity()` in `combat.js` is generic, so I put the defeat emit there. **It was unreachable dead
code.** `player.js:hurt()` sets `p.hp = 0; p.alive = false;` *itself* and plays the death
animation — so by the time `applyDamage()` evaluates its guard:

```
if (target.hp <= 0 && target.alive) killEntity(target, pos);   // alive is ALREADY false
```

…`killEntity` never runs for the player at all. I only found this by **dying on purpose and
watching `GAME_LOST` never fire.** Moved the emit into `hurt()` at the real death site, and left a
note in `combat.js` explaining why it is deliberately not there.

## What shipped

- `EV.GAME_WON` / `EV.GAME_LOST` in `core/events.js`
- `director.js`: victory emit with run stats + `runOver` gate
- `player.js:hurt()`: defeat emit at the real death site
- `ui/endscreen.js` (new): full-screen gothic plate, both states, run stats, `R` to restart
- `ui/hud.css`: end-screen styling — gold rules, no rounded card, transform/opacity only
- `game/enemies.js`: **display names for all four archetypes** (only the boss had one)

Verified by playing:

| path | result |
|---|---|
| boss killed | *"THE SUNDER IS BROKEN / VICTORY / Ordolth, the Sundered lies dead on the arena floor"* — 5 kills, level 5, 1146 xp, 3 waves, 0:49 |
| player killed | *"THE DARK TAKES YOU / YOU DIED / slain by a Gnawing Wretch"* — stats shown |
| `R` from either | full reload → hp 1200/1200, kills 0, level 1, 30 monsters, end screen gone |

## Three of my own errors this session, and one bad diagnosis

**1. I broke the boot and blamed the wrong thing for four calls.** Deleting a duplicated `let`
declaration, my `DEL 28` removed `let widgets = []` instead of the duplicate line. The game threw
`ReferenceError: widgets is not defined` and showed "BOOT FAILED — SEE CONSOLE".

I then spent four tool calls diagnosing a frozen `World.time` as **background-tab rAF throttling**,
citing pin 4 of my own capture protocol. That was wrong: rAF was firing 146 frames/1.2s with
`document.hidden === false`. **The clock was frozen because the engine never started, because the
HUD threw during init.** I had the evidence to rule out my hypothesis in the same call I proposed it
(`rafFrames: 146` and `worldTime: 0` side by side) and read past it. **A frozen simulation with a
healthy rAF is an init failure, not a throttling one** — the console would have said so immediately.

**2. My first boss test used the wrong coordinate.** I teleported to `(99, 0)` — my *camera
station* — and reported "boss didn't spawn". The arena's actual anchor is `spawns[0]` at
`(86.9, 0)`, centre `(98.8, 0)` radius 25.2. My probe then printed `cx`/`cz` for every room, which
don't exist (rooms use `center`), so the table showed `0,0` for all seven and I nearly concluded the
level data was broken.

**3. `killer` reported "the dark" for every death** because I invented `opts.sourceName` /
`opts.attackerName`. `combat.js` passes `{ type, crit, source }` where `source` is the attacker
**entity** — the name comes off `source._brain.beh.name`. Then that returned `"swarm"`, the raw
archetype id, because only the boss had a `name` field. Two fixes, both found by reading the actual
payload instead of guessing its shape.

**The pattern in all three:** I asserted a mechanism (throttling, coordinates, option field names)
without checking the one source that would have settled it — the console, the level data, the call
site. Each cost several calls. The same failure I spent the previous round documenting in others.


## Two more bugs found by playing the ending, one of them a real UX defect

**1. `R` restarts the run — and `R` is also Void Beam's skill key.** My scripted playthrough killed
the boss, the victory screen appeared, and the very next rotation press was `r`, which reloaded the
page before the screen could be read. **A player mashing skills at the moment of victory would
restart the run they just won.** Fixed with a 900ms arm delay on the end screen's key handler: long
enough that the keypress must be deliberate, short enough to never feel unresponsive.

Worth noting how I nearly misdiagnosed this. When `__ENGINE` came back undefined mid-fight I
hypothesised that **writing `MEASUREMENT_NOTES.md` and `STATE.md` inside the Vite-watched project
root was triggering a full reload.** I tested it — set a `window.__marker`, appended a byte to
`STATE.md` from bash, re-read the marker — and **it survived. Refuted.** The cause was my own `r`
keypress. Cheap test, and it stopped me from "fixing" a non-problem in the build config.

**2. The dungeon is not straight-line traversable, and my walk test got lucky once.** A first run
walked from spawn (0,0) all the way to the arena at (98.8, 0) on WASD alone. A second identical run
**stalled permanently at x=56.8** — 150 seconds of held keys, zero movement. Diagnosis:

```
walkableHere: true    walkableAhead: false    stagger: 0.18    vel: 0
```

The player was pressed flat against a wall while enemy hits kept re-applying stagger. The straight
line from spawn to arena crosses dungeon geometry; the first run happened to drift around it. **A
single successful traversal is not evidence that a path exists** — I reported "walked the whole way
from spawn, no teleports" off one sample, and the second sample contradicted it.

## Verified end-to-end

| check | result |
|---|---|
| boss fight | 2600 hp → dead, real clicks and skills |
| victory screen | 18 kills, level 6, 4 waves, 5:33 |
| **spawning after victory** | **wave stayed 4, monsters stayed 12 across 20s** — the original bug is fixed |
| defeat screen | "slain by a Gnawing Wretch" with stats |
| `R` restart | hp 1200/1200, kills 0, level 1, 30 monsters, end screen gone |
| JS errors | 0 across every path |


# Centring, an FPS meter, and a performance pass — with the instrument finally under control

## 1. The character was off-centre for two separate reasons

**`cam.lookAt(target)` aimed at a cursor-biased point**, so any non-zero `lookAhead` pushed the
character off-centre by that fraction of the cursor distance. And **`cam.position.lerp(desired,
1 - exp(-6.5·dt))` let the camera lag while walking** — a first-order lag settles at `v/k`, so at
`moveSpeed 5.1` and `k = 6.5` the camera sat a steady **~0.78 world units behind** the player the
whole time he moved. Not a transient: a permanent offset in the direction of travel.

Both removed. The follow point *is* the player, the camera is placed rigidly at `follow + offset`,
and shake is applied to position only so an impact jolts the view without moving the look target.
Rigid is safe because `p.pos` is already smoothed by the acceleration/friction integrator — the
damping was buying nothing and costing centring.

**Verified, projecting the player to screen space:**

| condition | screen pos | offset from centre |
|---|---|---|
| standing still | (800, 450) | **(0, 0)** |
| moving, vel 5.1 | (800, 450) | **(0, 0)** |
| cursor at far corner | (800, 450) | **(0, 0)** |

## 2. FPS meter (`ui/fpsmeter.js`)

`clock.fps` already existed but only behind the F3 overlay. Now always visible top-left with **fps,
frame time in ms, and a 1% low** over a 120-frame window — an average alone hides exactly the hitching
that makes a game feel bad. Colour-coded at 55 / 30. Live reading: *"26 FPS · 37.8ms · 1% low 10"*.

## 3. Performance — and the run where every number was garbage

**First profiling pass was worthless and I caught it only because I re-measured the baseline at the
end:** it read **10.6 fps at the start and 34.8 with everything restored**. The fps drifted upward
monotonically through the whole run (shader compilation / JIT settling), so every "delta" was
warmup. It produced beautiful, entirely fictional numbers: shadows +69.8%, godray +230%, monsters
+274%.

Redone with **warmup passes first, then A-B-A per leg**, trusting a delta only when the two A
readings agree within 5%:

| lever | A1 | B | A2 | drift | real gain |
|---|---|---|---|---|---|
| shadowMap OFF | 34.8 | 37.0 | 34.6 | 0.6% | **+6.6%** |
| godray OFF | 33.6 | 34.7 | 34.8 | 3.5% | +1.5% |
| 20 monsters hidden | 34.8 | 39.6 | 35.0 | 0.6% | **+13.5%** |
| enemy shadows OFF | 34.4 | 36.6 | 34.8 | 1.2% | **+5.8%** |
| shadow casters 6→2 | 34.8 | 41.4 | 34.9 | 0.3% | **+18.8%** |
| shadowmap 512→256 | 29.1 | 26.9 | 34.6 | **17.3%** | *rejected* |

The last row is why the design matters: disposing shadow maps forces a rebuild that polluted its own
A2, and the "−15.5%" is meaningless. **A leg that fails its own drift check gets thrown away, not
reported.**

### The actual bottleneck, found by hooking the render loop

My earlier reads of `renderer.info` returned `calls: 1` because I sampled *outside* the render loop.
Hooking `R.render` and sampling after each call:

```
renderCallsPerFrame  3481
trianglesPerFrame    6,160,228
visible scene tris     512,410      ← a 12× multiplier
```

**Shadow passes redraw the scene ~11 extra times.** A point-light shadow is a **cube — six render
passes** — while the CSM sun is three cascades. With `shadowLights: 3`, the braziers were **18 of the
frame's 21 shadow passes.** Cost is almost perfectly linear at ~1.9 fps per caster:

| point casters | fps |
|---|---|
| 3 (shipped) | 35.1 |
| 2 | 36.3 |
| 1 | **38.6** |
| 0 | 40.8 |
| 3 (return leg) | 34.9 ← 0.6% drift, so the sweep is clean |

**Shipped `shadowLights: 3 → 1` (+10%)** and **`castShadow = false` on enemy skinned meshes
(+5.8%)** — they are 33% of scene triangles (169,280 of 512,410 across 31 meshes) and every shadow
pass re-skins all of them. Kept one brazier caster rather than zero: +16.5% was available but deletes
every point-light contact shadow, and *"objects read as pasted onto the floor"* is the defect two
blind judges named.

## 4. Traversal: the map was never the problem

The user reported the character can't traverse the map, and I had hit the same thing (stuck at
x=56.8). Two flood fills from spawn over the walkable grid:

| test | cells reached |
|---|---|
| point test, 1.0 step | 4153 / 4155 — **100%** |
| **radius-aware (0.42 capsule, 8-sample ring), 0.5 step** | **15063 / 15063 — 100%** |

**The level is fully connected for the player's actual collision volume.** `cistern` and `collapsed`
room *centres* are blocked by design (flooded / rubble). Collision response is also correct — holding
`S` at the stuck spot moved **dx +0.11, dz +3.5**, i.e. it slid along the blocking wall exactly as
`moveCapsule`'s per-axis retry intends.

**My own stuck test was the bug.** I held `w` and `d`, and `W` moves **−x** while the arena is at
**+x = 98.8** — I was walking away from the goal into the wall behind me. My "walkableAhead" probe
also sampled `x + 3`, a direction the keys were never sending me.

**The real defect was wayfinding:** the minimap has `REVEAL_RADIUS = 17`, so with seven rooms and no
marker there is nothing to tell you which way the boss is. Added `ui/objective.js` — a compass arrow
at the bottom of the screen pointing at the arena with a live distance, rotating in **screen** space
so it agrees with the WASD basis (a world-space arrow would point somewhere the keys don't go). It
hides itself once you're inside the arena or the run ends. Verified: reads *"THE SUNDER 94m"* at
spawn rotated 128.7°, against a hand calculation of `atan2(73.4, −66.1) = 132°`.

## The lesson, third time this session

Every wrong conclusion here came from an **uncontrolled variable between A/B legs** — monster count
drift, warmup drift, a self-polluting shadow-map rebuild, and a direction I never actually tested.
Pinning the roster took the noise floor from **±14% to ±0.4%**. The fix each time was not a better
metric but a better *experimental design*: warm up, interleave, re-measure the baseline, and discard
any leg whose control readings disagree.


## The traversal fix: a compass that points along the PATH, not at the goal

Pointing an arrow at the arena was not enough, and measuring *why* gave the real answer. From the
spot a goal-bearing follower stalls at, (56.8, 4.8):

| | |
|---|---|
| straight line to arena | 42.3 units |
| **true walkable path** | **48.0 units** |
| detour ratio | **1.14** |
| max deviation from the straight line | **3.3 units** |

The path is *almost* straight — but it runs down a corridor at **z≈1**, and standing at z=4.8 you must
move **−z about 4 units BEFORE going +x**. An arrow aimed at the goal points **+x into a wall** there.
**That is the entire "cannot traverse the map" report:** the level is fully connected (radius-aware
flood fill reaches 15063/15063 clear cells) and the guidance was aiming into geometry.

So `ui/objective.js` now builds a **flow field once** — BFS outward from the arena over the
radius-aware clearance grid, 1u cells, at level load, since the level is static at seed 1337 — and the
arrow points **downhill on that field**, i.e. along a route the player can actually walk. The distance
shown is the **path** distance, not the straight line, because "25m" while you are the wrong side of a
wall is misleading exactly where a player is most likely to be lost.

**Verified by following the compass alone**, reading the arrow's SVG rotation and pressing the matching
WASD keys: **from spawn (0,0) to (72.8, −0.5), closing 72.9 of 98.8 units and reaching the boss trigger
radius** — walking straight past x=56.8, the spot where the goal-bearing version stalled twice.

### Final state, all verified in one frame

| | |
|---|---|
| centring | **offX 0, offY 0** — still, moving at 5.1, and with the cursor in the far corner |
| fps meter | "34 FPS · 29.6ms · 1% low 28" |
| objective | "THE SUNDER 25m" (path distance) |
| shadow casters | **4** (3 CSM cascades + 1 brazier), enemy casters 0 |
| steady fps | **34**, up from 14.6 |
| 1% low | **28** against 34 average — up from 10, so the frame pacing is far tighter |
| JS errors | 0 |


# "Where the fuck is the character" — he was centred and buried behind a wall

The user's screenshot showed no character anywhere, while my projection test kept reporting
**offX 0, offY 0**. Both were true, and reconciling them was the whole job.

## The centring was never wrong; the occlusion was

Checks that ruled out the obvious causes, at the user's own 1568×1015 (aspect 1.545, NOT 16:9 —
every previous test of mine had been 16:9):

```
window            1568x1015   aspect 1.545
canvas CSS        1568x1015   left 0  top 0     ← fills the window exactly
canvas attrs      1568x1015
camera.aspect     1.545                          ← matches
renderer size     1568x1015   pixelRatio 1
player projects   (784, 508)  = the window centre exactly
```

So no letterbox, no aspect mismatch, no canvas offset. Then the decisive test: **hide all 268
non-player meshes and screenshot.** The character appeared at the exact centre — arms, legs, boots,
sword, shield, green eye glow. **He was centred the whole time and level geometry was drawn on top
of him.**

An occlusion oracle — read the centre pixel with the world drawn, then with only the player drawn,
and compare — found it at **1 of 9 sampled positions**, and that position was **(56.8, 4.8), exactly
where the user's screenshot was taken.**

## Why hiding the wall was not an option

The level bakes each kit piece into **one merged mesh**: `kit-wallAshlar` is a single
41,052-triangle object spanning the whole dungeon. There is no per-wall object to hide and no
per-wall material to fade — hiding it would delete every wall in the level.

So `render/cutaway.js` injects a **dithered-discard cutaway** into every kit material. In view space
the camera is the origin; a fragment is occluding if it is closer than the player *and* within a
radius of the camera-to-player axis. Those fragments `discard` with a 4×4 Bayer dither, so the edge
is a soft fade. **Discard, not alpha** — the material stays opaque, so no transparency sorting, no
blend cost, no depth-prepass interaction.

**Radius swept on-frame at the user's position:**

| radius | result |
|---|---|
| 1.55 | hole too small — only a sliver of shield rim |
| **2.60** | **head, shoulders, chest glow, sword arm all readable** |
| 3.60 | **WORSE** — hole grows past the figure and cuts the wall *behind* him, removing the dark backdrop he reads against |

That last row is the useful one: **bigger is not monotonically better**, because the cutaway must
expose the character without deleting his silhouette contrast.

**And it is a net performance WIN.** A-B-A with the roster pinned at 30: disabling the cutaway
*costs* **9% fps** (28.9 vs ~31.8, drift 1.6%) — discarded fragments skip all PBR lighting work.

## The rim light needed a second sweep for dark pockets

Cutting the wall revealed **darkness** — (56.8, 4.8) is unlit, so the hole alone did not help. My
earlier sweep had optimised the rim on a *lit* floor, where 10 was the knee. Re-swept in the pocket:

| rim | result |
|---|---|
| 10 | faint silhouette edge only |
| **30** | **helmet, shoulder, arm, sword all read clearly** |
| 70 | washes out — helmet becomes a featureless bright blob |

Rim cost is **+0.2% fps** (drift 0.3%), i.e. free. The 5u range means it lifts the actor, not the
room, so it does not re-introduce the ambient-fill defect.

## Cursor-driven discovery: my first design was a measured no-op

The request was that cursor movement help discover the map. The minimap revealed fog only around the
player at `REVEAL_RADIUS = 17`. My first implementation revealed **at** the cursor's ground point —
and measuring it showed **zero fog cleared.**

The reason is geometric and I would never have guessed it:

| cursor screen position | ground point distance from player |
|---|---|
| screen centre | 0.7 |
| +200px horizontal | 2.5 |
| +430px (screen edge) | **5.1** |
| corner (300, 300) | **7.5** |

**At distance 21 with fov 30, the cursor's ground point never gets more than ~7.5 units from the
player — the player's own reveal radius is 17.** Revealing at the cursor is *always strictly inside*
what he already reveals. It could never expose anything new.

Fixed by treating the cursor as a **direction** and scouting along it to `SCOUT_DISTANCE = 27`, so
sweeping the mouse sweeps a revealed annulus *beyond* the player's own radius, at 0.55× his reveal
size (looking hints, walking maps).

**Verified with the player pinned and only the mouse moving: fog 81.5% → 63.5%, an 18-point reveal.**
During live play while walking: **93.5% → 63.1%, 30.4 points.**

## One self-inflicted false alarm

Mid-session a screenshot came back with white untextured floors and magenta blobs — the classic
shader-compile-failure look. I nearly reverted the cutaway. The console showed **no shader errors**,
and the materials all still had `map`, `normalMap` and `__cutPatched`. **The broken frame was
accumulated state in a tab where I had hidden 268 meshes for the occlusion oracle and restored them
imperfectly.** A fresh tab rendered correctly. **Test scaffolding that mutates the scene must be run
in a tab you then throw away.**

## Final state

| | |
|---|---|
| centring | **offX 0, offY 0** — 85 consecutive samples while walking |
| character visible through walls | yes, dithered cutaway at radius 2.6 |
| fps meter | "37 FPS · 27.3ms · 1% low 10" |
| cursor scouting | 30.4 points of fog revealed during a walk |
| cutaway cost | **−9% if disabled** (it is a win) |
| rim light cost | +0.2% (free) |
| JS errors | 0 |


# The centring bug was devicePixelRatio, and every test I ran was blind to it

The user said the character sat in the bottom-right by the mana orb. I repeatedly measured
**offX 0, offY 0** and said it was centred. **They were right and my instrument was wrong.**

**`engine.js` called `renderer.setSize(w, h, false)`.** That third argument is `updateStyle`;
`false` means Three.js sets the canvas `width`/`height` **attributes** to `w * pixelRatio` but never
sets a CSS size. A canvas's attributes are its **intrinsic size**, and `position:fixed; inset:0` does
**not** override intrinsic size for a replaced element. So at `devicePixelRatio 2` the canvas was
*displayed* at its backing-store size — twice the window — and only its top-left quarter was visible.

Reproduced the moment I opened a tab at `deviceScaleFactor: 2`:

```
devicePixelRatio      2
window                1568 x 1015
canvas attributes     3136 x 2030      correct backing store
canvas CLIENT size    3136 x 2030      WRONG — must equal the CSS window size
player renders at     (1568, 1015)     the bottom-right corner — beside the mana orb
offset from centre    (784, 508)       exactly half the window, both axes
```

**Every centring test I had run used `deviceScaleFactor: 1`**, where attribute size and CSS size
coincide and the bug cannot appear. My projection maths was correct *in canvas space* the whole time;
canvas space and screen space had simply stopped being the same thing. **"Centred in the canvas" is
not the claim the user made, and I never checked the one that mattered.**

Fixed at both ends: `setSize(w, h, true)`, an explicit `canvas.style.width/height` in `resize()`, and
`width:100%; height:100%` on `#viewport` in the HTML so the intrinsic size can never apply even before
the first resize.

**Verified at DPR 2:** backing store 1568×1015, client 1568×1015, `offX 0, offY 0` standing still,
moving, and with the cursor in the far corner.

## And it was most of the "lag" too

At DPR 2 we were rasterising 6.4M pixels — 4× the work. Pixel-ratio sweep, roster pinned at 30,
A-B-A (return leg 11.4 vs 11.5, 0.9% drift):

| pixelRatio | backing store | fps |
|---|---|---|
| 2 | 3136×2030 | **11.5** |
| 1.5 | 2352×1522 | 19.5 (+70%) |
| 1 | 1568×1015 | **39.3 (+242%)** |

Client size stayed 1568×1015 at every ratio, so **centring is independent of the cap** — only
sharpness changes. Shipped `maxPixelRatio: 1`: performance was raised as a complaint twice and
sharpness never once. **Live, unpinned, 30 monsters: 10 → 39 fps, 1% low 28.**

## The lesson

Three tests said "centred": a projection to canvas space, a crop of the canvas centre, and an
occlusion oracle reading the canvas centre pixel. **All three shared the same wrong assumption** —
that canvas coordinates equal screen coordinates. Agreement between three instruments that share an
assumption is not corroboration; it is the same measurement taken three times.

**The user's screenshot was the only ground truth in the room, and I argued with it for two rounds.**


# Performance round: 24-30 fps -> 101 fps exploration, pixel-identical

The ask was 60 fps minimum, 100 preferred, with NO loss of quality, features or visuals.

## What the frame was actually spending

Profiled per-system inside the engine loop, then split scene vs post, then split
per-pixel vs fixed. Every number rAF-clocked at 1440x900.

    all 14 systems' JS (frame+fixed)     0.45 ms   <- AI 0.13, HUD 0.14
    whole post chain (5 passes)          1.47 ms
    RenderPass (the scene)              14.08 ms
    harness ceiling (bare rAF)           8.00 ms

So JS was irrelevant and the post stack was nearly free. Resolution scaling gave the
decisive split -- ms fitted against s^2:

    scale 1.00 / 0.75 / 0.50 / 0.35  ->  22.08 / 14.25 / 8.26 / 8.12 ms
    fit: 16.72 ms per-pixel, 5.09 ms fixed   => FRAGMENT-BOUND

## The lever: 47 PointLights, most contributing exactly nothing

Three.js forward-renders, unrolling every visible PointLight into every lit fragment.
Cost tracks the light COUNT, not screen coverage:

    visible point lights   47    24    16    12     9
    frame (ms)          35.46 13.00  9.94  9.91  8.38

A PointLight with decay=2 and finite `distance = d` attenuates by
`pow(saturate(1 - pow(dist/d,4)),2) / max(dist^2,eps)` -- **exactly zero** past d. So a
light whose influence sphere misses the frustum cannot change any pixel. At spawn, 14 of
23 live lights were in that category: `skylight-arena` has reach 28.1 and sat 98.3 world
units away; a brazier with reach 7.0 sat 31.6 away.

Verified rather than argued. Engine frozen, `World.time` pinned, same frame rendered both
ways, PNGs decoded and compared byte-for-byte -- at all SEVEN rooms:

    entry nave crypt cistern courtyard collapsed arena
    0 differing pixels of 1,296,000 each.  9,072,000 total.  max channel delta 0/255.

Shipped result, rAF-clocked A-B-A with the roster pinned:

    cull OFF  42.1 fps  23.75 ms   (23 lights)
    cull ON  101.7 fps   9.83 ms   (12 lights, 9 in frustum)   2.42x, -13.92 ms

## Quality went UP, not down

`QUALITY = { level: 'medium' }` was shipped last round from SwiftShader numbers, and
`medium` DISABLES GTAO and the contact-AO term -- ambient occlusion was absent from the
shipped game. Restored to `ultra`:

    medium (no AO)  120.1 fps      ultra (AO on)  109.0 fps
    AO costs 0.84 ms against a 13.92 ms saving. Ultra is now 2.3x faster than medium was.

## Five things I got wrong, and what disproved each

**1. "Shadows are the cost."** `shadowMap.autoUpdate = false` measured +3.8%, which looked
real until I counted render calls: `renderCallsPerFrame: 20` in BOTH legs. The ablation
was a no-op (Three.js renders shadows inside `renderer.render`), so +3.8% was noise.

**2. "Merged level-spanning geometry is the cost."** `kit-wallAshlar` is one
41,052-triangle mesh spanning 126.5 x 91.6 -- the whole dungeon, so its bounding box always
intersects the frustum and `frustumCulled` does nothing. Hiding it saved **-0.36 ms**.
All five level-spanning meshes together: **-0.31 ms**. Chunking them would have gained
nothing. (Hiding all 140 opaque meshes saves 12.87 ms; the cost is per-pixel lighting,
not geometry.)

**3. "Transparent overdraw is the cost."** 476 of 625 materials are transparent with
depthWrite:false. Hiding ALL of them: 1.67 ms. Hiding the 112 at opacity 0.00: **-0.08 ms**.

**4. "A depth prepass will pay."** Overdraw measured 2.32x by additive-blend fragment
counting, and the prepass reported 46.7 -> 120 fps, saving 12.48 ms -- MORE than the
theoretical maximum for 2.32x on a 12.87 ms pass. The pixel diff caught it: 90.7% of pixels
differed and the entire dungeon was gone. I had rendered depth to the CANVAS while the
composer's RenderPass renders into its OWN framebuffer with freshly-cleared depth, so
`EqualDepth` rejected every fragment. The "win" was an empty screen. Done correctly into
the composer's buffer it LOSES 1.63 ms -- 149 extra draw calls cost more than 2.32x
overdraw saves on a CPU rasteriser.

**5. "Rung changes are expensive, so add hysteresis."** I asserted this and never measured
it. A direct test cycled 64 rung changes in 64 consecutive frames: 30.7 ms worst frame,
zero frames over 50 ms. Holding the rung was actively harmful -- combat spikes arrive faster
than any hold expires, so it PINNED the expensive rung:

    5 rungs, no hold    mean 60.6 fps   dropped 29
    5 rungs, hold 45    mean 52.2 fps   dropped 287
    7 rungs, hold 45    mean 29.4 fps   dropped 0
    4 rungs, hold 20    page hung outright
    2 rungs, hold 20    page hung outright

## Two real bugs found while chasing stalls

**`PCFSoftShadowMap` is deprecated in three 0.185.** `WebGLShadowMap.render()` warns,
silently rewrites `type` to `PCFShadowMap`, AND -- because the shadow sampler type changes --
walks the whole scene setting `material.needsUpdate` on EVERY material. So asking for
PCFSoft bought exactly PCF plus a guaranteed full-scene recompile. Caught with a setter
tripwire installed on `shadowMap.type` before boot; the single write recorded was
`from 2 to 1` inside `WebGLShadowMap.render`, called from my own prewarm. Boot programs
358 -> 296.

**My own culler rendered frames at un-prewarmed light counts.** Parked pool slots
(intensity ~0) still count toward Three.js's light total, and I was skipping them without
touching `visible`. Measured over 227 combat frames: 4 rendered at 25, 24 and 32 lights
instead of the chosen rung, and those frames cost up to 433 ms each. Fixed by making the
cull own parked slots too; `stats.offRung` now asserts it, and reads 0.

## Why the count is quantised at all

Three.js keys its program cache on the light count, so a free-running exact cull walks the
count continuously and recompiles every material at each new value. Measured over a
12-second walk: programs 66 -> 254, **worst frame 4,295 ms, mean 1.1 fps**. Prewarming
every count 0..32 costs 11.2 s and 1,531 programs, so that is out. Five rungs
[12,16,20,24,28,34] are prewarmed at boot in ~0.9 s; padding uses out-of-frustum lights,
which contribute zero, so a padded frame is still pixel-identical.

Ceiling: raising the top rung 28 -> 34 was measured, not assumed, and it went the opposite
way to my prediction --

    ceiling 28   mean 45.5 fps   p50 46.9   p90 26.7   dropped 305
    ceiling 34   mean 64.6 fps   p50 75.2   p90 50.3   dropped 0

-- because the 34 rung is reached in only 45 of 2326 frames, while a 28 ceiling drops real
lights on every heavy frame.

## An instrument that produced a plausible false answer twice

Timing `pipeline.render()` in a tight synchronous loop on a frozen scene reported **6.26 ms
for a frame that measures 21 ms under rAF**, and made culling look 4% SLOWER. Adding
`gl.finish()` did not fix it -- SwiftShader's worker threads finish after the call returns.
Any conclusion from that timer is void, including a "forceSinglePass saves 0.55 ms"
reading. Only rAF-clocked numbers are used above.

## What is honestly not fixed

Combat p90/p99 still fall below 60 fps HERE: 26-50 fps p90 depending on how many lights
the fight genuinely puts in frustum (peak demand 31). That is not a defect in the cull --
`droppedInFrustum` is 0 -- it is the cost of shading 20-34 lights per pixel.

The per-light cost is **100% fragment work**, which is the load-bearing fact for real
hardware. Measured by re-running the light sweep at quarter pixels:

    ms per light at full res   0.585
    ms per light at 1/4 pixels 0.087        (fixed CPU component: -0.079, i.e. zero)

A CPU rasteriser pays full price for exactly the work a GPU does in parallel across
hundreds of cores. These numbers are a floor, not a forecast.

First-fight program growth is also real and bounded: fight 1 compiles ~91 programs
(worst frame 365 ms), fight 2 compiles 5. A warm-up, not a leak. Forcing every mesh
visible during prewarm to link them early did NOT help (143 vs 91) and was reverted.


## Two further fixes the cull exposed

**The brazier pool was ranking by distance to CAMERA, ignoring the frustum.** An isometric
follow-cam sits ~21 world units behind and above the player, so a brazier BEHIND the camera
is routinely nearer to it than one the player is walking toward. Those won pool slots and
lit nothing on screen. Measured at all 7 room centres by projecting every emissive flame
instance and asking whether any live PointLight sat within 3 world units:

    before   entry 4 of 4 on-screen flames unlit   nave 3 of 3 unlit   total 7 of 19
    after    0 of 19 unlit, in every room

Fix: rank in-frustum sources above out-of-frustum, then by distance. Same 12 slots, spent
on braziers you can actually see. This is a VISUAL improvement, and it also stops the cull
wasting rung capacity on lights it will immediately discard. Runs at reassignHz 8, so the
added frustum test is negligible.

**The prewarm was warming the wrong colour space.** `outputColorSpace` is part of Three.js's
program cache key and differs by render TARGET: the canvas is `srgb`, the composer's
intermediate targets are `srgb-linear`. prewarm() called `renderer.render(scene, camera)`
straight to the canvas, so every material was compiled for a colour space the game never
renders in, and the real program still compiled on first sight in play.

Found by diffing cache keys FIELD BY FIELD after a fight (the same technique that caught the
shadow bug): of 135 fresh keys, 12 differed only at field 2 — `srgb` vs `srgb-linear` — and
80 only at field 40, the point-light count. Routing prewarm through `World.pipeline.render()`:

    first-fight program growth  183 -> 45      worst frame  427 ms -> 186 ms
    boot programs               296 -> 431     boot prewarm 0.83 s -> 2.13 s (behind curtain)

Second fight compiles 6 programs, so the remainder is genuinely one-time warm-up.

## Shipped state

    src/render/lightcull.js   new — frustum cull + prewarmed rung ladder [12,16,20,24,28,34]
    src/core/config.js        graphics.lightCull: true; QUALITY 'medium' -> 'ultra'
    src/core/engine.js        PCFSoftShadowMap -> PCFShadowMap (deprecated; forced a recompile)
    src/world/props.js        brazier pool ranks in-frustum first
    src/ui/debug.js           F3 shows `lights shown/inFrustum @rung` and `lights dropped`
    src/main.js               registers lightcull LAST; prewarms rungs at boot

Verified on the shipped tree, rAF-clocked, real keyboard/mouse input:

    exploration   111.9 fps mean   p50 111   p90 107   p99 94   worst 21.3 ms
    cull A-B-A     42.1 -> 101.7 fps (2.42x, -13.92 ms), return drift 15.9% vs 122% effect
    losslessness   0 differing pixels of 9,072,000 across all 7 rooms
    integrity      droppedInFrustum 0, offRung 0, 0 JS errors, ultra + AO on

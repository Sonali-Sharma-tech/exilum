# Archetype silhouette — measurement method and findings

Rubric §5 requires a player to identify the threat type **at a glance, without
reading a health bar**. Three separate blind judges called our enemies
"identical", "anatomically vague", or "identical smooth shapes", so this needed a
real instrument rather than an opinion.

## The measurement, and two wrong versions of it first

**Wrong attempt 1 — bind-pose probe.** A cancelled agent measured the bind-pose
silhouette and reported swarm at aspect 0.95, near-square and widest at the top —
the opposite of its "low, scuttling" spec. That finding was misleading: `lean` is
applied **at runtime in the facing frame** (`enemygen.js` sets `built.lean` and
applies it per-frame), not baked into the mesh. So the probe could not see a 0.36
rad forward pitch that genuinely exists in play.

**Wrong attempt 2 — screen projection of a world AABB.** I projected the 8 corners
of each creature's world-space bounding box and took the screen bbox. That returned
1253×1555 px for a single swarm on a 1280×720 viewport. Projecting the corners of
an axis-aligned box wildly overestimates extent when the box is near the camera;
the world box itself was correct at 2.07 × 1.87 × 1.73.

**Wrong attempt 3 — uncontrolled pose.** Projecting actual skinned vertices gave
plausible numbers, but re-running after editing only the *swarm* rig changed
**every** archetype's numbers (caster 0.59→1.18, brute 0.92→1.37). The creatures
were captured at different facings and different points in their animation cycles,
so the instrument was measuring **pose**, not proportion.

**The controlled version.** Force identical facing (`e.facing = 0`,
`root.rotation.y = 0`), disable the AI so nothing re-faces, pin every mixer to the
same clip time (`_play('idle', 0)` then `mixer.setTime(0.5)`), and measure the
**local-space** vertex extents rather than screen space. Proportion is then the
only variable, and camera position cannot contaminate the result.

## Findings (controlled, local space)

| archetype | footprint aspect | localH | massBot | massTop | reads as |
|---|---|---|---|---|---|
| swarm | **1.69** | 1.24 | 0.28 | 0.51 | wide, low — ground-hugging scuttler |
| caster | **0.61** | 2.71 | 0.32 | 0.39 | tall, narrow |
| brute | 0.86 | **3.22** | 0.11 | **0.59** | tallest and widest, top-heavy |
| exploder | 1.18 | 1.46 | 0.19 | 0.48 | squat, round |

`footprintAspect = max(localW, localD) / localH`.

**No two archetypes share a footprint aspect**, and the spread is 0.61 → 1.69,
which is wide enough to read at pixel scale.

## The fix that was applied

The real collision was **swarm against brute at aspect 0.91 / 0.92** — they
differed only in *size*, not proportion, so at gameplay pixel scale they read as
the same shape scaled. Note this contradicts the cancelled agent's claim that swarm
confused with the *exploder*; that was an artefact of its bind-pose measurement.

The swarm rig was pushed genuinely horizontal rather than merely small:

```
hipY   0.44 → 0.34    lower to the ground
legLen 0.52 → 0.40    shorter legs
armLen 0.80 → 1.02    longer arms, reaching forward
hunch  1.15 → 1.55    deeper forward curl
splay  1.05 → 1.35    wider stance
footZ  0.22 → 0.30    feet further forward
```

Result: footprint aspect 1.69, the widest of any archetype and clearly separated
from brute's 0.86. Skin weights verified at **zero unnormalised** after the change.

## Standing rule

Measure proportion in the creature's **own local frame with pose and facing
pinned**. Screen-space measurement is only valid for answering "is it big enough to
see" — never for "is its shape distinct", because camera angle, animation phase and
distance all leak into the number and will move when you change something
unrelated.

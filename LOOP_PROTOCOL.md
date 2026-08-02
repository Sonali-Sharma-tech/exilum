# The critique loop — how EXILIUM converges on AAA

The user's requirement: *"a separate sub-agent should check it visually... a really
harsh critic, and if it doesn't look triple A, it should keep going... don't stop
until each sub-agent is utterly wowed... it should literally compare them side by
side blind and say which one looks better."*

This file is the operational spec for that loop. It exists so each round is
identical in method and the scores are therefore comparable across rounds.

## Roles

- **Implementers** (14 agents, one per subsystem) — write code. They never score
  their own work; self-assessment is the failure mode this whole loop exists to
  prevent.
- **Critics** — hostile art directors. They receive frames + objective metrics +
  `POE2_RUBRIC.md` and return a strict JSON verdict per `CRITIC_PROTOCOL.md`.
  They never write code, so they have no sunk cost in the implementation.
- **Blind judge** — receives a 2-up sheet with panels labelled only `A` and `B`,
  one ours and one real PoE2, WITHOUT being told which is which, and must say
  which reads as the commercial product. This is the user's explicit bar.
- **Main** — orchestrates, captures frames, runs metrics, aggregates verdicts,
  dispatches fixers. Does not score.

## One round

1. **Capture.** `tools/capture.js` through the `browser` tool. Fixed scenario set
   (establishing / materials close-up / combat / ui) at 1920x1080. Framings are
   identical every round — otherwise round-to-round score deltas measure camera
   choice, not quality.
2. **Measure.** `node tools/analyze.mjs shots/<frame>.png` per frame. Objective
   numbers: luminance percentiles, contrast ratio, saturation band, shadow hue
   angle, local contrast, spatial variation, hard-edge ratio.
   Critics get these alongside the image because *a critic looking only at an
   image will rationalise* — it will call a crushed frame "moody" and an
   oversaturated one "rich". Numbers do not rationalise.
3. **Critique.** Fan out one critic per rubric domain, in parallel. Each returns
   the JSON in `CRITIC_PROTOCOL.md`: per-category 0-100 scores with **pixel-cited
   evidence**, active auto-fails, exactly three highest-leverage fixes, verdict.
4. **Blind compare.** `node tools/blind-compare.mjs --a ours.png --b poe2.png
   --out shots/blind.png --key shots/blind.key.json --seed <n>`. The tool
   normalises both images to identical dimensions (so resolution cannot decide
   the outcome), places them behind a neutral grey gutter, and writes the
   A/B assignment to a *separate key file* the judge never sees. Judge returns
   which panel is the commercial product and what gave it away.
5. **Aggregate.** Union every auto-fail and every fix across all critics. Rank by
   `impact / effort`. Auto-fails always outrank score-improvements — a single
   active auto-fail caps a category at 40 and no amount of polish elsewhere
   compensates.
6. **Dispatch fixers.** One agent per owned file, in parallel, each given the
   verbatim critic evidence for its subsystem. Fixers get the *evidence*, not a
   paraphrase, so they cannot argue with a summary.
7. **Repeat** from 1.

## Exit condition

The loop terminates only when ALL of:

- Weighted rubric total >= **85** ("shippable AAA — a player would not question
  it") on the establishing frame.
- **Zero active auto-fails** across every frame.
- No single category below **75** (a 95 in lighting does not excuse a 45 in
  materials; the eye finds the weakest element).
- Blind judge either picks ours as the commercial product, or explicitly states
  it could not reliably tell them apart.
- No console errors, and 60fps sustained at 1920x1080.

## Anti-patterns this loop is designed to prevent

- **Score inflation to end the loop.** An inflated score ships a worse game.
  `CRITIC_PROTOCOL.md` instructs critics to start from "this is a 55 and the
  burden of proof is on the pixels". Critics who cannot cite a pixel location for
  a deduction are not doing their job; critics who cannot cite one for a *credit*
  are inflating.
- **Fixing what is cheap instead of what is broken.** Ranking by impact/effort
  with auto-fails first prevents polishing a already-good subsystem while an
  auto-fail stands.
- **Losing ground.** Every round captures the same framings and keeps the
  previous round's shots, so a regression is visible rather than argued about.
- **Judging our own work.** Implementers never score. Critics never implement.

## Honest limitation, recorded up front

A blind comparison against real PoE2 imagery requires real PoE2 imagery. If
`refs/REFERENCE.md` reports that no genuine screenshots could be obtained, then
step 4 cannot run as specified, and that must be stated plainly in the final
report rather than substituted with a comparison against something else and
described as if it were the real thing. The rubric-based critique (steps 1-3)
still runs and still has teeth; the blind test simply cannot be claimed.

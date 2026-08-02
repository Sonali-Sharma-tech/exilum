import { bus, EV } from './events.js';
// Fixed-step simulation + interpolated render, with impact hitstop.
//
// HITSTOP MUST BE DEADLINED IN REAL TIME, NOT SIM TIME.
//
// The freeze works by scaling simulation time down to FROZEN_SCALE. If the deadline is
// also expressed in sim time, the two multiply: sim only advances at 6% of wall speed, so
// a 62 ms freeze takes 62/0.06 = 1033 ms of real time to elapse. Measured on the old
// code, requesting each duration and timing the real gap until the clock unfroze:
//
//     requested   30 ms ->  496 ms real   (16.5x)
//     requested   62 ms ->  963 ms real   (15.5x)
//     requested  124 ms -> 2082 ms real   (16.8x)
//     requested  210 ms -> 3473 ms real   (16.5x)   <- Ground Slam crit
//
// i.e. exactly 1/FROZEN_SCALE. Every single hit bought roughly a second of 6%-speed
// slow-motion, and an AoE crit nearly three and a half seconds. That is the "time
// dilation" — not frame rate. The deadline now lives on `performance.now()`, which the
// freeze cannot dilate, so 62 ms means 62 ms.
const FROZEN_SCALE = 0.14;   // sim speed during hitstop — a punch, not a stall
const DEFAULT_MS = 60;

// FREEZE BUDGET (leaky bucket). Caps the share of REAL time hitstop may consume.
//
// Hitstop is emitted per impact, and enemy hits emit it too. Measured standing in a pack
// of 12 with NO player input: 31 freezes in 8 s (3.9/sec), 12.4% duty cycle. Add the
// player's own attacks and it climbs further. Individually each freeze is correct; in
// aggregate the game stops responding for an eighth of every second.
//
// The bucket refills at MAX_DUTY of real time and holds at most BURST, so:
//   - an isolated heavy hit always lands at full strength (the bucket is full)
//   - a sustained swarm degrades gracefully — freezes get shortened, not dropped
//   - the worst case is bounded at MAX_DUTY, by construction rather than by tuning
const MAX_DUTY = 0.07;       // <=7% of real time may be frozen
const BURST = 0.075;         // s of freeze bankable, so one full slam always reads
const MIN_GRANT = 0.006;     // s — below this the freeze cannot span a frame; skip it

export class Clock {
  constructor(step = 1 / 60) {
    this.step = step; this.acc = 0; this.last = performance.now() / 1000;
    this.elapsed = 0; this.frame = 0; this.dtRaw = 0; this.alpha = 0;
    this.timeScale = 1; this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
    // Real-time deadline, in the same clock as `performance.now() / 1000`.
    this.hitstopRealUntil = 0;
    // Kept for anything reading it; expressed in real seconds now.
    this.hitstopUntil = 0;
    this._budget = BURST;          // s of freeze available
    this.hitstopStats = { requested: 0, granted: 0, clipped: 0, skipped: 0 };
    bus.on(EV.HITSTOP, (ms = DEFAULT_MS) => {
      const want = Math.max(0, (+ms || 0) / 1000);
      this.hitstopStats.requested += want;
      const now = performance.now() / 1000;
      // Time already promised by a freeze in flight. It was ALREADY paid for out of the
      // bucket, so it must never be re-banked — an earlier version set the deadline to
      // `now + pending + grant`, which re-added it on every chained hit and produced a
      // 254 ms freeze against a 75 ms cap (measured 21.9% duty cycle where the grants
      // totalled only 4%). Extending from the EXISTING deadline is what makes the bucket
      // an actual bound: total frozen time can never exceed total granted time.
      const pending = Math.max(0, this.hitstopRealUntil - now);
      // A shorter request adds nothing when a longer freeze is already in flight.
      const extra = Math.max(0, want - pending);
      if (extra <= 0) return;
      const grant = Math.min(extra, this._budget);
      // Below one frame at any plausible rate the freeze cannot be seen, only felt as a
      // dropped frame — so it is skipped rather than spent.
      if (grant < MIN_GRANT) { this.hitstopStats.skipped += extra; return; }
      if (grant < extra) this.hitstopStats.clipped += extra - grant;
      this._budget -= grant;
      this.hitstopStats.granted += grant;
      this.hitstopRealUntil = Math.max(this.hitstopRealUntil, now) + grant;
      this.hitstopUntil = this.hitstopRealUntil;
    });
  }
  tick(onFixed) {
    const nowMs = performance.now();
    const now = nowMs / 1000;
    let dt = Math.min(now - this.last, 0.1); this.last = now; this.dtRaw = dt;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc > 0.5) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }
    // Refill the freeze bucket from REAL elapsed time, so the cap is a true duty cycle
    // and cannot be gamed by frame rate.
    this._budget = Math.min(BURST, this._budget + dt * MAX_DUTY);
    const frozen = now < this.hitstopRealUntil;
    const scale = frozen ? FROZEN_SCALE : this.timeScale;
    this.acc += dt * scale;
    let guard = 0;
    while (this.acc >= this.step && guard++ < 5) { this.elapsed += this.step; onFixed(this.step, this.elapsed); this.acc -= this.step; }
    this.alpha = this.acc / this.step; this.frame++;
    return dt * scale;
  }
  /** True while an impact freeze is in force. */
  get frozen() { return (performance.now() / 1000) < this.hitstopRealUntil; }
}

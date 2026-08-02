import { bus, EV } from './events.js';
// Fixed-step simulation + interpolated render. Hitstop scales sim time, not wall time.
export class Clock {
  constructor(step = 1 / 60) {
    this.step = step; this.acc = 0; this.last = performance.now() / 1000;
    this.elapsed = 0; this.frame = 0; this.dtRaw = 0; this.alpha = 0;
    this.timeScale = 1; this.hitstopUntil = 0; this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
    bus.on(EV.HITSTOP, (ms = CFGMS) => { this.hitstopUntil = Math.max(this.hitstopUntil, this.elapsed + ms / 1000); });
  }
  tick(onFixed) {
    const now = performance.now() / 1000;
    let dt = Math.min(now - this.last, 0.1); this.last = now; this.dtRaw = dt;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc > 0.5) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }
    const frozen = this.elapsed < this.hitstopUntil;
    const scale = frozen ? 0.06 : this.timeScale;   // near-freeze on impact
    this.acc += dt * scale;
    let guard = 0;
    while (this.acc >= this.step && guard++ < 5) { this.elapsed += this.step; onFixed(this.step, this.elapsed); this.acc -= this.step; }
    this.alpha = this.acc / this.step; this.frame++;
    return dt * scale;
  }
}
const CFGMS = 60;

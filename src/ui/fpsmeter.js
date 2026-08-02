// fpsmeter.js — always-visible frame counter, top-left.
//
// `clock.fps` already existed but was only surfaced behind the F3 debug overlay, so the
// number you need most while judging whether the game feels smooth was the one you had to
// go looking for.
//
// Shows fps AND frame time in ms, because they answer different questions: fps tells you the
// average, ms tells you the budget (16.7ms = 60, 33.3 = 30). It also tracks a 1-percent-low
// over a rolling window — a run that averages 40fps with 12fps lows feels far worse than a
// steady 30, and an average alone hides exactly that.
//
// Colour-coded against the two thresholds that matter perceptually: 55+ reads smooth, 30-55
// reads playable, under 30 reads like a slideshow.
import { el } from './theme.js';

const WINDOW = 120;          // frames retained for the 1% low

export class FpsMeter {
  constructor(root) {
    this.node = el('div', null, root);
    this.node.id = 'fpsmeter';
    this.main = el('span', 'fm-main', this.node);
    this.sub = el('span', 'fm-sub', this.node);
    this.samples = new Float32Array(WINDOW);
    this.n = 0;
    this.acc = 0;
    this.shownFps = -1;
    this.shownLow = -1;
  }

  frame(dt, ctx) {
    // Raw dt is the true frame interval; clock.fps is a 0.5s average of the same thing.
    if (dt > 0) {
      this.samples[this.n % WINDOW] = dt;
      this.n++;
    }
    this.acc += dt;
    if (this.acc < 0.25) return;              // repaint 4x/sec, not every frame
    this.acc = 0;

    const count = Math.min(this.n, WINDOW);
    if (!count) return;
    let sum = 0;
    for (let i = 0; i < count; i++) sum += this.samples[i];
    const meanDt = sum / count;
    const fps = 1 / Math.max(meanDt, 1e-6);

    // 1% low = the slowest 1% of frames, expressed as fps. Sort a copy of the window.
    const arr = Array.prototype.slice.call(this.samples, 0, count).sort((a, b) => b - a);
    const k = Math.max(1, Math.round(count * 0.01));
    let worst = 0;
    for (let i = 0; i < k; i++) worst += arr[i];
    const low = 1 / Math.max(worst / k, 1e-6);

    const fpsR = Math.round(fps);
    const lowR = Math.round(low);
    if (fpsR === this.shownFps && lowR === this.shownLow) return;   // no DOM write if unchanged
    this.shownFps = fpsR; this.shownLow = lowR;

    this.main.textContent = `${fpsR} FPS`;
    this.sub.textContent = `${(meanDt * 1000).toFixed(1)}ms · 1% low ${lowR}`;
    const cls = fpsR >= 55 ? 'fm-good' : (fpsR >= 30 ? 'fm-ok' : 'fm-bad');
    if (this.node.className !== cls) this.node.className = cls;
  }
}

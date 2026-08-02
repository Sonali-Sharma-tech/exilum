// EXILIUM — WebAudio synthesis toolkit.
// Pure, stateless DSP builders + a Voice/VoicePool abstraction so SFX never
// allocate the expensive persistent graph (panner/filter/shaper/amp/send/convolver)
// mid-combat. One-shot source nodes (oscillators, buffer sources) are unavoidable
// in WebAudio — they cannot be restarted once stopped — but they are cheap; the
// pool recycles everything else and disconnects finished sources via `onended`.

const TAU = Math.PI * 2;
const EPS = 1e-4; // exponentialRamp targets must be non-zero

// ---------------------------------------------------------------------------
// Noise buffers — generated once, replayed through fresh (cheap) buffer sources.
// ---------------------------------------------------------------------------

/** White / pink / brown noise. Pink via Paul Kellet's refined filter; brown via
 *  leaky integration. Returns a mono AudioBuffer of `seconds` length. */
export function makeNoiseBuffer(ac, type = 'white', seconds = 2.4) {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else { // brown
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Convolution reverb impulse response — procedurally generated, no files.
// Exponentially-decaying, band-shaped stereo noise for a large stone cathedral:
// a short early-reflection cluster, a long dark diffuse tail, LF-weighted.
// ---------------------------------------------------------------------------

export function makeImpulseResponse(ac, opts = {}) {
  const seconds = opts.seconds ?? 3.6;
  const decay = opts.decay ?? 4.2;      // higher = faster falloff
  const preDelay = opts.preDelay ?? 0.012;
  const sr = ac.sampleRate;
  const n = Math.floor(sr * seconds);
  const pre = Math.floor(sr * preDelay);
  const ir = ac.createBuffer(2, n, sr);
  // Early-reflection taps (metres-ish -> seconds) give the "big room" cue.
  const taps = [0.011, 0.019, 0.031, 0.047, 0.063, 0.089, 0.113];
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // One-pole low-pass state to darken the tail (stone absorbs highs).
    let lp = 0;
    for (let i = 0; i < n; i++) {
      if (i < pre) { d[i] = 0; continue; }
      const x = (i - pre) / (n - pre);
      const env = Math.pow(1 - x, decay);
      let s = (Math.random() * 2 - 1) * env;
      lp += (s - lp) * 0.34;           // darken
      d[i] = lp;
    }
    // Stamp discrete early reflections on top for spatial definition.
    for (let ti = 0; ti < taps.length; ti++) {
      const idx = pre + Math.floor(taps[ti] * sr) + (ch ? 7 : 0);
      if (idx < n) d[idx] += (1 - ti / taps.length) * 0.6 * (Math.random() * 0.4 + 0.8);
    }
  }
  return ir;
}

// ---------------------------------------------------------------------------
// Waveshaper curves. Cached by the caller (built once, reused across voices).
// ---------------------------------------------------------------------------

/** Soft-clipping tanh-ish distortion. `amount` 0..1 drives harmonics. */
export function makeDistortionCurve(amount = 0.6, n = 2048) {
  const k = amount * 100 + 0.001;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); // rational soft clip
  }
  return c;
}

/** Bit-depth reduction via quantised transfer curve (a real bitcrusher stage;
 *  sample-rate crushing would need an AudioWorklet — bit crush is the audible
 *  half and needs no worklet). `bits` e.g. 4..8. */
export function makeBitcrushCurve(bits = 5, n = 4096) {
  const levels = Math.pow(2, bits);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

/** Transparent output ceiling: unity/linear up to `knee`, then a smooth tanh
 *  saturation that asymptotes just below `ceil` so the signal can NEVER reach
 *  digital clip (±1). Placed AFTER the limiter it only shapes the rare peaks the
 *  compressor let through — normal-level audio passes untouched, no distortion. */
export function makeCeilingCurve(knee = 0.7, ceil = 0.985, n = 8192) {
  const c = new Float32Array(n);
  const range = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x), s = Math.sign(x);
    c[i] = a <= knee ? x : s * (knee + range * Math.tanh((a - knee) / range));
  }
  return c;
}

// ---------------------------------------------------------------------------
// Envelope helpers — schedule directly on AudioParams (audio-thread accurate).
// ---------------------------------------------------------------------------

const clampPos = (v) => (v > EPS ? v : EPS);

/** Percussive AD(S)R on a gain-like param: attack->peak, decay->sustain,
 *  optional hold, release->silence. `sustain`=0 gives a pure percussive shape
 *  (decay does the work, release is a short tail). Exponential ramps throughout.
 *  Returns the time at which the tail has effectively ended. */
export function ampEnv(param, t0, { a = 0.005, d = 0.08, s = 0.0, sustain = 0, r = 0.12, peak = 1 } = {}) {
  const sus = sustain > 0 ? sustain : EPS;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  param.exponentialRampToValueAtTime(clampPos(peak), t0 + a);
  param.exponentialRampToValueAtTime(sus, t0 + a + d);
  const holdEnd = t0 + a + d + s;
  if (s > 0) param.setValueAtTime(sus, holdEnd);
  param.exponentialRampToValueAtTime(EPS, holdEnd + r);
  return holdEnd + r;
}
// ---------------------------------------------------------------------------
// Source factory helpers. Create + return; caller connects to voice.input.
// ---------------------------------------------------------------------------

export function osc(ac, type, freq, t) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  return o;
}

export function noiseSrc(ac, buffer, { loop = false, rate = 1 } = {}) {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = loop;
  s.playbackRate.value = rate;
  return s;
}

// ---------------------------------------------------------------------------
// Voice — one reusable positional synthesis slot.
// input -> filter -> shaper -> amp -> {panner->dry | dry} , amp -> send -> reverb
// ---------------------------------------------------------------------------

export class Voice {
  constructor(ac, dryOut, reverbIn) {
    this.ac = ac;
    this.input = ac.createGain();
    this.filter = ac.createBiquadFilter();
    this.shaper = ac.createWaveShaper();
    this.amp = ac.createGain();
    this.panner = ac.createPanner();
    this.send = ac.createGain();

    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 6;
    this.panner.maxDistance = 130;
    this.panner.rolloffFactor = 0.9;
    this.panner.coneInnerAngle = 360;

    this.input.connect(this.filter);
    this.filter.connect(this.shaper);
    this.shaper.connect(this.amp);
    this.amp.connect(this.send);
    this.send.connect(reverbIn);
    this.panner.connect(dryOut);

    this._dryOut = dryOut;
    this._dryRoute = null;     // 'panner' | 'bus' | null
    this.sources = [];
    this.active = false;
    this.startTime = -1;
    this.endTime = -1;
    this.priority = 0;
    this.reset(0);
  }

  reset(t) {
    this.filter.type = 'lowpass';
    this.filter.frequency.cancelScheduledValues(t);
    this.filter.frequency.setValueAtTime(20000, t);
    this.filter.Q.cancelScheduledValues(t);
    this.filter.Q.setValueAtTime(0.7, t);
    this.filter.gain.setValueAtTime(0, t);
    this.shaper.curve = null;           // clean passthrough
    this.shaper.oversample = 'none';
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setValueAtTime(1, t);
    this.send.gain.cancelScheduledValues(t);
    this.send.gain.setValueAtTime(0, t);
    this.input.gain.setValueAtTime(1, t);
  }

  routeDry(positional) {
    const want = positional ? 'panner' : 'bus';
    if (this._dryRoute === want) return;
    if (this._dryRoute === 'panner') { try { this.amp.disconnect(this.panner); } catch { /* not connected */ } }
    else if (this._dryRoute === 'bus') { try { this.amp.disconnect(this._dryOut); } catch { /* not connected */ } }
    if (want === 'panner') this.amp.connect(this.panner);
    else this.amp.connect(this._dryOut);
    this._dryRoute = want;
  }

  setPosition(x, y, z) {
    const p = this.panner;
    if (p.positionX) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else {
      p.setPosition(x, y, z); // legacy fallback
    }
  }

  /** Track a one-shot source so it can be stopped on steal and disconnected on
   *  end. `chain` = extra per-layer nodes (gains/filters/oscillators) to release
   *  when this source finishes, so nothing accumulates on the reused voice. */
  add(src, ...chain) {
    this.sources.push(src);
    src.onended = () => {
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
      try { src.disconnect(); } catch { /* already gone */ }
      for (const nn of chain) { try { nn.disconnect(); } catch { /* already gone */ } }
    };
    return src;
  }

  /** Kill immediately (voice stealing). */
  stopNow() {
    const t = this.ac.currentTime;
    for (const s of this.sources) { try { s.stop(t); } catch { /* not started */ } }
    this.active = false;
  }
}

// ---------------------------------------------------------------------------
// VoicePool — hard cap, oldest-stealing, lazy reclamation. Zero persistent-node
// allocation after construction.
// ---------------------------------------------------------------------------

export class VoicePool {
  constructor(ac, cap, dryOut, reverbIn) {
    this.ac = ac;
    this.voices = [];
    for (let i = 0; i < cap; i++) this.voices.push(new Voice(ac, dryOut, reverbIn));
  }

  /** Get a voice for a sound of `dur` seconds starting at `t`. */
  acquire(t, dur, positional = true, priority = 0) {
    let free = null, oldest = null;
    for (const v of this.voices) {
      if (!v.active || v.endTime <= t) { free = v; break; }
      if (!oldest || v.startTime < oldest.startTime) oldest = v;
    }
    let v = free;
    if (!v) {
      // steal the lowest-priority, then oldest, voice.
      let victim = oldest;
      for (const c of this.voices) {
        if (c.priority < victim.priority ||
           (c.priority === victim.priority && c.startTime < victim.startTime)) victim = c;
      }
      victim.stopNow();
      v = victim;
    }
    v.reset(t);
    v.active = true;
    v.startTime = t;
    v.endTime = t + dur;
    v.priority = priority;
    v.routeDry(positional);
    return v;
  }
}

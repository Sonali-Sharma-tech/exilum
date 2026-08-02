// EXILIUM — adaptive music bed + layered ambience. Fully synthesized, never
// loops audibly: persistent detuning drones + a lookahead-scheduled sparse
// minor motif + slow parameter drift. State (calm/combat/boss) crossfades on
// per-layer gain via setTargetAtTime, never hard switches.

import { osc, noiseSrc } from './synth.js';

const MINOR_PENTA = [0, 3, 5, 7, 10, 12, 15]; // dark, sparse
const ROOT = 55;                               // A1 tonic

const semi = (base, s) => base * Math.pow(2, s / 12);

// ---------------------------------------------------------------------------
// MusicBed — persistent layers whose gains crossfade with combat state.
// Layers: drone (root/fifth beating), strings (bowed saw stack), choir
// (formant-filtered noise), tension (combat pulse + minor drone), boss.
// ---------------------------------------------------------------------------

export class MusicBed {
  constructor(ac, busOut, reverbIn, noise) {
    this.ac = ac; this.bus = busOut; this.reverbIn = reverbIn; this.N = noise;
    this.layers = {};
    this.state = 'calm';
    this.nextMotif = 0;
    this.nextDrift = 0;
    this.persistent = [];
    this._built = false;
  }

  _layer(name, target) {
    const g = this.ac.createGain();
    g.gain.value = 0;
    g.connect(this.bus);
    this.layers[name] = { gain: g, target, cur: 0 };
    return g;
  }

  start() {
    if (this._built) return;
    this._built = true;
    const ac = this.ac, t = ac.currentTime;

    // --- drone: root + fifth + octave, slightly detuned, slow LFO beating ---
    const droneOut = this._layer('drone', { calm: 0.6, combat: 0.42, boss: 0.32 });
    const droneVerb = ac.createGain(); droneVerb.gain.value = 0.25; droneVerb.connect(this.reverbIn);
    droneOut.connect(droneVerb);
    const droneVoices = [
      { f: ROOT, type: 'sine', g: 0.5 },
      { f: ROOT * 1.5, type: 'sine', g: 0.3 },
      { f: ROOT * 2, type: 'triangle', g: 0.16 },
      { f: ROOT * 0.5, type: 'sine', g: 0.4 },
    ];
    for (const dv of droneVoices) {
      const o = osc(ac, dv.type, dv.f, t);
      const g = ac.createGain(); g.gain.value = dv.g;
      // slow detune LFO -> beating that never phase-aligns (irrational rate).
      const lfo = osc(ac, 'sine', 0.037 + Math.random() * 0.05, t);
      const lg = ac.createGain(); lg.gain.value = 3 + Math.random() * 4;
      lfo.connect(lg); lg.connect(o.detune);
      o.connect(g); g.connect(droneOut);
      o.start(t); lfo.start(t);
      this.persistent.push(o, lfo);
    }

    // --- strings: bowed saw stack through a slow lowpass swell ---
    const strOut = this._layer('strings', { calm: 0.12, combat: 0.4, boss: 0.5 });
    const strFilt = ac.createBiquadFilter(); strFilt.type = 'lowpass';
    strFilt.frequency.value = 700; strFilt.Q.value = 0.8;
    strFilt.connect(strOut);
    const strVerb = ac.createGain(); strVerb.gain.value = 0.4; strFilt.connect(strVerb); strVerb.connect(this.reverbIn);
    for (let i = 0; i < 5; i++) {
      const o = osc(ac, 'sawtooth', semi(ROOT * 2, [0, 3, 7, 10, 12][i]) * (1 + (Math.random() - 0.5) * 0.006), t);
      const g = ac.createGain(); g.gain.value = 0.08;
      const lfo = osc(ac, 'sine', 0.05 + i * 0.017, t); const lg = ac.createGain(); lg.gain.value = 4;
      lfo.connect(lg); lg.connect(o.detune);
      o.connect(g); g.connect(strFilt);
      o.start(t); lfo.start(t);
      this.persistent.push(o, lfo);
    }
    this.strFilt = strFilt;

    // --- choir: formant-filtered noise, distant, swelling ---
    const choirOut = this._layer('choir', { calm: 0.18, combat: 0.16, boss: 0.34 });
    const choirVerb = ac.createGain(); choirVerb.gain.value = 0.6; choirOut.connect(choirVerb); choirVerb.connect(this.reverbIn);
    const cn = noiseSrc(ac, this.N.pink, { loop: true });
    const choirSwell = ac.createGain(); choirSwell.gain.value = 0.5; choirSwell.connect(choirOut);
    const formants = [[400, 8], [800, 10], [2600, 12]]; // 'ah' vowel
    for (const [f, q] of formants) {
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const g = ac.createGain(); g.gain.value = 0.5;
      cn.connect(bp); bp.connect(g); g.connect(choirSwell);
    }
    // slow amplitude swell so the choir "breathes" (LFO + DC offset -> gain).
    const swell = osc(ac, 'sine', 0.06, t); const sg = ac.createGain(); sg.gain.value = 0.4;
    const swellBase = ac.createConstantSource(); swellBase.offset.value = 0.55;
    swell.connect(sg); sg.connect(choirSwell.gain); swellBase.connect(choirSwell.gain);
    cn.start(t); swell.start(t); swellBase.start(t);
    this.persistent.push(cn, swell, swellBase);

    // --- tension: combat-only low pulse + minor semitone rub ---
    const tenOut = this._layer('tension', { calm: 0, combat: 0.34, boss: 0.4 });
    const pulse = osc(ac, 'sine', ROOT * 0.5, t);
    const pulseGate = ac.createGain(); pulseGate.gain.value = 0;
    const heart = osc(ac, 'sine', 1.9, t); const hg = ac.createGain(); hg.gain.value = 0.5;
    const hbase = ac.createConstantSource(); hbase.offset.value = 0.28;
    heart.connect(hg); hg.connect(pulseGate.gain); hbase.connect(pulseGate.gain);
    pulse.connect(pulseGate); pulseGate.connect(tenOut);
    const rub = osc(ac, 'sawtooth', semi(ROOT * 2, 1), t); const rubG = ac.createGain(); rubG.gain.value = 0.06;
    rub.connect(rubG); rubG.connect(tenOut);
    pulse.start(t); heart.start(t); hbase.start(t); rub.start(t);
    this.persistent.push(pulse, heart, hbase, rub);
    this.heartRate = heart;

    // --- boss: driving detuned brass-ish saws + sub throb ---
    const bossOut = this._layer('boss', { calm: 0, combat: 0, boss: 0.5 });
    const bossFilt = ac.createBiquadFilter(); bossFilt.type = 'lowpass'; bossFilt.frequency.value = 900;
    bossFilt.connect(bossOut);
    for (let i = 0; i < 3; i++) {
      const o = osc(ac, 'sawtooth', semi(ROOT, [0, 0.06, -0.05][i] + [0, 7, 12][i]), t);
      const g = ac.createGain(); g.gain.value = 0.12;
      o.connect(g); g.connect(bossFilt); o.start(t);
      this.persistent.push(o);
    }
    const sub = osc(ac, 'sine', ROOT * 0.5, t); const subT = osc(ac, 'sine', 2.4, t);
    const subTg = ac.createGain(); subTg.gain.value = 0.4; const subBase = ac.createConstantSource(); subBase.offset.value = 0.4;
    const subGate = ac.createGain(); subGate.gain.value = 0;
    subT.connect(subTg); subTg.connect(subGate.gain); subBase.connect(subGate.gain);
    sub.connect(subGate); subGate.connect(bossFilt);
    sub.start(t); subT.start(t); subBase.start(t);
    this.persistent.push(sub, subT, subBase);

    this._applyState(t, 6);
  }

  setState(s) {
    this.state = s;
    if (this._built) this._applyState(this.ac.currentTime, 3.5);
  }

  _applyState(t, tc) {
    for (const k in this.layers) {
      const L = this.layers[k];
      L.gain.gain.cancelScheduledValues(t);
      L.gain.gain.setTargetAtTime(L.target[this.state] ?? 0, t, tc / 3);
    }
    // combat/boss drive the heartbeat faster + strings brighter.
    if (this.heartRate) {
      const hr = this.state === 'boss' ? 2.9 : this.state === 'combat' ? 2.1 : 1.2;
      this.heartRate.frequency.setTargetAtTime(hr, t, 2);
    }
    if (this.strFilt) {
      const co = this.state === 'boss' ? 1400 : this.state === 'combat' ? 1000 : 620;
      this.strFilt.frequency.setTargetAtTime(co, t, 3);
    }
  }

  /** Called each frame; cheap until a scheduled event is due. */
  tick(now) {
    if (!this._built) return;
    // Sparse minor motif — a lonely melodic line, denser in combat/boss.
    if (now >= this.nextMotif) {
      const gap = this.state === 'boss' ? 1.6 : this.state === 'combat' ? 2.6 : 4.5;
      this.nextMotif = now + gap + Math.random() * gap;
      if (this.state !== 'calm' || Math.random() < 0.7) this._motif(now + 0.05);
    }
    // Slow drift — nudge string detune + choir formant so it never repeats.
    if (now >= this.nextDrift) {
      this.nextDrift = now + 7 + Math.random() * 6;
      if (this.strFilt) this.strFilt.frequency.setTargetAtTime(500 + Math.random() * 900, now, 5);
    }
  }

  _motif(t) {
    const ac = this.ac;
    const oct = this.state === 'boss' ? 4 : 3;
    const s = MINOR_PENTA[(Math.random() * MINOR_PENTA.length) | 0];
    const f = semi(ROOT * oct, s);
    const o = osc(ac, this.state === 'boss' ? 'sawtooth' : 'triangle', f, t);
    const g = ac.createGain();
    const dur = 1.2 + Math.random() * 1.6;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(this.state === 'calm' ? 0.09 : 0.14, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const bp = ac.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 2200;
    o.connect(bp); bp.connect(g); g.connect(this.bus);
    const mv = ac.createGain(); mv.gain.value = 0.5; g.connect(mv); mv.connect(this.reverbIn);
    o.start(t); o.stop(t + dur + 0.05);
    o.onended = () => { try { o.disconnect(); bp.disconnect(); g.disconnect(); mv.disconnect(); } catch { /* gone */ } };
  }

  dispose() {
    for (const n of this.persistent) { try { n.stop(); } catch { /* not a source */ } try { n.disconnect(); } catch { /* gone */ } }
    this.persistent.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Ambience — continuous cathedral room tone + randomised, non-repeating events:
// water drips, distant rumbles, wind through stone, chain creaks, skittering.
// ---------------------------------------------------------------------------

export class Ambience {
  constructor(ac, busOut, reverbIn, noise) {
    this.ac = ac; this.bus = busOut; this.reverbIn = reverbIn; this.N = noise;
    this.persistent = [];
    this.events = []; // {next, fn}
    this._built = false;
  }

  start() {
    if (this._built) return;
    this._built = true;
    const ac = this.ac, t = ac.currentTime;

    // room tone: very low filtered brown noise, always present.
    const room = noiseSrc(ac, this.N.brown, { loop: true });
    const rf = ac.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 220; rf.Q.value = 0.6;
    const rg = ac.createGain(); rg.gain.value = 0.14;
    room.connect(rf); rf.connect(rg); rg.connect(this.bus);
    const rv = ac.createGain(); rv.gain.value = 0.5; rg.connect(rv); rv.connect(this.reverbIn);
    room.start(t);
    this.persistent.push(room);

    // wind through stone: band-passed pink noise with a slow swept resonance.
    const wind = noiseSrc(ac, this.N.pink, { loop: true });
    const wf = ac.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 500; wf.Q.value = 2.5;
    const wg = ac.createGain(); wg.gain.value = 0.08;
    const wl = osc(ac, 'sine', 0.05, t); const wlg = ac.createGain(); wlg.gain.value = 260;
    wl.connect(wlg); wlg.connect(wf.frequency);
    const wa = osc(ac, 'sine', 0.08, t); const wag = ac.createGain(); wag.gain.value = 0.05;
    const wab = ac.createConstantSource(); wab.offset.value = 0.07;
    wa.connect(wag); wag.connect(wg.gain); wab.connect(wg.gain);
    wind.connect(wf); wf.connect(wg); wg.connect(this.bus);
    const wv = ac.createGain(); wv.gain.value = 0.4; wg.connect(wv); wv.connect(this.reverbIn);
    wind.start(t); wl.start(t); wa.start(t); wab.start(t);
    this.persistent.push(wind, wl, wa, wab);

    // scheduled random one-shots.
    this.events = [
      { next: t + 1 + Math.random() * 3, gap: [2.5, 6], fn: (tt) => this._drip(tt) },
      { next: t + 6 + Math.random() * 10, gap: [12, 26], fn: (tt) => this._rumble(tt) },
      { next: t + 4 + Math.random() * 8, gap: [9, 20], fn: (tt) => this._creak(tt) },
      { next: t + 3 + Math.random() * 6, gap: [5, 14], fn: (tt) => this._skitter(tt) },
    ];
  }

  tick(now) {
    if (!this._built) return;
    for (const e of this.events) {
      if (now >= e.next) {
        e.fn(now + 0.03);
        e.next = now + e.gap[0] + Math.random() * (e.gap[1] - e.gap[0]);
      }
    }
  }

  _spatialGain(sendAmt) {
    // ambience one-shots get a random azimuth via cheap stereo pan + reverb.
    const g = this.ac.createGain();
    const pan = this.ac.createStereoPanner ? this.ac.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; g.connect(pan); pan.connect(this.bus); }
    else g.connect(this.bus);
    const rv = this.ac.createGain(); rv.gain.value = sendAmt; g.connect(rv); rv.connect(this.reverbIn);
    return { g, pan, rv };
  }

  _drip(t) {
    const ac = this.ac; const { g } = this._spatialGain(0.5);
    const o = osc(ac, 'sine', 900 + Math.random() * 700, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.09);
    const eg = ac.createGain();
    eg.gain.setValueAtTime(0.0001, t);
    eg.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
    eg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(eg); eg.connect(g);
    o.start(t); o.stop(t + 0.2);
    o.onended = () => { try { o.disconnect(); eg.disconnect(); g.disconnect(); } catch { /* gone */ } };
  }

  _rumble(t) {
    const ac = this.ac; const { g } = this._spatialGain(0.6);
    const n = noiseSrc(ac, this.N.brown, { rate: 0.4 + Math.random() * 0.3 });
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90;
    const eg = ac.createGain();
    const dur = 2 + Math.random() * 2;
    eg.gain.setValueAtTime(0.0001, t);
    eg.gain.exponentialRampToValueAtTime(0.3, t + dur * 0.4);
    eg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(lp); lp.connect(eg); eg.connect(g);
    n.start(t); n.stop(t + dur + 0.05);
    n.onended = () => { try { n.disconnect(); lp.disconnect(); eg.disconnect(); g.disconnect(); } catch { /* gone */ } };
  }

  _creak(t) {
    // chain/metal creak: pitch-wobbled ring-modded tone through a resonant BP.
    const ac = this.ac; const { g } = this._spatialGain(0.45);
    const o = osc(ac, 'sawtooth', 220 + Math.random() * 120, t);
    o.frequency.linearRampToValueAtTime(o.frequency.value * 1.4, t + 0.5);
    const wob = osc(ac, 'sine', 7 + Math.random() * 6, t); const wg = ac.createGain(); wg.gain.value = 14;
    wob.connect(wg); wg.connect(o.detune);
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 8;
    const eg = ac.createGain();
    eg.gain.setValueAtTime(0.0001, t);
    eg.gain.exponentialRampToValueAtTime(0.09, t + 0.15);
    eg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(bp); bp.connect(eg); eg.connect(g);
    o.start(t); o.stop(t + 0.75); wob.start(t); wob.stop(t + 0.75);
    o.onended = () => { try { o.disconnect(); wob.disconnect(); wg.disconnect(); bp.disconnect(); eg.disconnect(); g.disconnect(); } catch { /* gone */ } };
  }

  _skitter(t) {
    // rat/insect skittering: burst of tiny high filtered noise ticks.
    const ac = this.ac; const { g } = this._spatialGain(0.2);
    const count = 4 + ((Math.random() * 6) | 0);
    for (let i = 0; i < count; i++) {
      const tt = t + i * (0.03 + Math.random() * 0.04);
      const n = noiseSrc(ac, this.N.white, { rate: 1.2 });
      const hp = ac.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 4000 + Math.random() * 3000; hp.Q.value = 6;
      const eg = ac.createGain();
      eg.gain.setValueAtTime(0.0001, tt);
      eg.gain.exponentialRampToValueAtTime(0.06, tt + 0.002);
      eg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03);
      n.connect(hp); hp.connect(eg); eg.connect(g);
      n.start(tt); n.stop(tt + 0.05);
      n.onended = () => { try { n.disconnect(); hp.disconnect(); eg.disconnect(); } catch { /* gone */ } };
    }
    setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, (count * 0.08 + 0.2) * 1000);
  }

  dispose() {
    for (const n of this.persistent) { try { n.stop(); } catch { /* not a source */ } try { n.disconnect(); } catch { /* gone */ } }
    this.persistent.length = 0; this.events.length = 0;
  }
}

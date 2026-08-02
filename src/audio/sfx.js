// EXILIUM — SFX library. Every id is a *designed* sound (transient + body + tail),
// never a raw beep. Recipes are pure builders: they receive a play-context `c`
// { ac, v (Voice), t (start), N (noise buffers), C (waveshaper curves) }, spawn
// one-shot sources onto the reused voice graph, schedule envelopes on AudioParams,
// and return the sound's total duration in seconds so the pool can reclaim the voice.

import { osc, noiseSrc, ampEnv } from './synth.js';

// Vowel formant triples [F1,F2,F3] (Hz), lowered/shaped for monstrous timbres.
const FORMANT = {
  a: [720, 1180, 2600], o: [420, 820, 2400], u: [330, 720, 2180],
  e: [500, 1750, 2500], i: [380, 2150, 3100], growl: [260, 640, 1700],
};

// --- per-layer builders (create source + local chain, auto start/stop/cleanup) ---

function tone(c, type, f0, f1, amp, dur, dest) {
  const { ac, v, t } = c;
  const o = osc(ac, type, f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(2, f1), t + dur);
  const g = ac.createGain();
  ampEnv(g.gain, t, amp);
  o.connect(g); g.connect(dest || v.input);
  o.start(t); o.stop(t + dur + 0.02);
  v.add(o, g);
  return { o, g };
}

function noiseL(c, buf, ftype, f0, f1, q, amp, dur, dest) {
  const { ac, v, t } = c;
  const s = noiseSrc(ac, buf, { rate: 0.9 + Math.random() * 0.2 });
  const bp = ac.createBiquadFilter();
  bp.type = ftype; bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) bp.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ac.createGain();
  ampEnv(g.gain, t, amp);
  s.connect(bp); bp.connect(g); g.connect(dest || v.input);
  s.start(t); s.stop(t + dur + 0.02);
  v.add(s, bp, g);
  return { s, bp, g };
}

/** Bipolar ring modulation: signal * carrier. */
function ringMod(c, inputNode, carrierF, depth, dur, dest) {
  const { ac, v, t } = c;
  const ring = ac.createGain(); ring.gain.setValueAtTime(0, t);
  const carrier = osc(ac, 'sine', carrierF, t);
  const cg = ac.createGain(); cg.gain.value = depth;
  carrier.connect(cg); cg.connect(ring.gain);
  inputNode.connect(ring); ring.connect(dest || v.input);
  carrier.start(t); carrier.stop(t + dur + 0.02);
  v.add(carrier, cg, ring);
  return ring;
}

/** Formant-filtered source -> 3 parallel bandpass throats. Returns the created
 *  nodes (out gain + 3 bandpass/gain pairs) so the CALLER attaches them to the
 *  source's cleanup chain via `v.add(src, ...throat(...))` — nothing lingers on
 *  the reused voice. */
function throat(c, srcNode, vowel, dur, dest) {
  const { ac, v, t } = c; const F = FORMANT[vowel] || FORMANT.o;
  const out = ac.createGain();
  ampEnv(out.gain, t, { a: 0.02, d: dur * 0.4, s: dur * 0.4, r: dur * 0.3, peak: 1, sustain: 0.7 });
  out.connect(dest || v.input);
  const nodes = [out];
  for (let i = 0; i < 3; i++) {
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = F[i]; bp.Q.value = 9 - i * 2.5;
    const g = ac.createGain(); g.gain.value = [1, 0.55, 0.28][i];
    srcNode.connect(bp); bp.connect(g); g.connect(out);
    nodes.push(bp, g);
  }
  return nodes;
}

const verb = (c, amt) => c.v.send.gain.setValueAtTime(amt, c.t);
const shape = (c, curve, over = '2x') => { c.v.shaper.curve = curve; c.v.shaper.oversample = over; };

// ===========================================================================
// Registry — id -> recipe(c) => duration. Metadata (positional/priority/base
// gain trim) lives in META below; audio.js reads both.
// ===========================================================================

export const SFX = {
  // ---- weapon swings: layered filtered-noise sweep with a moving bandpass ----
  swing(c) {
    const dur = 0.34;
    noiseL(c, c.N.white, 'bandpass', 900, 4200, 1.2, { a: 0.02, d: 0.06, s: 0.05, r: 0.14, peak: 0.5 }, dur);
    noiseL(c, c.N.pink, 'highpass', 600, 2600, 0.7, { a: 0.03, d: 0.05, s: 0.04, r: 0.12, peak: 0.3 }, dur);
    verb(c, 0.06);
    return dur + 0.05;
  },

  // ---- melee impacts: <10ms transient + material body + tail (rubric §7) -----
  impact_flesh(c) {
    // wet slap: HP noise click transient, low sine body drop, damped mid thud.
    noiseL(c, c.N.white, 'highpass', 3200, 1400, 0.6, { a: 0.001, d: 0.03, r: 0.02, peak: 0.55 }, 0.06);
    tone(c, 'sine', 150, 60, { a: 0.002, d: 0.11, r: 0.05, peak: 0.9 }, 0.18);
    noiseL(c, c.N.brown, 'lowpass', 700, 240, 1.1, { a: 0.003, d: 0.09, r: 0.05, peak: 0.5 }, 0.16);
    verb(c, 0.1);
    return 0.24;
  },
  impact_stone(c) {
    // sharp click transient + resonant stone body + short grit tail.
    noiseL(c, c.N.white, 'highpass', 5200, 2600, 0.5, { a: 0.0008, d: 0.02, r: 0.015, peak: 0.7 }, 0.04);
    noiseL(c, c.N.white, 'bandpass', 620, 520, 7, { a: 0.001, d: 0.12, r: 0.06, peak: 0.6 }, 0.2);
    tone(c, 'triangle', 340, 190, { a: 0.001, d: 0.08, r: 0.04, peak: 0.4 }, 0.14);
    verb(c, 0.22);
    return 0.26;
  },
  impact_metal(c) {
    // bright click + inharmonic ring (detuned partials) + ring-modded shimmer.
    noiseL(c, c.N.white, 'highpass', 6000, 3200, 0.4, { a: 0.0006, d: 0.02, r: 0.02, peak: 0.7 }, 0.05);
    const parts = [523, 781, 1244, 1893];
    for (const f of parts) tone(c, 'sine', f * (0.99 + Math.random() * 0.02), f, { a: 0.001, d: 0.5, r: 0.35, peak: 0.22 }, 0.85);
    const buzz = tone(c, 'sine', 1600, 1500, { a: 0.001, d: 0.4, r: 0.3, peak: 0.18 }, 0.7);
    ringMod(c, buzz.g, 137, 1, 0.7);
    verb(c, 0.3);
    return 0.9;
  },

  // ---- spell casts per element ------------------------------------------------
  cast_fire(c) {
    const dur = 0.7;
    shape(c, c.C.soft);
    // low roar + crackle bursts + rising whoosh.
    tone(c, 'sawtooth', 70, 130, { a: 0.03, d: 0.2, s: 0.25, r: 0.2, peak: 0.4, sustain: 0.3 }, dur);
    noiseL(c, c.N.brown, 'lowpass', 500, 900, 0.8, { a: 0.05, d: 0.2, s: 0.2, r: 0.2, peak: 0.5, sustain: 0.35 }, dur);
    for (let i = 0; i < 7; i++) {
      const ct = { ...c, t: c.t + Math.random() * 0.45 };
      noiseL(ct, c.N.white, 'bandpass', 1800 + Math.random() * 2200, null, 6, { a: 0.001, d: 0.03, r: 0.02, peak: 0.28 }, 0.05);
    }
    verb(c, 0.28);
    return dur + 0.1;
  },
  cast_cold(c) {
    const dur = 0.8;
    // detuning bell cluster + airy shimmer + ring-mod glisten.
    const base = 660;
    for (let i = 0; i < 4; i++) {
      const l = tone(c, 'sine', base * (i + 1) * (0.5 + i * 0.5), base * (i + 1) * (0.5 + i * 0.5) * 1.02,
        { a: 0.04, d: 0.4, s: 0.2, r: 0.3, peak: 0.2 / (i + 1), sustain: 0.12 / (i + 1) }, dur);
      if (i === 1) ringMod(c, l.g, 23, 0.6, dur);
    }
    noiseL(c, c.N.white, 'highpass', 6000, 9000, 0.6, { a: 0.06, d: 0.3, s: 0.2, r: 0.3, peak: 0.16, sustain: 0.1 }, dur);
    verb(c, 0.4);
    return dur + 0.1;
  },
  cast_lightning(c) {
    const dur = 0.45;
    shape(c, c.C.dist);
    // instant broadband crack + electric buzz (distorted saw + ring mod) + tail.
    noiseL(c, c.N.white, 'highpass', 2000, 400, 0.3, { a: 0.0005, d: 0.05, r: 0.05, peak: 0.85 }, 0.12);
    const buzz = tone(c, 'sawtooth', 900, 620, { a: 0.002, d: 0.2, s: 0.05, r: 0.15, peak: 0.35 }, dur);
    ringMod(c, buzz.g, 90, 1, dur);
    noiseL(c, c.N.white, 'bandpass', 3800, 5200, 5, { a: 0.001, d: 0.18, r: 0.1, peak: 0.3 }, 0.3);
    verb(c, 0.34);
    return dur + 0.05;
  },
  cast_chaos(c) {
    const dur = 0.75;
    shape(c, c.C.crush);
    // wet hiss (LFO-swept bandpass) + bubbling random blips + detuned wet drone.
    const s = noiseSrc(c.ac, c.N.pink, { loop: true });
    const bp = c.ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
    const lfo = osc(c.ac, 'sine', 5.5, c.t); const lg = c.ac.createGain(); lg.gain.value = 1400;
    bp.frequency.setValueAtTime(1800, c.t); lfo.connect(lg); lg.connect(bp.frequency);
    const g = c.ac.createGain(); ampEnv(g.gain, c.t, { a: 0.05, d: 0.3, s: 0.2, r: 0.25, peak: 0.4, sustain: 0.25 });
    s.connect(bp); bp.connect(g); g.connect(c.v.input);
    s.start(c.t); s.stop(c.t + dur + 0.02); lfo.start(c.t); lfo.stop(c.t + dur + 0.02);
    c.v.add(s, bp, g, lfo, lg);
    for (let i = 0; i < 5; i++) {
      const ct = { ...c, t: c.t + Math.random() * 0.55 };
      tone(ct, 'square', 200 + Math.random() * 900, 120, { a: 0.002, d: 0.05, r: 0.03, peak: 0.18 }, 0.08);
    }
    verb(c, 0.32);
    return dur + 0.1;
  },
  cast_generic(c) {
    // neutral arcane cast: rising filtered saw swell + airy shimmer.
    const dur = 0.5;
    tone(c, 'sawtooth', 160, 480, { a: 0.02, d: 0.18, s: 0.08, r: 0.15, peak: 0.32 }, dur);
    noiseL(c, c.N.white, 'bandpass', 2400, 4800, 3, { a: 0.03, d: 0.14, r: 0.15, peak: 0.2 }, dur);
    tone(c, 'sine', 520, 780, { a: 0.02, d: 0.16, r: 0.12, peak: 0.14 }, dur);
    verb(c, 0.3);
    return dur + 0.05;
  },

  // ---- projectiles ------------------------------------------------------------
  proj_launch(c) {
    const dur = 0.3;
    tone(c, 'sawtooth', 420, 140, { a: 0.004, d: 0.12, r: 0.1, peak: 0.35 }, dur);
    noiseL(c, c.N.pink, 'bandpass', 1600, 500, 1.4, { a: 0.005, d: 0.1, r: 0.09, peak: 0.3 }, dur);
    verb(c, 0.12);
    return dur + 0.05;
  },
  proj_impact(c) {
    noiseL(c, c.N.white, 'highpass', 4000, 1800, 0.6, { a: 0.001, d: 0.04, r: 0.03, peak: 0.6 }, 0.08);
    tone(c, 'sine', 220, 90, { a: 0.002, d: 0.1, r: 0.05, peak: 0.6 }, 0.16);
    verb(c, 0.2);
    return 0.22;
  },

  // ---- enemy vocalisations (formant-filtered per archetype) -------------------
  vox_swarm(c) { // screech
    const dur = 0.45;
    const src = osc(c.ac, 'sawtooth', 480, c.t);
    src.frequency.exponentialRampToValueAtTime(760, c.t + 0.1);
    src.frequency.exponentialRampToValueAtTime(360, c.t + dur);
    src.start(c.t); src.stop(c.t + dur + 0.02);
    c.v.add(src, ...throat(c, src, 'i', dur));
    verb(c, 0.28); return dur + 0.1;
  },
  vox_caster(c) { // warbling wail
    const dur = 0.7;
    const src = osc(c.ac, 'sawtooth', 260, c.t);
    const vib = osc(c.ac, 'sine', 6, c.t); const vg = c.ac.createGain(); vg.gain.value = 18;
    vib.connect(vg); vg.connect(src.frequency);
    src.start(c.t); src.stop(c.t + dur + 0.02); vib.start(c.t); vib.stop(c.t + dur + 0.02);
    c.v.add(src, vib, vg, ...throat(c, src, 'e', dur));
    verb(c, 0.4); return dur + 0.1;
  },
  vox_brute(c) { // low guttural growl
    const dur = 0.8; shape(c, c.C.soft);
    const src = osc(c.ac, 'sawtooth', 82, c.t);
    src.frequency.linearRampToValueAtTime(66, c.t + dur);
    const rough = osc(c.ac, 'sine', 30, c.t); const rg = c.ac.createGain(); rg.gain.value = 12;
    rough.connect(rg); rg.connect(src.frequency);
    src.start(c.t); src.stop(c.t + dur + 0.02); rough.start(c.t); rough.stop(c.t + dur + 0.02);
    c.v.add(src, rough, rg, ...throat(c, src, 'growl', dur));
    verb(c, 0.34); return dur + 0.1;
  },
  vox_exploder(c) { // rising charge hiss then click
    const dur = 0.6;
    noiseL(c, c.N.white, 'bandpass', 600, 5000, 3, { a: 0.2, d: 0.1, s: 0.1, r: 0.15, peak: 0.4, sustain: 0.3 }, dur);
    tone(c, 'sine', 90, 300, { a: 0.3, d: 0.1, r: 0.1, peak: 0.3 }, dur);
    verb(c, 0.2); return dur + 0.05;
  },
  vox_boss(c) { // deep layered roar (also used for boss_roar)
    const dur = 1.6; shape(c, c.C.dist);
    const src = osc(c.ac, 'sawtooth', 58, c.t);
    src.frequency.linearRampToValueAtTime(44, c.t + dur);
    const sub = tone(c, 'sine', 40, 30, { a: 0.05, d: 0.6, s: 0.5, r: 0.4, peak: 0.7, sustain: 0.5 }, dur);
    const rough = osc(c.ac, 'sine', 22, c.t); const rg = c.ac.createGain(); rg.gain.value = 16;
    rough.connect(rg); rg.connect(src.frequency);
    src.start(c.t); src.stop(c.t + dur + 0.02); rough.start(c.t); rough.stop(c.t + dur + 0.02);
    c.v.add(src, rough, rg, ...throat(c, src, 'growl', dur));
    ringMod(c, sub.g, 47, 0.5, dur);
    verb(c, 0.5); return dur + 0.2;
  },

  // ---- deaths -----------------------------------------------------------------
  death_generic(c) {
    const dur = 0.7; shape(c, c.C.soft);
    const src = osc(c.ac, 'sawtooth', 180, c.t);
    src.frequency.exponentialRampToValueAtTime(50, c.t + dur);
    src.start(c.t); src.stop(c.t + dur + 0.02);
    c.v.add(src, ...throat(c, src, 'o', dur));
    tone(c, 'sine', 120, 40, { a: 0.005, d: 0.4, r: 0.3, peak: 0.5 }, dur);
    verb(c, 0.34); return dur + 0.15;
  },
  death_boss(c) {
    const dur = 2.4; shape(c, c.C.dist);
    const src = osc(c.ac, 'sawtooth', 90, c.t);
    src.frequency.exponentialRampToValueAtTime(28, c.t + dur);
    src.start(c.t); src.stop(c.t + dur + 0.02);
    c.v.add(src, ...throat(c, src, 'growl', dur));
    tone(c, 'sine', 55, 22, { a: 0.05, d: 1.2, r: 0.8, peak: 0.8 }, dur);
    noiseL(c, c.N.brown, 'lowpass', 400, 120, 0.8, { a: 0.1, d: 1.0, r: 0.8, peak: 0.4 }, dur);
    verb(c, 0.6); return dur + 0.3;
  },

  // ---- footsteps (surface-keyed) ---------------------------------------------
  step_stone(c) {
    noiseL(c, c.N.white, 'lowpass', 900, 380, 1.6, { a: 0.001, d: 0.05, r: 0.03, peak: 0.32 }, 0.09);
    tone(c, 'sine', 130, 70, { a: 0.001, d: 0.05, r: 0.03, peak: 0.22 }, 0.09);
    verb(c, 0.08); return 0.12;
  },
  step_water(c) {
    noiseL(c, c.N.white, 'highpass', 2600, 5200, 0.7, { a: 0.001, d: 0.07, r: 0.05, peak: 0.34 }, 0.13);
    tone(c, 'sine', 420, 180, { a: 0.002, d: 0.06, r: 0.04, peak: 0.16 }, 0.1);
    verb(c, 0.12); return 0.16;
  },
  step_rubble(c) {
    for (let i = 0; i < 4; i++) {
      const ct = { ...c, t: c.t + i * 0.012 + Math.random() * 0.01 };
      noiseL(ct, c.N.white, 'bandpass', 1400 + Math.random() * 2200, null, 5, { a: 0.001, d: 0.03, r: 0.02, peak: 0.2 }, 0.05);
    }
    tone(c, 'sine', 110, 70, { a: 0.001, d: 0.05, r: 0.03, peak: 0.18 }, 0.09);
    verb(c, 0.08); return 0.13;
  },
  step_wood(c) {
    // hollow plank knock: mid resonant body + soft click.
    noiseL(c, c.N.white, 'bandpass', 1500, 900, 3, { a: 0.001, d: 0.04, r: 0.03, peak: 0.28 }, 0.08);
    tone(c, 'triangle', 220, 150, { a: 0.001, d: 0.07, r: 0.04, peak: 0.24 }, 0.12);
    tone(c, 'sine', 96, 70, { a: 0.001, d: 0.05, r: 0.03, peak: 0.16 }, 0.09);
    verb(c, 0.1); return 0.15;
  },
  step_grass(c) {
    // soft rustle: brief highpassed pink swish, minimal body.
    noiseL(c, c.N.pink, 'highpass', 3000, 5000, 0.6, { a: 0.002, d: 0.06, r: 0.05, peak: 0.24 }, 0.12);
    tone(c, 'sine', 90, 60, { a: 0.002, d: 0.04, r: 0.03, peak: 0.1 }, 0.07);
    verb(c, 0.05); return 0.14;
  },

  // ---- loot (rarity-keyed dopamine curve) ------------------------------------
  loot_drop(c) {
    noiseL(c, c.N.white, 'highpass', 5000, 2600, 0.5, { a: 0.001, d: 0.03, r: 0.02, peak: 0.4 }, 0.05);
    tone(c, 'triangle', 900, 700, { a: 0.001, d: 0.12, r: 0.08, peak: 0.3 }, 0.22);
    tone(c, 'sine', 180, 90, { a: 0.002, d: 0.08, r: 0.05, peak: 0.3 }, 0.14);
    verb(c, 0.2); return 0.28;
  },
  loot_pickup_common(c) {
    tone(c, 'triangle', 880, 1180, { a: 0.002, d: 0.08, r: 0.06, peak: 0.3 }, 0.16);
    verb(c, 0.14); return 0.2;
  },
  loot_pickup_rare(c) {
    // bright rising arpeggio bell — genuinely exciting.
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      const ct = { ...c, t: c.t + i * 0.055 };
      tone(ct, 'triangle', f, f * 2, { a: 0.002, d: 0.28, r: 0.2, peak: 0.34 }, 0.5);
      tone(ct, 'sine', f * 2, f * 2, { a: 0.002, d: 0.2, r: 0.15, peak: 0.14 }, 0.36);
    });
    noiseL(c, c.N.white, 'highpass', 8000, 12000, 0.5, { a: 0.01, d: 0.3, r: 0.25, peak: 0.12 }, 0.6);
    verb(c, 0.42); return 0.85;
  },
  loot_pickup_unique(c) {
    // the PoE dopamine hit: sub swell + shimmering major chord + sparkle rain.
    tone(c, 'sine', 55, 110, { a: 0.02, d: 0.8, r: 0.6, peak: 0.6 }, 1.3);
    const chord = [392, 494, 587, 784, 988];
    chord.forEach((f, i) => {
      const ct = { ...c, t: c.t + i * 0.03 };
      tone(ct, 'triangle', f, f * 1.005, { a: 0.03, d: 0.9, s: 0.2, r: 0.6, peak: 0.24, sustain: 0.12 }, 1.4);
    });
    for (let i = 0; i < 10; i++) {
      const ct = { ...c, t: c.t + 0.1 + Math.random() * 0.8 };
      tone(ct, 'sine', 1800 + Math.random() * 3000, null, { a: 0.002, d: 0.15, r: 0.1, peak: 0.12 }, 0.2);
    }
    verb(c, 0.55); return 1.6;
  },
  loot_currency(c) {
    // coin cluster jingle — many short high metallic pings.
    const pitches = [1560, 2080, 1780, 2340, 1960];
    for (let i = 0; i < 7; i++) {
      const ct = { ...c, t: c.t + i * 0.028 + Math.random() * 0.015 };
      const f = pitches[i % pitches.length] * (0.97 + Math.random() * 0.06);
      tone(ct, 'triangle', f, f * 0.98, { a: 0.001, d: 0.14, r: 0.1, peak: 0.2 }, 0.26);
    }
    verb(c, 0.3); return 0.5;
  },
  item_pickup(c) {
    tone(c, 'triangle', 660, 990, { a: 0.002, d: 0.09, r: 0.06, peak: 0.28 }, 0.18);
    tone(c, 'sine', 330, 330, { a: 0.002, d: 0.06, r: 0.04, peak: 0.14 }, 0.12);
    verb(c, 0.14); return 0.22;
  },

  // ---- UI ---------------------------------------------------------------------
  ui_click(c) {
    noiseL(c, c.N.white, 'bandpass', 2600, 2600, 4, { a: 0.0008, d: 0.02, r: 0.015, peak: 0.3 }, 0.04);
    tone(c, 'square', 1200, 900, { a: 0.001, d: 0.02, r: 0.015, peak: 0.14 }, 0.04);
    return 0.06;
  },
  ui_hover(c) {
    tone(c, 'sine', 1500, 1800, { a: 0.002, d: 0.03, r: 0.02, peak: 0.1 }, 0.06);
    return 0.08;
  },

  // ---- progression + set pieces ----------------------------------------------
  level_up(c) {
    const dur = 1.4; shape(c, c.C.soft);
    // rising brass-like saw chord + shimmer + sub swell.
    const chord = [261, 329, 392, 523];
    chord.forEach((f, i) => {
      const ct = { ...c, t: c.t + i * 0.04 };
      tone(ct, 'sawtooth', f * 0.5, f, { a: 0.04, d: 0.7, s: 0.3, r: 0.4, peak: 0.22, sustain: 0.14 }, dur);
    });
    tone(c, 'sine', 65, 130, { a: 0.05, d: 0.8, r: 0.5, peak: 0.5 }, dur);
    for (let i = 0; i < 8; i++) {
      const ct = { ...c, t: c.t + 0.2 + Math.random() * 0.9 };
      tone(ct, 'triangle', 2000 + Math.random() * 2500, null, { a: 0.002, d: 0.18, r: 0.12, peak: 0.12 }, 0.24);
    }
    verb(c, 0.45); return dur + 0.2;
  },
  xp_tick(c) {
    tone(c, 'sine', 1320, 1560, { a: 0.001, d: 0.04, r: 0.03, peak: 0.08 }, 0.08);
    return 0.1;
  },

  // ---- enemy-emitted ids ------------------------------------------------------
  enemy_swing(c) { return SFX.swing(c); },
  enemy_cast(c) {
    const dur = 0.5;
    tone(c, 'sawtooth', 180, 420, { a: 0.05, d: 0.2, s: 0.1, r: 0.15, peak: 0.28 }, dur);
    noiseL(c, c.N.white, 'bandpass', 2200, 5000, 4, { a: 0.06, d: 0.15, r: 0.15, peak: 0.2 }, dur);
    verb(c, 0.3); return dur + 0.05;
  },
  tele_brute(c) {
    const dur = 0.9;
    tone(c, 'sine', 44, 90, { a: 0.3, d: 0.3, s: 0.1, r: 0.2, peak: 0.6, sustain: 0.4 }, dur);
    noiseL(c, c.N.brown, 'lowpass', 200, 600, 0.7, { a: 0.35, d: 0.2, r: 0.2, peak: 0.4 }, dur);
    verb(c, 0.3); return dur + 0.1;
  },
  explode(c) {
    const dur = 0.9; shape(c, c.C.dist);
    noiseL(c, c.N.white, 'lowpass', 4000, 200, 0.6, { a: 0.001, d: 0.3, r: 0.4, peak: 0.9 }, dur);
    tone(c, 'sine', 90, 30, { a: 0.002, d: 0.5, r: 0.3, peak: 0.85 }, dur);
    noiseL(c, c.N.brown, 'lowpass', 800, 120, 0.8, { a: 0.005, d: 0.4, r: 0.4, peak: 0.6 }, dur);
    verb(c, 0.45); return dur + 0.1;
  },
};

// Per-sound metadata: positional (world-placed) vs UI/global, steal priority
// (higher survives), and whether it should force reverb tail room. Missing =>
// defaults { positional:true, priority:1 }.
export const META = {
  ui_click: { positional: false, priority: 3 },
  ui_hover: { positional: false, priority: 3 },
  level_up: { positional: false, priority: 5 },
  xp_tick: { positional: false, priority: 0 },
  loot_pickup_common: { positional: false, priority: 2 },
  loot_pickup_rare: { positional: false, priority: 4 },
  loot_pickup_unique: { positional: false, priority: 5 },
  loot_currency: { positional: false, priority: 2 },
  item_pickup: { positional: false, priority: 2 },
  vox_boss: { positional: true, priority: 5 },
  death_boss: { positional: true, priority: 5 },
  explode: { positional: true, priority: 4 },
  impact_flesh: { positional: true, priority: 3 },
  impact_stone: { positional: true, priority: 3 },
  impact_metal: { positional: true, priority: 3 },
};

// Alias table: incoming EV.SFX_PLAY ids from other subsystems -> recipe keys.
export const ALIAS = {
  hit: 'impact_flesh', melee: 'impact_flesh', slash: 'swing',
  cast: 'cast_generic', spell: 'cast_generic',
  loot: 'loot_drop', pickup: 'item_pickup',
  boss_roar: 'vox_boss',
};

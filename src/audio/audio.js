// EXILIUM — audio subsystem. 100% synthesized WebAudio, no files.
// AudioContext is created lazily on the first user gesture (browser autoplay
// policy) — every call before that is a safe no-op, so the console stays clean.
//
// Signal graph (built once, at first gesture):
//   voices.dry -> sfxBus ---+
//   music layers -> musicBus -> musicDuck ---+
//   ambience -> ambienceBus -------------------+--> master(gain) -> limiter -> out
//   (voices/music/ambience).send -> reverbSend -> convolver -> reverbReturn --+
//
// The limiter (DynamicsCompressor as a brickwall) guarantees combat never clips;
// a sidechain duck on musicDuck pulls the music back under big impacts.

import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';
import {
  VoicePool, makeNoiseBuffer, makeImpulseResponse,
  makeDistortionCurve, makeBitcrushCurve, makeCeilingCurve,
} from './synth.js';
import { SFX, META, ALIAS } from './sfx.js';
import { MusicBed, Ambience } from './music.js';

// --- module-scope temporaries (zero per-frame allocation) ---
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _lp = new THREE.Vector3();
const _prev = new THREE.Vector3();

// --- tunables local to this subsystem (CFG core is read-only for me) ---
const VOICE_CAP = 32;
const CULL_RADIUS = 58;          // beyond this, positional sounds are dropped
const STRIDE_METERS = 1.7;       // distance per footstep at walk
const INTENSITY_HZ = 0.3;        // seconds between combat-state evaluations
const REVERB_SECONDS = 3.6;
const ELEMENTS = ['fire', 'cold', 'lightning', 'chaos'];

function elementOf(skill) {
  if (!skill) return null;
  const e = (skill.element || skill.type || skill.name || skill).toString().toLowerCase();
  if (e.includes('fire') || e.includes('burn') || e.includes('flame')) return 'fire';
  if (e.includes('cold') || e.includes('ice') || e.includes('frost')) return 'cold';
  if (e.includes('light') || e.includes('shock') || e.includes('spark')) return 'lightning';
  if (e.includes('chaos') || e.includes('poison') || e.includes('void')) return 'chaos';
  for (const el of ELEMENTS) if (e.includes(el)) return el;
  return null;
}

const STEP_FOR = {
  stone: 'step_stone', wetstone: 'step_water', water: 'step_water',
  rubble: 'step_rubble', wood: 'step_wood', grass: 'step_grass',
};

const RARITY_PICKUP = {
  normal: 'loot_pickup_common', common: 'loot_pickup_common', magic: 'loot_pickup_common',
  rare: 'loot_pickup_rare', unique: 'loot_pickup_unique', currency: 'loot_currency',
};

export default {
  name: 'audio',

  init(ctx) {
    this.THREE = ctx.THREE;
    this.ac = null;
    this.started = false;
    this.master = null;
    this.limiter = null;
    this.buses = {};
    this.pool = null;
    this.noise = null;
    this.music = null;
    this.ambience = null;

    // footstep accumulator
    this._stepDist = 0;
    this._hasPrev = false;
    // combat state
    this._state = 'calm';
    this._intAcc = 0;
    this._lastDamageT = -99;
    this._lastLevel = World.stats?.level ?? 1;
    this._bossSeen = new Set();
    // debounce identical sfx (dedupe double-emitters)
    this._recent = new Map();
    // throttles
    this._lastXpTick = -1;

    this._unbind = [];
    this._wireEvents();
    this._armGesture();
  },

  // ---- gesture-gated context creation --------------------------------------
  _armGesture() {
    const kick = () => this._begin();
    const opts = { passive: true };
    addEventListener('pointerdown', kick, opts);
    addEventListener('keydown', kick, opts);
    addEventListener('touchstart', kick, opts);
    this._disarm = () => {
      removeEventListener('pointerdown', kick, opts);
      removeEventListener('keydown', kick, opts);
      removeEventListener('touchstart', kick, opts);
    };
  },

  _begin() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                       // no WebAudio -> stay silent, no throw
    this.started = true;
    this._disarm?.();
    const ac = new AC({ latencyHint: 'interactive' });
    this.ac = ac;
    this._build();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    // suspend when tab hidden (CPU) — resume on return.
    document.addEventListener('visibilitychange', () => {
      if (!this.ac) return;
      if (document.hidden) this.ac.suspend?.().catch(() => {});
      else this.ac.resume?.().catch(() => {});
    });
  },

  _build() {
    const ac = this.ac;

    // master -> limiter (compressor) -> ceiling (true soft-clip brickwall) -> out.
    // The compressor tames the average; the ceiling guarantees the peak can never
    // reach digital clip (±1) even in a pathological combat burst. Nothing distorts
    // at normal levels — the ceiling is unity/linear below its knee.
    const master = ac.createGain(); master.gain.value = CFG.audio.master;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.12;
    const ceiling = ac.createWaveShaper();
    ceiling.curve = makeCeilingCurve(0.7, 0.985);
    ceiling.oversample = '4x';
    master.connect(limiter); limiter.connect(ceiling); ceiling.connect(ac.destination);
    this.master = master; this.limiter = limiter; this.ceiling = ceiling;

    // buses
    const musicBus = ac.createGain(); musicBus.gain.value = CFG.audio.music;
    const musicDuck = ac.createGain(); musicDuck.gain.value = 1;
    musicBus.connect(musicDuck); musicDuck.connect(master);
    const sfxBus = ac.createGain(); sfxBus.gain.value = CFG.audio.sfx;
    sfxBus.connect(master);
    const ambBus = ac.createGain(); ambBus.gain.value = 0.6;
    ambBus.connect(master);
    this.buses = { musicBus, musicDuck, sfxBus, ambBus };

    // convolution reverb (cathedral IR, procedurally generated)
    const reverbSend = ac.createGain(); reverbSend.gain.value = 1;
    const convolver = ac.createConvolver();
    convolver.buffer = makeImpulseResponse(ac, { seconds: REVERB_SECONDS, decay: 4.2 });
    const reverbReturn = ac.createGain(); reverbReturn.gain.value = 0.9;
    reverbSend.connect(convolver); convolver.connect(reverbReturn); reverbReturn.connect(master);
    this.reverbSend = reverbSend;

    // shared noise buffers + waveshaper curves (built once — the warm-up)
    this.noise = {
      white: makeNoiseBuffer(ac, 'white', 2.6),
      pink: makeNoiseBuffer(ac, 'pink', 2.6),
      brown: makeNoiseBuffer(ac, 'brown', 3.2),
    };
    this.curves = {
      soft: makeDistortionCurve(0.35),
      dist: makeDistortionCurve(0.75),
      crush: makeBitcrushCurve(5),
    };

    // voice pool — all persistent nodes allocated here, none per-sound after.
    this.pool = new VoicePool(ac, VOICE_CAP, sfxBus, reverbSend);

    // music + ambience beds
    this.music = new MusicBed(ac, musicBus, reverbSend, this.noise);
    this.ambience = new Ambience(ac, ambBus, reverbSend, this.noise);
    this.music.start();
    this.ambience.start();
    this.music.setState(this._state);
  },

  // ---- event wiring --------------------------------------------------------
  _wireEvents() {
    const on = (evt, fn) => this._unbind.push(bus.on(evt, fn));
    on(EV.SFX_PLAY, (p) => this._onSfx(p));
    on(EV.DAMAGE_DEALT, (p) => this._onDamage(p));
    on(EV.ENTITY_DIED, (p) => this._onDied(p));
    on(EV.LOOT_DROP, (p) => this._play('loot_drop', p?.pos, this._tierGain(p?.tier)));
    on(EV.LOOT_PICKUP, (p) => this._onPickup(p));
    on(EV.PLAYER_CAST, (p) => this._onCast(p));
    on(EV.XP_GAIN, () => this._onXp());
    on(EV.UI_TOAST, (p) => this._onToast(p));
    on(EV.LEVEL_READY, () => this._onLevelReady());
  },

  _tierGain(tier) {
    if (typeof tier === 'number') return Math.min(1.3, 0.7 + tier * 0.15);
    return 0.9;
  },

  _onSfx(p) {
    if (!p) return;
    let id = p.id;
    if (!SFX[id]) id = ALIAS[id] || id;
    this._play(id, p.pos, p.gain ?? 1);
  },

  _onDamage(p) {
    if (!p) return;
    this._lastDamageT = this.ac ? this.ac.currentTime : 0;
    const tgt = p.target;
    let id = 'impact_flesh';
    if (tgt && (tgt.kind === 'prop' || tgt.faction === 'prop')) {
      const m = (tgt.material || tgt.mat || '').toString().toLowerCase();
      id = (m.includes('metal') || m.includes('iron')) ? 'impact_metal' : 'impact_stone';
    }
    // living targets keep the flesh impact — the physical hit-feel channel (§7).
    // gain scales with damage; crits are louder + duck the music.
    const g = Math.min(1.25, 0.75 + (p.amount ? Math.log10(1 + p.amount) * 0.22 : 0.2) + (p.crit ? 0.25 : 0));
    this._play(id, p.pos, g);
    if (p.crit) this._play('impact_metal', p.pos, 0.5); // bright crit ring layer
    if (p.crit || (p.amount ?? 0) > 120) this._duck(0.55, 0.28);
  },

  _onDied(p) {
    if (!p) return;
    const e = p.entity;
    const boss = e && (e.isBoss || e.archetype === 'boss');
    if (boss) { this._play('death_boss', p.pos, 1.1); this._duck(0.4, 0.9); this._bossSeen.delete(e?.id); }
    else this._play('death_generic', p.pos, 0.9);
  },

  _onPickup(p) {
    const it = p?.item;
    const r = (it?.rarity || it?.tier || 'common').toString().toLowerCase();
    const id = RARITY_PICKUP[r] || 'item_pickup';
    this._play(id, null, 1);
  },

  _onCast(p) {
    const el = elementOf(p?.skill);
    const id = el ? `cast_${el}` : 'cast_generic';
    this._play(SFX[id] ? id : 'cast_generic', p?.origin, 1);
    this._lastDamageT = this.ac ? this.ac.currentTime : 0; // casting counts as combat
  },

  _onXp() {
    if (!this.started) return;
    const now = this.ac.currentTime;
    if (now - this._lastXpTick < 0.09) return; // throttle rapid ticks
    this._lastXpTick = now;
    this._play('xp_tick', null, 0.8);
  },

  _onToast(p) {
    const tier = (p?.tier || '').toString().toLowerCase();
    this._play('ui_click', null, 0.7);
    if (tier === 'rare' || tier === 'unique') this._play('xp_tick', null, 0.6);
  },

  _onLevelReady() {
    // new space revealed: settle to calm and let a distant rumble bloom in.
    this._state = 'calm';
    this.music?.setState('calm');
    if (this.started && this.ambience?._built) this.ambience._rumble(this.ac.currentTime + 0.1);
  },

  // ---- playback ------------------------------------------------------------
  _play(id, pos, gain = 1) {
    if (!this.started || !this.ac) return;      // pre-gesture no-op
    const recipe = SFX[id];
    if (!recipe) return;
    const meta = META[id] || { positional: true, priority: 1 };
    const now = this.ac.currentTime;

    // debounce identical id at ~same position within 40ms (dedupe double emits)
    const key = id + (pos ? `|${Math.round(pos.x)}|${Math.round(pos.z)}` : '');
    const last = this._recent.get(key);
    if (last !== undefined && now - last < 0.04) return;
    this._recent.set(key, now);

    let positional = meta.positional && !!pos;
    if (positional) {
      // cull far-off-screen sounds (unless high priority: boss/explode/etc.)
      _lp.copy(this._listenerPos());
      const dx = pos.x - _lp.x, dz = pos.z - _lp.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CULL_RADIUS && (meta.priority ?? 1) < 4) return;
    }

    const v = this.pool.acquire(now, 0.5, positional, meta.priority ?? 1);
    if (positional) v.setPosition(pos.x, (pos.y ?? 0) + 0.6, pos.z);
    v.amp.gain.setValueAtTime(Math.max(0.0001, gain), now);

    const c = { ac: this.ac, v, t: now, N: this.noise, C: this.curves };
    let dur = 0.5;
    try { dur = recipe(c) || 0.5; } catch (e) { console.error(`[audio:${id}]`, e); }
    v.endTime = now + dur + 0.05;
  },

  /** Sidechain duck: pull music down by `depth` for `hold` seconds, then recover. */
  _duck(level, hold) {
    if (!this.started) return;
    const g = this.buses.musicDuck.gain;
    const now = this.ac.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(level, now, 0.02);
    g.setTargetAtTime(1, now + hold, 0.18);
  },

  _listenerPos() {
    const p = World.player?.pos;
    if (p) { _lp.set(p.x, p.y, p.z); return _lp; }
    if (World.camera) { World.camera.getWorldPosition(_lp); return _lp; }
    _lp.set(0, 0, 0); return _lp;
  },

  // ---- per-frame -----------------------------------------------------------
  frame(dt) {
    if (!this.started || !this.ac || this.ac.state !== 'running') return;
    this._updateListener();
    this._footsteps(dt);
    const now = this.ac.currentTime;
    this.music.tick(now);
    this.ambience.tick(now);
    this._intAcc += dt;
    if (this._intAcc >= INTENSITY_HZ) { this._intAcc = 0; this._evalIntensity(now); }
  },

  _updateListener() {
    const L = this.ac.listener;
    const cam = World.camera;
    if (!cam) return;
    // listener sits at the player (the ear), oriented to the camera's
    // ground-projected view so world-space pans map to screen-space pans.
    const pos = this._listenerPos();
    cam.getWorldDirection(_fwd); _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); else _fwd.normalize();
    if (L.positionX) {
      const t = this.ac.currentTime, k = 0.02;
      L.positionX.setTargetAtTime(pos.x, t, k);
      L.positionY.setTargetAtTime(pos.y + 1.2, t, k);
      L.positionZ.setTargetAtTime(pos.z, t, k);
      L.forwardX.setTargetAtTime(_fwd.x, t, k);
      L.forwardY.setTargetAtTime(_fwd.y, t, k);
      L.forwardZ.setTargetAtTime(_fwd.z, t, k);
      L.upX.value = _up.x; L.upY.value = _up.y; L.upZ.value = _up.z;
    } else {
      L.setPosition(pos.x, pos.y + 1.2, pos.z);
      L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  },

  _footsteps(dt) {
    const pl = World.player;
    if (!pl || !pl.pos) { this._hasPrev = false; return; }
    if (!this._hasPrev) { _prev.copy(pl.pos); this._hasPrev = true; return; }
    const dx = pl.pos.x - _prev.x, dz = pl.pos.z - _prev.z;
    const moved = Math.hypot(dx, dz);
    _prev.copy(pl.pos);
    // don't step while airborne/dead/near-still
    const speed = moved / Math.max(dt, 1e-3);
    if (pl.alive === false || speed < 0.6) { this._stepDist = 0; return; }
    this._stepDist += moved;
    const stride = STRIDE_METERS * (speed > CFG.player.moveSpeed * 1.4 ? 0.82 : 1);
    if (this._stepDist >= stride) {
      this._stepDist -= stride;
      let surf = 'stone';
      if (World.level?.surfaceAt) surf = World.level.surfaceAt(pl.pos.x, pl.pos.z) || 'stone';
      const id = STEP_FOR[surf] || 'step_stone';
      this._play(id, pl.pos, 0.9);
    }
  },

  _evalIntensity(now) {
    // player level-up fanfare
    const lvl = World.stats?.level ?? this._lastLevel;
    if (lvl > this._lastLevel) { this._lastLevel = lvl; this._play('level_up', null, 1); }

    // prune the debounce map (entries only matter for ~40ms; keep it bounded)
    if (this._recent.size > 64) {
      for (const [k, t] of this._recent) if (now - t > 1) this._recent.delete(k);
    }

    // scan entities near the player for combat / boss state
    const pl = World.player;
    let bossAlive = false, foes = 0;
    if (pl?.pos) {
      const ents = World.entities;
      const ar = CFG.enemy.aggroRadius + 4;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (!e.alive || e.faction !== 'monster') continue;
        if (e.isBoss || e.archetype === 'boss') {
          const dx = e.pos.x - pl.pos.x, dz = e.pos.z - pl.pos.z;
          if (dx * dx + dz * dz < CFG.enemy.leashRadius * CFG.enemy.leashRadius) {
            bossAlive = true;
            if (!this._bossSeen.has(e.id)) { this._bossSeen.add(e.id); this._play('vox_boss', e.pos, 1.15); }
          }
          continue;
        }
        const dx = e.pos.x - pl.pos.x, dz = e.pos.z - pl.pos.z;
        if (dx * dx + dz * dz < ar * ar) foes++;
      }
    }
    const recentDmg = now - this._lastDamageT < 5;
    let state = 'calm';
    if (bossAlive) state = 'boss';
    else if (foes > 0 || recentDmg) state = 'combat';
    if (state !== this._state) { this._state = state; this.music.setState(state); }
  },

  dispose() {
    for (const off of this._unbind) { try { off(); } catch { /* gone */ } }
    this._unbind.length = 0;
    this.music?.dispose();
    this.ambience?.dispose();
    if (this.ac) { try { this.ac.close(); } catch { /* gone */ } this.ac = null; }
    this.started = false;
  },
};

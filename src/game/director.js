// director.js — encounter director: reads World.level.spawns, spawns budget-based
// packs of mixed archetypes with escalating composition + occasional rare/magic,
// respects CFG.enemy.maxActive, culls dead/faraway entities, triggers the boss in
// the arena. Packs are COMPOSED into readable formations (crescent / champion /
// wedge) and staged inside the room's lit pools via setpiece.js, so an encounter
// reads as a designed moment rather than an accident of simulation. Owner: EnemyAI.
import * as THREE from 'three';
import { World } from '../core/world.js';
import { bus, EV } from '../core/events.js';
import { CFG } from '../core/config.js';
import { Enemy } from './enemies.js';
import { pickStageAnchor, chooseFormation, composePack } from './setpiece.js';

// budget cost per archetype (difficulty currency)
const COST = { swarm: 1, exploder: 2, caster: 3, brute: 6 };
// escalating pack templates — weighted archetype mixes per wave tier
const TIERS = [
  { swarm: 6, exploder: 1 },                       // wave 1: skittering fodder
  { swarm: 5, exploder: 2, caster: 2 },            // wave 2: ranged pressure
  { swarm: 6, caster: 2, brute: 1, exploder: 2 },  // wave 3: mixed with a tank
  { swarm: 7, caster: 3, brute: 2, exploder: 3 },  // wave 4+: full composition
];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _dir2 = new THREE.Vector3();

export class Director {
  constructor(env) {
    this.env = env;
    this.enemies = [];          // live Enemy controllers
    this.wave = 0;
    this.baseBudget = 8;
    this.spawnAnchors = [];     // patrol/pack anchors (spawns[1..])
    this.arena = null;          // { pos, radius } around spawns[0]
    this.bossSpawned = false;
    this.bossDefeated = false;
    this.runOver = false;       // set on boss death — permanently stops wave spawning
    this.boss = null;
    this.spawnTimer = 2.0;
    this.cullTimer = 0;
    this.delayed = [];          // {skill, t, attacker}
    this.pendingAdds = [];      // {archetype, pos, count}
    // env hooks the Enemy controllers call back into
    env.spawnAdds = (arch, pos, count) => this._queueAdds(arch, pos, count);
    env.onDeath = (en) => this._onDeath(en);
    env.delayedStrike = (skill, delay, attacker) => this.delayed.push({ skill, t: delay, attacker });
  }

  setup(level) {
    const spawns = (level?.spawns && level.spawns.length) ? level.spawns : this._fallbackSpawns(level);
    // spawns[0] anchors the arena/boss (per LevelForge contract)
    const arenaPos = spawns[0].clone();
    let arenaR = 13;
    // prefer an explicit arena room flag if the level exposes one
    if (level?.rooms) {
      // real shape: { id, kind, center:Vector3, size:{x,z}, radius, floorY }; arena = kind==='arena' && boss
      const ar = level.rooms.find((r) => r && ((r.kind === 'arena' && r.boss) || r.kind === 'arena' || r.boss || r.isArena));
      if (ar) {
        const c = ar.center || ar.pos || (ar.bounds && new THREE.Vector3(
          (ar.bounds.minX + ar.bounds.maxX) / 2, 0, (ar.bounds.minZ + ar.bounds.maxZ) / 2));
        if (c) arenaPos.set(c.x, c.y || 0, c.z);
        if (ar.radius) arenaR = ar.radius;
        else if (ar.size) arenaR = Math.max(8, Math.min(ar.size.x, ar.size.z) * 0.5);
        else if (ar.bounds) arenaR = Math.max(8, Math.min(ar.bounds.maxX - ar.bounds.minX, ar.bounds.maxZ - ar.bounds.minZ) * 0.5);
      }
    }
    this.arena = { pos: arenaPos, radius: arenaR };
    this.spawnAnchors = spawns.slice(1);
    if (!this.spawnAnchors.length) this.spawnAnchors = this._fallbackSpawns(level).slice(1);
    this.ready = true;
  }

  _fallbackSpawns(level) {
    // scatter anchors on walkable ground when the level provides none
    const out = [];
    const b = level?.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const start = level?.playerStart || new THREE.Vector3(0, 0, 0);
    // arena far from player start
    out.push(new THREE.Vector3(b.minX * 0.7 + b.maxX * 0.3, 0, b.minZ * 0.3 + b.maxZ * 0.7));
    let tries = 0;
    while (out.length < 8 && tries++ < 400) {
      const x = b.minX + Math.random() * (b.maxX - b.minX);
      const z = b.minZ + Math.random() * (b.maxZ - b.minZ);
      if (level?.walkable && !level.walkable(x, z)) continue;
      if (Math.hypot(x - start.x, z - start.z) < 14) continue;
      const y = level?.heightAt ? level.heightAt(x, z) : 0;
      out.push(new THREE.Vector3(x, y, z));
    }
    return out;
  }

  get activeCount() { let n = 0; for (const e of this.enemies) if (e.e.alive) n++; return n; }

  // ── spawn a COMPOSED, STAGED pack drawn from the current wave tier ───────────
  // Roster is rolled FIRST (archetype + rarity), so the composer can see whether an
  // elite is present and build a champion-and-retinue frame around it; then the pack
  // is staged in a lit pool in front of the player and laid into a readable shape.
  spawnWave() {
    if (!this.ready) return;
    this.wave++;
    const tier = TIERS[Math.min(this.wave - 1, TIERS.length - 1)];
    let budget = this.baseBudget + this.wave * 4;
    const bag = this._weightedBag(tier);
    const members = [];
    let guard = 0;
    const cap = Math.min(CFG.enemy.maxActive - this.activeCount, 14);
    while (budget > 0 && members.length < cap && guard++ < 200) {
      const arch = bag[(Math.random() * bag.length) | 0];
      const c = COST[arch]; if (c > budget) { budget--; continue; }
      members.push({ archetype: arch, rarity: this._rollRarity(arch) });
      budget -= c;
    }
    if (!members.length) return;
    // Periodically GUARANTEE a focal point even when no rarity rolled, so the player
    // reliably gets composed champion moments — promote the costliest member to magic.
    if (!members.some((m) => m.rarity !== 'normal') && Math.random() < 0.33) {
      let bi = 0; for (let i = 1; i < members.length; i++)
        if ((COST[members[i].archetype] || 0) > (COST[members[bi].archetype] || 0)) bi = i;
      members[bi].rarity = 'magic';
    }
    const anchor = pickStageAnchor(this.spawnAnchors, {});
    if (!anchor) return;
    const formation = chooseFormation(members, (this.wave * 2654435761) >>> 0);
    const slots = composePack(members, anchor, formation, (this.wave * 40503) >>> 0);
    for (const s of slots) {
      if (this.activeCount >= CFG.enemy.maxActive) break;
      this._spawnSlot(s.archetype, s.x, s.z, s.rarity, s.facing);
    }
    bus.emit(EV.UI_TOAST, { text: `Wave ${this.wave}`, tier: 'wave' });
  }

  _weightedBag(tier) {
    const bag = [];
    for (const k in tier) for (let i = 0; i < tier[k]; i++) bag.push(k);
    return bag;
  }

  _rollRarity(arch) {
    if (arch === 'brute') { const r = Math.random(); return r < 0.12 ? 'rare' : r < 0.4 ? 'magic' : 'normal'; }
    const r = Math.random();
    return r < 0.04 ? 'rare' : r < 0.16 ? 'magic' : 'normal';
  }

  // spawn one composed slot at an explicit world position (setpiece decides where)
  _spawnSlot(archetype, x, z, rarity, facing) {
    _v.set(x, World.level?.heightAt ? World.level.heightAt(x, z) : 0, z);
    const en = new Enemy(archetype, _v, this.env, { rarity, facing });
    en.e._brain = en;
    this.enemies.push(en);
    return en;
  }

  _queueAdds(arch, pos, count) {
    for (let i = 0; i < count; i++) {
      if (this.activeCount >= CFG.enemy.maxActive) break;
      const ang = (i / count) * Math.PI * 2;
      _v.set(pos.x + Math.cos(ang) * 3, pos.y, pos.z + Math.sin(ang) * 3);
      if (World.level?.walkable && !World.level.walkable(_v.x, _v.z)) _v.set(pos.x, pos.y, pos.z);
      _v.y = World.level?.heightAt ? World.level.heightAt(_v.x, _v.z) : pos.y;
      const en = new Enemy(arch, _v, this.env, { rarity: 'normal', facing: Math.random() * 6.28 });
      en.e._brain = en; this.enemies.push(en);
    }
  }

  // ── boss trigger: a STAGED ENTRANCE, not a fade-in ──────────────────────────
  // The boss looms in across the lit arena from the player (far side of centre,
  // framed against the arena's fire), rears up in a held roar for its entrance
  // window, and a guard wedge is composed BETWEEN it and the player so the frame
  // reads as an apex threat leading its vanguard — a designed moment.
  _checkBoss() {
    if (this.bossSpawned || !this.arena) return;
    const p = World.player; if (!p) return;
    if (p.pos.distanceTo(this.arena.pos) < this.arena.radius) {
      this.bossSpawned = true;
      // place the boss beyond the arena centre, on the side away from the player,
      // so it enters facing the player across the lit floor rather than on top of them
      _dir2.copy(this.arena.pos).sub(p.pos).setY(0);
      if (_dir2.lengthSq() < 0.01) _dir2.set(0, 0, 1);
      _dir2.normalize();
      _v.copy(this.arena.pos).addScaledVector(_dir2, this.arena.radius * 0.5);
      if (World.level?.walkable && !World.level.walkable(_v.x, _v.z)) _v.copy(this.arena.pos);
      _v.y = World.level?.heightAt ? World.level.heightAt(_v.x, _v.z) : 0;
      const boss = new Enemy('boss', _v, this.env, { rarity: 'unique',
        facing: Math.atan2(p.pos.x - _v.x, p.pos.z - _v.z), entrance: true });
      boss.e._brain = boss; boss.aggro = true; boss.target = p;
      this.enemies.push(boss); this.boss = boss;
      World.boss = boss.e;                        // HUD reads this
      bus.emit(EV.UI_TOAST, { text: boss.beh.name, tier: 'boss' });
      bus.emit(EV.SFX_PLAY, { id: 'boss_intro', pos: boss.e.pos });
      bus.emit(EV.CAMERA_SHAKE, 0.8);
      // guard vanguard composed as a wedge between the boss and the player
      const guard = [{ archetype: 'brute', rarity: 'normal' },
        { archetype: 'swarm', rarity: 'normal' }, { archetype: 'swarm', rarity: 'normal' },
        { archetype: 'swarm', rarity: 'normal' }];
      _v2.copy(boss.e.pos).lerp(p.pos, 0.42);
      const slots = composePack(guard, _v2, 'wedge', 0xB055 >>> 0);
      for (const s of slots) { if (this.activeCount >= CFG.enemy.maxActive) break;
        this._spawnSlot(s.archetype, s.x, s.z, s.rarity, s.facing); }
    }
  }

  _onDeath(en) {
    if (en.isBoss) {
      this.bossDefeated = true;
      this.runOver = true;                        // hard stop: no further waves, ever
      // clear the HUD boss bar next tick (leave alive=false this tick)
      setTimeout(() => { if (World.boss === en.e) World.boss = null; }, 60);
      // THE ENDING. Without this the run had no terminal state: `bossActive()` returns
      // false once `bossDefeated` is set, so the spawn gate in fixed() opened again and
      // waves resumed — beating the boss put you back in endless mode. Now the run ends,
      // and the surviving field is left alive so the player can mop up or walk away.
      const s = World.stats || {};
      bus.emit(EV.GAME_WON, {
        kills: s.kills ?? 0,
        level: s.level ?? 1,
        xp: s.xp ?? 0,
        waves: this.wave,
        seconds: World.time ?? 0,
        bossName: this.boss?.beh?.name ?? 'the Sunderer',
      });
      bus.emit(EV.CAMERA_SHAKE, 1.2);
    }
  }

  // ── per-fixed-step director update ──────────────────────────────────────────
  fixed(dt, t) {
    if (!this.ready) return;
    // resolve delayed strikes (arena eruptions land after their telegraph)
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i]; d.t -= dt;
      if (d.t <= 0) {
        bus.emit('combat:enemyAttack', { attacker: d.attacker, skill: d.skill, origin: d.skill.origin, dir: d.skill.dir, target: World.player });
        this.delayed.splice(i, 1);
      }
    }
    this._checkBoss();
    // wave pacing: spawn when the field thins out and we're under the cap
    this.spawnTimer -= dt;
    const alive = this.activeCount;
    // `!this.runOver` is the fix for the endless-after-boss bug: bossActive() alone goes
    // false the moment the boss dies, which re-opened this gate.
    if (!this.runOver && this.spawnTimer <= 0 && alive < Math.min(CFG.enemy.maxActive, 24 + this.wave * 6) && !this.bossActive()) {
      const emptyish = alive < 6;
      this.spawnTimer = emptyish ? 1.2 : 7 + Math.random() * 4;
      if (World.player) this.spawnWave();
    }
    // cull dead (fully collapsed) + far-away bodies; drop leashed packs far from player
    this.cullTimer -= dt;
    if (this.cullTimer <= 0) { this.cullTimer = 0.5; this._cull(); }
  }

  bossActive() { return this.bossSpawned && !this.bossDefeated; }

  _cull() {
    const p = World.player?.pos;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const en = this.enemies[i];
      if (!en.e.alive) {
        en.deadT = (en.deadT || 0) + 0.5;
        const far = p ? en.e.pos.distanceTo(p) > 26 : true;
        if (en.deadT > (en.isBoss ? 6 : 3.5) || (far && en.deadT > 1.2)) { en.dispose(); this.enemies.splice(i, 1); }
        continue;
      }
      // despawn very-distant idle non-aggro trash to keep the sim lean
      if (!en.aggro && !en.isBoss && p && en.e.pos.distanceTo(p) > 70) { en.dispose(); this.enemies.splice(i, 1); }
    }
  }
}

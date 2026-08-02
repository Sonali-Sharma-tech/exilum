import { SpatialHash } from './spatial.js';
// Shared mutable blackboard. Subsystems read/write; nobody owns it exclusively.
export const World = {
  scene: null, camera: null, renderer: null, pipeline: null,
  player: null,
  entities: [],          // { id, kind, pos, vel, hp, alive, mesh, ... }
  projectiles: [],
  loot: [],
  hash: new SpatialHash(3),
  level: null,           // { walkable(x,z), heightAt(x,z), rooms[], spawns[], bounds }
  nav: null,
  time: 0,
  paused: false,
  stats: { kills: 0, level: 1, xp: 0, xpNext: 525 },
  _nextId: 1,
  id() { return this._nextId++; },
  add(e) { e.id ??= this.id(); this.entities.push(e); return e; },
  remove(e) { const i = this.entities.indexOf(e); if (i >= 0) this.entities.splice(i, 1); },
  rebuildHash() { this.hash.clear(); for (const e of this.entities) if (e.alive) this.hash.insert(e); },
};

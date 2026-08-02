// Tiny synchronous pub/sub. Subsystems talk through this, not direct imports.
class Bus {
  #m = new Map();
  on(evt, fn)  { (this.#m.get(evt) ?? this.#m.set(evt, new Set()).get(evt)).add(fn); return () => this.off(evt, fn); }
  off(evt, fn) { this.#m.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const s = this.#m.get(evt); if (!s) return;
    for (const fn of s) { try { fn(payload); } catch (e) { console.error(`[bus:${evt}]`, e); } }
  }
}
export const bus = new Bus();

// Canonical event names — the integration contract between subsystems.
export const EV = {
  BOOT_PROGRESS: 'boot:progress',
  LEVEL_READY:   'level:ready',
  PLAYER_MOVE:   'player:move',
  PLAYER_CAST:   'player:cast',
  DAMAGE_DEALT:  'combat:damage',
  ENTITY_DIED:   'entity:died',
  LOOT_DROP:     'loot:drop',
  LOOT_PICKUP:   'loot:pickup',
  VFX_SPAWN:     'vfx:spawn',
  SFX_PLAY:      'sfx:play',
  CAMERA_SHAKE:  'camera:shake',
  HITSTOP:       'time:hitstop',
  UI_TOAST:      'ui:toast',
  XP_GAIN:       'xp:gain',
  // Run terminators. The game had NO ending: the boss set `bossDefeated` and nothing
  // consumed it, so `Director.fixed()` saw `!bossActive()` go true again and resumed
  // spawning waves forever — killing the final boss returned you to endless mode.
  GAME_WON:      'game:won',
  GAME_LOST:     'game:lost',
};

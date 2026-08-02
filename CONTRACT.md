# EXILIUM — Subsystem Contract (authoritative)

Isometric ARPG in Three.js r0.185. Target: Path of Exile 2 visual quality.
Project root: `~/Desktop/exilium`. Dev server: `npm run dev` -> http://127.0.0.1:5188

## Hard rules
1. **NEVER** edit files you do not own (list below). Ownership is exclusive; other agents work in parallel.
2. **NEVER** edit `src/core/*`, `src/main.js`, `src/render/camera.js`. They are the integration layer, owned by Main.
3. **NO external assets.** No downloads, no CDN, no image/model/audio files. Everything procedural:
   textures via canvas/GPU, geometry via code, animation hand-keyframed, audio via WebAudio.
4. Three.js is imported bare: `import * as THREE from 'three'`. Addons: `import { X } from 'three/examples/jsm/...'`.
5. Read tunables from `src/core/config.js` (`CFG`). Do not hardcode magic numbers that belong there.
6. Talk to other systems via the event bus and `World`. Never import another subsystem module.
7. Code must be production-grade: no TODOs, no placeholders, no stubs left behind, no dead code.
8. Performance budget: 60fps at 1920x1080. Use InstancedMesh for anything repeated, pool all particles,
   never allocate per-frame in hot loops (reuse temp vectors at module scope).

## System contract
Every subsystem module default-exports an object:
```js
export default {
  name: 'my-system',
  async init(ctx) {},   // ctx = { THREE, World, scene, camera, renderer, canvas, bus, EV, CFG }
  fixed(dt, t) {},      // fixed 1/60 sim step — gameplay, physics, AI
  frame(dt, t) {},      // variable — visuals, interpolation, animation
  resize(w, h) {},
};
```
Systems run in the order registered in `main.js`:
materials, sky, level, props, physics, player, combat, vfx, ai, loot, camera, pipeline, hud, audio.

## World blackboard (`src/core/world.js`)
```js
World.scene, World.camera, World.renderer
World.pipeline   // set by pipeline.js; must expose render(dt). If set, engine calls it instead of renderer.render
World.player     // set by player.js
World.entities[] // all live actors incl. player
World.level      // set by level.js
World.stats      // { kills, level, xp, xpNext }
World.hash       // SpatialHash, rebuilt every fixed step: World.hash.query(x,z,r,out)
World.add(e) / World.remove(e) / World.id()
```

## Entity shape (shared)
```js
{ id, kind: 'player'|'enemy'|'prop', faction: 'player'|'monster',
  pos: THREE.Vector3, vel: THREE.Vector3, radius: number, height: number,
  hp: number, maxHp: number, alive: boolean, facing: number /*radians*/,
  mesh: THREE.Object3D|null, stagger: number, armour: number,
  hurt(amount, opts) // optional; combat.js falls back to hp arithmetic
}
```

## Event contract (`src/core/events.js` -> `EV`)
- `EV.BOOT_PROGRESS` `{frac, msg}` — emitted by engine
- `EV.LEVEL_READY` `{level}` — level.js emits after geometry built
- `EV.PLAYER_CAST` `{skill, origin:Vector3, dir:Vector3}` — player -> combat
- `EV.DAMAGE_DEALT` `{target, amount, crit, type, pos:Vector3}` — combat -> vfx/hud/audio
- `EV.ENTITY_DIED` `{entity, pos}` — combat -> ai/loot/vfx
- `EV.LOOT_DROP` `{pos, tier}` / `EV.LOOT_PICKUP` `{item}`
- `EV.VFX_SPAWN` `{kind, pos, dir?, scale?, color?}` — anyone -> vfx
- `EV.SFX_PLAY` `{id, pos?, gain?}` — anyone -> audio
- `EV.CAMERA_SHAKE` number(amplitude 0..1)
- `EV.HITSTOP` number(milliseconds)
- `EV.UI_TOAST` `{text, tier?}`
- `EV.XP_GAIN` `{amount}`

## Cross-subsystem APIs (must exist exactly as specified)

### `src/gen/materials.js` (owner: MaterialLab) — runs FIRST, everyone depends on it
```js
export const MAT = {};           // registry: MAT.stoneFloor, MAT.stoneWall, MAT.metal, ... (THREE.Material)
export function getMat(name)     // -> THREE.Material (throws if missing)
export function makeTexture(spec) // -> THREE.Texture, procedural
export function pbr(name, opts)  // -> MeshStandardMaterial with map/normal/rough/ao wired
export default { name:'materials', init }
```
Must provide at minimum, all with albedo+normal+roughness+AO and correct `.repeat`/tiling:
`stoneFloor, stoneWall, cobble, wetStone, rubble, woodPlank, ironBanded, gold, bone, cloth, dirt, moss, bloodDecal, runeGlow, waterSurface`

### `src/render/sky.js` (owner: SkyAtmos)
Owns: sun/moon directional light + CSM cascades, hemisphere/ambient fill, IBL env map
(generate with PMREMGenerator from a procedural sky shader — no HDR files), volumetric god rays,
distance fog tuning, `scene.environment`. Must expose `World.sun` (the main DirectionalLight)
so pipeline/level can read its direction.

### `src/world/level.js` (owner: LevelForge)
Must set `World.level = { walkable(x,z):boolean, heightAt(x,z):number, rooms:[], spawns:[Vector3],
bounds:{minX,maxX,minZ,maxZ}, playerStart:Vector3 }` then `bus.emit(EV.LEVEL_READY,{level})`.
Procedural modular dungeon/ruins: rooms + corridors, walls, floors, height variation, ledges, rubble.

### `src/core/physics.js` (owner: PhysicsSim) — EXCEPTION: PhysicsSim owns this one file in core/
```js
export function moveCapsule(entity, desiredDelta) // slide-collide vs level + entities, writes entity.pos
export function raycastWorld(origin, dir, maxDist) // -> {point,normal,dist}|null
export function spawnRigidBody(spec)  // -> handle, for loot/gibs/destructibles
export function spawnRagdoll(entity)  // -> handle, verlet ragdoll from entity skeleton
export default { name:'physics', init, fixed }
```

### `src/entity/player.js` (owner: CharacterRig)
Sets `World.player`. Owns procedural skinned character (skeleton + hand-keyframed clips:
idle, walk, run, attack1, attack2, cast, roll, hit, death), click-to-move locomotion with
terrain following, and cape/cloth secondary motion. Reads `Input` from `src/core/input.js`.
Emits `EV.PLAYER_CAST` on skill input. Skill keys: LMB=attack, Q/W/E/R + 1..4 = skills, Space = roll.

### `src/combat/combat.js` (owner: CombatSkills)
Skill definitions, projectiles, AoE, damage formulas (crit/armour/resist), hit resolution vs
`World.hash`, hitstop + shake on impact. Emits `EV.DAMAGE_DEALT`, `EV.ENTITY_DIED`, `EV.VFX_SPAWN`.

### `src/combat/vfx.js` (owner: VFXParticles)
Pooled GPU particles, additive impact bursts, projectile trails, ground-target decals, blood,
dust, embers, magic circles. Listens to `EV.VFX_SPAWN`, `EV.DAMAGE_DEALT`, `EV.ENTITY_DIED`.

### `src/game/ai.js` (owner: EnemyAI)
Enemy archetypes (melee swarm, ranged caster, armoured brute, boss), steering + separation,
telegraphed attacks, aggro/leash, wave director tied to `World.level.spawns`. Uses `moveCapsule`.

### `src/game/loot.js` (owner: LootSystem)
Rarity tiers with PoE-style colour coding, physics-tossed drops, ground labels, pickup radius,
item affix generation. Emits `EV.LOOT_PICKUP`, `EV.UI_TOAST`.

### `src/render/pipeline.js` (owner: RenderPipeline)
Owns `World.pipeline = { render(dt) }` via EffectComposer: RenderPass -> GTAO -> UnrealBloom ->
SMAA/TAA -> custom grade/vignette/chromatic-aberration ShaderPass -> OutputPass.
Must handle resize and expose quality toggles. This is the single biggest lever on "does it look AAA".

### `src/ui/hud.js` (owner: UIHud)
DOM-based (into `#ui-root`): life/mana orbs, skill bar with cooldown sweeps, XP bar, minimap,
floating damage numbers, item tooltips, inventory grid, boss health bar. Dark gothic gold-on-black.

### `src/audio/audio.js` (owner: AudioProc)
WebAudio only — synthesized. Ambient drone/music bed, positional impact/swing/spell SFX,
footsteps keyed to terrain, UI clicks. Listens to `EV.SFX_PLAY`, `EV.DAMAGE_DEALT`, etc.
Must not start AudioContext until first user gesture.

## Verification (required before you report done)
```bash
cd ~/Desktop/exilium && npx vite build 2>&1 | tail -20   # must succeed, no errors
```
Then confirm no console errors by loading the page (Main runs the browser check).
Report: files changed, what you implemented, and any contract deviations.
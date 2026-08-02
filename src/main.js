import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { bus, EV } from './core/events.js';

import materials from './gen/materials.js';
import sky       from './render/sky.js';
import level     from './world/level.js';
import props     from './world/props.js';
import physics   from './core/physics.js';
import player    from './entity/player.js';
import combat    from './combat/combat.js';
import vfx       from './combat/vfx.js';
import ai        from './game/ai.js';
import loot      from './game/loot.js';
import camera    from './render/camera.js';
import pipeline  from './render/pipeline.js';
import hud       from './ui/hud.js';
import audio     from './audio/audio.js';

const boot = document.getElementById('boot');
const bar = boot.querySelector('.bar i');
const msg = boot.querySelector('[data-boot-msg]');
bus.on(EV.BOOT_PROGRESS, ({ frac, msg: m }) => {
  bar.style.width = `${Math.round(frac * 100)}%`;
  if (m) msg.textContent = m.replace(/[-_]/g, ' ');
});

const canvas = document.getElementById('viewport');
Input.attach(canvas);

const engine = new Engine(canvas);
engine
  .use(materials)   // procedural texture/material library — everything else depends on it
  .use(sky)         // atmosphere, sun/moon, IBL environment
  .use(level)       // terrain + modular dungeon geometry
  .use(props)       // instanced clutter, decals, destructibles
  .use(physics)     // capsule collision, rigid bodies, ragdolls
  .use(player)      // rig, animation, locomotion
  .use(combat)      // skills, damage, hit resolution
  .use(vfx)         // particles, trails, impact FX
  .use(ai)          // enemy brains + encounter director
  .use(loot)        // drops, rarity, pickup
  .use(camera)      // isometric follow cam
  .use(pipeline)    // post stack — LAST so it sees the finished scene
  .use(hud)         // HUD, inventory, tooltips
  .use(audio);      // procedural music + sfx

// End-of-frame input edge clear must run after every system has read it.
engine.systems.push({ name: 'input-flush', frame: () => Input.endFrame() });

engine.boot().then(() => {
  window.__EXILIUM_READY = true;
  setTimeout(() => {
    boot.classList.add('done');
    // Remove the node rather than relying on the opacity transition alone: a
    // dropped transitionend (headless, background tab, reduced-motion) would
    // otherwise leave a full-screen curtain over a live game forever.
    const kill = () => boot.remove();
    boot.addEventListener('transitionend', kill, { once: true });
    setTimeout(kill, 1400);
  }, 260);
}).catch((e) => {
  console.error(e);
  msg.textContent = 'boot failed — see console';
  window.__EXILIUM_ERROR = String(e && e.stack || e);
});

window.__ENGINE = engine;

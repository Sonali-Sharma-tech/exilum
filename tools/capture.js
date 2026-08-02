/**
 * Capture harness body — executed inside the `browser` tool's `run` action,
 * where `page`, `tab`, `display`, `assert` are in scope.
 *
 * Read this file and pass its contents as the `code` parameter. Kept on disk
 * rather than inlined so the capture set is reproducible and reviewable, and so
 * every critique round captures IDENTICAL framings — a critic comparing round N
 * to round N+1 must not be looking at different camera angles.
 *
 * Captures a scenario set rather than one frame, because the rubric scores
 * categories that a single static shot cannot show: §7 vfx needs combat, §8
 * animation needs motion, §4 materials needs a close-up, §5 composition needs
 * the wide establishing shot.
 */

const OUT = 'shots';
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 220)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 220)));

await tab.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });

// Wait for the app's own readiness signal rather than a fixed sleep: procedural
// texture/geometry generation time varies, and racing the first frame captures
// an empty scene that would be critiqued as a failure of art rather than timing.
const bootState = await tab.evaluate(() => ({
  ready: !!window.__EXILIUM_READY,
  bootError: window.__EXILIUM_ERROR || null,
  // A module-LOAD failure (bad/missing export) throws before main.js installs
  // its try/catch, so __EXILIUM_ERROR stays null while the page is completely
  // dead. __ENGINE missing is the reliable tell for that case. Without this
  // check the harness reports "no error" on a corpse and the critic scores a
  // black frame as an art failure.
  engineMissing: !window.__ENGINE,
}));

const hardFail = bootState.bootError
  || (!bootState.ready && bootState.engineMissing);

if (hardFail) {
  const diag = {
    FATAL: 'boot failed',
    bootError: bootState.bootError,
    engineMissing: bootState.engineMissing,
    likelyCause: bootState.bootError
      ? 'runtime throw inside a system init()'
      : 'module-load failure (missing/bad export) — throws before main.js try/catch, so __EXILIUM_ERROR is null',
    consoleErrors: errs.slice(0, 12),
  };
  display(diag);
  return { ok: false, ...diag };
}

// The boot overlay fades via a CSS opacity transition. In headless Chromium that
// transition does not reliably complete, so every screenshot ends up
// photographing a black curtain over a live scene. Remove the node outright —
// this is a capture concern, not a game concern.
await page.evaluate(() => { const b = document.getElementById('boot'); if (b) b.remove(); });

/** Let the sim run so animation/particles/cloth reach a representative state. */

/**
 * Drive the game from inside the page. Uses the live engine handle and event
 * bus, so scenarios exercise the real code paths rather than posing the scene.
 */
async function drive(fn, ...args) {
  return tab.evaluate(fn, ...args);
}

const shots = [];
async function shoot(name) {
  const path = `${OUT}/${name}.png`;
  await tab.screenshot({ save: path, silent: true });
  shots.push(path);
}

// ---------------------------------------------------------------- 1. establishing
// Default gameplay framing, no combat. Scores §1 camera, §2 colour, §3 lighting,
// §5 composition, §6 atmosphere.
await settle(2200);
await shoot('01-establishing');

// ---------------------------------------------------------------- 2. materials
// Zoom in hard. §4 materials/textures is judged here — roughness variation,
// micro grain, normal-map detail and texel density are invisible at gameplay zoom.
await drive(() => {
  const E = window.__ENGINE; if (!E) return;
  window.__savedFov = E.camera.fov;
  E.camera.fov = 11;              // long lens crop into the surface detail
  E.camera.updateProjectionMatrix();
});
await settle(900);
await shoot('02-materials-closeup');
await drive(() => {
  const E = window.__ENGINE; if (!E) return;
  E.camera.fov = window.__savedFov ?? 30;
  E.camera.updateProjectionMatrix();
});

// ---------------------------------------------------------------- 3. combat
// Spawn a pack near the player and fire skills so §7 (vfx/impact) and §8
// (animation) have something real to score. Tries several plausible spawn hooks
// because EnemyAI owns that surface and may expose it differently.
await drive(() => {
  const E = window.__ENGINE; if (!E) return;
  const { World, bus, EV } = E.ctx;
  const p = World.player; if (!p) return;
  const spawn = World.spawnEnemy || World.director?.spawnAt || World.ai?.spawnEnemy;
  if (typeof spawn === 'function') {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      try { spawn(p.pos.x + Math.cos(a) * 5.5, p.pos.z + Math.sin(a) * 5.5); } catch (e) {}
    }
  }
  // Aim the cursor at the pack so skills fire outward into view.
  const Input = E.ctx.World.__input || null;
  bus.emit(EV.PLAYER_CAST, { skill: 'basic', origin: p.pos.clone(), dir: { x: 1, y: 0, z: 0 } });
});
await settle(700);
await drive(() => {
  const E = window.__ENGINE; if (!E) return;
  const { World, bus, EV } = E.ctx;
  const p = World.player; if (!p) return;
  // Fire a spread of skills to populate the frame with VFX at varied lifetimes.
  for (const s of ['cleave', 'slam', 'nova', 'bolt', 'beam', 'basic']) {
    try {
      bus.emit(EV.PLAYER_CAST, {
        skill: s, origin: p.pos.clone(),
        dir: { x: Math.cos(Math.random() * 6.28), y: 0, z: Math.sin(Math.random() * 6.28) },
      });
    } catch (e) {}
  }
});
await settle(420);   // mid-effect, not after everything has faded
await shoot('03-combat');

// ---------------------------------------------------------------- 4. ui
await drive(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
});
await settle(600);
await shoot('04-ui');
await drive(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
});

// ---------------------------------------------------------------- telemetry
const stats = await drive(() => {
  const E = window.__ENGINE; if (!E) return null;
  const r = E.renderer, W = E.ctx.World;
  return {
    fps: Math.round(E.clock.fps),
    drawCalls: r.info.render.calls,
    triangles: r.info.render.triangles,
    programs: r.info.programs?.length ?? null,
    textures: r.info.memory.textures,
    geometries: r.info.memory.geometries,
    entities: W.entities.length,
    hasLevel: !!W.level,
    hasPlayer: !!W.player,
    hasPipeline: !!W.pipeline,
    hasEnv: !!E.scene.environment,
    hasSun: !!W.sun,
    lights: (() => { let n = 0; E.scene.traverse((o) => { if (o.isLight) n++; }); return n; })(),
    toneMapping: r.toneMapping,
    systems: E.systems.map((s) => s.name),
  };
});

display({ shots, stats, consoleErrors: errs.slice(0, 15) });
return { ok: true, shots, stats, consoleErrors: errs.slice(0, 15) };

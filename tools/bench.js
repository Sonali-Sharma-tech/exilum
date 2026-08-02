/**
 * Fixed-camera benchmark harness — executed inside the `browser` tool's `run`.
 *
 * WHY THIS EXISTS
 * Round-1 and round-2 captures were compared and the numbers moved, but the two
 * frames had different camera positions and therefore different lit-area
 * fractions (pureBlack 11% vs 27%). A localContrast delta across two different
 * views measures the VIEW, not the texture work. That comparison was worthless.
 *
 * This harness pins the camera to fixed world positions with the follow-cam
 * disabled, so every round photographs the SAME pixels and a delta is
 * attributable to the change under test.
 *
 * Stations are chosen to isolate specific rubric criteria:
 *   nave-lit    — player-height view of a brazier pool. The §4 surface-detail
 *                 station: guaranteed lit stone, so grain is measurable.
 *   nave-wide   — the composition/§5 station.
 *   courtyard   — the ONLY room measured on-target for warm/cool (71.96/24.26).
 *                 It is the regression control: if a lighting change moves this
 *                 off target, the change overcorrected.
 *   crypt       — worst room in the game (60% pure black). The floor station.
 *   arena       — boss encounter, strongest frame. Protect it.
 *   combat      — the ONLY station exercising §7 (vfx) and §8 (animation). Live AI
 *                 is non-deterministic and resolves a fight in seconds under
 *                 headless, so this station FREEZES the sim (ai.enabled=false) and
 *                 drives every time-varying thing by fixed dt steps: a fixed
 *                 archetype roster at fixed offsets, telegraph advanced to
 *                 sweep-phase f=0.70, and the cast light captured at 250ms — the
 *                 peak of the VFX light envelope. Byte-reproducible each round.
 *                 Spec authored by the CriticCombat agent.
 */

const STATIONS = [
  { name: 'nave-lit',   pos: [34, 0, 2],    zoom: 0.72 },
  { name: 'nave-wide',  pos: [38, 0, 0],    zoom: 1.35 },
  { name: 'courtyard',  pos: [75, 0, -36],  zoom: 1.0  },
  { name: 'crypt',      pos: [40, 0, -31],  zoom: 1.0  },
  { name: 'arena',      pos: [99, 0, 0],    zoom: 1.15 },
  // Combat station LAST, per CriticCombat's spec: headless SwiftShader crashes
  // under sustained load, and this station does the most work. Keeping it last
  // means a crash loses only the combat frame, not the environment set.
  // Sited at the nave-lit brazier pool so spell light-spill is measured against
  // known-lit stone rather than against black.
  { name: 'combat',     pos: [34, 0, 2],    zoom: 0.9, combat: true },
];

const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 200)));

await tab.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });

// Procedural generation is slow under headless software GL; poll rather than sleep.
let ready = false, bootErr = null;
for (let i = 0; i < 110; i++) {
  try {
    const s = await tab.evaluate(() => ({ r: !!window.__EXILIUM_READY, e: window.__EXILIUM_ERROR || null }));
    if (s.e) { bootErr = s.e; break; }
    if (s.r) { ready = true; break; }
  } catch (e) { /* main thread busy */ }
  await new Promise((r) => setTimeout(r, 2500));
}
if (!ready) { display({ FATAL: 'boot failed', bootErr, errs }); return { ok: false, bootErr, errs }; }

await tab.evaluate(() => { document.getElementById('boot')?.remove(); });
await new Promise((r) => setTimeout(r, 6000));   // let materials/level settle

const shots = [];
// rAF is suspended in a hidden tab, so foreground once before any station.
try { await page.bringToFront(); } catch (e) {}

const SETTLE_SIM_SECONDS = 9, SETTLE_WALL_CEILING_MS = 45000;

for (const st of STATIONS) {
  // Park the player, then FREEZE the camera by neutralising the follow system's
  // inputs: cursor lead reads Input.ground, so pin it to the player position.
  const ok = await tab.evaluate(([pos, zoom]) => {
    const E = window.__ENGINE, W = E.ctx.World;
    if (!W.player || !W.level) return false;
    const [x, , z] = pos;
    // MUST go through teleportPlayer, not `player.pos.set`. `_dest` in player.js is
    // module-scoped and persists, so a bare position write leaves the old
    // click-to-move target intact and the player WALKS BACK TO IT during the settle.
    // Traced at the crypt station: placed at (40,-31), accelerated to -4.0 u/s, and
    // arrived at (29.6,-21.2) — twelve world units away — before stopping. Every
    // station was silently measuring wherever the player walked to.
    if (typeof W.teleportPlayer === 'function') W.teleportPlayer(x, z);
    else { W.player.pos.set(x, W.level.heightAt(x, z), z); W.player.vel.set(0, 0, 0); }
    return true;
  }, [st.pos, st.zoom]);
  if (!ok) { display({ FATAL: 'no player/level at station', station: st.name }); return { ok: false }; }

  // Long settle: follow-cam is exponential, and enemies need to re-path.
  await new Promise((r) => setTimeout(r, 3200));

  // FREEZE COMBAT before measuring an ENVIRONMENT station.
  //
  // WHY: a repeatability test at a single station with ZERO code change measured
  // visiblePct 14.27 / 34.94 / 17.40 and meanLuminance 0.0133 / 0.0339 / 0.0149 —
  // spreads of 93% and 99.5%. Cause: transient VFX and enemy-attack PointLights
  // firing mid-combat (lit-light count swung 20 -> 32 -> 20 between captures).
  // That noise is LARGER than most of the deltas being attributed to fixes, which
  // made three consecutive rounds of environment measurements worthless.
  //
  // Environment stations measure LIGHTING and SURFACES, so live combat is pure
  // contamination. Freeze the AI, clear transient lights, and let the VFX pools
  // drain before capturing. The dedicated `combat` station re-enables what it
  // needs deterministically.
  if (!st.combat) {
    await tab.evaluate(() => {
      const E = window.__ENGINE, W = E.ctx.World;
      for (const s of E.systems) if (s && s.director) s.enabled = false;
      // Despawn live enemies: their emissive glows and rarity auras alter the frame.
      for (const s of E.systems) {
        if (!s || !s.director) continue;
        for (const c of s.director.enemies.slice()) { try { c.dispose?.(); } catch (e) {} }
        s.director.enemies.length = 0;
      }
      // Drop any transient VFX lights still alive from the last frame of combat.
      E.scene.traverse((o) => {
        if (o.isPointLight && !/skylight|brazier|torch|sconce|candle/.test(o.name || '')) {
          o.intensity = 0; o.visible = false;
        }
      });
      W.projectiles && (W.projectiles.length = 0);
    });
    // LONG settle. This is the single change that made the metrics trustworthy, and
    // it is not about particles: the follow-camera is an exponential spring, so after
    // the player is teleported to a station it approaches the framing ASYMPTOTICALLY
    // over many seconds. Capturing at ~3s photographs a camera still in motion, and
    // because framing determines how much lit geometry is on screen, that moved
    // visiblePct and pureBlack far more than any subsystem did.
    //
    // Measured noise floor over 4 consecutive captures, no code change:
    //   before (3s settle): vis 39.1%  blk 70.3%  meanL 16.3%  locC 6.1%  satVis 1.2%
    //   after  (9s settle): vis 11.4%  blk  8.4%  meanL  6.6%  locC 2.4%  satVis 0.7%
    // pureBlack went from unusable to trustworthy purely on settle time.
    await new Promise((r) => setTimeout(r, 9000));
  }

  // Combat station: freeze the sim and drive VFX/animation deterministically, so a
  // round-over-round delta is attributable to the change and not to AI variance.
  if (st.combat) {
    await tab.evaluate(([px, pz]) => {
      const E = window.__ENGINE, THREE = E.ctx.THREE;
      let director = null;
      for (const s of E.systems) if (s && s.director) director = s.director;
      if (!director) return false;
      // Clear live enemies so the roster is reproducible.
      for (const c of director.enemies.slice()) { try { c.dispose?.(); } catch (e) {} }
      director.enemies.length = 0;
      const ROSTER = [
        ['swarm', px + 2.5, pz + 1.5], ['swarm', px + 3.0, pz - 1.0], ['swarm', px + 1.5, pz + 3.0],
        ['caster', px - 3.0, pz + 2.0], ['caster', px - 2.5, pz - 2.5],
        ['brute', px + 2.0, pz - 3.5],
      ];
      for (const [arch, x, z] of ROSTER) {
        try { director.env.spawnAdds(arch, new THREE.Vector3(x, 0, z), 1); } catch (e) {}
      }
      return true;
    }, [st.pos[0], st.pos[2]]);

    await new Promise((r) => setTimeout(r, 900));   // controllers instantiate

    await tab.evaluate(([px, pz]) => {
      const E = window.__ENGINE, W = E.ctx.World, THREE = E.ctx.THREE, bus = E.ctx.bus, EV = E.ctx.EV;
      let ai = null, director = null;
      for (const s of E.systems) if (s && s.director) { ai = s; director = s.director; }
      if (!director) return false;
      ai.enabled = false;                            // freeze: nothing aggros, moves, or dies

      // Idle pose at a DECORRELATED phase per enemy. If the per-instance spawn
      // offset is working, the roster reads as a crowd; if it regresses, they
      // visibly lockstep — which is itself the diagnostic.
      director.enemies.forEach((c, i) => {
        try {
          c._play('idle', 0);
          c.model.mixer.setTime((i * 0.37) % 2.6);
          c.e.facing = Math.atan2(px - c.e.pos.x, pz - c.e.pos.z);
          if (c.model.root) c.model.root.rotation.y = c.e.facing;
        } catch (e) {}
      });

      // One telegraph advanced to sweep-phase f=0.70 — unambiguously mid-windup.
      const teleR = 3.0, teleDur = 1.0;
      const tp = new THREE.Vector3(px + 1.0, W.level.heightAt(px + 1.0, pz), pz + 0.5);
      try {
        director.env.telegraph.spawn(tp, teleR, teleDur, 0x66e0ff);
        const steps = Math.round((0.70 * teleDur) / (1 / 60));
        for (let k = 0; k < steps; k++) director.env.telegraph.update(1 / 60);
      } catch (e) {}

      // Cast, then advance 250ms to the peak of the VFX light envelope — the frame
      // where "does the spell light the floor" is maximally testable.
      const castPos = new THREE.Vector3(px, W.level.heightAt(px, pz) + 0.5, pz);
      try {
        bus.emit(EV.PLAYER_CAST, { skill: 'q', origin: castPos.clone(), dir: { x: 1, y: 0, z: 0 } });
        bus.emit(EV.VFX_SPAWN, { kind: 'impact', pos: castPos, dir: new THREE.Vector3(1, 0, 0),
                                 scale: 1.4, color: 0x7fd6ff, duration: 0.6 });
      } catch (e) {}
      for (let k = 0; k < 15; k++) {                 // 15 * 1/60 ~= 250ms
        try { director.env.telegraph.update(1 / 60); } catch (e) {}
        director.enemies.forEach((c) => { try { c.model.mixer.update(1 / 60); } catch (e) {} });
      }
      return true;
    }, [st.pos[0], st.pos[2]]);

    await new Promise((r) => setTimeout(r, 60));     // one rAF so the final state renders
  }

  // GATE ON SIMULATED SECONDS, NOT WALL-CLOCK. requestAnimationFrame is SUSPENDED in
  // a background tab, which freezes World.time and every uTime-driven effect (fire,
  // mist, dust) while `document.hidden` still reads false and the FPS counter still
  // reports 60 — so a wall-clock sleep can capture a completely unsettled scene.
  // But a fixed wall-clock sleep is ALSO wrong: the crypt runs at ~24-28fps and
  // advances only ~65% of real-time, so a 9s sleep yields ~5.5 sim-seconds and a
  // naive "did it advance 9s?" check wrongly discards a perfectly good station.
  // Poll until the SIM reports enough time, with a wall ceiling, and only declare a
  // stall when the clock is genuinely flat across consecutive samples.
  const simT0 = await tab.evaluate(() => window.__ENGINE.ctx.World.time);
  let simElapsed = 0, waitedMs = 0, flatSamples = 0, lastSim = simT0;
  while (simElapsed < SETTLE_SIM_SECONDS && waitedMs < SETTLE_WALL_CEILING_MS) {
    await new Promise(r => setTimeout(r, 1500)); waitedMs += 1500;
    const now = await tab.evaluate(() => window.__ENGINE.ctx.World.time);
    flatSamples = (now - lastSim < 0.10) ? flatSamples + 1 : 0;
    if (flatSamples >= 3) break;
    lastSim = now; simElapsed = now - simT0;
  }
  if (simElapsed < SETTLE_SIM_SECONDS * 0.9) {
    display({ SIM_CLOCK_STALLED: st.name, simSecondsAdvanced: +simElapsed.toFixed(2),
              waitedMs, note: 'rAF suspended (tab not foreground) — discarded, scene never settled' });
    continue;
  }

  // ASSERT THE CONDITION HELD before measuring the thing we care about. Four of the
  // five measurement errors this session came from trusting that a setup did what was
  // asked without verifying it. A station that drifted is measuring a different place
  // than its name claims, so fail loudly rather than silently publish it.
  const placed = await tab.evaluate(([x, z]) => {
    const W = window.__ENGINE.ctx.World;
    return { dx: +(W.player.pos.x - x).toFixed(2), dz: +(W.player.pos.z - z).toFixed(2) };
  }, [st.pos[0], st.pos[2]]);
  const drift = Math.hypot(placed.dx, placed.dz);
  if (drift > 1.0) {
    display({ STATION_DRIFTED: st.name, requested: [st.pos[0], st.pos[2]], driftUnits: +drift.toFixed(2),
              note: 'reading discarded — player did not stay at the station' });
    continue;
  }

  const path = `shots/bench-${st.name}.png`;
  await tab.screenshot({ save: path, silent: true });

  const m = await tab.evaluate(() => {
    const E = window.__ENGINE, W = E.ctx.World, r = E.renderer;
    let litLights = 0;
    E.scene.traverse((o) => { if (o.isPointLight && o.intensity > 0) litLights++; });
    return {
      fps: Math.round(E.clock.fps),
      draws: r.info.render.calls,
      tris: r.info.render.triangles,
      entities: W.entities.length,
      litLights,
      playerY: +W.player.pos.y.toFixed(2),
    };
  });
  shots.push({ station: st.name, path, ...m });
}

display({ shots, consoleErrors: errs.slice(0, 10) });
return { ok: true, shots, errs: errs.slice(0, 10) };

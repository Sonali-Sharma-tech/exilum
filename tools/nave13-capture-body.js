// NaveStructure Round-13 capture body — paste into browser `run` on the "nave" tab.
// Same-tree A/B: at each nave station, capture relief ON then OFF seconds apart with
// NO teleport between legs (drift is common-mode, cancels). BOTH legs go through the
// runtime rebuild hook so the mesh-construction path is identical and only relief differs.
const STATIONS = [
  { name: 'nave-lit',  pos: [34, 0, 2], zoom: 0.72 },
  { name: 'nave-wide', pos: [38, 0, 0], zoom: 1.35 },
];
const out = [];
try { await page.bringToFront(); } catch (e) {}

// boot poll
let ready = false, bootErr = null;
for (let i = 0; i < 120; i++) {
  try {
    const s = await tab.evaluate(() => ({ r: !!window.__EXILIUM_READY, e: window.__EXILIUM_ERROR || null }));
    if (s.e) { bootErr = s.e; break; }
    if (s.r) { ready = true; break; }
  } catch (e) {}
  await new Promise(r => setTimeout(r, 2000));
}
if (!ready) { display({ FATAL: 'boot failed', bootErr }); return { ok: false, bootErr }; }
await tab.evaluate(() => { document.getElementById('boot')?.remove(); });
await new Promise(r => setTimeout(r, 4000));

const settleAndFreeze = async (pos) => {
  await tab.evaluate(([x, , z]) => {
    const W = window.__ENGINE.ctx.World;
    if (typeof W.teleportPlayer === 'function') W.teleportPlayer(x, z);
  }, pos);
  await new Promise(r => setTimeout(r, 3200));
  await tab.evaluate(() => {
    const E = window.__ENGINE, W = E.ctx.World;
    for (const s of E.systems) if (s && s.director) s.enabled = false;
    for (const s of E.systems) {
      if (!s || !s.director) continue;
      for (const c of s.director.enemies.slice()) { try { c.dispose?.(); } catch (e) {} }
      s.director.enemies.length = 0;
    }
    E.scene.traverse((o) => {
      if (o.isPointLight && !/skylight|brazier|torch|sconce|candle/.test(o.name || '')) { o.intensity = 0; o.visible = false; }
    });
    W.projectiles && (W.projectiles.length = 0);
  });
  // sim-second gated settle
  const simT0 = await tab.evaluate(() => window.__ENGINE.ctx.World.time);
  let elapsed = 0, waited = 0, flat = 0, last = simT0;
  while (elapsed < 9 && waited < 45000) {
    await new Promise(r => setTimeout(r, 1500)); waited += 1500;
    const now = await tab.evaluate(() => window.__ENGINE.ctx.World.time);
    flat = (now - last < 0.10) ? flat + 1 : 0;
    if (flat >= 3) break;
    last = now; elapsed = now - simT0;
  }
  return elapsed;
};

const capture = async (name, pos, relief, tag) => {
  const rb = await tab.evaluate((on) => (window.__rebuildNaveRelief ? window.__rebuildNaveRelief(on) : null), relief);
  await new Promise(r => setTimeout(r, 700)); // a few rAF for the swapped mesh to render
  const placed = await tab.evaluate(([x, z]) => {
    const W = window.__ENGINE.ctx.World;
    return { dx: +(W.player.pos.x - x).toFixed(2), dz: +(W.player.pos.z - z).toFixed(2) };
  }, [pos[0], pos[2]]);
  const drift = Math.hypot(placed.dx, placed.dz);
  const path = `shots/nave13-${name}-${tag}.png`;
  await tab.screenshot({ save: path, silent: true });
  const m = await tab.evaluate(() => {
    const E = window.__ENGINE, r = E.renderer;
    let litLights = 0; E.scene.traverse((o) => { if (o.isPointLight && o.intensity > 0) litLights++; });
    return { draws: r.info.render.calls, tris: r.info.render.triangles, litLights };
  });
  return { name, tag, relief, path, drift, wallTris: rb && rb.tris, ...m };
};

for (const st of STATIONS) {
  const elapsed = await settleAndFreeze(st.pos);
  if (elapsed < 8.0) { out.push({ station: st.name, STALLED: elapsed }); continue; }
  // ON first (default state), then OFF — both via rebuild hook (identical path).
  out.push(await capture(st.name, st.pos, true, 'relief-on'));
  out.push(await capture(st.name, st.pos, false, 'relief-off'));
  // restore ON so a later reload/other station starts from shipped state
  await tab.evaluate(() => window.__rebuildNaveRelief && window.__rebuildNaveRelief(true));
}
display({ out });
return { ok: true, out };

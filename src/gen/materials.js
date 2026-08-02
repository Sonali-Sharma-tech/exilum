// EXILIUM procedural PBR material library — runs FIRST in boot; everything
// depends on it. 100% procedural (no external assets): every albedo, normal,
// roughness, AO and emissive map is synthesised from real gradient/cellular
// noise (see noise.js) and baked through the texgen engine (see texgen.js).
//
// The look is built to the MEASURED PoE2 ground truth: darkness carries the
// grimness, but the LIT surface is richly coloured (sat ~0.24-0.58 once
// firelight hits it), so albedos here keep genuine hue identity — never greyed
// flat. Micro detail is dense and continuous (local contrast target ~0.0197)
// so nothing reads plastic.
//
// Every material carries all four PBR channels: albedo, normal (Sobel from the
// height field, +Y up), roughness and AO (baked cavity darkening). Roughness
// varies SPATIALLY within each surface; weathering is CAUSAL and DIRECTIONAL:
// water streaks run down, moss beds in crevices, wear polishes walkable tops
// and grabbed edges, grime settles in mortar and hollows.
//
// PERFORMANCE ARCHITECTURE — coarse form + full-res compose. The expensive
// structured noise (domain-warped geological FORM, ridged cracks, worley block
// layout, and every smooth weathering mask) is LOW-FREQUENCY, so it is
// evaluated once on a small coarse grid (size/coarseDiv) and bilinearly
// upsampled. Only the things that MUST be full-resolution live in pixel(): the
// whiteTile micro-grain (cheap, ~6ns, and the carrier of local contrast) and
// crisp analytic patterns (plank seams, cloth weave, blood radial). This keeps
// generation ~5x cheaper than evaluating warp/worley per texel.

import * as THREE from 'three';
import { World } from '../core/world.js';
import { Noise, clamp01, smooth, mix } from './noise.js';
import { newLayer, withMetal, withEmissive, bakeAO, buildTextures, hsl,
         makeCanvas, canvasTexture, normalCanvas, albedoCanvas, ormCanvas } from './texgen.js';

// ------------------------------------------------------------------- registry
export const MAT = {};            // name -> THREE.MeshStandardMaterial
const TEX = {};                   // name -> { map, normalMap, roughnessMap, aoMap, ... }
const DEF = {};                   // name -> recipe definition
const _animated = [];             // water: scrolling textures
let RENDERER = null;
let ANISO = 8;
let _registeredCSM = false;

// Heroes (floor + wall fill the screen) at 2048; everyone else 1024 — always a
// multiple of 256 so whiteTile grain stays seamless. Texel density held uniform
// (repeat = 1/worldSize) so no crisp rock sits beside a blurry one.
const HERO = 2048, STD = 1024;

// ----------------------------------------------------------- directional noise
// Seamless anisotropic value: different periods per axis (both powers of two)
// stretch features along one direction while staying tileable.
function streakV(nz, u, v) { // thin, vertically elongated — water runs DOWN
  return (nz.pnoise2(u * 16, v * 4, 16, 4) * 0.6 +
          nz.pnoise2(u * 32, v * 8, 32, 8) * 0.4) * 0.5 + 0.5;
}
function grainH(nz, u, v) {  // wood grain: long along U, tight across V
  return (nz.pnoise2(u * 4, v * 48, 4, 64) * 0.55 +
          nz.pnoise2(u * 8, v * 96, 8, 128) * 0.45) * 0.5 + 0.5;
}

// ----------------------------------------------------------------- synth engine
const MAXCH = 12;
const _coC = new Float32Array(MAXCH);   // coarse write scratch
const _co = new Float32Array(MAXCH);    // compose sample scratch
const _out = { h: 0, r: 0, g: 0, b: 0, rough: 0, metal: 0, emr: 0, emg: 0, emb: 0, alpha: 1 };

// Coarse form pass + full-res compose into a fresh layer. Pure CPU (no THREE
// texture upload) so it is reusable for both single textures (synth) and the
// per-cell fields of a variant atlas (getStoneAtlas). `def.size` is the target
// resolution; `nz` seeds the whole field, so a distinct seed => a distinct
// realisation of the same recipe.
function composeLayer(nz, def) {
  const size = def.size;
  const nCh = def.channels;
  const layer = newLayer(size);
  if (def.metal) withMetal(layer);
  if (def.emissive) withEmissive(layer);
  const alphaBuf = def.alpha ? new Float32Array(size * size) : null;

  // ---- coarse form pass (all structured noise lives here) ----
  const cs = Math.max(96, Math.round(size / (def.coarseDiv || 3)));
  const C = [];
  for (let k = 0; k < nCh; k++) C.push(new Float32Array(cs * cs));
  for (let cy = 0; cy < cs; cy++) {
    for (let cx = 0; cx < cs; cx++) {
      def.coarse(nz, cx / cs, cy / cs, _coC);
      const i = cy * cs + cx;
      for (let k = 0; k < nCh; k++) C[k][i] = _coC[k];
    }
  }

  // ---- full-res compose (bilinear upsample + micro grain + colour ramp) ----
  const scale = cs / size;
  const P = _out;
  for (let y = 0; y < size; y++) {
    const fy = y * scale - 0.5;
    let y0 = Math.floor(fy); const ty = fy - y0;
    const y1 = ((y0 + 1) % cs + cs) % cs; y0 = ((y0 % cs) + cs) % cs;
    const rowY0 = y0 * cs, rowY1 = y1 * cs;
    for (let x = 0; x < size; x++) {
      const fx = x * scale - 0.5;
      let x0 = Math.floor(fx); const tx = fx - x0;
      const x1 = ((x0 + 1) % cs + cs) % cs; x0 = ((x0 % cs) + cs) % cs;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const i00 = rowY0 + x0, i10 = rowY0 + x1, i01 = rowY1 + x0, i11 = rowY1 + x1;
      for (let k = 0; k < nCh; k++) {
        const Ck = C[k];
        _co[k] = Ck[i00] * w00 + Ck[i10] * w10 + Ck[i01] * w01 + Ck[i11] * w11;
      }
      P.h = 0.5; P.r = P.g = P.b = 0.5; P.rough = 0.7; P.metal = 0;
      P.emr = P.emg = P.emb = 0; P.alpha = 1;
      def.pixel(nz, x / size, y / size, x, y, size, _co, P);

      const i = y * size + x;
      layer.h[i] = P.h;
      layer.r[i] = P.r; layer.g[i] = P.g; layer.b[i] = P.b;
      layer.rough[i] = P.rough;
      if (layer.metal) layer.metal[i] = P.metal;
      if (layer.em) { layer.em[0][i] = P.emr; layer.em[1][i] = P.emg; layer.em[2][i] = P.emb; }
      if (alphaBuf) alphaBuf[i] = P.alpha;
    }
  }
  return { layer, alphaBuf };
}

function synth(nz, def) {
  const { layer, alphaBuf } = composeLayer(nz, def);
  bakeAO(layer, def.aoOpts || {});
  const tex = buildTextures(layer, {
    aniso: ANISO,
    repeat: 1 / (def.worldSize || 2),
    normalStrength: def.normalStrength ?? 2.4,
    aoFold: def.aoFold ?? 0.5,
    wrap: def.wrap || THREE.RepeatWrapping,
  });
  if (alphaBuf) tex._alpha = alphaBuf;
  return { layer, tex };
}

// ================================================================ recipe bank
// Channel layouts are documented per family; coarse() fills o[], pixel() reads
// co[] by the same indices.

// ---- stone family (floor / wall / cobble / wet / rubble) --------------------
// coarse channels: 0 form, 1 grime, 2 wearZone, 3 damp, 4 tint, 5 groove,
//                  6 perBlock, 7 crackMask, 8 crackGate (per-block), 9 region
function stoneCoarseFactory(blockCells, mortar) {
  return (nz, u, v, o) => {
    o[0] = nz.warp(u, v, 6, 4, 0.34) * 0.5 + 0.5;                 // geological undulation
    o[1] = clamp01(nz.fbm(u + 11.3, v + 2.1, 5, 3) * 0.7 + 0.5);  // grime blotches
    o[2] = clamp01(nz.fbm(u + 4.7, v + 9.9, 3, 3) * 0.8 + 0.45);  // broad wear zones
    o[3] = clamp01(streakV(nz, u + 2.2, v) * 0.9 + 0.05);         // downward damp streaks
    o[4] = nz.fbm(u + 30.1, v + 13.2, 8, 3) * 0.5 + 0.5;          // colour drift
    const cell = nz.worley(u, v, blockCells, 0.85);              // block/slab layout
    o[5] = 1 - smooth(0.0, mortar, cell.f2 - cell.f1);           // mortar groove (1 in seam)
    o[6] = cell.id / 255 - 0.5;                                  // per-slab tint/value offset
    o[7] = smooth(0.62, 0.9, nz.warpRidged(u, v, 26, 3, 0.12));  // raw crack field
    // Per-block crack GATE, decorrelated from tint id: most slabs intact, some
    // heavily fractured — kills the "identical filigree on every stone" tell.
    o[8] = smooth(0.4, 0.95, nz.whiteTile(cell.cx * 7 + 3, cell.cy * 13 + 1));
    o[9] = nz.fbm(u + 50.0, v + 20.0, 2, 2) * 0.5 + 0.5;          // broad regional value drift
  };
}
function stonePixel(cfg) {
  const { hue, sat, lum, roughBase, aggregate,
          wet = 0, wearAmt = 0.35, mossAmt = 0, hueJit = 10, satJit = 0.05, lumJit = 0.14,
          faceRelief = 0.13, hueMott = 8, satMott = 0.05, coolMin = 0.42, faceScalePow = 1, crackAmt = 1,
          regionHue = 0, blkHue = 14, regionLum = 0.12 } = cfg;
  return (nz, u, v, x, y, size, co, P) => {
    const form = co[0], grime = co[1], wearZone = co[2], damp = co[3], tint = co[4];
    const groove = co[5], perBlock = co[6], crackGate = co[8], region = co[9];
    // Cracks gated per-block: most slabs intact, gated ones fracture. Kills the
    // "identical filigree on every stone" repetition tell.
    const crackMask = clamp01(co[7] * crackAmt) * crackGate;   // crackAmt: per-cell fracture character
    // MICRO grain (full-res, the anti-plastic layer + local contrast carrier).
    const sp = nz.whiteTile(x, y);
    const sp2 = nz.whiteTile(x + 911, y + 373);
    const agg = (sp - 0.5) * aggregate + (sp2 - 0.5) * aggregate * 0.5;

    // FACE relief + MINERAL mottle — full-res fields the coarse pass cannot carry.
    // `face`: 16-32-texel height detail that SURVIVES minification to the screen
    // (form is too smooth, whiteTile grain mips to flat), so the Sobel normal
    // finally bites on the stone FACES, not just the mortar seams. `mott`: low-freq
    // mineral drift WITHIN a slab so albedo stops being one locked colour ramp.
    const fs = faceScalePow;
    // Frequencies HALVED from 128/64 to 64/32. At 128 the face field is ~1 cycle per
    // 8 texels of a 1024px cell, which under minification at gameplay distance aliases
    // into parallel diagonal streaks (visible as procedural "corduroy" on grazing-angle
    // stone) AND averages toward flat, depressing rendered local contrast. Larger
    // features survive mipping, so the same relief energy reaches the screen as real
    // per-stone variation instead of aliasing away.
    const face = nz.pnoise2(u * 64 * fs, v * 64 * fs, 64 * fs, 64 * fs) * 0.6 + nz.pnoise2(u * 32 * fs, v * 32 * fs, 32 * fs, 32 * fs) * 0.4;
    const mott = nz.pnoise2(u * 64 * fs + 21.7, v * 64 * fs + 5.3, 64 * fs, 64 * fs) * 0.6 + nz.pnoise2(u * 32 * fs + 9.1, v * 32 * fs + 40.2, 32 * fs, 32 * fs) * 0.4;

    // HEIGHT: form + per-block lift, minus grooves & cracks, plus micro grain.
    let h = form * 0.6 + perBlock * 0.12 + 0.2 - groove * 0.5 - crackMask * 0.28
      + face * faceRelief * (1 - groove * 0.8) + agg * 0.5;
    P.h = clamp01(h);

    // Convex tops (high form) get walked smooth & lit; grooves stay rough/dark.
    const topness = smooth(0.45, 0.85, form + perBlock * 0.3);
    const wear = topness * wearZone * wearAmt;

    // COLOUR: distinct per-block value/hue (blocks read as separate quarried
    // stones) + regional drift + noise, darkened in grooves & cracks.
    const l = lum + (tint - 0.5) * lumJit + perBlock * 0.22 + (region - 0.5) * regionLum + mott * 0.05 + agg * 0.6;
    const s = clamp01(sat + (tint - 0.5) * satJit + perBlock * 0.06 + mott * satMott);
    // hue varies at THREE scales: room (region, low-freq coherent), slab (perBlock,
    // per-worley-cell) and within-slab (tint mid-freq + mott mineral). Multi-scale hue
    // drift raises distinct-colour count as coherent regions, never as grain.
    const hh = hue + (region - 0.5) * regionHue + (tint - 0.5) * hueJit + perBlock * blkHue + mott * hueMott;
    let c = hsl(hh, s, clamp01(l));
    // Cool mineral patches — grey-blue, desaturated, on exposed faces where the
    // mottle field runs negative. Gives genuine HUE variation across one slab
    // (not just luminance), restores cool pixels against the warm key, and pulls
    // satVisible down. Buried grime/grooves override it below (topness gate).
    const coolM = clamp01(smooth(0.12, 0.72, -mott) * coolMin * topness);
    if (coolM > 0.001) {
      const cm = hsl(208 + mott * 12, 0.13, clamp01(l * 0.97));
      c.r = mix(c.r, cm.r, coolM); c.g = mix(c.g, cm.g, coolM); c.b = mix(c.b, cm.b, coolM);
    }
    // grime beds in grooves & concavities; cracks read as dark hairlines.
    const dirt = clamp01(groove * 0.8 + crackMask * 0.5 + (1 - topness) * grime * 0.5);
    c.r = mix(c.r, c.r * 0.42 + 0.05, dirt);
    c.g = mix(c.g, c.g * 0.40 + 0.04, dirt);
    c.b = mix(c.b, c.b * 0.36 + 0.03, dirt);
    c.r = mix(c.r, c.r * 1.18 + 0.02, wear); c.g = mix(c.g, c.g * 1.14 + 0.015, wear); c.b = mix(c.b, c.b * 1.1, wear);
    // mortar: dark but ALIVE — grit + faint per-groove value drift, never a flat void.
    const mortarGrit = groove * (0.03 + (sp - 0.5) * 0.05 + (sp2 - 0.5) * 0.03);
    c.r += mortarGrit; c.g += mortarGrit * 0.9; c.b += mortarGrit * 0.8;

    const wetM = clamp01(wet + damp * (wet > 0 ? 0.5 : 0.35) + groove * wet * 0.6);
    c.r *= mix(1, 0.5, wetM); c.g *= mix(1, 0.52, wetM); c.b *= mix(1, 0.58, wetM);

    if (mossAmt > 0) {
      const moss = clamp01((groove * 0.6 + (1 - topness) * 0.7) * mossAmt * (0.5 + grime * 0.8));
      const m = hsl(96 + tint * 18, 0.34, 0.2 + agg * 0.5);
      c.r = mix(c.r, m.r, moss); c.g = mix(c.g, m.g, moss); c.b = mix(c.b, m.b, moss);
    }
    P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);

    // ROUGHNESS — spatially varied: recesses/grooves rougher, worn tops
    // smoother, dirt rougher, wet lower, micro breakup. Per-block base drift so
    // whole slabs differ in finish, not just within-slab.
    let rough = roughBase + groove * 0.22 + crackMask * 0.15 + (1 - topness) * 0.10
      + dirt * 0.12 - wear * 0.42 - wetM * 0.5 + perBlock * 0.12 + (sp - 0.5) * 0.06;
    P.rough = clamp01(rough);
  };
}
function stoneDef(name, size, worldSize, cfg) {
  return { name, size, worldSize, channels: 10, coarseDiv: size >= HERO ? 5 : 3,
    normalStrength: cfg.normalStrength ?? 2.6, aoFold: cfg.aoFold ?? 0.55, aoOpts: cfg.aoOpts,
    coarse: stoneCoarseFactory(cfg.blockCells, cfg.mortar), pixel: stonePixel(cfg), cfg };
}

// ---- wood plank -------------------------------------------------------------
// channels: 0 tone, 1 grime, 2 wearZone, 3 damp, 4 tint, 5 grain, 6 knot
function woodCoarse(nz, u, v, o) {
  o[0] = nz.fbm(u, v, 4, 3) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 5.1, v + 8.3, 6, 3) * 0.7 + 0.5);
  o[2] = clamp01(nz.fbm(u + 1.7, v + 3.9, 3, 2) * 0.8 + 0.45);
  o[3] = streakV(nz, u + 9.0, v) * 0.5 + 0.25;
  o[4] = nz.fbm(u + 21.0, v + 4.0, 8, 3) * 0.5 + 0.5;
  o[5] = grainH(nz, u, v);                                    // grain flow
  const knotC = nz.worley(u, v, 4, 0.7);
  o[6] = 1 - smooth(0.02, 0.11, knotC.f1);                   // knots
}
function woodPixel(planks = 5) {
  return (nz, u, v, x, y, size, co, P) => {
    const grimeF = co[1], wearZone = co[2], damp = co[3], tint = co[4], grain = co[5], knot = co[6];
    // MACRO plank rows (analytic, full-res for crisp seams).
    const pv = v * planks;
    const pi = Math.floor(pv), pf = pv - pi;
    const plankId = nz.whiteTile(pi * 37 + 5, 3);
    const gap = 1 - smooth(0.0, 0.045, Math.min(pf, 1 - pf));
    const grainLine = smooth(0.35, 0.62, grain);
    const sp = nz.whiteTile(x, y);

    P.h = clamp01(0.6 + (grain - 0.5) * 0.3 - gap * 0.55 - knot * 0.25 + (sp - 0.5) * 0.12);

    const baseHue = 28 + (plankId - 0.5) * 10 + (tint - 0.5) * 6;
    const baseSat = 0.34 + (plankId - 0.5) * 0.08;
    let l = 0.24 + (plankId - 0.5) * 0.06 + (tint - 0.5) * 0.05 + (grainLine - 0.5) * 0.12 + (sp - 0.5) * 0.08 - knot * 0.12;
    let c = hsl(baseHue, clamp01(baseSat + knot * 0.15), clamp01(l));
    const wear = smooth(0.4, 0.9, 1 - Math.abs(pf - 0.5) * 2) * wearZone * 0.4;
    const dirt = clamp01(gap * 0.7 + grimeF * 0.3);
    c.r = mix(c.r, c.r * 0.5, dirt); c.g = mix(c.g, c.g * 0.48, dirt); c.b = mix(c.b, c.b * 0.5, dirt);
    const wetM = clamp01(damp * 0.5);
    c.r *= mix(1, 0.6, wetM); c.g *= mix(1, 0.62, wetM); c.b *= mix(1, 0.66, wetM);
    P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);

    P.rough = clamp01(0.82 - grainLine * 0.1 - wear * 0.4 + gap * 0.1 + dirt * 0.08 - wetM * 0.4 + (sp - 0.5) * 0.05);
  };
}

// ---- iron-banded wood -------------------------------------------------------
// wood channels + 7 rust
function ironCoarse(nz, u, v, o) {
  woodCoarse(nz, u, v, o);
  o[7] = clamp01(nz.fbm(u * 2 + 4, v * 2, 8, 3) * 0.6 + 0.4);   // rust field
}
function ironBandedPixel() {
  const wood = woodPixel(4);
  return (nz, u, v, x, y, size, co, P) => {
    wood(nz, u, v, x, y, size, co, P);                          // paint wood first
    const bandHalf = 0.075;
    const d1 = Math.abs(v - 0.24), d2 = Math.abs(v - 0.76);
    const band = 1 - smooth(bandHalf * 0.7, bandHalf, Math.min(d1, d2));
    if (band > 0.01) {
      const ru = u * 8; const rf = ru - Math.floor(ru);
      const rivet = band > 0.5 ? (1 - smooth(0.06, 0.14, Math.abs(rf - 0.5))) * band : 0;
      const sp = nz.whiteTile(x, y);
      const rust = clamp01(co[7] + co[3] * 0.4);
      const steel = hsl(212, 0.06, 0.34 + (sp - 0.5) * 0.12 + rivet * 0.25);
      const rustC = hsl(20, 0.5, 0.24 + (sp - 0.5) * 0.14);
      P.r = mix(P.r, mix(steel.r, rustC.r, rust), band);
      P.g = mix(P.g, mix(steel.g, rustC.g, rust), band);
      P.b = mix(P.b, mix(steel.b, rustC.b, rust), band);
      P.h = clamp01(mix(P.h, 0.72 + rivet * 0.28 + (sp - 0.5) * 0.08, band));
      P.metal = band * mix(0.9, 0.2, rust);
      P.rough = mix(P.rough, mix(0.32, 0.82, rust) - rivet * 0.15, band);
    }
  };
}

// ---- gold (hero metal — licensed rich saturation) --------------------------
// channels: 0 form, 1 tarnish, 2 dent, 3 scratch, 4 drift
function goldCoarse(nz, u, v, o) {
  o[0] = nz.warp(u, v, 6, 4, 0.3) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 7.0, v + 1.0, 10, 3) * 0.7 + 0.5);
  o[2] = nz.warpRidged(u, v, 20, 2, 0.1);
  o[3] = smooth(0.7, 0.95, nz.pnoise2(u * 96, v * 12, 128, 16) * 0.5 + 0.5);
  o[4] = nz.fbm(u + 12.0, v, 8, 3) * 0.5 + 0.5;
}
function goldPixel(nz, u, v, x, y, size, co, P) {
  const form = co[0], tarnish = co[1], dent = co[2], scratch = co[3];
  const sp = nz.whiteTile(x, y);
  P.h = clamp01(form * 0.5 + 0.3 - dent * 0.25 + (sp - 0.5) * 0.08 - scratch * 0.05);
  const l = 0.5 + (form - 0.5) * 0.18 + (sp - 0.5) * 0.06 - tarnish * 0.12;
  const c = hsl(46 - tarnish * 6, clamp01(0.62 - tarnish * 0.25), clamp01(l));
  P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);
  P.metal = clamp01(0.98 - tarnish * 0.25);
  P.rough = clamp01(0.18 + tarnish * 0.4 + (1 - form) * 0.12 + scratch * 0.1 + (sp - 0.5) * 0.04);
}

// ---- bone -------------------------------------------------------------------
// channels: 0 form, 1 stain, 2 pore, 3 crack, 4 tint
function boneCoarse(nz, u, v, o) {
  o[0] = nz.warp(u, v, 5, 4, 0.28) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 3.0, v + 8.0, 7, 3) * 0.7 + 0.45);
  const pit = nz.worley(u, v, 40, 1);
  o[2] = 1 - smooth(0.0, 0.16, pit.f1);                       // porosity
  o[3] = smooth(0.72, 0.95, nz.warpRidged(u, v, 30, 3, 0.14)); // hairline cracks
  o[4] = nz.fbm(u + 15.0, v + 5.0, 9, 3) * 0.5 + 0.5;
}
function bonePixel(nz, u, v, x, y, size, co, P) {
  const form = co[0], stain = co[1], pore = co[2], crack = co[3], tint = co[4];
  const sp = nz.whiteTile(x, y);
  P.h = clamp01(form * 0.5 + 0.35 - pore * 0.22 - crack * 0.3 + (sp - 0.5) * 0.1);
  let l = 0.6 + (form - 0.5) * 0.12 + (tint - 0.5) * 0.08 + (sp - 0.5) * 0.06 - pore * 0.14;
  const st = clamp01(stain * 0.5 + pore * 0.5 + crack * 0.6);
  const base = hsl(40, 0.16, clamp01(l));
  const stainC = hsl(32, 0.4, 0.28);
  P.r = clamp01(mix(base.r, stainC.r, st * 0.6));
  P.g = clamp01(mix(base.g, stainC.g, st * 0.6));
  P.b = clamp01(mix(base.b, stainC.b, st * 0.6));
  P.rough = clamp01(0.6 + pore * 0.2 + crack * 0.15 + st * 0.1 + (sp - 0.5) * 0.05 - (form - 0.5) * 0.15);
}

// ---- cloth ------------------------------------------------------------------
// channels: 0 drape, 1 grime, 2 wearZone, 3 fold, 4 tint
function clothCoarse(nz, u, v, o) {
  o[0] = nz.fbm(u, v, 5, 3) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 4.0, v + 9.0, 6, 3) * 0.7 + 0.5);
  o[2] = clamp01(nz.fbm(u + 8.0, v + 2.0, 3, 2) * 0.8 + 0.5);
  o[3] = nz.warp(u, v, 4, 3, 0.4) * 0.5 + 0.5;                 // broad creases
  o[4] = nz.fbm(u + 19.0, v + 6.0, 7, 3) * 0.5 + 0.5;
}
function clothPixel(nz, u, v, x, y, size, co, P) {
  const drape = co[0], grime = co[1], wearZone = co[2], fold = co[3], tint = co[4];
  // woven weave (analytic, full-res): orthogonal threads over/under.
  const threads = 140;
  const wu = Math.sin(u * threads * Math.PI * 2) * 0.5 + 0.5;
  const wv = Math.sin(v * threads * Math.PI * 2) * 0.5 + 0.5;
  const weave = (wu * (1 - wv) + wv * (1 - wu));
  const sp = nz.whiteTile(x, y);
  P.h = clamp01(0.5 + (weave - 0.5) * 0.4 + (fold - 0.5) * 0.4 + (sp - 0.5) * 0.08);
  // fibre flecks + weave both reach albedo (dyed cloth has visible thread grain).
  const fibre = (sp - 0.5) * 0.11 + (nz.whiteTile(x + 313, y + 77) - 0.5) * 0.06;
  let l = 0.16 + (drape - 0.5) * 0.08 + (weave - 0.5) * 0.11 + (tint - 0.5) * 0.04 + fibre;
  const fade = clamp01(wearZone * 0.4 + weave * 0.2);
  let c = hsl(354 + (tint - 0.5) * 12, clamp01(0.32 - fade * 0.12), clamp01(l + fade * 0.05));
  const dirt = clamp01(grime * 0.5 * (1 - fold));
  c.r = mix(c.r, c.r * 0.5 + 0.02, dirt); c.g = mix(c.g, c.g * 0.5, dirt); c.b = mix(c.b, c.b * 0.55, dirt);
  P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);
  P.rough = clamp01(0.9 - weave * 0.12 - fade * 0.1 + (sp - 0.5) * 0.05);
}

// ---- dirt / earth -----------------------------------------------------------
// channels: 0 form, 1 pebbleF, 2 packed, 3 damp, 4 tint, 5 stone, 6 crack
function dirtCoarse(nz, u, v, o) {
  o[0] = nz.warp(u, v, 5, 4, 0.4) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 6.0, v + 3.0, 8, 3) * 0.7 + 0.5);
  o[2] = clamp01(nz.fbm(u + 2.0, v + 7.0, 4, 2) * 0.8 + 0.45);
  o[3] = streakV(nz, u + 5, v) * 0.6 + 0.2;
  o[4] = nz.fbm(u + 22.0, v + 1.0, 9, 3) * 0.5 + 0.5;
  const st = nz.worley(u, v, 22, 1);
  o[5] = 1 - smooth(0.05, 0.2, st.f1);                        // pebbles/clods
  o[6] = smooth(0.68, 0.95, nz.warpRidged(u, v, 18, 3, 0.16)); // dried cracks
}
function dirtPixel(nz, u, v, x, y, size, co, P) {
  const form = co[0], pebbleF = co[1], packed = co[2], damp = co[3], tint = co[4], stone = co[5], crack = co[6];
  const sp = nz.whiteTile(x, y), sp2 = nz.whiteTile(x + 41, y + 733);
  const grit = (sp - 0.5) * 0.5 + (sp2 - 0.5) * 0.25;
  P.h = clamp01(form * 0.4 + 0.35 + stone * 0.2 - crack * 0.2 + grit * 0.3);
  let l = 0.2 + (form - 0.5) * 0.1 + (tint - 0.5) * 0.07 + grit * 0.4 + stone * 0.06;
  let c = hsl(30 + (tint - 0.5) * 14 + (pebbleF - 0.5) * 8, clamp01(0.28 - stone * 0.12), clamp01(l));
  const sc = hsl(34, 0.08, 0.3 + grit * 0.4);
  c.r = mix(c.r, sc.r, stone * 0.6); c.g = mix(c.g, sc.g, stone * 0.6); c.b = mix(c.b, sc.b, stone * 0.6);
  const wetM = clamp01(damp * 0.6 + crack * 0.3);
  c.r *= mix(1, 0.55, wetM); c.g *= mix(1, 0.56, wetM); c.b *= mix(1, 0.6, wetM);
  P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);
  P.rough = clamp01(0.94 - packed * 0.2 - stone * 0.15 - wetM * 0.35 + crack * 0.05 + (sp - 0.5) * 0.05);
}

// ---- moss (green over damp stone) ------------------------------------------
// stone channels 0-7 + 8 mossPatch, 9 clump
function mossCoarse(nz, u, v, o) {
  stoneCoarseFactory(6, 0.14)(nz, u, v, o);
  o[10] = nz.fbm(u + 3.3, v + 5.1, 5, 3) * 0.5 + 0.5;         // moss colonisation
  const clump = nz.worley(u, v, 30, 1);
  o[11] = 1 - smooth(0.0, 0.18, clump.f1);                    // moss clumps
}
function mossPixel() {
  const base = stonePixel({ hue: 210, sat: 0.1, lum: 0.24, roughBase: 0.82,
    aggregate: 0.28, wet: 0.25, wearAmt: 0.15, mossAmt: 0 });
  return (nz, u, v, x, y, size, co, P) => {
    base(nz, u, v, x, y, size, co, P);                        // wet-stone substrate
    const patch = co[10], clumpH = co[11], damp = co[3];
    const cover = clamp01(smooth(0.42, 0.72, patch) + damp * 0.3 - (P.h - 0.5) * 0.6);
    if (cover > 0.01) {
      const fuzz = nz.whiteTile(x, y);
      const l = 0.2 + (patch - 0.5) * 0.1 + (fuzz - 0.5) * 0.14 + clumpH * 0.06;
      const m = hsl(98 + (patch - 0.5) * 22, 0.34 + clumpH * 0.1, clamp01(l));
      P.r = mix(P.r, clamp01(m.r), cover); P.g = mix(P.g, clamp01(m.g), cover); P.b = mix(P.b, clamp01(m.b), cover);
      P.h = clamp01(P.h + cover * (0.12 + clumpH * 0.14) + (fuzz - 0.5) * 0.06 * cover);
      P.rough = clamp01(mix(P.rough, 0.93 + (fuzz - 0.5) * 0.06, cover));
    }
  };
}

// ---- blood decal (radial splat, non-tiling, transparent) -------------------
// channels: 0 blob, 1 spatter, 2 irregular, 3 tint
function bloodCoarse(nz, u, v, o) {
  o[0] = nz.fbm(u, v, 5, 3) * 0.5 + 0.5;
  o[1] = nz.fbm(u + 4, v + 2, 9, 3) * 0.5 + 0.5;
  o[2] = nz.fbm(u * 3, v * 3, 12, 3) * 0.18;                  // pool-edge wobble
  o[3] = nz.fbm(u + 8, v, 7, 3) * 0.5 + 0.5;
}
function bloodPixel(nz, u, v, x, y, size, co, P) {
  const blob = co[0], spatter = co[1], irregular = co[2], tint = co[3];
  const du = u - 0.5, dv = v - 0.5;
  const r = Math.sqrt(du * du + dv * dv) * 2;
  const edge = 0.62 + (blob - 0.5) * 0.5;
  const pool = 1 - smooth(edge - 0.08, edge + irregular, r);
  const droplet = smooth(0.86, 0.99, spatter) * (1 - smooth(0.7, 1.1, r));
  const sp = nz.whiteTile(x, y);
  P.alpha = clamp01(pool + droplet);
  P.h = clamp01(0.5 + pool * 0.12 - (1 - pool) * 0.1 + (sp - 0.5) * 0.06);
  const dryness = clamp01(r * 0.8 + (1 - pool) * 0.4);
  const l = 0.14 - dryness * 0.05 + (tint - 0.5) * 0.03 + (sp - 0.5) * 0.03;
  const c = hsl(357 - dryness * 6, clamp01(0.72 - dryness * 0.25), clamp01(Math.max(0.02, l)));
  P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);
  const wet = pool * (1 - dryness);
  P.rough = clamp01(0.75 - wet * 0.55 + (sp - 0.5) * 0.05);
}

// ---- rune glow (emissive — licensed) ---------------------------------------
// channels: 0 form, 1 grime, 2 groove, 3 rune, 4 tint
function runeCoarse(nz, u, v, o) {
  o[0] = nz.warp(u, v, 6, 4, 0.3) * 0.5 + 0.5;
  o[1] = clamp01(nz.fbm(u + 3, v + 6, 6, 3) * 0.7 + 0.5);
  const cell = nz.worley(u, v, 5, 0.85);
  o[2] = 1 - smooth(0.0, 0.12, cell.f2 - cell.f1);            // stone grooves
  const rc = nz.worley(u, v, 7, 1);
  const chan = smooth(0.02, 0.06, Math.abs(rc.f1 - rc.f2));
  const veins = smooth(0.46, 0.5, nz.warpRidged(u * 0.6, v * 0.6, 10, 3, 0.2));
  o[3] = clamp01(Math.max(chan, veins * 0.9)) * smooth(0.2, 0.5, o[0] + 0.2); // glyph network
  o[4] = nz.fbm(u + 17, v + 9, 8, 3) * 0.5 + 0.5;
}
function runePixel(nz, u, v, x, y, size, co, P) {
  const form = co[0], grime = co[1], groove = co[2], rune = co[3];
  const sp = nz.whiteTile(x, y);
  let bl = 0.12 + (form - 0.5) * 0.08 + (sp - 0.5) * 0.05 - groove * 0.06;
  let base = hsl(224, 0.12, clamp01(bl));
  const dirt = clamp01(groove * 0.7 + (1 - form) * grime * 0.4);
  base.r *= mix(1, 0.5, dirt); base.g *= mix(1, 0.5, dirt); base.b *= mix(1, 0.55, dirt);
  let h = form * 0.55 + 0.28 - groove * 0.4 + (sp - 0.5) * 0.1 - rune * 0.18;
  P.h = clamp01(h);
  const glow = rune;
  P.emr = 0.35 * glow; P.emg = 0.95 * glow; P.emb = 1.0 * glow;   // arcane cyan
  P.r = clamp01(mix(base.r, 0.5, glow * 0.5));
  P.g = clamp01(mix(base.g, 0.85, glow * 0.6));
  P.b = clamp01(mix(base.b, 0.95, glow * 0.6));
  P.rough = clamp01(0.82 - glow * 0.4 + groove * 0.1 + (sp - 0.5) * 0.05);
}

// ---- water surface (animated) ----------------------------------------------
// channels: 0 swell, 1 ripple1, 2 tint
function waterCoarse(nz, u, v, o) {
  o[0] = nz.warp(u, v, 6, 4, 0.5) * 0.5 + 0.5;
  o[1] = nz.warp(u, v, 12, 3, 0.25) * 0.5 + 0.5;
  o[2] = nz.fbm(u + 9, v, 12, 3) * 0.5 + 0.5;
}
function waterPixel(nz, u, v, x, y, size, co, P) {
  const swell = co[0], r1 = co[1], tint = co[2];
  const chop = nz.pnoise2(u * 128, v * 128, 128, 128) * 0.5 + 0.5;  // crisp micro chop
  P.h = clamp01(swell * 0.4 + r1 * 0.4 + (chop - 0.5) * 0.18 + 0.1);
  const foam = smooth(0.82, 0.98, r1 + (chop - 0.5) * 0.2);
  const l = 0.08 + (swell - 0.5) * 0.05 + foam * 0.5;
  let c = hsl(188 + (tint - 0.5) * 16, clamp01(0.4 - foam * 0.35), clamp01(l));
  P.r = clamp01(c.r); P.g = clamp01(c.g); P.b = clamp01(c.b);
  P.metal = 0.02;
  P.rough = clamp01(0.06 + foam * 0.5);
  P.alpha = clamp01(0.78 + foam * 0.2);
}

// ------------------------------------------------------------ recipe registry
function buildRecipes() {
  // Palette-variety A/B gate. The multi-scale stone-bed palette + regional/per-slab
  // hue drift SHIP BY DEFAULT. Setting `globalThis.__PALETTE_BASE = true` BEFORE boot
  // strips them so the atlas falls back to the original symmetric-jitter realisation
  // (blkHue default 14, regionHue 0, no beds) — a reload-separated A/B that isolates
  // this change from concurrent commits. Baked textures are double-cached, so the
  // flag must be set pre-boot; it does nothing after the atlas is baked.
  const _pv = (fields) => (globalThis.__PALETTE_BASE ? {} : fields);
  DEF.stoneFloor = stoneDef('stoneFloor', HERO, 6, {
    hue: 34, sat: 0.15, lum: 0.32, roughBase: 0.78, blockCells: 5, mortar: 0.1, aggregate: 0.3, wearAmt: 0.45, mossAmt: 0.12,
    faceRelief: 0.24, normalStrength: 3.0,
    // Four quarried stone BEDS: a warm sandstone (rich, carries the firelit key), a pale
    // neutral limestone, a cool blue-grey and a faint green-grey lichened bed — spread
    // across four hue octants at LOWER mean saturation (mean satMul ~0.82) so satVisible
    // falls rather than rises, mean-neutral in value, and varied stone SIZE (blockCells 2-4).
    ..._pv({ regionHue: 34, blkHue: 20, beds: [
      { hue: 30,  satMul: 1.15, lum: +0.014, blockCells: 2, wear: +0.05, crack: 0.8 },
      { hue: 46,  satMul: 0.72, lum: +0.020, blockCells: 3, wear: -0.05, crack: 1.3 },
      { hue: 202, satMul: 0.80, lum: -0.020, blockCells: 4, wear: +0.10, moss: +0.04, crack: 1.0 },
      { hue: 96,  satMul: 0.62, lum: -0.008, blockCells: 2, moss: +0.08, crack: 0.7 },
    ] }) });
  DEF.stoneWall = stoneDef('stoneWall', HERO, 6, {
    hue: 212, sat: 0.1, lum: 0.3, roughBase: 0.82, blockCells: 4, mortar: 0.12, aggregate: 0.28, wearAmt: 0.2, mossAmt: 0.22,
    faceRelief: 0.24, normalStrength: 3.0,
    // Cool grey ashlar dominant, with a pale neutral course, a warm sandstone course
    // (the mixed-masonry look) and a green-grey damp course, at varied block sizes.
    ..._pv({ regionHue: 28, blkHue: 18, beds: [
      { hue: 210, satMul: 0.95, lum: +0.008, blockCells: 2, crack: 0.9 },
      { hue: 200, satMul: 0.55, lum: +0.022, blockCells: 3, wear: +0.05, crack: 1.2 },
      { hue: 35,  satMul: 0.78, lum: -0.016, blockCells: 2, wear: -0.05, crack: 0.8 },
      { hue: 150, satMul: 0.65, lum: -0.014, blockCells: 4, moss: +0.10, crack: 1.0 },
    ] }) });
  DEF.cobble = stoneDef('cobble', STD, 2, {
    hue: 28, sat: 0.16, lum: 0.28, roughBase: 0.8, blockCells: 9, mortar: 0.16, aggregate: 0.32, wearAmt: 0.5, mossAmt: 0.18,
    ..._pv({ regionHue: 30, blkHue: 18 }) });
  DEF.wetStone = stoneDef('wetStone', STD, 2, {
    hue: 208, sat: 0.13, lum: 0.22, roughBase: 0.6, blockCells: 6, mortar: 0.12, aggregate: 0.26, wet: 0.55, wearAmt: 0.25, mossAmt: 0.25,
    ..._pv({ regionHue: 24, blkHue: 16 }) });
  DEF.rubble = stoneDef('rubble', STD, 2.5, {
    hue: 30, sat: 0.13, lum: 0.3, roughBase: 0.86, blockCells: 14, mortar: 0.22, aggregate: 0.4, wearAmt: 0.1, mossAmt: 0.14, aoOpts: { strength: 1.3 } });

  DEF.woodPlank = { name: 'woodPlank', size: STD, worldSize: 2, channels: 7, coarseDiv: 3,
    normalStrength: 2.4, aoFold: 0.5, coarse: woodCoarse, pixel: woodPixel(5) };
  DEF.ironBanded = { name: 'ironBanded', size: STD, worldSize: 2, channels: 8, coarseDiv: 3, metal: true,
    normalStrength: 2.8, aoFold: 0.5, coarse: ironCoarse, pixel: ironBandedPixel() };
  DEF.gold = { name: 'gold', size: STD, worldSize: 1.5, channels: 5, coarseDiv: 3, metal: true,
    normalStrength: 2.0, aoFold: 0.35, coarse: goldCoarse, pixel: goldPixel };
  DEF.bone = { name: 'bone', size: STD, worldSize: 1.5, channels: 5, coarseDiv: 3,
    normalStrength: 2.6, aoFold: 0.55, coarse: boneCoarse, pixel: bonePixel };
  DEF.cloth = { name: 'cloth', size: STD, worldSize: 1.5, channels: 5, coarseDiv: 3,
    normalStrength: 2.2, aoFold: 0.45, coarse: clothCoarse, pixel: clothPixel };
  DEF.dirt = { name: 'dirt', size: STD, worldSize: 2, channels: 7, coarseDiv: 3,
    normalStrength: 2.6, aoFold: 0.5, coarse: dirtCoarse, pixel: dirtPixel };
  DEF.moss = { name: 'moss', size: STD, worldSize: 2, channels: 12, coarseDiv: 3,
    normalStrength: 2.6, aoFold: 0.55, coarse: mossCoarse, pixel: mossPixel() };

  DEF.bloodDecal = { name: 'bloodDecal', size: STD, worldSize: 1, channels: 4, coarseDiv: 3, alpha: true,
    normalStrength: 1.6, aoFold: 0.3, wrap: THREE.ClampToEdgeWrapping, coarse: bloodCoarse, pixel: bloodPixel };
  DEF.runeGlow = { name: 'runeGlow', size: STD, worldSize: 2, channels: 5, coarseDiv: 3, emissive: true,
    normalStrength: 2.4, aoFold: 0.5, coarse: runeCoarse, pixel: runePixel };
  DEF.waterSurface = { name: 'waterSurface', size: STD, worldSize: 3, channels: 3, coarseDiv: 3, alpha: true,
    normalStrength: 1.4, aoFold: 0.15, coarse: waterCoarse, pixel: waterPixel };
}

// --------------------------------------------------------- material assembly
function assemble(name, tex) {
  const def = DEF[name];
  const params = {
    map: tex.map, normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap, aoMap: tex.aoMap,
    metalness: 0, roughness: 1,
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: 1.0,
  };
  if (tex.metalnessMap) { params.metalnessMap = tex.metalnessMap; params.metalness = 1; }
  if (tex.emissiveMap) {
    params.emissiveMap = tex.emissiveMap;
    params.emissive = new THREE.Color(0xffffff);
    params.emissiveIntensity = 2.4;                 // push runes past bloom threshold (0.78)
  }

  let mat;
  if (name === 'gold') { params.metalness = 1; params.envMapIntensity = 1.4; mat = new THREE.MeshStandardMaterial(params); }
  else if (name === 'waterSurface') {
    params.transparent = true; params.opacity = 0.9; params.metalness = 0.02;
    params.roughness = 0.1; params.envMapIntensity = 1.6; params.depthWrite = false;
    mat = new THREE.MeshStandardMaterial(params);
  } else if (name === 'bloodDecal') {
    params.transparent = true; params.alphaTest = 0.02;
    params.polygonOffset = true; params.polygonOffsetFactor = -1; params.polygonOffsetUnits = -1; params.depthWrite = false;
    mat = new THREE.MeshStandardMaterial(params);
  } else {
    mat = new THREE.MeshStandardMaterial(params);
  }
  mat.name = name;

  if (tex._alpha && (name === 'waterSurface' || name === 'bloodDecal')) {
    mat.alphaMap = makeAlphaTexture(tex._alpha, def.size, def.worldSize, def.wrap);
  }
  return mat;
}

function makeAlphaTexture(alpha, size, worldSize, wrap) {
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = clamp01(alpha[i]) * 255; const j = i << 2;
    d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrap || THREE.RepeatWrapping;
  tex.repeat.set(1 / (worldSize || 1), 1 / (worldSize || 1));
  tex.anisotropy = ANISO;
  tex.needsUpdate = true;
  return tex;
}

// Generate one material (textures + MeshStandardMaterial), cache, register CSM.
function generate(name) {
  const def = DEF[name];
  if (!def) throw new Error(`materials: unknown material "${name}"`);
  const nz = new Noise(hashName(name));
  const { tex } = synth(nz, def);
  TEX[name] = tex;
  const mat = assemble(name, tex);
  MAT[name] = mat;
  registerCSM(mat);
  if (name === 'waterSurface') {
    _animated.push({ map: tex.map, normalMap: tex.normalMap, dux: 0.013, duy: 0.021, dvx: -0.019, dvy: 0.011 });
  }
  return mat;
}

// ============================================================ variant atlas
// The single-source-texture tell: a whole paved floor samples ONE seamless
// stone texture, so every slab is an offset/rotation of the SAME field and its
// distinctive landmarks (the ridged coral-crack topology, worley cells, grime
// blotches) recur on neighbours — "adjacent stones read as the same stone with
// only rotation differing" (blind judge 7). The fix: bake N genuinely INDEPENDENT
// realisations of the recipe into ONE texture atlas (grid x grid cells), each
// seeded distinctly so no two cells share a noise signature. A slab's baked UV
// window then selects a cell; with per-slab rotation + mirror that is
// grid^2 x 8 distinct appearances from a single texture upload — no extra draw
// call, no shader injection, so CSM cannot clobber it (stock RepeatWrapping map).
//
// Cells are individually seamless (each baked over its own [0,1) tile with
// wrapped Sobel/AO), and slab UVs are inset-guarded away from cell borders so
// mip/bilinear bleed across the grid never reaches sampled texels.
// Per-cell recipe: the base recipe perturbed on the axes that read as STONE
// CHARACTER — hue/value/roughness and, crucially, the balance of crack vs wear
// vs moss. A distinct SEED alone only reshuffles the same signature (verified:
// cross-cell grain NCC stayed at the single-field baseline), so cells must
// differ in CHARACTER too: some crack-heavy, some clean-worn, some mossy, across
// a hue spread — which is exactly what blind judge 7 asked for ("chips, cracks
// AND discolouration"). Offsets are symmetric about the base and averaged over
// grid^2 cells, so the MEAN texture ~= the shipped floor and the five frame
// guards do not move; only the between-cell VARIANCE rises.
function _cellRNG(seed) { let s = seed >>> 0; return () => {
  let t = (s += 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function _atlasCellDef(name, cellPx, blockCells, faceScalePow, over = {}) {
  if (!Object.keys(DEF).length) buildRecipes();   // lazy: probe / early-atlas paths
  const base = DEF[name];
  if (!base || !base.cfg) throw new Error(`materials.getStoneAtlas: "${name}" is not a stone recipe`);
  const cfg2 = { ...base.cfg, blockCells, faceScalePow, ...over };
  return {
    name: `${name}#atlasCell`, size: cellPx, worldSize: base.worldSize, channels: 10, coarseDiv: 3,
    normalStrength: base.normalStrength ?? 3.0, aoFold: base.aoFold ?? 0.55, aoOpts: base.aoOpts,
    coarse: stoneCoarseFactory(blockCells, cfg2.mortar), pixel: stonePixel(cfg2),
  };
}
// Bake `grid*grid` AO-finished cell layers, each an independent realisation with
// its own character. PURE CPU (composeLayer + bakeAO only) — safe in Node with
// no WebGL, which is what the deterministic decorrelation probe imports.
function _bakeAtlasCells(name, { grid = 2, cellPx = 1024, blockCells = 2, faceScalePow = 0.5 } = {}) {
  if (!Object.keys(DEF).length) buildRecipes();
  const base = DEF[name].cfg;
  const seed0 = hashName(name);
  const rng = _cellRNG(seed0 ^ 0x5c1a7);
  const layers = [];
  const n = grid * grid;
  // Authored stone-BED palette: each cell is a genuinely different quarried stone —
  // its own hue octant (warm/neutral/cool), saturation, value AND worley block SIZE.
  // Spreading blockCells across cells is the SCALE-variety lever (a floor tiling
  // big-stone and small-stone beds no longer repeats at one uniform period, which
  // is the "uniform cell scale" tell); spreading hue centres is the COLOUR-variety
  // lever (no longer "one tan stone rotated four ways"). Beds are laid out roughly
  // mean-neutral in value/saturation so the frame guards (meanLuminance, satVisible)
  // barely move; only the between-cell variance rises. Recipes that author no `beds`
  // fall back to the original symmetric-jitter realisation unchanged.
  const beds = base.beds || null;
  for (let idx = 0; idx < n; idx++) {
    const j = (amp) => (rng() - 0.5) * 2 * amp;
    let over, bc;
    if (beds) {
      const bed = beds[idx % beds.length];
      bc = bed.blockCells ?? blockCells;                       // per-bed stone SIZE (integer: worley tiling)
      over = {
        hue: bed.hue,                                          // absolute hue octant for this bed
        sat: clamp01((base.sat ?? 0.15) * (bed.satMul ?? 1) + j(0.02)),
        lum: clamp01((base.lum ?? 0.3) + (bed.lum ?? 0) + j(0.02)),
        roughBase: clamp01((base.roughBase ?? 0.8) + (bed.rough ?? 0) + j(0.05)),
        wearAmt: Math.max(0, (base.wearAmt ?? 0.35) + (bed.wear ?? 0) + j(0.10)),
        mossAmt: Math.max(0, (base.mossAmt ?? 0) + (bed.moss ?? 0) + j(0.06)),
        crackAmt: Math.max(0.15, (bed.crack ?? 1) + j(0.45)),
      };
    } else {
      // Symmetric-about-base perturbation (mean over cells ~= base). Crack/wear/moss
      // are the strongest character axes; hue gives the discolouration variety.
      bc = blockCells;
      over = {
        hue: (base.hue ?? 30) + j(11),
        sat: clamp01((base.sat ?? 0.15) + j(0.04)),
        lum: clamp01((base.lum ?? 0.3) + j(0.03)),
        roughBase: clamp01((base.roughBase ?? 0.8) + j(0.06)),
        wearAmt: Math.max(0, (base.wearAmt ?? 0.35) + j(0.18)),
        mossAmt: Math.max(0, (base.mossAmt ?? 0) + j(0.10)),
        crackAmt: Math.max(0.15, 1 + j(0.65)),
      };
    }
    // Distinct permutation table per cell => distinct form/worley/crack topology.
    const nz = new Noise((seed0 ^ Math.imul(idx + 1, 0x9e3779b1)) >>> 0);
    const cellDef = _atlasCellDef(name, cellPx, bc, faceScalePow, over);
    const { layer } = composeLayer(nz, cellDef);
    bakeAO(layer, cellDef.aoOpts || {});
    layers.push(layer);
  }
  return { grid, cellPx, layers };
}

const _atlasCache = new Map();
// Public: THREE texture atlas for a stone recipe. One map/normal/ORM upload;
// repeat=1 (UV windows carry world->cell mapping). Browser-only (needs canvas).
export function getStoneAtlas(name, opts = {}) {
  const key = `${name}|${opts.grid || 2}|${opts.cellPx || 1024}|${opts.blockCells || 2}|${opts.faceScalePow ?? 0.5}`;
  const hit = _atlasCache.get(key);
  if (hit) return hit;
  const { grid, cellPx, layers } = _bakeAtlasCells(name, opts);
  const A = grid * cellPx;
  const mapC = makeCanvas(A), norC = makeCanvas(A), ormC = makeCanvas(A);
  const mctx = mapC.getContext('2d'), nctx = norC.getContext('2d'), octx = ormC.getContext('2d');
  const aoFold = (DEF[name] && DEF[name].aoFold) ?? 0.55;
  const nStr = (DEF[name] && DEF[name].normalStrength) ?? 3.0;
  for (let idx = 0; idx < layers.length; idx++) {
    const gx = idx % grid, gy = (idx / grid) | 0;
    const L = layers[idx];
    mctx.drawImage(albedoCanvas(L, aoFold), gx * cellPx, gy * cellPx);
    nctx.drawImage(normalCanvas(L, nStr),   gx * cellPx, gy * cellPx);
    octx.drawImage(ormCanvas(L),            gx * cellPx, gy * cellPx);
  }
  const wrap = THREE.RepeatWrapping;
  const orm = canvasTexture(ormC, { srgb: false, aniso: ANISO, repeat: 1, wrap });
  const tex = {
    map: canvasTexture(mapC, { srgb: true, aniso: ANISO, repeat: 1, wrap }),
    normalMap: canvasTexture(norC, { srgb: false, aniso: ANISO, repeat: 1, wrap }),
    roughnessMap: orm, aoMap: orm, grid, cellPx,
  };
  _atlasCache.set(key, tex);
  return tex;
}

// Renderer-free probe source: the per-cell HEIGHT fields (the grain signature
// that drives the normal map) as plain Float32Arrays, so the decorrelation
// probe can prove inter-cell independence in Node with no WebGL context.
export function getStoneAtlasFields(name, opts = {}) {
  const { grid, cellPx, layers } = _bakeAtlasCells(name, opts);
  const aoFold = (DEF[name] && DEF[name].aoFold) ?? 0.55;
  return { grid, cellPx, aoFold, cells: layers.map((L) => ({ h: L.h, r: L.r, g: L.g, b: L.b, ao: L.ao })) };
}

function hashName(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function registerCSM(mat) { if (World.registerCSMMaterial) { try { World.registerCSMMaterial(mat); } catch (e) { /* sky sweeps as backstop */ } } }

// ---------------------------------------------------------------- public API
export function getMat(name) {
  const m = MAT[name];
  if (!m) throw new Error(`materials.getMat: unknown material "${name}" (available: ${Object.keys(MAT).join(', ')})`);
  return m;
}

// Fresh MeshStandardMaterial for `name` sharing its baked maps, with optional
// overrides. Lets props/loot make cheap variants without regenerating textures.
export function pbr(name, opts = {}) {
  if (!TEX[name]) {
    if (!DEF[name]) throw new Error(`materials.pbr: unknown material "${name}"`);
    generate(name);
  }
  const mat = MAT[name].clone();
  if (opts.color !== undefined) mat.color = new THREE.Color(opts.color);
  if (opts.roughness !== undefined) mat.roughness = opts.roughness;
  if (opts.metalness !== undefined) mat.metalness = opts.metalness;
  if (opts.emissive !== undefined) mat.emissive = new THREE.Color(opts.emissive);
  if (opts.emissiveIntensity !== undefined) mat.emissiveIntensity = opts.emissiveIntensity;
  if (opts.repeat !== undefined) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap', 'alphaMap']) {
      if (mat[k]) { mat[k] = mat[k].clone(); mat[k].repeat.set(opts.repeat, opts.repeat); mat[k].needsUpdate = true; }
    }
  }
  registerCSM(mat);
  return mat;
}

// Procedural texture factory:
//  makeTexture({ material:'stoneFloor', channel:'map'|'normalMap'|... })
//    -> a baked channel of a named material (generated on demand).
//  makeTexture({ size, base, octaves, ridged, worley, warp, color, repeat, srgb, seed })
//    -> a bespoke seamless noise texture for props/vfx.
export function makeTexture(spec = {}) {
  if (spec.material) {
    if (!TEX[spec.material]) generate(spec.material);
    const t = TEX[spec.material][spec.channel || 'map'];
    if (!t) throw new Error(`makeTexture: material "${spec.material}" has no channel "${spec.channel}"`);
    return t;
  }
  const size = spec.size || 512;
  const nz = new Noise(spec.seed ?? 1234);
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const base = spec.base || 8, oct = spec.octaves || 4, ridged = !!spec.ridged;
  const warpAmt = spec.warp || 0, worleyCells = spec.worley || 0;
  const col = spec.color ? new THREE.Color(spec.color) : new THREE.Color(0.7, 0.7, 0.7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n = warpAmt > 0 ? (ridged ? nz.warpRidged(u, v, base, oct, warpAmt) : nz.warp(u, v, base, oct, warpAmt))
                          : nz.fbm(u, v, base, oct, 0.5, ridged);
      if (!ridged && warpAmt === 0) n = n * 0.5 + 0.5;
      if (worleyCells > 0) { const c = nz.worley(u, v, worleyCells, 1); n *= (0.4 + c.f1 * 0.8); }
      const sp = nz.whiteTile(x, y);
      const shade = clamp01(n * 0.85 + (sp - 0.5) * 0.12 + 0.08);
      const j = (y * size + x) << 2;
      d[j] = clamp01(col.r * shade) * 255;
      d[j + 1] = clamp01(col.g * shade) * 255;
      d[j + 2] = clamp01(col.b * shade) * 255;
      d[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = spec.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const rep = spec.repeat || 1; tex.repeat.set(rep, rep);
  tex.anisotropy = ANISO;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// -------------------------------------------------------------------- system
const ORDER = [
  'stoneFloor', 'stoneWall', 'cobble', 'wetStone', 'rubble',
  'woodPlank', 'ironBanded', 'gold', 'bone', 'cloth',
  'dirt', 'moss', 'bloodDecal', 'runeGlow', 'waterSurface',
];

async function init(ctx) {
  RENDERER = ctx.renderer;
  ANISO = RENDERER?.capabilities?.getMaxAnisotropy ? RENDERER.capabilities.getMaxAnisotropy() : 8;
  buildRecipes();
  const n = ORDER.length;
  for (let i = 0; i < n; i++) {
    const name = ORDER[i];
    generate(name);
    ctx.bus.emit(ctx.EV.BOOT_PROGRESS, { frac: i / n, msg: `materials:${name}` });
    await new Promise((r) => setTimeout(r));      // yield so the boot bar animates
  }
  // Prewarm the flagstone/ashlar variant atlases HERE (boot phase, ~4s budget)
  // so level.init gets cache hits and its generation stays under the 2s budget —
  // the 32-cell bake is ~2 HERO-equivalents and must not land on level gen.
  for (const nm of ['stoneFloor', 'stoneWall']) {
    try { getStoneAtlas(nm); } catch (e) { /* level falls back to base map */ }
    await new Promise((r) => setTimeout(r));
  }
}

// Animate water; one-time CSM registration backstop (we init before sky).
function frame(dt, t) {
  for (let i = 0; i < _animated.length; i++) {
    const a = _animated[i];
    if (a.map) { a.map.offset.x = (a.map.offset.x + a.dux * dt) % 1; a.map.offset.y = (a.map.offset.y + a.duy * dt) % 1; }
    if (a.normalMap) { a.normalMap.offset.x = (a.normalMap.offset.x + a.dvx * dt) % 1; a.normalMap.offset.y = (a.normalMap.offset.y + a.dvy * dt) % 1; }
  }
  if (!_registeredCSM && World.registerCSMMaterial) {
    for (const k in MAT) registerCSM(MAT[k]);
    _registeredCSM = true;
  }
}

export default { name: 'materials', init, frame };

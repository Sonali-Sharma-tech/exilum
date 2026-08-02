#!/usr/bin/env node
/**
 * Objective frame metrics, measured against the rubric's numeric targets.
 *
 * Purpose: a critic looking at an image will rationalise. It will call a frame
 * "moody and atmospheric" when it is in fact crushed to black, or "richly
 * coloured" when saturation is 3x the PoE2 target. Numbers do not rationalise.
 * The critic gets these stats alongside the image and must reconcile the two.
 *
 * Pure Node, zero dependencies — decodes PNG by hand (zlib is built in) so this
 * never has to fight the corporate npm registry.
 *
 * Usage: node tools/analyze.mjs shots/frame.png [--json]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG decode
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo PNG per-scanline filters. Each scanline is prefixed by a filter byte.
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const A = x >= channels ? cur[x - channels] : 0;      // left
      const B = prev ? prev[x] : 0;                          // up
      const C = prev && x >= channels ? prev[x - channels] : 0; // up-left
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += A; break;
        case 2: v += B; break;
        case 3: v += (A + B) >> 1; break;
        case 4: {                                            // Paeth
          const p = A + B - C;
          const pa = Math.abs(p - A), pb = Math.abs(p - B), pc = Math.abs(p - C);
          v += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }

  // Normalise everything to RGB triplets.
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      const pi = out[i] * 3;
      rgb[i*3] = palette[pi]; rgb[i*3+1] = palette[pi+1]; rgb[i*3+2] = palette[pi+2];
    } else if (colorType === 0 || colorType === 4) {
      const g = out[i * channels];
      rgb[i*3] = g; rgb[i*3+1] = g; rgb[i*3+2] = g;
    } else {
      rgb[i*3] = out[i*channels]; rgb[i*3+1] = out[i*channels+1]; rgb[i*3+2] = out[i*channels+2];
    }
  }
  return { width, height, rgb };
}

// ------------------------------------------------------------- colour helpers
const srgbToLin = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
// Rec.709 luma on linearised values — the perceptually correct way to ask
// "how bright is this pixel", as opposed to averaging sRGB bytes.
const luminance = (r, g, b) =>
  0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);

function rgbToHsv(r, g, b) {
  const rr = r/255, gg = g/255, bb = b/255;
  const max = Math.max(rr,gg,bb), min = Math.min(rr,gg,bb), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

// -------------------------------------------------------------------- metrics
function analyze(png) {
  const { width: W, height: H, rgb } = png;
  const N = W * H;

  const lums = new Float64Array(N);
  let satSum = 0, satCount = 0;
  let warmPix = 0, coolPix = 0, neutralPix = 0;
  const satAll = [];
  // Shadow chroma: are dark regions blue-ish (correct) or grey (rubric fail)?
  let shadowHueX = 0, shadowHueY = 0, shadowSatSum = 0, shadowCount = 0;
  let clipped = 0, nearBlack = 0;
  // Visible = a pixel a viewer can actually read colour in. In frames with
  // several percent pure black, unweighted saturation is dominated by
  // numerically unstable near-zero pixels: rgb(3,1,0) reports sat 1.0 but
  // reads as black. Measured PoE2 gameplay: 12-60% visible, median 25%.
  let visCount = 0, visSatSum = 0;

  for (let i = 0; i < N; i++) {
    const r = rgb[i*3], g = rgb[i*3+1], b = rgb[i*3+2];
    const L = luminance(r, g, b);
    lums[i] = L;
    const { h, s, v } = rgbToHsv(r, g, b);
    satSum += s; satCount++; satAll.push(s);

    if (v > 0.06) {
      // Warm = red/orange/yellow arc, cool = cyan/blue arc.
      if ((h >= 340 || h <= 65) && s > 0.10) warmPix++;
      else if (h >= 170 && h <= 280 && s > 0.06) coolPix++;
      else neutralPix++;
    }
    if (Math.max(r, g, b) >= 40) { visCount++; visSatSum += s; }
    if (r >= 254 && g >= 254 && b >= 254) clipped++;
    if (r <= 2 && g <= 2 && b <= 2) nearBlack++;

    if (L < 0.035) { // shadow region
      shadowCount++;
      shadowSatSum += s;
      const rad = h * Math.PI / 180;
      shadowHueX += Math.cos(rad) * s;
      shadowHueY += Math.sin(rad) * s;
    }
  }

  const sortedL = Array.from(lums).sort((a, b) => a - b);
  const p01 = percentile(sortedL, 0.01);
  const p05 = percentile(sortedL, 0.05);
  const p50 = percentile(sortedL, 0.50);
  const p95 = percentile(sortedL, 0.95);
  const p99 = percentile(sortedL, 0.99);
  const meanL = sortedL.reduce((a,b)=>a+b,0) / N;

  // Dynamic range as a ratio of bright to dark, in stops. Rubric §3 asks for
  // a 6:1..15:1 key:fill, which shows up here as roughly 2.5-4 stops.
  const contrastRatio = p95 / Math.max(p05, 1e-5);
  const stops = Math.log2(Math.max(contrastRatio, 1));

  // Local contrast: mean absolute Laplacian. Low value = flat/blurry frame,
  // which is how "no micro detail / no roughness variation" manifests.
  let lapSum = 0, lapN = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const l = 4*lums[i] - lums[i-1] - lums[i+1] - lums[i-W] - lums[i+W];
      lapSum += Math.abs(l); lapN++;
    }
  }
  const localContrast = lapSum / Math.max(lapN, 1);

  // Edge-aliasing proxy: fraction of horizontally adjacent pairs with a very
  // large luminance jump. Hard jaggies produce many maximal single-pixel steps.
  let hardEdges = 0, edgePairs = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W - 1; x++) {
      const a = lums[y*W+x], b = lums[y*W+x+1];
      edgePairs++;
      if (Math.abs(a - b) > 0.18) hardEdges++;
    }
  }

  // LARGE-STEP ENERGY SHARE — the project's cleanest ours-vs-PoE2 discriminator.
  //
  // localContrast is a MEAN |Laplacian|, and a mean cannot distinguish "many small
  // steps" from "few large ones". Measuring the step-size DISTRIBUTION showed the
  // deficit is entirely in the large steps: we carry MORE sub-0.01 grain than PoE2
  // (71.5% of steps vs 53.0%) but 4.7x fewer steps in 0.04-0.08 and 9.5x fewer above
  // 0.08. PoE2 draws 49.4-82.6% of its gradient energy from steps >0.04; we drew
  // 11.3-37.4%. Zero overlap across six references and five stations — our best
  // station sat below the weakest reference.
  //
  // This retrospectively explains three rounds of failed work on localContrast: every
  // attempt added MICRO-detail, i.e. added to the one bucket where we already exceeded
  // the reference, and that bucket carries little energy. The fix is fewer, DEEPER
  // steps — recessed joints whose interiors are genuinely shadowed beside lit faces —
  // not more grain. Target: >=45%.
  //
  // MUST EXCLUDE THE HUD. Measured full-frame, ours reads 47.91% against poe2-07's
  // 56.98% — an apparently small gap. Excluding the HUD, ours is 21.6% against 57.3%:
  // the reference is unchanged, ours collapses by 26 points. Our HUD (hard-edged gold
  // orb rims, crisp skill-icon borders, minimap frame) is itself a large-step
  // generator, and PoE2's reference frames have far less of that per pixel. So the
  // full-frame number flatters us by ~2.2x and would have reported this defect as
  // nearly solved when the SCENE — the only thing any renderer change can affect —
  // is 2.7x short. Scene window: y 12-72%, x 8-92%.
  const sy0 = Math.floor(H * 0.12), sy1 = Math.floor(H * 0.72);
  const sx0 = Math.floor(W * 0.08), sx1 = Math.floor(W * 0.92);
  //
  // THE GUARD MUST BE ABSOLUTE, NOT A SHARE. My first guard was `fineStepEnergyPct`, a
  // share of total gradient energy — and it does NOT close the Goodhart hole, because
  // both numbers divide by the SAME denominator. Deleting fine grain shrinks that
  // denominator, which mechanically RAISES large% and LOWERS fine% at the same time. So
  // the maps-OFF plastic failure scores large 46.04% / fine 11.53% and PASSES a
  // "large>=40 AND fine 5-34" target, while being the exact defect the judges named.
  //
  // `fineStepEnergyAbs` is mean fine-step energy PER SAMPLED PIXEL. It is independent of
  // the large-step term: adding lit/unlit boundaries raises large energy without
  // touching it, whereas deleting texture makes it FALL. That is the asymmetry a real
  // guard needs. Both shares are still reported for comparison against the reference
  // frames, but the ABS value is what proves detail was not deleted.
  let bigStepEnergy = 0, allStepEnergy = 0, bigStepCount = 0, stepCount = 0;
  let fineStepEnergy = 0, fineStepCount = 0;
  for (let y = sy0; y < sy1; y += 2) {
    for (let x = sx0; x < sx1 - 1; x++) {
      const d = Math.abs(lums[y*W+x] - lums[y*W+x+1]);
      allStepEnergy += d; stepCount++;
      if (d > 0.04) { bigStepEnergy += d; bigStepCount++; }
      else if (d < 0.01) { fineStepEnergy += d; fineStepCount++; }
    }
  }

  // Scene-window mode separation: mean of above-mean pixels minus mean of below-mean.
  // Same window as the step metrics so the population matches (HUD excluded).
  let sceneSum = 0, sceneN = 0;
  for (let y = sy0; y < sy1; y += 2) {
    for (let x = sx0; x < sx1; x += 2) { sceneSum += lums[y*W+x]; sceneN++; }
  }
  const sceneMean = sceneSum / Math.max(sceneN, 1);
  let aboveSum = 0, aboveN = 0, belowSum = 0, belowN = 0;
  for (let y = sy0; y < sy1; y += 2) {
    for (let x = sx0; x < sx1; x += 2) {
      const v = lums[y*W+x];
      if (v >= sceneMean) { aboveSum += v; aboveN++; } else { belowSum += v; belowN++; }
    }
  }
  const sceneModeSep = (aboveSum / Math.max(aboveN, 1)) - (belowSum / Math.max(belowN, 1));

  const shadowHueAngle = shadowCount
    ? (Math.atan2(shadowHueY, shadowHueX) * 180 / Math.PI + 360) % 360 : null;
  const shadowSat = shadowCount ? shadowSatSum / shadowCount : 0;

  const satSorted = satAll.sort((a,b)=>a-b);
  const meanSat = satSum / satCount;

  // Rule-of-thirds-ish focal check: is brightness concentrated somewhere, or
  // spread evenly (which reads as no focal point / flat lighting)?
  const tiles = 6;
  const tileL = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      let s = 0, c = 0;
      for (let y = Math.floor(ty*H/tiles); y < Math.floor((ty+1)*H/tiles); y++)
        for (let x = Math.floor(tx*W/tiles); x < Math.floor((tx+1)*W/tiles); x++) { s += lums[y*W+x]; c++; }
      tileL.push(s / Math.max(c,1));
    }
  }
  const tMean = tileL.reduce((a,b)=>a+b,0)/tileL.length;
  const tVar = tileL.reduce((a,b)=>a+(b-tMean)**2,0)/tileL.length;
  const spatialVariation = Math.sqrt(tVar) / Math.max(tMean, 1e-5);

  const warmCoolTotal = warmPix + coolPix + neutralPix || 1;

  // Chroma directional coherence over the scene window: autocorrelation of per-pixel
  // chroma at lag 1 ALONG the screen diagonal vs ACROSS it. Parallel streaks correlate
  // along their own length; isotropic material detail correlates equally both ways.
  const cA = [], cB = [];
  const chromaAt = (x, y) => {
    const i = (y * W + x) * 3;
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  for (let y = sy0 + 1; y < sy1 - 1; y++) {
    for (let x = sx0 + 1; x < sx1 - 1; x++) {
      const c = chromaAt(x, y);
      cA.push([c, chromaAt(x + 1, y + 1)]);   // along the streak direction
      cB.push([c, chromaAt(x + 1, y - 1)]);   // perpendicular to it
    }
  }
  const pearson = (pairs) => {
    const n = pairs.length; if (!n) return 0;
    let ma = 0, mb = 0;
    for (const p of pairs) { ma += p[0]; mb += p[1]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (const p of pairs) { const u = p[0] - ma, v = p[1] - mb; num += u * v; da += u * u; db += v * v; }
    return num / Math.max(Math.sqrt(da * db), 1e-12);
  };
  const chromaCoh = pearson(cA) / Math.max(pearson(cB), 1e-9);

  return {
    dimensions: `${W}x${H}`,
    exposure: {
      meanLuminance: +meanL.toFixed(4),
      p01: +p01.toFixed(4), p05: +p05.toFixed(4), median: +p50.toFixed(4),
      p95: +p95.toFixed(4), p99: +p99.toFixed(4),
      contrastRatio: +contrastRatio.toFixed(2),
      dynamicRangeStops: +stops.toFixed(2),
      clippedWhitePct: +(100*clipped/N).toFixed(3),
      pureBlackPct: +(100*nearBlack/N).toFixed(3),
    },
    colour: {
      meanSaturation: +meanSat.toFixed(4),
      satMedian: +percentile(satSorted, 0.5).toFixed(4),
      satP95: +percentile(satSorted, 0.95).toFixed(4),
      warmPct: +(100*warmPix/warmCoolTotal).toFixed(2),
      coolPct: +(100*coolPix/warmCoolTotal).toFixed(2),
      neutralPct: +(100*neutralPix/warmCoolTotal).toFixed(2),
      shadowHueAngle: shadowHueAngle === null ? null : +shadowHueAngle.toFixed(1),
      visiblePct: +(100*visCount/N).toFixed(2),
      satVisible: visCount ? +(visSatSum/visCount).toFixed(4) : null,
    },
    detail: {
      localContrast: +localContrast.toFixed(5),
      hardEdgeRatio: +(hardEdges/Math.max(edgePairs,1)).toFixed(5),
      spatialVariation: +spatialVariation.toFixed(4),
      // Share of gradient energy from steps >0.04. PoE2 refs: 49.4-82.6%. Target >=45%.
      largeStepEnergyPct: +(100*bigStepEnergy/Math.max(allStepEnergy,1e-9)).toFixed(2),
      largeStepCountPct: +(100*bigStepCount/Math.max(stepCount,1)).toFixed(2),
      // Goodhart guard: must NOT collapse while largeStepEnergyPct rises. Stripping all
      // floor textures pushes largeStepEnergyPct to 46% — past target — while producing
      // the flat "plastic" look the judges condemned. Judge the pair, never the headline.
      fineStepEnergyPct: +(100*fineStepEnergy/Math.max(allStepEnergy,1e-9)).toFixed(2),
      fineStepCountPct: +(100*fineStepCount/Math.max(stepCount,1)).toFixed(2),
      // THE REAL GUARD — absolute, denominator-independent. Deleting texture makes this
      // FALL; adding lit/unlit boundaries leaves it alone. The share-based fine% does not
      // work as a guard: maps-OFF scores large 46% / fine 11.5% and passes a paired
      // share target while being the plastic failure both judges condemned.
      fineStepEnergyAbs: +(fineStepEnergy/Math.max(stepCount,1)).toFixed(6),
      allStepEnergyAbs: +(allStepEnergy/Math.max(stepCount,1)).toFixed(6),
      // BRIGHTNESS-INDEPENDENT STRUCTURE. allStepEnergyAbs correlates with meanLuminance at
      // +0.880 across our stations and the references, so the raw value mostly says "how
      // bright is this frame". Dividing it out isolates structure per unit brightness, which
      // is the cleanest single number for "does this look like PoE2":
      //   ours 0.064-0.129 (mean 0.085)   references 0.188-0.609 (mean 0.362)   -> 4.3x short
      // The decisive case: poe2-10 is DARKER than our crypt (meanL 0.0143 vs 0.0146) yet
      // carries 2.4x the absolute step energy. Brightening slides along the trend line and can
      // clear the absolute floor, but leaves this ratio untouched — so a change that raises
      // allStepEnergyAbs proportionally to meanLuminance added brightness, not structure.
      structurePerLuma: +(allStepEnergy/Math.max(stepCount,1)/Math.max(meanL,1e-9)).toFixed(4),
      // POOL-STRUCTURE SEPARATION — mean(above-mean pixels) minus mean(below-mean pixels)
      // over the scene window. This is the "bright island in darkness" property the rubric
      // calls the most important single criterion, and it separates us from the references
      // at EVERY station where `spatialVariation` did not:
      //     ours 0.130-0.158 at all five stations   references 0.215-0.249
      // nave-wide has our BEST spatialVariation (1.77) and still only 0.158 modeSep, so
      // spatialVariation was not surfacing this deficit at all. A "fill" raises the dark
      // mass and shrinks the gap; an "island" adds bright mass and widens it. Measured
      // consequence: the two rooms that received cool FILL pools have p10 0.045-0.054
      // against the references' 0.012-0.020 and a dynamic range of 5.6x against 14-25x —
      // the fill lifted the black floor, which no amount of extra brightness can undo.
      modeSep: +(sceneModeSep).toFixed(4),
      // EXPOSURE-INVARIANT FORM — use THIS one for acceptance gates. Raw `modeSep` above is
      // brightness-confounded: scaling every pixel by k multiplies it by ~k (measured
      // 0.1584 -> 0.1900 -> 0.2352 at exposure x1.0/1.2/1.5), so an agent can "improve" it
      // by simply brightening the frame. Dividing by mean scene luminance removes that
      // entirely (1.6752 -> 1.6748 -> 1.6660 over the same exposures, 0.5% drift).
      // This is the same failure `allStepEnergyAbs` had and the same fix `structurePerLuma`
      // used — the FIFTH metric in this project to need it. Validated BEFORE agents
      // optimised against it rather than after, which is the only reason it cost nothing.
      modeSepPerLuma: +(sceneModeSep / Math.max(sceneMean, 1e-9)).toFixed(4),
      // THE localContrast GATE IS EXPOSURE-CONFOUNDED, AND THIS IS ITS HONEST FORM.
      // `localContrast` moves +55.2% under a pure x1.25 exposure change, and across our
      // five stations correlation(localContrast, meanLuminance) = +0.963 — the gate is
      // almost entirely reporting brightness. Our "recovery" from 1/5 to 4/5 passing the
      // 0.012 floor was therefore driven largely by agents brightening frames, not by
      // structural gain. Normalised, the verdict REVERSES and the deficit is universal:
      //     ours       0.517 - 0.599   (nave-lit .599, nave-wide .526, courtyard .517,
      //                                 crypt .598, arena .571)
      //     references 0.728 - 0.994   (poe2-05 .921, poe2-07 .759, poe2-09 .728,
      //                                 poe2-11 .994)
      // Zero overlap: our BEST is below the references' WORST. This is why the blind judges
      // kept calling our frames "flat" and "pasted on" while the raw gate read green — the
      // judges were right and the instrument was wrong. Note poe2-05 has the LOWEST mean
      // luminance of any reference (0.0177) and the SECOND-HIGHEST ratio (0.921): the
      // references achieve contrast *at low brightness*, which is the "dark but readable"
      // property we have been failing while passing the gate.
      localContrastPerLuma: +(localContrast / Math.max(meanL, 1e-9)).toFixed(4),
      // CHROMA DIRECTIONAL COHERENCE — the "corduroy striping" three separate blind judges
      // named across four rounds, which survived TWO fixes because every instrument we built
      // measured the wrong channel. Round 12 measured LUMINANCE ridge anisotropy, got 1.086
      // against a reference range of 1.062-1.097, and correctly declared it fixed. The judges
      // kept seeing stripes because the defect is in CHROMA, and chroma directionality had
      // never been measured. A streak correlates ALONG its length and decorrelates ACROSS it,
      // so the ratio of those two chroma autocorrelations isolates it:
      //     references     poe2-07 0.959   poe2-09 1.013   poe2-11 1.002   (isotropic, ~1.00)
      //     ours           1.270                                            (27% coherent)
      //     ours, floor normalMaps stripped at runtime   1.095              (most of the way)
      // So ~45% of it is the floor NORMAL maps carrying a directionally coherent pattern that
      // the two-colour lighting (cool IBL, warm brazier) renders as teal and red 1px streaks.
      // Note the amount of fine chroma is NOT the problem: poe2-07 has chromaP99 0.1255
      // against our 0.0667, nearly 2x MORE high-frequency chroma than us. Only its DIRECTION
      // differs. Target: 1.00 +/- 0.05. Gate this, not luminance anisotropy.
      chromaCoherence: +(chromaCoh).toFixed(4),
    },
    verdictHints: buildHints({
      meanSat, p05, p95, contrastRatio, nearBlack, N, clipped,
      visiblePct: 100*visCount/N, satVisible: visCount ? visSatSum/visCount : null,
      hardEdgeRatio: hardEdges/Math.max(edgePairs,1),
      shadowHueAngle, shadowSat, localContrast, spatialVariation,
      warmPct: 100*warmPix/warmCoolTotal, coolPct: 100*coolPix/warmCoolTotal,
    }),
  };
}

/**
 * Translate raw numbers into rubric language, calibrated against MEASURED Path
 * of Exile 2 gameplay frames (refs/png/poe2-05..12.png, Steam appid 2694490,
 * fetched 2026-08-01). See "MEASURED GROUND TRUTH" at the top of POE2_RUBRIC.md.
 *
 * The thresholds this file originally shipped with were reconstructed from model
 * memory without web access, and were wrong in BOTH directions: they would have
 * failed real PoE2 screenshots as "oversaturated" (measured 0.41 vs a claimed
 * 0.08-0.22 band) and "crushed" (measured up to 10.3% pure black vs a claimed
 * >8% fail), while passing genuinely flat frames because the contrast floor was
 * 4:1 when PoE2 measures ~93:1.
 *
 * Advisory only — the critic still looks at the image. But a hint here means the
 * pixels disagree with any claim that the frame is fine.
 */
function buildHints(m) {
  const h = [];

  // Most diagnostic single number: how much of the frame is lit at all.
  if (m.visiblePct > 75) h.push(`FAIL S3 evenly lit: ${m.visiblePct.toFixed(0)}% of pixels are bright enough to read colour in, vs PoE2's 12-60% (median 25%). PoE2 is a tight POOL of light inside genuine darkness. Kill the global fill, let the frame fall to true black outside the pool, add vignette.`);
  else if (m.visiblePct < 8) h.push(`WARN S3 only ${m.visiblePct.toFixed(0)}% of the frame is visible — darker than PoE2's darkest reference (11.8%). Risks reading as an unlit bug rather than a lit scene.`);

  if (m.contrastRatio < 20) h.push(`FAIL S3 flat lighting: p95/p05 is ${m.contrastRatio.toFixed(1)}:1. Measured PoE2 sits at 93:1 (range 49-362). Add a strong motivated key and let fill fall to black — do NOT lift shadows for "detail".`);
  else if (m.contrastRatio < 40) h.push(`WARN S3 contrast ${m.contrastRatio.toFixed(0)}:1 is below PoE2's 49:1 floor.`);

  if (m.satVisible !== null && m.satVisible !== undefined) {
    if (m.satVisible < 0.18) h.push(`FAIL S2 lit areas are grey: visible-pixel saturation ${m.satVisible.toFixed(2)} vs PoE2's 0.24-0.58 (median 0.49). "Desaturate everything" was a misreading — PoE2's lit 25% is RICHLY coloured (sodium orange, blood red, cold steel blue). Darkness carries the grimness, not greyness.`);
    else if (m.satVisible > 0.62) h.push(`WARN S2 visible-pixel saturation ${m.satVisible.toFixed(2)} exceeds PoE2's 0.58 ceiling — approaching cartoonish.`);
  }

  const blackPct = 100 * m.nearBlack / m.N;
  if (blackPct < 0.3) h.push(`FAIL S2 no true blacks: only ${blackPct.toFixed(2)}% pure black. PoE2 runs 0.5-10.3% (median 4.7%) — genuine darkness is load-bearing. A lifted black floor reads as fog, not night.`);
  else if (blackPct > 14) h.push(`WARN S2 ${blackPct.toFixed(1)}% pure black exceeds PoE2's 10.3% max — verify the lit pool still carries readable detail.`);
  if (100 * m.clipped / m.N > 3) h.push(`WARN S2 ${(100*m.clipped/m.N).toFixed(1)}% clipped to white — filmic rolloff overdriven; reduce exposure or bloom.`);

  // Grey shadows are still wrong, but the chroma may be WARM: measured shadow
  // hue median 69deg, because firelight (not skylight) is the fill in a crypt.
  if (m.shadowHueAngle !== null && m.shadowSat < 0.15 && m.shadowPixelPct > 0.1)
    h.push(`FAIL S2 grey shadows: shadow saturation ${m.shadowSat.toFixed(2)} vs PoE2's 0.15-0.64 (median 0.41). Shadows must pick up chroma from the motivating fill. That chroma may be WARM (firelit crypt, measured ~69deg) or COOL (skylit/arcane) — do not force blue into a brazier-lit room.`);

  if (m.localContrast < 0.008) h.push(`FAIL S4 no micro detail: local contrast ${m.localContrast.toFixed(5)} vs PoE2's 0.0197 (range 0.011-0.067). Surfaces read as untextured plastic. Needs real normal maps, spatially-varying roughness, micro grain.`);
  else if (m.localContrast < 0.012) h.push(`WARN S4 micro detail ${m.localContrast.toFixed(4)} below PoE2's 0.011 floor.`);

  if (m.spatialVariation < 0.45) h.push(`FAIL S3/S5 no focal point: spatial variation ${m.spatialVariation.toFixed(2)} vs PoE2's 1.04 (range 0.75-1.55). Brightness is spread evenly — need distinct pools of light with real darkness between them.`);
  else if (m.spatialVariation < 0.70) h.push(`WARN S3/S5 spatial variation ${m.spatialVariation.toFixed(2)} below PoE2's 0.75 floor.`);

  if (m.hardEdgeRatio !== undefined && m.hardEdgeRatio > 0.014) h.push(`FAIL S6 aliasing: hard-edge ratio ${m.hardEdgeRatio.toFixed(4)} vs PoE2's 0.0048. High-contrast edges are stepping. Enable or strengthen AA.`);

  if (m.warmPct < 4 && m.coolPct < 4) h.push(`WARN S2 no temperature split: warm ${m.warmPct.toFixed(0)}% / cool ${m.coolPct.toFixed(0)}%. One of the two must carry the key.`);

  if (h.length === 0) h.push('No numeric red flags against measured PoE2 targets. Judge composition, materials, silhouette and detail from the image itself.');
  return h;
}
// ------------------------------------------------------------------------ main
const file = process.argv[2];
if (!file) { console.error('usage: analyze.mjs <file.png>'); process.exit(2); }
try {
  const res = analyze(decodePNG(readFileSync(file)));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res));
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
} catch (e) {
  console.error(`analyze failed: ${e.message}`);
  process.exit(1);
}

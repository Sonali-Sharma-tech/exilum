#!/usr/bin/env node
/**
 * Shadow-band hue probe — measures the RENDERED shadow cool/warm lobes.
 *
 * Owner: ShadowTeal. This is a measurement instrument, not shipped code.
 *
 * The percept under test: "a uniform cool-purple fill; darkness lacks receding
 * depth." SHADOW_HUE_FINDINGS.md establishes this is a HUE-VARIANCE problem, not
 * a luminance one. The governing statistic is the circular spread of hue over the
 * shadow band, and the lever is the cool lobe's HUE POSITION (target 150-240deg,
 * teal), not its brightness or the warm/cool ratio.
 *
 * Shadow band (per the finding, and the acceptance criteria):
 *   pixels with max channel in 8-55/255 AND saturation >= 0.05.
 *   HUD EXCLUDED — hue is meaningless in near-black and unstable in near-neutral,
 *   and flat UI graphics contaminate every hue/run statistic (MEASUREMENT_NOTES
 *   errors #7). Bottom ~22% + top-right ~28%.
 *
 * Also reports a luminance-range block over a central crop (y 0.10-0.72,
 * x 0.08-0.92) matching the parent's courtyard measurement, so the courtyard
 * "no darks" fix (p05 / dynamic-range) is measured on the SAME population the
 * target was derived over.
 *
 * Usage: node tools/shadowhue.mjs <file.png> [--json] [--full] [--lumcrop]
 *   --full     do NOT exclude HUD (calibration only)
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = []; let palette = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const A = x >= channels ? cur[x - channels] : 0;
      const B = prev ? prev[x] : 0;
      const C = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break; case 1: v += A; break; case 2: v += B; break;
        case 3: v += (A + B) >> 1; break;
        case 4: { const p = A + B - C; const pa = Math.abs(p-A), pb = Math.abs(p-B), pc = Math.abs(p-C);
          v += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C); break; }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) { const pi = out[i]*3; rgb[i*3]=palette[pi]; rgb[i*3+1]=palette[pi+1]; rgb[i*3+2]=palette[pi+2]; }
    else if (colorType === 0 || colorType === 4) { const g = out[i*channels]; rgb[i*3]=g; rgb[i*3+1]=g; rgb[i*3+2]=g; }
    else { rgb[i*3]=out[i*channels]; rgb[i*3+1]=out[i*channels+1]; rgb[i*3+2]=out[i*channels+2]; }
  }
  return { width, height, rgb };
}

const srgbToLin = (c) => { const s = c/255; return s <= 0.04045 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); };
const luminance = (r,g,b) => 0.2126*srgbToLin(r) + 0.7152*srgbToLin(g) + 0.0722*srgbToLin(b);
function rgbToHsv(r,g,b){ const rr=r/255,gg=g/255,bb=b/255; const max=Math.max(rr,gg,bb),min=Math.min(rr,gg,bb),d=max-min;
  let h=0; if(d!==0){ if(max===rr)h=((gg-bb)/d)%6; else if(max===gg)h=(bb-rr)/d+2; else h=(rr-gg)/d+4; h*=60; if(h<0)h+=360; }
  return { h, s: max===0?0:d/max, v: max }; }
const percentile = (s,p) => s.length ? s[Math.min(s.length-1, Math.max(0, Math.floor(p*(s.length-1))))] : 0;

// HUD mask: bottom ~22% + top-right ~28% (rectangle x>=0.72W & y<=0.30H). Matches
// the "Exclude the HUD from every image measurement" instruction.
function inHUD(x, y, W, H) {
  if (y >= 0.78 * H) return true;                       // bottom bar / flasks / globes
  if (x >= 0.72 * W && y <= 0.30 * H) return true;      // top-right minimap / buffs
  return false;
}

// Warm / cool arcs for the shadow band. Calibrated to reproduce poe2-07's
// finding-table split (warm 53.5 / cool 34.2). Cool arc = the teal→blue lobe the
// task targets (150-240deg). Warm arc = the sodium/ember lobe.
const WARM = (h) => (h >= 330 || h <= 70);
const COOL = (h) => (h >= 150 && h <= 250);

function analyze(file, opts) {
  const { width: W, height: H, rgb } = decodePNG(readFileSync(file));
  // shadow band
  let n = 0, sumC = 0, sumS = 0, sumCw = 0, sumSw = 0, wsum = 0;
  let warm = 0, cool = 0, neutral = 0, satSum = 0;
  let coolC = 0, coolS = 0, coolW = 0;         // cool-lobe circular mean (sat-weighted)
  let warmC = 0, warmS = 0, warmW = 0;
  const hist = new Array(36).fill(0);         // 10deg hue bins over the shadow band
  const hudOff = opts.full ? () => false : inHUD;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (hudOff(x, y, W, H)) continue;
      const i = (y*W + x)*3, r = rgb[i], g = rgb[i+1], b = rgb[i+2];
      const mx = Math.max(r,g,b);
      if (mx < 8 || mx > 55) continue;                  // shadow band by max channel
      const { h, s } = rgbToHsv(r,g,b);
      if (s < 0.05) continue;                            // drop near-neutral: hue unstable
      n++; satSum += s;
      hist[Math.floor(h/10)%36]++;
      const rad = h*Math.PI/180;
      // unweighted circular accumulation (spread of the finding table)
      sumC += Math.cos(rad); sumS += Math.sin(rad);
      // sat-weighted (reported alongside)
      sumCw += Math.cos(rad)*s; sumSw += Math.sin(rad)*s; wsum += s;
      if (WARM(h)) { warm++; warmC += Math.cos(rad)*s; warmS += Math.sin(rad)*s; warmW += s; }
      else if (COOL(h)) { cool++; coolC += Math.cos(rad)*s; coolS += Math.sin(rad)*s; coolW += s; }
      else neutral++;
    }
  }
  const circ = (sc, ss, w, cnt) => {
    const R = Math.hypot(sc, ss) / Math.max(w || cnt, 1e-9);
    const mean = (Math.atan2(ss, sc)*180/Math.PI + 360) % 360;
    const std = Math.sqrt(Math.max(0, -2*Math.log(Math.max(R, 1e-9)))) * 180/Math.PI;
    return { mean: +mean.toFixed(1), spread: +std.toFixed(1), R: +R.toFixed(4) };
  };
  const tot = warm + cool + neutral || 1;
  const uw = circ(sumC, sumS, n, n);            // unweighted
  const sw = circ(sumCw, sumSw, wsum, n);       // sat-weighted
  const coolLobe = cool ? circ(coolC, coolS, coolW, cool) : null;
  const warmLobe = warm ? circ(warmC, warmS, warmW, warm) : null;

  // luminance range over central crop (courtyard "no darks" check)
  const lums = [];
  for (let y = Math.floor(0.10*H); y < Math.floor(0.72*H); y++)
    for (let x = Math.floor(0.08*W); x < Math.floor(0.92*W); x++) {
      const i = (y*W+x)*3; lums.push(luminance(rgb[i], rgb[i+1], rgb[i+2]));
    }
  lums.sort((a,b)=>a-b);
  const p05 = percentile(lums, 0.05), p50 = percentile(lums, 0.50), p95 = percentile(lums, 0.95);

  return {
    file, dims: `${W}x${H}`,
    shadowBand: {
      n, meanSat: +(satSum/Math.max(n,1)).toFixed(4),
      spreadUnweighted: uw.spread, meanHueUnweighted: uw.mean,
      spreadSatWeighted: sw.spread, meanHueSatWeighted: sw.mean,
      warmPct: +(100*warm/tot).toFixed(1), coolPct: +(100*cool/tot).toFixed(1), neutralPct: +(100*neutral/tot).toFixed(1),
      coolLobeHue: coolLobe ? coolLobe.mean : null,
      warmLobeHue: warmLobe ? warmLobe.mean : null,
    },
    lumCrop: {
      p05: +p05.toFixed(4), median: +p50.toFixed(4), p95: +p95.toFixed(4),
      dynamicRange: +(p95/Math.max(p05,1e-5)).toFixed(1),
    },
    hueHist: opts.hist ? hist.map((c,i)=>({deg:i*10, n:c})).filter(b=>b.n>0) : undefined,
  };
}

const file = process.argv[2];
if (!file) { console.error('usage: shadowhue.mjs <file.png> [--json] [--full]'); process.exit(2); }
const opts = { full: process.argv.includes('--full'), hist: process.argv.includes('--hist') };
const res = analyze(file, opts);
console.log(process.argv.includes('--json') ? JSON.stringify(res) : JSON.stringify(res, null, 2));

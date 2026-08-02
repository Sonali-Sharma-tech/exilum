#!/usr/bin/env node
/**
 * Blind A/B comparison sheet builder.
 *
 * Purpose: the user asked for a genuine blind side-by-side. For that to mean
 * anything, three properties must hold:
 *
 *  1. The critic must not know which image is ours. So the two images are
 *     composited into ONE png, left/right assignment chosen by a coin flip
 *     derived from a seed, and labelled only "A" and "B".
 *  2. The answer key is written to a SEPARATE file the critic is never given.
 *  3. Both images are normalised to the same dimensions, so resolution is not
 *     a giveaway. (A 1600x900 render beside a 3840x2160 marketing shot is not a
 *     blind test, it's a resolution test.)
 *
 * Honest limitation, stated plainly: this tool composites whatever two files it
 * is given. It cannot acquire Path of Exile 2 screenshots on its own — no game
 * install, no network in this session. Until a real reference frame is placed in
 * reference/, the "blind" comparison can only run ours-vs-ours (e.g. iteration N
 * vs N+1), which is still genuinely useful for detecting regressions but is NOT
 * the same as beating PoE2. Do not let a passing ours-vs-ours result be reported
 * as "beat PoE2".
 *
 * Zero dependencies: writes an uncompressed-ish PNG via zlib deflate.
 *
 * Usage:
 *   node tools/blind-compare.mjs --a shots/ours.png --b reference/poe2.png \
 *        --out shots/blind.png --key shots/blind.key.json --seed 7
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname } from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

// ------------------------------------------------------------------ PNG decode
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
      if (data[12] !== 0) throw new Error('interlaced unsupported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} unsupported`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`colorType ${colorType} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const A = x >= ch ? cur[x - ch] : 0;
      const B = prev ? prev[x] : 0;
      const C = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += A; else if (f === 2) v += B;
      else if (f === 3) v += (A + B) >> 1;
      else if (f === 4) {
        const p = A + B - C;
        const pa = Math.abs(p - A), pb = Math.abs(p - B), pc = Math.abs(p - C);
        v += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C);
      }
      cur[x] = v & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) { const p = out[i] * 3; rgb[i*3]=palette[p]; rgb[i*3+1]=palette[p+1]; rgb[i*3+2]=palette[p+2]; }
    else if (colorType === 0 || colorType === 4) { const g = out[i*ch]; rgb[i*3]=g; rgb[i*3+1]=g; rgb[i*3+2]=g; }
    else { rgb[i*3]=out[i*ch]; rgb[i*3+1]=out[i*ch+1]; rgb[i*3+2]=out[i*ch+2]; }
  }
  return { width, height, rgb };
}

// ------------------------------------------------------------------ PNG encode
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- resampling
/** Box-filtered downscale / bilinear upscale to an exact target size. */
function resize(src, tw, th) {
  const { width: sw, height: sh, rgb } = src;
  const out = new Uint8Array(tw * th * 3);
  const sxRatio = sw / tw, syRatio = sh / th;
  for (let y = 0; y < th; y++) {
    const sy0 = y * syRatio, sy1 = Math.min(sh, (y + 1) * syRatio);
    for (let x = 0; x < tw; x++) {
      const sx0 = x * sxRatio, sx1 = Math.min(sw, (x + 1) * sxRatio);
      let r = 0, g = 0, b = 0, n = 0;
      const iy0 = Math.floor(sy0), iy1 = Math.max(iy0 + 1, Math.ceil(sy1));
      const ix0 = Math.floor(sx0), ix1 = Math.max(ix0 + 1, Math.ceil(sx1));
      for (let sy = iy0; sy < iy1 && sy < sh; sy++) {
        for (let sx = ix0; sx < ix1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 3;
          r += rgb[i]; g += rgb[i+1]; b += rgb[i+2]; n++;
        }
      }
      const o = (y * tw + x) * 3;
      out[o] = r / n; out[o+1] = g / n; out[o+2] = b / n;
    }
  }
  return { width: tw, height: th, rgb: out };
}

// ------------------------------------------------------------- label rendering
// Tiny 5x7 bitmap font — only the glyphs needed for "A" and "B" panel labels.
const GLYPHS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
};
function stampLabel(img, ch, ox, oy, scale, colour) {
  const g = GLYPHS[ch]; if (!g) return;
  for (let ry = 0; ry < g.length; ry++) {
    for (let rx = 0; rx < g[ry].length; rx++) {
      if (g[ry][rx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = ox + rx * scale + sx, py = oy + ry * scale + sy;
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        const i = (py * img.width + px) * 3;
        img.rgb[i] = colour[0]; img.rgb[i+1] = colour[1]; img.rgb[i+2] = colour[2];
      }
    }
  }
}

// -------------------------------------------------------------------- assemble
const aPath = arg('a'), bPath = arg('b');
const out = arg('out', 'shots/blind.png');
const keyPath = arg('key', 'shots/blind.key.json');
const seed = Number(arg('seed', 1));
const gap = Number(arg('gap', 16));

if (!aPath || !bPath) { console.error('need --a and --b'); process.exit(2); }

const imgA = decodePNG(readFileSync(aPath));
const imgB = decodePNG(readFileSync(bPath));

// Normalise BOTH to identical dimensions. Otherwise resolution, not quality,
// decides the comparison.
const tw = Math.min(imgA.width, imgB.width, 1280);
const th = Math.round(tw * Math.min(imgA.height / imgA.width, imgB.height / imgB.width));
const rA = resize(imgA, tw, th);
const rB = resize(imgB, tw, th);

// Deterministic coin flip: which source goes in the left ("A") panel.
// mulberry32 on the seed, so a given seed always yields the same layout and the
// run is reproducible/auditable after the fact.
let s = (seed + 0x9e3779b9) >>> 0;
s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
const flip = (((s ^ (s >>> 14)) >>> 0) / 4294967296) < 0.5;

const leftSrc  = flip ? rA : rB;
const rightSrc = flip ? rB : rA;
const leftName  = flip ? aPath : bPath;
const rightName = flip ? bPath : aPath;

const W = tw * 2 + gap, H = th;
const sheet = { width: W, height: H, rgb: new Uint8Array(W * H * 3) };
// Neutral mid-grey gutter: pure white or black would bias perceived contrast of
// the adjacent panels.
sheet.rgb.fill(28);

for (let y = 0; y < th; y++) {
  for (let x = 0; x < tw; x++) {
    const si = (y * tw + x) * 3;
    const li = (y * W + x) * 3;
    sheet.rgb[li] = leftSrc.rgb[si]; sheet.rgb[li+1] = leftSrc.rgb[si+1]; sheet.rgb[li+2] = leftSrc.rgb[si+2];
    const ri = (y * W + (x + tw + gap)) * 3;
    sheet.rgb[ri] = rightSrc.rgb[si]; sheet.rgb[ri+1] = rightSrc.rgb[si+1]; sheet.rgb[ri+2] = rightSrc.rgb[si+2];
  }
}

stampLabel(sheet, 'A', 18, 18, 4, [235, 235, 235]);
stampLabel(sheet, 'B', tw + gap + 18, 18, 4, [235, 235, 235]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePNG(W, H, sheet.rgb));
mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, JSON.stringify({
  sheet: out, seed,
  A: leftName, B: rightName,
  note: 'ANSWER KEY — must not be shown to the comparing critic.',
  normalisedTo: `${tw}x${th}`,
}, null, 2));

console.log(JSON.stringify({
  ok: true, sheet: out, key: keyPath, panelSize: `${tw}x${th}`,
  warning: 'Do not reveal the key to the comparing agent.',
}, null, 2));

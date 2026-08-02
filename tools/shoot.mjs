#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 * Boots the vite dev server output (or any URL), waits for the app to signal
 * readiness via window.__FORGE_READY__, then captures a PNG.
 *
 * Readiness is signalled by the app rather than a fixed sleep because GPU
 * pipeline warm-up (shader compile, texture upload) varies wildly between
 * hardware GL and the SwiftShader fallback. A fixed sleep either wastes
 * seconds or races the first frame.
 *
 * Usage:
 *   node tools/shoot.mjs --url http://localhost:5173 --out shots/a.png
 *                        [--w 1600] [--h 900] [--wait 45000] [--settle 400]
 *                        [--gpu] [--scene overgrown_ruins] [--dpr 1]
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true; // bare flag
  return next;
}

const url = arg('url', 'http://localhost:5173');
const out = resolve(arg('out', 'shots/frame.png'));
const width = Number(arg('w', 1600));
const height = Number(arg('h', 900));
const waitMs = Number(arg('wait', 45000));
const settleMs = Number(arg('settle', 400));
const dpr = Number(arg('dpr', 1));
const scene = arg('scene', null);
const wantGpu = arg('gpu', false);

// SwiftShader is the reliable path in headless: real GPU access from a
// detached process is inconsistent on macOS, and a silent fallback to a
// 1x1 context is worse than a slow-but-correct software raster.
const gpuFlags = wantGpu
  ? ['--use-angle=metal', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  protocolTimeout: Math.max(120000, waitMs + 60000),
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-extensions',
    '--force-color-profile=srgb',
    // Keep rAF running even though the page is never foregrounded.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...gpuFlags,
  ],
});

let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    logs.push(`[404] ${r.url()} ${r.failure()?.errorText ?? ''}`));

  const target = scene ? `${url}${url.includes('?') ? '&' : '?'}scene=${scene}` : url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // The app sets window.__FORGE_READY__ = true once it has presented a frame
  // with all shaders compiled and assets resident.
  await page.waitForFunction('window.__FORGE_READY__ === true', {
    timeout: waitMs,
    polling: 250,
  });

  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));

  const diag = await page.evaluate(() => window.__FORGE_DIAG__ ?? null);

  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'png' });

  console.log(JSON.stringify({ ok: true, out, diag, logs: logs.slice(-40) }, null, 2));
} catch (err) {
  code = 1;
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2));
} finally {
  await browser.close();
  process.exit(code);
}

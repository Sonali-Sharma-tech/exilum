import * as THREE from 'three';
import { CFG } from './config.js';
import { Clock } from './clock.js';
import { World } from './world.js';
import { bus, EV } from './events.js';

/**
 * SYSTEM CONTRACT — every subsystem module default-exports:
 *   { name:string, init?(ctx):Promise<void>|void, fixed?(dt,t), frame?(dt,t), resize?(w,h), dispose?() }
 * ctx = { THREE, World, scene, camera, renderer, canvas, bus, EV, CFG }
 * Systems run in registration order. Never import another system directly — use the bus / World.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.systems = [];
    this.clock = new Clock(1 / 60);

    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false, depth: true, alpha: false,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.graphics.maxPixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CFG.graphics.exposure;
    renderer.shadowMap.enabled = true;
    // PCFShadowMap, not PCFSoftShadowMap. In three 0.185 PCFSoftShadowMap is DEPRECATED:
    // WebGLShadowMap.render() warns, silently rewrites `type` to PCFShadowMap, and — because
    // the shadow sampler type changes — walks the whole scene setting `material.needsUpdate`
    // on EVERY material. So asking for PCFSoft bought exactly PCF plus a guaranteed
    // full-scene shader recompile on the first shadow render.
    //
    // Caught by installing a setter tripwire on `shadowMap.type` before boot; the single
    // write recorded was `from 2 to 1` inside WebGLShadowMap.render. Naming the type we
    // actually get removes the recompile and the deprecation warning, and changes no pixels
    // (it was already rendering as PCF from the first shadowed frame onward).
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(CFG.graphics.fog.color, CFG.graphics.fog.density);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(CFG.camera.fov, 1, CFG.camera.near, CFG.camera.far);
    this.camera = camera;

    World.scene = scene; World.camera = camera; World.renderer = renderer;

    this.ctx = { THREE, World, scene, camera, renderer, canvas, bus, EV, CFG };
    addEventListener('resize', () => this.resize(), { passive: true });
  }

  use(sys) { if (sys) this.systems.push(sys); return this; }

  async boot() {
    const n = this.systems.length;
    for (let i = 0; i < n; i++) {
      const s = this.systems[i];
      bus.emit(EV.BOOT_PROGRESS, { frac: i / n, msg: s.name });
      if (s.init) await s.init(this.ctx);
    }
    bus.emit(EV.BOOT_PROGRESS, { frac: 1, msg: 'ready' });
    this.resize();
    this.running = true;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.graphics.maxPixelRatio));
    // `updateStyle` MUST be true. With it false, Three.js sets the canvas width/height
    // ATTRIBUTES to w*pixelRatio but never sets a CSS size — and a canvas's attributes act as
    // its INTRINSIC size, which `position:fixed; inset:0` does not override for a replaced
    // element. So on any display with devicePixelRatio > 1 the canvas was DISPLAYED at
    // attribute size, i.e. 2x too large, and you saw only its top-left quarter.
    //
    // Measured at DPR 2, 1568x1015 (a Retina window) with updateStyle false:
    //     canvas attributes  3136 x 2030   (correct backing store)
    //     canvas CLIENT size 3136 x 2030   (WRONG — must equal the CSS window size)
    //     player renders at  (1568, 1015)  = the bottom-right corner of the visible area
    //     offset from centre (784, 508)    = exactly half the window, in both axes
    // The character appeared beside the mana orb. Every earlier centring test of mine ran at
    // deviceScaleFactor 1, where attribute size and CSS size coincide and the bug is
    // invisible — which is why the projection maths said "offX 0" while the screen disagreed.
    this.renderer.setSize(w, h, true);
    // Belt and braces: pin the CSS box explicitly so the canvas can never fall back to its
    // intrinsic attribute size even if something else calls setSize with updateStyle false.
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h);
  }

  _loop() {
    if (!this.running) return;
    const dt = this.clock.tick((fdt, t) => {
      World.time = t;
      if (World.paused) return;
      World.rebuildHash();
      for (const s of this.systems) s.fixed?.(fdt, t);
    });
    const t = this.clock.elapsed;
    for (const s of this.systems) s.frame?.(dt, t);
    if (World.pipeline?.render) World.pipeline.render(dt);
    else this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }
}

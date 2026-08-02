import * as THREE from 'three';
import { World } from '../core/world.js';
import { buildAtlas, GRID } from '../gen/sprites.js';
import { particleVert, particleFrag } from '../render/shaders/vfx/particle.js';
import { ribbonVert, ribbonFrag } from '../render/shaders/vfx/ribbon.js';
import { decalVert, decalFrag } from '../render/shaders/vfx/decal.js';

/**
 * Pooled GPU particle + ribbon + decal + dynamic-light system.
 *
 * Design goals (rubric §7, contract perf budget):
 *  - Fixed-size pools, InstancedMesh with per-instance attributes. All motion,
 *    fade, size, rotation and colour animation runs in the vertex shader; the
 *    CPU only writes a slot once on spawn and recycles it via a ring buffer.
 *  - Zero allocation after construction: every buffer, temp vector and scratch
 *    is created up front. `emit()` reads a shared descriptor and writes scalars.
 *  - Additive (premultiplied ONE,ONE) and alpha (premultiplied ONE,1-SRC_ALPHA)
 *    pools, depthWrite:false, depth-tested against the scene so walls occlude.
 */

// ------------------------------------------------------------------ blend defs
function additiveBlend(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;          // src already premultiplied
  mat.blendDst = THREE.OneFactor;
}
function alphaBlend(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;          // premultiplied over
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
}

// ------------------------------------------------- shared spawn descriptor
// Mutated in place by emitters and read synchronously by ParticlePool.emit().
// Never retained; scalars are copied into the instance buffers immediately.
export const SPAWN = {
  px: 0, py: 0, pz: 0,
  vx: 0, vy: 0, vz: 0,
  drag: 2.0, gravity: 0.0,
  life: 1.0,
  sizeStart: 1.0, sizeEnd: 1.0,
  rot0: 0.0, spin: 0.0,
  r0: 1, g0: 1, b0: 1,
  r1: 1, g1: 1, b1: 1,
  frame: 0,
  flags: 0,          // 1 stretch, 2 flicker, 4 sparkFade, 8 smokeSwell
  seed: -1,          // <0 -> random
  additive: true,
};
export function resetSpawn() {
  const s = SPAWN;
  s.px = s.py = s.pz = 0; s.vx = s.vy = s.vz = 0;
  s.drag = 2.0; s.gravity = 0.0; s.life = 1.0;
  s.sizeStart = 1.0; s.sizeEnd = 1.0; s.rot0 = 0; s.spin = 0;
  s.r0 = s.g0 = s.b0 = 1; s.r1 = s.g1 = s.b1 = 1;
  s.frame = 0; s.flags = 0; s.seed = -1; s.additive = true;
}

// ---------------------------------------------------------------- ParticlePool
class ParticlePool {
  constructor(capacity, atlas, additive) {
    this.capacity = capacity;
    this.head = 0;
    this.dirty = false;

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    geo.instanceCount = capacity;
    this._base = base;

    const mk = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos  = mk(3); this.aVel  = mk(3);
    this.aCtrl = mk(4); this.aRot  = mk(4);
    this.aCol0 = mk(4); this.aCol1 = mk(4);
    this.aSeed = mk(1);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iCtrl', this.aCtrl);
    geo.setAttribute('iRot', this.aRot);
    geo.setAttribute('iCol0', this.aCol0);
    geo.setAttribute('iCol1', this.aCol1);
    geo.setAttribute('iSeed', this.aSeed);
    // dead by default: birth far past, life tiny -> n>=1 -> culled in shader
    for (let i = 0; i < capacity; i++) this.aCtrl.array[i * 4 + 2] = -1e9;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:  { value: 0 },
        uGrid:  { value: GRID },
        uAtlas: { value: atlas },
      },
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      depthTest: true,
    });
    additive ? additiveBlend(mat) : alphaBlend(mat);
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 11;
    this.geo = geo;
  }

  emit(now) {
    const s = SPAWN, i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.dirty = true;
    const seed = s.seed < 0 ? Math.random() : s.seed;

    let o = i * 3;
    this.aPos.array[o] = s.px; this.aPos.array[o + 1] = s.py; this.aPos.array[o + 2] = s.pz;
    this.aVel.array[o] = s.vx; this.aVel.array[o + 1] = s.vy; this.aVel.array[o + 2] = s.vz;
    o = i * 4;
    this.aCtrl.array[o] = s.drag; this.aCtrl.array[o + 1] = s.gravity;
    this.aCtrl.array[o + 2] = now; this.aCtrl.array[o + 3] = s.life;
    this.aRot.array[o] = s.rot0; this.aRot.array[o + 1] = s.spin;
    this.aRot.array[o + 2] = s.sizeStart; this.aRot.array[o + 3] = s.sizeEnd;
    this.aCol0.array[o] = s.r0; this.aCol0.array[o + 1] = s.g0;
    this.aCol0.array[o + 2] = s.b0; this.aCol0.array[o + 3] = s.frame;
    this.aCol1.array[o] = s.r1; this.aCol1.array[o + 1] = s.g1;
    this.aCol1.array[o + 2] = s.b1; this.aCol1.array[o + 3] = s.flags;
    this.aSeed.array[i] = seed;
  }

  flush(now) {
    this.material.uniforms.uTime.value = now;
    if (!this.dirty) return;
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCtrl.needsUpdate =
      this.aRot.needsUpdate = this.aCol0.needsUpdate = this.aCol1.needsUpdate =
      this.aSeed.needsUpdate = true;
    this.dirty = false;
  }

  dispose() {
    this.geo.dispose(); this.material.dispose(); this._base.dispose();
  }
}

// ------------------------------------------------------------------ Ribbon
const RIB_SEGS = 26;
const _rt = new THREE.Vector3(), _rp = new THREE.Vector3(), _rn = new THREE.Vector3();
const _rview = new THREE.Vector3(), _rside = new THREE.Vector3(), _rtan = new THREE.Vector3();

class Ribbon {
  constructor(material) {
    this.active = false;
    this.mode = 0;          // 0 trail, 1 static
    this.birth = 0; this.life = 1;
    this.width = 0.3;
    this.r = 1; this.g = 1; this.b = 1;
    this.count = 0;
    this.fading = false; this.fadeT = 0; this.fadeDur = 0.16;
    this._pts = new Float32Array(RIB_SEGS * 3);
    this._lastX = 0; this._lastY = 0; this._lastZ = 0;

    const geo = new THREE.BufferGeometry();
    const V = RIB_SEGS * 2;
    this.pos = new THREE.BufferAttribute(new Float32Array(V * 3), 3);
    this.side = new THREE.BufferAttribute(new Float32Array(V), 1);
    this.vcol = new THREE.BufferAttribute(new Float32Array(V * 3), 3);
    this.valpha = new THREE.BufferAttribute(new Float32Array(V), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.vcol.setUsage(THREE.DynamicDrawUsage);
    this.valpha.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < RIB_SEGS; i++) { this.side.array[i * 2] = -1; this.side.array[i * 2 + 1] = 1; }
    const idx = new Uint16Array((RIB_SEGS - 1) * 6);
    for (let i = 0; i < RIB_SEGS - 1; i++) {
      const a = i * 2, b = i * 2 + 6;
      idx[b - 6] = a; idx[b - 5] = a + 2; idx[b - 4] = a + 1;
      idx[b - 3] = a + 1; idx[b - 2] = a + 2; idx[b - 1] = a + 3;
    }
    geo.setAttribute('position', this.pos);
    geo.setAttribute('side', this.side);
    geo.setAttribute('vcol', this.vcol);
    geo.setAttribute('valpha', this.valpha);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 12;
  }

  reset(mode, now) {
    this.active = true; this.mode = mode; this.birth = now; this.count = 0;
    this.fading = false; this.fadeT = 0;
    this.mesh.visible = true;
  }

  setColor(hex) {
    const c = hex;
    this.r = ((c >> 16) & 255) / 255;
    this.g = ((c >> 8) & 255) / 255;
    this.b = (c & 255) / 255;
  }
  setColorRGB(r, g, b) { this.r = r; this.g = g; this.b = b; }

  pushHead(x, y, z) {
    const dx = x - this._lastX, dy = y - this._lastY, dz = z - this._lastZ;
    if (this.count > 0 && dx * dx + dy * dy + dz * dz < 0.0009) return;
    if (this.count === RIB_SEGS) {
      this._pts.copyWithin(0, 3, RIB_SEGS * 3);
      this.count = RIB_SEGS - 1;
    }
    const o = this.count * 3;
    this._pts[o] = x; this._pts[o + 1] = y; this._pts[o + 2] = z;
    this.count++;
    this._lastX = x; this._lastY = y; this._lastZ = z;
  }

  setPoints(flat, n) {
    this.count = Math.min(n, RIB_SEGS);
    for (let i = 0; i < this.count * 3; i++) this._pts[i] = flat[i];
  }

  beginFade() { this.fading = true; this.fadeT = 0; }

  update(now, dt, camPos) {
    if (!this.active) return;
    let overall = 1;
    if (this.mode === 1) {
      const n = (now - this.birth) / this.life;
      if (n >= 1) { this.release(); return; }
      overall = (1 - this._smooth(0.4, 1, n)) * this._smooth(0, 0.08, n);
      // ease-in fast, ease-out
      overall = Math.max(0, overall);
    }
    if (this.fading) {
      this.fadeT += dt;
      overall *= Math.max(0, 1 - this.fadeT / this.fadeDur);
      if (this.fadeT >= this.fadeDur) { this.release(); return; }
    }
    const c = this.count;
    if (c < 2 || overall <= 0.001) { this.mesh.visible = false; return; }
    this.mesh.visible = true;

    const P = this._pts, pos = this.pos.array, vcol = this.vcol.array, val = this.valpha.array;
    for (let i = 0; i < c; i++) {
      const o = i * 3;
      _rp.set(P[o], P[o + 1], P[o + 2]);
      // tangent from neighbours
      const pi = Math.max(0, i - 1), ni = Math.min(c - 1, i + 1);
      _rn.set(P[ni * 3], P[ni * 3 + 1], P[ni * 3 + 2]);
      _rt.set(P[pi * 3], P[pi * 3 + 1], P[pi * 3 + 2]);
      _rtan.subVectors(_rn, _rt);
      if (_rtan.lengthSq() < 1e-8) _rtan.set(0, 1, 0);
      _rtan.normalize();
      _rview.subVectors(camPos, _rp).normalize();
      _rside.crossVectors(_rtan, _rview);
      if (_rside.lengthSq() < 1e-8) _rside.set(1, 0, 0);
      _rside.normalize();

      const t = c > 1 ? i / (c - 1) : 1;       // 0 tail .. 1 head
      const taper = Math.sin(t * Math.PI * 0.5); // fatter toward head
      const hw = this.width * (0.15 + 0.85 * taper);
      const vo = i * 6;                          // 2 verts * 3
      pos[vo]     = _rp.x - _rside.x * hw; pos[vo + 1] = _rp.y - _rside.y * hw; pos[vo + 2] = _rp.z - _rside.z * hw;
      pos[vo + 3] = _rp.x + _rside.x * hw; pos[vo + 4] = _rp.y + _rside.y * hw; pos[vo + 5] = _rp.z + _rside.z * hw;

      const a = overall * Math.pow(t, 0.6);       // fade toward tail, non-linear
      const va = i * 2;
      val[va] = a; val[va + 1] = a;
      const co = i * 6;
      vcol[co] = this.r; vcol[co + 1] = this.g; vcol[co + 2] = this.b;
      vcol[co + 3] = this.r; vcol[co + 4] = this.g; vcol[co + 5] = this.b;
    }
    this.pos.needsUpdate = true;
    this.vcol.needsUpdate = true;
    this.valpha.needsUpdate = true;
    this.geo.setDrawRange(0, (c - 1) * 6);
  }

  _smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

  release() {
    this.active = false; this.fading = false; this.count = 0;
    this.mesh.visible = false;
    this.geo.setDrawRange(0, 0);
  }
}

class RibbonPool {
  constructor(count) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: ribbonVert,
      fragmentShader: ribbonFrag,
      side: THREE.DoubleSide,
      depthTest: true,
    });
    additiveBlend(this.material);
    this.ribbons = [];
    for (let i = 0; i < count; i++) this.ribbons.push(new Ribbon(this.material));
  }
  acquire(mode, now) {
    for (const r of this.ribbons) if (!r.active) { r.reset(mode, now); return r; }
    return null;
  }
  update(now, dt, camPos) { for (const r of this.ribbons) r.update(now, dt, camPos); }
  addTo(scene) { for (const r of this.ribbons) scene.add(r.mesh); }
  dispose() { this.material.dispose(); for (const r of this.ribbons) r.geo.dispose(); }
}

// ---------------------------------------------------------------- DecalField
class DecalField {
  constructor(capacity, atlas, additive, renderOrder) {
    this.capacity = capacity; this.head = 0; this.dirty = false;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    geo.instanceCount = capacity;
    this._base = base;
    const mk = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage); return a;
    };
    this.aPos = mk(3); this.aCtrl = mk(4); this.aData = mk(4); this.aColor = mk(3);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iCtrl', this.aCtrl);
    geo.setAttribute('iData', this.aData);
    geo.setAttribute('iColor', this.aColor);
    for (let i = 0; i < capacity; i++) this.aCtrl.array[i * 4] = -1e9;

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAtlas: { value: atlas }, uGrid: { value: GRID } },
      vertexShader: decalVert, fragmentShader: decalFrag, depthTest: true,
    });
    additive ? additiveBlend(mat) : alphaBlend(mat);
    // ground decals: push depth back a touch to avoid z-fight with the floor
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.geo = geo;
  }

  // mode, frame, param(z), color rgb, pos, scale, yaw, life, seed
  emit(now, mode, frame, r, g, b, x, y, z, scale, yaw, life, param, seed) {
    const i = this.head; this.head = (this.head + 1) % this.capacity; this.dirty = true;
    let o = i * 3;
    this.aPos.array[o] = x; this.aPos.array[o + 1] = y; this.aPos.array[o + 2] = z;
    o = i * 4;
    this.aCtrl.array[o] = now; this.aCtrl.array[o + 1] = life;
    this.aCtrl.array[o + 2] = scale; this.aCtrl.array[o + 3] = yaw;
    this.aData.array[o] = mode; this.aData.array[o + 1] = frame;
    this.aData.array[o + 2] = param; this.aData.array[o + 3] = seed;
    o = i * 3;
    this.aColor.array[o] = r; this.aColor.array[o + 1] = g; this.aColor.array[o + 2] = b;
  }

  flush(now) {
    this.material.uniforms.uTime.value = now;
    if (!this.dirty) return;
    this.aPos.needsUpdate = this.aCtrl.needsUpdate = this.aData.needsUpdate = this.aColor.needsUpdate = true;
    this.dirty = false;
  }
  dispose() { this.geo.dispose(); this.material.dispose(); this._base.dispose(); }
}

// ------------------------------------------------------------------ LightPool
class DynLight {
  constructor() {
    this.light = new THREE.PointLight(0xffffff, 0, 18, 2);
    this.light.castShadow = false;
    this.light.visible = false;
    this.active = false; this.birth = 0; this.life = 1;
    this.base = 10; this.priority = 0; this.flicker = 0;
    this.steady = false; this._owner = null;
  }
}
class LightPool {
  constructor(count) {
    this.lights = [];
    for (let i = 0; i < count; i++) this.lights.push(new DynLight());
  }
  addTo(scene) { for (const l of this.lights) scene.add(l.light); }
  acquire(now, priority) {
    let free = null, victim = null;
    for (const l of this.lights) {
      if (!l.active) { free = l; break; }
      if (!victim || l.priority < victim.priority ||
        (l.priority === victim.priority && l.birth < victim.birth)) victim = l;
    }
    const l = free || (victim && victim.priority <= priority ? victim : null);
    if (!l) return null;
    // stealing a light from a steady (aura) owner: sever that ownership so the
    // old owner re-acquires cleanly instead of double-driving this light.
    if (l._owner) { l._owner = null; l.steady = false; }
    l.active = true; l.birth = now; l.priority = priority; l.light.visible = true;
    return l;
  }
  update(now, dt) {
    for (const l of this.lights) {
      if (!l.active) continue;
      if (l.steady) {
        // aura/loot: constant output (position + intensity refreshed by owner),
        // never auto-expires — released explicitly when the owner ends.
        const fl = l.flicker > 0 ? (1 - l.flicker + l.flicker * (0.5 + 0.5 * Math.sin(now * 26 + l.birth * 13))) : 1;
        l.light.intensity = l.base * fl;
        continue;
      }
      const n = (now - l.birth) / l.life;
      if (n >= 1) { l.active = false; l.light.visible = false; l.light.intensity = 0; continue; }
      // quick rise, then a GENTLE lingering decay (pow 0.7 holds ~62% at half-life)
      // so the light reads as a persistent glow washing the floor, not a 4-8 frame spike.
      const env = Math.min(1, n / 0.05) * Math.pow(1 - n, 0.7);
      const fl = l.flicker > 0 ? (1 - l.flicker + l.flicker * (0.5 + 0.5 * Math.sin(now * 40 + l.birth * 13))) : 1;
      l.light.intensity = l.base * env * fl;
    }
  }
  dispose() {}
}

// ---------------------------------------------------------- ParticleSystem
const _cam = new THREE.Vector3();

export class ParticleSystem {
  constructor(scene, camera, cfg) {
    this.scene = scene; this.camera = camera; this.cfg = cfg;
    this.now = 0;
    this.atlas = buildAtlas();

    this.additive = new ParticlePool(cfg.poolAdditive, this.atlas, true);
    this.alpha = new ParticlePool(cfg.poolAlpha, this.atlas, false);
    scene.add(this.additive.mesh, this.alpha.mesh);

    this.bloodDecals = new DecalField(cfg.bloodDecals, this.atlas, false, 3);
    this.groundFx = new DecalField(cfg.groundFx, this.atlas, true, 5);
    scene.add(this.bloodDecals.mesh, this.groundFx.mesh);

    this.ribbons = new RibbonPool(cfg.ribbons);
    this.ribbons.addTo(scene);

    this.lights = new LightPool(cfg.lights);
    this.lights.addTo(scene);

    // projectile -> trail ribbon map (bounded, entries only on new projectiles)
    this.projTrails = new Map();
    this._epoch = 0;
    // hoisted cull callback (Map.forEach passes value,key with no pair alloc;
    // deleting the current entry mid-forEach is well-defined) — zero per-frame alloc.
    this._cullTrail = (r, p) => {
      if (r._epoch !== this._epoch) {
        this.projTrails.delete(p);
        if (r.active) r.beginFade();
      }
    };
  }

  emit() {
    (SPAWN.additive ? this.additive : this.alpha).emit(this.now);
  }

  emitDecalBlood(frame, r, g, b, x, y, z, scale, yaw, life, seed) {
    this.bloodDecals.emit(this.now, 0, frame, r, g, b, x, y, z, scale, yaw, life, 0, seed);
  }
  emitScorch(r, g, b, x, y, z, scale, yaw, life, seed) {
    this.bloodDecals.emit(this.now, 1, 0, r, g, b, x, y, z, scale, yaw, life, 0, seed);
  }
  emitMagicCircle(r, g, b, x, y, z, scale, yaw, life, seed) {
    this.groundFx.emit(this.now, 2, 0, r, g, b, x, y, z, scale, yaw, life, 0, seed);
  }
  emitTelegraph(r, g, b, x, y, z, scale, yaw, life, duration, seed) {
    this.groundFx.emit(this.now, 3, 0, r, g, b, x, y, z, scale, yaw, life, duration, seed);
  }
  emitLootGlow(r, g, b, x, y, z, scale, yaw, life, seed) {
    this.groundFx.emit(this.now, 4, 0, r, g, b, x, y, z, scale, yaw, life, 0, seed);
  }
  emitDotField(r, g, b, x, y, z, scale, yaw, life, seed) {
    this.groundFx.emit(this.now, 5, 0, r, g, b, x, y, z, scale, yaw, life, 0, seed);
  }

  acquireRibbon(mode) { return this.ribbons.acquire(mode, this.now); }
  acquireLight(priority) { return this.lights.acquire(this.now, priority); }

  // Auto-attach velocity-aligned trails to live projectiles (combat-owned).
  _scanProjectiles() {
    const list = World.projectiles;
    if (!Array.isArray(list)) return;
    this._epoch++;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.alive === false || !p.pos) continue;
      let r = this.projTrails.get(p);
      if (!r) {
        r = this.acquireRibbon(0);
        if (!r) continue;
        r.setColor(p.color != null ? p.color : 0xffb060);
        r.width = (p.radius || 0.3) * 1.6;
        r._lastX = r._lastY = r._lastZ = 1e9;
        this.projTrails.set(p, r);
      }
      r._epoch = this._epoch;
      r.pushHead(p.pos.x, p.pos.y, p.pos.z);
    }
    // detach ribbons whose projectile vanished this frame (no pair alloc)
    this.projTrails.forEach(this._cullTrail);
  }

  update(dt) {
    this.now += dt;
    const now = this.now;
    this.camera.getWorldPosition(_cam);

    this._scanProjectiles();

    this.additive.flush(now);
    this.alpha.flush(now);
    this.bloodDecals.flush(now);
    this.groundFx.flush(now);
    this.ribbons.update(now, dt, _cam);
    this.lights.update(now, dt);
  }

  dispose() {
    this.additive.dispose(); this.alpha.dispose();
    this.bloodDecals.dispose(); this.groundFx.dispose();
    this.ribbons.dispose(); this.lights.dispose();
    this.atlas.dispose();
  }
}

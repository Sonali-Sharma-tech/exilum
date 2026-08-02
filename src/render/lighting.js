// EXILIUM — lighting/atmosphere helpers owned by SkyAtmos.
// Colour-temperature conversion, screen-space volumetric god rays (exposed as a
// THREE.Pass the RenderPipeline inserts), camera-anchored atmospheric particulate
// (dust motes / embers / spores), and a subtle drifting ground-mist layer.
//
// Everything here is procedural — no external assets — pooled, and allocation-free
// in the per-frame hot path (temp vectors hoisted to module scope).
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { World } from '../core/world.js';
import { lightColor } from '../gen/propgen.js';

// ---------------------------------------------------------------- temp scratch
const _v = /*@__PURE__*/ new THREE.Vector3();

// ------------------------------------------------------------ colour temperature
// Tanner Helland's black-body approximation. Returns an sRGB-authored THREE.Color
// (three converts to linear internally), so a "2900K" sun reads as amber/sodium
// and a "9000K" sky reads cold blue — the physical basis for the §2 warm-key /
// cool-shadow temperature split.
export function kelvinToColor(kelvin, target = new THREE.Color()) {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (x) => THREE.MathUtils.clamp(x, 0, 255) / 255;
  target.setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
  return target;
}

// ---------------------------------------------------------------- god rays
// Screen-space radial light-shafts (crepuscular rays) marched from the sun's
// projected screen position, masked to genuinely bright pixels so shafts only
// emit from the motivated source (visible sky/emissive), never a global haze.
// Additive over the read buffer; fades out as the sun leaves the frustum.
const GODRAY_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2  uSunPos;      // sun screen position in UV space
  uniform float uIntensity;   // master strength, fades w/ sun visibility
  uniform float uDecay;       // per-sample attenuation along the shaft
  uniform float uDensity;     // shaft length (spacing of samples)
  uniform float uWeight;      // contribution per sample
  uniform float uThreshold;   // luminance below this does not shaft
  varying vec2 vUv;
  const int SAMPLES = 48;
  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    if (uIntensity <= 0.0001) { gl_FragColor = base; return; }
    vec2 delta = (vUv - uSunPos) * (uDensity / float(SAMPLES));
    vec2 uv = vUv;
    float illum = 1.0;
    vec3 accum = vec3(0.0);
    for (int i = 0; i < SAMPLES; i++) {
      uv -= delta;
      vec2 cuv = clamp(uv, 0.0, 1.0);
      vec3 s = texture2D(tDiffuse, cuv).rgb;
      float l = max(max(s.r, s.g), s.b);
      float m = smoothstep(uThreshold, uThreshold + 0.6, l);
      accum += s * m * illum;
      illum *= uDecay;
    }
    accum *= (uWeight / float(SAMPLES));
    // Warm-bias the shaft so rays read as sodium/dusk light, not white glare.
    accum *= vec3(1.08, 0.94, 0.72);
    gl_FragColor = vec4(base.rgb + accum * uIntensity, base.a);
  }
`;
const GODRAY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class GodRayPass extends Pass {
  constructor(getCamera, getSunWorldPos) {
    super();
    this._getCamera = getCamera;
    this._getSunWorldPos = getSunWorldPos;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: null },
        uSunPos:    { value: new THREE.Vector2(0.5, 0.9) },
        uIntensity: { value: 0.0 },
        uDecay:     { value: 0.965 },
        uDensity:   { value: 0.62 },
        uWeight:    { value: 0.30 },
        uThreshold: { value: 0.90 },
      },
      vertexShader: GODRAY_VERT,
      fragmentShader: GODRAY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.strength = 0.9; // ceiling; scaled by on-screen sun visibility
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    const cam = this._getCamera();
    const u = this.material.uniforms;
    if (cam) {
      _v.copy(this._getSunWorldPos()).project(cam);
      const behind = _v.z > 1.0;
      const sx = _v.x * 0.5 + 0.5, sy = _v.y * 0.5 + 0.5;
      u.uSunPos.value.set(sx, sy);
      // Fade with how far the sun is outside the [0,1] frame + behind camera.
      const ox = Math.max(0, Math.max(-sx, sx - 1), Math.max(-sy, sy - 1));
      const edge = THREE.MathUtils.clamp(1.0 - ox * 2.2, 0.0, 1.0);
      u.uIntensity.value = behind ? 0.0 : this.strength * edge;
    } else {
      u.uIntensity.value = 0.0;
    }
    u.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

// ---------------------------------------------------------------- dust field
// A single pooled Points cloud anchored to a box that follows the camera, so it
// never runs out. Vertex shader drifts each mote; three particle classes share
// the buffer (0 dust, 1 ember, 2 spore). Soft round additive sprites — never
// hard squares. Occlusion works because points depth-test against scene geometry.
// The number of nearest scene casters sampled per mote. World carries ~54 static
// braziers/torches; 16 nearest covers every pool a camera-boxed mote can sit in
// (fire range <=16, box half-extent 46), evaluated per-vertex — 2600*16 cheap MADs.
const DUST_MAX_LIGHTS = 16;
const DUST_VERT = /* glsl */`
  attribute float aSeed;
  attribute float aType;   // 0 dust, 1 ember, 2 spore
  attribute float aSize;
  uniform vec3  uCamPos;
  uniform vec3  uBox;      // half-extents of the follow volume
  uniform float uTime;
  uniform float uScale;    // px size scale
  uniform float uMotivate; // 0 = legacy self-emissive, 1 = lit by the scene (A/B)
  uniform float uKnee;     // accumulated irradiance -> visibility soft knee
  uniform vec3  uAmbient;  // cool sky/IBL tint a mote takes when unlit (shadow)
  uniform vec3  uDust;     // legacy per-type colours (A/B "before" path only)
  uniform vec3  uEmber;
  uniform vec3  uSpore;
  uniform vec4  uLightPos[${DUST_MAX_LIGHTS}]; // xyz world pos, w = range (0 = empty slot)
  uniform vec3  uLightCol[${DUST_MAX_LIGHTS}]; // rgb colour premultiplied by intensity
  uniform vec3  uFloor;    // ambient visibility floor per class (x dust, y ember, z spore)
  uniform vec3  uExpo;     // in-pool exposure gain per class (x dust, y ember, z spore)
  varying vec3  vColL;     // legacy colour (pre-flicker)
  varying vec3  vColN;     // motivated tint (colour of what lights the mote)
  varying float vFL;       // legacy flicker * near-fade
  varying float vBN;       // motivated brightness * twinkle * near-fade
  void main() {
    float sp = 6.2831853 * aSeed;
    vec3 drift;
    if (aType > 1.5) {
      // spores: lazy horizontal wander, near-neutral vertical
      drift = vec3(sin(uTime*0.11 + sp)*1.7, sin(uTime*0.07 + sp*1.7)*0.5, cos(uTime*0.09 + sp*0.6)*1.7);
    } else if (aType > 0.5) {
      // embers: rise + flicker, faster
      drift = vec3(sin(uTime*0.5 + sp)*0.9, uTime*0.9 + aSeed*40.0, cos(uTime*0.4 + sp)*0.9);
    } else {
      // dust: slow sway + gentle settle
      drift = vec3(sin(uTime*0.18 + sp)*2.4, -uTime*0.35 - aSeed*8.0, cos(uTime*0.14 + sp*1.3)*2.4);
    }
    vec3 wp = position + drift;
    // wrap into a box centred on the camera so the field is always full
    vec3 rel = wp - uCamPos;
    vec3 span = uBox * 2.0;
    rel = mod(rel + uBox, span) - uBox;
    vec3 world = uCamPos + rel;

    // --- MOTIVATION: accumulate the scene's illumination AT the mote ----------
    // A mote is dust/spark, not a light: it is only as bright as the light that
    // reaches its world position, and it takes that light's colour. This is what
    // makes it belong to the scene — it flares inside a brazier pool and vanishes
    // in shadow as it drifts, instead of self-glowing as a fixed-colour sprite.
    float E = 0.0;            // scalar irradiance proxy
    vec3  acc = vec3(0.0);    // colour * irradiance, for the illuminant hue
    for (int i = 0; i < ${DUST_MAX_LIGHTS}; i++) {
      float rng = uLightPos[i].w;
      if (rng > 0.0) {
        vec3  dv = world - uLightPos[i].xyz;
        float d  = length(dv);
        float win = 1.0 - pow(clamp(d / rng, 0.0, 1.0), 4.0); // three's range window
        win *= win;
        float att = win / (1.0 + d * d);                      // soft inverse-square
        vec3  ci  = uLightCol[i];
        float inten = max(max(ci.r, ci.g), ci.b);             // intensity proxy
        E   += inten * att;
        acc += ci * att;
      }
    }
    float sat = E / (E + uKnee);                 // 0 in shadow -> ~1 deep in a pool
    vec3  lit = acc / max(E, 1e-3);              // chromaticity of the illuminant
    vec3  tintN = mix(uAmbient, lit, smoothstep(0.0, uKnee * 0.4, E));

    // per-class visibility response: dust/spore keep a faint floor for depth cue;
    // embers get a near-zero floor + high exposure so they read ONLY as hot sparks
    // inside fire and dim out as they rise and cool — never free-floating orbs.
    float floorV, expo, tw;
    if (aType > 1.5) {        // spore
      floorV = uFloor.z; expo = uExpo.z; tw = 0.60 + 0.40 * sin(uTime*1.1 + sp*2.0);
    } else if (aType > 0.5) { // ember
      floorV = uFloor.y; expo = uExpo.y; tw = 0.55 + 0.45 * sin(uTime*9.0 + sp*3.0);
    } else {                  // dust
      floorV = uFloor.x; expo = uExpo.x; tw = 0.65 + 0.35 * sin(uTime*1.3 + sp*2.0);
    }
    float brightN = (floorV + expo * (1.0 - floorV) * sat) * tw;

    // legacy self-emissive path, preserved for same-tree A/B via uMotivate
    vColL = (aType > 1.5) ? uSpore : (aType > 0.5) ? uEmber : uDust;
    float flickL = (aType > 0.5 && aType < 1.5)
      ? 0.55 + 0.45 * sin(uTime*9.0 + sp*3.0)
      : 0.6 + 0.4 * sin(uTime*1.3 + sp*2.0);

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    // fade motes very close to the camera to avoid big blurry blobs over the lens
    float near = smoothstep(1.2, 5.0, -mv.z);
    gl_PointSize = aSize * uScale * near / max(-mv.z, 0.5);
    vFL   = flickL * near;
    vBN   = brightN * near;
    vColN = tintN;
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAG = /* glsl */`
  precision mediump float;
  uniform float uMotivate;
  varying vec3  vColL;
  varying vec3  vColN;
  varying float vFL;
  varying float vBN;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);      // soft round falloff
    a *= a;
    // legacy: fixed per-type colour * flicker
    vec3  rgbL = vColL * vFL; float aL = a * vFL;
    // motivated: illuminant tint * scene-driven brightness
    vec3  rgbN = vColN * vBN; float aN = a * clamp(vBN, 0.0, 1.0);
    gl_FragColor = vec4(mix(rgbL, rgbN, uMotivate), mix(aL, aN, uMotivate));
  }
`;

export class DustField {
  constructor({ count = 2600, box = new THREE.Vector3(46, 26, 46) } = {}) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const type = new Float32Array(count);
    const size = new Float32Array(count);
    const span = { x: box.x * 2, y: box.y * 2, z: box.z * 2 };
    for (let i = 0; i < count; i++) {
      pos[i*3]   = Math.random() * span.x;
      pos[i*3+1] = Math.random() * span.y;
      pos[i*3+2] = Math.random() * span.z;
      seed[i] = Math.random();
      const r = Math.random();
      // mostly dust, a scatter of embers, some spores
      type[i] = r < 0.72 ? 0 : r < 0.86 ? 1 : 2;
      size[i] = type[i] === 1 ? 5.0 + Math.random() * 5.0        // embers a touch bigger
              : type[i] === 2 ? 6.0 + Math.random() * 6.0        // spores soft/large
              : 2.2 + Math.random() * 3.6;                       // dust fine
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aType', new THREE.BufferAttribute(type, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never frustum-cull

    // light-sampling scratch, sized to the caster set on first update
    this._lightPos = [];
    this._lightCol = [];
    for (let i = 0; i < DUST_MAX_LIGHTS; i++) {
      this._lightPos.push(new THREE.Vector4(0, 0, 0, 0));
      this._lightCol.push(new THREE.Vector3(0, 0, 0));
    }
    this._order = null; this._dist = null;
    this._tmpCol = new THREE.Color();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCamPos:   { value: new THREE.Vector3() },
        uBox:      { value: box.clone() },
        uTime:     { value: 0 },
        uScale:    { value: 90.0 },
        // motivated by default; set to 0 for the legacy self-emissive "before".
        uMotivate: { value: 1.0 },
        uKnee:     { value: 7.0 },
        // cool skylight/IBL chroma a mote reflects when no fire reaches it
        uAmbient:  { value: new THREE.Color().setRGB(0.34, 0.46, 0.60, THREE.SRGBColorSpace) },
        uDust:     { value: new THREE.Color().setRGB(0.42, 0.50, 0.66, THREE.SRGBColorSpace).multiplyScalar(0.5) },
        uEmber:    { value: new THREE.Color().setRGB(1.0, 0.52, 0.16, THREE.SRGBColorSpace) },
        uSpore:    { value: new THREE.Color().setRGB(0.5, 0.66, 0.6, THREE.SRGBColorSpace).multiplyScalar(0.4) },
        // per-class visibility floor (ambient, unlit) and in-pool exposure gain:
        // x dust, y ember, z spore. Ember floor near-zero so sparks read only in fire.
        uFloor:    { value: new THREE.Vector3(0.09, 0.015, 0.06) },
        uExpo:     { value: new THREE.Vector3(1.0, 1.7, 1.0) },
        uLightPos: { value: this._lightPos },
        uLightCol: { value: this._lightCol },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'atmos-dust';
  }

  // Pack the nearest DUST_MAX_LIGHTS scene casters (World.lightSources) into the
  // shader uniforms so each mote can be lit by them. Static (no per-frame flicker)
  // on purpose: the motes carry their own twinkle and the bench needs the field
  // deterministic. Empty slots keep w=0 and are skipped in the shader.
  _packLights(camPos) {
    const ls = World.lightSources;
    const n = Array.isArray(ls) ? ls.length : 0;
    const gain = World.lighting?.brazierIntensity ?? 1;
    if (!n) { for (let i = 0; i < DUST_MAX_LIGHTS; i++) this._lightPos[i].w = 0; return; }
    if (!this._order || this._order.length !== n) {
      this._order = new Int32Array(n); this._dist = new Float32Array(n);
    }
    const ord = this._order, dst = this._dist;
    for (let i = 0; i < n; i++) {
      const s = ls[i];
      const dx = s.x - camPos.x, dy = s.y - camPos.y, dz = s.z - camPos.z;
      dst[i] = dx*dx + dy*dy + dz*dz; ord[i] = i;
    }
    const m = Math.min(DUST_MAX_LIGHTS, n);
    for (let a = 0; a < m; a++) {           // partial selection of the m nearest
      let best = a;
      for (let b = a + 1; b < n; b++) if (dst[ord[b]] < dst[ord[best]]) best = b;
      const t = ord[a]; ord[a] = ord[best]; ord[best] = t;
    }
    for (let i = 0; i < DUST_MAX_LIGHTS; i++) {
      if (i < m) {
        const s = ls[ord[i]];
        this._lightPos[i].set(s.x, s.y, s.z, s.range || 12);
        const c = this._tmpCol.copy(lightColor(s.type));
        const inten = (s.baseInt || 20) * gain;
        this._lightCol[i].set(c.r * inten, c.g * inten, c.b * inten);
      } else {
        this._lightPos[i].w = 0;
      }
    }
  }

  update(t, camPos) {
    this.material.uniforms.uTime.value = t;
    this.material.uniforms.uCamPos.value.copy(camPos);
    this._packLights(camPos);
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- ground mist
// A camera-following plane just above the floor with animated fbm coverage. Very
// low, patchy, cool additive haze that pools in the near field — reinforces
// aerial perspective and shadow chroma without a global black-lifting fog sheet.
const MIST_VERT = /* glsl */`
  varying vec2 vWorld;
  varying float vDist;
  uniform vec3 uCamPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xz;
    vDist = distance(wp.xz, uCamPos.xz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const MIST_FRAG = /* glsl */`
  precision mediump float;
  varying vec2 vWorld;
  varying float vDist;
  uniform float uTime;
  uniform float uStrength;
  uniform vec3  uColorWarm;  // warm amber mist patch (firelit near sources)
  uniform vec3  uColorCool;  // cool teal mist patch (skylit / damp)
  // cheap value-noise fbm
  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }
  float fbm(vec2 p){
    float v=0.0, amp=0.5;
    for(int i=0;i<4;i++){ v+=amp*noise(p); p*=2.03; amp*=0.5; }
    return v;
  }
  void main() {
    vec2 uv = vWorld * 0.045;
    float n = fbm(uv + vec2(uTime*0.02, uTime*0.015));
    n *= fbm(uv*2.1 - vec2(uTime*0.013, 0.0));
    float cover = smoothstep(0.12, 0.55, n);
    // band the mist to the mid/far field so the immediate floor stays crisp,
    // and fade it out at the far ring so it never becomes a wall.
    float ring = smoothstep(4.0, 12.0, vDist) * (1.0 - smoothstep(34.0, 52.0, vDist));
    float a = cover * ring * uStrength;
    if (a < 0.002) discard;
    // Patchy HUE (ShadowHue): a LOW-frequency selector (bigger cells than the
    // coverage noise, slow independent drift) splits the mist into warm-amber vs
    // cool-teal regions, so the floor shadow band it tints carries genuine hue
    // VARIANCE between neighbouring patches instead of one flat wash. This is the
    // axis the moon + dome IBL cannot reach: up-facing floors integrate a
    // near-uniform hemisphere, so their shadow hue is otherwise a single value.
    // Energy is UNCHANGED — only the hue of the SAME alpha is redistributed and
    // the two colours are luminance-matched, so additive lift equals the old flat
    // mist and pureBlack/visible are untouched.
    float sel = smoothstep(0.38, 0.62, fbm(vWorld * 0.012 + vec2(uTime*0.006, -uTime*0.004)));
    vec3 col = mix(uColorCool, uColorWarm, sel);
    gl_FragColor = vec4(col * a, a);
  }
`;

export class GroundMist {
  constructor({ size = 200, height = 0.55 } = {}) {
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:     { value: 0 },
        uStrength: { value: 0.16 },
        uColorWarm:{ value: new THREE.Color().setRGB(0.52, 0.35, 0.15, THREE.SRGBColorSpace) }, // amber patch, hue ~33, lum-matched to old flat mist
        uColorCool:{ value: new THREE.Color().setRGB(0.10, 0.42, 0.56, THREE.SRGBColorSpace) }, // teal patch, hue ~198, lum-matched; patch split gives floor shadow hue variance
        uCamPos:   { value: new THREE.Vector3() },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = height;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'atmos-mist';
  }

  update(t, camPos) {
    this.material.uniforms.uTime.value = t;
    this.material.uniforms.uCamPos.value.copy(camPos);
    // follow the camera, snapped to the noise grid so the pattern doesn't swim
    this.mesh.position.x = Math.round(camPos.x);
    this.mesh.position.z = Math.round(camPos.z);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

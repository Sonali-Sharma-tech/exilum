import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Heavy-hit screen feedback as a self-contained THREE.Pass. VFX drives the
 * `impact` amplitude; RenderPipeline may adopt this pass into its composer
 * (World.vfxScreenPass) and calls render() in the chain. We do NOT build our
 * own EffectComposer — this is a passive pass others may consume.
 *
 * Effect: a brief radial shockwave lens distortion emanating from a focus point
 * plus a damage-typed edge tint and a punchy chromatic split, all decaying with
 * `impact`. When impact ~ 0 it is a cheap passthrough copy.
 */

const frag = /* glsl */`
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uImpact;     // 0..1 current amplitude
  uniform float uTime;       // seconds since last hit
  uniform vec2  uFocus;      // screen-space focus (0..1)
  uniform vec3  uTint;       // damage-typed tint colour
  uniform float uAspect;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    if (uImpact < 0.002) { gl_FragColor = texture2D(tDiffuse, uv); return; }

    vec2 d = uv - uFocus;
    d.x *= uAspect;
    float dist = length(d);

    // expanding shockwave ring — displacement peaks at the ring front
    float front = uTime * 1.6;
    float ring = exp(-pow((dist - front) * 7.0, 2.0));
    float disp = ring * uImpact * 0.035;
    vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
    dir.x /= uAspect;

    // chromatic split scaled by impact
    float ca = uImpact * 0.006 * (0.5 + ring);
    vec2 off = dir * disp;
    float rC = texture2D(tDiffuse, uv - off + dir * ca).r;
    float gC = texture2D(tDiffuse, uv - off).g;
    float bC = texture2D(tDiffuse, uv - off - dir * ca).b;
    vec3 col = vec3(rC, gC, bC);

    // edge tint pulse (vignette-weighted so it never washes the centre)
    float edge = smoothstep(0.25, 0.95, length((uv - 0.5) * vec2(uAspect, 1.0)));
    col += uTint * uImpact * edge * 0.5;
    // brief full-frame flash on the ring front for the connect
    col += uTint * ring * uImpact * 0.25;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const vert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

export class VfxScreenPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      uImpact:  { value: 0 },
      uTime:    { value: 0 },
      uFocus:   { value: new THREE.Vector2(0.5, 0.5) },
      uTint:    { value: new THREE.Color(1, 1, 1) },
      uAspect:  { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
    this._fsq = new FullScreenQuad(this.material);
  }

  /** Called by VFX each frame to advance decay and by hits to punch amplitude. */
  setImpact(amp) { this.uniforms.uImpact.value = amp; }
  setFocus(x, y) { this.uniforms.uFocus.value.set(x, y); }
  setTint(r, g, b) { this.uniforms.uTint.value.setRGB(r, g, b); }
  setHitTime(t) { this.uniforms.uTime.value = t; }
  setAspect(a) { this.uniforms.uAspect.value = a; }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._fsq.render(renderer);
  }

  setSize() { /* aspect updated via setAspect from resize */ }

  dispose() {
    this.material.dispose();
    this._fsq.dispose();
  }
}

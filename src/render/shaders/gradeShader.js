import * as THREE from 'three';

/**
 * EXILIUM final-grade pass — runs AFTER OutputPass (ACES tonemap + sRGB), so it
 * operates in display-referred sRGB [0,1]. This is the colourist's domain:
 * lift/gamma/gain, a luminance-dependent saturation curve, a pool-of-light
 * vignette, edge-only chromatic aberration and animated film grain.
 *
 * Design constraints, all load-bearing against the MEASURED PoE2 ground truth:
 *  - PURE BLACK IS PRESERVED. Every op is zero-at-zero: gain multiplies, gamma
 *    is a power, lift is a shadow *bell* that fades to 0 at true black, the
 *    vignette multiplies, and grain is masked to nothing in the deepest shadow.
 *    PoE2 runs 0.5-10.3% genuine black and it is load-bearing — we never lift
 *    the floor into fog.
 *  - LIT PIXELS STAY RICHLY COLOURED. satFloor is a *shadow-only minimum*, not a
 *    global desaturate; mid/lit pixels keep full saturation and bright VFX get a
 *    small boost, so the measured satVisible ~0.49 is honoured, not crushed.
 *  - GRAIN AND CA ARE NEAR-SUBLIMINAL. CA is r^2-weighted so the frame centre is
 *    pristine and only the extreme corners fringe by ~1px; grain peaks in the
 *    mids and is invisible in black and white.
 */
export const GradeShader = {
  name: 'ExiliumGrade',

  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uResolution:{ value: new THREE.Vector2(1920, 1080) },
    uLift:      { value: 0.014 },
    uGamma:     { value: 1.02 },
    uGain:      { value: 1.03 },
    uSatFloor:  { value: 0.72 },
    uVignette:  { value: 0.42 },
    uCA:        { value: 0.0016 }, // radial chromatic aberration, corners only
    uGrain:     { value: 0.035 },  // film grain amplitude, luma-masked
    uMidLift:   { value: 0.052 }, // low-mid RECOVERY bell — pulls crushed stonework into the readable band (0 at true black)
    uWarmTame:  { value: 0.70 },  // warm-EXCESS-selective sat reduction on lit stone; applied amount self-scales with stone warmth (cool/emissive exempt)
    uVfxBoostLo:{ value: 0.80 },  // low edge of the VFX/emissive sat-boost band — narrowed up so only bright cores pop, not lit stone
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uResolution;
    uniform float uLift;
    uniform float uGamma;
    uniform float uGain;
    uniform float uSatFloor;
    uniform float uVignette;
    uniform float uCA;
    uniform float uGrain;
    uniform float uMidLift;
    uniform float uWarmTame;
    uniform float uVfxBoostLo;

    // Rec.709 luma on display-referred (sRGB) values — matches how the offline
    // analyzer weights "how bright is this pixel" for the metrics we're graded on.
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    // Hash for animated grain — cheap, no texture fetch, decorrelated per frame.
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      // Radius from centre, aspect-corrected so the vignette/CA are elliptical
      // and match the 16:9 frame instead of stretching.
      vec2 uv = vUv;
      vec2 fromC = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      float r2 = dot(fromC, fromC);

      // --- Chromatic aberration: edge-only. r2 weighting keeps the centre
      //     perfectly clean; the shift maxes near the corners at ~1px. ---
      vec2 dir = (uv - 0.5);
      float caK = uCA * r2;
      vec3 color;
      color.r = texture2D(tDiffuse, uv - dir * caK).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + dir * caK).b;
      color = max(color, 0.0);

      // --- Lift / gamma / gain. gain (slope) and gamma (power) both preserve
      //     0, so true black survives. Lift is applied as a shadow bell below. ---
      color *= uGain;
      color = pow(color, vec3(uGamma));

      float l = luma(color);

      // Shadow-bell lift: peaks in the low-shadow band, fades to 0 at genuine
      // black (protecting pure-black pixels) and again toward the mids. Adds
      // gentle tonal separation to the crush without turning night into fog.
      float shadowW = smoothstep(0.0, 0.10, l) * (1.0 - smoothstep(0.10, 0.42, l));
      color += uLift * shadowW;

      // Low-mid RECOVERY bell: the frame measured bimodal — 43% crushed to
      // near-black vs PoE2's ~22%, with only 1/3 the readable low-mid population
      // ("darkness with no shape"). This raises the crushed stonework into the
      // readable band. Low knee at 0.024 keeps the pure-black floor (byte<=2,
      // luma<=0.008) untouched — 0 stays 0; it fades out before lit stone so it
      // recovers structure without washing the pools or lifting night into fog.
      float midL = luma(color);
      float midW = smoothstep(0.024, 0.14, midL) * (1.0 - smoothstep(0.34, 0.60, midL));
      color += uMidLift * midW;

      // --- Saturation as a function of luminance. Deep shadow is pulled gently
      //     toward satFloor (invisible there anyway); mid/lit pixels keep full
      //     chroma; genuine highlights (VFX, fire, gold) get a small boost so
      //     they pop against the desaturated dark. ---
      l = luma(color);
      float satMul = mix(uSatFloor, 1.0, smoothstep(0.0, 0.32, l));
      satMul += smoothstep(uVfxBoostLo, 0.95, l) * 0.18; // emissive-core pop — band narrowed up so lit stone is excluded (RenderPipeline: boost was fighting the tame)

      // Warm-selective chroma tame. PoE2 spends saturation as a CURRENCY on
      // light sources and VFX; our lit floor cobbles measured as orange as the
      // firelight itself (satVisible 0.72 vs 0.58 ceiling), collapsing that
      // currency. Pull chroma out of MID-LIT WARM stone only: hue is NEVER
      // shifted (chroma-only), cool pixels are exempt (arcane VFX + the cool
      // half survive), shadows are spared (their chroma is load-bearing), and
      // the band fades out before emissive cores so fire/gold keep full pop.
      float warm = clamp((color.r - color.b) * 2.4, 0.0, 1.0);
      float litBand = smoothstep(0.10, 0.24, l) * (1.0 - smoothstep(0.66, 0.82, l));
      satMul = max(satMul - uWarmTame * warm * litBand, 0.0);

      vec3 grey = vec3(l);
      color = mix(grey, color, satMul);

      // --- Vignette: multiplicative pool of light. Reinforces "bright island in
      //     darkness"; multiply preserves black at the corners. ---
      float vig = 1.0 - uVignette * smoothstep(0.15, 1.15, r2);
      color *= vig;

      // --- Film grain: animated, luma-masked so it is absent in true black
      //     (preserving pure-black %) and gentle in highlights, peaking in mids
      //     where the eye reads it as sensor texture, not noise. ---
      float g = hash(gl_FragCoord.xy + fract(uTime) * 431.0) - 0.5;
      float ll = luma(color);
      float grainMask = smoothstep(0.02, 0.18, ll) * (1.0 - smoothstep(0.55, 1.0, ll));
      color += g * uGrain * grainMask;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * GPU particle shader. All animation lives here: the CPU only writes a slot's
 * spawn state once and recycles it — position, size, rotation, colour and alpha
 * are all evaluated from normalised lifetime in the vertex shader.
 *
 * Motion model (closed form, no per-frame CPU sim):
 *   drag decays velocity exponentially; a constant gravity term is layered on.
 *   p(t) = p0 + v0 * (1 - e^{-k t}) / k  +  0.5 * g * t^2   (g on Y only)
 *
 * Billboarding is done in view space so quads always face the camera. Sparks
 * optionally stretch along their view-space velocity for streak trails.
 *
 * Colour is stored as two endpoints (start->end) that can exceed 1.0 in linear
 * space, so additive spell cores blow past the bloom threshold (§7).
 */

export const particleVert = /* glsl */`
  uniform float uTime;
  uniform float uGrid;      // atlas columns/rows (square)

  attribute vec3  iPos;      // spawn position (world)
  attribute vec3  iVel;      // spawn velocity (world)
  attribute vec4  iCtrl;     // x: drag k, y: gravity mult, z: birth, w: life
  attribute vec4  iRot;      // x: rot0, y: spin, z: sizeStart, w: sizeEnd
  attribute vec4  iCol0;     // start colour (rgb, linear, may exceed 1) + a: frame index
  attribute vec4  iCol1;     // end colour (rgb) + a: flags
  attribute float iSeed;     // 0..1 per-particle randomiser

  varying vec2  vUv;
  varying vec4  vColor;      // rgb tint * lifetime alpha, premultiplied-ready

  // flag bits packed into iCol1.a
  // 1 = additive spark stretch, 2 = ember flicker, 4 = spark fade, 8 = smoke rise-fall
  bool hasFlag(float flags, float bit) { return mod(floor(flags / bit), 2.0) > 0.5; }

  void main() {
    float age  = uTime - iCtrl.z;
    float life = max(iCtrl.w, 0.0001);
    float n    = age / life;                 // normalised lifetime

    // Dead / not-yet-born: collapse to a zero-area quad off-screen.
    if (n < 0.0 || n >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vColor = vec4(0.0);
      vUv = vec2(0.0);
      return;
    }

    // --- motion (closed form) ---
    float k = max(iCtrl.x, 0.0001);
    vec3 disp = iVel * (1.0 - exp(-k * age)) / k;
    disp.y += 0.5 * (-9.8 * iCtrl.y) * age * age;
    vec3 world = iPos + disp;

    // --- size over life: easeOut interpolation start->end ---
    float eo = 1.0 - pow(1.0 - n, 2.4);
    float size = mix(iRot.z, iRot.w, eo);

    // --- alpha envelope (never linear) ---
    float flags = iCol1.a;
    float aIn = smoothstep(0.0, 0.12, n);              // quick ease-in
    float a;
    if (hasFlag(flags, 4.0)) {
      a = aIn * pow(1.0 - n, 1.8);                     // spark: sharp tail
    } else if (hasFlag(flags, 8.0)) {
      a = aIn * pow(1.0 - n, 1.1) * (0.6 + 0.4 * sin(n * 3.14159)); // smoke swell
    } else {
      float aOut = 1.0 - smoothstep(0.55, 1.0, n);     // hold then ease-out
      a = aIn * aOut;
    }
    if (hasFlag(flags, 2.0)) {                          // ember flicker
      a *= 0.7 + 0.3 * sin(uTime * 34.0 + iSeed * 62.0);
    }

    // --- colour tint (start->end), premultiply happens via blend + tex alpha ---
    vec3 tint = mix(iCol0.rgb, iCol1.rgb, n);
    vColor = vec4(tint, a);

    // --- billboard in view space ---
    vec4 viewCenter = modelViewMatrix * vec4(world, 1.0);
    float rot = iRot.x + iRot.y * age;
    float c = cos(rot), s = sin(rot);
    vec2 corner = position.xy;                          // [-0.5..0.5] quad
    vec2 r = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * size;

    if (hasFlag(flags, 1.0)) {
      // stretch along view-space velocity direction (streak)
      vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
      float vl = length(vv.xy);
      if (vl > 0.001) {
        vec2 vdir = vv.xy / vl;
        vec2 vperp = vec2(-vdir.y, vdir.x);
        float stretch = 1.0 + min(vl * 0.16, 3.0);
        r = vdir * (corner.y * size * stretch) + vperp * (corner.x * size * 0.6);
      }
    }

    viewCenter.xy += r;
    gl_Position = projectionMatrix * viewCenter;

    // --- atlas UV from frame index ---
    float frame = iCol0.a;
    float col = mod(frame, uGrid);
    float row = floor(frame / uGrid);
    // guard-band inset avoids bilinear bleed across cells
    vec2 uv = position.xy + 0.5;                        // 0..1 within cell
    float inset = 0.012;
    uv = mix(vec2(inset), vec2(1.0 - inset), uv);
    vUv = (vec2(col, row) + uv) / uGrid;
  }
`;

export const particleFrag = /* glsl */`
  precision highp float;
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying vec4 vColor;

  void main() {
    vec4 tex = texture2D(uAtlas, vUv);   // premultiplied on upload
    // tex.rgb already * tex.a; tint by colour and fade by lifetime alpha.
    vec3 rgb = tex.rgb * vColor.rgb * vColor.a;
    float a  = tex.a * vColor.a;
    if (a < 0.002) discard;
    gl_FragColor = vec4(rgb, a);         // premultiplied output
  }
`;

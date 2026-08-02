/**
 * Ground decal / telegraph shader. Ground-projected quads laid flat on the play
 * surface, oriented by a per-instance yaw. A single instanced field renders many
 * modes so blood, scorch, magic circles, telegraphs and loot glows all share one
 * draw call. Fully procedural per mode (blood samples the atlas; the rest are
 * generated from UV maths) — this reads instantly at iso distance without hard
 * squares (§7).
 *
 * modes: 0 blood, 1 scorch, 2 magicCircle, 3 telegraph, 4 lootGlow, 5 dotField
 */

export const decalVert = /* glsl */`
  uniform float uTime;

  attribute vec3  iPos;      // world centre
  attribute vec4  iCtrl;     // x: birth, y: life, z: scale, w: yaw
  attribute vec4  iData;     // x: mode, y: frame(blood), z: fill(0..1), w: seed
  attribute vec3  iColor;    // linear colour (may exceed 1 for additive modes)

  varying vec2  vUv;
  varying vec3  vColor;
  varying float vAge;        // normalised
  varying vec4  vData;
  varying float vSeed;

  void main() {
    float age = uTime - iCtrl.x;
    float life = max(iCtrl.y, 0.0001);
    float n = age / life;
    if (n < 0.0 || n >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vUv = vec2(0.0); vColor = vec3(0.0); vAge = 1.0; vData = vec4(0.0); vSeed = 0.0;
      return;
    }
    vUv = position.xy + 0.5;          // 0..1
    vColor = iColor;
    vAge = n;
    vData = iData;
    vSeed = iData.w;

    float s = iCtrl.z;
    float c = cos(iCtrl.w), sn = sin(iCtrl.w);
    // quad lies in XZ plane (ground). position.xy -> local XZ.
    vec2 p = position.xy * s;
    vec2 rp = vec2(p.x * c - p.y * sn, p.x * sn + p.y * c);
    vec3 world = iPos + vec3(rp.x, 0.0, rp.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

export const decalFrag = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform sampler2D uAtlas;
  uniform float uGrid;

  varying vec2  vUv;
  varying vec3  vColor;
  varying float vAge;
  varying vec4  vData;
  varying float vSeed;

  const float PI = 3.14159265;
  const float TAU = 6.28318530;

  void main() {
    float mode = vData.x;
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;             // 0 centre .. 1 edge
    float ang = atan(c.y, c.x);
    vec3 rgb; float a;

    if (mode < 0.5) {
      // ----- BLOOD: sample atlas splat, tint dark red, very long fade -----
      float frame = vData.y;
      float col = mod(frame, uGrid), row = floor(frame / uGrid);
      vec2 uv = (vec2(col, row) + vUv * (1.0 - 0.02) + 0.01) / uGrid;
      vec4 tex = texture2D(uAtlas, uv);    // premultiplied
      float fade = 1.0 - smoothstep(0.55, 1.0, vAge);   // hold, then ease out
      a = tex.a * fade;
      // tex already premultiplied white*alpha; retint to blood via vColor
      rgb = vColor * a;
      gl_FragColor = vec4(rgb, a);
      if (a < 0.003) discard;
      return;

    } else if (mode < 1.5) {
      // ----- SCORCH: soft dark radial with charred rim -----
      float body = (1.0 - smoothstep(0.2, 1.0, r));
      float rim = smoothstep(0.55, 0.72, r) * (1.0 - smoothstep(0.72, 0.95, r));
      float fade = 1.0 - smoothstep(0.5, 1.0, vAge);
      a = (body * 0.75 + rim * 0.35) * fade;
      rgb = vColor * a;
      gl_FragColor = vec4(rgb, a);
      if (a < 0.003) discard;
      return;

    } else if (mode < 2.5) {
      // ----- MAGIC CIRCLE: rotating rune rings, additive -----
      float rot = uTime * 0.6 + vSeed * TAU;
      float aa = ang + rot;
      float ring1 = smoothstep(0.02, 0.0, abs(r - 0.92));
      float ring2 = smoothstep(0.02, 0.0, abs(r - 0.72));
      float ring3 = smoothstep(0.015, 0.0, abs(r - 0.5));
      // rune ticks between the two outer rings
      float ticks = step(0.55, abs(sin(aa * 12.0))) * smoothstep(0.72, 0.92, r) * (1.0 - smoothstep(0.92, 0.98, r));
      // spokes
      float spokes = step(0.94, abs(sin(aa * 6.0))) * smoothstep(0.1, 0.72, r) * (1.0 - smoothstep(0.72, 0.8, r));
      float inRunes = step(0.6, abs(sin(-aa * 8.0 + 1.3))) * smoothstep(0.35, 0.5, r) * (1.0 - smoothstep(0.5, 0.56, r));
      float glyph = ring1 * 0.9 + ring2 * 0.7 + ring3 * 0.5 + ticks * 0.9 + spokes * 0.5 + inRunes * 0.7;
      float glow = pow(1.0 - clamp(r, 0.0, 1.0), 2.6) * 0.5;   // soft emissive underlay -> luminous, not line-art
      float edge = 1.0 - smoothstep(0.92, 1.0, r);             // feather rim to zero (no hard polygon edge)
      float pulse = 0.75 + 0.25 * sin(uTime * 3.0 + vSeed * 10.0);
      float appear = smoothstep(0.0, 0.15, vAge);
      float fade = 1.0 - smoothstep(0.7, 1.0, vAge);
      a = (glyph + glow) * pulse * appear * fade * edge;
      rgb = vColor * a;
      gl_FragColor = vec4(rgb, a);
      if (a < 0.003) discard;
      return;

    } else if (mode < 3.5) {
      // ----- TELEGRAPH: danger ring + radial sweep-fill wind-up -----
      float fill = vAge;                    // sweeps 0..1 over life==windup, completes at strike
      // sweep angle: 0 at top, clockwise
      float sweep = mod(-ang / TAU + 0.25, 1.0);
      float filled = step(sweep, fill);
      float glowBody = filled * pow(1.0 - clamp(r, 0.0, 1.0), 1.8) * 0.5;  // soft emissive fill -> bloom, not flat
      float body = filled * (1.0 - smoothstep(0.85, 1.0, r)) * 0.22;
      float ringOuter = smoothstep(0.035, 0.0, abs(r - 0.9));
      float ringInner = smoothstep(0.025, 0.0, abs(r - 0.12));
      float lead = smoothstep(0.06, 0.0, abs(sweep - fill)) * (1.0 - smoothstep(0.88, 1.0, r));  // leading edge glow
      float strike = smoothstep(0.9, 1.0, fill) * (0.5 + 0.5 * sin(uTime * 40.0));               // strike flash as fill completes
      float edge = 1.0 - smoothstep(0.95, 1.0, r);            // feather rim (kills hard polygon edge)
      float appear = smoothstep(0.0, 0.08, vAge);
      a = (glowBody + body + ringOuter * 0.9 + ringInner * 0.6 + lead * 0.9 + strike) * appear * edge;
      rgb = vColor * a * (1.0 + strike);
      gl_FragColor = vec4(rgb, a);
      if (a < 0.003) discard;
      return;

    } else if (mode < 4.5) {
      // ----- LOOT GLOW: soft additive ground pool under a beam -----
      float body = pow(1.0 - r, 2.4);
      float pulse = 0.8 + 0.2 * sin(uTime * 2.4 + vSeed * 6.0);
      float appear = smoothstep(0.0, 0.4, vAge);
      float fade = 1.0 - smoothstep(0.85, 1.0, vAge);
      a = body * pulse * appear * fade;
      rgb = vColor * a;
      gl_FragColor = vec4(rgb, a);
      if (a < 0.003) discard;
      return;
    } else if (mode < 5.5) {
      // ----- DOT FIELD: turbulent additive ground haze with edge ring -----
      float body = (1.0 - smoothstep(0.3, 1.0, r));
      float churn = 0.5 + 0.5 * sin(vUv.x * 18.0 + uTime * 1.7 + vSeed * 9.0)
                        * sin(vUv.y * 15.0 - uTime * 1.3);
      float edge = smoothstep(0.04, 0.0, abs(r - 0.9)) * 0.6;
      float appear = smoothstep(0.0, 0.2, vAge);
      float fade = 1.0 - smoothstep(0.8, 1.0, vAge);
      a = (body * (0.4 + 0.6 * churn) + edge) * appear * fade;
      rgb = vColor * a;
      if (a < 0.003) discard;
      gl_FragColor = vec4(rgb, a);
      return;
    }

    // ----- SHOCKWAVE: expanding bright ring conforming to the ground -----
    // ease-out expansion: front races out then settles at the rim
    float front = 1.0 - pow(1.0 - vAge, 2.0);
    float thick = mix(0.16, 0.05, vAge);
    float band = exp(-pow((r - front) / thick, 2.0));
    float lead = smoothstep(0.06, 0.0, abs(r - front)) * (r < front ? 0.4 : 1.0);
    float fade = 1.0 - smoothstep(0.55, 1.0, vAge);
    a = (band * 0.9 + lead * 0.5) * fade;
    rgb = vColor * a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(rgb, a);
  }
`;

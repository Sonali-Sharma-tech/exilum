/**
 * Ribbon/trail shader. Geometry is a two-sided vertex strip whose spine points
 * are updated on the CPU (projectile history, weapon-swing arc, beam, chain).
 * The shader softens the cross-section edge and applies a per-vertex colour and
 * alpha so a single material serves every ribbon. Premultiplied additive output
 * so trails glow and cross the bloom threshold.
 */

export const ribbonVert = /* glsl */`
  attribute float side;      // -1..1 across ribbon width
  attribute vec3  vcol;      // per-vertex colour (linear, may exceed 1)
  attribute float valpha;    // per-vertex alpha along the ribbon

  varying float vSide;
  varying vec3  vCol;
  varying float vAlpha;

  void main() {
    vSide = side;
    vCol = vcol;
    vAlpha = valpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const ribbonFrag = /* glsl */`
  precision highp float;
  varying float vSide;
  varying vec3  vCol;
  varying float vAlpha;

  void main() {
    // soft feather toward the ribbon edges (no hard band)
    float edge = 1.0 - abs(vSide);
    float soft = smoothstep(0.0, 0.6, edge);
    float a = soft * vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vCol * a, a);   // premultiplied additive
  }
`;

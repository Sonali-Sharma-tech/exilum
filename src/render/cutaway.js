// cutaway.js — punch a soft hole in level geometry that stands between the camera and
// the player, so the character is never hidden by a wall.
//
// The bug this fixes: the player IS at the exact screen centre (verified by projecting him
// and measuring 0px offset from window centre at several window shapes), but at some
// positions a merged wall mesh draws over him and he simply vanishes. An occlusion oracle —
// compare the centre pixel with the world drawn vs the player drawn alone — found it at 1 of
// 9 sampled spots, including the exact position the user screenshotted.
//
// Why a shader and not "hide the wall": the level bakes each kit piece into ONE merged mesh
// (`kit-wallAshlar` is a single 41,052-triangle object spanning the whole dungeon), so there
// is no per-wall object to hide and no per-wall material to fade — hiding it would delete
// every wall in the level at once.
//
// Method: for each fragment, work in VIEW space where the camera sits at the origin. Build
// the axis from the camera to the player. A fragment is occluding if it is (a) closer to the
// camera than the player and (b) within `radius` of that axis — i.e. inside the tube swept
// between camera and character. Those fragments are DISCARDED with a Bayer dither so the
// edge reads as a soft fade rather than a hard-edged hole.
//
// Discard, not alpha: keeping the material opaque means no transparency sorting, no blend
// cost, and no interaction with the depth-prepass or shadow passes. Screen-door transparency
// buys the soft look for free.
import * as THREE from 'three';
import { World } from '../core/world.js';

// Shared uniforms — one object, referenced by every patched material, updated once a frame.
export const CUT = {
  uCutPlayerView: { value: new THREE.Vector3(0, 0, -1) },
  // Radius swept on-frame at the position the user screenshotted (56.8, 4.8), where a merged
  // wall block drew directly over the character:
  //   1.55 — hole too small; only a sliver of shield rim visible
  //   2.60 — head, shoulders, chest glow and sword arm all clearly readable  <-- chosen
  //   3.60 — WORSE. The hole grows past the figure and cuts the wall BEHIND him too,
  //          removing the dark backdrop he reads against, so he goes darker not clearer.
  // That last leg is the useful one: the cutaway must expose the character WITHOUT deleting
  // his silhouette contrast, so bigger is not monotonically better.
  uCutRadius:     { value: 2.6 },    // world units at the player's depth
  uCutEnabled:    { value: 1 },
};

const _v = new THREE.Vector3();

/** Update the shared uniform from the live camera + player. Call once per frame. */
export function updateCutaway(camera, playerPos) {
  // Expose for runtime tuning + on-frame A/B sweeps, the same pattern the lighting system
  // uses. Without a handle here the uniform is unreachable from the page and every radius
  // change costs a rebuild.
  if (!World.cutaway) World.cutaway = CUT;
  if (!camera || !playerPos) { CUT.uCutEnabled.value = 0; return; }
  // Aim at the chest, not the feet — a hole centred on the feet leaves the head covered.
  _v.set(playerPos.x, playerPos.y + 1.0, playerPos.z).applyMatrix4(camera.matrixWorldInverse);
  CUT.uCutPlayerView.value.copy(_v);
  CUT.uCutEnabled.value = 1;
}

const VERT_DECL = /* glsl */`
varying vec3 vCutView;
`;
const VERT_BODY = /* glsl */`
  vCutView = (modelViewMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_DECL = /* glsl */`
varying vec3 vCutView;
uniform vec3  uCutPlayerView;
uniform float uCutRadius;
uniform float uCutEnabled;

// 4x4 Bayer matrix — an ordered dither gives a stable, non-shimmering soft edge, unlike a
// per-frame random which crawls when the camera moves.
float cutBayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float t =
    i == 0  ? 0.0625 : i == 1  ? 0.5625 : i == 2  ? 0.1875 : i == 3  ? 0.6875 :
    i == 4  ? 0.8125 : i == 5  ? 0.3125 : i == 6  ? 0.9375 : i == 7  ? 0.4375 :
    i == 8  ? 0.2500 : i == 9  ? 0.7500 : i == 10 ? 0.1250 : i == 11 ? 0.6250 :
    i == 12 ? 1.0000 : i == 13 ? 0.5000 : i == 14 ? 0.8750 : 0.3750;
  return t;
}
`;
const FRAG_BODY = /* glsl */`
  if (uCutEnabled > 0.5) {
    float playerDist = length(uCutPlayerView);
    float fragDist   = length(vCutView);
    // 0.55 keeps geometry the player is standing ON or just behind from being cut.
    if (fragDist < playerDist - 0.55) {
      vec3  axis = uCutPlayerView / max(playerDist, 1e-4);
      float t    = dot(vCutView, axis);
      float r    = length(vCutView - axis * t);
      // Widen the tube slightly toward the camera so the hole is a cone, not a cylinder:
      // near-camera geometry covers more screen area per world unit.
      float widen = mix(1.0, 1.9, clamp(1.0 - fragDist / max(playerDist, 1e-4), 0.0, 1.0));
      float rad   = uCutRadius * widen;
      if (r < rad) {
        // 1.0 fully cut at the centre, 0.0 at the rim
        float cut = 1.0 - smoothstep(rad * 0.45, rad, r);
        if (cut > cutBayer(gl_FragCoord.xy)) discard;
      }
    }
  }
`;

/**
 * Patch a material so it participates in the cutaway. Safe to call more than once —
 * a flag on the material prevents double-injection.
 */
export function patchCutaway(material) {
  if (!material || material.__cutPatched) return material;
  material.__cutPatched = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.uniforms.uCutPlayerView = CUT.uCutPlayerView;
    shader.uniforms.uCutRadius     = CUT.uCutRadius;
    shader.uniforms.uCutEnabled    = CUT.uCutEnabled;

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', VERT_DECL + '\nvoid main() {')
      // project_vertex is where `transformed` and `mvPosition` exist
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', FRAG_DECL + '\nvoid main() {')
      // clipping_planes_fragment runs first in main() — discard before any lighting work
      .replace('#include <clipping_planes_fragment>',
               '#include <clipping_planes_fragment>\n' + FRAG_BODY);
  };
  material.needsUpdate = true;
  return material;
}

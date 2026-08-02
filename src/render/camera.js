import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { World } from '../core/world.js';
import { Input } from '../core/input.js';
import { bus, EV } from '../core/events.js';
import { updateCutaway } from './cutaway.js';

/** Isometric follow-cam with cursor lead, spring damping, and impact shake. */
const shake = { amp: 0, freq: 26, t: 0 };
bus.on(EV.CAMERA_SHAKE, (a = 0.25) => { shake.amp = Math.min(shake.amp + a, 1.1); });

const target = new THREE.Vector3();
const follow = new THREE.Vector3();      // the point the camera centres on = the player
const desired = new THREE.Vector3();
const offset = new THREE.Vector3();
let zoom = 1;

function computeOffset() {
  const el = THREE.MathUtils.degToRad(CFG.camera.elevationDeg);
  const yaw = THREE.MathUtils.degToRad(CFG.camera.yawDeg);
  const d = CFG.camera.distance * zoom;
  offset.set(Math.sin(yaw) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(yaw) * Math.cos(el) * d);
  return offset;
}

export default {
  name: 'camera',
  init({ camera }) {
    camera.position.copy(computeOffset());
    camera.lookAt(0, 0, 0);
  },
  frame(dt) {
    const cam = World.camera, p = World.player;
    if (!cam) return;
    Input.update(cam);
    if (Input.wheel) zoom = THREE.MathUtils.clamp(zoom + Input.wheel * 0.07, 0.72, 1.5);
    if (!p) return;

    // ── DEAD-CENTRE FOLLOW (PoE-style) ────────────────────────────────────────
    // The character must sit at the exact centre of the screen. Two things were moving it
    // off-centre before:
    //
    // 1. `cam.lookAt(target)` aimed at a CURSOR-BIASED point, not the player. Any non-zero
    //    `lookAhead` therefore pushed the character off-centre by that fraction of the
    //    cursor distance — the whole point of the bias was to lead the view, which is
    //    exactly what "not centred" means.
    // 2. `cam.position.lerp(desired, 1 - exp(-6.5*dt))` let the camera LAG while walking.
    //    A first-order lag settles at v/k, so at moveSpeed 5.1 and k=6.5 the camera sat a
    //    steady ~0.78 world units behind the player the entire time he was moving — a
    //    permanent off-centre offset in the direction of travel, not a transient.
    //
    // Both are gone. The follow point IS the player, the camera is placed rigidly at
    // `follow + offset`, and it looks at `follow`. That pins the character to the screen
    // centre in every frame, moving or still, which is how PoE reads.
    //
    // Rigid is safe here because `p.pos` is already smoothed by the acceleration/friction
    // integrator in player.js — there is no raw input jitter to filter out, so the damping
    // was buying nothing and costing centring.
    follow.copy(p.pos);
    follow.y += 0.9;                       // chest height, so the figure centres not the feet

    cam.position.copy(follow).add(computeOffset());

    // Shake is applied to POSITION ONLY, after placement. It jolts the view without moving
    // the look target, so an impact shakes the frame while the character stays centred.
    if (shake.amp > 0.0005) {
      shake.t += dt;
      const a = shake.amp * 0.34;
      cam.position.x += Math.sin(shake.t * shake.freq * 1.7) * a;
      cam.position.y += Math.sin(shake.t * shake.freq * 2.3 + 1.1) * a * 0.7;
      cam.position.z += Math.cos(shake.t * shake.freq * 1.3 + 0.4) * a;
      shake.amp *= Math.exp(-CFG.camera.shakeDecay * dt);
    }
    cam.lookAt(follow.x, follow.y, follow.z);

    // Feed the wall-cutaway shader. It works in VIEW space, so the camera's inverse world
    // matrix must be current — hence after lookAt, and we update it explicitly because
    // Three.js would otherwise only refresh it at render time.
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    updateCutaway(cam, p.pos);
  },
};

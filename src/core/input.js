import * as THREE from 'three';
import { World } from './world.js';
import { bus, EV } from './events.js';

/** Mouse + keyboard. Exposes cursor position projected onto the play surface. */
export const Input = {
  keys: new Set(),
  mouse: new THREE.Vector2(),        // NDC
  ground: new THREE.Vector3(),       // world-space cursor on play surface
  lmb: false, rmb: false,
  lmbEdge: false, rmbEdge: false,
  wheel: 0,
  _ray: new THREE.Raycaster(),
  _plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  skillEdge: new Set(),

  attach(canvas) {
    const setNDC = (e) => {
      this.mouse.x = (e.clientX / innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    };
    canvas.addEventListener('pointermove', setNDC, { passive: true });
    canvas.addEventListener('pointerdown', (e) => {
      setNDC(e);
      if (e.button === 0) { this.lmb = true; this.lmbEdge = true; }
      if (e.button === 2) { this.rmb = true; this.rmbEdge = true; }
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.skillEdge.add(k);
      this.keys.add(k);
      // WASD is locomotion, F is a skill. preventDefault stops the browser scrolling the
      // page on Space and stops any stray accelerator behaviour on the movement keys.
      if (['w','a','s','d','q','e','r','f','1','2','3','4',' '].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => { this.keys.clear(); this.lmb = this.rmb = false; });
  },

  /** Project cursor onto the play surface, following terrain height. */
  update(camera) {
    this._ray.setFromCamera(this.mouse, camera);
    const py = World.player?.pos.y ?? 0;
    this._plane.constant = -py;
    const hit = this._ray.ray.intersectPlane(this._plane, this.ground);
    if (!hit) this._ray.ray.at(40, this.ground);
    if (World.level?.heightAt) this.ground.y = World.level.heightAt(this.ground.x, this.ground.z);
    return this.ground;
  },

  endFrame() { this.lmbEdge = false; this.rmbEdge = false; this.wheel = 0; this.skillEdge.clear(); },
  down(k) { return this.keys.has(k); },
  pressed(k) { return this.skillEdge.has(k); },
};

// Uniform grid for O(1)-ish neighbour queries. Rebuilt each sim step.
export class SpatialHash {
  constructor(cell = 3) { this.cell = cell; this.m = new Map(); }
  #k(x, z) { return ((x / this.cell) | 0) * 73856093 ^ ((z / this.cell) | 0) * 19349663; }
  clear() { this.m.clear(); }
  insert(e) {
    const k = this.#k(e.pos.x, e.pos.z);
    const b = this.m.get(k); if (b) b.push(e); else this.m.set(k, [e]);
  }
  query(x, z, r, out = []) {
    out.length = 0;
    const c = this.cell, n = Math.ceil(r / c);
    for (let ix = -n; ix <= n; ix++) for (let iz = -n; iz <= n; iz++) {
      const b = this.m.get(this.#k(x + ix * c, z + iz * c)); if (!b) continue;
      for (const e of b) { const dx = e.pos.x - x, dz = e.pos.z - z; if (dx * dx + dz * dz <= r * r) out.push(e); }
    }
    return out;
  }
}

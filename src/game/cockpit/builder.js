// Geometry accumulators.
//
// Two of them, because the cockpit is two draw calls and they carry different
// per-vertex payloads: the structure needs an albedo and a pair of shading
// flags, the instruments need a colour and a gauge address. Both are flat-shaded
// — every quad gets its own four vertices and one face normal. That is four
// times the vertex count of a welded mesh and it is the right trade at this
// size: the whole cockpit is under a thousand triangles, and hard facet edges
// are what make a small machine read as fabricated rather than moulded.
//
// Neither of these is touched after build(). Nothing here runs per frame.

import * as THREE from 'three';

/** Winding convention: a, b, c, d counter-clockwise seen from the visible side. */
function faceNormal(a, b, d, out) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
  return out;
}

const N = [0, 0, 0];

/**
 * The structural mesh: position, normal, albedo, and two flags.
 *
 * flags.x — 1 for an interior surface, which is the only kind that gets the
 *           canopy shadow. The frame's own outward faces are lit plainly;
 *           shadowing them against their own aperture would be circular.
 * flags.y — sheen. A narrow specular, used sparingly on machined edges so the
 *           frame catches a highlight the soft world outside never can. Small,
 *           sharp and detailed against enormous and soft is the contrast the
 *           whole look is supposed to rest on.
 */
export class Surf {
  constructor() {
    this.pos = []; this.nrm = []; this.col = []; this.flg = []; this.idx = [];
  }

  quad(a, b, c, d, color, interior = 1, sheen = 0) {
    faceNormal(a, b, d, N);
    const base = this.pos.length / 3;
    for (const v of [a, b, c, d]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(N[0], N[1], N[2]);
      this.col.push(color[0], color[1], color[2]);
      this.flg.push(interior, sheen);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /**
   * A general hexahedron from eight corners.
   *
   * 0..3 are the z-min (forward) face counter-clockwise seen from -Z; 4..7 the
   * z-max (aft) face, same order in x and y. The corners may be sheared and
   * tapered freely, which is what lets a rib or a pod be one call.
   */
  hexa(p, color, interior = 1, sheen = 0) {
    const [c0, c1, c2, c3, c4, c5, c6, c7] = p;
    this.quad(c0, c3, c2, c1, color, interior, sheen);   // -Z
    this.quad(c4, c5, c6, c7, color, interior, sheen);   // +Z
    this.quad(c0, c4, c7, c3, color, interior, sheen);   // -X
    this.quad(c1, c2, c6, c5, color, interior, sheen);   // +X
    this.quad(c0, c1, c5, c4, color, interior, sheen);   // -Y
    this.quad(c3, c7, c6, c2, color, interior, sheen);   // +Y
    return this;
  }

  /**
   * A tube segment between two eight-point cross-sections.
   *
   * `ringA` is aft (larger z), `ringB` forward. The vertex order below is the
   * one that puts the normals on the *inside*, which is where the pilot is.
   */
  ring(ringA, zA, ringB, zB, color, interior = 1, sheen = 0) {
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) & 7;
      this.quad(
        [ringA[i][0], ringA[i][1], zA],
        [ringA[j][0], ringA[j][1], zA],
        [ringB[j][0], ringB[j][1], zB],
        [ringB[i][0], ringB[i][1], zB],
        typeof color === 'function' ? color(i) : color, interior, sheen);
    }
    return this;
  }

  /** A flat annulus between two cross-sections in the same plane. `facing` is
   *  -1 for a face that looks forward, +1 for one that looks back at the pilot. */
  annulus(outer, inner, z, facing, color, interior = 1, sheen = 0) {
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) & 7;
      const o0 = [outer[i][0], outer[i][1], z], o1 = [outer[j][0], outer[j][1], z];
      const i0 = [inner[i][0], inner[i][1], z], i1 = [inner[j][0], inner[j][1], z];
      const c = typeof color === 'function' ? color(i) : color;
      if (facing > 0) this.quad(o0, o1, i1, i0, c, interior, sheen);
      else this.quad(o0, i0, i1, o1, c, interior, sheen);
    }
    return this;
  }

  /** A flat cap over one cross-section, as a fan. `facing` as above. */
  cap(ring, z, facing, color, interior = 1, sheen = 0) {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    cx /= 8; cy /= 8;
    const mid = [cx, cy, z];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) & 7;
      const a = [ring[i][0], ring[i][1], z], b = [ring[j][0], ring[j][1], z];
      // Degenerate quad as a triangle; the builder only knows quads and one
      // duplicated corner costs a vertex, not a triangle.
      if (facing > 0) this.quad(a, b, mid, mid, color, interior, sheen);
      else this.quad(b, a, mid, mid, color, interior, sheen);
    }
    return this;
  }

  get triangles() { return this.idx.length / 3; }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlags', new THREE.Float32BufferAttribute(this.flg, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The emissive mesh: position, colour, and a gauge address.
 *
 * meter.x  gauge index, or -1 for something that is simply always on.
 * meter.y  where this quad sits along its gauge, 0..1 — so a bar is a row of
 *          quads that differ only in this number and the whole readout animates
 *          from one uniform. Negative means "not a bar": the quad is a lamp and
 *          its brightness is the gauge value directly.
 *
 * The point of the encoding is that every instrument in the cockpit is one draw
 * call with no geometry ever rewritten. There is no per-frame allocation in an
 * instrument panel built this way because there is no per-frame anything.
 */
export class Emis {
  constructor() { this.pos = []; this.col = []; this.mtr = []; this.idx = []; }

  quad(a, b, c, d, color, gauge, frac) {
    const base = this.pos.length / 3;
    for (const v of [a, b, c, d]) {
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(color[0], color[1], color[2]);
      this.mtr.push(gauge, frac);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  get triangles() { return this.idx.length / 3; }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMeter', new THREE.Float32BufferAttribute(this.mtr, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

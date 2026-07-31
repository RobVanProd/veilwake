// The corridors the Listener carves, and the medium they change.
//
// Contract §10.1: *"Moving, it carves a corridor of cleared, low-density air
// 300 m across that persists for several minutes and slowly refills."* §2.3 then
// says a duct is *"strong local gradient, and not inside a dense core"*, and
// notes that *"Corridors carved by the Listener satisfy it automatically, which
// is the point — the road that looks easiest is the one that carries your engine
// noise furthest, and nothing had to be scripted for that to be true."*
//
// That last sentence is the whole reason this file wraps the **source** rather
// than the medium. `createMedium` derives `duct` from a finite difference of
// `source.densityAt`. A carve applied on top of `Medium.sample()` would clear the
// air and produce no gradient, no duct and no trap; applied to `densityAt`, the
// corridor wall becomes a gradient, the gradient becomes a duct, and the trap
// builds itself out of the same three lines that build the picture. Nothing here
// authors a duct and nothing here mentions the player.
//
// Note what this file does *not* do: it does not change what the cloud shader
// draws. The creature and its senses agree about the corridor; the renderer does
// not know about it yet. That is a visible-world integration listed in the
// module's API notes, not a silent approximation — §2.2's rule is that an
// approximation must be conservative in the player's favour, and a corridor the
// player cannot see but which the creature treats as clear air is the opposite.
// Until the renderer carves too, run with `visible: false` (the default) and the
// Listener carves nothing at all.

import { clamp01 } from '../../core/math.js';

const smooth01 = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1));
  return t * t * (3 - 2 * t);
};

/**
 * A rolling trail of carved segments.
 *
 * Capacity is sized the way §3.3 sizes the trail buffers, so a segment is only
 * ever dropped after it has already refilled: the fastest the Listener moves is
 * 1200 m/min = 20 m/s, and at one segment per `spacingM` = 100 m a full
 * `lifeSec` = 240 s of corridor is 48 segments. 96 is twice that, so the cap
 * cannot silently truncate a live corridor.
 */
export class CorridorField {
  constructor({
    capacity = 96,
    radiusM = 150,        // §10.1: 300 m across
    lifeSec = 240,        // "several minutes"
    spacingM = 100,
    strength = 0.92,      // fraction of density removed at the axis
    refillFrom = 0.35,    // fraction of life at which it starts filling back in
  } = {}) {
    this.capacity = capacity;
    this.radiusM = radiusM;
    this.lifeSec = lifeSec;
    this.spacingM = spacingM;
    this.strength = strength;
    this.refillFrom = refillFrom;

    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.born = new Float32Array(capacity);
    this.head = 0;
    this.count = 0;
    this.now = 0;
    this.revision = 0;

    // Bounding box over live segments. One test rejects a query that is nowhere
    // near a corridor, which is the overwhelmingly common case — the path
    // integral runs 8 times per sense tick and most of those points are in open
    // air a long way from anything carved.
    this._bb = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, valid: false };
    this._last = { x: 0, y: 0, z: 0, has: false };
  }

  /** Advance the clock. Ages are read from this, so it must be driven each step. */
  tick(t) { this.now = t; }

  /** Extend the corridor to a point, if the creature has moved far enough. */
  carve(x, y, z, t) {
    const l = this._last;
    if (l.has) {
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      if (dx * dx + dy * dy + dz * dz < this.spacingM * this.spacingM) return false;
    }
    const i = this.head;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.born[i] = t;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    l.x = x; l.y = y; l.z = z; l.has = true;
    this.now = t;
    this.revision++;
    this._rebuildBounds();
    return true;
  }

  /** Break the trail, so a creature that stopped carving does not join two ends. */
  lift() { this._last.has = false; }

  _rebuildBounds() {
    const b = this._bb;
    if (this.count === 0) { b.valid = false; return; }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const j = (this.head - 1 - i + this.capacity * 2) % this.capacity;
      if (this.x[j] < x0) x0 = this.x[j];
      if (this.y[j] < y0) y0 = this.y[j];
      if (this.z[j] < z0) z0 = this.z[j];
      if (this.x[j] > x1) x1 = this.x[j];
      if (this.y[j] > y1) y1 = this.y[j];
      if (this.z[j] > z1) z1 = this.z[j];
    }
    const r = this.radiusM;
    b.x0 = x0 - r; b.y0 = y0 - r; b.z0 = z0 - r;
    b.x1 = x1 + r; b.y1 = y1 + r; b.z1 = z1 + r;
    b.valid = true;
  }

  /**
   * How much of the ambient density survives here, in 0..1.
   *
   * Segments combine by `max`, never by sum: two overlapping passes make one
   * corridor, not a hole. A corridor is a place the vapour was pushed out of, and
   * pushing twice does not remove more than all of it.
   */
  clearance(x, y, z) {
    if (this.count === 0) return 1;
    const b = this._bb;
    if (b.valid && (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || z < b.z0 || z > b.z1)) return 1;

    const r2 = this.radiusM * this.radiusM;
    let worst = 0;
    for (let i = 0; i < this.count; i++) {
      const j = (this.head - 1 - i + this.capacity * 2) % this.capacity;
      const dx = x - this.x[j], dy = y - this.y[j], dz = z - this.z[j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const age = (this.now - this.born[j]) / this.lifeSec;
      if (age >= 1) continue;
      // Full for the first third of its life, then slowly refills.
      const fill = 1 - smooth01(this.refillFrom, 1, age);
      // Soft-edged: a hard-edged corridor would make `duct` a step function and
      // the acoustic spreading exponent snap between 20 and 12 as a creature
      // crossed the wall.
      const radial = 1 - smooth01(0.55, 1.0, Math.sqrt(d2) / this.radiusM);
      const a = this.strength * fill * radial;
      if (a > worst) worst = a;
    }
    return 1 - worst;
  }

  /** Live segment count, for the budget test. */
  liveCount() {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const j = (this.head - 1 - i + this.capacity * 2) % this.capacity;
      if (this.now - this.born[j] < this.lifeSec) n++;
    }
    return n;
  }

  reset() { this.head = 0; this.count = 0; this.revision++; this._bb.valid = false; this._last.has = false; }
}

/**
 * A density source with the corridors cut out of it.
 *
 * Shaped exactly like `CloudSystem` so `createMedium` cannot tell the difference,
 * and exposing `generationKey()` so the derived-field cache invalidates when a
 * corridor changes as well as when the weather moves. Without that key a corridor
 * carved between two cache generations would be invisible to `duct` for up to a
 * third of a second — a small window, and exactly the kind of small window that
 * produces one unreproducible detection an hour.
 */
export function createCarvingSource(source, fields) {
  const list = Array.isArray(fields) ? fields : [fields];
  const advect = source.field && source.field.shapeAdvect;
  const advectM = 4;

  const clearance = (x, y, z) => {
    let c = 1;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f || f.count === 0) continue;
      const q = f.clearance(x, y, z);
      if (q < c) c = q;
    }
    return c;
  };

  return {
    field: source.field,
    storms: source.storms,
    densityAt(x, y, z, detailLod = 1) {
      const d = source.densityAt(x, y, z, detailLod);
      return d <= 0 ? d : d * clearance(x, y, z);
    },
    // Flow is the cloud system's, with one correction. `CloudSystem.flowAt`
    // derives turbulence from the local density — it is strongest at a cloud
    // edge and zero in clear air — so a carved corridor would read as calm if
    // the field had actually been carved. Scaling by the same clearance is what
    // the underlying formula would have produced, and it is what §10.1 means by
    // corridors being "faster, calmer and more inviting". The three wind terms
    // are unchanged: clearing vapour does not change which way it is blowing.
    flowAt: source.flowAt
      ? (x, y, z, out) => {
          const o = source.flowAt(x, y, z, out);
          o.turbulence *= clearance(x, y, z);
          return o;
        }
      : undefined,
    transmittance: source.transmittance ? source.transmittance.bind(source) : undefined,
    clearanceAt: clearance,
    generationKey() {
      let rev = 0;
      for (let i = 0; i < list.length; i++) rev += list[i] ? list[i].revision : 0;
      const a = advect
        ? `${Math.round(advect[0] / advectM)},${Math.round(advect[1] / advectM)},${Math.round(advect[2] / advectM)}`
        : '0';
      return `${a}|${rev}`;
    },
  };
}

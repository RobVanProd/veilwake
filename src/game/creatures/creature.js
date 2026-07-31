// The creature contract, in code.
//
// `CREATURE_BEHAVIOR_CONTRACT.md` is written so that the signature system, the
// medium and the creatures can be built by different people at the same time and
// still agree when they meet. This file is that agreement expressed once, so
// there is exactly one implementation of every shared formula. An archetype that
// reimplements the acoustic spreading term "equivalently" is how the creature and
// the player's own instruments end up disagreeing by 3% in a way nobody can find.
//
// Three things live here and nothing else:
//
//   1. The canonical constants and the transmission formulas (contract §1, §4).
//   2. The escalation machine, the attention integrator and the detection log
//      (§5, §6, §7) — shared by every archetype so the escalation is legible
//      across the roster.
//   3. Adapters that turn whatever the medium and signature systems happen to
//      expose into the shapes §2.1 and §3.4 promise. Those two systems are being
//      built in parallel; the adapters exist so this file can be written and
//      tested against a synthetic world before either lands, and so the day they
//      do land is a wiring change rather than a rewrite.
//
// No Three.js import. Vectors here are plain `{x, y, z}` objects, which keeps the
// whole creature layer runnable outside the renderer — the tests in
// `tests/creature.test.js` construct a world with no GPU in it at all, and a test
// that needs a WebGL context is a test that stops being run.
//
// Importing this file has no side effects: it defines classes and constants and
// touches nothing global.

import { clamp, clamp01 } from '../../core/math.js';

// ---------------------------------------------------------------------------
// §1 Canonical constants
// ---------------------------------------------------------------------------

export const UNIT = 1;                  // metres per world unit
export const STEP = 1 / 120;            // s, fixed simulation step
export const SENSE_PERIOD = 12;         // steps between sense evaluations (10 Hz)
export const SENSE_DT = SENSE_PERIOD * STEP;   // 0.1 s — also the attention integrator's dt
export const SOUND_SPEED = 330;         // m/s
export const ACOUSTIC_REF = 100;        // m, reference distance for the dB spreading term
export const FAR_PLANE = 12000;         // m — nothing detects beyond it
export const VIS_CLEAR = 4000;          // m, visibility at density 0
export const VIS_K = 5.6;
export const AMBIENT_K = 244;           // K
export const SHIP_LENGTH = 14;          // m

/** The single definition of "how far can anything see here". §1. */
export const visibilityM = (rho) => VIS_CLEAR * Math.exp(-VIS_K * rho);

/** Sound is slow, and that is a scale cue as much as a constraint. §1. */
export const soundDelayS = (d) => d / SOUND_SPEED;

/** Path-integral sample count. §4: eight, not a march. §8 caps this. */
export const PATH_SAMPLES = 8;

/** Medium samples one creature may take per sense tick. §8. */
export const MEDIUM_SAMPLE_BUDGET = 32;

/**
 * Forked-RNG tags. §5.3 requires each creature's randomness to come from its own
 * stream; these keep two creatures of the same archetype from sharing one, and
 * keep the voice schedule from shifting when a false positive is drawn.
 */
export const RNG_TAG = {
  LISTENER: 0x11577e,
  LANTERN: 0x1a17e2,
  WAKE_HUNTER: 0x3a4e77,
  CHOIR: 0xc401a2,
  // Sub-streams. A creature forks once per purpose, so adding a draw in one
  // place cannot shift the sequence in another.
  SENSE: 0x0001,
  VOICE: 0x0002,
  BEHAVIOUR: 0x0003,
};

// ---------------------------------------------------------------------------
// §6 The escalation machine
// ---------------------------------------------------------------------------

export const STATE = {
  UNAWARE: 'UNAWARE',
  ALERT: 'ALERT',
  SEARCHING: 'SEARCHING',
  TRACKING: 'TRACKING',
  COMMITTED: 'COMMITTED',
};

export const STATE_ORDER = [
  STATE.UNAWARE, STATE.ALERT, STATE.SEARCHING, STATE.TRACKING, STATE.COMMITTED,
];

/** Attention at which each state is entered. §6. */
export const STATE_ENTRY = {
  [STATE.UNAWARE]: 0,
  [STATE.ALERT]: 0.25,
  [STATE.SEARCHING]: 0.45,
  [STATE.TRACKING]: 0.70,
  [STATE.COMMITTED]: 0.92,
};

/** Exit is 0.8x entry, so a creature does not oscillate at a boundary. §6. */
export const HYSTERESIS = 0.8;
export const stateExit = (name) => STATE_ENTRY[name] * HYSTERESIS;

// ---------------------------------------------------------------------------
// Small vector helpers
//
// Deliberately not Three.js. The creature layer must run headless.
// ---------------------------------------------------------------------------

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vdistSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

/**
 * World-frame bearing, as one scalar, measured in the horizontal plane.
 *
 * §5.1 gives `bearing` as a single number in radians, which forces a choice:
 * azimuth only, or azimuth plus elevation. **This project uses azimuth only, and
 * that is a design decision, not a simplification.** A creature's percept
 * therefore carries no information about how high the ship is, so its search is a
 * vertical cylinder rather than a cone, and climbing or diving out of its plane
 * is a real evasion the player can discover. Any archetype that needs elevation
 * must add it as a separate named field so the difference is visible in the log.
 */
export const azimuth = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

/** Unit horizontal direction for an azimuth. Inverse of `azimuth`. */
export const azimuthDir = (rad) => ({ x: Math.sin(rad), y: 0, z: Math.cos(rad) });

export function wrapAngle(a) {
  const TAU = Math.PI * 2;
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---------------------------------------------------------------------------
// §2 The medium adapter
// ---------------------------------------------------------------------------

/**
 * A `MediumSample`, reused in place. §2.1.
 *
 * Allocating one of these per query would produce roughly two thousand objects a
 * second at the sample budget in §8, which is a garbage-collection pause during
 * an encounter — the specific failure the hitch budget in `PERFORMANCE_BUDGET.md`
 * exists to prevent.
 */
export const makeMediumSample = () => ({
  density: 0,
  temperature: AMBIENT_K,
  charge: 0,
  flow: vec(),
  turbulence: 0,
  duct: 0,
});

/** §2.3. Strong local gradient, and not inside a dense core. */
export function ductFromField(gradMagnitude, rho) {
  const a = smooth01(0.15, 0.55, gradMagnitude * 300);
  const b = 1 - smooth01(0.6, 0.9, rho);
  return clamp01(a * b);
}

const smooth01 = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1));
  return t * t * (3 - 2 * t);
};

/**
 * Normalise whatever the medium system exposes into §2.1's `sample()`.
 *
 * If `source` already satisfies the contract, it is returned untouched — that is
 * the intended end state and this adapter should become a one-line passthrough
 * the day the medium lands.
 *
 * Otherwise a `CloudSystem` is wrapped. Two things about that wrapping matter:
 *
 *   - **Density is sampled at `detailLod = 0`**, which skips the fine erosion
 *     texture. Erosion only ever removes density, so this reads *higher* than the
 *     shader does, which means more acoustic absorption and a creature that hears
 *     *less* than the picture implies. §2.2 requires any approximation to be
 *     conservative in the player's favour and this one is, in the right
 *     direction. It is also exactly what the shader's own shadow march uses.
 *
 *   - **`duct` and `turbulence` are cached on a coarse grid.** Both are smooth
 *     fields and both need several density evaluations to derive; sampling them
 *     exactly at eight points along every path, for every creature, ten times a
 *     second, is the single most expensive thing the AI could do.
 *
 * **The cache is keyed on the field's own advection state, not on `t`.** That
 * distinction was a real bug and is worth stating. `CloudSystem.densityAt` has no
 * time parameter at all — the field's time dependence lives entirely in
 * `clouds.field.shapeAdvect`, which `clouds.update()` moves. A cache keyed on a
 * quantised `t` therefore had time in the key and not in the computation, so a
 * warm entry could answer a query from a field state up to a whole cache
 * generation old while `density` beside it was sampled live. Two calls with the
 * same `(x, y, z, t)` genuinely returned different answers depending on whether
 * the table happened to be warm, which §2.1 forbids and §12's "replaying the same
 * seed produces an identical detection log" depends on.
 *
 * Keying on the advection offsets makes the key *be* the thing the value depends
 * on, so warm and cold agree by construction. The offsets are quantised to
 * `advectM` metres, which is the one approximation left and the only one §2.2
 * needs an error bound for: `tests/creature.test.js` measures it rather than
 * asserting it.
 */
export function createMedium(source, opts = {}) {
  if (!source) return createFlatMedium(opts);
  if (typeof source.sample === 'function') return source;
  if (typeof source.densityAt !== 'function') return createFlatMedium(opts);

  const cellM = opts.cellM ?? 64;         // metres per derived-field cache cell
  const gradH = opts.gradH ?? 60;         // finite-difference arm, metres
  // Field advection quantum. The derived quantities are built from a 60 m
  // gradient arm, so 4 m of field motion is fifteen times finer than the thing
  // being measured. At the shape wind's 11 m/s that is a new generation every
  // 0.36 s, which is what pays for the cache.
  const advectM = opts.advectM ?? 4;
  const cellS = opts.cellS ?? 0.25;       // fallback generation, for sources with no `field`
  const cache = new Map();
  const out = makeMediumSample();
  const flowTmp = { x: 0, y: 0, z: 0, turbulence: 0 };

  // §8: the budget is stated in `Medium.sample()` calls, but the *cost* is field
  // evaluations, and one is not the other. These count the real work so the two
  // numbers can never be confused for each other again.
  let nDensity = 0, nFlow = 0;
  const densityAt = (x, y, z) => { nDensity++; return source.densityAt(x, y, z, 0); };

  const hasFlow = typeof source.flowAt === 'function';
  const advect = source.field && source.field.shapeAdvect;
  let generation = null;

  // A source that changes for reasons of its own — a carved corridor, say —
  // supplies its own key, so the derived-field cache invalidates on that too.
  const generationKey = typeof source.generationKey === 'function'
    ? () => source.generationKey()
    : (t) => (advect
      ? `${Math.round(advect[0] / advectM)},${Math.round(advect[1] / advectM)},${Math.round(advect[2] / advectM)}`
      : `${Math.round(t / cellS)}`);

  const derive = (x, y, z, t) => {
    const gen = generationKey(t);
    if (gen !== generation) { generation = gen; cache.clear(); }

    const ix = Math.round(x / cellM), iy = Math.round(y / cellM), iz = Math.round(z / cellM);
    // A string key rather than a packed integer: the world is 24 km across and
    // nothing bounds `y`, so any packing wide enough to be safe is wider than a
    // double's integer range. A collision here is a creature reading another
    // cell's duct, which is the kind of bug that only ever appears in a log
    // nobody can reproduce.
    const key = `${ix},${iy},${iz}`;
    let e = cache.get(key);
    if (e) return e;
    const cx = ix * cellM, cy = iy * cellM, cz = iz * cellM;

    // Tetrahedral gradient: four evaluations instead of the six a central
    // difference needs, for the same order of accuracy.
    const h = gradH;
    const k0 = densityAt(cx + h, cy - h, cz - h);
    const k1 = densityAt(cx - h, cy - h, cz + h);
    const k2 = densityAt(cx - h, cy + h, cz - h);
    const k3 = densityAt(cx + h, cy + h, cz + h);
    const gx = (k0 - k1 - k2 + k3) / (4 * h);
    const gy = (-k0 - k1 + k2 + k3) / (4 * h);
    const gz = (-k0 + k1 - k2 + k3) / (4 * h);
    const rhoLocal = (k0 + k1 + k2 + k3) * 0.25;

    // A density-only source is a legitimate synthetic world — the guard above
    // accepts one, so this has to as well. Still air, not a crash.
    if (hasFlow) { nFlow++; source.flowAt(cx, cy, cz, flowTmp); }
    else { flowTmp.x = 0; flowTmp.y = 0; flowTmp.z = 0; flowTmp.turbulence = 0; }

    e = {
      duct: ductFromField(Math.hypot(gx, gy, gz), rhoLocal),
      turbulence: clamp01(flowTmp.turbulence),
      flow: { x: flowTmp.x, y: flowTmp.y, z: flowTmp.z },
      charge: chargeFromStorms(source, cx, cy, cz),
    };
    // Wholesale clear rather than an LRU. Values are a pure function of the key
    // *and the generation*, so dropping the table cannot change an answer.
    if (cache.size > 8192) cache.clear();
    cache.set(key, e);
    return e;
  };

  return {
    sample(x, y, z, t, dst = out) {
      const e = derive(x, y, z, t);
      // §2.2, the one-field rule: density is the live field at the exact point,
      // never the cached cell. Only the derived quantities are approximated.
      dst.density = clamp01(densityAt(x, y, z));
      dst.temperature = AMBIENT_K;
      dst.charge = e.charge;
      dst.flow.x = e.flow.x; dst.flow.y = e.flow.y; dst.flow.z = e.flow.z;
      dst.turbulence = e.turbulence;
      dst.duct = e.duct;
      return dst;
    },
    /** Line of sight, when an archetype needs it. The Listener does not. */
    transmittance: source.transmittance ? source.transmittance.bind(source) : null,
    /** Real field work, not `sample()` calls. See `countingMedium`. */
    fieldEvals() { return { densityAt: nDensity, flowAt: nFlow }; },
    resetFieldEvals() { nDensity = 0; nFlow = 0; },
    /** Which field state the derived values currently describe. */
    generation() { return generation; },
    _cache: cache,
  };
}

function chargeFromStorms(cloud, x, y, z) {
  const storms = cloud.storms;
  if (!storms) return 0;
  let q = 0;
  for (let i = 0; i < storms.length; i++) {
    const s = storms[i];
    if (!s || s.charge <= 0) continue;
    const d = Math.hypot(x - s.x, y - s.y, z - s.z);
    if (d > s.radius * 1.6) continue;
    q += s.charge * (1 - clamp01(d / (s.radius * 1.6)));
  }
  return clamp01(q);
}

/**
 * A medium with no weather in it. Used when the cloud system is absent, and as
 * the base the tests build their synthetic worlds on top of.
 */
export function createFlatMedium({ density = 0, turbulence = 0, charge = 0, duct = 0,
                                   flow = vec(), temperature = AMBIENT_K } = {}) {
  const out = makeMediumSample();
  return {
    sample(x, y, z, t, dst = out) {
      dst.density = density; dst.temperature = temperature; dst.charge = charge;
      dst.flow.x = flow.x; dst.flow.y = flow.y; dst.flow.z = flow.z;
      dst.turbulence = turbulence; dst.duct = duct;
      return dst;
    },
    transmittance: null,
  };
}

// ---------------------------------------------------------------------------
// §3 The signature adapter
// ---------------------------------------------------------------------------

/**
 * Where the ship was, on the same schedule the signature recorder runs on.
 *
 * §3.4 specifies six channels and no position, and `SignatureRecorder` implements
 * exactly that. But transmission (§4.1) needs a distance and a path, and both are
 * properties of where the sound was *made*: a ship at cruise covers 1.3 km during
 * the 9.1 s a call takes to travel 3 km, so ranging it from where it is now is
 * ranging the wrong ship. Without this, the propagation delay is observable in
 * *emission* and not in *geometry*, which is half of the mechanic.
 *
 * This lives here rather than as three more floats on the recorder because
 * `src/game/signature.js` is owned elsewhere; it is the same 2 Hz, 300 s ring and
 * it costs 7.2 KB. If position ever joins the recorder's channel set, delete this
 * and pass the recorder as `positions` — the interface is the same `at(ageSec)`.
 *
 * Samples are interpolated between the two straddling entries. At 2 Hz and
 * 148 m/s the raw samples are 74 m apart, which is a bearing error of 1.4° at
 * 3 km for nothing.
 */
export class PositionHistory {
  constructor({ seconds = 300, hz = 2 } = {}) {
    this.hz = hz;
    this.capacity = Math.round(seconds * hz);
    this.data = new Float32Array(this.capacity * 3);
    this.times = new Float32Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this._acc = 0;
    this._period = 1 / hz;
    this._out = { x: 0, y: 0, z: 0, simTime: 0 };
  }

  /** Call every simulation step with the same `dt` the signature gets. */
  record(dt, time, pos) {
    this._acc += dt;
    if (this._acc < this._period) return false;
    this._acc -= this._period;
    const i = this.head * 3;
    this.data[i] = pos.x; this.data[i + 1] = pos.y; this.data[i + 2] = pos.z;
    this.times[this.head] = time;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return true;
  }

  /** Where the ship was `ageSec` ago, or null if that is older than the ring. */
  at(ageSec) {
    if (this.count === 0 || ageSec < 0) return null;
    const back = ageSec * this.hz;
    const b0 = Math.floor(back), f = back - b0;
    if (b0 + 1 >= this.count) {
      if (b0 >= this.count) return null;
      return this._read(b0, 0, b0);
    }
    return this._read(b0, f, b0 + 1);
  }

  _read(b0, f, b1) {
    const i0 = (this.head - 1 - b0 + this.capacity * 2) % this.capacity;
    const i1 = (this.head - 1 - b1 + this.capacity * 2) % this.capacity;
    const a = i0 * 3, b = i1 * 3;
    const o = this._out;
    o.x = this.data[a] + (this.data[b] - this.data[a]) * f;
    o.y = this.data[a + 1] + (this.data[b + 1] - this.data[a + 1]) * f;
    o.z = this.data[a + 2] + (this.data[b + 2] - this.data[a + 2]) * f;
    o.simTime = this.times[i0] + (this.times[i1] - this.times[i0]) * f;
    return o;
  }

  spanSec() { return this.count / this.hz; }
  reset() { this.head = 0; this.count = 0; this._acc = 0; }
}

/**
 * Normalise the signature system into the one thing a sense needs: what the ship
 * was emitting a given number of seconds ago, and where it was.
 *
 * **The argument is an age in seconds, not an absolute sim time, and the method is
 * called `at` because that is what `SignatureRecorder.at` is called and what it
 * means.** This was the other real bug in this file: the view took `t` and
 * forwarded it into a function whose parameter is `ageSec`. The two conventions
 * are mirror images about the present, so the adapter did not fail, it lied — at
 * t=60 s a 3 km listener asking for 50.91 got the sample from simTime 9.0, 42 s
 * wrong in the wrong direction, and past 300 s it returned null at every distance
 * forever. Nothing type-checks the difference between two numbers of seconds, so
 * the only defence is that the name and the convention agree, everywhere.
 *
 * If no position history is supplied, this falls back to the ship's current
 * position and stamps `positionExact: false`, which travels into the detection
 * log. A log line that admits its own path was approximated is worth more than
 * one that quietly is.
 *
 * Accepted shapes: a `SignatureRecorder`, a `Signature` (its `.recorder` is
 * used), a bare `(ageSec) => sample` function, or a live object read as "now".
 */
export function createSignatureView(source, { positions = null } = {}) {
  const rec = source && typeof source.at === 'function' ? source
    : source && source.recorder && typeof source.recorder.at === 'function' ? source.recorder
    : null;
  const history = rec ? (ageSec) => rec.at(ageSec)
    : typeof source === 'function' ? source
    : null;
  const live = () => (typeof source?.current === 'function' ? source.current()
    : typeof source?.values === 'function' ? source.values()
    : source);

  const norm = (s, pos, exact, ageSec) => {
    if (!s) return null;
    return {
      acoustic: s.acoustic ?? 0,
      thermal: s.thermal ?? 0,
      photic: s.photic ?? 0,
      em: s.em ?? 0,
      wake: s.wake ?? 0,
      relSpeed: s.relSpeed ?? 0,
      x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0,
      positionExact: exact,
      ageSec,
      simTime: s.simTime ?? null,
    };
  };

  return {
    hasHistory: !!history,
    hasPositions: !!positions,
    /** Seconds of past available. A sense asking beyond this gets null, not a lie. */
    spanSec() {
      if (!rec) return positions ? positions.spanSec() : 0;
      const s = rec.count / rec.hz;
      return positions ? Math.min(s, positions.spanSec()) : s;
    },
    /**
     * What the ship was emitting `ageSec` ago, and where it was.
     * Null when that is older than the recorder — §7 would rather have no
     * detection than one built on the present mistaken for the past.
     */
    at(ageSec, fallbackPos) {
      if (!history) return norm(live(), fallbackPos, false, 0);
      const s = history(ageSec);
      if (!s) return null;
      const p = positions ? positions.at(ageSec) : null;
      return norm(s, p || fallbackPos, !!p, ageSec);
    },
    /** Same thing, spelled so a call site cannot read it as an absolute time. */
    ago(ageSec, fallbackPos) { return this.at(ageSec, fallbackPos); },
    /**
     * Where the ship was `ageSec` ago, or null. Separate from `at()` because
     * solving for the flight time needs the geometry several times before it
     * needs the emission once.
     */
    positionAt(ageSec) { return positions ? positions.at(ageSec) : null; },
    /** Emissions right now. Contact channels only — everything else travels. */
    current(fallbackPos) {
      return norm(live(), fallbackPos, true, 0);
    },
  };
}

// ---------------------------------------------------------------------------
// §4 Transmission
// ---------------------------------------------------------------------------

/** Reused so the path integral allocates nothing. */
const _pathSample = makeMediumSample();

/**
 * The path terms in §4: eight evenly spaced samples between two points.
 *
 * `Rho` is the density integral in kilometre-units, which is what `absorb_dB`
 * expects: mean density along the ray, multiplied by the ray length in km.
 */
export function pathTerms(medium, ax, ay, az, bx, by, bz, t, dst = {}) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  let rho = 0, u = 0, q = 0, g = 0;
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const s = (i + 0.5) / PATH_SAMPLES;
    const m = medium.sample(ax + dx * s, ay + dy * s, az + dz * s, t, _pathSample);
    rho += m.density; u += m.turbulence; q += m.charge; g += m.duct;
  }
  const inv = 1 / PATH_SAMPLES;
  dst.distance = d;
  dst.rho_mean = rho * inv;
  dst.u_mean = u * inv;
  dst.q_mean = q * inv;
  dst.g_mean = g * inv;
  dst.Rho = dst.rho_mean * (d / 1000);
  dst.samples = PATH_SAMPLES;
  return dst;
}

/**
 * §4.1. Acoustic, a field channel.
 *
 * The duct term is the whole mechanic: in open air the spreading exponent is 20,
 * inside a strong duct it is 12, and at 6 km that is 14 dB — the difference
 * between inaudible and obvious.
 */
export function acousticReceived(emitted, terms) {
  const n = 20 - 8 * terms.g_mean;
  const spread = n * Math.log10(Math.max(terms.distance, ACOUSTIC_REF) / ACOUSTIC_REF);
  const absorb = 12 * terms.Rho;
  return emitted - spread - absorb;
}

/** §4.1. Ducts carry sound a long way and destroy its bearing. */
export const acousticBearingSigma = (terms) =>
  0.03 + 0.9 * terms.u_mean + 0.5 * terms.g_mean;

/** §4.2, for archetypes with eyes. Here so there is one copy of it. */
export function photicReceived(lumens, terms) {
  const vis = visibilityM(terms.rho_mean);
  const d = Math.max(terms.distance, 10);
  const through = Math.exp(-terms.distance / vis);
  const direct = lumens / (d * d) * through;
  const scatter = lumens / (d * d) * (1 - through) * 0.6;
  const total = direct + scatter;
  const quality = direct / Math.max(total, 1e-9);
  return { total, direct, scatter, quality, bearingSigma: 0.02 + 1.2 * (1 - quality) };
}

/** §4.3. Vapour barely attenuates EM; charged cells amplify it and wreck its bearing. */
export function emReceived(emu, terms) {
  const s = 300 / Math.max(terms.distance, 300);
  return {
    total: emu * s * s * (1 + 1.5 * terms.q_mean),
    bearingSigma: 0.04 + 1.6 * terms.q_mean,
  };
}

// ---------------------------------------------------------------------------
// §5 Percepts
// ---------------------------------------------------------------------------

/** §5.1. Never a position — an estimate with its error attached. */
export function makePercept(channel, strength, bearing, bearingSigma, ageSec, confidence, real, extra) {
  const p = {
    channel, strength, bearing, bearingSigma,
    range: null, ageSec, confidence, real,
  };
  if (extra) Object.assign(p, extra);
  return p;
}

/** Excess over threshold, as §5.4 defines it. The one place this is computed. */
export const perceptExcess = (strength, threshold, saturation) =>
  clamp01((strength - threshold) / (saturation - threshold));

// ---------------------------------------------------------------------------
// §7 The detection log
// ---------------------------------------------------------------------------

/**
 * One readable sentence per event, per §7. Kept beside the record rather than in
 * a UI file, because the sentence is the point of the record.
 */
export function formatEvent(e) {
  const m = e.medium || {};
  const head = `t=${e.simTime.toFixed(1)}  ${e.archetype}#${e.creature}  ${e.from}→${e.to}  ${e.channel}`;
  if (e.emitted === null || e.emitted === undefined) {
    return `${head}  attention ${e.attention.toFixed(3)}` +
      (e.distance !== null ? ` at ${Math.round(e.distance)} m` : '');
  }
  return `${head}  emitted ${e.emitted.toFixed(1)}, transmitted ${e.transmitted.toFixed(1)} at ` +
    `${Math.round(e.distance)} m through rho ${(m.rho_mean ?? 0).toFixed(2)} / duct ` +
    `${(m.g_mean ?? 0).toFixed(2)}, threshold ${e.threshold.toFixed(1)}` +
    (e.real === false ? '  [false positive]' : '') +
    (e.mediumFresh === false ? '  [path from an earlier tick]' : '') +
    (e.positionExact === false ? '  [ranged from the present, not the emission]' : '');
}

// ---------------------------------------------------------------------------
// The base creature
// ---------------------------------------------------------------------------

/**
 * Everything §5 through §7 requires, with the archetype supplying only `sense()`
 * and `behave()`.
 *
 * The division is deliberate and it is the rule that keeps the roster honest: an
 * archetype decides *what it can perceive* and *what it does about it*, and never
 * touches the attention integrator, the thresholds of the state machine, or the
 * log. A creature cannot escalate without a percept because there is no code path
 * by which it could.
 */
export class Creature {
  constructor({
    id = 0,
    archetype = 'creature',
    rng,
    position = vec(),
    bodyLength = 50,
    senseOffset = 0,
    fillRate = 0.1,
    decayRate = 0.01,
    memorySec = 120,
    threshold = 1,
    saturation = 2,
    falsePositiveBase = 0,
    longestSenseRange = FAR_PLANE,
    logCapacity = 64,
  } = {}) {
    this.id = id;
    this.archetype = archetype;
    this.position = vec(position.x, position.y, position.z);
    this.velocity = vec();
    this.bodyLength = bodyLength;

    // §5.2: sensing latency is not simulated, it falls out of the stagger.
    this.senseOffset = senseOffset % SENSE_PERIOD;

    this.fillRate = fillRate;
    this.decayRate = decayRate;
    this.memorySec = memorySec;
    this.threshold = threshold;
    this.saturation = saturation;
    this.falsePositiveBase = falsePositiveBase;
    this.longestSenseRange = longestSenseRange;

    // §8: promote far enough out that a creature is never promoted already
    // inside its own detection range.
    this.promotionRadius = longestSenseRange * 1.4;

    this.attention = 0;
    this.state = STATE.UNAWARE;
    /** 'full' | 'reduced'. §8: the reduced model may never produce a detection. */
    this.simLevel = 'reduced';

    /** Last percept-derived estimate. Position, its error, and how stale it is. */
    this.estimate = null;
    this.lastPerceptTime = -Infinity;

    this.rng = rng || null;
    this.rngSense = rng ? rng.fork(RNG_TAG.SENSE) : null;

    this._log = [];
    this._logCapacity = logCapacity;
    this._terms = { distance: 0, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0, samples: 0 };
    this._lastCause = null;
    this._transitions = 0;
    this.mediumSamplesLastTick = 0;
    this._senseSerial = 0;
    this._termsSerial = -1;
    /** Shared sink, set by `CreatureManager`, so `GAME.detectionLog()` is one list. */
    this.logSink = null;
  }

  /**
   * Fill `this._terms` from a path integral, and stamp it as belonging to this
   * sense tick. §4, and §7's requirement that a record explain itself.
   *
   * Archetypes must reach the medium through this rather than calling
   * `pathTerms` with their own destination object. The terms are what turns a log
   * line from "it was heard" into "it was heard at six kilometres *because it was
   * inside a duct*", and that clause is the whole point of the record. The stamp
   * is so the log can say when it is missing instead of quietly printing zeroes,
   * which is what it used to do for every event ever written.
   */
  measurePath(medium, from, to, t) {
    pathTerms(medium, from.x, from.y, from.z, to.x, to.y, to.z, t, this._terms);
    this._termsSerial = this._senseSerial;
    return this._terms;
  }

  /** §8. Detection is only ever produced by a fully simulated creature. */
  get fullySimulated() { return this.simLevel === 'full'; }

  /** Threshold right now. Archetypes that modulate it override this. */
  currentThreshold() { return this.threshold; }

  /**
   * One simulation step.
   *
   * Senses run at 10 Hz on the creature's own offset; behaviour runs every step,
   * because a 240 m body that only updates its heading ten times a second visibly
   * stutters when it passes close.
   */
  update(dt, tick, ctx) {
    if (this.fullySimulated && ((tick + this.senseOffset) % SENSE_PERIOD) === 0) {
      this._senseTick(ctx);
    }
    this.behave(dt, ctx);
    return this;
  }

  _senseTick(ctx) {
    this._senseSerial++;
    // `ctx.medium` is optional: an archetype that senses trails or contact never
    // touches it, and requiring it made `update()` throw for a creature that had
    // no use for one. Counting is optional on top of that.
    const counter = ctx.medium && ctx.medium.samplesTaken ? ctx.medium : null;
    const before = counter ? counter.samplesTaken() : 0;
    const percepts = this.sense(ctx) || [];
    this.mediumSamplesLastTick = counter ? counter.samplesTaken() - before : 0;

    // §5.4: multiple channels do not add. The strongest wins.
    let best = null, bestExcess = 0;
    for (let i = 0; i < percepts.length; i++) {
      const p = percepts[i];
      const e = perceptExcess(p.strength, p.threshold ?? this.currentThreshold(),
                              p.saturation ?? this.saturation);
      if (e > 0 && (best === null || e > bestExcess)) { best = p; bestExcess = e; }
    }

    if (best) {
      this.attention = clamp01(this.attention + this.fillRate * bestExcess * SENSE_DT);
      this.lastPerceptTime = ctx.t;
      this._lastCause = best;
      this.onPercept(best, ctx);
    } else {
      this.attention = clamp01(this.attention - this.decayRate * SENSE_DT);
      // §5.4: `memory` is how long the estimate survives after attention decays.
      if (this.estimate && ctx.t - this.lastPerceptTime > this.memorySec) this.estimate = null;
    }

    this._resolveStates(ctx, best);
  }

  /**
   * Walk the ladder. §6.
   *
   * One event per step of the ladder, never a jump, so the log reads as an
   * escalation rather than as a teleport. With a fill rate of 0.12 and a 0.1 s
   * tick, attention cannot move far enough in one tick to skip a rung anyway;
   * the loop is here so that stays true if a future archetype is faster.
   *
   * Two rules the first version of this got wrong, both worth stating because
   * both were invisible in the code and obvious in the log:
   *
   * **A resolve may only travel in one direction.** It used to `continue` after a
   * down-step, re-enter the loop and immediately promote again, so a single tick
   * could emit `COMMITTED→SEARCHING` and `SEARCHING→TRACKING` at the same
   * timestamp. The net observable transition was `COMMITTED→TRACKING`, which §6
   * forbids by name.
   *
   * **Leaving COMMITTED costs the attention too.** Fixing the loop alone is not
   * enough: COMMITTED's exit line is 0.736 and TRACKING's entry is 0.70, three
   * seconds apart at the Listener's decay, so a creature demoted to SEARCHING
   * would climb straight back into TRACKING and never hunt the area. Dropping
   * attention to `stateExit(TRACKING)` is not an invented number — it is exactly
   * the attention the creature would have held if it had walked down one rung at
   * a time, which is what "goes to SEARCHING, not TRACKING" has to mean if it
   * means anything.
   */
  _resolveStates(ctx, cause) {
    let dir = 0;
    for (let guard = 0; guard < STATE_ORDER.length; guard++) {
      const i = STATE_ORDER.indexOf(this.state);
      const up = STATE_ORDER[i + 1];
      if (dir >= 0 && up && this.attention >= STATE_ENTRY[up]) {
        dir = 1;
        this._transition(up, ctx, cause);
        continue;
      }
      if (dir <= 0 && i > 0 && this.attention < stateExit(this.state)) {
        dir = -1;
        if (this.state === STATE.COMMITTED) {
          // §6: something that has committed and lost you does not politely
          // resume tracking, it starts hunting the area.
          this.attention = Math.min(this.attention, stateExit(STATE.TRACKING));
          this._transition(STATE.SEARCHING, ctx, null);
        } else {
          this._transition(STATE_ORDER[i - 1], ctx, null);
        }
        continue;
      }
      break;
    }
  }

  _transition(to, ctx, cause, channel) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this._transitions++;
    this.onStateChange(from, to, ctx);
    this.logEvent(ctx, from, to, cause, channel);
  }

  /**
   * Move a creature without a percept, and say in the log that that is what
   * happened. §7.1 forbids turning towards the player without a percept; this is
   * the other direction, and the only caller is the manager enforcing §6's
   * one-COMMITTED rule.
   */
  forceState(to, ctx, channel = 'yield') {
    if (this.state === to) return false;
    const up = STATE_ORDER[STATE_ORDER.indexOf(to) + 1];
    // Keep attention consistent with the state it is being put into, or the next
    // resolve simply undoes this.
    if (up) this.attention = Math.min(this.attention, stateExit(up));
    this._transition(to, ctx, null, channel);
    return true;
  }

  /**
   * §7. Every state transition writes one of these. A transition without one is
   * the highest-severity bug in this project, which is why the write lives inside
   * `_transition` and not at any call site.
   */
  logEvent(ctx, from, to, cause, channel) {
    const c = cause || this._lastCause;
    const decayed = !cause;
    const fresh = this._termsSerial === this._senseSerial;
    const ev = {
      tick: ctx.tick,
      simTime: ctx.t,
      creature: this.id,
      archetype: this.archetype,
      from, to,
      channel: channel || (decayed ? 'decay' : c.channel),
      emitted: decayed ? null : (c.emitted ?? null),
      transmitted: decayed ? null : c.strength,
      threshold: this.currentThreshold(),
      distance: decayed ? (ctx.shipPos ? vdist(this.position, ctx.shipPos) : null)
        : (c.distance ?? (ctx.shipPos ? vdist(this.position, ctx.shipPos) : null)),
      medium: {
        rho_mean: this._terms.rho_mean,
        u_mean: this._terms.u_mean,
        q_mean: this._terms.q_mean,
        g_mean: this._terms.g_mean,
      },
      // The path terms are only this tick's if an archetype measured a path this
      // tick. A de-escalation carries the last measured path, and says so.
      mediumFresh: fresh,
      positionExact: decayed ? null : (c.positionExact ?? null),
      real: decayed ? null : c.real,
      attention: this.attention,
    };
    this._push(ev);
    return ev;
  }

  /** §8. Promotion is a log entry too, so nothing appears from nowhere. */
  logPromotion(ctx, from, to, distance) {
    return this._push({
      tick: ctx.tick, simTime: ctx.t, creature: this.id, archetype: this.archetype,
      from, to, channel: 'promotion',
      emitted: null, transmitted: null, threshold: this.currentThreshold(),
      distance,
      medium: { rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0 },
      mediumFresh: false, positionExact: null,
      real: null, attention: this.attention,
    });
  }

  _push(ev) {
    this._log.push(ev);
    if (this._log.length > this._logCapacity) this._log.shift();
    if (this.logSink) this.logSink(ev);
    return ev;
  }

  /** The last 64, oldest first. §7. */
  detectionLog() { return this._log.slice(); }
  transitionCount() { return this._transitions; }

  /**
   * §5.3. A false positive, or null.
   *
   * Drawn from the creature's own forked stream and evaluated on the sense tick,
   * so the same seed and the same inputs reproduce the same mistakes. An
   * encounter that cannot be replayed cannot be shown to be fair.
   *
   * The bearing is the caller's business: §5.3 requires a *plausible* direction,
   * and only the archetype knows what plausible means for its channel.
   */
  rollFalsePositive(mediumFactor, bearing, bearingSigma, channel) {
    if (!this.rngSense || this.falsePositiveBase <= 0) return null;
    const rate = this.falsePositiveBase * (1 + mediumFactor);
    if (!this.rngSense.chance(rate * SENSE_DT)) return null;
    const thr = this.currentThreshold();
    // Weak by construction: a mistake should be able to start a search and rarely
    // finish one. Squaring the draw puts most of them just over the line.
    const r = this.rngSense.float();
    const strength = thr + r * r * (this.saturation - thr) * 0.35;
    return makePercept(channel, strength, bearing, bearingSigma, 0,
      perceptExcess(strength, thr, this.saturation) * (1 - clamp01(bearingSigma)), false,
      { emitted: null });
  }

  // --- for archetypes ------------------------------------------------------

  /** @returns {Array} percepts this tick. Must be pure with respect to the world. */
  sense(_ctx) { return []; }
  /** Movement and everything the player can see. Runs every step. */
  behave(_dt, _ctx) {}
  /** Hook for archetypes that update an estimate. */
  onPercept(_percept, _ctx) {}
  /** Hook for posture changes. Must not touch attention or the log. */
  onStateChange(_from, _to, _ctx) {}

  snapshot() {
    return {
      id: this.id, archetype: this.archetype, state: this.state,
      attention: +this.attention.toFixed(4),
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      simLevel: this.simLevel,
      threshold: this.currentThreshold(),
      estimate: this.estimate ? { ...this.estimate } : null,
    };
  }
}

/**
 * Wrap a medium so it counts its own sampling.
 *
 * §8 caps a creature at 32 medium samples per sense tick, and a cap nobody
 * measures is a cap that has already been exceeded. `samplesTaken()` is that
 * number, in the contract's own unit: calls to `Medium.sample()`.
 *
 * **`fieldEvals()` is the other number, and the two are not interchangeable.**
 * One cold `sample()` costs one `densityAt` for the density plus, inside
 * `derive()`, four more for the tetrahedral gradient and one `flowAt` — and
 * `CloudSystem.flowAt` makes three further density evaluations of its own. So a
 * counter that says 8 can be hiding 64 evaluations of the field. The cache
 * amortises almost all of it in steady state, but a budget instrument that cannot
 * tell you the difference between eight and sixty-four is not an instrument.
 * `tests/creature.test.js` measures both against the real field.
 */
export function countingMedium(medium) {
  let n = 0;
  return {
    sample(x, y, z, t, dst) { n++; return medium.sample(x, y, z, t, dst); },
    transmittance: medium.transmittance,
    samplesTaken() { return n; },
    resetSamples() { n = 0; },
    /** Real field work underneath, when the wrapped medium can report it. */
    fieldEvals() { return medium.fieldEvals ? medium.fieldEvals() : null; },
    resetFieldEvals() { if (medium.resetFieldEvals) medium.resetFieldEvals(); },
    generation() { return medium.generation ? medium.generation() : null; },
    inner: medium,
  };
}

export { clamp, clamp01 };

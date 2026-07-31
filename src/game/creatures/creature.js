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
// `tests/listener.js` construct a world with no GPU in it at all, and a test that
// needs a WebGL context is a test that stops being run.

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
 *     second, is the single most expensive thing the AI could do. The cache is
 *     keyed on quantised position and time, so it returns bit-identical values
 *     whether or not it happens to be warm — a cache that changes results under
 *     replay is worse than no cache.
 */
export function createMedium(source, opts = {}) {
  if (!source) return createFlatMedium(opts);
  if (typeof source.sample === 'function') return source;
  if (typeof source.densityAt !== 'function') return createFlatMedium(opts);

  const cellM = opts.cellM ?? 64;         // metres per derived-field cache cell
  const cellS = opts.cellS ?? 1.0;        // seconds per derived-field cache generation
  const gradH = opts.gradH ?? 60;         // finite-difference arm, metres
  const cache = new Map();
  const out = makeMediumSample();
  const flowTmp = { x: 0, y: 0, z: 0, turbulence: 0 };

  const derive = (x, y, z, t) => {
    const ix = Math.round(x / cellM), iy = Math.round(y / cellM), iz = Math.round(z / cellM);
    const it = Math.round(t / cellS);
    const key = `${ix},${iy},${iz},${it}`;
    let e = cache.get(key);
    if (e) return e;
    const cx = ix * cellM, cy = iy * cellM, cz = iz * cellM;

    // Tetrahedral gradient: four evaluations instead of the six a central
    // difference needs, for the same order of accuracy.
    const h = gradH;
    const k0 = source.densityAt(cx + h, cy - h, cz - h, 0);
    const k1 = source.densityAt(cx - h, cy - h, cz + h, 0);
    const k2 = source.densityAt(cx - h, cy + h, cz - h, 0);
    const k3 = source.densityAt(cx + h, cy + h, cz + h, 0);
    const gx = (k0 - k1 - k2 + k3) / (4 * h);
    const gy = (-k0 - k1 + k2 + k3) / (4 * h);
    const gz = (-k0 + k1 - k2 + k3) / (4 * h);
    const rhoLocal = (k0 + k1 + k2 + k3) * 0.25;

    source.flowAt(cx, cy, cz, flowTmp);
    e = {
      duct: ductFromField(Math.hypot(gx, gy, gz), rhoLocal),
      turbulence: clamp01(flowTmp.turbulence),
      flow: { x: flowTmp.x, y: flowTmp.y, z: flowTmp.z },
      charge: chargeFromStorms(source, cx, cy, cz),
    };
    // Wholesale clear rather than an LRU. Values are a pure function of the key,
    // so dropping the table cannot change an answer, only its cost.
    if (cache.size > 8192) cache.clear();
    cache.set(key, e);
    return e;
  };

  return {
    sample(x, y, z, t, dst = out) {
      const e = derive(x, y, z, t);
      dst.density = clamp01(source.densityAt(x, y, z, 0));
      dst.temperature = AMBIENT_K;
      dst.charge = e.charge;
      dst.flow.x = e.flow.x; dst.flow.y = e.flow.y; dst.flow.z = e.flow.z;
      dst.turbulence = e.turbulence;
      dst.duct = e.duct;
      return dst;
    },
    /** Line of sight, when an archetype needs it. The Listener does not. */
    transmittance: source.transmittance ? source.transmittance.bind(source) : null,
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
 * Normalise the signature system into the one thing a sense needs: what the ship
 * was emitting at a given moment, **and where it was when it emitted it**.
 *
 * This is the one place the contract left room to disagree, so the reading is
 * stated here rather than assumed. §5.2 says an acoustic sense reads the past and
 * points at §3.4's recorder as the mechanism, but §3.4 lists six channels and no
 * position. Transmission (§4.1) needs a distance and a path, and both are
 * properties of where the sound was *made*, not of where the ship is now.
 *
 * **Chosen reading: the recorder stores position alongside the six channels.** It
 * is three more floats on a 14 KB buffer and it is the difference between a
 * detection that can be replayed and one that cannot.
 *
 * If a signature implementation does not store position, this adapter falls back
 * to the ship's current position and stamps `positionExact: false` on the
 * percept, which travels into the detection log. A log line that admits its own
 * path was approximated is worth more than one that quietly is.
 *
 * Accepted shapes, in order: `sampleAt(age)`, `at(age)`, `historyAt(age)`, a
 * bare function, or a live object read as "now".
 *
 * **The argument is an AGE IN SECONDS, not an absolute sim time.** This used to
 * be documented as an absolute time while the only history implementation in the
 * project — `SignatureRecorder.at(ageSec)` — took an age, and the two are mirror
 * images about the present. Measured: at t=60 s, `sampleAt(50.91)` (the absolute
 * time a 3 km listener should read) returned the sample from simTime 9.0, 42 s
 * wrong; and past t=300 s the absolute form returned null at every distance,
 * because the recorder rejects an age older than its buffer. A Listener wired to
 * the old docstring was scrambled for five minutes and then silently deaf
 * forever. One convention, stated here, and it is the age.
 */
export function createSignatureView(source) {
  const pick = (o) => (typeof o?.sampleAt === 'function' ? o.sampleAt.bind(o)
    : typeof o?.at === 'function' ? o.at.bind(o)
    : typeof o?.historyAt === 'function' ? o.historyAt.bind(o)
    : typeof o === 'function' ? o
    : null);

  const history = pick(source);
  const live = () => (typeof source?.current === 'function' ? source.current() : source);

  const norm = (s, fallbackPos, exact) => {
    if (!s) return null;
    const pos = s.position || s.pos || (s.x !== undefined ? s : null) || fallbackPos;
    return {
      acoustic: s.acoustic ?? 0,
      thermal: s.thermal ?? 0,
      photic: s.photic ?? 0,
      em: s.em ?? 0,
      wake: s.wake ?? 0,
      relSpeed: s.relSpeed ?? 0,
      x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0,
      positionExact: exact && !!(s.position || s.pos || s.x !== undefined),
      simTime: s.simTime ?? null,
    };
  };

  return {
    hasHistory: !!history,
    /**
     * What the ship was emitting `ageSec` ago, and where it was. Null once the
     * age runs off the end of the recorder — never the present pretending to be
     * the past, which §7 rates as the worst bug this project can have.
     */
    sampleAt(ageSec, fallbackPos) {
      if (!history) return norm(live(), fallbackPos, false);
      return norm(history(ageSec), fallbackPos, true);
    },
    /** Emissions right now. Contact channels only — everything else travels. */
    current(fallbackPos) {
      return norm(live(), fallbackPos, true);
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
    (e.real === false ? '  [false positive]' : '');
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
    const before = ctx.medium.samplesTaken ? ctx.medium.samplesTaken() : 0;
    const percepts = this.sense(ctx) || [];
    this.mediumSamplesLastTick =
      (ctx.medium.samplesTaken ? ctx.medium.samplesTaken() : 0) - before;

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
   */
  _resolveStates(ctx, cause) {
    for (let guard = 0; guard < STATE_ORDER.length; guard++) {
      const i = STATE_ORDER.indexOf(this.state);
      const up = STATE_ORDER[i + 1];
      if (up && this.attention >= STATE_ENTRY[up]) {
        this._transition(up, ctx, cause);
        continue;
      }
      if (i > 0 && this.attention < stateExit(this.state)) {
        // §6: something that has committed and lost you does not politely resume
        // tracking, it starts hunting the area.
        const down = this.state === STATE.COMMITTED ? STATE.SEARCHING : STATE_ORDER[i - 1];
        if (down === STATE.SEARCHING && this.state === STATE.COMMITTED) {
          // And the attention has to come down with it, or the rule is decorative.
          // COMMITTED exits at 0.736 and TRACKING is entered at 0.70 — the two
          // lines are 0.036 apart, which at the Listener's 0.012/s decay is three
          // seconds. Dropping to SEARCHING and leaving attention where it was put
          // the creature straight back into TRACKING on the next pass of this
          // loop: measured, the whole band [0.700, 0.735] mis-landed in TRACKING,
          // and that is exactly the band a decaying creature must pass through,
          // so it fired every time. The observable transition was COMMITTED→
          // TRACKING, which §6 forbids by name.
          //
          // 0.56 is not a new number: it is stateExit(TRACKING), the level at
          // which TRACKING would itself give up. Landing there puts the creature
          // in the middle of the SEARCHING band rather than on its edge, so
          // climbing back to TRACKING costs a real re-detection (0.14 of
          // attention) and decaying out of SEARCHING costs 16.7 s.
          this.attention = Math.min(this.attention, stateExit(STATE.TRACKING));
        }
        this._transition(down, ctx, null);
        continue;
      }
      break;
    }
  }

  _transition(to, ctx, cause) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this._transitions++;
    this.onStateChange(from, to, ctx);
    this.logEvent(ctx, from, to, cause);
  }

  /**
   * §7. Every state transition writes one of these. A transition without one is
   * the highest-severity bug in this project, which is why the write lives inside
   * `_transition` and not at any call site.
   */
  logEvent(ctx, from, to, cause) {
    const c = cause || this._lastCause;
    const decayed = !cause;
    const ev = {
      tick: ctx.tick,
      simTime: ctx.t,
      creature: this.id,
      archetype: this.archetype,
      from, to,
      channel: decayed ? 'decay' : c.channel,
      emitted: decayed ? null : (c.emitted ?? null),
      transmitted: decayed ? null : c.strength,
      threshold: this.currentThreshold(),
      distance: ctx.shipPos ? vdist(this.position, ctx.shipPos) : null,
      medium: {
        rho_mean: this._terms.rho_mean,
        u_mean: this._terms.u_mean,
        q_mean: this._terms.q_mean,
        g_mean: this._terms.g_mean,
      },
      real: decayed ? null : c.real,
      attention: this.attention,
    };
    this._push(ev);
    return ev;
  }

  /** §8. Promotion is a log entry too, so nothing appears from nowhere. */
  logPromotion(ctx, from, to, distance) {
    this._push({
      tick: ctx.tick, simTime: ctx.t, creature: this.id, archetype: this.archetype,
      from, to, channel: 'promotion',
      emitted: null, transmitted: null, threshold: this.currentThreshold(),
      distance,
      medium: { rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0 },
      real: null, attention: this.attention,
    });
  }

  _push(ev) {
    this._log.push(ev);
    if (this._log.length > this._logCapacity) this._log.shift();
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

// ---------------------------------------------------------------------------
// Above the creature
//
// Two rules the contract states and the base class structurally cannot keep,
// because a `Creature` cannot see its peers. They live here rather than in
// `main.js` for one reason: in `main.js` they cannot be tested, and both of them
// were wrong the first time they were written.
// ---------------------------------------------------------------------------

/**
 * §8. Decide which creatures are simulated in full this step.
 *
 * Nothing sets `simLevel` on its own and `update()` gates sensing on it, so a
 * creature nobody promotes runs `sense()` zero times a second. Measured: a
 * default creature senses 0 times in one second; a promoted one senses exactly
 * 10, which is `SENSE_PERIOD` at 120 Hz and is the contract's rate.
 *
 * The nearest `max` inside their own `promotionRadius` go to 'full'. The radius
 * is 1.4× the creature's longest sense range precisely so that nothing is ever
 * promoted while already inside its own detection range — §8's "nothing appears
 * from nowhere" — and every change is logged for the same reason.
 *
 * @param {Array}  creatures
 * @param {object} shipPos
 * @param {object} ctx        needs `tick` and `t` for the log entry
 * @param {number} max
 * @param {Array}  scratch    reused ordering buffer; pass one to allocate nothing
 * @returns {number} how many levels changed
 */
export function promoteByDistance(creatures, shipPos, ctx, max = 6, scratch = []) {
  scratch.length = 0;
  for (let i = 0; i < creatures.length; i++) scratch.push(creatures[i]);
  scratch.sort((a, b) => vdist(a.position, shipPos) - vdist(b.position, shipPos));
  let changed = 0;
  for (let i = 0; i < scratch.length; i++) {
    const c = scratch[i];
    const d = vdist(c.position, shipPos);
    const want = (i < max && d <= c.promotionRadius) ? 'full' : 'reduced';
    if (want === c.simLevel) continue;
    const from = c.simLevel;
    c.simLevel = want;
    c.logPromotion(ctx, from, want, d);
    changed++;
  }
  return changed;
}

/** While one creature is COMMITTED, nothing else may climb past this. */
export const CEDE_CEILING = stateExit(STATE.COMMITTED);

/**
 * §6 and §11.1: at most one creature may be COMMITTED at a time.
 *
 * Two simultaneous committed pursuers produce a situation with no readable
 * solution, which reads as unfair regardless of whether it is. The creature with
 * the most attention keeps it and everything else cedes.
 *
 * **Ceding is a ceiling, not a demotion, and that distinction is the whole
 * function.** The first version simply pushed the losers to SEARCHING and left
 * their attention alone, so each one re-committed on its very next sense tick
 * and was pushed down again — measured, 8729 forced demotions in a 500 s run
 * with three creatures on one target, which flooded the 64-entry detection log
 * with noise and destroyed the one thing §7 exists to provide. Holding attention
 * below COMMITTED's entry instead costs one demotion per encounter and parks the
 * runner-up in TRACKING, which is both legal and better drama: something else is
 * still coming, and the moment the holder gives up it is one percept from taking
 * over.
 *
 * @returns {number} how many creatures were forced down this call
 */
export function enforceSingleCommitted(creatures, ctx) {
  let holder = null;
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    if (c.state !== STATE.COMMITTED) continue;
    if (holder === null || c.attention > holder.attention) holder = c;
  }
  if (!holder) return 0;
  let forced = 0;
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    if (c === holder) continue;
    if (c.state === STATE.COMMITTED) {
      // The attention comes down with the state, or the demotion is decorative —
      // the same lesson as the natural fall out of COMMITTED in _resolveStates.
      c.attention = Math.min(c.attention, stateExit(STATE.TRACKING));
      c._transition(STATE.SEARCHING, ctx, null);
      forced++;
    }
    if (c.attention > CEDE_CEILING) c.attention = CEDE_CEILING;
  }
  return forced;
}

/**
 * Wrap a medium so it counts its own sampling.
 *
 * §8 caps a creature at 32 medium samples per sense tick, and a cap nobody
 * measures is a cap that has already been exceeded. The counter costs one integer
 * increment per sample and it is what lets `tests/listener.js` assert the budget
 * rather than assume it.
 */
export function countingMedium(medium) {
  let n = 0;
  return {
    sample(x, y, z, t, dst) { n++; return medium.sample(x, y, z, t, dst); },
    transmittance: medium.transmittance,
    samplesTaken() { return n; },
    resetSamples() { n = 0; },
    inner: medium,
  };
}

export { clamp, clamp01 };

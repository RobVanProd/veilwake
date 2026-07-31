// The Listener. Contract §10.1.
//
// 240 m long, functionally blind, and the first thing the player will ever have
// to outwit. Everything it does is built on `creature.js`, which is the shared
// formula library and the escalation machine — this file adds exactly two things
// the base class leaves to an archetype: what it can perceive, and what it does
// about it.
//
// ---------------------------------------------------------------------------
// The design requirement, above every other consideration here
// ---------------------------------------------------------------------------
// **It has to be readable.** A player must be able to watch it for two minutes,
// form a theory, test the theory, and be right. A creature that is merely
// unpredictable is not frightening, it is unfair, and the difference is Pillar 3.
//
// Everything below is therefore built out of rules a player can *see*:
//
//   - It lives somewhere. It orbits a territory centre on a slow circuit, so the
//     same creature comes back around and the player learns where "its" airspace
//     is rather than treating every encounter as a fresh die roll.
//   - It leaves a mark. While it is moving and not alarmed it carves a corridor
//     of cleared air 300 m across. The corridor is the map of everything it has
//     done, permanently on display, and it is the trap: a corridor is a duct, so
//     the fast comfortable road is where it hears best. It built the trap by
//     existing, and nothing about that had to be scripted.
//   - It stops carving when it notices you. That is the single most important
//     readable tell in the game, and it costs nothing to teach: the vapour ahead
//     simply stops being clear.
//   - It goes quiet on a schedule, and while it is quiet it hears three times
//     further. The player learns one sentence — *when it goes quiet, you go
//     quiet* — and then has to perform it.
//   - Its guess about where you are is wrong in a *specific* direction. It
//     infers range by assuming you are as loud as a cruising ship, so going
//     quiet does not just make you harder to hear, it makes it think you are
//     further away than you are. That is a lever the player can find by
//     experiment and it is the reward for paying attention.
//
// ---------------------------------------------------------------------------
// What is from the contract and what is a decision
// ---------------------------------------------------------------------------
// Marked at every constant below, because the next person needs to know which
// numbers they are allowed to move. The contract pins the sense parameters, the
// silence window, the call schedule, the corridor width and the SEARCHING and
// TRACKING closing speeds. It does not give a patrol speed, a COMMITTED speed, a
// turn rate, a patrol radius or a sweep shape, and those are marked as choices.
//
// No Three.js. Plain `{x, y, z}` throughout, so `tests/listener.test.js` runs
// with no GPU anywhere in the process.

import {
  Creature, STATE, FAR_PLANE,
  soundDelayS, pathTerms, acousticReceived, acousticBearingSigma,
  makePercept, perceptExcess, makeMediumSample,
  azimuth, wrapAngle, vec, vdist, clamp, clamp01,
} from './creature.js';

/** Everything the archetype is, in one place. §10.1 unless marked. */
export const LISTENER = {
  bodyLength: 240,            // §10.1
  emissionDb: 40,             // §10.1 — its own continuous low-frequency call

  // --- senses (§10.1, §5.4) ---------------------------------------------
  threshold: 16,              // dB(V)
  listeningThreshold: 6,      // dB(V), while the silence window is open
  saturation: 60,
  fillRate: 0.12,
  decayRate: 0.012,
  memorySec: 240,
  falsePositiveBase: 0.02,    // Hz, before the medium factor

  // --- the silence window (§10.1) ----------------------------------------
  silenceEverySec: [100, 160],
  silenceLastsSec: [18, 26],

  // --- calls (§10.1) ------------------------------------------------------
  callEverySec: [40, 90],
  callLastsSec: [6, 11],

  // --- the corridor (§10.1: "300 m across") ------------------------------
  corridorRadiusM: 150,
  corridorSpacingM: 150,      // CHOICE: one node per radius, so the recorded
                              // path has no gaps and no redundancy.
  corridorNodes: 96,          // CHOICE: 96 × 150 m = 14.4 km of history, about
                              // 48 min of patrol. Ring buffer; nothing grows.

  // --- movement -----------------------------------------------------------
  // SEARCHING and TRACKING are the contract's 500 m/min and 900 m/min.
  speed: {
    [STATE.UNAWARE]: 5.0,     // CHOICE: 300 m/min, below SEARCHING's 500
    [STATE.ALERT]: 2.0,       // CHOICE: §10.1 says "motion slows"
    [STATE.SEARCHING]: 500 / 60,
    [STATE.TRACKING]: 900 / 60,
    [STATE.COMMITTED]: 20.0,  // CHOICE: §10.1 says only "full speed". 1200 m/min
  },
  // CHOICE. 1.5°/s. At the COMMITTED speed that is a 764 m turning radius, which
  // is three body lengths — a creature this size must not pivot, and the player
  // has to be able to out-turn it. That is the escape the design wants.
  turnRateRad: 0.0262,
  patrolRadiusM: 1200,        // CHOICE: a 25 min circuit at the patrol speed
  sweepRad: 0.6,              // CHOICE: SEARCHING sweeps ±34° about the estimate
  sweepPeriodSec: 40,         // CHOICE: slow enough to read as deliberate

  // --- how it infers range (all CHOICES, and the interesting ones) --------
  // §5.1 is explicit that an acoustic percept carries no range — "only bearing
  // and loudness, which are confounded". The Listener therefore has to *assume*
  // a source level to turn loudness into a distance, and this is the assumption:
  // that the thing it heard is as loud as a ship at cruise, which is the same
  // 46 dB(V) reference §4.1's worked example uses throughout.
  //
  // The consequence is the whole reason to do it this way. A ship at idle is
  // 28 dB quieter than the assumption, and in open air 28 dB of spreading is a
  // factor of 25 in distance — so idling does not merely make you harder to
  // hear, it makes the Listener place you twenty-five kilometres away. Going
  // quiet actively misleads it, and a player can discover that by experiment.
  assumedEmittedDb: 46,
  // The estimate's radial error, as a fraction of its own range. Deliberately
  // large: the creature has no way to know how wrong its assumption is, and an
  // estimate that claimed to be good would make it act with a confidence it has
  // not earned.
  rangeSigmaFrac: 0.5,
  // How fast it assumes the thing it heard can move, for inflating a stale
  // estimate. Its own TRACKING closing speed — it assumes you are about as fast
  // as it is, which is wrong in the player's favour.
  estimateDriftMps: 900 / 60,
};

const TAU = Math.PI * 2;

/** Draw uniformly from a [lo, hi] pair, or return the number if it is one. */
const span = (rng, pair) =>
  (Array.isArray(pair) ? (rng ? rng.range(pair[0], pair[1]) : (pair[0] + pair[1]) / 2) : pair);

export class Listener extends Creature {
  /**
   * @param {object} opts  everything `Creature` takes, plus:
   * @param {object} opts.territory  {x, z} it patrols around. Defaults to where
   *   it was spawned, so a Listener always has somewhere it belongs.
   * @param {number} opts.patrolDir  +1 or -1. Which way round the circuit.
   */
  constructor(opts = {}) {
    super({
      archetype: 'Listener',
      bodyLength: LISTENER.bodyLength,
      fillRate: LISTENER.fillRate,
      decayRate: LISTENER.decayRate,
      memorySec: LISTENER.memorySec,
      threshold: LISTENER.threshold,
      saturation: LISTENER.saturation,
      falsePositiveBase: LISTENER.falsePositiveBase,
      longestSenseRange: FAR_PLANE,
      ...opts,
    });

    const t = opts.territory;
    this.territory = { x: t ? t.x : this.position.x, z: t ? t.z : this.position.z };
    this.patrolRadius = opts.patrolRadiusM ?? LISTENER.patrolRadiusM;
    this.patrolDir = opts.patrolDir ?? 1;

    /** World heading in radians, in the same frame as `azimuth()`. */
    this.heading = opts.heading ?? 0;
    this.speed = 0;

    // §5.3 requires the behaviour stream to be separate from the sense stream,
    // so that adding a draw in one cannot shift the sequence in the other.
    this.rngBehaviour = this.rng ? this.rng.fork(0x0003) : null;

    // --- the silence window ------------------------------------------------
    /** True while it is holding still and listening. §10.1. */
    this.silent = false;
    this._silenceAt = span(this.rngBehaviour, LISTENER.silenceEverySec);
    this._silenceEnds = 0;

    // --- calls -------------------------------------------------------------
    this.calling = false;
    this._callAt = span(this.rngBehaviour, LISTENER.callEverySec);
    this._callEnds = 0;
    /** Rises by one on each call, so audio can trigger on the edge. */
    this.callCount = 0;

    // --- the corridor ------------------------------------------------------
    this.carving = true;
    this.corridorRadius = LISTENER.corridorRadiusM;
    this._corridor = [];
    this._corridorHead = 0;
    this._carveDist = LISTENER.corridorSpacingM;   // lay one down immediately

    // --- scratch. Nothing in the hot path allocates. -----------------------
    this._percepts = [];
    this._local = makeMediumSample();
    this._est = { x: 0, z: 0, sigma: 0, tSec: -Infinity, bearing: 0, range: 0 };
    this._clock = 0;
  }

  // -------------------------------------------------------------------------
  // Sensing
  // -------------------------------------------------------------------------

  /** §10.1: 16 dB(V), and 6 dB(V) for the 18–26 s it spends listening. */
  currentThreshold() {
    return this.silent ? LISTENER.listeningThreshold : LISTENER.threshold;
  }

  /**
   * Acoustic only. It is functionally blind. §10.1.
   *
   * Nine medium samples per tick — eight along the path plus one at the body for
   * the false-positive rate — against §8's budget of 32.
   */
  sense(ctx) {
    const out = this._percepts;
    out.length = 0;
    const ship = ctx.shipPos;
    if (!ship || !ctx.medium) return out;

    const d = vdist(this.position, ship);
    if (d > FAR_PLANE) return out;      // §1: nothing detects beyond it

    // §5.2: what it hears now is what the ship emitted d/330 seconds ago, and
    // the argument is an AGE. At 3 km that is 9.1 s of the ship's past, which is
    // long enough for the player to have already changed their mind.
    const ageSec = soundDelayS(d);
    const past = ctx.signature ? ctx.signature.sampleAt(ageSec, ship) : null;

    // Into `this._terms` deliberately: the base class copies it into every
    // DetectionEvent, and a log line that cannot say "through rho 0.02 / duct
    // 0.81" is a log line that does not explain why it was heard at six
    // kilometres. Before this call the field was allocated and never written and
    // every event reported all four terms as zero.
    const terms = pathTerms(
      ctx.medium,
      this.position.x, this.position.y, this.position.z,
      ship.x, ship.y, ship.z,
      ctx.t, this._terms);

    const sigma = acousticBearingSigma(terms);
    const trueBearing = azimuth(this.position, ship);

    if (past) {
      const received = acousticReceived(past.acoustic, terms);
      // §5.1: the bearing handed on is already corrupted. Nothing downstream
      // gets to see the true one.
      const noise = this.rngSense ? this.rngSense.gaussian() * sigma : 0;
      const thr = this.currentThreshold();
      out.push(makePercept(
        'acoustic', received, wrapAngle(trueBearing + noise), sigma, ageSec,
        perceptExcess(received, thr, this.saturation) * (1 - clamp01(sigma)), true,
        { emitted: past.acoustic, positionExact: past.positionExact }));
    }

    // §5.3: reverberation in a duct is what a listener mistakes for a ship, so
    // the rate is scaled by the duct at its own body, not along the path.
    const local = ctx.medium.sample(
      this.position.x, this.position.y, this.position.z, ctx.t, this._local);
    const fp = this.rollFalsePositive(
      2.0 * local.duct, this._plausibleBearing(sigma), sigma, 'acoustic');
    if (fp) out.push(fp);

    return out;
  }

  /**
   * Where a mistake would plausibly come from. §5.3 asks for a plausible
   * direction rather than a uniform one, because a creature investigating
   * nothing at all in a random direction reads as broken rather than as mistaken.
   *
   * If it already has an estimate it doubts it in place; otherwise it hears
   * something roughly where it is already looking.
   */
  _plausibleBearing(sigma) {
    const rng = this.rngSense;
    const base = this.estimate ? this.estimate.bearing : this.heading;
    return wrapAngle(base + (rng ? rng.gaussian() * (sigma + 0.5) : 0));
  }

  // -------------------------------------------------------------------------
  // The estimate
  // -------------------------------------------------------------------------

  /**
   * Turn a bearing and a loudness into somewhere to go.
   *
   * `this.estimate` was declared by the base class and written by nothing, which
   * is why `memorySec` was dead code and SEARCHING and TRACKING — both of which
   * are *defined* as acting on an estimate — had nothing to aim at.
   *
   * A false positive updates it exactly like a real percept. §5.3 requires the
   * mistake to be indistinguishable inside the creature's own reasoning, and a
   * creature that quietly ignored its own errors would be one the player could
   * never learn to bait.
   */
  onPercept(p, ctx) {
    if (p.channel !== 'acoustic') return;
    const range = this._rangeFrom(p.strength);
    const x = this.position.x + Math.sin(p.bearing) * range;
    const z = this.position.z + Math.cos(p.bearing) * range;
    // Two independent errors: across the bearing, and along it.
    const lateral = range * p.bearingSigma;
    const radial = range * LISTENER.rangeSigmaFrac;
    this._fuse(x, z, Math.hypot(lateral, radial), p.bearing, range, ctx.t);
  }

  /**
   * Invert §4.1 for distance, assuming the source is as loud as a cruising ship.
   *
   * Bisection rather than algebra because spreading and absorption are a log and
   * a linear term in the same equation and there is no closed form. Twenty-four
   * halvings of [100 m, FAR_PLANE] settle to under a metre, and the whole thing
   * is a few dozen floating-point operations once every sense tick.
   *
   * It reuses the path terms measured on the way in, which is a small liberty:
   * strictly the creature does not know the density between itself and something
   * whose distance it has not yet worked out. It is defensible — the medium it
   * is embedded in is the medium it just listened through — and the alternative
   * is a second path integral for a number that is deliberately imprecise.
   */
  _rangeFrom(received) {
    const t = this._terms;
    const n = 20 - 8 * t.g_mean;
    const absorbPerM = 12 * t.rho_mean / 1000;
    const excess = LISTENER.assumedEmittedDb - received;
    const loss = (d) => n * Math.log10(Math.max(d, 100) / 100) + absorbPerM * d;
    if (loss(100) >= excess) return 100;
    if (loss(FAR_PLANE) <= excess) return FAR_PLANE;
    let lo = 100, hi = FAR_PLANE;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      if (loss(mid) < excess) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  /**
   * Blend a new fix into the old one, weighted by which is less wrong.
   *
   * Inverse-variance, with the old estimate's error inflated by how far the
   * target could have travelled since. Two consequences the player can feel: a
   * ship that keeps making noise gets pinned down as sigma shrinks, and an
   * estimate left alone dissolves on its own — after 60 s of silence a fix that
   * was good to 200 m is only good to 1100 m, which is a corridor width and a
   * half of somewhere else to be.
   */
  _fuse(x, z, sigma, bearing, range, t) {
    const e = this._est;
    if (!this.estimate || !(t - e.tSec < this.memorySec)) {
      e.x = x; e.z = z; e.sigma = sigma; e.bearing = bearing; e.range = range; e.tSec = t;
      this.estimate = e;
      return;
    }
    const stale = Math.max(0, t - e.tSec);
    const so = e.sigma + LISTENER.estimateDriftMps * stale;
    const vo = so * so, vn = sigma * sigma;
    const w = vo / (vo + vn);          // 1 means "trust the new fix entirely"
    e.x += (x - e.x) * w;
    e.z += (z - e.z) * w;
    e.sigma = Math.sqrt((vo * vn) / (vo + vn));
    e.bearing = bearing;
    e.range = range;
    e.tSec = t;
    this.estimate = e;
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  /**
   * §10.1's escalation table, one branch per row.
   *
   * Runs every step rather than on the sense tick, because a 240 m body that
   * only updates its heading ten times a second visibly stutters when it passes
   * close — and passing close is the whole shot.
   */
  behave(dt, ctx) {
    this._clock = ctx && ctx.t !== undefined ? ctx.t : this._clock + dt;
    this._updateSilence(dt);
    this._updateCalls(dt);

    // §10.1: while it is listening it emits nothing and it does not move. The
    // stillness is what makes the silence legible — it is not that the drone
    // stopped, it is that everything stopped.
    if (this.silent) {
      this.speed = 0;
      this.carving = false;
      return;
    }

    const wantSpeed = LISTENER.speed[this.state] ?? LISTENER.speed[STATE.UNAWARE];
    // §10.1: ALERT stops carving and the corridor begins to refill. That is the
    // tell, and it is free — the player sees the vapour ahead stop being clear.
    this.carving = this.state !== STATE.ALERT;

    let target;
    switch (this.state) {
      case STATE.SEARCHING:
        // Sweeps the estimate rather than driving at it, because the estimate is
        // probably wrong by hundreds of metres and §6 says this is the state the
        // player will spend the most time in and the one that must read clearest.
        target = this._towardEstimate()
          + LISTENER.sweepRad * Math.sin(TAU * this._clock / LISTENER.sweepPeriodSec);
        break;
      case STATE.TRACKING:
      case STATE.COMMITTED:
        target = this._towardEstimate();
        break;
      case STATE.ALERT:
      case STATE.UNAWARE:
      default:
        target = this._patrolHeading();
        break;
    }

    this._steer(target, wantSpeed, dt);
  }

  /** Bearing to the estimate, or straight on if it has lost the thread. */
  _towardEstimate() {
    const e = this.estimate;
    if (!e) return this.heading;
    return Math.atan2(e.x - this.position.x, e.z - this.position.z);
  }

  /**
   * Orbit the territory centre.
   *
   * Tangent to the ring when it is on the ring, turning inward when it has
   * drifted outside and outward when it has cut inside. The point is not the
   * geometry, it is that the creature has somewhere it belongs: the player who
   * watches for five minutes learns where its airspace is and can route around
   * it, and that is knowledge earned by observation rather than handed over.
   */
  _patrolHeading() {
    const dx = this.position.x - this.territory.x;
    const dz = this.position.z - this.territory.z;
    const r = Math.hypot(dx, dz);
    if (r < 1) return this.heading;
    const outward = Math.atan2(dx, dz);
    const err = clamp((r - this.patrolRadius) / this.patrolRadius, -1, 1);
    return outward + this.patrolDir * (Math.PI / 2) * (1 + err);
  }

  /** Turn toward a heading at the body's turn rate, then move. */
  _steer(targetHeading, wantSpeed, dt) {
    const turn = clamp(wrapAngle(targetHeading - this.heading),
      -LISTENER.turnRateRad * dt, LISTENER.turnRateRad * dt);
    this.heading = wrapAngle(this.heading + turn);

    // Speed changes over about ten seconds. A 240 m body does not accelerate,
    // and the slow build is what makes TRACKING read as inevitable.
    this.speed += (wantSpeed - this.speed) * (1 - Math.exp(-0.1 * dt));

    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    const step = this.speed * dt;
    this.position.x += sx * step;
    this.position.z += sz * step;
    this.velocity.x = sx * this.speed;
    this.velocity.y = 0;
    this.velocity.z = sz * this.speed;

    if (this.carving) {
      this._carveDist += step;
      if (this._carveDist >= LISTENER.corridorSpacingM) {
        this._carveDist = 0;
        this._pushCorridor();
      }
    }
  }

  _updateSilence(dt) {
    this._silenceAt -= dt;
    if (this.silent) {
      this._silenceEnds -= dt;
      if (this._silenceEnds <= 0) {
        this.silent = false;
        this._silenceAt = span(this.rngBehaviour, LISTENER.silenceEverySec);
      }
      return;
    }
    if (this._silenceAt > 0) return;
    // Suppressed once it is actually closing. A creature that stopped dead in
    // the middle of a committed run would be a bug the player would read as one,
    // and §10.1 describes the window as something it does while occupying its
    // territory, not while hunting.
    if (this.state === STATE.TRACKING || this.state === STATE.COMMITTED) {
      this._silenceAt = 5;
      return;
    }
    this.silent = true;
    this.calling = false;
    this._silenceEnds = span(this.rngBehaviour, LISTENER.silenceLastsSec);
  }

  _updateCalls(dt) {
    // §10.1: calls stop at ALERT and above. The drone changing character is the
    // player's first warning, and it arrives before anything has moved.
    if (this.state !== STATE.UNAWARE || this.silent) {
      this.calling = false;
      return;
    }
    if (this.calling) {
      this._callEnds -= dt;
      if (this._callEnds <= 0) {
        this.calling = false;
        this._callAt = span(this.rngBehaviour, LISTENER.callEverySec);
      }
      return;
    }
    this._callAt -= dt;
    if (this._callAt > 0) return;
    this.calling = true;
    this.callCount++;
    this._callEnds = span(this.rngBehaviour, LISTENER.callLastsSec);
  }

  // -------------------------------------------------------------------------
  // The corridor
  // -------------------------------------------------------------------------

  /**
   * Record where it has cleared the vapour.
   *
   * **It records; it does not carve.** Actually clearing density means writing
   * into `CloudSystem`, and this layer is deliberately headless — no Three.js,
   * no renderer, plain `{x, y, z}` — so the medium change belongs to whoever
   * owns the cloud field. This is the data that change would be driven from, and
   * until it is consumed the corridor exists in the simulation's bookkeeping and
   * not in the picture. Said plainly here rather than discovered later.
   */
  _pushCorridor() {
    const n = LISTENER.corridorNodes;
    const node = this._corridor[this._corridorHead % n] ||
      (this._corridor[this._corridorHead % n] = { x: 0, y: 0, z: 0, t: 0 });
    node.x = this.position.x; node.y = this.position.y; node.z = this.position.z;
    node.t = this._clock;
    this._corridorHead++;
  }

  /** The carved path, oldest first. Radius is `corridorRadius` at every node. */
  corridor() {
    const n = LISTENER.corridorNodes;
    const have = Math.min(this._corridorHead, n);
    const out = new Array(have);
    for (let k = 0; k < have; k++) {
      out[k] = this._corridor[(this._corridorHead - have + k + n * 2) % n];
    }
    return out;
  }

  // -------------------------------------------------------------------------

  /** Adds what a HUD, a capture or the voice needs on top of the base fields. */
  snapshot() {
    const s = super.snapshot();
    s.heading = +this.heading.toFixed(4);
    s.speed = +this.speed.toFixed(2);
    s.silent = this.silent;
    s.calling = this.calling;
    s.carving = this.carving;
    s.corridorNodes = Math.min(this._corridorHead, LISTENER.corridorNodes);
    return s;
  }

  /** What `src/audio/language.js` needs each frame. §9. */
  voiceState(shipPos) {
    return {
      state: this.state,
      attention: this.attention,
      distance: shipPos ? vdist(this.position, shipPos) : null,
      bearing: shipPos ? azimuth(this.position, shipPos) : 0,
      calling: this.calling,
      silent: this.silent,
      emissionDb: this.silent ? 0 : LISTENER.emissionDb,
    };
  }
}

/** Spawn a Listener with the contract's parameters filled in. §5.2's stagger. */
export function makeListener({ id = 0, rng = null, position = vec(), ...rest } = {}) {
  return new Listener({
    id,
    rng,
    position,
    // §5.2: the sense stagger is the sensing latency, and identical offsets both
    // spike the cost and remove the latency.
    senseOffset: id % 12,
    ...rest,
  });
}

export { STATE };

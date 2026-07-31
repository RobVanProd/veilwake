// The Listener. Contract §10.1.
//
// Two hundred and forty metres of blind animal that hunts by sound, carves the
// map as it moves, and every hundred-odd seconds stops dead and stops making
// noise so it can hear better. Everything it does is meant to be learnable by
// watching, because a creature that is merely unpredictable is not frightening,
// it is unfair — and the rule the player is supposed to end up with is one
// sentence: **when it goes quiet, you go quiet.**
//
// Three things in here are doing the design work, and all three are consequences
// of the contract rather than inventions on top of it.
//
// **It does not know how far away you are.** §5.1 is explicit that acoustic gives
// bearing and loudness and that the two are confounded. So this file does not
// cheat and read the ship's position into the estimate: it inverts §4.1's
// spreading term against an *assumed* source level of 46 dB(V) — the contract's
// own cruise anchor — and believes the answer. A ship that is quieter than the
// assumption is judged further away than it is, and an idling ship at 125 m is
// placed at three kilometres. That is not an error to be tuned out. It is the
// mechanic: what you emit does not just decide whether you are heard, it decides
// *where it thinks you are*, and a player who works that out can put the search
// somewhere they are not.
//
// **The silence is the sense.** Its own voice is 40 dB(V) and it is masking
// itself, so it stops. §10.1 gives the threshold drop as 16 → 6 dB(V), which is
// a factor of 3.2 on every range it has, and the arithmetic in §4.1 confirms it
// exactly: a cruising ship goes from audible at 3.16 km to audible at 10.0 km.
// Nothing else changes — not the fill rate, not the geometry. One number moves,
// and the map stops being safe.
//
// **The corridors are not level design.** It carves because it is enormous, and
// the carve satisfies §2.3's duct test on its own, so the cleared road is also
// the place sound travels furthest. See `corridor.js`; nothing about the player
// appears anywhere in it.
//
// Where the contract does not give a number, this file says so beside the number
// it chose. There are exactly three of those and they are listed in `LISTENER`.

import {
  Creature, STATE, FAR_PLANE, SOUND_SPEED, ACOUSTIC_REF, RNG_TAG,
  acousticReceived, acousticBearingSigma, perceptExcess, makePercept,
  azimuth, azimuthDir, wrapAngle, vec, vdist, makeMediumSample,
} from './creature.js';
import { clamp, clamp01, shortestAngle } from '../../core/math.js';
import { CorridorField } from './corridor.js';

/**
 * Everything the Listener is, in one block.
 *
 * Values marked `[contract]` are from CREATURE_BEHAVIOR_CONTRACT.md and changing
 * one means changing that file first. Values marked `[chosen]` are the three the
 * contract does not specify; each says what it was derived from.
 */
export const LISTENER = {
  bodyLength: 240,               // [contract §10.1] 1:17 against the ship

  // --- §5.4 attention ------------------------------------------------------
  fillRate: 0.12,                // [contract §5.4]
  decayRate: 0.012,              // [contract §5.4]
  memorySec: 240,                // [contract §5.4]

  // --- §10.1 senses --------------------------------------------------------
  threshold: 16,                 // [contract] dB(V), normally
  listeningThreshold: 6,         // [contract] dB(V), while listening
  saturation: 60,                // [contract] dB(V)
  falsePositiveBase: 0.02,       // [contract] Hz
  // §5.3: acoustic false positives scale with reverberation in ducts.
  falsePositiveMediumGain: 2.0,  // [contract §5.3]

  // --- §10.1 environmental signature --------------------------------------
  emissionDb: 40,                // [contract] continuous, very low frequency
  callEverySec: [40, 90],        // [contract] while UNAWARE
  callLengthSec: [6, 11],        // [contract]
  silenceEverySec: [100, 160],   // [contract] the mysterious behaviour
  silenceLengthSec: [18, 26],    // [contract]
  corridorRadiusM: 150,          // [contract] 300 m across
  corridorLifeSec: 240,          // [contract] "several minutes"

  /**
   * Closing speeds, metres per second.
   *
   * SEARCHING (500 m/min) and TRACKING (900 m/min) are [contract §10.1].
   *
   * UNAWARE is [chosen]: §10.1 says "slow circuits" and gives no number. 300
   * m/min is the largest speed strictly below SEARCHING's, so investigating is
   * always visibly faster than patrolling — which is the tell §10.1 asks the
   * player to read ("a corridor opening in a direction it was not going").
   *
   * ALERT is [chosen]: §6 says only "motion slows". Half of patrol.
   *
   * COMMITTED is [chosen]: §10.1 says "full speed" and gives no number. 1200
   * m/min continues the 500 → 900 ladder and is 13.5% of the ship's cruise
   * (148 m/s, `SIG.cruiseRel`), which is the constraint that actually matters:
   * §10 states that exactly one creature in the roster is a pursuer and it is
   * the Wake Hunter. A Listener that could run a ship down would make it two.
   * §10.1's own line is that escape from COMMITTED "requires the medium, not
   * manoeuvring" — it is terrifying because of where it is, not how fast.
   */
  speedMps: {
    [STATE.UNAWARE]: 300 / 60,
    [STATE.ALERT]: 150 / 60,
    [STATE.SEARCHING]: 500 / 60,
    [STATE.TRACKING]: 900 / 60,
    [STATE.COMMITTED]: 1200 / 60,
  },

  /**
   * The source level it assumes when it turns loudness into a range.
   *
   * [contract §3.2, the Cruise row]. Not a free parameter: it is the one anchor
   * a creature listening to a moving ship would have learned, and picking it
   * makes the inversion exact for a cruising ship and wrong in a stated
   * direction for everything else.
   */
  assumedSourceDb: 46,

  /**
   * How fast it assumes the thing it heard can move, for ageing an estimate.
   * [contract §3.2 / `SIG.cruiseRel`] — the ship's steady state at full main
   * throttle, 148 m/s.
   */
  assumedTargetSpeedMps: 148,

  /**
   * Minimum turn radius, as a multiple of body length.
   *
   * [chosen, from scale]. A 240 m body pivoting inside its own length reads as a
   * sprite rotating rather than as an animal turning, and §10.1's whole staging
   * requirement is that the creature never stops being enormous. Three body
   * lengths is 720 m, so at COMMITTED speed it takes 3.6 minutes to reverse
   * course — which is also why widening its error is a real evasion.
   */
  turnRadiusBodies: 3,

  /**
   * Seconds to come to a stop. [chosen, forced by §10.1]: the listening window is
   * 18–26 s and the contract says it "does not move" during it. Accelerating over
   * one body length would take 24 s to shed 20 m/s, which would consume the whole
   * window. Two seconds is 20 m of travel — a twelfth of its own body.
   */
  stopSeconds: 2.0,

  patrolRadiusM: 3000,
};

const TAU = Math.PI * 2;

export class Listener extends Creature {
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
      // §10.1: "to FAR_PLANE in a duct". The promotion radius in §8 is 1.4x
      // this, so it is never promoted already inside its own hearing.
      longestSenseRange: FAR_PLANE,
      ...opts,
    });

    this.rngVoice = this.rng ? this.rng.fork(RNG_TAG.VOICE) : null;
    this.rngBehaviour = this.rng ? this.rng.fork(RNG_TAG.BEHAVIOUR) : null;

    this.home = vec(this.position.x, this.position.y, this.position.z);
    this.heading = opts.heading ?? 0;
    this.speed = 0;

    // --- §10.1 the mysterious behaviour -----------------------------------
    /** True during a listening window: silent, still, and threshold 6. */
    this.listening = false;
    this._nextSilenceAt = this._draw(LISTENER.silenceEverySec);
    this._silenceEndsAt = -1;
    this.silenceCount = 0;

    // --- §9 voice ----------------------------------------------------------
    this.emissionDb = LISTENER.emissionDb;
    this.callActive = false;
    this.callEndsAt = -1;
    this._nextCallAt = this._draw(LISTENER.callEverySec);
    this.callCount = 0;

    // --- §10.1 environmental signature -------------------------------------
    this.corridor = opts.corridor || new CorridorField({
      radiusM: LISTENER.corridorRadiusM,
      lifeSec: LISTENER.corridorLifeSec,
    });
    /**
     * Carving is off until the renderer can show a corridor. §2.2 forbids an
     * approximation that favours the creature, and a duct the player cannot see
     * is exactly that. Turn it on in the same change that carves the picture.
     */
    this.carving = opts.carving ?? false;

    this._percepts = [];
    this._local = makeMediumSample();
    this._lastBearing = null;
    this._sweepPhase = 0;
  }

  _draw([lo, hi]) {
    return this.rngBehaviour ? this.rngBehaviour.range(lo, hi) : (lo + hi) * 0.5;
  }

  _drawVoice([lo, hi]) {
    return this.rngVoice ? this.rngVoice.range(lo, hi) : (lo + hi) * 0.5;
  }

  /** §10.1. The one number the silence moves. */
  currentThreshold() {
    return this.listening ? LISTENER.listeningThreshold : LISTENER.threshold;
  }

  // -------------------------------------------------------------------------
  // §10.1 Senses — acoustic only. It is functionally blind.
  // -------------------------------------------------------------------------

  /**
   * One acoustic percept, or none, plus §5.3's chance of a mistake.
   *
   * Nine medium samples: eight for §4's path integral and one at the ear, for
   * the local duct the false-positive rate scales with. §8 allows 32.
   *
   * The flight time is solved rather than assumed. `d/330` uses the distance to
   * where the ship is *now*, but the sound left from where it was *then*, and at
   * cruise those are 1.3 km apart over a 3 km path. The fixed point
   * `τ = |creature − ship(t−τ)| / 330` converges geometrically because
   * `|dd/dτ| ≤ v/c = 0.45`, so two passes land inside one simulation step. If no
   * position history was supplied the geometry falls back to the present and the
   * percept says so, which travels into the log — the delay is then observable in
   * what was emitted but not in where it came from.
   */
  sense(ctx) {
    const out = this._percepts;
    out.length = 0;

    const medium = ctx.medium;
    const sig = ctx.signature;
    if (!medium || !sig) return out;

    const ear = this.position;
    const local = medium.sample(ear.x, ear.y, ear.z, ctx.t, this._local);
    const gLocal = local.duct;
    const uLocal = local.turbulence;

    if (ctx.shipPos && vdist(ear, ctx.shipPos) <= FAR_PLANE) {
      let tau = vdist(ear, ctx.shipPos) / SOUND_SPEED;
      if (sig.hasPositions) {
        for (let i = 0; i < 2; i++) {
          const p = sig.positionAt(tau);
          if (!p) break;
          tau = vdist(ear, p) / SOUND_SPEED;
        }
      }

      // Null, not the present. §7 would rather have no detection than one built
      // on a sample from the wrong end of time.
      const rec = sig.at(tau, ctx.shipPos);
      if (rec) {
        const src = rec;
        const terms = this.measurePath(medium, ear, src, ctx.t);
        const received = acousticReceived(rec.acoustic, terms);
        const thr = this.currentThreshold();
        if (received > thr) {
          const sigma = acousticBearingSigma(terms);
          const bearing = wrapAngle(azimuth(ear, src) + this._gauss() * sigma);
          const excess = perceptExcess(received, thr, this.saturation);
          out.push(makePercept('acoustic', received, bearing, sigma, tau,
            excess * (1 - clamp01(sigma)), true, {
              emitted: rec.acoustic,
              distance: terms.distance,
              positionExact: rec.positionExact,
              g_mean: terms.g_mean,
              threshold: thr,
            }));
        }
      }
    }

    // §5.3. Reverberation in ducts, from the creature's own forked stream.
    const fp = this.rollFalsePositive(
      LISTENER.falsePositiveMediumGain * gLocal,
      this._plausibleBearing(),
      0.03 + 0.9 * uLocal + 0.5 * gLocal,
      'acoustic');
    if (fp) {
      fp.g_mean = gLocal;
      fp.distance = null;
      fp.positionExact = false;
      out.push(fp);
    }

    return out;
  }

  _gauss() { return this.rngSense ? this.rngSense.gaussian() : 0; }

  /**
   * §5.3: *"A false percept's bearing is drawn from a plausible direction, not a
   * uniform one — creatures investigating nothing at all in a random direction
   * read as broken rather than as mistaken."*
   *
   * Plausible here means: where it is already attending. Failing that, where it
   * is already pointed. Uniform within a right angle either side, which is half
   * the circle and demonstrably not the whole of it — a mistake should look like
   * a misheard version of what it was listening for.
   */
  _plausibleBearing() {
    const base = this.estimate ? this.estimate.bearing
      : this._lastBearing !== null ? this._lastBearing
      : this.heading;
    const spread = this.rngSense ? this.rngSense.spread(Math.PI / 2) : 0;
    return wrapAngle(base + spread);
  }

  // -------------------------------------------------------------------------
  // §5 The estimate
  // -------------------------------------------------------------------------

  /**
   * Fuse a percept into the position estimate.
   *
   * Bearing fuses by inverse variance, which is the standard weighting and has no
   * free constant in it. Before fusing, the held estimate's bearing error is
   * inflated for the time it has been sitting there — the target could have moved
   * `v·Δt` sideways, which is `v·Δt/range` radians — so an old estimate loses to
   * a fresh one automatically rather than because of a decay rate somebody
   * picked.
   *
   * Range is the confounded half. It comes from inverting §4.1's spreading term
   * against an assumed source level, using the spreading exponent this percept
   * actually travelled under, so a ducted contact reads as much further away than
   * it is. §4.1 calls that ambiguity "the single most useful in the game" and
   * asks for it not to be tuned away; this is where it lands.
   */
  onPercept(p, ctx) {
    if (p.channel !== 'acoustic') return;
    this._lastBearing = p.bearing;

    const g = p.g_mean ?? 0;
    const n = 20 - 8 * g;
    const range = clamp(
      ACOUSTIC_REF * Math.pow(10, (LISTENER.assumedSourceDb - p.strength) / n),
      ACOUSTIC_REF, FAR_PLANE);
    const sigma = Math.max(p.bearingSigma, 1e-3);

    const prev = this.estimate;
    let bearing = p.bearing, fused = sigma, r = range;

    if (prev) {
      const dt = Math.max(0, ctx.t - prev.tSec);
      const drift = LISTENER.assumedTargetSpeedMps * dt / Math.max(prev.range, ACOUSTIC_REF);
      const s0 = Math.hypot(prev.bearingSigma, drift);
      const w0 = 1 / (s0 * s0), w1 = 1 / (sigma * sigma);
      bearing = wrapAngle(prev.bearing + shortestAngle(prev.bearing, p.bearing) * (w1 / (w0 + w1)));
      fused = 1 / Math.sqrt(w0 + w1);
      r = (prev.range * w0 + range * w1) / (w0 + w1);
    }

    const dir = azimuthDir(bearing);
    this.estimate = {
      bearing,
      bearingSigma: fused,
      range: r,
      // Lateral spread of the search, in metres. The *radial* error is not
      // represented as a number because §5.1 says acoustic carries no range at
      // all; what the creature does about that is sweep, not widen.
      sigmaM: r * fused,
      x: this.position.x + dir.x * r,
      y: this.position.y,
      z: this.position.z + dir.z * r,
      tSec: ctx.t,
      real: p.real,
    };
  }

  // -------------------------------------------------------------------------
  // §10.1 Behaviour
  // -------------------------------------------------------------------------

  behave(dt, ctx) {
    const t = ctx.t;
    this._silence(t);
    this._voice(t);

    const state = this.state;
    const target = this.listening ? 0 : (LISTENER.speedMps[state] ?? 0);
    // Accelerating a 240 m body over its own length keeps the medium ahead of it
    // reading as pushed rather than teleported. Braking is a different manoeuvre
    // and gets its own number: §10.1's listening window is 18–26 s and the
    // creature has to actually be still for it, so a stop that ate a quarter of
    // the window would make "it does not move" false in play.
    //
    // The brake is a CONSTANT magnitude, floored at the patrol speed, and that
    // detail is the whole difference between the paragraph above being true and
    // being aspirational. Written as `max(this.speed, 1) / stopSeconds` the rate
    // shrank as the speed did, so the last metre per second took as long as the
    // first four: measured, a creature entering a window from its 5 m/s patrol was
    // still moving 5.1 s in and was fully stopped for only 73.2% of an 18–26 s
    // window, against a docstring promising two seconds. Flooring the rate at
    // `patrol / stopSeconds` makes the common case exactly the documented 2.0 s,
    // and the snap removes an asymptote that no fixed step ever actually reaches.
    const patrol = LISTENER.speedMps[STATE.UNAWARE];
    const rate = target > this.speed
      ? Math.max(target * target / (2 * this.bodyLength), 0.05)
      : Math.max(this.speed, patrol) / LISTENER.stopSeconds;
    this.speed += clamp(target - this.speed, -rate * dt, rate * dt);
    if (target === 0 && this.speed < rate * dt) this.speed = 0;

    const want = this._desiredHeading(state, t);
    if (want !== null && this.speed > 1e-3) {
      const omega = this.speed / (LISTENER.turnRadiusBodies * this.bodyLength);
      this.heading = wrapAngle(this.heading
        + clamp(shortestAngle(this.heading, want), -omega * dt, omega * dt));
    }

    const dir = azimuthDir(this.heading);
    this.velocity.x = dir.x * this.speed;
    this.velocity.y = 0;
    this.velocity.z = dir.z * this.speed;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // §10.1: ALERT stops carving and the corridor begins to refill. That is the
    // player-visible tell that something registered, and it is the only one they
    // get before SEARCHING.
    this.corridor.tick(t);
    const carvingNow = this.carving && !this.listening && state !== STATE.ALERT && this.speed > 0.5;
    if (carvingNow) this.corridor.carve(this.position.x, this.position.y, this.position.z, t);
    else this.corridor.lift();
  }

  /**
   * §10.1 per state. SEARCHING sweeps, TRACKING and COMMITTED turn onto the
   * estimate, UNAWARE walks its circuit and ALERT holds what it had.
   *
   * The sweep amplitude is the estimate's own bearing error, so the creature
   * searches exactly as wide as it is wrong — a ducted contact produces a wide,
   * slow sweep and a clear-air one a narrow, direct approach, and the player can
   * read which they caused. The sweep rate is the body's own turn rate, so
   * nothing here can ask it to move in a way it cannot.
   */
  _desiredHeading(state, t) {
    if (state === STATE.UNAWARE) {
      const dx = this.position.x - this.home.x, dz = this.position.z - this.home.z;
      const r = Math.hypot(dx, dz);
      const a = Math.atan2(dx, dz);
      // Tangent to the circuit, pulled in or pushed out until it is on it.
      const bias = clamp((r - LISTENER.patrolRadiusM) / LISTENER.patrolRadiusM, -1, 1);
      return wrapAngle(a + Math.PI / 2 - bias * (Math.PI / 3));
    }
    if (state === STATE.ALERT) return null;
    if (!this.estimate) return this._lastBearing;

    if (state === STATE.SEARCHING) {
      const amp = clamp(this.estimate.bearingSigma, 0.15, 1.2);
      const omega = Math.max(this.speed, 1) / (LISTENER.turnRadiusBodies * this.bodyLength);
      this._sweepPhase = (this._sweepPhase + omega * 0.1) % TAU;
      return wrapAngle(this.estimate.bearing + Math.sin(this._sweepPhase) * amp);
    }
    return this.estimate.bearing;
  }

  /**
   * §10.1. Every 100–160 s it goes completely silent and completely still for
   * 18–26 s, and its threshold drops from 16 to 6 dB(V).
   *
   * Both schedules come from the behaviour stream, so §12's requirement that the
   * mysterious behaviour be reproducible from a fixed seed is satisfied by
   * construction: the same seed produces the same windows at the same times, and
   * the encounter can be captured and looked at.
   */
  _silence(t) {
    if (this.listening) {
      if (t >= this._silenceEndsAt) {
        this.listening = false;
        this._nextSilenceAt = t + this._draw(LISTENER.silenceEverySec);
        // Its own voice comes back with it.
        this.emissionDb = LISTENER.emissionDb;
      }
      return;
    }
    if (t >= this._nextSilenceAt) {
      this.listening = true;
      this.silenceCount++;
      this._silenceEndsAt = t + this._draw(LISTENER.silenceLengthSec);
      this.emissionDb = 0;
      this.callActive = false;
      this.callEndsAt = -1;
      // A call scheduled during the window is not owed afterwards.
      this._nextCallAt = this._silenceEndsAt + this._drawVoice(LISTENER.callEverySec);
    }
  }

  /**
   * §10.1 calls every 40–90 s while UNAWARE; §9.4 makes the interval a function
   * of attention and nothing else. Loudness is deliberately not a threat cue.
   */
  _voice(t) {
    if (this.listening) return;
    if (this.callActive) {
      if (t >= this.callEndsAt) {
        this.callActive = false;
        const calm = this._drawVoice(LISTENER.callEverySec);
        this._nextCallAt = t + calm * (1 - 0.85 * this.attention);
      }
      return;
    }
    if (this.state !== STATE.UNAWARE) return;
    if (t >= this._nextCallAt) {
      this.callActive = true;
      this.callCount++;
      this.callEndsAt = t + this._drawVoice(LISTENER.callLengthSec);
    }
  }

  /** §9.3: the AI drives one scalar and the voice follows. */
  voiceState() {
    return {
      fundamentalHz: 24,
      partials: [1, 2, 3, 4],
      inharmonicity: this.attention,
      calling: this.callActive,
      silent: this.listening,
      emittedDb: this.emissionDb,
    };
  }

  snapshot() {
    const s = super.snapshot();
    s.listening = this.listening;
    s.heading = +this.heading.toFixed(4);
    s.speed = +this.speed.toFixed(3);
    s.calling = this.callActive;
    s.corridorSegments = this.corridor.liveCount();
    return s;
  }
}

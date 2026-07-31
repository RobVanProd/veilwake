// The Lantern. Contract §10.2.
//
// Ninety metres of body behind a lure array up to four hundred metres across,
// carrying between nine and twenty lights. It does not chase and it is not fast.
// It surrounds, and the thing it is best at is being worth approaching.
//
// **The dimming is the whole creature and it is not a timer.** §10.2:
//
//   > The lights are a lure. A lure is only useful while it still needs to
//   > attract something, and once the Lantern has a good enough estimate it stops
//   > advertising and starts closing. It goes dark because it has *finished*.
//
// So the brightness in this file is a readout of one question the creature asks
// itself every step — *how much of the lure's job is left?* — and nothing else
// touches it. There is no fade curve keyed to a state name and no countdown. The
// state correlation the player learns (bright while it is guessing, dark once it
// knows) is a *consequence* that has to be measured rather than asserted, and
// `tests/lantern.test.js` measures it: the same creature, at the same distance,
// after the same elapsed time, is bright against a dark ship and dark against a
// lit one. That is what makes **brightness is safety and darkness is commitment**
// learnable instead of merely true.
//
// Three things are doing the design work, all of them consequences of the
// contract rather than inventions on top of it.
//
// **It does not know how far away you are, and its two channels are wrong about
// it by different amounts.** §5.1 is explicit that neither photic nor EM carries
// range. So, like the Listener, this file inverts §4's transmission against an
// assumed source level — but it does it twice, against two assumptions with very
// different quality. The ship's light spans four decades (3 lm of instrument glow
// to 40 000 lm of scan flash, §3.2) and its EM spans barely one and a half in
// normal flight, and the EMU is *defined* so that reactor idle is exactly 1.0
// (§3.1). The EM range guess is therefore several times better constrained than
// the optical one, which is why a ship that goes dark does not thereby become
// unlocatable — and why a dark ship *is* placed much further away than it is,
// which is where "brightness is safety" comes from mechanically rather than
// thematically.
//
// **Cross-channel agreement is where §5.4's last sentence lands.** *"Multiple
// channels do not add; the strongest wins, and cross-channel agreement affects
// confidence rather than magnitude."* The Listener has one channel and cannot
// implement that sentence. This one has exactly two, so the strongest percept
// still drives attention (the base class does that and this file does not touch
// it), while the two independent range guesses fuse in log space and the fused
// spread is *inflated* when they disagree. Agreement makes the estimate tight;
// tight is what finishes the lure; finishing the lure is the dimming.
//
// **The charge cell is the honest early warning and it survives the dark.**
// §10.2: *"a rising electrical charge in the surrounding cells: q climbs by up to
// 0.5 within 600 m of it."* `stormCell()` exposes exactly that, shaped so
// `createMedium`'s own `chargeFromStorms` consumes it with no new code. It is a
// constant cell, not a function of attention, and that is deliberate: §10.2's
// "rising" is spatial — it rises as you fly closer — and COMMITTED's *"Nothing at
// all, then charge rising on the instrument"* is the creature closing on you in
// the dark. Both fall out of one constant.
//
// Where the contract does not give a number, this file says so beside the number
// it chose and what it was derived from. There are seven of those and they are
// all marked `[chosen]` in `LANTERN`.
//
// No renderer import. `lights()` returns plain data — position, lumens, an
// intensity in the renderer's units, colour and radius — so the creature stays
// headless and testable, and `main.js` spreads each entry into
// `bioluminescence()` from `src/render/lights.js`.

import {
  Creature, STATE, FAR_PLANE, SENSE_PERIOD, RNG_TAG,
  photicReceived, emReceived, perceptExcess, makePercept,
  azimuth, azimuthDir, wrapAngle, vec, vdist, makeMediumSample,
} from './creature.js';
import { clamp, clamp01, shortestAngle, approach, TAU } from '../../core/math.js';

/**
 * Everything the Lantern is, in one block.
 *
 * Values marked `[contract]` are from CREATURE_BEHAVIOR_CONTRACT.md and changing
 * one means changing that file first. Values marked `[chosen]` are the seven the
 * contract does not specify; each says what it was derived from.
 */
export const LANTERN = {
  bodyLength: 90,                // [contract §10.2] the body is rarely the thing you see
  lureSpanM: 400,                // [contract §10.2] the array spans up to 400 m
  lureDiameterM: 4,              // [contract §10.2] each light is 4 m across
  lureCountRange: [9, 20],       // [contract §10.2] "between nine and twenty of them"

  // --- §5.4 attention ------------------------------------------------------
  fillRate: 0.08,                // [contract §5.4]
  decayRate: 0.008,              // [contract §5.4]
  memorySec: 400,                // [contract §5.4]

  // --- §10.2 senses --------------------------------------------------------
  //
  // Two channels, and the base `Creature` owns one threshold, one saturation and
  // one false-positive rate. `_useChannel` points those three fields at one of
  // these sets while the Lantern reasons about that channel, and leaves them
  // pointed at whichever channel produced the strongest percept — which is what
  // makes a §7 log line's `threshold` field agree with its `channel` field
  // instead of quoting the other sense's number.
  photic: {
    threshold: 0.004,            // [contract §10.2] lux-eq
    saturation: 0.20,            // [contract §10.2] lux-eq
    falsePositiveBase: 0.05,     // [contract §10.2] Hz
    mediumGain: 1.5,             // [contract §5.3] scattering in cloud: 1.5 * rho_local
    /**
     * The source level it assumes when it turns brightness into a range.
     *
     * [contract §3.2, the Nav lights row]. Not a free parameter: 1200 lm is the
     * light a ship carries as a matter of course, so it is the anchor a creature
     * that has watched ships would have. Everything else is judged against it and
     * wrong in a stated direction — a ship running its search lamp is placed 2.7x
     * further away than it is, and a ship showing nothing but 3 lm of instrument
     * glow is placed *twenty times* further away than it is. That last one is the
     * mechanic, not an error: going dark does not make you invisible, it makes
     * you seem distant, and a Lantern that thinks you are distant keeps
     * advertising.
     */
    assumedSourceLm: 1200,
    /**
     * The span of ship photic emissions the assumption could be wrong across.
     * [contract §3.2]: 3 lm (instruments only — a fully dark ship emits 0 and is
     * not detected at all) to 40 000 lm (scan flash). Under the inverse-square
     * term in §4.2, `d ∝ sqrt(I)`, so the log-range uncertainty is
     * `0.5 * ln(hi/lo) / 2` = 2.374 — the half-width of the interval the truth
     * lies in. Nothing here is fitted; it is the arithmetic of not knowing which
     * row of §3.2 you are looking at.
     */
    sourceSpanLm: [3, 40000],
  },
  em: {
    threshold: 0.05,             // [contract §10.2] EMU
    saturation: 4.0,             // [contract §10.2] EMU
    falsePositiveBase: 0.03,     // [contract §10.2] Hz
    mediumGain: 4.0,             // [contract §5.3] charged cells: 4.0 * q_local
    /**
     * [contract §3.1]: *"EMU is the VEILWAKE electromagnetic unit, defined so
     * that reactor idle is exactly 1.0."* The assumption is the definition of the
     * unit, which is as anchored as an assumption gets.
     */
    assumedSourceEmu: 1.0,
    /**
     * [contract §3.2]: 1.0 (idle, the lowest powered state) to 60 (scan pulse).
     * `0.5 * ln(60/1) / 2` = 1.023, less than half the optical figure. The ship's
     * light varies by four decades and its reactor by one and a half, and that
     * asymmetry is the reason EM is this creature's ranging sense and its eyes
     * are only its lure-confirmation.
     */
    sourceSpanEmu: [1.0, 60],
  },

  /**
   * [contract §10.2]. The longest range in its own list is the scan *pre-charge*
   * on EM at 6000 m. §8's promotion radius is 1.4x this, so it is never promoted
   * already inside its own detection range.
   */
  longestSenseRange: 6000,

  // --- §10.2 environmental signature ---------------------------------------
  chargePeak: 0.5,               // [contract §10.2] "q climbs by up to 0.5"
  chargeReachM: 600,             // [contract §10.2] "within 600 m of it"

  // --- the lure ------------------------------------------------------------
  /**
   * Total luminous output of the array at full advertisement, lumens.
   *
   * [chosen, anchored on §4.2's own worked values]. §10.2 requires UNAWARE to
   * read as *"A beautiful thing at distance. Worth approaching. This is beat 2 of
   * the session"*, and §4.2 prints exactly one number for what 40 000 lm buys:
   * the ship's scan flash is seen to ~3160 m against the same 0.004 threshold
   * this creature uses. Matching the array to the brightest thing in the game
   * puts "at distance" at about three kilometres in clear air, which is a quarter
   * of `FAR_PLANE` and far enough that approaching it is a decision rather than a
   * reflex. In dense cloud §4.2 collapses that to a glow with no bearing — the
   * same trade the player's own lamps make, which is what makes it legible.
   *
   * Note that §4.2's printed ranges are the pure inverse-square answers and drop
   * the scatter weighting, so the *measured* reach of 40 000 lm through the real
   * formula is about 2.8 km rather than 3.16. `tests/lantern.test.js` reports the
   * measured number rather than the printed one; see its notes.
   */
  arrayLumens: 40000,
  /**
   * Below this total output, lumens, the array is off rather than dim.
   *
   * [derived]: §4.2 evaluates at `max(d, 10)` metres, so the strongest reading
   * any receiver can ever take of a source of `I` lumens is `I / 100` lux-eq.
   * Setting that equal to the 0.004 lux-eq threshold every range in §4.2 is
   * quoted against gives 0.4 lm — the output below which nothing in this world
   * can see the array from any distance at all. It is not a rounding tolerance;
   * it is the point where "dark" stops being an approximation.
   */
  darkLumens: 0.4,
  /**
   * Renderer units for one element at full brightness, and the light's radius and
   * colour. [contract: none]. These mirror `bioluminescence()`'s defaults in
   * `src/render/lights.js` so that `main.js` can spread a `lights()` entry
   * straight into that preset; they live here as plain numbers because importing
   * the renderer into a creature is what makes the creature layer untestable.
   * If the preset changes, these follow it — they are not an independent opinion.
   */
  renderIntensity: 1.6,
  lightRadiusM: 140,
  color: [0.28, 0.86, 0.92],

  /**
   * Ring geometry.
   *
   * `ringRadiusM` is half of §10.2's 400 m span: the furled array, which is what
   * the player sees while it is drifting.
   *
   * `ringMaxRadiusM` is [chosen] — §10.2 says elements are released and drift
   * outward and gives no limit. The full span is the limit that means something:
   * released, the ring reaches twice the furled radius, so the array's own size
   * is the only number in play. It also sets the escape budget, because §10.2's
   * avoidance is *"leave through the ring while it is still thin"* and a ring at
   * 400 m closing at the contract's 40 m/min takes ten minutes to arrive. That is
   * the "how long you have been deciding" §10.2 names.
   */
  ringRadiusM: 200,
  ringMaxRadiusM: 400,
  ringSpeedMps: 40 / 60,         // [contract §10.2] "The ring's closing speed is 40 m/min"

  /**
   * Body speed per state, metres per second.
   *
   * COMMITTED is [contract §10.2]: *"body closes at 300 m/min"*.
   *
   * SEARCHING and TRACKING are [chosen] and both equal the ring's own closing
   * speed. §10.2 gives exactly one non-committed speed for this creature and
   * inventing a second would be inventing a number; using the one it gives keeps
   * the array and the animal it is attached to moving as one thing, which is also
   * the only way the ring can stay centred on the body that released it.
   *
   * UNAWARE and ALERT are zero because §10.2 says *"Drifting"* and, at ALERT,
   * only that the lights orient. It moves with the flow in both, which is not the
   * same as not moving.
   */
  bodySpeedMps: {
    [STATE.UNAWARE]: 0,
    [STATE.ALERT]: 0,
    [STATE.SEARCHING]: 40 / 60,
    [STATE.TRACKING]: 40 / 60,
    [STATE.COMMITTED]: 300 / 60,
  },

  /**
   * How fast the array can swing onto a bearing, rad/s. [chosen, from scale]:
   * the tips of a 400 m array moving at the body's own fastest speed, i.e.
   * `bodySpeed(COMMITTED) / ringRadiusM` = 5 / 200. Nothing in the array is ever
   * asked to move faster than the animal can move. It takes about two minutes to
   * turn end for end, which is why §10.2's ALERT tell — *"lights orient"* — is
   * something the player notices over a while rather than in a moment.
   */
  orientRateRadS: (300 / 60) / 200,

  /**
   * How fast the lure follows its own need, e-foldings per second. [chosen]:
   * twice the calm tremolo rate, so a dim is always faster than the pulse it
   * interrupts and can never be read as a trough, and still slow enough (1.7 s
   * e-folding, ~5 s to settle) that it is a fade rather than a switch. A switch
   * would be unlearnable — the player has to see it *going*.
   */
  dimRate: 0.6,

  /**
   * §9.3 / §10.2 audio: 320 Hz, glassy, near-pure partials, *"a slow 0.3 Hz
   * tremolo while calm"*. The light and the sound are the same event, so this is
   * also the pulse rate of the lights, and §9.4 makes the interval — and only the
   * interval — the threat cue: `interval = calm * (1 - 0.85 * attention)`.
   */
  fundamentalHz: 320,
  tremoloHz: 0.3,
  /**
   * Tremolo depth. [chosen]: 0.45, so the trough sits at 0.55 of the peak. It has
   * to be deep enough to read as a pulse and shallow enough that a pulsing
   * lantern is never as dark as a dimming one, because the player is being asked
   * to tell those two apart and the whole creature depends on it.
   */
  tremoloDepth: 0.45,

  /**
   * How fast it assumes the thing it is looking for can move, for ageing an
   * estimate. [contract §3.2 / `SIG.cruiseRel`] — the ship's steady state at full
   * main throttle, 148 m/s.
   */
  assumedTargetSpeedMps: 148,
};

/** Log-range uncertainty of one channel's source assumption. §5.1 gives neither
 *  channel a range, so a range only exists by inverting §4 against an assumed
 *  source level; this is the half-width, in ln units, of being wrong about which
 *  row of §3.2 the ship is on. Both channels are inverse-square, hence the 0.5. */
const logSigma = ([lo, hi]) => 0.5 * Math.log(hi / lo) / 2;

const PHOTIC_LOG_SIGMA = logSigma(LANTERN.photic.sourceSpanLm);   // 2.374
const EM_LOG_SIGMA = logSigma(LANTERN.em.sourceSpanEmu);          // 1.023

export class Lantern extends Creature {
  constructor(opts = {}) {
    super({
      archetype: 'Lantern',
      bodyLength: LANTERN.bodyLength,
      fillRate: LANTERN.fillRate,
      decayRate: LANTERN.decayRate,
      memorySec: LANTERN.memorySec,
      threshold: LANTERN.photic.threshold,
      saturation: LANTERN.photic.saturation,
      falsePositiveBase: LANTERN.photic.falsePositiveBase,
      longestSenseRange: LANTERN.longestSenseRange,
      ...opts,
    });

    this.rngVoice = this.rng ? this.rng.fork(RNG_TAG.VOICE) : null;
    this.rngBehaviour = this.rng ? this.rng.fork(RNG_TAG.BEHAVIOUR) : null;

    this.heading = opts.heading ?? 0;
    /** Which of the two channels the base class's single threshold refers to. */
    this.activeChannel = 'photic';

    // --- the lure ----------------------------------------------------------
    /**
     * How much of the lure's job is left, 0..1. The dimming, in one number. See
     * `_lureNeed()`, which is the only thing in this file that decides it.
     */
    this.lureNeed = 1;
    /** What the lights are actually doing, lagging `lureNeed` by `dimRate`. */
    this.lureOutput = 1;
    this.litCount = 0;
    this.ringRadius = LANTERN.ringRadiusM;
    this.lures = this._buildArray(opts.lureCount);

    // Reused scratch. Declared before anything that uses them, because
    // `_solveReach` is called from this constructor and a field assigned three
    // lines later is `undefined` when it runs.
    this._percepts = [];
    this._local = makeMediumSample();
    this._flow = vec();
    this._lastBearing = null;
    this._lights = [];
    this._reachTerms = { distance: 0, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0 };
    this._fpTerms = { distance: 0, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0 };

    // §4.2 reach of the array at full output through the medium it is in. Set on
    // every sense tick; seeded here for clear air so a Lantern that has never
    // sensed still has a defensible answer instead of a zero.
    this._reachM = this._solveReach(0);

    // --- §9 voice ----------------------------------------------------------
    this._pulsePhase = 0;
    this.pulse = 1;
    this.pulseCount = 0;
    /** True on the step a light changed. §10.2: every change gets a crackle. */
    this.crackle = false;
    this.crackleCount = 0;

    // --- §10.2 environmental signature -------------------------------------
    // Shaped for `chargeFromStorms` in creature.js, which reaches to
    // `radius * 1.6` — so the radius that puts the contract's 600 m at the outer
    // edge is 600/1.6. Handing the medium a cell rather than patching the medium
    // keeps §2.2's one-field rule intact: the creature does not get its own
    // private charge field that the player's instrument cannot see.
    this._cell = {
      x: this.position.x, y: this.position.y, z: this.position.z,
      radius: LANTERN.chargeReachM / 1.6,
      charge: LANTERN.chargePeak,
    };
  }

  /**
   * Nine to twenty elements, per §10.2, spaced around the ring.
   *
   * Each carries a small angular rate of its own, so the ring is never evenly
   * thick. That is not decoration: §10.2's avoidance is *"leave through the ring
   * while it is still thin"*, and a perfectly regular ring has no thin part to
   * leave through. The rate is the ring's own closing speed over the ring's
   * largest radius, so an element crosses one element-spacing in a few minutes —
   * slow enough that a gap the player picked is still there when they reach it.
   */
  _buildArray(count) {
    const r = this.rngBehaviour;
    const [lo, hi] = LANTERN.lureCountRange;
    const n = count ?? (r ? r.int(lo, hi) : Math.round((lo + hi) / 2));
    const spin = LANTERN.ringSpeedMps / LANTERN.ringMaxRadiusM;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        angle: (i / n) * TAU + (r ? r.spread(TAU / (4 * n)) : 0),
        omega: r ? r.spread(spin) : 0,
        // The array is a volume, not a hoop. Half a body length of vertical
        // spread is the largest offset that still reads as one animal's array.
        yOff: r ? r.spread(LANTERN.bodyLength * 0.5) : 0,
        level: 1,
        x: 0, y: 0, z: 0,
        key: `creature/lantern/${this.id}/${i}`,
      });
    }
    return out;
  }

  /**
   * Point the base class's single-channel fields at one of the two channels.
   *
   * `Creature` was written for a creature with one sense — one `threshold`, one
   * `saturation`, one `falsePositiveBase` — and `rollFalsePositive` reads all
   * three off `this`. Rather than reimplement §5.3's draw with different numbers
   * (two copies of a formula is how two systems end up disagreeing by 3%), the
   * Lantern moves the fields. Whatever channel is selected when sensing ends is
   * the one `currentThreshold()` reports, and `sense()` ends by selecting the
   * channel that produced the strongest percept.
   */
  _useChannel(name) {
    const c = LANTERN[name];
    this.activeChannel = name;
    this.threshold = c.threshold;
    this.saturation = c.saturation;
    this.falsePositiveBase = c.falsePositiveBase;
    return c;
  }

  // -------------------------------------------------------------------------
  // §10.2 Senses — photic and electromagnetic
  // -------------------------------------------------------------------------

  /**
   * Up to two real percepts and up to two mistakes.
   *
   * Nine medium samples: eight for §4's path integral and one at the body, for
   * the local density and charge the false-positive rates scale with. §8 allows
   * 32. **Both channels share the one path integral**, and that is correct rather
   * than a saving: §5.2 gives both photic and EM zero extra latency, so both are
   * looking at the same instant along the same ray, and measuring the path twice
   * would be two answers to one question.
   *
   * The emission is read at age 0 rather than through `signature.current()`
   * because the recorder is what the view is built on and `current()` is only
   * defined when the view was handed a live `Signature`. At the recorder's 2 Hz
   * that is up to half a second stale, which is the entire latency budget of a
   * zero-latency channel and is worth knowing; it is not corrected here because
   * correcting it would mean reading the present, which §5.2 does not allow.
   */
  sense(ctx) {
    const out = this._percepts;
    out.length = 0;

    const medium = ctx.medium;
    const sig = ctx.signature;
    if (!medium || !sig) return out;

    const eye = this.position;
    const local = medium.sample(eye.x, eye.y, eye.z, ctx.t, this._local);
    const rhoLocal = local.density;
    const qLocal = local.charge;

    const rec = (ctx.shipPos && vdist(eye, ctx.shipPos) <= FAR_PLANE)
      ? sig.at(0, ctx.shipPos)
      : null;
    const terms = rec ? this.measurePath(medium, eye, rec, ctx.t) : null;

    // How far this array reaches right now, through the medium on the path it
    // can actually see along. `_lureNeed` measures the estimate against it.
    this._reachM = this._solveReach(terms ? terms.rho_mean : rhoLocal);

    // --- photic ------------------------------------------------------------
    const P = this._useChannel('photic');
    if (rec && rec.photic > 0) {
      const r = photicReceived(rec.photic, terms);
      if (r.total > P.threshold) {
        out.push(this._percept('photic', r.total, azimuth(eye, rec), r.bearingSigma, terms, rec, {
          emitted: rec.photic,
          // §5.1: photic carries no range. This is an inversion of §4.2's
          // inverse-square term against `assumedSourceLm`, and it is wrong by
          // however wrong that assumption is — which is the point. It inverts
          // only the inverse-square term and not the extinction weighting, for
          // the same reason §4.2's own worked ranges do: the creature cannot
          // know the density along a path it has not travelled, so it reads a
          // glow through cloud as a dimmer point in clear air and places it
          // further away. Fog buys distance in its belief as well as bearing.
          rangeLn: 0.5 * Math.log(P.assumedSourceLm / Math.max(r.total, 1e-12)),
          rangeLnSigma: PHOTIC_LOG_SIGMA,
        }));
      }
    }
    this._pushFalsePositive('photic', P.mediumGain * rhoLocal, rhoLocal, qLocal, out);

    // --- electromagnetic ---------------------------------------------------
    const E = this._useChannel('em');
    if (rec && rec.em > 0) {
      const r = emReceived(rec.em, terms);
      if (r.total > E.threshold) {
        out.push(this._percept('em', r.total, azimuth(eye, rec), r.bearingSigma, terms, rec, {
          emitted: rec.em,
          // §4.3 is flat inside 300 m, so the inversion cannot resolve anything
          // closer than that and says so by clamping. A creature that reported
          // 40 m from a channel that is constant below 300 would be inventing
          // precision the physics does not contain.
          rangeLn: Math.log(Math.max(300 * Math.sqrt(
            E.assumedSourceEmu * (1 + 1.5 * terms.q_mean) / Math.max(r.total, 1e-12)), 300)),
          rangeLnSigma: EM_LOG_SIGMA,
        }));
      }
    }
    this._pushFalsePositive('em', E.mediumGain * qLocal, rhoLocal, qLocal, out);

    // Leave the base class's threshold pointed at whatever won, so §7's log line
    // quotes the threshold belonging to the channel it names.
    this._selectStrongest(out);
    return out;
  }

  _percept(channel, strength, trueBearing, sigma, terms, rec, extra) {
    const c = LANTERN[channel];
    const bearing = wrapAngle(trueBearing + this._gauss() * sigma);
    const excess = perceptExcess(strength, c.threshold, c.saturation);
    return makePercept(channel, strength, bearing, sigma, 0,
      excess * (1 - clamp01(sigma)), true, {
        threshold: c.threshold,
        saturation: c.saturation,
        distance: terms.distance,
        positionExact: rec.positionExact,
        ...extra,
      });
  }

  /**
   * §5.3, through the base class's own draw so the mistake and the detection are
   * built by the same code.
   *
   * A false percept's bearing error is the one the volume it is actually looking
   * at produces, at the range this array works to — so a Lantern in thick cloud
   * makes vague mistakes and one in clear air makes sharp ones, from §4.2 and
   * §4.3 rather than from a number invented here. A mistake also has to *look*
   * like a misreading of what it was attending to, not a uniform draw, which is
   * `_plausibleBearing`.
   */
  _pushFalsePositive(channel, mediumFactor, rhoLocal, qLocal, out) {
    const t = this._fpTerms;
    t.distance = this._reachM;
    t.rho_mean = rhoLocal;
    t.q_mean = qLocal;
    const sigma = channel === 'photic'
      ? photicReceived(LANTERN.arrayLumens, t).bearingSigma
      : emReceived(1, t).bearingSigma;
    const fp = this.rollFalsePositive(mediumFactor, this._plausibleBearing(), sigma, channel);
    if (!fp) return;
    const c = LANTERN[channel];
    fp.threshold = c.threshold;
    fp.saturation = c.saturation;
    fp.distance = null;
    fp.positionExact = false;
    // A mistake carries a range too, or it could never move the estimate at all
    // and would be a percept the creature ignores — which is not what §5.3 means
    // by indistinguishable. It is placed where the lure reaches, because that is
    // where this creature's attention already is.
    fp.rangeLn = Math.log(this._reachM);
    fp.rangeLnSigma = channel === 'photic' ? PHOTIC_LOG_SIGMA : EM_LOG_SIGMA;
    out.push(fp);
  }

  /** The strongest by §5.4's excess, which is what the base integrator will pick. */
  _selectStrongest(list) {
    let best = null, bestExcess = -1;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const e = perceptExcess(p.strength, p.threshold, p.saturation);
      if (e > bestExcess) { best = p; bestExcess = e; }
    }
    if (best) this._useChannel(best.channel);
    return best;
  }

  _gauss() { return this.rngSense ? this.rngSense.gaussian() : 0; }

  /**
   * §5.3: *"A false percept's bearing is drawn from a plausible direction, not a
   * uniform one."* Plausible here is where it is already attending, failing that
   * where the array is already pointed, spread over a right angle either side.
   */
  _plausibleBearing() {
    const base = this.estimate ? this.estimate.bearing
      : this._lastBearing !== null ? this._lastBearing
      : this.heading;
    return wrapAngle(base + (this.rngSense ? this.rngSense.spread(Math.PI / 2) : 0));
  }

  /**
   * How far the array reaches, in metres, through a medium of mean density
   * `rhoMean`: the distance at which §4.2 puts the whole array at the 0.004
   * lux-eq threshold every worked range in that section is quoted against.
   *
   * This is the normalisation `_lureNeed` divides by, and it is measured rather
   * than picked — which matters, because it is medium-dependent in the direction
   * that makes the creature behave correctly: in thick cloud the reach collapses,
   * so an estimate of a given quality counts as *worse* relative to it, so the
   * Lantern keeps advertising. Shining harder in fog is all it can do, and §4.2
   * says that makes it a large vague presence rather than a located one. Both
   * sides of that trade are the same formula.
   *
   * `photicReceived` falls monotonically in distance, so bisection is exact to
   * the interval width; 24 halvings of 12 km is under a millimetre.
   */
  _solveReach(rhoMean) {
    const t = this._reachTerms;
    t.rho_mean = rhoMean;
    let lo = 10, hi = FAR_PLANE;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      t.distance = mid;
      if (photicReceived(LANTERN.arrayLumens, t).total >= LANTERN.photic.threshold) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // -------------------------------------------------------------------------
  // §5 The estimate
  // -------------------------------------------------------------------------

  /**
   * Fuse everything this tick produced, then fuse that into what it held.
   *
   * The base class hands over only the strongest percept, because §5.4 says the
   * strongest is what drives attention. It is *not* what should drive the
   * estimate: the same section ends *"cross-channel agreement affects confidence
   * rather than magnitude"*, and that clause only means something if both
   * channels are allowed to speak. So this reads `this._percepts` — the array
   * `sense()` built this tick, mistakes included, because §5.3 requires a false
   * percept to be indistinguishable inside the creature's own reasoning.
   *
   * Bearings fuse as unit vectors weighted by inverse variance, which is the
   * circular mean and has no free constant in it. Ranges fuse in *log* space,
   * because both inversions are inverse-square and a factor-of-two error is
   * symmetric in logs and wildly asymmetric in metres.
   *
   * The disagreement inflation is the part that earns its place. If the two
   * channels' ranges differ by `k` combined sigmas, at least one source
   * assumption is wrong, and the fused answer is worse than either sigma claims —
   * so the fused sigma is scaled by `max(1, k)`. That is the standard chi
   * inflation, not a tuned penalty, and it is what makes agreement *do* something
   * rather than merely be reported.
   */
  onPercept(_best, ctx) {
    const list = this._percepts;
    if (!list.length) return;

    let wb = 0, bx = 0, bz = 0;
    let wl = 0, lsum = 0;
    let lp = null, le = null;
    let kb = 0;
    let firstBearing = null, firstSigma = 0;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const s = Math.max(p.bearingSigma, 1e-3);
      const w = 1 / (s * s);
      bx += Math.sin(p.bearing) * w;
      bz += Math.cos(p.bearing) * w;
      wb += w;
      if (firstBearing === null) { firstBearing = p.bearing; firstSigma = s; }
      else kb = Math.abs(shortestAngle(firstBearing, p.bearing)) / Math.hypot(firstSigma, s);

      if (p.rangeLn !== undefined) {
        const ls = Math.max(p.rangeLnSigma, 1e-3);
        const wr = 1 / (ls * ls);
        lsum += p.rangeLn * wr;
        wl += wr;
        if (p.channel === 'photic') lp = p.rangeLn; else if (p.channel === 'em') le = p.rangeLn;
      }
    }
    if (wb <= 0 || wl <= 0) return;

    let bearing = Math.atan2(bx, bz);
    let bearingSigma = 1 / Math.sqrt(wb);
    let lnR = lsum / wl;
    let tickLnSigma = 1 / Math.sqrt(wl);

    let kr = 0;
    if (lp !== null && le !== null) {
      kr = Math.abs(lp - le) / Math.hypot(PHOTIC_LOG_SIGMA, EM_LOG_SIGMA);
      if (kr > 1) tickLnSigma *= kr;
    }
    // §5.4's "confidence" for this creature: the Gaussian likelihood that two
    // independent senses looking at one thing would differ by this much. 1 when
    // they agree exactly, and it deliberately changes no magnitude anywhere.
    const agreement = (lp !== null && le !== null) ? Math.exp(-0.5 * (kb * kb + kr * kr)) : 0;

    this._lastBearing = bearing;

    /**
     * **The range sigma does not shrink with repetition, and that is physics
     * rather than a safety clamp.** The error in a range that came from
     * inverting §4 against an assumed source level is *systematic* — every
     * sample of a ship that is holding station shares it exactly — so staring at
     * it for five minutes does not narrow it by sqrt(3000). The only thing that
     * narrows it is genuinely new information, and for this creature that means
     * the other channel.
     *
     * Getting this wrong is not a small error, it is a different creature: the
     * first version fused the range sigma across time like the bearing, the
     * estimate reached 0.107 after a few hundred ticks whatever the ship did,
     * and the lure went out on a schedule. The dimming became a timer wearing
     * the right variable names, which is exactly what §10.2 says it must not be.
     *
     * The bearing above *is* fused across time, and that is correct for the
     * opposite reason: §4's bearing error is drawn fresh from the RNG on every
     * tick, so it is genuinely random and genuinely averages down.
     */
    let lnSigma = tickLnSigma;

    const prev = this.estimate;
    if (prev) {
      // The target could have moved while the estimate sat there. At range R a
      // move of v*dt is v*dt/R radians *and* v*dt/R in fractional range, so one
      // quantity inflates both — an old estimate loses to a fresh one because it
      // is older, not because of a decay rate somebody picked.
      const dt = Math.max(0, ctx.t - prev.tSec);
      const drift = LANTERN.assumedTargetSpeedMps * dt / Math.max(prev.range, 100);

      const s0 = Math.hypot(prev.bearingSigma, drift);
      const w0 = 1 / (s0 * s0);
      const px = Math.sin(prev.bearing) * w0 + bx, pz = Math.cos(prev.bearing) * w0 + bz;
      bearing = Math.atan2(px, pz);
      bearingSigma = 1 / Math.sqrt(w0 + wb);

      // The *value* still blends, so the range does not jitter from tick to
      // tick; only the confidence in it refuses to compound.
      const l0 = Math.hypot(prev.rangeLnSigma, drift);
      const v0 = 1 / (l0 * l0), v1 = 1 / (tickLnSigma * tickLnSigma);
      lnR = (Math.log(prev.range) * v0 + lnR * v1) / (v0 + v1);
    }

    const range = clamp(Math.exp(lnR), 10, FAR_PLANE);
    const dir = azimuthDir(bearing);
    // Lateral spread of the search, metres.
    const sigmaM = range * bearingSigma;
    // Radial spread, metres: the half-width of `[range*e^-s, range*e^+s]` is
    // exactly `range * sinh(s)`. This is the number the Listener explicitly does
    // not have — acoustic carries no range at all — and the Lantern only has it
    // because it has two channels to disagree with each other.
    const radialM = range * Math.sinh(lnSigma);
    this.estimate = {
      bearing,
      bearingSigma,
      range,
      rangeLnSigma: lnSigma,
      sigmaM,
      radialM,
      // Held as a value rather than a getter: `_lureNeed` reads it every step at
      // 120 Hz and `snapshot()` spreads the object, and a getter is a different
      // thing in each of those.
      spreadM: Math.hypot(sigmaM, radialM),
      agreement,
      /** The two channels' range disagreement, in combined sigmas. §5.4. */
      disagreement: kr,
      channels: (lp !== null ? 1 : 0) + (le !== null ? 1 : 0),
      x: this.position.x + dir.x * range,
      y: this.position.y,
      z: this.position.z + dir.z * range,
      tSec: ctx.t,
      real: list.every((p) => p.real),
    };
  }

  // -------------------------------------------------------------------------
  // §10.2 The dimming
  // -------------------------------------------------------------------------

  /**
   * How much of the lure's job is left, 0..1. **This is the creature.**
   *
   * §10.2: *"A lure is only useful while it still needs to attract something, and
   * once the Lantern has a good enough estimate it stops advertising and starts
   * closing."* A lure therefore has exactly two ways to be finished, and §10.2
   * names both in one sentence — *"As the player gets closer, **or** as the
   * Lantern gets more certain"*. So this is a `min`, not a product: either one
   * finishes it.
   *
   *   `stillFar`     — is there anything left to draw in? Measured from the ring,
   *                    which is the tool the lure hands off to, out to the reach,
   *                    which is the furthest the lure can be seen at all. Inside
   *                    the ring there is nothing left to attract; beyond the
   *                    reach the lure is the only instrument it has.
   *   `stillUnknown` — is the estimate worth acting on? Measured against the same
   *                    reach, because that is the size of the volume the lure is
   *                    lighting: an uncertainty as big as the lit volume means
   *                    "somewhere in my light", which is what the lure exists to
   *                    narrow, and an uncertainty far smaller means the lure has
   *                    already done everything it can do.
   *
   * COMMITTED returns zero directly, and that is not a special case bolted on to
   * match the escalation table. §6 defines COMMITTED as *"it has the player"*.
   * There is definitionally nothing left to attract.
   *
   * **The estimate ages while it is being read, not only while it is being
   * fused.** The target could have moved `v*age` since the last percept, which is
   * `v*age/range` in radians and the same fraction in range, so an estimate that
   * is not being refreshed grows until it is worth nothing and the lure comes
   * back on by itself. Without this the creature stays dark for the whole 400 s
   * of §5.4 memory after the player has gone, which would teach the player the
   * wrong rule: darkness would mean "it knew where you were at some point",
   * rather than **now**, and the rule has to be about now or it is not
   * actionable.
   *
   * Note what the *range* here is: the creature's belief, not the truth. A ship
   * that shows less light than the assumed 1200 lm is placed further away than it
   * is (see `assumedSourceLm`), so it keeps the lantern bright — and a bright,
   * loud ship is placed correctly and puts it out. That is the whole of
   * **brightness is safety and darkness is commitment**, arrived at without
   * either sentence being written into the code.
   */
  _lureNeed(t) {
    if (this.state === STATE.COMMITTED) return 0;
    const e = this.estimate;
    // Nothing at all: the lure is the only thing it can do, so it does it fully.
    if (!e) return 1;

    const drift = LANTERN.assumedTargetSpeedMps * Math.max(0, t - e.tSec)
      / Math.max(e.range, 100);
    const lateral = e.range * Math.hypot(e.bearingSigma, drift);
    const radial = e.range * Math.sinh(Math.hypot(e.rangeLnSigma, drift));
    const spread = Math.hypot(lateral, radial);

    const reach = Math.max(this._reachM, LANTERN.ringRadiusM + 1);
    // The far edge of the belief, not its centre: a lure still has work to do if
    // the thing it wants might be outside the ring, and "might be" is what an
    // estimate with a spread on it means.
    const stillFar = clamp01((e.range + spread - LANTERN.ringRadiusM)
      / (reach - LANTERN.ringRadiusM));
    const stillUnknown = clamp01(spread / reach);
    return Math.min(stillFar, stillUnknown);
  }

  // -------------------------------------------------------------------------
  // §10.2 Behaviour
  // -------------------------------------------------------------------------

  behave(dt, ctx) {
    this.crackle = false;
    this._flowResponse(ctx);
    this._voice(dt);
    this._dim(dt, ctx.t);
    this._move(dt);
    this._ring(dt);
    this._cell.x = this.position.x;
    this._cell.y = this.position.y;
    this._cell.z = this.position.z;
  }

  /**
   * The one medium sample a reduced creature is allowed.
   *
   * §8: *"A distant creature outside the six runs position, flow response and
   * audio only, with no senses and no attention."* This is that flow response. It
   * produces no percept and cannot: it reads the medium and writes a velocity.
   * Once per sense period rather than every step, because flow is cached on a
   * 64 m grid in `createMedium` and sampling it at 120 Hz would be 120 lookups of
   * a value that changes twelve times a second at most.
   */
  _flowResponse(ctx) {
    if (!ctx.medium || (ctx.tick % SENSE_PERIOD) !== 0) return;
    const p = this.position;
    const m = ctx.medium.sample(p.x, p.y, p.z, ctx.t, this._local);
    this._flow.x = m.flow.x; this._flow.y = m.flow.y; this._flow.z = m.flow.z;
  }

  /**
   * §9.4: the interval between vocalisations is the threat cue and the only one.
   * §10.2 makes the light and the sound the same event, so this drives both — the
   * tremolo, the pulse of the lights, and the crackle that marks every change.
   *
   * At attention 0 it pulses at the contract's calm 0.3 Hz; at attention 1,
   * `0.3 / (1 - 0.85)` = 2 Hz. Nothing about the *loudness* changes, per §9.
   */
  _voice(dt) {
    const hz = LANTERN.tremoloHz / Math.max(1 - 0.85 * this.attention, 1e-3);
    this._pulsePhase += hz * TAU * dt;
    if (this._pulsePhase >= TAU) {
      this._pulsePhase -= TAU;
      this.pulseCount++;
      // §10.2: *"the dimming has a sound even when it has no light"*. The array
      // is a circuit and it keeps cycling after the lights are out, which is why
      // this fires unconditionally and is the player's only cue at COMMITTED.
      this._crackle();
    }
    this.pulse = 1 - LANTERN.tremoloDepth * 0.5 * (1 - Math.cos(this._pulsePhase));
  }

  /**
   * Follow the need. Elements go out one at a time rather than the array fading
   * as a unit, because §10.2's SEARCHING tell is *"Individual lights separating"*
   * and the player has to be able to count what is left. The cascade is exact:
   * the levels sum to `lureOutput * n`, so total output is `arrayLumens *
   * lureOutput` however many elements happen to be lit.
   */
  _dim(dt, t) {
    this.lureNeed = this._lureNeed(t);
    this.lureOutput = approach(this.lureOutput, this.lureNeed, LANTERN.dimRate, dt);
    // An exponential approach never arrives, and §10.2's COMMITTED row says
    // *"Fully dark"* without qualification. `darkLumens` is where the array stops
    // being a light at all, so this is a snap to off rather than a rounding: a
    // creature emitting 1e-48 lm is dark in every sense except the one a test
    // reads, and "dark" has to be a state the player can be certain of.
    if (this.lureOutput * LANTERN.arrayLumens < LANTERN.darkLumens) this.lureOutput = 0;
    const n = this.lures.length;
    const x = this.lureOutput * n;
    let lit = 0;
    for (let i = 0; i < n; i++) {
      const lv = clamp01(x - i);
      this.lures[i].level = lv;
      if (lv > 0) lit++;
    }
    if (lit !== this.litCount) this._crackle();
    this.litCount = lit;
  }

  _crackle() { this.crackle = true; this.crackleCount++; }

  /**
   * Drift, and orient.
   *
   * Orientation is not steering: §10.2's ALERT tell is *"lights orient"* with no
   * translation at all, so the array swings onto the estimate's bearing whether
   * or not the body is moving. §7.1 is satisfied by construction — there is no
   * path to a heading that does not go through `this.estimate`, and an estimate
   * only exists because `onPercept` built one.
   */
  _move(dt) {
    if (this.estimate) {
      const r = LANTERN.orientRateRadS;
      this.heading = wrapAngle(this.heading
        + clamp(shortestAngle(this.heading, this.estimate.bearing), -r * dt, r * dt));
    }
    const speed = LANTERN.bodySpeedMps[this.state] ?? 0;
    const dir = azimuthDir(this.heading);
    this.velocity.x = this._flow.x + dir.x * speed;
    this.velocity.y = this._flow.y;
    this.velocity.z = this._flow.z + dir.z * speed;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
  }

  /**
   * §10.2: released and drifting outward on SEARCHING, drawn inward on TRACKING,
   * at 40 m/min in both directions — the contract gives that speed once and using
   * it for both is one number rather than two.
   *
   * The ring is centred on the body rather than on the estimate, and that is a
   * reading of §10.2 worth stating: *"lure elements that drift outward on the
   * flow and encircle the estimate"* cannot mean the elements travel to the
   * estimate on their own, because at 40 m/min a kilometre takes twenty-five
   * minutes and the elements would arrive after the encounter. They go with the
   * animal, and the animal is what closes on the estimate. The encirclement is
   * the body arriving with its array already spread.
   */
  _ring(dt) {
    const target = this.state === STATE.SEARCHING ? LANTERN.ringMaxRadiusM
      : (this.state === STATE.TRACKING || this.state === STATE.COMMITTED) ? LANTERN.bodyLength
      : LANTERN.ringRadiusM;
    const step = LANTERN.ringSpeedMps * dt;
    this.ringRadius += clamp(target - this.ringRadius, -step, step);

    const p = this.position;
    for (let i = 0; i < this.lures.length; i++) {
      const l = this.lures[i];
      l.angle = wrapAngle(l.angle + l.omega * dt);
      l.x = p.x + Math.sin(l.angle) * this.ringRadius;
      l.y = p.y + l.yOff;
      l.z = p.z + Math.cos(l.angle) * this.ringRadius;
    }
  }

  /**
   * The widest angular gap in the ring, radians.
   *
   * §10.2's avoidance is *"leave through the ring while it is still thin"*, and
   * this is what "thin" is, in a number a test can read and an instrument could
   * one day draw. It is a property of the creature, not advice to the player.
   */
  widestGapRad() {
    const n = this.lures.length;
    if (n < 2) return TAU;
    const a = this.lures.map((l) => wrapAngle(l.angle)).sort((p, q) => p - q);
    let worst = a[0] + TAU - a[n - 1];
    for (let i = 1; i < n; i++) worst = Math.max(worst, a[i] - a[i - 1]);
    return worst;
  }

  // -------------------------------------------------------------------------
  // What the rest of the game reads
  // -------------------------------------------------------------------------

  /**
   * The lights, as plain data. One entry per element that is emitting anything.
   *
   * No renderer import: `main.js` is expected to spread each entry into
   * `bioluminescence()` from `src/render/lights.js`, whose defaults these mirror.
   * `lumens` is the physical quantity — the same unit §3.2 and §4.2 use — so
   * anything that wants to run the transmission formulas on this creature's own
   * light can, without a conversion nobody can check.
   *
   * The array is reused between calls. Callers that keep the result must copy it.
   */
  lights() {
    const out = this._lights;
    out.length = 0;
    const per = LANTERN.arrayLumens / this.lures.length;
    for (let i = 0; i < this.lures.length; i++) {
      const l = this.lures[i];
      const level = l.level * this.pulse;
      if (level <= 0) continue;
      out.push({
        key: l.key,
        x: l.x, y: l.y, z: l.z,
        lumens: per * level,
        intensity: LANTERN.renderIntensity * level,
        color: LANTERN.color,
        radius: LANTERN.lightRadiusM,
        diameterM: LANTERN.lureDiameterM,
      });
    }
    return out;
  }

  /** Total photic output right now, lumens. What §4.2 would be handed. */
  emittedLumens() { return LANTERN.arrayLumens * this.lureOutput * this.pulse; }

  /**
   * §10.2's environmental signature, shaped for `chargeFromStorms` in
   * `creature.js`: push this into the cloud system's `storms` list and `q` climbs
   * by up to 0.5 within 600 m of the body, in the same field the player's own EM
   * instrument reads. Reused between calls; it tracks the body.
   */
  stormCell() { return this._cell; }

  /** §9.3: the AI drives one scalar and the voice follows. */
  voiceState() {
    return {
      fundamentalHz: LANTERN.fundamentalHz,
      partials: [1, 2, 3, 4, 5],
      inharmonicity: this.attention,
      tremoloHz: LANTERN.tremoloHz / Math.max(1 - 0.85 * this.attention, 1e-3),
      tremolo: this.pulse,
      crackle: this.crackle,
      // §10.2: duck the music bus for the crackle — it is the only cue at
      // COMMITTED and it has to be audible in a dense mix.
      duckMusic: this.crackle && this.state === STATE.COMMITTED ? 0.45 : 0,
      lit: this.litCount,
    };
  }

  snapshot() {
    const s = super.snapshot();
    s.channel = this.activeChannel;
    s.lureNeed = +this.lureNeed.toFixed(4);
    s.lureOutput = +this.lureOutput.toFixed(4);
    s.lit = this.litCount;
    s.lures = this.lures.length;
    s.ringRadius = +this.ringRadius.toFixed(1);
    s.reachM = Math.round(this._reachM);
    s.heading = +this.heading.toFixed(4);
    s.crackles = this.crackleCount;
    if (this.estimate) {
      s.estimate.spreadM = Math.round(this.estimate.spreadM);
      s.estimate.agreement = +this.estimate.agreement.toFixed(3);
    }
    return s;
  }
}

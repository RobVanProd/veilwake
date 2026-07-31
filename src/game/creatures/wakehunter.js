// The Wake Hunter. Contract §10.3.
//
// Fifty-five metres, in packs of three to seven, and the only true pursuer in the
// roster. Everything else in this game rewards speed. This one inverts it, and
// the inversion is the whole reason it exists: **against the Wake Hunter,
// running is what gets you caught**, because speed is what makes the trail it
// follows.
//
// Four things in here are doing the design work. All four are consequences of the
// contract rather than inventions on top of it, and three of them are things this
// file deliberately does *not* do.
//
// **It cannot smell the ship.** §10.3: wake primary, thermal secondary, "**Both
// are trail channels**, which is the whole point: they never sense the ship, only
// what it did." So there is no path in this file from `ctx.shipPos` to a percept.
// `ctx.shipPos` is read exactly once, in the base class, to stamp a distance onto
// a log line. A Wake Hunter that can smell the ship directly is not a Wake Hunter,
// it is a bloodhound with the serial numbers filed off, and the entire avoidance
// vocabulary in §10.3 — turbulence erases, cross-flow separates, fly under your
// heat — stops meaning anything the moment that path exists.
//
// **It is not transmitted, so there is no path integral.** §4.4 is explicit:
// trail channels are "not transmitted. Sampled where the creature is." The
// stimulus is the §4.4 sum over parcels inside the sense radius and nothing else.
// That makes this the cheapest archetype in the roster on the medium — two samples
// a sense tick against §8's budget of thirty-two — and the most expensive on
// parcels, and both facts are measured in `tests/wakehunter.test.js` rather than
// asserted here.
//
// **The direction it follows is measured, not assumed.** §10.3: "They follow the
// trail *forwards*, from older parcels to newer." A parcel carries an age, so the
// trail is a curve parameterised by age and "forwards" is `-d(pos)/d(age)`, which
// this file gets by weighted least squares over the parcels in reach. That is one
// regression with no free constant in it, and it pays for itself twice: the slope's
// magnitude is `|v_ship − flow|`, which is contract §4.5's `relSpeed` — the pack
// measures how fast its target was going, from the trail alone, and uses it to lead
// the intercept. It also produces §10.3's mysterious behaviour for free. A parcel
// laid at time `t−a` has been advecting on the flow for `a` seconds and, if it is
// thermal, climbing at 0.8 m/s for `a` seconds, so the fitted curve is not the path
// the player flew. The pack "breaks off and swings wide in a direction the player
// never flew" because it is going where the trail *is*, and nothing had to be
// scripted for that to be true.
//
// **The pack shares where to look and never how sure to be.** §10.3 says "when one
// finds a parcel above threshold, the others converge on it", and §7's first
// non-negotiable rule says a creature may not turn towards the player without a
// percept. Both hold at once only if the shared thing is a *place* and not a
// *state*: a pack contact steers `behave()` and never touches `attention`, so a
// converging hunter that arrives and finds nothing decays and leaves, and the log
// shows it never escalated on somebody else's evidence. The percept behind a
// shared contact is real, belongs to a real creature and wrote a real
// `DetectionEvent`; the converging member's own ladder is still built entirely
// from what it can smell itself.
//
// Where the contract does not give a number, this file says so beside the number
// it chose, in `WAKE_HUNTER`. There are seven of those and every one of them is
// derived from something the contract does state.

import {
  Creature, STATE, SENSE_PERIOD, FAR_PLANE, RNG_TAG,
  perceptExcess, makePercept, azimuthDir, wrapAngle,
  vec, makeMediumSample,
} from './creature.js';
import { clamp, clamp01, lerp, shortestAngle } from '../../core/math.js';

/**
 * Everything the Wake Hunter is, in one block.
 *
 * Values marked `[contract]` are from CREATURE_BEHAVIOR_CONTRACT.md and changing
 * one means changing that file first. Values marked `[chosen]` are the seven the
 * contract does not specify; each says what it was derived from.
 */
export const WAKE_HUNTER = {
  bodyLength: 55,                  // [contract §10.3] individually comprehensible
  packSize: [3, 7],                // [contract §10.3]

  // --- §5.4 attention ------------------------------------------------------
  // It commits in 4.2 s because getting a percept at all requires it to already
  // be flying through your trail: 0.92 / (0.55 × 0.4) = 4.18 s at the contract's
  // stated excess of 0.4. There is no early warning built into these numbers and
  // there is not supposed to be — the early warning is the vapour going rough
  // 200 m ahead of them.
  fillRate: 0.55,                  // [contract §5.4]
  decayRate: 0.050,                // [contract §5.4]
  memorySec: 90,                   // [contract §5.4]

  // --- §10.3 senses: wake, primary -----------------------------------------
  wakeThreshold: 0.05,             // [contract] s⁻¹ — drifting sheds 0.02, below it
  wakeSaturation: 2.0,             // [contract] s⁻¹
  wakeSenseRadiusM: 165,           // [contract] 3 × body
  wakeFalsePositiveBase: 0.12,     // [contract] Hz — the highest in the roster
  wakeFalsePositiveMediumGain: 3.0,   // [contract §5.3] turbulence looks like a trail

  // --- §10.3 senses: thermal, secondary ------------------------------------
  thermalThreshold: 1.5,           // [contract] ΔK
  thermalSaturation: 40,           // [contract] ΔK — the cruise hull anchor exactly
  thermalSenseRadiusM: 220,        // [contract] m
  thermalFalsePositiveBase: 0.01,  // [contract] Hz
  thermalFalsePositiveMediumGain: 0,  // [contract §5.3] heat is rarely ambiguous

  // --- §10.3 environmental signature ---------------------------------------
  // Not applied here: this file does not own the medium. `turbulenceAt()` below
  // publishes the field so whoever does can add it, and until they do the pack
  // has no tell in the vapour, which is a promise §10.3 makes to the player and
  // this build does not yet keep.
  turbulenceRadiusM: 200,          // [contract] m
  turbulenceU: 0.6,                // [contract] raises local u to about this

  // --- §10.3 pack ----------------------------------------------------------
  packFrontM: 600,                 // [contract] the sweep front

  /**
   * How wide the formation sits, as a fraction of the 600 m front, per state.
   *
   * [chosen, but every row is named by §10.3's own escalation table]: UNAWARE is
   * "loose formation", ALERT is "formation tightens", SEARCHING is the "600 m
   * sweep front" and is therefore 1.0 by definition, TRACKING is "single file
   * along the trail" and is therefore 0 by definition, and COMMITTED is "spread
   * to cut off". Only the two intermediate fractions are free, and they are set
   * so the sequence a player watches is wide → narrow → widest → line → wide,
   * which is the shape of the table read down the middle column.
   */
  formationSpread: {
    [STATE.UNAWARE]: 1.0,
    [STATE.ALERT]: 0.6,
    [STATE.SEARCHING]: 1.0,
    [STATE.TRACKING]: 0.0,
    [STATE.COMMITTED]: 0.75,
  },

  /**
   * Speeds through the medium, metres per second. All five are [chosen]: §10.3
   * gives the pack's behaviour in every state and not one number for how fast.
   *
   * The constraint that fixes them is not aesthetic. §3.2 puts the ship's cruise
   * at 148 m/s relative to the medium and its boost at 237 (`SIG.cruiseRel`,
   * `SIG.boostRel`), and §10.3's own thesis is that boost is *the wrong answer* —
   * which it can only be if boost genuinely works as an escape and costs you the
   * trail instead. So the top of this ladder has to sit below cruise: 120 m/s is
   * 0.81 × cruise and 0.51 × boost, so a ship that simply runs in a straight line
   * pulls away from the pack and hands it a three-minute trail to follow home.
   * Catching happens when the player turns, loiters or doubles back — that is,
   * along their own line, which is exactly what §10.3 says pursuit is.
   *
   * A Wake Hunter faster than the ship would make escape a matter of throttle and
   * delete the entire avoidance vocabulary in §10.3. If any of these ever rise
   * above `SIG.cruiseRel`, that is the bug.
   */
  speedMps: {
    [STATE.UNAWARE]: 12,           // drifting with the flow; this is the paddling
    [STATE.ALERT]: 30,
    [STATE.SEARCHING]: 55,
    [STATE.TRACKING]: 90,
    [STATE.COMMITTED]: 120,
  },

  /**
   * Minimum turn radius, in body lengths. [chosen, from scale]: two body lengths
   * is 110 m, which at the 120 m/s top speed is 1.09 rad/s — a 5.8 s reversal.
   * The Listener's is three body lengths of a 240 m animal and takes 3.6 minutes;
   * the difference between those two numbers is the difference between a thing
   * you outmanoeuvre and a thing you outmanoeuvre nothing at all.
   */
  turnRadiusBodies: 2,

  /**
   * Acceleration, m/s². [chosen]: `speedMps.COMMITTED² / (2 × 550)`, i.e. it
   * reaches intercept speed over ten body lengths, or 9.2 s. The number that
   * matters is the lower bound rather than the value: at 13 m/s² a pack cannot
   * go from drifting to intercept inside one sense tick, so every escalation in
   * §10.3's table is something the player has time to see happen.
   */
  accelMps2: 13.1,

  /** Level flight is a fiction here; the thermal trail is above you. [chosen] */
  maxPitchRad: 1.2,

  /**
   * How far along the trail it aims, in SEARCHING and TRACKING. [chosen, and it
   * is not free]: one wake sense radius ahead of the freshest parcel it can
   * smell is precisely the nearest point it *cannot* yet smell. Aiming there is
   * the definition of following a trail rather than sitting on it.
   */
  leadM: 165,

  /**
   * Seconds between idle heading changes while UNAWARE. [chosen]: at 12 m/s and
   * the 0.22 rad/s turn rate that speed allows, an 8 s leg is 96 m — under two
   * body lengths, which is what "loose formation, drifting with the flow" looks
   * like from outside.
   */
  wanderEverySec: 8,
  wanderSpreadRad: 1.0,

  // --- §9 / §10.3 audio ----------------------------------------------------
  chirpHz: 900,                    // [contract §10.3]
  chirpLenSec: [0.040, 0.090],     // [contract §10.3]

  /**
   * Chirp interval, cold → saturated. [chosen, endpoints named by §10.3]:
   * §10.3 overrides §9.4 for this archetype and says so in as many words —
   * "**Chirp rate is a readout of trail strength**, not of proximity: a
   * fast-chirping pack far away means your trail is strong, and a slow-chirping
   * pack nearby means it is nearly cold." So the interval is driven by the
   * measured trail excess and never by distance or by attention. The two ends are
   * the two ends of §10.3's own player-perception column: 3.0 s is "distant clicks
   * with long gaps", and at 0.35 s across five panned pack members the chirps
   * overlap into the "continuous chirping" of the COMMITTED row.
   */
  chirpIntervalSec: [3.0, 0.35],
};

const SCRATCH = 192;
const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------
// The trail adapter
// ---------------------------------------------------------------------------

const EMPTY_TRAILS = {
  has: false,
  eachWake() {},
  eachThermal() {},
};

/**
 * Normalise whatever holds the parcels into the one thing a trail sense needs:
 * a walk over live parcels, each as `(x, y, z, value, ageSec)`.
 *
 * The same reasoning as `createMedium` and `createSignatureView` in
 * `creature.js`, for the same reason: `src/game/signature.js` is owned elsewhere,
 * the archetype has to be testable against a synthetic trail before the wiring
 * lands, and the day it lands should be a wiring change rather than a rewrite.
 *
 * **`value` is already decayed and `age` is already in seconds.** Both of those
 * are properties of the parcel field's own clock, and a creature that re-derived
 * them from `born` and `tau` would be a second implementation of §3.3's decay law
 * living in a file that has no business owning it.
 *
 * Accepted shapes, in order: a `Signature` (`eachWake`/`eachThermal`, which bind
 * their own `time`), a bare pair of `ParcelField`s (`wakeTrail`/`thermalTrail`
 * plus a `time`), or `{ wake: [...], thermal: [...] }` arrays of
 * `{x, y, z, value, age}` — the last being what the tests build so a case can put
 * a parcel of an exactly known strength at an exactly known place.
 */
export function createTrailView(source) {
  if (!source) return EMPTY_TRAILS;
  if (typeof source.eachWake === 'function' && typeof source.eachThermal === 'function') {
    return {
      has: true,
      eachWake: (fn) => source.eachWake(fn),
      eachThermal: (fn) => source.eachThermal(fn),
    };
  }
  if (source.wakeTrail && typeof source.wakeTrail.each === 'function') {
    const now = () => (typeof source.time === 'number' ? source.time : 0);
    return {
      has: true,
      eachWake: (fn) => source.wakeTrail.each(fn, now()),
      eachThermal: (fn) => (source.thermalTrail ? source.thermalTrail.each(fn, now()) : undefined),
    };
  }
  if (Array.isArray(source.wake) || Array.isArray(source.thermal)) {
    const walk = (arr, fn) => {
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        fn(p.x, p.y, p.z, p.value, p.age || 0, p.radius || 0);
      }
    };
    return {
      has: true,
      eachWake: (fn) => walk(source.wake, fn),
      eachThermal: (fn) => walk(source.thermal, fn),
    };
  }
  return EMPTY_TRAILS;
}

// ---------------------------------------------------------------------------
// §10.3 The pack
// ---------------------------------------------------------------------------

/**
 * What three to seven Wake Hunters know about each other.
 *
 * Two jobs, both from §10.3, and nothing else. It hands out lane offsets across
 * the 600 m sweep front, and it holds one shared contact so that "when one finds
 * a parcel above threshold, the others converge on it" is true.
 *
 * **It does not hold state, attention, or anything that could raise a member's
 * ladder.** See this file's header: the contact steers and never escalates. A
 * pack is a search pattern, not a hive mind, and the difference is what keeps §7
 * satisfiable for every member individually.
 */
export class WakeHunterPack {
  constructor({ id = 0, contactLifeSec = WAKE_HUNTER.memorySec } = {}) {
    this.id = id;
    this.members = [];
    /**
     * How long a shared contact is worth converging on. Deliberately the same
     * number as §5.4's `memory` for this archetype: a contact should live exactly
     * as long as the finder's own estimate of it would, so a member that arrives
     * on a dead lead and a member that lost its own lead give up together.
     */
    this.contactLifeSec = contactLifeSec;
    this.contact = null;
    /** Which way the formation is oriented; lanes are perpendicular to it. */
    this.axis = 0;
    this.shares = 0;
  }

  add(h) {
    h.pack = this;
    h.packIndex = this.members.length;
    this.members.push(h);
    return h;
  }

  get size() { return this.members.length; }

  /**
   * Where member `i` sits across the front. Evenly spaced, centred, so a pack of
   * five spans −300 … +300 m and a pack of one flies down the middle.
   */
  laneOffset(i) {
    const n = this.members.length;
    if (n <= 1) return 0;
    return ((i - (n - 1) / 2) / ((n - 1) / 2)) * (WAKE_HUNTER.packFrontM / 2);
  }

  /**
   * One member found something. The freshest wins outright rather than being
   * averaged with what is already there: two fixes on a trail are two points on a
   * curve, and their mean is a point that is not on the trail at all.
   */
  share(member, est, t) {
    const c = this.contact;
    if (!c || est.tSec >= c.tSec) {
      this.contact = {
        x: est.x, y: est.y, z: est.z,
        forward: { x: est.forward.x, y: est.forward.y, z: est.forward.z },
        trailSpeedMps: est.trailSpeedMps,
        channel: est.channel,
        tSec: est.tSec,
        ageSec: est.ageSec,
        real: est.real,
        by: member.id,
      };
      this.axis = Math.atan2(est.forward.x, est.forward.z);
      this.shares++;
    }
    return this.contact;
  }

  /** The shared contact, or null once it is older than a member's own memory. */
  contactAt(t) {
    const c = this.contact;
    if (!c) return null;
    if (t - c.tSec > this.contactLifeSec) { this.contact = null; return null; }
    return c;
  }

  /**
   * §10.3's COMMITTED row is a *pack* behaviour — "spread to cut off, direct
   * intercept" — but §6 allows only one COMMITTED creature in the world, so at
   * most one member of the pack is ever in that state. The rest read this and
   * spread anyway, which is the only way the row is reachable at all. See the
   * note in `WakeHunter.behave` and the `stillWrong` entry that goes with it.
   */
  leader() {
    let best = null;
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      if (!best || m.attention > best.attention) best = m;
    }
    return best;
  }

  committedMember() {
    for (let i = 0; i < this.members.length; i++) {
      if (this.members[i].state === STATE.COMMITTED) return this.members[i];
    }
    return null;
  }

  /** §10.3's environmental signature, summed over the pack. */
  turbulenceAt(x, y, z) {
    let u = 0;
    for (let i = 0; i < this.members.length; i++) u += this.members[i].turbulenceAt(x, y, z);
    return clamp01(u);
  }

  snapshot(t = 0) {
    const c = this.contactAt(t);
    return {
      id: this.id,
      size: this.members.length,
      axis: +this.axis.toFixed(4),
      shares: this.shares,
      contact: c ? { by: c.by, channel: c.channel, ageSec: +(t - c.tSec).toFixed(2), real: c.real } : null,
      members: this.members.map((m) => m.snapshot()),
    };
  }
}

// ---------------------------------------------------------------------------
// The archetype
// ---------------------------------------------------------------------------

export class WakeHunter extends Creature {
  constructor(opts = {}) {
    super({
      archetype: 'WakeHunter',
      bodyLength: WAKE_HUNTER.bodyLength,
      fillRate: WAKE_HUNTER.fillRate,
      decayRate: WAKE_HUNTER.decayRate,
      memorySec: WAKE_HUNTER.memorySec,
      // The base class has one threshold and one saturation because every other
      // archetype has one channel. These are the *primary* channel's, so anything
      // that reads them without asking gets the wake numbers; `currentThreshold()`
      // below switches them for the channel actually in play.
      threshold: WAKE_HUNTER.wakeThreshold,
      saturation: WAKE_HUNTER.wakeSaturation,
      falsePositiveBase: WAKE_HUNTER.wakeFalsePositiveBase,
      /**
       * **This is not the sense radius, and that is deliberate.**
       *
       * §8 promotes on *distance to the ship*, at 1.4× "the creature's longest
       * sense range", so that nothing is ever promoted already inside its own
       * detection range. For every other archetype those two distances are the
       * same distance. For this one they are not related at all: what it detects
       * is a parcel, and a live parcel can be anywhere the ship has been in the
       * last three minutes — up to 188 s × 148 m/s ≈ 27 km away, past FAR_PLANE.
       * Setting this to the 220 m thermal radius would give a promotion radius of
       * 308 m, so a pack four kilometres back working along a trail would be
       * `reduced`, and §8 says the reduced model has no senses. The archetype
       * would be blind everywhere except on top of the player, which is the one
       * place it is not supposed to need to be.
       *
       * FAR_PLANE is therefore the honest answer and it has a cost this file
       * cannot pay: the resulting 16.8 km promotion radius exceeds FAR_PLANE, so a
       * Wake Hunter is fully simulated whenever it exists, and a pack of five
       * spends five of §8's six slots. The correct fix is in `manager.js` —
       * promote a trail follower on distance to the nearest live parcel — and it
       * is not this file's to make.
       */
      longestSenseRange: FAR_PLANE,
      ...opts,
    });

    this.rngVoice = this.rng ? this.rng.fork(RNG_TAG.VOICE) : null;
    this.rngBehaviour = this.rng ? this.rng.fork(RNG_TAG.BEHAVIOUR) : null;

    // §10.3 gives the two channels different false-positive rates — 0.12 Hz on
    // wake against 0.01 Hz on thermal, a factor of twelve — and the base class
    // holds one. Both live here; `falsePositiveBase` above is the wake one, so
    // anything that reads the base class's field without asking gets the primary
    // channel's number rather than a wrong one. Passing `falsePositiveBase: 0`
    // silences both, which is what a test that wants no mistakes wants.
    this.wakeFalsePositiveBase = opts.wakeFalsePositiveBase
      ?? opts.falsePositiveBase ?? WAKE_HUNTER.wakeFalsePositiveBase;
    this.thermalFalsePositiveBase = opts.thermalFalsePositiveBase
      ?? (opts.falsePositiveBase !== undefined
        ? opts.falsePositiveBase : WAKE_HUNTER.thermalFalsePositiveBase);

    this.pack = null;
    this.packIndex = 0;
    if (opts.pack) opts.pack.add(this);

    this.heading = opts.heading ?? 0;
    this.pitch = 0;
    this.speed = 0;

    /**
     * Which channel the last thing it noticed came in on. Drives
     * `currentThreshold()`, so a `DetectionEvent` for a heat contact prints the
     * 1.5 ΔK threshold and not the 0.05 s⁻¹ one. §7's readable sentence is only
     * readable if its four numbers are in the same units.
     */
    this._channel = 'wake';

    /** §10.3: the chirp rate is this, and nothing else. 0..1, set every sense tick. */
    this.trailExcess = 0;
    this.chirping = false;
    this.chirpEndsAt = -1;
    this._nextChirpAt = 0;
    this.chirpCount = 0;

    this._percepts = [];
    this._local = makeMediumSample();
    this._flow = vec();
    this._uLocal = 0;
    this._aim = vec();
    this._wanderAt = 0;
    this._wanderTo = this.heading;

    this._trailSource = null;
    this._trails = EMPTY_TRAILS;

    // Two reused scan results and one reused scratch buffer, so a sense tick
    // allocates only the percepts themselves. Six parcels a second per creature
    // into the nursery is nothing; 1280 is a collection during an encounter.
    this._scan = {
      radius: 0, r2: 0, ox: 0, oy: 0, oz: 0,
      sum: 0, n: 0, stored: 0, overflow: 0,
      w: 0, sinSum: 0, cosSum: 0,
      headAge: Infinity, headX: 0, headY: 0, headZ: 0,
      px: new Float64Array(SCRATCH), py: new Float64Array(SCRATCH), pz: new Float64Array(SCRATCH),
      pw: new Float64Array(SCRATCH), pa: new Float64Array(SCRATCH),
    };
    this._wakeFit = this._makeFit();
    this._thermalFit = this._makeFit();
    /** Parcels examined on the last sense tick, both channels. For §8's budget. */
    this.parcelsScanned = 0;

    // Bound once. A closure per sense tick, twice per tick, per creature is
    // exactly the kind of quiet allocation PERFORMANCE_BUDGET.md §141 forbids.
    this._collect = (x, y, z, value, age) => this._collectParcel(x, y, z, value, age);
  }

  _makeFit() {
    return {
      n: 0, stimulus: 0, overflow: 0,
      x: 0, y: 0, z: 0, range: 0, bearing: 0, bearingSigma: 0, elevation: 0,
      ageSec: 0, fx: 0, fy: 0, fz: 0, trailSpeedMps: 0, forwardConfidence: 0,
    };
  }

  /** §10.3, per channel. See `_channel`. */
  currentThreshold() {
    return this._channel === 'thermal' ? WAKE_HUNTER.thermalThreshold : WAKE_HUNTER.wakeThreshold;
  }

  currentSaturation() {
    return this._channel === 'thermal' ? WAKE_HUNTER.thermalSaturation : WAKE_HUNTER.wakeSaturation;
  }

  /**
   * §10.3's environmental signature: "Sharp local turbulence — they raise `u` to
   * about 0.6 within 200 m, which is visible in the vapour before they are."
   *
   * Published rather than applied, because this file does not own the medium.
   * Linear falloff to match §4.4's, so the same shape appears on both sides of
   * the interface.
   */
  turbulenceAt(x, y, z) {
    const d = Math.hypot(x - this.position.x, y - this.position.y, z - this.position.z);
    if (d >= WAKE_HUNTER.turbulenceRadiusM) return 0;
    return WAKE_HUNTER.turbulenceU * (1 - d / WAKE_HUNTER.turbulenceRadiusM);
  }

  // -------------------------------------------------------------------------
  // §10.3 Senses — two trail channels, and nothing that can see the ship
  // -------------------------------------------------------------------------

  /**
   * Up to four percepts: a wake contact, a heat contact, and §5.3's chance of a
   * mistake on each.
   *
   * One medium sample, at the creature itself, for the local turbulence the wake
   * false-positive rate scales with. §8 allows thirty-two. There is no path
   * integral because §4.4 says trail channels are not transmitted, and adding one
   * would be inventing an attenuation the contract does not have.
   *
   * The two channels are not summed. §5.4 is explicit that multiple channels do
   * not add and the strongest excess wins, and the base class does that; what
   * this returns is the evidence, not a verdict.
   */
  sense(ctx) {
    const out = this._percepts;
    out.length = 0;
    this.parcelsScanned = 0;

    this._sampleLocal(ctx);
    const trails = this._resolveTrails(ctx);

    if (trails.has) {
      const wake = this._scanChannel(trails.eachWake, WAKE_HUNTER.wakeSenseRadiusM, this._wakeFit);
      if (wake && wake.stimulus > WAKE_HUNTER.wakeThreshold) {
        out.push(this._perceptFrom('wake', wake, WAKE_HUNTER.wakeThreshold, WAKE_HUNTER.wakeSaturation));
      }
      const therm = this._scanChannel(trails.eachThermal, WAKE_HUNTER.thermalSenseRadiusM, this._thermalFit);
      if (therm && therm.stimulus > WAKE_HUNTER.thermalThreshold) {
        out.push(this._perceptFrom('thermal', therm, WAKE_HUNTER.thermalThreshold, WAKE_HUNTER.thermalSaturation));
      }
    }

    // §5.3. Wake first, then thermal, always in that order and always both rolled
    // — a draw that is skipped is a draw the next replay does not skip, and §12
    // wants the same seed to reproduce the same mistakes.
    const fpWake = this._rollChannel('wake',
      this.wakeFalsePositiveBase,
      WAKE_HUNTER.wakeFalsePositiveMediumGain * this._uLocal,
      WAKE_HUNTER.wakeSaturation, WAKE_HUNTER.wakeSenseRadiusM);
    if (fpWake) out.push(fpWake);

    const fpTherm = this._rollChannel('thermal',
      this.thermalFalsePositiveBase,
      WAKE_HUNTER.thermalFalsePositiveMediumGain,
      WAKE_HUNTER.thermalSaturation, WAKE_HUNTER.thermalSenseRadiusM);
    if (fpTherm) out.push(fpTherm);

    return out;
  }

  _sampleLocal(ctx) {
    const m = ctx.medium;
    if (!m || typeof m.sample !== 'function') { this._uLocal = 0; return; }
    const s = m.sample(this.position.x, this.position.y, this.position.z, ctx.t, this._local);
    this._uLocal = s.turbulence;
    this._flow.x = s.flow.x; this._flow.y = s.flow.y; this._flow.z = s.flow.z;
  }

  /** Built once per source object, not once per tick. */
  _resolveTrails(ctx) {
    const src = ctx.trails || (ctx.signature && ctx.signature.trails) || ctx.signature || null;
    if (src !== this._trailSource) {
      this._trailSource = src;
      this._trails = createTrailView(src);
    }
    return this._trails;
  }

  // --- the parcel scan -----------------------------------------------------

  /**
   * One pass over one parcel field, producing everything a percept needs.
   *
   * The stimulus is §4.4 exactly — `sum of (parcel value × falloff)` with
   * `falloff = 1 − clamp01(dist / senseRadius)` — and `tests/wakehunter.test.js`
   * checks this sum against `ParcelField.sample()` on a real `Signature` rather
   * than trusting that two copies of one formula agree.
   *
   * Everything else is measured off the same pass:
   *
   *   - **bearing** to the freshest parcel in reach, which is the head of the
   *     scent and the thing it is following.
   *   - **bearingSigma** as the *circular* standard deviation of the parcels'
   *     bearings, weighted by their contribution. This is not a chosen constant
   *     and it is not from §4 — §4 gives no bearing error for trail channels
   *     because there is no path to corrupt one. The error is the ambiguity in
   *     the evidence itself: a clean trail passing 150 m away subtends a few
   *     degrees, and a field of turbulence-torn parcels scattered around the
   *     creature subtends the sky. Turbulence therefore widens the search without
   *     anything having been told to make it do so.
   *   - **forward**, the regression described in this file's header.
   *
   * Parcels beyond `SCRATCH` still count towards the stimulus and are left out of
   * the fit; `overflow` reports it so a test can see the truncation instead of
   * inferring it from a number that looks slightly wrong.
   */
  _scanChannel(each, radius, dst) {
    if (!each) return null;
    const s = this._scan;
    s.radius = radius; s.r2 = radius * radius;
    s.ox = this.position.x; s.oy = this.position.y; s.oz = this.position.z;
    s.sum = 0; s.n = 0; s.stored = 0; s.overflow = 0;
    s.w = 0; s.sinSum = 0; s.cosSum = 0;
    s.headAge = Infinity;
    each(this._collect);
    if (s.n === 0) return null;
    return this._fit(dst);
  }

  _collectParcel(x, y, z, value, age) {
    const s = this._scan;
    this.parcelsScanned++;
    if (!(value > 0)) return;
    const dx = x - s.ox, dy = y - s.oy, dz = z - s.oz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= s.r2) return;
    const d = Math.sqrt(d2);
    const w = value * (1 - d / s.radius);      // §4.4, the whole of it
    if (!(w > 0)) return;

    s.sum += w;
    s.n++;
    const b = Math.atan2(dx, dz);
    s.sinSum += w * Math.sin(b);
    s.cosSum += w * Math.cos(b);
    s.w += w;
    if (age < s.headAge) { s.headAge = age; s.headX = x; s.headY = y; s.headZ = z; }
    if (s.stored < SCRATCH) {
      const i = s.stored++;
      s.px[i] = x; s.py[i] = y; s.pz[i] = z; s.pw[i] = w; s.pa[i] = age;
    } else {
      s.overflow++;
    }
  }

  _fit(dst) {
    const s = this._scan;
    const k = s.stored;

    let W = 0, ma = 0, mx = 0, my = 0, mz = 0;
    for (let i = 0; i < k; i++) {
      const w = s.pw[i];
      W += w; ma += w * s.pa[i]; mx += w * s.px[i]; my += w * s.py[i]; mz += w * s.pz[i];
    }
    if (W > 0) { ma /= W; mx /= W; my /= W; mz /= W; }

    // Weighted least squares of position against age. The slope is metres per
    // second of parcel age; negated it is the direction from older parcels to
    // newer, which is §10.3's "forwards". Its magnitude is |v_ship − flow|,
    // because a parcel at age `a` sits at ship(t−a) + (flow + rise)·a — so this
    // is contract §4.5's relSpeed, arrived at from the outside.
    let Saa = 0, Sax = 0, Say = 0, Saz = 0, Spp = 0;
    for (let i = 0; i < k; i++) {
      const w = s.pw[i];
      const da = s.pa[i] - ma;
      const dx = s.px[i] - mx, dy = s.py[i] - my, dz = s.pz[i] - mz;
      Saa += w * da * da;
      Sax += w * da * dx; Say += w * da * dy; Saz += w * da * dz;
      Spp += w * (dx * dx + dy * dy + dz * dz);
    }

    let fx = 0, fy = 0, fz = 0, speed = 0, conf = 0;
    if (Saa > 1e-9) {
      const vx = Sax / Saa, vy = Say / Saa, vz = Saz / Saa;
      speed = Math.hypot(vx, vy, vz);
      if (speed > 1e-6) { fx = -vx / speed; fy = -vy / speed; fz = -vz / speed; }
      // The share of the positional spread the line explains: |slope|²·Saa over
      // Spp, which is an R² and is bounded by 1 by Cauchy-Schwarz. A trail is a
      // line; a cloud of eddies is not, and this is the number that says which.
      conf = Spp > 1e-9 ? clamp01((speed * speed * Saa) / Spp) : 0;
    }
    // Nothing to fit a direction to — head where the scent is, and admit it.
    if (speed <= 1e-6) {
      const dx = s.headX - s.ox, dy = s.headY - s.oy, dz = s.headZ - s.oz;
      const m = Math.hypot(dx, dy, dz) || 1;
      fx = dx / m; fy = dy / m; fz = dz / m;
    }

    const hx = s.headX - s.ox, hy = s.headY - s.oy, hz = s.headZ - s.oz;
    const range = Math.hypot(hx, hy, hz);

    // Circular standard deviation. R̄ = 1 for a single parcel (a point has no
    // spread) and falls towards 0 as the contributions surround the creature.
    const R = clamp(Math.hypot(s.sinSum, s.cosSum) / Math.max(s.w, 1e-12), 1e-9, 1);
    const sigma = Math.max(1e-3, Math.sqrt(Math.max(0, -2 * Math.log(R))));

    dst.n = s.n;
    dst.stimulus = s.sum;
    dst.overflow = s.overflow;
    dst.x = s.headX; dst.y = s.headY; dst.z = s.headZ;
    dst.range = range;
    dst.bearing = Math.atan2(hx, hz);
    dst.bearingSigma = sigma;
    dst.elevation = range > 1e-6 ? Math.asin(clamp(hy / range, -1, 1)) : 0;
    dst.ageSec = s.headAge;
    dst.fx = fx; dst.fy = fy; dst.fz = fz;
    dst.trailSpeedMps = speed;
    dst.forwardConfidence = conf;
    return dst;
  }

  _perceptFrom(channel, fit, threshold, saturation) {
    const excess = perceptExcess(fit.stimulus, threshold, saturation);
    return makePercept(channel, fit.stimulus, fit.bearing, fit.bearingSigma,
      // §5.2: a trail percept's latency *is* the parcel's age. Nothing else is
      // added, and nothing else needs to be.
      fit.ageSec,
      excess * (1 - clamp01(fit.bearingSigma)), true, {
        // §5.1 gives trail channels a position — "but it is where you *were*".
        range: fit.range,
        threshold,
        saturation,
        distance: fit.range,
        emitted: null,
        // Beyond azimuth, and named separately per the note on `azimuth()` in
        // creature.js: the vertical is the whole of §10.3's third avoidance lever.
        elevation: fit.elevation,
        px: fit.x, py: fit.y, pz: fit.z,
        fx: fit.fx, fy: fit.fy, fz: fit.fz,
        trailSpeedMps: fit.trailSpeedMps,
        forwardConfidence: fit.forwardConfidence,
        parcels: fit.n,
        positionExact: true,
      });
  }

  /**
   * §5.3, per channel.
   *
   * The base class's helper reads `falsePositiveBase`, `currentThreshold()` and
   * `saturation`, because every other archetype has one channel. Pointing those
   * three at the channel being rolled for the duration of the draw is ugly and it
   * is still the right call: the alternative is a second copy of §5.3's
   * "weak by construction" curve living in an archetype, which is exactly the
   * drift the base class exists to prevent.
   *
   * The phantom is placed half a sense radius away on a plausible bearing and
   * pointed along the formation's own axis — an eddy that looks like a trail
   * going the way this pack already expects trails to go. §5.3 asks for that in
   * as many words: a creature investigating nothing at all in a *random*
   * direction reads as broken rather than as mistaken.
   */
  _rollChannel(channel, base, mediumFactor, saturation, radius) {
    const ch0 = this._channel, base0 = this.falsePositiveBase, sat0 = this.saturation;
    this._channel = channel;
    this.falsePositiveBase = base;
    this.saturation = saturation;

    const bearing = this._plausibleBearing();
    const sigma = 0.15 + this._uLocal;
    const p = this.rollFalsePositive(mediumFactor, bearing, sigma, channel);

    if (p) {
      const dir = azimuthDir(bearing);
      const r = radius * 0.5;
      p.threshold = this.currentThreshold();
      p.saturation = saturation;
      p.range = r;
      p.distance = r;
      p.elevation = 0;
      p.px = this.position.x + dir.x * r;
      p.py = this.position.y;
      p.pz = this.position.z + dir.z * r;
      const axis = this.pack ? this.pack.axis : this.heading;
      const f = azimuthDir(axis);
      p.fx = f.x; p.fy = 0; p.fz = f.z;
      p.trailSpeedMps = 0;
      p.forwardConfidence = 0;
      p.parcels = 0;
      p.positionExact = false;
    }

    this._channel = ch0;
    this.falsePositiveBase = base0;
    this.saturation = sat0;
    return p;
  }

  _plausibleBearing() {
    const base = this.estimate ? this.estimate.bearing
      : this.pack && this.pack.contact ? this.pack.axis
      : this.heading;
    const spread = this.rngSense ? this.rngSense.spread(HALF_PI) : 0;
    return wrapAngle(base + spread);
  }

  // -------------------------------------------------------------------------
  // §5 The estimate
  // -------------------------------------------------------------------------

  /**
   * A trail fix replaces the previous one; it is not fused with it.
   *
   * The Listener fuses bearings by inverse variance because two acoustic bearings
   * to one continuous source are two measurements of the same quantity. Two trail
   * fixes are not: they are two different points on a curve the ship drew
   * minutes apart, and their weighted mean is a point that is not on the curve.
   * The smoothing that a fuse would provide is already in the fit, which averages
   * every parcel in reach.
   */
  onPercept(p, ctx) {
    this._channel = p.channel;
    this.estimate = {
      x: p.px, y: p.py, z: p.pz,
      bearing: p.bearing,
      bearingSigma: p.bearingSigma,
      elevation: p.elevation,
      range: p.range,
      ageSec: p.ageSec,
      tSec: ctx.t,
      channel: p.channel,
      real: p.real,
      strength: p.strength,
      forward: { x: p.fx, y: p.fy, z: p.fz },
      forwardConfidence: p.forwardConfidence,
      trailSpeedMps: p.trailSpeedMps,
      parcels: p.parcels,
    };
    this.trailExcess = perceptExcess(p.strength, p.threshold, p.saturation);
    // §10.3: "when one finds a parcel above threshold, the others converge on
    // it." A false positive is shared too, and has to be: §5.3 says a false
    // percept is indistinguishable from a real one inside the creature's own
    // reasoning, and a pack that could tell the difference would never do the
    // thing §10.3 promises it does in rough air.
    if (this.pack) this.pack.share(this, this.estimate, ctx.t);
  }

  // -------------------------------------------------------------------------
  // §10.3 Behaviour
  // -------------------------------------------------------------------------

  behave(dt, ctx) {
    const t = ctx.t;

    // A reduced creature never runs `sense()`, so it never samples the medium
    // there. It still has to ride the flow, or a demoted pack would hang in the
    // air while everything around it moved. §8 forbids it detecting anything; it
    // does not ask it to stop existing.
    if (!this.fullySimulated && (ctx.tick % SENSE_PERIOD) === 0) this._sampleLocal(ctx);

    // §10.3: the trail excess drives the chirp rate and decays to nothing when
    // there is no scent. Read it off the integrator's own clock rather than
    // holding it: `lastPerceptTime` is set by the base class on any tick that
    // produced one.
    if (ctx.t - this.lastPerceptTime > 0.5) this.trailExcess = 0;
    this._voice(t);

    const state = this.state;
    let want = WAKE_HUNTER.speedMps[state] ?? 0;

    /**
     * A member converging on a pack-mate's contact moves at the searching speed
     * even though its own ladder has not left UNAWARE.
     *
     * This is the one place the pack touches something other than a heading, and
     * it is forced by §10.3: "when one finds a parcel above threshold, the others
     * converge on it." At the UNAWARE speed of 12 m/s a hunter 900 m off the
     * trail takes seventy-five seconds to reach it, by which time the contact has
     * expired — a pack that converges that slowly does not converge, and the row
     * in §10.3's table is unreachable.
     *
     * It stays inside §7.1, which forbids *turning towards the player* without a
     * percept: the percept exists, it belongs to a real pack-mate and it wrote a
     * real `DetectionEvent`. What does not happen here is escalation. Attention
     * is untouched, the state stays UNAWARE, and a member that arrives on a dead
     * lead has nothing to show for it and wanders off. This is formation keeping
     * at speed, not a detection.
     */
    if (!this.estimate && this.pack && this.pack.contactAt(ctx.t)) {
      want = Math.max(want, WAKE_HUNTER.speedMps[STATE.SEARCHING]);
    }

    const rate = WAKE_HUNTER.accelMps2;
    this.speed += clamp(want - this.speed, -rate * dt, rate * dt);

    const aim = this._aimAt(ctx);
    if (aim) {
      const dx = aim.x - this.position.x, dy = aim.y - this.position.y, dz = aim.z - this.position.z;
      const flat = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = clamp(Math.atan2(dy, Math.max(flat, 1e-3)),
        -WAKE_HUNTER.maxPitchRad, WAKE_HUNTER.maxPitchRad);
      const omega = Math.max(this.speed, 1) / (WAKE_HUNTER.turnRadiusBodies * this.bodyLength);
      this.heading = wrapAngle(this.heading
        + clamp(shortestAngle(this.heading, wantYaw), -omega * dt, omega * dt));
      this.pitch += clamp(wantPitch - this.pitch, -omega * dt, omega * dt);
    } else {
      // §10.3 UNAWARE: loose formation, drifting with the flow.
      if (t >= this._wanderAt) {
        this._wanderAt = t + WAKE_HUNTER.wanderEverySec;
        const s = this.rngBehaviour ? this.rngBehaviour.spread(WAKE_HUNTER.wanderSpreadRad) : 0;
        this._wanderTo = wrapAngle(this.heading + s);
      }
      const omega = Math.max(this.speed, 1) / (WAKE_HUNTER.turnRadiusBodies * this.bodyLength);
      this.heading = wrapAngle(this.heading
        + clamp(shortestAngle(this.heading, this._wanderTo), -omega * dt, omega * dt));
      this.pitch += clamp(-this.pitch, -omega * dt, omega * dt);
    }

    // The ladder in `speedMps` is airspeed — speed through the medium, the same
    // frame §4.5 measures the ship's `relSpeed` in. The flow is added on top,
    // which is why UNAWARE reads as drifting and why the pack's ground track
    // bends the same way the trail it is following does.
    const dir = azimuthDir(this.heading);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.velocity.x = dir.x * this.speed * cp + this._flow.x;
    this.velocity.y = this.speed * sp + this._flow.y;
    this.velocity.z = dir.z * this.speed * cp + this._flow.z;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
  }

  /**
   * Where to fly, in three dimensions, or null for "nothing to go to".
   *
   * Its own estimate first, then the pack's shared contact — §10.3's convergence.
   * Never `ctx.shipPos`; see the header.
   */
  _aimAt(ctx) {
    const own = this.estimate;
    const shared = this.pack ? this.pack.contactAt(ctx.t) : null;
    const src = own || shared;
    if (!src) return null;

    const a = this._aim;
    const f = src.forward;
    const dist = Math.hypot(src.x - this.position.x, src.y - this.position.y, src.z - this.position.z);

    // §10.3 COMMITTED: "Spread to cut off, direct intercept." The lead is solved
    // rather than dialled — how far the target moves while the pack covers the
    // distance, using the trail speed the fit measured. Clamped at the range,
    // because a lead longer than your own distance to the point is the arithmetic
    // telling you the target is faster than you are, and the answer to that is
    // pure pursuit and a longer wait, not a wilder guess.
    let lead = WAKE_HUNTER.leadM;
    const committed = this.state === STATE.COMMITTED
      || (this.pack && this.pack.committedMember() && this.state === STATE.TRACKING);
    if (committed) {
      const closing = Math.max(this.speed, 1);
      lead = Math.min((src.trailSpeedMps || 0) * (dist / closing), dist);
    }

    a.x = src.x + f.x * lead;
    a.y = src.y + f.y * lead;
    a.z = src.z + f.z * lead;

    if (this.pack) {
      const spread = WAKE_HUNTER.formationSpread[this.state] ?? 1;
      const off = this.pack.laneOffset(this.packIndex) * spread;
      if (off !== 0) {
        const r = azimuthDir(this.pack.axis + HALF_PI);
        a.x += r.x * off;
        a.z += r.z * off;
      } else if (this.packIndex > 0) {
        // §10.3 TRACKING: single file. Queue up behind the member ahead rather
        // than stacking every hunter on one point, which reads as one creature.
        const back = this.packIndex * this.bodyLength * 2;
        a.x -= f.x * back; a.y -= f.y * back; a.z -= f.z * back;
      }
    }
    return a;
  }

  /**
   * §10.3, overriding §9.4 explicitly: the interval is a readout of trail
   * strength and not of attention or proximity.
   *
   * Sampled when a chirp ends rather than continuously, so a scent that fades
   * mid-interval does not retroactively change a chirp that has already been
   * scheduled — the player is hearing the state of the hunt at the moment each
   * chirp was decided on, which is what makes the readout honest.
   */
  _voice(t) {
    if (this.chirping) {
      if (t >= this.chirpEndsAt) {
        this.chirping = false;
        const [cold, hot] = WAKE_HUNTER.chirpIntervalSec;
        this._nextChirpAt = t + lerp(cold, hot, clamp01(this.trailExcess));
      }
      return;
    }
    if (t >= this._nextChirpAt) {
      this.chirping = true;
      this.chirpCount++;
      const [lo, hi] = WAKE_HUNTER.chirpLenSec;
      const r = this.rngVoice ? this.rngVoice.range(lo, hi) : (lo + hi) * 0.5;
      this.chirpEndsAt = t + r;
    }
  }

  /** §9.3: the AI drives one scalar and the voice follows. */
  voiceState() {
    const [cold, hot] = WAKE_HUNTER.chirpIntervalSec;
    return {
      fundamentalHz: WAKE_HUNTER.chirpHz,
      partials: [1, 2, 3],
      inharmonicity: this.attention,
      chirping: this.chirping,
      intervalSec: lerp(cold, hot, clamp01(this.trailExcess)),
      trailStrength: this.trailExcess,
      packIndex: this.packIndex,
    };
  }

  snapshot() {
    const s = super.snapshot();
    s.heading = +this.heading.toFixed(4);
    s.pitch = +this.pitch.toFixed(4);
    s.speed = +this.speed.toFixed(2);
    s.channel = this._channel;
    s.trailExcess = +this.trailExcess.toFixed(4);
    s.chirping = this.chirping;
    s.chirps = this.chirpCount;
    s.packIndex = this.packIndex;
    s.packId = this.pack ? this.pack.id : null;
    s.parcelsScanned = this.parcelsScanned;
    if (this.estimate) {
      s.trailSpeedMps = +this.estimate.trailSpeedMps.toFixed(2);
      s.trailAgeSec = +this.estimate.ageSec.toFixed(2);
      s.forwardConfidence = +this.estimate.forwardConfidence.toFixed(3);
    }
    return s;
  }
}

/**
 * A pack, ready to add to a `CreatureManager`.
 *
 * Members are laid out across the 600 m front on the axis they start on, so the
 * formation is correct on the first frame rather than after it has converged.
 *
 * `rng.fork()` advances the parent, so handing every member the same `Rng` still
 * gives each of them an independent stream — but it does so in construction
 * order, which is fine and deterministic and worth knowing before somebody
 * reorders this loop and wonders why a replay changed.
 */
export function createWakeHunterPack({
  id = 0, size = 5, rng = null, position = vec(), heading = 0, idBase = 0, ...opts
} = {}) {
  const pack = new WakeHunterPack({ id });
  const n = clamp(Math.round(size), 1, 12);
  const right = azimuthDir(heading + HALF_PI);
  for (let i = 0; i < n; i++) {
    const h = new WakeHunter({
      id: idBase + i,
      rng: rng ? rng.fork(RNG_TAG.WAKE_HUNTER) : null,
      heading,
      pack,
      position: vec(position.x, position.y, position.z),
      ...opts,
    });
    const off = pack.laneOffset(i);
    h.position.x += right.x * off;
    h.position.z += right.z * off;
  }
  pack.axis = heading;
  return pack;
}

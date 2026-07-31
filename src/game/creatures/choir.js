// The Choir. Contract §10.4.
//
// Tens of thousands of 0.4 m elements spread across two to six kilometres. There
// is no body and nothing to look at, and it is the largest thing in the game. It
// is also the only creature in the roster that is not, in any sense, hunting: it
// has no attention integrator, it never enters TRACKING or COMMITTED, and there
// is no code path in this file by which it could. It is an information hazard.
//
// What it does is **repeat**. And the sentence in §10.4 that constrains every
// line below is this one:
//
//   > The Choir does not invent. Every echo is a recording of something that was
//   > genuinely present.
//
// So there is a memory of things it has actually perceived, and there is a
// playback, and there is nothing in between that could manufacture a contact.
// A phantom Listener call means a real Listener passed through this volume
// recently enough for the shoal to still hold it. The lies are accurate
// historical records with the timestamps stripped off — and, as it happens, the
// ranges too, which is the second half of the same idea and is spelled out at
// `_emitEcho`.
//
// Four things in here are doing the design work.
//
// **The tell is geometric, not tagged.** §10.4 promises the player a checkable
// rule: a real contact appears on two or more channels with consistent bearings;
// a Choir echo appears on exactly one channel and its bearing is the *Choir's*
// bearing rather than the bearing of the thing it is imitating. Nothing in this
// file marks an echo as fake for the receiver's benefit. An echo is a genuine
// re-emission, on one channel, from a point inside the shoal, and every receiver
// runs the same §4 transmission against it that it runs against the ship. The
// bearing comes out as the shoal's bearing because that is where the sound
// physically is. `crossReference()` at the bottom is the discriminator that falls
// out, and `tests/choir.test.js` measures how well it separates.
//
// **The tell degrades where the cover is best, for free.** Echo origins are drawn
// uniformly inside the shoal volume. From ten kilometres away that is a point;
// from inside it is the whole sky. §10.4 asks for exactly that ("inside the shoal
// the echoes come from every direction at once") and no code implements it — it
// is what a 4 km sphere looks like from two distances.
//
// **Scanning poisons it.** An active scan is loud, distinctive and immediately
// memorised. A scan recording is exempt from capacity eviction and is replayed on
// its own guaranteed schedule for the full 600 s the shoal remembers, which is
// §10.4's "for as long as the shoal remembers it" implemented as a promise rather
// than as a probability.
//
// **It draws other creatures.** That is the whole reason the echo bus exists and
// the reason this file exports `senseEchoes()`. A Wake Hunter pack that commits
// to a Choir echo of an engine note is committed to somewhere the player is not,
// which makes the shoal a tool as well as a hazard. See INTEGRATION at the foot
// of this file for the three lines another archetype adds.
//
// Values marked [contract] are from CREATURE_BEHAVIOR_CONTRACT.md and changing
// one means changing that file first. Values marked [chosen] are the ones the
// contract does not specify; each says what it was derived from.

import {
  Creature, FAR_PLANE, SOUND_SPEED, RNG_TAG, SENSE_DT,
  acousticReceived, acousticBearingSigma, photicReceived, emReceived,
  pathTerms, perceptExcess, makePercept,
  azimuth, wrapAngle, vec, vdist, makeMediumSample,
} from './creature.js';
import { clamp01, shortestAngle } from '../../core/math.js';

// ---------------------------------------------------------------------------
// What the shoal will bother to remember
// ---------------------------------------------------------------------------

/**
 * §10.4: *"All five, weakly, with no thresholds worth listing, because it is not
 * hunting."*
 *
 * That sentence is a problem for an implementation, because a recorder still has
 * to decide what is too faint to store. Inventing five numbers here would be
 * inventing five numbers, so instead each floor is **the lowest threshold anybody
 * else in the roster has on that channel**, quoted from their own sections. The
 * rule the shoal follows is therefore one sentence and it is not arbitrary:
 *
 *   *The Choir remembers anything any creature in the world could have detected.*
 *
 * Which is also why its echoes are informative rather than decorative. A shoal
 * thick with Wake Hunter chirps is a shoal a pack has been sweeping, and the
 * shoal could only have heard those chirps if they were loud enough to matter.
 *
 * If a future archetype arrives with a lower threshold on a channel, this table
 * moves down to meet it, or the Choir starts being able to hold less than the
 * world contains and §10.4's "the false contacts are true" quietly becomes "the
 * false contacts are true, mostly".
 */
export const RECORDING_FLOOR = {
  acoustic: 6,        // [contract §10.1] the Listener's *listening* threshold, dB(V)
  photic: 0.004,      // [contract §10.2] the Lantern, lux-eq
  em: 0.05,           // [contract §10.2] the Lantern, EMU
  wake: 0.05,         // [contract §10.3] the Wake Hunter, s⁻¹
  thermal: 1.5,       // [contract §10.3] the Wake Hunter, ΔK
};

/**
 * Saturations, on the same principle and from the same sections. These exist
 * only so a percept produced by this creature carries a well-formed `excess`
 * for anything downstream that reads one; the Choir's own fill rate is zero, so
 * they never move its attention. See the `fillRate` note in `CHOIR`.
 */
export const RECORDING_SATURATION = {
  acoustic: 60,       // [contract §10.1]
  photic: 0.20,       // [contract §10.2]
  em: 4.0,            // [contract §10.2]
  wake: 2.0,          // [contract §10.3]
  thermal: 40,        // [contract §10.3]
};

/** §10.4's four postures. Not the §6 machine — see `CHOIR.fillRate`. */
export const POSTURE = {
  DISPERSED: 'DISPERSED',
  GATHERING: 'GATHERING',
  DENSE: 'DENSE',
  RESONANT: 'RESONANT',
};

export const CHOIR = {
  // --- §10.4 scale ---------------------------------------------------------
  elementM: 0.4,                 // [contract] an individual element
  spanM: [2000, 6000],           // [contract] the shoal spans 2–6 km

  // --- §5.4 attention ------------------------------------------------------
  /**
   * **Zero, and that is the mechanism rather than a placeholder.**
   *
   * §10.4: *"It has no attention integrator and it never enters TRACKING or
   * COMMITTED."* The §6 machine still runs — it is the base class's and this file
   * does not disable it — but with both rates at zero, attention is a constant
   * 0 and `_resolveStates` can never find a rung to climb. The creature is
   * exempt from §6's one-COMMITTED rule by construction rather than by a special
   * case in `CreatureManager`, which is why `manager.js` needs no knowledge of
   * this archetype at all. `tests/choir.test.js` drives 900 s and measures that
   * attention never leaves 0 and the state never leaves UNAWARE, because "it
   * cannot" is a claim and the log is evidence.
   */
  fillRate: 0,                   // [contract §5.4 — the row is blank]
  decayRate: 0,                  // [contract §5.4 — the row is blank]
  memorySec: 600,                // [contract §5.4] how long a recording is held

  /**
   * [chosen] §10.4: *"a capacity of some hundreds of recordings and it forgets
   * the oldest."* Four hundred is in the middle of "some hundreds" and it is
   * also enough that the 600 s memory is what expires a recording in ordinary
   * play rather than the cap: a cruising ship inside the shoal produces at most
   * one recording per channel per sense tick that clears a floor, and the
   * de-duplication in `_record` collapses a steady cruise into roughly one
   * recording every `dedupeSec`. If the cap starts doing the forgetting, the
   * shoal stops holding the ten minutes §5.4 says it holds.
   */
  capacity: 400,

  /**
   * [chosen] Minimum seconds between two recordings of the same source on the
   * same channel.
   *
   * Without this, a ship at steady cruise writes a recording every sense tick —
   * ten a second — and the entire memory is one second of one ship inside a
   * minute. The shoal would then be unable to hold the Listener that passed
   * through four minutes ago, which is the thing §10.4 says makes its echoes
   * worth reading. Four seconds is short enough that a manoeuvre is captured as
   * a manoeuvre and long enough that 400 slots is 26 minutes of one continuous
   * source rather than 40 seconds of it.
   */
  dedupeSec: 4.0,

  // --- §10.4 playback ------------------------------------------------------
  pitchRange: [0.7, 1.3],        // [contract] re-synthesised at 0.7–1.3× pitch

  /**
   * [contract §10.4] *"well-formed, plausible contacts that behave correctly for
   * about a minute."* Sixty seconds is the life of one echo, and it is the number
   * every echo-rate below is derived against.
   */
  echoLifeSec: 60,

  /**
   * Seconds between ordinary echoes, per posture. [chosen], and derived from the
   * line above plus §10.4's own posture table, because "occasional" and
   * "constant" are not numbers but `rate × life = concurrent echoes` is:
   *
   *   DISPERSED  1/25 Hz × 60 s = 2.4 live   → "rare single-channel contacts
   *                                            that vanish"
   *   GATHERING  1/8  Hz × 60 s = 7.5 live   → "instruments getting busier for
   *                                            no reason"
   *   DENSE      1/2.5 Hz × 60 s = 24 live   → "instruments unusable"
   *
   * Twenty-four simultaneous well-formed contacts is unusable in the specific
   * sense that matters: cross-referencing two channels by hand cannot keep up,
   * so the tell in §10.4 stops being executable exactly where the cover is best.
   * That is the trade §10.4 asks for and these three numbers are where it lives.
   */
  echoEverySec: {
    [POSTURE.DISPERSED]: 25.0,
    [POSTURE.GATHERING]: 8.0,
    [POSTURE.DENSE]: 2.5,
    [POSTURE.RESONANT]: 2.5,
  },

  /**
   * [chosen, forced by §10.4] *"It responds to being scanned... it will be
   * repeated for as long as the shoal remembers it."*
   *
   * A weight on the ordinary lottery cannot promise that: one scan among four
   * hundred recordings surfaces when it feels like it. So a live scan recording
   * gets its own guaranteed schedule on top of the ordinary one. Forty-five
   * seconds against a 60 s echo life means there is essentially always a scan
   * echo on the player's instruments, and 600 s of memory means thirteen
   * repetitions. Scanning inside a Choir costs ten minutes of instrument, which
   * is what "poisons" has to mean if it means anything.
   */
  scanEchoEverySec: 45.0,

  /**
   * What counts as a scan, in the channel's own units. All three are the §3.2
   * anchor rows read at 80% — a margin for the medium and for the 10% the
   * signature system is allowed — so this fires on a real scan and not on a
   * boost.
   *
   *   pre-charge 20 EMU → 16     pulse 96 dB(V) → 76.8     pulse 40000 lm → 32000
   */
  scanEm: 16.0,                  // [contract §3.2]
  scanAcousticDb: 76.8,          // [contract §3.2]
  scanPhoticLm: 32000.0,         // [contract §3.2]

  /**
   * [chosen] Body length above which a recorded creature is "a large creature"
   * for §10.4's RESONANT posture. The Listener is 240 m and the Lantern's body
   * is 90 m; 150 separates them, and RESONANT plainly means the voice that is a
   * landmark — *"a Listener call, from the wrong place, slightly wrong pitch."*
   */
  largeBodyM: 150,

  // --- §10.4 environmental signature ---------------------------------------
  absorbDbPerKm: 6.0,            // [contract] +6 dB per km of shoal traversed
  emSigmaAddMax: 0.8,            // [contract] rad, at full density

  // --- posture ------------------------------------------------------------
  /**
   * [chosen] Posture is driven by one scalar, `density01`, and `density01`
   * follows the greater of two things: an ambient breathing term of the shoal's
   * own, and how continuously the shoal has had something to record.
   *
   * The second half is the interesting one and it is a lever rather than a
   * meter: **your own noise thickens the shoal that hides you.** A player who
   * runs loud past a Choir arrives back at a DENSE one, with the cover and the
   * unusable instruments that implies. §10.4's closing line is that cover and
   * clarity are the same resource spent opposite ways; this is where the player
   * gets to spend it.
   *
   * `exposure01` needs no normalisation constant because it is not a rate — it
   * is the fraction of recent sense ticks on which anything at all cleared a
   * floor, which is already 0..1 by construction. Guessing a divisor for a
   * recordings-per-second figure is exactly the class of mistake this project
   * has made five times.
   */
  exposureTauSec: 20.0,
  /**
   * [chosen] How fast density follows its target. GATHERING has to be *readable*
   * as "instruments getting busier for no reason", which means the change has to
   * happen over tens of seconds and not in a tick — a shoal that snapped from
   * DISPERSED to DENSE would read as a scripted event rather than as weather.
   * Thirty seconds is about half an echo life, so the rate visibly ramps.
   */
  densityTauSec: 30.0,
  /** Posture entry on `density01`, with §6's own 0.8× hysteresis so it does not chatter. */
  gatheringAt: 0.30,
  denseAt: 0.62,
  postureHysteresis: 0.8,
  /**
   * [chosen] The shoal's own weather, independent of the player. Redrawn on a
   * slow schedule so a Choir the player has never met is still sometimes thick —
   * without this, shoal density is a display of the player's own noise and the
   * world stops having weather in it. The ceiling is above `denseAt`, so an
   * unvisited shoal can be genuine cover; the floor is above zero, so it is
   * never simply absent.
   */
  ambientRange: [0.05, 0.78],
  ambientEverySec: [120, 300],

  // --- §8 ------------------------------------------------------------------
  /**
   * Trail sense radii, for the two channels §4.4 says are sampled where the
   * receiver is rather than transmitted. Quoted from §10.3 on the same principle
   * as `RECORDING_FLOOR`: the shoal records what the Wake Hunter could have
   * sensed, using the Wake Hunter's own radii, so the two agree about what was
   * in the volume.
   */
  wakeSenseRadiusM: 165,         // [contract §10.3]
  thermalSenseRadiusM: 220,      // [contract §10.3]
};

const TAU_ANGLE = Math.PI * 2;

// ---------------------------------------------------------------------------
// The echo bus
// ---------------------------------------------------------------------------

let _echoSerial = 0;

/**
 * Where an echo lives between the Choir emitting it and something sensing it.
 *
 * A bus rather than a method on the Choir, for the same reason `EmissionBus`
 * exists in `signature.js`: the consumer must not need to know how many Choirs
 * there are or where they are. `main.js` makes one of these, hands it to every
 * Choir, and puts it on `ctx` as `ctx.echoes`. Everything else reads it.
 *
 * **An echo is not a message. It is a source.** It carries a position, a channel
 * and an emitted value in that channel's own units, and a receiver is expected to
 * run the ordinary §4 transmission against it exactly as it would against the
 * ship. Nothing on it tells a receiver that it is an echo — `real: false` is for
 * the detection log (§7.3) and §5.1 is explicit that the flag is never exposed to
 * the player. If a receiver ever branches on `real`, the tell in §10.4 has been
 * replaced by a tag and the skill ceiling of this creature is gone.
 */
export class EchoBus {
  constructor({ capacity = 256 } = {}) {
    this.capacity = capacity;
    this.echoes = [];
    this.emitted = 0;
    this._lastT = -Infinity;
  }

  /** Choir only. */
  publish(echo) {
    this.echoes.push(echo);
    this.emitted++;
    // Hard cap ahead of expiry, so a pathological echo rate cannot grow this
    // without bound between updates. At the DENSE rate the steady state is 24.
    if (this.echoes.length > this.capacity) this.echoes.shift();
    return echo;
  }

  /**
   * Drop echoes whose minute is up.
   *
   * Idempotent for a given `t`, because several Choirs share one bus and each of
   * them calls this in its own `behave()`. A second call at the same sim time is
   * a no-op rather than a second pass over the list.
   */
  update(t) {
    if (t === this._lastT) return this;
    this._lastT = t;
    let w = 0;
    for (let i = 0; i < this.echoes.length; i++) {
      const e = this.echoes[i];
      if (e.endsAt > t) this.echoes[w++] = e;
    }
    this.echoes.length = w;
    return this;
  }

  each(fn) { for (let i = 0; i < this.echoes.length; i++) fn(this.echoes[i]); }
  live() { return this.echoes; }
  count() { return this.echoes.length; }
  countOn(channel) {
    let n = 0;
    for (let i = 0; i < this.echoes.length; i++) if (this.echoes[i].channel === channel) n++;
    return n;
  }
  clear() { this.echoes.length = 0; return this; }
}

// ---------------------------------------------------------------------------
// §10.4 environmental signature, as functions anything can call
// ---------------------------------------------------------------------------

/**
 * Length of the segment a→b that lies inside a sphere, in metres.
 *
 * Used for both of §10.4's environmental terms. Written out rather than
 * approximated by "is the midpoint inside" because a path that clips the edge of
 * a shoal and a path that goes down its long axis differ by kilometres, and the
 * whole point of the absorption is that traversing the shoal is expensive.
 */
export function chordThroughSphere(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6 || r <= 0) return 0;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const mx = ax - cx, my = ay - cy, mz = az - cz;
  const b = mx * ux + my * uy + mz * uz;
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t0 = Math.max(-b - s, 0);
  const t1 = Math.min(-b + s, len);
  return Math.max(t1 - t0, 0);
}

/**
 * §10.4: *"A dense shoal absorbs sound — add +6 dB of acoustic absorption per
 * kilometre of shoal traversed."*
 *
 * Additional dB to subtract from an acoustic path, on top of §4.1's own
 * `absorb_dB`. Scaled by each shoal's `density01`, because a DISPERSED shoal is
 * thin and the contract's figure plainly describes a dense one: crossing 4 km of
 * DENSE shoal costs 21 dB, which turns a cruising ship at 3 km from clearly
 * audible into inaudible. Crossing the same 4 km of DISPERSED shoal costs 5 dB,
 * which is worth something and not much. That range is the cover the player is
 * buying, and it is why flying deeper into a shoal is a real decision.
 *
 * @param {Array} shoals anything with `{position, radiusM, density01}` — Choirs
 */
export function choirAbsorptionDb(shoals, a, b) {
  if (!shoals || !shoals.length) return 0;
  let db = 0;
  for (let i = 0; i < shoals.length; i++) {
    const s = shoals[i];
    if (!s || !s.radiusM) continue;
    const m = chordThroughSphere(a.x, a.y, a.z, b.x, b.y, b.z,
      s.position.x, s.position.y, s.position.z, s.radiusM);
    if (m > 0) db += CHOIR.absorbDbPerKm * (s.density01 ?? 1) * (m / 1000);
  }
  return db;
}

/**
 * §10.4: *"and scatters EM, raising `bearingSigma` by up to 0.8 rad."*
 *
 * Additional radians to add to an EM percept's `bearingSigma`. "Up to" is read as
 * reached at full density through a full diameter, which makes the shoal's EM
 * effect the same shape as its acoustic one: a glancing path through a thin shoal
 * barely matters and a traverse of a dense one is 46° of error. A Lantern hunting
 * the ship's reactor across a dense shoal is loud and lost, which is the same
 * ambiguity §4.1 protects for ducts and should not be tuned away either.
 */
export function choirEmSigmaAdd(shoals, a, b) {
  if (!shoals || !shoals.length) return 0;
  let add = 0;
  for (let i = 0; i < shoals.length; i++) {
    const s = shoals[i];
    if (!s || !s.radiusM) continue;
    const m = chordThroughSphere(a.x, a.y, a.z, b.x, b.y, b.z,
      s.position.x, s.position.y, s.position.z, s.radiusM);
    if (m > 0) add += CHOIR.emSigmaAddMax * (s.density01 ?? 1) * clamp01(m / (2 * s.radiusM));
  }
  return Math.min(add, CHOIR.emSigmaAddMax);
}

// ---------------------------------------------------------------------------
// The creature
// ---------------------------------------------------------------------------

export class Choir extends Creature {
  constructor(opts = {}) {
    super({
      archetype: 'Choir',
      // The shoal has no body. `bodyLength` is the base class's contact-channel
      // and turn-radius scale and neither applies, so this is the element size
      // rather than a made-up hull: §10.4's only length is 0.4 m.
      bodyLength: CHOIR.elementM,
      fillRate: CHOIR.fillRate,
      decayRate: CHOIR.decayRate,
      memorySec: CHOIR.memorySec,
      // Per-percept thresholds and saturations are attached in `sense()` from
      // RECORDING_FLOOR / RECORDING_SATURATION; these are the fallbacks the base
      // class uses when a percept carries none, and the acoustic pair is the one
      // that would be used, so it is the acoustic pair.
      threshold: RECORDING_FLOOR.acoustic,
      saturation: RECORDING_SATURATION.acoustic,
      // §5.3. The Choir has no false positives of its own, and that is a
      // statement rather than an omission: a false positive is a *mistaken
      // detection*, and §10.4's whole mystery is that this creature never makes
      // one. Everything it holds was really there. Give it a false-positive rate
      // and "the false contacts are true" becomes false, and the deepest
      // mystery-to-understanding turn in the roster stops paying out.
      falsePositiveBase: 0,
      // §10.1's acoustic reach is the longest thing it could record, so promote
      // on that; §8's 1.4× then guarantees it is never promoted already holding
      // something it should not have heard.
      longestSenseRange: FAR_PLANE,
      ...opts,
      // AFTER the spread, deliberately.
      //
      // "It never enters COMMITTED" is the single load-bearing fact about this
      // creature — §6 exempts it from the one-COMMITTED rule on exactly that
      // basis, so a Choir that can climb the ladder does not just misbehave, it
      // silently removes the invariant that keeps two creatures from committing
      // to the player at once. With the spread last, `new Choir({ fillRate: 0.55 })`
      // reached COMMITTED; an adversarial pass found it and was right to call the
      // seal a default rather than a property. A zero fill rate means attention
      // has no term that can grow, which is structural: it holds no matter what
      // a caller passes, and it cannot be undone from outside this file.
      fillRate: 0,
    });

    this.rngVoice = this.rng ? this.rng.fork(RNG_TAG.VOICE) : null;
    this.rngBehaviour = this.rng ? this.rng.fork(RNG_TAG.BEHAVIOUR) : null;

    /** §10.4: the shoal spans 2–6 km. Radius, so `spanM` halves. */
    this.radiusM = opts.radiusM ?? this._draw(CHOIR.spanM) * 0.5;

    /** 0..1. Everything §10.4 calls "density" — absorption, scatter, posture. */
    this.density01 = clamp01(opts.density01 ?? CHOIR.ambientRange[0]);
    this.posture = POSTURE.DISPERSED;
    this.postureChanges = 0;

    this._exposure01 = 0;
    this._ambient = this.density01;
    this._nextAmbientAt = this._draw(CHOIR.ambientEverySec);

    /** §10.4's memory. Oldest-first; `_record` appends, `_forget` shifts. */
    this.memory = [];
    this.recordCount = 0;
    this.forgotCount = 0;

    /** Where echoes go. One bus for the world; see the class comment. */
    this.echoes = opts.echoes || new EchoBus();
    this._nextEchoAt = 0;
    this._nextScanEchoAt = 0;
    this.echoCount = 0;
    /** The poison, counted: how often and how recently a scan was played back. */
    this.scanEchoCount = 0;
    this.lastScanEchoAt = -Infinity;
    this._echoLog = [];
    this._echoLogCapacity = opts.echoLogCapacity ?? 64;

    this._resonantUntil = -1;
    /** Round-robin cursor over `ctx.creatures`. See `_recordPeers`. */
    this._peerCursor = 0;

    this._percepts = [];
    this._local = makeMediumSample();
    this._presentTerms = { distance: 0, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0, samples: 0 };
    this._peerTerms = { distance: 0, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0, samples: 0 };
    this._lastBearing = null;
    this._drift = vec();
  }

  _draw([lo, hi]) {
    return this.rngBehaviour ? this.rngBehaviour.range(lo, hi) : (lo + hi) * 0.5;
  }

  _drawVoice([lo, hi]) {
    return this.rngVoice ? this.rngVoice.range(lo, hi) : (lo + hi) * 0.5;
  }

  // -------------------------------------------------------------------------
  // §10.4 Senses — all five, and every one of them a recorder
  // -------------------------------------------------------------------------

  /**
   * Perceive, and remember what was perceived.
   *
   * **Recording happens here rather than in `onPercept`, deliberately.** The base
   * class funnels one percept per tick into `onPercept` — §5.4's "multiple
   * channels do not add; the strongest wins" — which is exactly right for a
   * creature deciding whether to escalate and exactly wrong for a creature whose
   * entire job is to hold everything it heard. A Choir that recorded only the
   * loudest channel would never hold the ship's EM while its engine was running,
   * and the tell in §10.4 needs the shoal to be able to echo any channel.
   * `sense()` still returns the full percept list, so the base machinery sees
   * what it always sees; it simply moves attention nowhere, because the rates are
   * zero.
   *
   * Medium sample budget, §8 allows 32:
   *
   *   1  at the shoal, for the local terms
   *   8  the acoustic path, from where the ship *was* — flight time is solved
   *   8  the present-position path, shared by photic and em, which do not travel
   *      slowly enough for the difference to exist
   *   8  one peer creature, round-robin
   *   ──
   *   25
   *
   * The round-robin is why peers are one per tick and not all of them: two peers
   * would be 33 and §8 is a cap, not a target. At 10 Hz a roster of six is fully
   * scanned every 0.6 s, which is well inside the shortest thing anybody in the
   * roster does.
   */
  sense(ctx) {
    const out = this._percepts;
    out.length = 0;

    const medium = ctx.medium;
    if (!medium) return out;

    const here = this.position;
    medium.sample(here.x, here.y, here.z, ctx.t, this._local);

    if (ctx.signature && ctx.shipPos) this._senseShip(ctx, out);
    if (ctx.trails) this._senseTrails(ctx, out);
    if (ctx.creatures) this._recordPeers(ctx, out);

    // §10.4's exposure term: did anything at all clear a floor this tick? A
    // fraction of ticks, not a rate, so there is no divisor to get wrong.
    const rate = 1 - Math.exp(-SENSE_DT / CHOIR.exposureTauSec);
    this._exposure01 += ((out.length > 0 ? 1 : 0) - this._exposure01) * rate;

    return out;
  }

  /**
   * The three field channels from the ship, through §4.
   *
   * The acoustic path is solved for flight time the same way the Listener solves
   * it — `τ = |shoal − ship(t−τ)| / 330`, two passes, which converges because
   * `|dd/dτ| ≤ v/c = 0.45`. Photic and em are read at the present position
   * because §5.2 gives them zero extra latency, and using the delayed position
   * for them would place the ship's lights 1.3 km from the ship.
   *
   * Nothing here reads `ctx.shipPos` into the recording. A recording holds what
   * was emitted and what the shoal itself was — never where the ship was — which
   * is what makes an echo's bearing the shoal's bearing later without any code
   * arranging for that.
   */
  _senseShip(ctx, out) {
    const sig = ctx.signature;
    const here = this.position;
    if (vdist(here, ctx.shipPos) > FAR_PLANE) return;

    let tau = vdist(here, ctx.shipPos) / SOUND_SPEED;
    if (sig.hasPositions) {
      for (let i = 0; i < 2; i++) {
        const p = sig.positionAt(tau);
        if (!p) break;
        tau = vdist(here, p) / SOUND_SPEED;
      }
    }

    // §7 would rather have no record than one built on the present mistaken for
    // the past: `at()` returns null past the recorder's span and this obeys it.
    const past = sig.at(tau, ctx.shipPos);
    if (past) {
      // `measurePath` and not `pathTerms`, so the terms this tick's log line
      // carries are the acoustic ones — the primary channel and the only one
      // with a non-trivial path story to tell.
      const terms = this.measurePath(ctx.medium, here, past, ctx.t);
      const received = acousticReceived(past.acoustic, terms);
      if (received > RECORDING_FLOOR.acoustic) {
        const sigma = acousticBearingSigma(terms);
        out.push(this._percept('acoustic', received, azimuth(here, past), sigma, tau, {
          emitted: past.acoustic,
          distance: terms.distance,
          positionExact: past.positionExact,
          g_mean: terms.g_mean,
        }));
        this._record(ctx, 'acoustic', past.acoustic, 'ship', -1, tau, {
          scan: past.acoustic >= CHOIR.scanAcousticDb,
        });
      }
    }

    // Photic and em share one path because they share one geometry.
    //
    // Read at age zero rather than through `current()`. §5.2 gives both channels
    // zero extra latency, so "now" is the right sample — but taking it from the
    // recorder means the *position* comes from the same history the acoustic path
    // used, so the two rays are built by one mechanism and cannot disagree about
    // where the ship is. It also means a signature view with no live object
    // behind it still works.
    const now = sig.at(0, ctx.shipPos);
    if (!now) return;
    const p = now;
    const terms = pathTerms(ctx.medium, here.x, here.y, here.z, p.x, p.y, p.z, ctx.t, this._presentTerms);
    const bearing = azimuth(here, p);

    const ph = photicReceived(now.photic, terms);
    if (ph.total > RECORDING_FLOOR.photic) {
      out.push(this._percept('photic', ph.total, bearing, ph.bearingSigma, 0, {
        emitted: now.photic, distance: terms.distance, positionExact: now.positionExact,
      }));
      this._record(ctx, 'photic', now.photic, 'ship', -1, 0, {
        scan: now.photic >= CHOIR.scanPhoticLm,
      });
    }

    const em = emReceived(now.em, terms);
    if (em.total > RECORDING_FLOOR.em) {
      out.push(this._percept('em', em.total, bearing, em.bearingSigma, 0, {
        emitted: now.em, distance: terms.distance, positionExact: now.positionExact,
      }));
      // §3.2: the capacitor ramps to 20 EMU over 1.5 s *before* the pulse fires.
      // The shoal therefore memorises the *intention* to scan as readily as the
      // scan, which is §3.2's own "scanning announces itself twice" arriving in
      // a second system without anything being added to make it.
      this._record(ctx, 'em', now.em, 'ship', -1, 0, { scan: now.em >= CHOIR.scanEm });
    }
  }

  /**
   * §4.4's two trail channels, sampled where the shoal is.
   *
   * Optional: `ctx.trails` is anything exposing `sampleWake(x, y, z, radius)` and
   * `sampleThermal(...)`, which the live `Signature` does. Without it the shoal
   * simply has no wake or heat in its memory — which is a smaller Choir, not a
   * broken one, and is what happens in a headless test with no parcel field.
   *
   * The radii are the Wake Hunter's, per `CHOIR.wakeSenseRadiusM`. The shoal is
   * kilometres across and could defensibly sweep all of it, but §4.4's falloff is
   * defined against the *receiver's* sense radius and a 3 km radius would sum the
   * entire trail buffer into one number that never falls below anything. Using
   * the roster's own radii keeps the shoal's memory of a trail comparable to what
   * the creature that hunts trails would have felt.
   */
  _senseTrails(ctx, out) {
    const here = this.position;
    const trails = ctx.trails;
    if (typeof trails.sampleWake === 'function') {
      const w = trails.sampleWake(here.x, here.y, here.z, CHOIR.wakeSenseRadiusM);
      if (w > RECORDING_FLOOR.wake) {
        // A trail gives a position, but it is where the ship *was*: §5.1. The
        // bearing is to the parcel field's centre of mass if the source offers
        // one, and otherwise to the shoal itself, which is honest — a shoal that
        // has flown through a wake knows it is in one, not where it came from.
        out.push(this._percept('wake', w, this._lastBearing ?? 0, 1.0, 0, { emitted: w }));
        this._record(ctx, 'wake', w, 'ship', -1, 0, {});
      }
    }
    if (typeof trails.sampleThermal === 'function') {
      const k = trails.sampleThermal(here.x, here.y, here.z, CHOIR.thermalSenseRadiusM);
      if (k > RECORDING_FLOOR.thermal) {
        out.push(this._percept('thermal', k, this._lastBearing ?? 0, 1.0, 0, { emitted: k }));
        this._record(ctx, 'thermal', k, 'ship', -1, 0, {});
      }
    }
  }

  /**
   * §11.3: *"The Choir records other creatures, which is what makes its echoes
   * informative."*
   *
   * One peer per sense tick, round-robin, for the §8 budget reason in `sense()`.
   * A peer is anything with a `position` and a `voiceState()` reporting
   * `emittedDb` — which is the interface `listener.js` already exposes and the
   * one every archetype in this project publishes for §9's benefit. A creature
   * that is silent this instant is not recorded, which is why a Listener inside
   * its own listening window leaves nothing behind: the shoal cannot hold what
   * was never emitted, and §10.4 says it does not invent.
   */
  _recordPeers(ctx, out) {
    const list = ctx.creatures;
    if (!list.length) return;
    // Advance first, so a roster that shrinks cannot pin the cursor on a gap.
    this._peerCursor = (this._peerCursor + 1) % list.length;
    const c = list[this._peerCursor];
    if (!c || c === this || typeof c.voiceState !== 'function') return;

    const v = c.voiceState();
    const db = v.emittedDb ?? 0;
    if (db <= 0) return;

    const here = this.position;
    const d = vdist(here, c.position);
    if (d > FAR_PLANE) return;

    const terms = pathTerms(ctx.medium, here.x, here.y, here.z,
      c.position.x, c.position.y, c.position.z, ctx.t, this._peerTerms);
    const received = acousticReceived(db, terms);
    if (received <= RECORDING_FLOOR.acoustic) return;

    const sigma = acousticBearingSigma(terms);
    out.push(this._percept('acoustic', received, azimuth(here, c.position), sigma,
      d / SOUND_SPEED, { emitted: db, distance: d, positionExact: true, g_mean: terms.g_mean }));

    this._record(ctx, 'acoustic', db, c.archetype, c.id, d / SOUND_SPEED, {
      large: (c.bodyLength ?? 0) >= CHOIR.largeBodyM,
      voice: { fundamentalHz: v.fundamentalHz ?? null, partials: v.partials ?? null },
    });
  }

  /**
   * §5.1: a percept is never a position, it is an estimate with its error
   * attached, and the bearing it carries is *already corrupted* by
   * `bearingSigma`. Corrupting it here rather than leaving the true bearing in
   * the record matters for more than tidiness: `crossReference()` at the foot of
   * this file separates real contacts from echoes by asking whether several
   * channels agree, and a sensor that returned exact bearings would make every
   * real contact agree perfectly and the discriminator would look far better
   * than it is.
   */
  _percept(channel, strength, bearing, sigma, ageSec, extra) {
    const thr = RECORDING_FLOOR[channel];
    const sat = RECORDING_SATURATION[channel];
    const noisy = wrapAngle(bearing + (this.rngSense ? this.rngSense.gaussian() : 0) * sigma);
    const p = makePercept(channel, strength, noisy, sigma, ageSec,
      perceptExcess(strength, thr, sat) * (1 - clamp01(sigma)), true, extra);
    p.threshold = thr;
    p.saturation = sat;
    return p;
  }

  /** Keeps a bearing for the trail channels to fall back on. Attention is untouched. */
  onPercept(p, _ctx) {
    if (p.channel === 'acoustic' || p.channel === 'photic' || p.channel === 'em') {
      this._lastBearing = p.bearing;
    }
  }

  // -------------------------------------------------------------------------
  // §10.4 Memory
  // -------------------------------------------------------------------------

  /**
   * Store one thing the shoal genuinely perceived.
   *
   * `emitted` is the value **at the source**, not what arrived here, and that is
   * the load-bearing decision in this method. See `_emitEcho` for what it costs
   * and why it is right.
   *
   * De-duplication: a source already recorded on this channel within
   * `dedupeSec` refreshes the existing entry instead of adding one. Without it a
   * steady cruise fills the whole memory with itself in forty seconds and the
   * shoal can no longer hold the Listener that passed four minutes ago — which is
   * the thing that makes its echoes worth reading at all.
   */
  _record(ctx, channel, emitted, sourceKind, sourceId, ageSec, flags = {}) {
    const t = ctx.t;
    // **A scan is never merged into an ongoing recording, and that is not
    // tidiness.** The first version of this folded the scan flag into whatever
    // "ship / acoustic" record was already open, and because a ship inside the
    // shoal refreshes that record on every sense tick, its `t` never aged and
    // the scan flag never expired: one scan poisoned the instruments for as long
    // as the player kept flying nearby, forever. Measured at 698 s and still
    // going. §10.4 says the scan is repeated *for as long as the shoal remembers
    // it*, and §5.4 says that is 600 s — a poison with no end is a different
    // mechanic, and a worse one, because it removes the player's reason to wait
    // it out. A scan is loud and distinctive, so it gets its own memory.
    if (!flags.scan) {
      for (let i = this.memory.length - 1; i >= 0; i--) {
        const r = this.memory[i];
        if (r.channel !== channel || r.sourceKind !== sourceKind || r.sourceId !== sourceId) continue;
        if (r.scan) continue;
        if (t - r.t > CHOIR.dedupeSec) break;
        // Refresh in place: the shoal is hearing the same thing continue, not a
        // second thing. Keep the louder value — an echo of a boost is a more
        // faithful record of that minute than an echo of the cruise either side.
        r.t = t;
        r.emitted = Math.max(r.emitted, emitted);
        r.repeats++;
        return r;
      }
    } else {
      // Two sense ticks inside one 0.2 s pulse are one scan, not two.
      for (let i = this.memory.length - 1; i >= 0; i--) {
        const r = this.memory[i];
        if (t - r.t > CHOIR.dedupeSec) break;
        if (r.scan && r.channel === channel && r.sourceKind === sourceKind && r.sourceId === sourceId) {
          r.t = t;
          r.emitted = Math.max(r.emitted, emitted);
          r.repeats++;
          return r;
        }
      }
    }

    const rec = {
      channel,
      emitted,
      sourceKind,
      sourceId,
      // §10.4: *"stored with a timestamp"*. The timestamp is held and then
      // stripped from the echo — see `_emitEcho`. It exists so a developer can
      // read the log, and because "the lies are accurate historical records with
      // the timestamps stripped off" needs there to have been a timestamp.
      t,
      // How old the evidence already was when the shoal heard it: the acoustic
      // flight time, or a trail's age. An echo's total staleness is this plus
      // however long the shoal has held it.
      ageAtRecord: ageSec,
      scan: !!flags.scan,
      large: !!flags.large,
      voice: flags.voice ?? null,
      repeats: 1,
    };
    this.memory.push(rec);
    this.recordCount++;
    this._forget(t);
    return rec;
  }

  /**
   * §10.4: *"It has a capacity of some hundreds of recordings and it forgets the
   * oldest."* Plus §5.4's 600 s memory, whichever bites first.
   *
   * Scan recordings are exempt from the capacity rule and expire only on the
   * clock. That is the poison: §10.4 says a scan "will be repeated for as long as
   * the shoal remembers it", and a scan that could be pushed out by four hundred
   * seconds of engine note would be repeated for as long as the shoal was quiet,
   * which is the opposite of the mechanic.
   */
  _forget(now) {
    const t = now ?? this._lastForgetT ?? 0;
    this._lastForgetT = t;
    if (t > 0) {
      let w = 0;
      for (let i = 0; i < this.memory.length; i++) {
        const r = this.memory[i];
        if (t - r.t <= CHOIR.memorySec) this.memory[w++] = r;
        else this.forgotCount++;
      }
      this.memory.length = w;
    }
    while (this.memory.length > CHOIR.capacity) {
      // Oldest first, skipping scans. If somehow everything held is a scan, the
      // oldest scan goes rather than growing without bound.
      let idx = this.memory.findIndex((r) => !r.scan);
      if (idx < 0) idx = 0;
      this.memory.splice(idx, 1);
      this.forgotCount++;
    }
  }

  /** How many live scan recordings the shoal is holding. The poison, counted. */
  scanMemoryCount() {
    let n = 0;
    for (let i = 0; i < this.memory.length; i++) if (this.memory[i].scan) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // §10.4 Playback
  // -------------------------------------------------------------------------

  /**
   * Emit one echo: a real recording, re-sounded from a point inside the shoal.
   *
   * Three properties are what make this creature what it is, and all three are
   * consequences of the two lines that pick the origin and the emitted value.
   *
   * **One channel.** A recording is one channel because a percept is one channel.
   * Nothing recombines them, so an echo can never present the two-channel
   * agreement §10.4 reserves for real contacts. That is the tell, and it is not
   * enforced anywhere — it is structural.
   *
   * **The Choir's bearing.** The origin is a uniform point inside the shoal
   * sphere. A receiver computing `azimuth(self, echo)` therefore gets the shoal's
   * bearing and not the imitated thing's, exactly as §10.4 promises, without a
   * single line arranging it. From far outside the shoal that bearing is tight;
   * from inside, the same uniform draw spreads it across the whole sky, which is
   * §10.4's *"inside the shoal the echoes come from every direction at once, so
   * the tell degrades exactly where the cover is best."* Nothing implements the
   * degradation; it is what a 4 km sphere looks like from two distances.
   *
   * **No range information at all.** The echo re-emits the value the source was
   * *emitting*, not the attenuated thing that arrived at the shoal. The shoal is
   * reproducing a signature, not replaying a wavefront — §10.4 says it stores
   * "any signature it is exposed to" and reproduces it. The consequence is
   * precise and worth stating: an echo of a ship heard at eight kilometres and an
   * echo of the same ship heard at eight hundred metres are identical, so an echo
   * carries no information about how far away the original was. The timestamps
   * are stripped, and so are the ranges. It also makes echoes strong enough to
   * *draw* other creatures, which §10.4 requires them to do; re-emitting the
   * received value would make every echo of a distant thing inaudible and the
   * Wake-Hunter-decoy mechanic would not exist.
   */
  _emitEcho(ctx, rec) {
    const r = this.rngVoice ? this.rngVoice.float() : 0.5;
    const u1 = this.rngVoice ? this.rngVoice.float() : 0.5;
    const u2 = this.rngVoice ? this.rngVoice.float() : 0.5;
    // Uniform in the ball: cube-root radius, or the echoes cluster at the centre
    // and the shoal reads as a point source with jitter rather than as a volume.
    const rad = this.radiusM * Math.cbrt(clamp01(r));
    const ct = u1 * 2 - 1;
    const st = Math.sqrt(Math.max(0, 1 - ct * ct));
    const phi = u2 * TAU_ANGLE;

    const echo = {
      id: ++_echoSerial,
      choirId: this.id,
      channel: rec.channel,
      emitted: rec.emitted,
      x: this.position.x + rad * st * Math.cos(phi),
      y: this.position.y + rad * ct,
      z: this.position.z + rad * st * Math.sin(phi),
      t0: ctx.t,
      endsAt: ctx.t + CHOIR.echoLifeSec,
      // §10.4 audio: re-synthesised at 0.7–1.3× pitch, with a comb-like ring no
      // real creature produces. Both are the second, subtler tell — available to
      // a player who has learned the voices well enough to notice one is wrong.
      pitch: this._drawVoice(CHOIR.pitchRange),
      sourceKind: rec.sourceKind,
      sourceId: rec.sourceId,
      voice: rec.voice,
      /** When the original was actually heard. Not readable from the echo itself. */
      recordedAt: rec.t,
      /** Total staleness: what it already was, plus how long the shoal has held it. */
      ageSec: rec.ageAtRecord + (ctx.t - rec.t),
      scan: rec.scan,
      large: rec.large,
      /** §5.1 / §7.3. For the detection log. Never exposed to the player. */
      real: false,
      posture: this.posture,
    };

    this.echoes.publish(echo);
    this.echoCount++;
    if (echo.scan) { this.scanEchoCount++; this.lastScanEchoAt = ctx.t; }
    this._echoLog.push(echo);
    if (this._echoLog.length > this._echoLogCapacity) this._echoLog.shift();

    // §10.4's RESONANT posture: re-emitting a large creature's full voice. It is
    // a thing the shoal is *doing*, so it lasts as long as the doing does.
    if (rec.large && (this.posture === POSTURE.DENSE || this.posture === POSTURE.GATHERING
      || this.posture === POSTURE.RESONANT)) {
      this._resonantUntil = Math.max(this._resonantUntil, ctx.t + CHOIR.echoLifeSec);
    }
    return echo;
  }

  /**
   * Which recording to play back.
   *
   * Uniform over everything held, with no weighting at all, and that is a
   * decision: §10.4's payoff is that an experienced player *reads* the shoal —
   * *"a shoal thick with Wake Hunter chirps is a shoal a pack has been
   * sweeping."* That inference is only sound if the echo mix is an unbiased
   * sample of the memory. Weighting playback towards the recent, or the loud, or
   * the dramatic would make the shoal a narrator, and the player's hard-won
   * reading of it would be a reading of the weighting.
   *
   * Scans get their repetition from a separate guaranteed schedule instead —
   * `CHOIR.scanEchoEverySec` — precisely so that the ordinary lottery can stay
   * honest.
   */
  /**
   * Never two channels of the same event at once.
   *
   * A single echo is structurally one channel, which is true and was never the
   * problem. The problem is that one *event* can be recorded on several: a scan
   * fires acoustic, EM and photic in the same 0.2 s, so the shoal ends up holding
   * three recordings of it. Replay two of those while the first is still audible
   * and a receiver sees the same event on two channels — which is precisely the
   * corroboration §10.4 reserves for real contacts, reconstructed out of parts
   * that were each individually honest.
   *
   * An adversarial pass found this by driving one realistic scan and watching the
   * tell stop working. The fix is a filter here rather than a rule in the
   * receiver, because the invariant belongs to the thing making the claim: the
   * shoal will happily forget an event for a moment rather than corroborate it.
   */
  _eventKey(r) { return `${r.sourceKind}#${r.sourceId}`; }

  _eventIsLive(rec, now) {
    const key = this._eventKey(rec);
    for (let i = 0; i < this.echoes.length; i++) {
      const e = this.echoes[i];
      if (e.channel === rec.channel) continue;          // same channel is a repeat, not corroboration
      if (e.endsAt !== undefined && e.endsAt <= now) continue;
      if (`${e.sourceKind}#${e.sourceId}` === key) return true;
    }
    return false;
  }

  _pickRecording(scanOnly, now = 0) {
    const pool = scanOnly ? this.memory.filter((r) => r.scan) : this.memory;
    if (!pool.length) return null;
    // Prefer a recording whose event is not already sounding on another channel.
    const free = pool.filter((r) => !this._eventIsLive(r, now));
    const use = free.length ? free : null;
    if (!use) return null;                              // stay silent rather than corroborate
    const i = this.rngVoice ? Math.floor(this.rngVoice.float() * use.length) : 0;
    return use[Math.min(i, use.length - 1)];
  }

  // -------------------------------------------------------------------------
  // §10.4 Posture and drift
  // -------------------------------------------------------------------------

  behave(dt, ctx) {
    const t = ctx.t;

    // The shoal is tens of thousands of 0.4 m animals. It rides the medium, and
    // §2.1's flow is the only motion it has: there is no body to swim with, and
    // §7.1 forbids anything else from turning it towards the player.
    if (ctx.medium) {
      const m = ctx.medium.sample(this.position.x, this.position.y, this.position.z, t, this._local);
      // A shoal is not a leaf; it lags the air it is in. Half the flow keeps it
      // recognisably drifting without letting a fast cell shear it across the map
      // faster than the player can re-find it.
      this._drift.x = m.flow.x * 0.5;
      this._drift.y = m.flow.y * 0.5;
      this._drift.z = m.flow.z * 0.5;
    }
    this.velocity.x = this._drift.x;
    this.velocity.y = this._drift.y;
    this.velocity.z = this._drift.z;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    this._updateDensity(dt, t);
    this._updatePosture(ctx, t);

    this._forget(t);
    this.echoes.update(t);

    // Ordinary playback.
    if (this._nextEchoAt <= 0) this._nextEchoAt = t + this._echoInterval();
    if (t >= this._nextEchoAt) {
      const rec = this._pickRecording(false, ctx.t);
      if (rec) this._emitEcho(ctx, rec);
      this._nextEchoAt = t + this._echoInterval();
    }

    // The poison, on its own guaranteed clock.
    if (this._nextScanEchoAt <= 0) this._nextScanEchoAt = t + CHOIR.scanEchoEverySec;
    if (t >= this._nextScanEchoAt) {
      const rec = this._pickRecording(true, ctx.t);
      if (rec) this._emitEcho(ctx, rec);
      this._nextScanEchoAt = t + CHOIR.scanEchoEverySec;
    }
  }

  _echoInterval() {
    const base = CHOIR.echoEverySec[this.posture] ?? CHOIR.echoEverySec[POSTURE.DISPERSED];
    // ±30% jitter, so a busy instrument reads as weather rather than as a
    // metronome. A perfectly periodic phantom is a tell the contract does not
    // offer and would be a much easier one than the channel-count rule.
    const j = this.rngVoice ? this.rngVoice.spread(0.3) : 0;
    return base * (1 + j);
  }

  _updateDensity(dt, t) {
    if (t >= this._nextAmbientAt) {
      this._ambient = this._draw(CHOIR.ambientRange);
      this._nextAmbientAt = t + this._draw(CHOIR.ambientEverySec);
    }
    const target = Math.max(this._ambient, this._exposure01);
    this.density01 = clamp01(this.density01
      + (target - this.density01) * (1 - Math.exp(-dt / CHOIR.densityTauSec)));
  }

  /**
   * §10.4's four postures, on §6's own hysteresis rule.
   *
   * Hysteresis is 0.8× entry, copied from §6 rather than invented, for the same
   * reason §6 has it: a shoal oscillating between GATHERING and DENSE at a
   * boundary would make "instruments getting busier" unreadable as a trend.
   */
  _updatePosture(ctx, t) {
    if (t < this._resonantUntil) {
      this._setPosture(ctx, POSTURE.RESONANT);
      return;
    }
    const d = this.density01;
    const h = CHOIR.postureHysteresis;
    let want = this.posture === POSTURE.RESONANT ? POSTURE.DENSE : this.posture;
    if (want === POSTURE.DENSE && d < CHOIR.denseAt * h) want = POSTURE.GATHERING;
    if (want === POSTURE.GATHERING) {
      if (d >= CHOIR.denseAt) want = POSTURE.DENSE;
      else if (d < CHOIR.gatheringAt * h) want = POSTURE.DISPERSED;
    }
    if (want === POSTURE.DISPERSED && d >= CHOIR.gatheringAt) want = POSTURE.GATHERING;
    this._setPosture(ctx, want);
  }

  /**
   * A posture change is written into the detection log.
   *
   * §7 requires an event for every *state* transition and a posture is not a
   * state, so this is not owed. It is here because §10.4's postures are the only
   * thing about this creature the player can perceive directly, and because a
   * shoal that went DENSE is the explanation for the next three minutes of
   * unusable instruments. A log that cannot say when the cover arrived cannot
   * answer "why did I stop being able to see anything", which is the question
   * §7 exists to make answerable.
   *
   * Echoes are deliberately **not** logged here. At the DENSE rate that is
   * twenty-four entries a minute, which would flush every real detection out of
   * the shared 64-entry ring — a log that hides the thing it is for. They go to
   * this creature's own `echoHistory()` instead, and the receiving creature's own
   * `DetectionEvent` already carries `real: false` and a distance that points at
   * the shoal, which is what §7.3 asks of a false contact.
   */
  _setPosture(ctx, to) {
    const from = this.posture;
    if (from === to) return;
    this.posture = to;
    this.postureChanges++;
    this._push({
      tick: ctx.tick, simTime: ctx.t, creature: this.id, archetype: this.archetype,
      from, to, channel: 'posture',
      emitted: null, transmitted: null, threshold: this.currentThreshold(),
      distance: ctx.shipPos ? vdist(this.position, ctx.shipPos) : null,
      medium: {
        rho_mean: this._terms.rho_mean, u_mean: this._terms.u_mean,
        q_mean: this._terms.q_mean, g_mean: this._terms.g_mean,
      },
      mediumFresh: false, positionExact: null, real: null,
      attention: this.attention,
      density01: +this.density01.toFixed(3),
      memory: this.memory.length,
    });
  }

  // -------------------------------------------------------------------------
  // §9 Audio
  // -------------------------------------------------------------------------

  /**
   * §10.4: *"No voice of its own."*
   *
   * `emittedDb` is 0 and must stay 0, and it is the one field that matters here,
   * because it is what another Choir reads in `_recordPeers`. A shoal with a
   * voice of its own would record its own echoes, echo the echoes, and the
   * "every echo is a recording of something genuinely present" guarantee would
   * decay into a feedback loop within a couple of minutes.
   *
   * What it hands the audio system instead is the live echo list and the
   * absorption it is applying to everything else — §10.4's *"when dense, it also
   * applies its absorption to everything else, so the whole mix goes muffled and
   * close: the sound of being inside something."*
   */
  voiceState() {
    return {
      fundamentalHz: null,
      partials: null,
      inharmonicity: 0,
      calling: false,
      silent: true,
      emittedDb: 0,
      posture: this.posture,
      density01: this.density01,
      /** Applied to the whole mix by anything inside the shoal. */
      absorbDbPerKm: CHOIR.absorbDbPerKm * this.density01,
      /** The faint comb-like ring no real creature produces. §10.4 audio. */
      combRing: this.density01,
      echoes: this.echoes.live(),
    };
  }

  /** The last 64 echoes this shoal emitted, oldest first. Not the detection log. */
  echoHistory() { return this._echoLog.slice(); }

  /** True while a path from `a` to `b` passes through this shoal at all. */
  intersects(a, b) {
    return chordThroughSphere(a.x, a.y, a.z, b.x, b.y, b.z,
      this.position.x, this.position.y, this.position.z, this.radiusM) > 0;
  }

  /** Is a point inside the shoal? The tell degrades in here; see `_emitEcho`. */
  contains(p) { return vdist(p, this.position) <= this.radiusM; }

  snapshot() {
    const s = super.snapshot();
    s.posture = this.posture;
    s.density01 = +this.density01.toFixed(3);
    s.radiusM = Math.round(this.radiusM);
    s.memory = this.memory.length;
    s.scanMemory = this.scanMemoryCount();
    s.echoesLive = this.echoes.count();
    s.echoesEmitted = this.echoCount;
    s.exposure01 = +this._exposure01.toFixed(3);
    return s;
  }
}

// ---------------------------------------------------------------------------
// What another creature does with an echo
// ---------------------------------------------------------------------------

/**
 * Turn live echoes into percepts for `creature`, using the same §4 transmission
 * every other percept in the project goes through.
 *
 * This exists so that no archetype has to hand-roll it — the moment two files
 * both know how an echo becomes a percept, they disagree by 3% in a way nobody
 * can find, which is what the header of `creature.js` is about.
 *
 * `spec` names the channels this creature can actually sense, with its own
 * thresholds and saturations, e.g.
 *
 *   senseEchoes(this, ctx, {
 *     wake:    { threshold: 0.05, saturation: 2.0, senseRadiusM: 165 },
 *     thermal: { threshold: 1.5,  saturation: 40,  senseRadiusM: 220 },
 *   }, out);
 *
 * A creature that cannot sense a channel simply does not list it and never hears
 * those echoes, which is correct: the shoal echoing a search lamp does nothing at
 * all to the blind Listener.
 *
 * **Field channels** (`acoustic`, `photic`, `em`) transmit from the echo's point
 * through §4.1–4.3, identically to the ship. **Trail channels** (`wake`,
 * `thermal`) use §4.4's falloff against the receiver's own sense radius, treating
 * the echo as a single parcel — which is what it is, and the only reading of §4.4
 * that does not require the shoal to write into the parcel buffer.
 *
 * Percepts come back with `real: false` so §7.3 gets its record, and with
 * `echo: true` plus `choirId` for the log's benefit. **Nothing downstream may
 * branch on either.** They are developer-facing, exactly like `real`; §5.1 says
 * the flag is never exposed to the player, and a creature that ignored echoes
 * because they were flagged would delete the entire mechanic.
 */
export function senseEchoes(creature, ctx, spec, out = []) {
  const bus = ctx.echoes;
  if (!bus || !ctx.medium) return out;
  const here = creature.position;
  const list = bus.live();

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const s = spec[e.channel];
    if (!s) continue;

    const d = vdist(here, e);
    if (d > FAR_PLANE) continue;

    let strength = 0, sigma = 0, ageSec = e.ageSec;

    if (e.channel === 'wake' || e.channel === 'thermal') {
      // §4.4. A trail is not transmitted; it is sampled where the receiver is.
      const R = s.senseRadiusM ?? 0;
      if (R <= 0 || d > R) continue;
      strength = e.emitted * (1 - clamp01(d / R));
      // A trail parcel gives a position, so the bearing is as good as the
      // geometry — and the geometry says the shoal.
      sigma = s.bearingSigma ?? 0.05;
    } else {
      const terms = creature.measurePath(ctx.medium, here, e, ctx.t);
      if (e.channel === 'acoustic') {
        strength = acousticReceived(e.emitted, terms);
        sigma = acousticBearingSigma(terms);
        // §5.2: what is heard now left the shoal `d/330` ago, on top of whatever
        // the recording was already carrying.
        ageSec += d / SOUND_SPEED;
      } else if (e.channel === 'photic') {
        const ph = photicReceived(e.emitted, terms);
        strength = ph.total; sigma = ph.bearingSigma;
      } else {
        const em = emReceived(e.emitted, terms);
        strength = em.total; sigma = em.bearingSigma;
      }
    }

    if (!(strength > s.threshold)) continue;

    const bearing = wrapAngle(azimuth(here, e)
      + (creature.rngSense ? creature.rngSense.gaussian() : 0) * sigma);
    const p = makePercept(e.channel, strength, bearing, sigma, ageSec,
      perceptExcess(strength, s.threshold, s.saturation) * (1 - clamp01(sigma)),
      false, {
        emitted: e.emitted,
        distance: d,
        positionExact: true,
        echo: true,
        choirId: e.choirId,
        echoId: e.id,
        imitates: e.sourceKind,
      });
    p.threshold = s.threshold;
    p.saturation = s.saturation;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tell, as a function
// ---------------------------------------------------------------------------

/**
 * §10.4's discriminator, implemented once so the ship's instruments and the tests
 * agree about what it says.
 *
 *   > A real contact appears on **two or more channels with consistent
 *   > bearings**. A Choir echo appears on **exactly one channel**, and its
 *   > bearing is **the Choir's own bearing, not the bearing of the thing it is
 *   > imitating**.
 *
 * Percepts are grouped by bearing agreement and each group is reported with the
 * channels it spans. Two percepts agree when their bearings are within `k`
 * combined sigmas — the standard two-sigma test, so there is no invented
 * tolerance constant here; the tolerance is whatever the medium made the bearing
 * errors, which means it widens by itself in a duct or a charged cell and the
 * tell gets harder exactly where §4 says bearings get worse.
 *
 * **This returns evidence, not a verdict about the world.** `nChannels === 1` is
 * *"could be an echo"*, not *"is an echo"* — a ship running dark but not silent
 * is genuinely a one-channel contact, and a player who learns to discard every
 * single-channel return will eventually discard the real one. That ambiguity is
 * the skill, and this function must not resolve it. It reports what is
 * observable and stops.
 */
export function crossReference(percepts, { k = 2, minSigma = 0.02 } = {}) {
  const groups = [];
  for (let i = 0; i < percepts.length; i++) {
    const p = percepts[i];
    if (p.bearing === null || p.bearing === undefined) continue;
    const sp = Math.max(p.bearingSigma ?? 0, minSigma);
    let placed = null;
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const sg = Math.max(grp.bearingSigma, minSigma);
      if (Math.abs(shortestAngle(grp.bearing, p.bearing)) <= k * Math.hypot(sp, sg)) {
        placed = grp; break;
      }
    }
    if (!placed) {
      placed = { bearing: p.bearing, bearingSigma: sp, percepts: [], channels: [] };
      groups.push(placed);
    }
    placed.percepts.push(p);
    if (!placed.channels.includes(p.channel)) placed.channels.push(p.channel);
    // Inverse-variance fuse, the same weighting `listener.js` uses, so a group's
    // bearing is dominated by its best-located member rather than its first.
    const w0 = 1 / (placed.bearingSigma * placed.bearingSigma);
    const w1 = 1 / (sp * sp);
    placed.bearing = wrapAngle(placed.bearing
      + shortestAngle(placed.bearing, p.bearing) * (w1 / (w0 + w1)));
    placed.bearingSigma = 1 / Math.sqrt(w0 + w1);
  }

  return groups.map((g) => {
    let spread = 0;
    for (const p of g.percepts) spread = Math.max(spread, Math.abs(shortestAngle(g.bearing, p.bearing)));
    return {
      bearing: g.bearing,
      bearingSigma: g.bearingSigma,
      bearingSpreadRad: spread,
      channels: g.channels.slice(),
      nChannels: g.channels.length,
      percepts: g.percepts,
      /**
       * `corroborated` — two or more channels agreeing. §10.4's own words for
       * what a real contact looks like. The negative case is named `single` and
       * not `fake`, on purpose; see the note above.
       */
      corroborated: g.channels.length >= 2,
      single: g.channels.length === 1,
    };
  });
}

// ---------------------------------------------------------------------------
// INTEGRATION — what `main.js` and the other archetypes have to do
// ---------------------------------------------------------------------------
//
// 1. `src/game/creatures/index.js` gains one line:
//
//        export * from './choir.js';
//
// 2. `main.js` makes exactly one bus for the world, hands it to every Choir, and
//    puts it on the context every creature already receives:
//
//        import { Choir, EchoBus, RNG_TAG } from './game/creatures/index.js';
//
//        const echoes = new EchoBus();
//        manager.add(new Choir({
//          id: 40, position: { x: 4200, y: 20400, z: -1800 },
//          rng: worldRng.fork(RNG_TAG.CHOIR),
//          echoes,
//        }));
//
//        // the ctx already passed to manager.update(), plus two optional keys
//        ctx.echoes    = echoes;      // required for echoes to reach anybody
//        ctx.creatures = manager.creatures;   // optional: §11.3, records peers
//        ctx.trails    = signature;   // optional: §4.4 wake/thermal recording
//
//    Both optional keys degrade to "the shoal holds less", never to an error.
//
// 3. Any archetype that should be drawable by an echo adds three lines to its
//    own `sense()`, listing only the channels it actually has:
//
//        import { senseEchoes } from './choir.js';
//        ...
//        senseEchoes(this, ctx, {
//          wake:    { threshold: WAKE_HUNTER.wakeThreshold,    saturation: 2.0, senseRadiusM: 165 },
//          thermal: { threshold: WAKE_HUNTER.thermalThreshold, saturation: 40,  senseRadiusM: 220 },
//        }, out);
//
//    and nothing else. The percepts it produces run through the same attention
//    integrator, the same state machine and the same detection log as any other,
//    which is the point: a Wake Hunter that commits to an echo did so through the
//    ordinary machinery, and its `DetectionEvent` will say `real: false` with a
//    distance that points at the shoal. Nothing in the receiver may branch on
//    `echo` or on `real`.
//
// 4. §10.4's environmental signature is applied by the *caller* of the
//    transmission, because `creature.js` owns §4 and this file must not fork it:
//
//        received -= choirAbsorptionDb(choirs, from, to);          // acoustic
//        sigma    += choirEmSigmaAdd(choirs, from, to);            // em
//
//    where `choirs` is `manager.creatures.filter(c => c.archetype === 'Choir')`.
//    Applying it in one place — a small wrapper beside the transmission call —
//    keeps it true for the ship's instruments and the creatures at once, which
//    §0 requires: *"do not build a second, cleaner detection path for the
//    player."*
//
// UNRESOLVED, and the orchestrator should decide rather than inherit it:
//
//   §8 says the reduced model may never produce a detection. A reduced Choir
//   stops sensing (the base class gates `_senseTick` on `fullySimulated`) but
//   this file keeps emitting echoes, because a shoal that stops existing when
//   the player looks away is not weather. The defence is that an echo is a
//   *source*, not a sense: the detection it causes is produced entirely by the
//   receiving creature's own fully-simulated detection code, from a real
//   emission at a real point, and it is explicable from the log. That reading is
//   defensible and it is not the only one. If it is rejected, the fix is one
//   line — gate the two `_emitEcho` calls in `behave()` on `this.fullySimulated`
//   — and the cost is shoals that go silent at range.

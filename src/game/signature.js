// What the ship emits.
//
// This is the mechanical heart of the game. The player has no weapon and no
// shield; the only thing they actually control is how findable they are, so this
// file has to be right in the way a combat system has to be right in a game
// about combat. Two failure modes bracket it, and both are common:
//
//   A stealth meter. One number, one bar, one correct behaviour — be quiet. The
//   player learns it in ninety seconds and there is nothing left. Pillar 2 of
//   GAME_VISION.md exists to forbid exactly this: if there is a configuration
//   that is quiet on every axis at once, the game is over.
//
//   Hidden arbitrary rules. Six numbers that move for reasons the player cannot
//   reconstruct. Then being found is unfair whether or not it was, and Pillar 3
//   is broken. Everything here is therefore auditable: `breakdown()` names every
//   contributor to every channel in that channel's own units, and the recorder
//   in 3.4 keeps five minutes of it so a player can conduct a post-mortem.
//
// The numbers are not invented here. CREATURE_BEHAVIOR_CONTRACT.md §3 is the
// specification, the anchor table in §3.2 is the acceptance test, and where this
// file and the contract disagree the contract is right. `tests/signature.test.js`
// asserts every anchor and every guarantee in the §12 test list.
//
// ---------------------------------------------------------------------------
// What is in this file, and why the emitters are in it too
// ---------------------------------------------------------------------------
// `Signature` is the channel assembler: it takes emissions and turns them into
// six numbers with the right decay laws. `ShipSystems` is the thing that emits.
// They are one file rather than two because they are one contract: the anchor
// table in §3.2 constrains them *jointly*, and every number in `SHIP_SYSTEMS`
// below was solved for by subtracting the assembler's own hull terms from an
// anchor row. Splitting them puts half of a simultaneous equation in each of two
// files, and the first person to retune one of them breaks the other silently.
// Nothing here imports the renderer or the flight model, so the module is still
// importable in isolation with no side effects.
//
// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
// The design brief for this system calls the six channels vibration, heat,
// light, em, wake and flowMismatch. The contract calls them acoustic, thermal,
// photic, em, wake and relSpeed, and the contract's names are what the creature
// AI, the transmission model and the instruments will be written against. The
// canonical keys are therefore the contract's; the brief's names exist as
// documented aliases so that either vocabulary reads correctly at a call site.
// Having one set of names in the code and a different set in the design document
// is precisely how two systems end up disagreeing about which quantity is which,
// so the mapping is stated once, here, and nowhere else.
//
// ---------------------------------------------------------------------------
// Where the medium is allowed to matter
// ---------------------------------------------------------------------------
// The brief asks for a decision on whether dense cloud carries sound further.
// The decision, and it is consistent with contract §4.1:
//
//   **Density absorbs sound. Gradients carry it.**
//
// A source's acoustic power does not depend on where the source is standing, so
// nothing in this file makes the ship louder or quieter because of the local
// density. Absorption (12 dB per km of density 1.0) and ducting (the spreading
// exponent falling from 20 to 12 in a shear layer) both live in transmission,
// which is the receiver's problem, not the emitter's. The consequence is the one
// the design wants: the clear corridor that looks like the easy road is the
// place your engine noise travels furthest, and no part of that had to be
// scripted.
//
// The trail channels are the opposite case and for a real reason: wake and heat
// are physical disturbances *of* the medium, so the medium they are made in is
// part of making them. Wake scales with local density — a boost through a dense
// bank tears a far stronger trail than the same boost in clear air — and heat is
// shed faster into cold dense vapour than into thin air. Both are levers the
// player can use, both are visible in the picture, and both are documented
// beside the constant that implements them.
//
// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------
// Every channel has its own time constant and they differ by two orders of
// magnitude, because that is what makes different mistakes cost different
// amounts of *time* rather than different amounts of a resource:
//
//   photic      0 s      a lamp is off when you switch it off
//   em          0 s      except the scan capacitor, which is a real store
//   wake     0.35 s      the vortex sheet detaches
//   acoustic   2.2 s     machinery spinning down
//   thermal     90 s     the hull cooling towards ambient
//
// Two of those are zero and that is a decision, not an omission. Contract §3.1
// classes photic and em as field channels: they stop the instant the ship stops
// emitting. If going dark did not work immediately it would not be a tactic, and
// the Lantern's whole mechanic — brightness is safety, darkness is commitment —
// depends on darkness being available in one frame.
//
// The consequence of the acoustic constant is worth stating because it was not
// designed in, it fell out. **Measured**, from a settled 46.01 dB(V) cruise with
// every emitter cut in the same step (`tests/signature.test.js`, "power-down
// timeline"):
//
//   15.3 s  to fall below the Listener's normal 16 dB(V) threshold
//   22.5 s  to fall below its 6 dB(V) *listening* threshold
//   29.6 s  to settle onto the 4 dB hull floor
//
// The Listener's silent listening window is 18–26 s (§10.1). So a player who
// starts the power-down at the moment the silence begins is still above 6 dB for
// the first 22.5 s of it: they get away with it in a 26 s window and are caught
// in an 18 s one, and the window length is not something they can see. The rule
// is therefore not "go quiet when it goes quiet" but "have started already", and
// the margin is a gamble rather than a calculation. An earlier version of this
// header claimed 21 s to the hull floor, which is wrong by 40%; the numbers above
// are measured and the test that measures them fails if they move.

import { clamp, clamp01, lerp, approach } from '../core/math.js';

// ---------------------------------------------------------------------------
// Canonical channels
// ---------------------------------------------------------------------------

/** Contract §3.1 order. Anything iterating channels iterates this. */
export const CHANNELS = ['acoustic', 'thermal', 'photic', 'em', 'wake', 'relSpeed'];

/** Units, for anything that renders a number to the player. */
export const CHANNEL_UNITS = {
  acoustic: 'dB(V)',
  thermal: 'ΔK',
  photic: 'lm',
  em: 'EMU',
  wake: 's⁻¹',
  relSpeed: 'm/s',
};

/** Contract §3.1 classes. The creature AI branches on these. */
export const CHANNEL_CLASS = {
  acoustic: 'field',
  thermal: 'trail',
  photic: 'field',
  em: 'field',
  wake: 'trail',
  relSpeed: 'contact',
};

/** The design brief's vocabulary, mapped to the contract's. See the header. */
export const CHANNEL_ALIASES = {
  vibration: 'acoustic',
  heat: 'thermal',
  light: 'photic',
  em: 'em',
  wake: 'wake',
  flowMismatch: 'relSpeed',
};

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Every constant the body contributes, in the contract's units.
 *
 * **The anchor table in contract §3.2 is quoted in clear air (ρ = 0), which is
 * also where the 90 s thermal constant holds.** Both density terms below are
 * multiplicative and equal to 1.0 at ρ = 0, so the anchors are exact there and
 * scale from there in a documented direction. Without a stated reference density
 * the anchors are unfalsifiable, which would make the acceptance test in
 * `tests/signature.test.js` meaningless.
 */
export const SIG = {
  // --- reference kinematics ------------------------------------------------
  // The flight model's steady state at full main throttle: thrustMain 46 m/s²
  // against dragForward 0.0021 gives sqrt(46/0.0021) = 148.0 m/s. Cruise in the
  // anchor table means this. Boost gives sqrt(118/0.0021) = 237.0 m/s, so the
  // dynamic-pressure ratio q between boost and cruise is 2.565 and every
  // speed-driven term inherits it rather than being tuned twice. Both measured
  // against a real `Flight` over 400 s: 148.003 and 237.045 m/s.
  cruiseRel: 148.0,
  boostRel: 237.0,

  // --- acoustic, dB(V) -----------------------------------------------------
  // Combined in the power domain, never by adding decibels. Adding decibels is
  // the single most common unit error in game audio code and it silently makes
  // two quiet sources louder than one loud one.
  hullFloorDb: 4.0,          // creak and airflow over a dead hull; anchor row 1
  manoeuvreHardDb: 50.7,     // at strain 1.0; puts hard-turn-at-cruise on 52 dB

  // **Calibrated against the shipped flight model, not chosen.** Anchor row 4 is
  // "hard turn at cruise", so strain 1.0 has to mean the hardest sustained turn
  // the ship can actually hold. Measured on a real `Flight` at full throttle with
  // full yaw held for 300 s, averaged over the last 60 s:
  //
  //   gLoad 59.635 m/s²   slip 0.5705 rad (sin 0.540)   speed 112.47 m/s (q 0.578)
  //
  // The previous value here was 36.0, which was a guess: it made the same turn
  // read 55.6 dB against the anchor's 52 — inside the 10% tolerance, but by
  // accident. These three measurements are coupled to `manoeuvreGRef`,
  // `wakeSlipInv`, `strainThermalKps` and `strainEmu` below; retuning the flight
  // model means re-measuring them and re-running the anchor test.
  manoeuvreGRef: 59.635,     // m/s² of lateral+vertical load that means strain 1
  manoeuvreStrainCap: 4.0,   // strain is squared into power; uncapped it diverges
  acousticRiseTau: 0.45,     // s — turbines spool up faster than they spool down
  acousticFallTau: 2.2,      // s — see the header note on the Listener's window
  transientFallDbPerS: 34.0, // reverberant decay is linear in dB, not in power

  // --- thermal, ΔK above local --------------------------------------------
  thermalTau: 90.0,          // contract §3.2, clear air
  // Cold dense vapour is a better heat sink than thin air, so a ship that hides
  // in a bank also cools in it. This is the one line to replace when
  // Medium.sample() gains a real temperature — until then density is the proxy.
  thermalDensityCooling: 1.4,
  // Airframe and actuators under load. Anchor row 4 is 44 ΔK against cruise's 40
  // in the same throttle setting, so the extra 4 K is the manoeuvre itself:
  // 4 / thermalTau = 0.04444 K/s at strain 1.0. Squared like the acoustic term
  // because both are structural work against the medium.
  strainThermalKps: 0.044444,

  // --- photic, lm ----------------------------------------------------------
  // The engine plume. Contract §3.2 shows photic flat at 3 lm from idle through
  // boost, which taken literally would make boost and cruise *equal* on this
  // channel — and one of this system's load-bearing properties is that boost is
  // strictly worse than cruise on all six. A plume of a quarter of a lumen
  // restores strictness and leaves the total at 3.25 lm, well inside the
  // contract's stated 10% tolerance on 3. The deviation is deliberate, small,
  // and recorded here rather than discovered later.
  plumeThrottleLm: 0.05,
  plumeBoostLm: 0.25,

  // --- em, EMU -------------------------------------------------------------
  // Control actuators under load. Anchor row 4 is 2.6 EMU against cruise's 2.2.
  strainEmu: 0.4,

  // --- wake, s⁻¹ -----------------------------------------------------------
  // Every wake term is multiplied by the density factor, because wake is not a
  // thing the ship has, it is a thing the ship does to the vapour, and there has
  // to be vapour to do it to.
  wakeFloorInv: 0.02,        // hull adrift; anchor row 1
  wakePassageInv: 0.55,      // × q; puts cruise on 0.60 with the reactor's 0.03
  // × q × sin(slip). Solved for anchor row 4 with the *measured* sustained turn
  // above, not with an assumed 0.30 rad slip:
  //   1.8 = 0.02 (hull) + 0.03 (reactor) + 0.55·0.578 + k·0.578·0.540
  //   k = (1.8 − 0.02 − 0.03 − 0.3179) / 0.3121 = 4.59
  wakeSlipInv: 4.59,
  wakeDensityGain: 2.4,      // densityFactor = 1 + 2.4ρ, so 1.0 in clear air
  wakeDensityCap: 3.4,
  wakeTau: 0.35,             // the sheet takes a moment to establish and to shed
  wakeImpulseTau: 1.1,       // a struck hull rings

  // --- caps ----------------------------------------------------------------
  // Not decoration. Thermal is an integrator with an unbounded input if any
  // system can be held on forever, and an uncapped integrator is a signature
  // that grows without bound — which the test list forbids and which would also
  // silently break every creature threshold by making them all trivially met.
  caps: {
    acoustic: 140.0,
    thermal: 400.0,
    photic: 60000.0,
    em: 120.0,
    wake: 12.0,
    relSpeed: 400.0,
  },

  // --- exposure normalisation ---------------------------------------------
  // See exposure(). These divisors are the anchor table's extremes, so a reading
  // of 1.0 means "as loud as this ship gets on this channel".
  exposureRef: {
    acoustic: 106.0,   // (dB - hullFloor) / this; 110 dB hull impact
    thermal: 130.0,    // boost
    photic: 40000.0,   // scan pulse; applied logarithmically, lumens span four decades
    em: 60.0,          // scan pulse
    wake: 4.0,         // boost
    // Boost, *not* cruise. This was 148 — the cruise value — which pegged the
    // relSpeed bar at 1.000 during ordinary flight and left it unable to report
    // the 60% of extra closing speed a boost actually adds. Every other divisor
    // here is a genuine extreme and this one now is too: 237 m/s is the flight
    // model's measured steady state at full boost.
    relSpeed: 237.0,
  },

  // --- sampling ------------------------------------------------------------
  // The medium is resampled every 4 steps (30 Hz) and interpolated between. At
  // 148 m/s the ship moves 4.9 m between samples and the density field's
  // smallest meaningful feature is far larger than that, so the error is below
  // the noise in the field itself and it removes three quarters of the cost.
  mediumPeriod: 4,
  mediumBlendRate: 20.0,
};

/** Trail shedding and decay. Contract §3.3 — every number here is from there. */
export const TRAIL = {
  wakeCap: 768,
  wakeShedHz: 4,
  thermalCap: 512,
  thermalShedHz: 2,

  // tauWake = 60 / (1 + 8u). Sampled at birth: the eddy's fate is decided by the
  // air it was torn in, and re-sampling turbulence every step for 768 parcels
  // would cost more than the entire creature AI budget.
  wakeTauBase: 60.0,
  wakeTauTurbGain: 8.0,

  // **The ambient turbulence floor, and why there is one.**
  //
  // `CloudSystem.flowAt` gates its turbulence output on density (`ρ > 0.02`), so
  // it reports *exactly* zero in clear air. Measured along five real 400 s cruise
  // paths at three altitudes (24 000 shed-rate samples): u is 0 on 92–95% of them,
  // and where it is non-zero it is properly graded — p05 0.09, p50 0.46–0.68,
  // p95 1.0. The field's gradient is fine. What it has no representation for is
  // ordinary air, and the contract does: §3.3's own worked consequences are
  // computed at u ≈ 0.05 for "still air" ("cruising in still air leaves a
  // followable wake for about 106 s" is 42.9·ln(0.6/0.05) = 106.6 s, and "boosting
  // in still air writes about three minutes" is 42.9·ln(4.0/0.05) = 188 s).
  //
  // Taking u = 0 literally gives τ = 60 s instead of 42.9, which stretches the
  // boost trail to 263 s — past the 192 s the 768-parcel cap can hold, which is
  // how the trail-truncation bug got in. Flooring u at the contract's own still-
  // air figure restores both the contract's numbers and its cap arithmetic, and
  // narrows the clear-air-to-cloud τ ratio from 9.0× to 6.4× against the 5.3×
  // the contract's two worked examples (u 0.05 and 0.8) imply. This is a floor
  // on a measured field, not a guessed normalisation: the constant is quoted
  // from §3.3 and the arithmetic it restores is §3.3's own.
  ambientTurb: 0.05,

  thermalTau: 55.0,          // a shed parcel cools faster than the hull does
  thermalRise: 0.8,          // m/s; after three minutes the trail is 144 m up
  // Contract §3.3: radius = 8 + 1.5·age. Note that §4.4's stimulus formula uses
  // the *receiver's* sense radius and not the parcel's, so this does not enter
  // detection — the contract is explicit about the falloff and it is receiver-
  // only. The radius is what the parcel *is*, so it is read by `eachThermal()`
  // for the trail instrument and the renderer, and by the test.
  thermalRadius0: 8.0,
  thermalRadiusGrowth: 1.5,  // m/s

  // A shed parcel carries a fraction of the hull's excess, not all of it.
  //
  // The corrected derivation. At the cruise anchor the hull sits at 40 ΔK, so a
  // parcel is 22.0 ΔK and reaches the Wake Hunter's 1.5 ΔK threshold after
  // 55·ln(22.0/1.5) = 147.6 s. The worst case is a boost hull at 130 ΔK: a 71.5 ΔK
  // parcel, cold after 55·ln(71.5/1.5) = 212.6 s, against the 256 s that 512
  // parcels at 2 Hz hold. The comment this replaces claimed 0.55 "is what makes a
  // cruising ship's thermal trail fall below 1.5 ΔK after 242 s", which is
  // arithmetically impossible — 242 s would need a hull at 222 ΔK — and it was
  // the stated basis for the 512-parcel cap, so it would have misled the next
  // person to resize it.
  thermalShedFraction: 0.55,

  // **Minimum spacing between parcels, in metres.** Contract §3.3 sheds on a
  // clock, and §4.4 sums every parcel inside the sense radius — so on a clock
  // alone, a ship that stops moving stacks its whole buffer on one point and a
  // drifting ship becomes the loudest thing in the game on the channel the
  // design promises drifting is silent on. Measured before this gate existed: a
  // station-keeping hull read 4.595 on the Wake Hunter's wake sense (92× its
  // threshold) against 1.011 at full cruise, and 572.7 ΔK on its thermal sense
  // against a hull that was actually at 11.9.
  //
  // The gate is the shedding *distance* at the cruise anchor — cruiseRel divided
  // by the shed rate — so cruise is unchanged by construction and everything
  // slower is spaced out instead of piled up. Below the gate the most recent
  // parcel is refreshed in place rather than duplicated, so the trail stays live
  // where the ship is loitering without accumulating. Filled in below the
  // literal because they are derived, not chosen.
  wakeSpacingM: 0,
  thermalSpacingM: 0,

  // A parcel above this in its own units is still a detection to somebody: the
  // Wake Hunter's thresholds, §10.3. `ParcelField` refuses to overwrite a parcel
  // stronger than the weakest one it holds, and counts any eviction above these
  // as a contract violation so the test can assert zero.
  wakeLiveThreshold: 0.05,
  thermalLiveThreshold: 1.5,

  // Cached flow per parcel, refreshed on a rota. Flow varies slowly in space —
  // it is three global advection winds plus a local convection term — so a
  // 2 s-old flow vector integrates to well under a parcel radius of error. The
  // failure this prevents is the honest one: 1280 parcels × 120 Hz × three
  // density evaluations per flowAt is 460k samples a second, which is the whole
  // 3 ms update budget spent on advecting smoke.
  flowRefreshSec: 2.0,
};

TRAIL.wakeSpacingM = SIG.cruiseRel / TRAIL.wakeShedHz;        // 37.0 m
TRAIL.thermalSpacingM = SIG.cruiseRel / TRAIL.thermalShedHz;  // 74.0 m

/** Recorder. Contract §3.4: 300 s at 2 Hz, six channels — plus position. */
export const RECORDER = { seconds: 300, hz: 2 };

const dbToPower = (db) => Math.pow(10, db * 0.1);
const powerToDb = (p) => 10 * Math.log10(Math.max(p, 1e-12));

// ---------------------------------------------------------------------------
// The emission bus
// ---------------------------------------------------------------------------

/**
 * What the ship's systems publish each step.
 *
 * A bus rather than a return value for two reasons. It is reused, so a system
 * that emits every step at 120 Hz does not allocate 120 objects a second into a
 * game whose worst enemy is a garbage-collection pause during an encounter. And
 * every contribution arrives with a label attached, which is what makes
 * `Signature.breakdown()` able to answer "why is my EM at 20" with a system name
 * instead of a number — the difference between Pillar 3 being kept and being
 * claimed.
 */
export class EmissionBus {
  constructor(capacity = 32) {
    this.records = [];
    this._grow(capacity);
    this.count = 0;
    this.highWater = 0;

    // Modifiers rather than emissions: a system that changes how the *hull*
    // behaves writes here. The emergency vent is the only current user and it is
    // the whole of its later cost.
    this.thermalGain = 1;
    this.thermalTauScale = 1;
    // **Fraction of hull heat vented per second**, not per step. Read `_thermal`
    // for why the distinction is the difference between a countermeasure and an
    // erasure.
    this.thermalVentRate = 0;
  }

  _grow(n) {
    for (let i = 0; i < n; i++) {
      this.records.push({
        label: '', acousticDb: 0, acousticCrackDb: 0, thermalKps: 0, thermalK: 0,
        photicLm: 0, emu: 0, wakeInv: 0, wakeImpulse: 0,
      });
    }
  }

  reset() {
    this.count = 0;
    this.thermalGain = 1;
    this.thermalTauScale = 1;
    this.thermalVentRate = 0;
  }

  /**
   * Publish one source's emission. Fields omitted are zero.
   *
   * `acousticDb` is a sustained sound *level* and goes through the machinery
   * lag; `acousticCrackDb` is an impulse and decays reverberantly. Mixing the
   * two would make a 96 dB scan pulse audible for forty seconds.
   *
   * The pool doubles rather than dropping. The version this replaces returned
   * null past a fixed 24 and left an unfinished sentence where its justification
   * should have been; an emission that vanishes without a trace is a signature
   * the player is being charged for and cannot see, which is the exact failure
   * Pillar 3 forbids. Doubling allocates once during the first frame a new
   * subsystem appears and never again, so the steady state is still zero
   * allocations per PERFORMANCE_BUDGET.md §141.
   */
  add(label, e) {
    if (this.count >= this.records.length) this._grow(this.records.length);
    const r = this.records[this.count++];
    if (this.count > this.highWater) this.highWater = this.count;
    r.label = label;
    r.acousticDb = e.acousticDb || 0;
    r.acousticCrackDb = e.acousticCrackDb || 0;
    r.thermalKps = e.thermalKps || 0;
    r.thermalK = e.thermalK || 0;
    r.photicLm = e.photicLm || 0;
    r.emu = e.emu || 0;
    r.wakeInv = e.wakeInv || 0;
    r.wakeImpulse = e.wakeImpulse || 0;
    return r;
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Five minutes of every channel, at 2 Hz, **and where the ship was**.
 *
 * Contract §3.4 is explicit that this is a player-facing instrument and not a
 * debug tool. When the player is found and asks why, this is the honest answer
 * available to them — *you ran the search lamp for forty seconds and something
 * with eyes was inside 1.5 km* — without exposing a single creature internal.
 * It is also what makes the acoustic sense implementable at all: a creature 3 km
 * away hears what the ship was emitting 9.1 seconds ago, and that value has to
 * still exist somewhere.
 *
 * Position is stored with it because transmission (§4.1) needs the distance and
 * the path from where the sound was *made*, and `creature.js`'s signature
 * adapter says so in as many words: "three more floats on a 14 KB buffer and it
 * is the difference between a detection that can be replayed and one that
 * cannot". Without it every acoustic detection is stamped `positionExact: false`
 * and is wrong by 1347 m at cruise for a 9.1 s latency. 600 × 9 × 4 = 21.6 KB.
 */
const REC_STRIDE = CHANNELS.length + 3;

export class SignatureRecorder {
  constructor({ seconds = RECORDER.seconds, hz = RECORDER.hz } = {}) {
    this.hz = hz;
    this.capacity = Math.round(seconds * hz);
    this.data = new Float32Array(this.capacity * REC_STRIDE);
    this.times = new Float32Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this._acc = 0;
    this._period = 1 / hz;
    this._out = { simTime: 0, x: 0, y: 0, z: 0 };
    for (const c of CHANNELS) this._out[c] = 0;
  }

  /** Called every step; writes only on the 2 Hz boundary. */
  update(dt, time, values, pos) {
    this._acc += dt;
    if (this._acc < this._period) return false;
    this._acc -= this._period;
    const base = this.head * REC_STRIDE;
    for (let i = 0; i < CHANNELS.length; i++) this.data[base + i] = values[CHANNELS[i]];
    const n = CHANNELS.length;
    this.data[base + n] = pos ? pos.x : 0;
    this.data[base + n + 1] = pos ? pos.y : 0;
    this.data[base + n + 2] = pos ? pos.z : 0;
    this.times[this.head] = time;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return true;
  }

  /** Oldest-first samples of one channel over the last `seconds`. */
  history(channel, seconds = RECORDER.seconds) {
    const ci = CHANNELS.indexOf(channel === undefined ? 'acoustic' : (CHANNEL_ALIASES[channel] || channel));
    if (ci < 0) return [];
    const want = Math.min(this.count, Math.round(seconds * this.hz));
    const out = new Array(want);
    for (let k = 0; k < want; k++) {
      const idx = (this.head - want + k + this.capacity * 2) % this.capacity;
      out[k] = this.data[idx * REC_STRIDE + ci];
    }
    return out;
  }

  /**
   * What the ship was emitting `ageSec` ago, all channels, and where it was.
   *
   * This is the acoustic sense's entry point, and the shape `createSignatureView`
   * in `creature.js` reads: top-level `x`/`y`/`z` make it stamp
   * `positionExact: true`. It returns null rather than clamping when asked for
   * something older than the buffer: a creature reading the present and
   * believing it to be the past would produce a detection that cannot be
   * explained, which contract §7 rates as the highest severity bug in the
   * project.
   *
   * The returned object is **reused**. Copy it if you keep it; `at()` is called
   * once per creature per sense tick and allocating there would put six objects
   * a second per creature into the nursery.
   */
  /**
   * What the ship was emitting `ageSec` ago, interpolated between samples.
   *
   * This used to be `Math.round(ageSec * hz)`, which snapped the read to the
   * nearest stored sample. At 2 Hz that is a half-second staircase, and it lands
   * directly on the one property §5.2 asks this system to have: a creature is
   * supposed to be reacting to something you did nine seconds ago, and a
   * quantised read makes the delay wrong by up to a quarter of a second in
   * either direction — measured, a burst 3006 m away arrived 0.6 s early, which
   * is two hundred metres of sound travel that never happened.
   *
   * Interpolating costs one extra read and removes the quantisation entirely,
   * which matters beyond this test: acoustic detection ranges are fitted against
   * exact transmission values, and feeding them a staircased source undoes some
   * of that precision for no reason.
   *
   * Position is interpolated too. It has to be — a source point that snaps
   * between half-second-apart ship positions at 100 m/s jumps fifty metres, and
   * the bearing a creature derives from it jumps with it.
   */
  at(ageSec) {
    const exact = ageSec * this.hz;
    const back = Math.floor(exact);
    const frac = exact - back;
    if (back < 0 || back >= this.count) return null;

    const idxA = (this.head - 1 - back + this.capacity * 2) % this.capacity;
    // The older neighbour. If there is none, fall back to no interpolation
    // rather than reading past the end of the history.
    const hasB = (back + 1) < this.count;
    const idxB = hasB ? (this.head - 2 - back + this.capacity * 2) % this.capacity : idxA;
    const t = hasB ? frac : 0;

    const a = idxA * REC_STRIDE, b = idxB * REC_STRIDE;
    const out = this._out;
    out.simTime = this.times[idxA] + (this.times[idxB] - this.times[idxA]) * t;
    for (let i = 0; i < CHANNELS.length; i++) {
      out[CHANNELS[i]] = this.data[a + i] + (this.data[b + i] - this.data[a + i]) * t;
    }
    const n = CHANNELS.length;
    out.x = this.data[a + n] + (this.data[b + n] - this.data[a + n]) * t;
    out.y = this.data[a + n + 1] + (this.data[b + n + 1] - this.data[a + n + 1]) * t;
    out.z = this.data[a + n + 2] + (this.data[b + n + 2] - this.data[a + n + 2]) * t;
    return out;
  }

  /** Floating origin: the stored positions are world points and must move too. */
  rebase(ox, oy, oz) {
    const n = CHANNELS.length;
    for (let k = 0; k < this.count; k++) {
      const base = k * REC_STRIDE;
      this.data[base + n] -= ox;
      this.data[base + n + 1] -= oy;
      this.data[base + n + 2] -= oz;
    }
  }

  reset() { this.head = 0; this.count = 0; this._acc = 0; }
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/**
 * Wake and thermal parcels, shed into the world and left there.
 *
 * Structure-of-arrays in typed buffers, not an array of objects. 1280 live
 * parcels touched every step is exactly the shape of workload that makes a
 * JavaScript game stutter every few seconds when the collector runs, and a
 * stutter as something passes is a broken encounter rather than a performance
 * problem (PERFORMANCE_BUDGET.md §1).
 */
class ParcelField {
  constructor(cap, liveThreshold, hasRadius = false) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.flow = new Float32Array(cap * 3);
    this.value0 = new Float32Array(cap);   // strength s⁻¹, or ΔK
    this.born = new Float32Array(cap);
    this.tau = new Float32Array(cap);
    this.hasRadius = hasRadius;
    this.liveThreshold = liveThreshold;
    this.count = 0;
    this.last = -1;
    /** Contract §12: "a parcel is never dropped while still above any creature's
     *  threshold". This counts the times that happened. It must stay 0. */
    this.droppedLive = 0;
    this.weakestEvicted = 0;
    this._flowCursor = 0;
    this._out = { x: 0, y: 0, z: 0, turbulence: 0 };
  }

  /**
   * Which slot the next parcel goes in.
   *
   * Not the ring's oldest. Contract §3.3 sizes the caps so that the oldest is
   * always also the coldest, but that guarantee depends on every parcel having
   * been born with a similar strength, and a boost parcel or a vented-heat decoy
   * is an order of magnitude above its neighbours. Overwriting the *weakest*
   * live parcel makes the §12 guarantee structural instead of arithmetic: the
   * only parcel that can ever be lost is the one nothing could detect anyway.
   * In steady flight the weakest is the oldest and this is exactly a ring.
   *
   * O(cap) at the shed rate — 768 × 4 Hz = 3072 comparisons a second — which is
   * three orders below the trail advection it sits next to.
   */
  _pick(time) {
    if (this.count < this.cap) return this.count++;
    let idx = 0, worst = Infinity;
    for (let i = 0; i < this.cap; i++) {
      const v = this.value0[i] * Math.exp(-(time - this.born[i]) / this.tau[i]);
      if (v < worst) { worst = v; idx = i; }
    }
    this.weakestEvicted = worst;
    if (worst > this.liveThreshold) this.droppedLive++;
    return idx;
  }

  shed(x, y, z, value, tau, time, medium) {
    const i = this._pick(time);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.value0[i] = value;
    this.born[i] = time;
    this.tau[i] = tau;
    if (medium) {
      medium.flowAt(x, y, z, this._out);
      this.flow[i * 3] = this._out.x;
      this.flow[i * 3 + 1] = this._out.y;
      this.flow[i * 3 + 2] = this._out.z;
    } else {
      this.flow[i * 3] = 0; this.flow[i * 3 + 1] = 0; this.flow[i * 3 + 2] = 0;
    }
    this.last = i;
    return i;
  }

  /**
   * Keep the most recent parcel current instead of shedding another one.
   *
   * What a loitering ship does. The disturbance at that point is *one* blob that
   * is being continuously renewed, not a stack of them, so the value is the
   * stronger of what is there and what is arriving, and the clock restarts.
   */
  refreshLast(value, time) {
    const i = this.last;
    if (i < 0 || i >= this.count) return -1;
    const decayed = this.value0[i] * Math.exp(-(time - this.born[i]) / this.tau[i]);
    this.value0[i] = Math.max(decayed, value);
    this.born[i] = time;
    return i;
  }

  /** Advect on the cached flow, and refresh a slice of that cache. */
  advect(dt, medium, rise, refreshPerStep) {
    const p = this.pos, f = this.flow;
    for (let i = 0; i < this.count; i++) {
      p[i * 3] += f[i * 3] * dt;
      p[i * 3 + 1] += (f[i * 3 + 1] + rise) * dt;
      p[i * 3 + 2] += f[i * 3 + 2] * dt;
    }
    if (!medium || this.count === 0) return;
    for (let n = 0; n < refreshPerStep; n++) {
      const i = this._flowCursor % this.count;
      this._flowCursor = (this._flowCursor + 1) % Math.max(this.count, 1);
      medium.flowAt(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], this._out);
      f[i * 3] = this._out.x; f[i * 3 + 1] = this._out.y; f[i * 3 + 2] = this._out.z;
    }
  }

  /** Contract §4.4: sum of parcel value × linear falloff, within the radius. */
  sample(x, y, z, radius, time) {
    if (this.count === 0) return 0;
    const inv = 1 / radius;
    const r2 = radius * radius;
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.pos[i * 3] - x, dy = this.pos[i * 3 + 1] - y, dz = this.pos[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const age = time - this.born[i];
      const v = this.value0[i] * Math.exp(-age / this.tau[i]);
      sum += v * (1 - Math.sqrt(d2) * inv);
    }
    return sum;
  }

  /** How many live parcels are inside a sense radius. For the test and the HUD. */
  countWithin(x, y, z, radius) {
    const r2 = radius * radius;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.pos[i * 3] - x, dy = this.pos[i * 3 + 1] - y, dz = this.pos[i * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz < r2) n++;
    }
    return n;
  }

  /** Strongest live parcel, for tests and for the trail instrument. */
  strongest(time) {
    let best = 0;
    for (let i = 0; i < this.count; i++) {
      const v = this.value0[i] * Math.exp(-(time - this.born[i]) / this.tau[i]);
      if (v > best) best = v;
    }
    return best;
  }

  /** Age of the oldest live parcel, and its value. Sizes the caps honestly. */
  oldest(time) {
    let age = 0, value = 0;
    for (let i = 0; i < this.count; i++) {
      const a = time - this.born[i];
      if (a > age) { age = a; value = this.value0[i] * Math.exp(-a / this.tau[i]); }
    }
    return { age, value };
  }

  /** Contract §3.3: radius = 8 + 1.5·age, for the thermal class only. */
  radiusAt(i, time) {
    if (!this.hasRadius) return 0;
    return TRAIL.thermalRadius0 + TRAIL.thermalRadiusGrowth * (time - this.born[i]);
  }

  /**
   * Every live parcel, for the renderer and the trail instrument. Zero-alloc:
   * the callback is handed loose numbers, not an object.
   * @param {(x:number,y:number,z:number,value:number,age:number,radius:number)=>void} fn
   */
  each(fn, time) {
    for (let i = 0; i < this.count; i++) {
      const age = time - this.born[i];
      fn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2],
        this.value0[i] * Math.exp(-age / this.tau[i]), age, this.radiusAt(i, time));
    }
  }

  rebase(ox, oy, oz) {
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] -= ox; this.pos[i * 3 + 1] -= oy; this.pos[i * 3 + 2] -= oz;
    }
  }

  reset() { this.count = 0; this.last = -1; this._flowCursor = 0; this.droppedLive = 0; }
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export class Signature {
  /**
   * @param {object}  opts
   * @param {object}  opts.medium  anything with `densityAt(x,y,z)` and
   *   `flowAt(x,y,z,out)`. `CloudSystem` satisfies this exactly, which is the
   *   point: the signature reads the same field the player is looking at, per
   *   Pillar 1. Omitting it gives clear, still air, which is what tests want.
   */
  constructor({ medium = null } = {}) {
    this.medium = medium;
    this.time = 0;
    this.timeSource = 'internal';
    this._step = 0;

    // --- channel state ---------------------------------------------------
    this.acoustic = SIG.hullFloorDb;
    this.thermal = 0;
    this.photic = 0;
    this.em = 0;
    this.wake = SIG.wakeFloorInv;
    this.relSpeed = 0;

    // Internal stores. Only the two channels that genuinely hold something have
    // one; see the header on why photic and em do not.
    this._sustainedPower = dbToPower(SIG.hullFloorDb);
    this._crackDb = 0;
    this._wakeSustained = SIG.wakeFloorInv;
    this._wakeImpulse = 0;
    this._ventPending = 0;
    this._tauThermal = SIG.thermalTau;

    // --- medium, sampled on a rota ---------------------------------------
    this.density = 0;
    this.turbulence = 0;
    this.flow = { x: 0, y: 0, z: 0 };
    this._flowSample = { x: 0, y: 0, z: 0, turbulence: 0 };
    this._densityTarget = 0;
    this._turbTarget = 0;

    // --- kinematics, published so systems can price their own emissions ---
    this.kin = { relSpeed: 0, q: 0, densityFactor: 1, strain: 0, sinSlip: 0, speed: 0 };

    this.bus = new EmissionBus();
    this.recorder = new SignatureRecorder();
    this.wakeTrail = new ParcelField(TRAIL.wakeCap, TRAIL.wakeLiveThreshold, false);
    this.thermalTrail = new ParcelField(TRAIL.thermalCap, TRAIL.thermalLiveThreshold, true);

    this._wakeShedAcc = 0;
    this._thermalShedAcc = 0;
    this._lastWakeShed = { x: 0, y: 0, z: 0, valid: false };
    this._lastThermalShed = { x: 0, y: 0, z: 0, valid: false };
    this._wakeRefresh = Math.max(1, Math.round(TRAIL.wakeCap / (TRAIL.flowRefreshSec * 120)));
    this._thermalRefresh = Math.max(1, Math.round(TRAIL.thermalCap / (TRAIL.flowRefreshSec * 120)));

    // Breakdown records, preallocated per channel for the same reason the bus is.
    this._parts = {};
    this._dom = {};
    for (const c of CHANNELS) {
      this._parts[c] = { count: 0, items: Array.from({ length: 24 }, () => ({ label: '', value: 0, share: 0 })) };
      this._dom[c] = { label: '', value: 0, share: 0 };
    }

    this._values = { acoustic: 0, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 };
    this._pos = { x: 0, y: 0, z: 0 };
  }

  // --- the brief's vocabulary -------------------------------------------
  get vibration() { return this.acoustic; }
  get heat() { return this.thermal; }
  get light() { return this.photic; }
  get flowMismatch() { return this.relSpeed; }

  _part(channel, label, value) {
    const p = this._parts[channel];
    if (value === 0) return;
    if (p.count >= p.items.length) {
      const n = p.items.length;
      for (let i = 0; i < n; i++) p.items.push({ label: '', value: 0, share: 0 });
    }
    const it = p.items[p.count++];
    it.label = label; it.value = value; it.share = 0;
  }

  _resetParts() { for (const c of CHANNELS) this._parts[c].count = 0; }

  /**
   * One simulation step.
   *
   * @param {number} dt      fixed step, 1/120
   * @param {object} ship    a `Flight`, or anything exposing the same telemetry:
   *   position, velocity, throttleSmoothed, boostSmoothed, slipAngle, gLoad
   * @param {object} systems a `ShipSystems`, or null for a bare hull
   * @param {number} [simTime] **the loop's `simTime`.** Pass it. The recorder
   *   stamps every sample with this clock and creature senses look emissions up
   *   by *age against sim time*; a signature constructed mid-session, or a
   *   `GAME.seek()`, silently offsets every acoustic detection by the difference
   *   if the two clocks are allowed to drift apart. Omitting it keeps a private
   *   clock, which is what the tests want and what a headless harness gets.
   */
  update(dt, ship, systems = null, simTime = null) {
    if (simTime !== null && simTime !== undefined) {
      this.time = simTime;
      this.timeSource = 'external';
    } else {
      this.time += dt;
    }
    this._step++;
    this._resetParts();

    this._sampleMedium(dt, ship);
    this._kinematics(ship);

    this.bus.reset();
    if (systems) systems.emit(this.bus, this.kin, ship, dt);

    this._acoustic(dt);
    this._thermal(dt);
    this._photic(ship);
    this._em();
    this._wake(dt);

    const v = this._values;
    v.acoustic = this.acoustic; v.thermal = this.thermal; v.photic = this.photic;
    v.em = this.em; v.wake = this.wake; v.relSpeed = this.relSpeed;

    this._shed(dt, ship);
    const p = ship.position;
    this._pos.x = p.x; this._pos.y = p.y; this._pos.z = p.z;
    this.recorder.update(dt, this.time, v, this._pos);
    return this;
  }

  _sampleMedium(dt, ship) {
    const p = ship.position;
    if (this.medium && this._step % SIG.mediumPeriod === 1) {
      this._densityTarget = this.medium.densityAt(p.x, p.y, p.z);
      this.medium.flowAt(p.x, p.y, p.z, this._flowSample);
      this._turbTarget = this._flowSample.turbulence;
    }
    // Blended rather than stepped, so a signature does not visibly stair-step at
    // 30 Hz on an instrument the player is watching at 120.
    const r = SIG.mediumBlendRate;
    this.density = approach(this.density, this._densityTarget, r, dt);
    this.turbulence = approach(this.turbulence, this._turbTarget, r, dt);
    this.flow.x = approach(this.flow.x, this._flowSample.x, r, dt);
    this.flow.y = approach(this.flow.y, this._flowSample.y, r, dt);
    this.flow.z = approach(this.flow.z, this._flowSample.z, r, dt);
  }

  /**
   * Everything downstream that depends on how the ship is moving through the
   * medium rather than through the world.
   *
   * `relSpeed` is the subtle one and it is contract §4.5: the ship's velocity
   * minus the local flow. A ship travelling at 140 m/s inside a current going
   * the same way is quiet on this channel; a ship holding station in that
   * current is screaming. It costs one subtraction and it is the reason drifting
   * is actively concealing rather than merely passive.
   */
  _kinematics(ship) {
    const vx = ship.velocity.x - this.flow.x;
    const vy = ship.velocity.y - this.flow.y;
    const vz = ship.velocity.z - this.flow.z;
    const rel = Math.hypot(vx, vy, vz);
    const k = this.kin;
    k.relSpeed = rel;
    k.speed = ship.velocity.length ? ship.velocity.length() : Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    // Dynamic-pressure-like, normalised so cruise is exactly 1.0. Every
    // speed-driven term uses this rather than a raw speed, so retuning cruise
    // moves them all together instead of leaving four of them behind.
    const u = rel / SIG.cruiseRel;
    k.q = u * u;
    k.densityFactor = clamp(1 + SIG.wakeDensityGain * this.density, 1, SIG.wakeDensityCap);
    k.strain = clamp((ship.gLoad || 0) / SIG.manoeuvreGRef, 0, SIG.manoeuvreStrainCap);
    k.sinSlip = Math.abs(Math.sin(ship.slipAngle || 0));
    this.relSpeed = clamp(rel, 0, SIG.caps.relSpeed);
    this._part('relSpeed', 'motion through the medium', this.relSpeed);
  }

  /**
   * Acoustic, in dB(V).
   *
   * Sources are summed as *powers* and converted once at the end. Two decay laws
   * because there are two physical mechanisms: sustained machinery noise is
   * power spinning down, which is exponential in power; a bang is reverberation,
   * which is linear in dB — the standard RT60 model. Running an impulse through
   * the machinery constant would leave a 110 dB hull strike audible for a minute.
   */
  _acoustic(dt) {
    let target = dbToPower(SIG.hullFloorDb);
    this._part('acoustic', 'hull', SIG.hullFloorDb);

    const strain = this.kin.strain;
    if (strain > 0.001) {
      const p = dbToPower(SIG.manoeuvreHardDb) * strain * strain;
      target += p;
      this._part('acoustic', 'airframe load', powerToDb(p));
    }

    let crack = 0;
    for (let i = 0; i < this.bus.count; i++) {
      const r = this.bus.records[i];
      if (r.acousticDb > 0) {
        target += dbToPower(r.acousticDb);
        this._part('acoustic', r.label, r.acousticDb);
      }
      if (r.acousticCrackDb > crack) crack = r.acousticCrackDb;
    }

    // Asymmetric: engines are quicker to spool up than to spool down, which is
    // what makes a moment of panic cost more seconds than it saves.
    const tau = target > this._sustainedPower ? SIG.acousticRiseTau : SIG.acousticFallTau;
    this._sustainedPower = approach(this._sustainedPower, target, 1 / tau, dt);

    if (crack > this._crackDb) this._crackDb = crack;
    this._crackDb = Math.max(0, this._crackDb - SIG.transientFallDbPerS * dt);

    let total = this._sustainedPower;
    // Below the hull floor a transient is inaudible by definition, and adding it
    // anyway would lift a powered-down ship off its 4 dB anchor.
    if (this._crackDb > SIG.hullFloorDb) {
      total += dbToPower(this._crackDb);
      this._part('acoustic', 'transient', this._crackDb);
    }
    this.acoustic = clamp(powerToDb(total), 0, SIG.caps.acoustic);
  }

  /**
   * Thermal, in ΔK above local ambient.
   *
   * The only true integrator in the system. Continuous sources are heat *rates*
   * in K/s and reach a steady state of rate × τ; one-shot events are deposits in
   * K. Keeping those separate matters: the scan's "+3 K pre-charge, +6 K pulse"
   * in the anchor table lasts 1.5 s and 0.2 s respectively, so treating them as
   * steady-state offsets would deliver about a fiftieth of the stated heat.
   *
   * **The vent is a rate, and it conserves.** `bus.thermalVentRate` is a fraction
   * of the hull's excess per *second*, and every joule it takes off the hull is
   * banked into `_ventPending` and shed into the world by `_shed`. The version
   * this replaces applied its fraction once per simulation *step* and shed
   * nothing: a system publishing 0.5 annihilated 99.98% of a settled 38.6 ΔK hull
   * in one second and left the thermal trail untouched. That is a countermeasure
   * with no cost, which Pillar 2 forbids and which this file's own doc on
   * `dumpHeat` says it forbids.
   */
  _thermal(dt) {
    // Cold dense vapour carries heat away faster than thin air. This is what
    // makes a dense bank a place to cool down as well as a place to hide, and it
    // is the reverse of the wake trade in the same air — which is the point.
    const tau = (SIG.thermalTau / (1 + SIG.thermalDensityCooling * this.density))
      * (this.bus.thermalTauScale || 1);
    this._tauThermal = tau;

    const gain = this.bus.thermalGain;
    let rate = 0;
    let deposit = 0;

    const strain = this.kin.strain;
    if (strain > 0.001) {
      const r = SIG.strainThermalKps * strain * strain;
      rate += r;
      this._part('thermal', 'airframe load', r * gain * tau);
    }

    for (let i = 0; i < this.bus.count; i++) {
      const r = this.bus.records[i];
      if (r.thermalKps !== 0) {
        rate += r.thermalKps;
        // Shown as the equilibrium each source is pulling the hull towards, in
        // K, because "the reactor is worth 12 K" is a sentence a player can act
        // on and "0.133 K/s" is not. The items therefore sum to the temperature
        // the ship is heading for, not the one it is at — which is the useful
        // question for a channel whose whole character is that it lags.
        this._part('thermal', r.label, r.thermalKps * gain * tau);
      }
      if (r.thermalK !== 0) {
        deposit += r.thermalK;
        this._part('thermal', `${r.label} (deposit)`, r.thermalK);
      }
    }
    rate *= gain;

    this.thermal += (rate - this.thermal / tau) * dt + deposit;
    this.thermal = clamp(this.thermal, 0, SIG.caps.thermal);

    const vent = this.bus.thermalVentRate;
    if (vent > 0 && this.thermal > 0) {
      const vented = this.thermal * (1 - Math.exp(-vent * dt));
      this.thermal -= vented;
      this._ventPending += vented;
      this._part('thermal', 'vent', -vented / dt * tau);
    }
  }

  /** Photic, in lumens. Field channel: no store, no lag. */
  _photic(ship) {
    let lm = 0;
    for (let i = 0; i < this.bus.count; i++) {
      const r = this.bus.records[i];
      if (r.photicLm !== 0) { lm += r.photicLm; this._part('photic', r.label, r.photicLm); }
    }
    const plume = SIG.plumeThrottleLm * (ship.throttleSmoothed || 0)
                + SIG.plumeBoostLm * (ship.boostSmoothed || 0);
    if (plume > 0) { lm += plume; this._part('photic', 'thruster plume', plume); }
    this.photic = clamp(lm, 0, SIG.caps.photic);
  }

  /** Electromagnetic, in EMU. Field channel; the scan capacitor is the only store
   *  and it lives in `ShipSystems`, because it is a piece of equipment. */
  _em() {
    let e = 0;
    const strain = this.kin.strain;
    if (strain > 0.001) {
      const a = SIG.strainEmu * strain;
      e += a;
      this._part('em', 'control actuators', a);
    }
    for (let i = 0; i < this.bus.count; i++) {
      const r = this.bus.records[i];
      if (r.emu !== 0) { e += r.emu; this._part('em', r.label, r.emu); }
    }
    this.em = clamp(e, 0, SIG.caps.em);
  }

  /**
   * Wake, in s⁻¹ of vorticity.
   *
   * Speed here is speed *through the medium*, not through the world, so a ship
   * riding a current tears almost nothing — the same subtraction that produces
   * relSpeed. Slip is the multiplier: a skidding ship presents its flank and
   * tears far more than a clean one at the same speed, which is what makes a
   * panicked turn expensive in a channel the player did not think they were
   * spending.
   */
  _wake(dt) {
    const k = this.kin;
    const df = k.densityFactor;

    let target = SIG.wakeFloorInv;
    this._part('wake', 'hull', SIG.wakeFloorInv * df);

    const passage = SIG.wakePassageInv * k.q;
    if (passage > 1e-4) { target += passage; this._part('wake', 'passage', passage * df); }

    const slip = SIG.wakeSlipInv * k.q * k.sinSlip;
    if (slip > 1e-4) { target += slip; this._part('wake', 'slip', slip * df); }

    let impulse = 0;
    for (let i = 0; i < this.bus.count; i++) {
      const r = this.bus.records[i];
      if (r.wakeInv !== 0) { target += r.wakeInv; this._part('wake', r.label, r.wakeInv * df); }
      if (r.wakeImpulse > impulse) impulse = r.wakeImpulse;
    }

    this._wakeSustained = approach(this._wakeSustained, target, 1 / SIG.wakeTau, dt);
    if (impulse > this._wakeImpulse) this._wakeImpulse = impulse;
    this._wakeImpulse *= Math.exp(-dt / SIG.wakeImpulseTau);
    if (this._wakeImpulse > 1e-4) this._part('wake', 'impact', this._wakeImpulse * df);

    this.wake = clamp((this._wakeSustained + this._wakeImpulse) * df, 0, SIG.caps.wake);
  }

  /**
   * Shed trail parcels. Contract §3.3.
   *
   * Field channels stop when the ship stops. These do not: cutting power silences
   * the acoustic, photic and EM channels inside a couple of seconds and does
   * nothing whatsoever about the last three minutes, which is the single most
   * important asymmetry in the game.
   *
   * Shedding is gated on **distance as well as time** — see `TRAIL.wakeSpacingM`
   * for the bug that gate exists to close. Below the gate the last parcel is
   * refreshed rather than duplicated, so a hovering ship leaves one live blob
   * where it is hovering instead of a buffer's worth stacked on one point.
   */
  _shed(dt, ship) {
    const p = ship.position;

    this._wakeShedAcc += dt;
    const wakePeriod = 1 / TRAIL.wakeShedHz;
    if (this._wakeShedAcc >= wakePeriod) {
      this._wakeShedAcc -= wakePeriod;
      // The eddy's fate is decided by the air it was torn in. Floored at the
      // contract's still-air figure; see TRAIL.ambientTurb.
      const u = Math.max(this.turbulence, TRAIL.ambientTurb);
      const tau = TRAIL.wakeTauBase / (1 + TRAIL.wakeTauTurbGain * u);
      const l = this._lastWakeShed;
      if (!l.valid || Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z) >= TRAIL.wakeSpacingM) {
        this.wakeTrail.shed(p.x, p.y, p.z, this.wake, tau, this.time, this.medium);
        l.x = p.x; l.y = p.y; l.z = p.z; l.valid = true;
      } else {
        this.wakeTrail.refreshLast(this.wake, this.time);
      }
    }

    this._thermalShedAcc += dt;
    const thermPeriod = 1 / TRAIL.thermalShedHz;
    if (this._thermalShedAcc >= thermPeriod) {
      this._thermalShedAcc -= thermPeriod;
      // The vented heat rides out with whatever is shed next, so it leaves the
      // hull and enters the world rather than leaving the simulation.
      const carried = this.thermal * TRAIL.thermalShedFraction + this._ventPending;
      this._ventPending = 0;
      const l = this._lastThermalShed;
      if (!l.valid || Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z) >= TRAIL.thermalSpacingM) {
        this.thermalTrail.shed(p.x, p.y, p.z, carried, TRAIL.thermalTau, this.time, this.medium);
        l.x = p.x; l.y = p.y; l.z = p.z; l.valid = true;
      } else {
        this.thermalTrail.refreshLast(carried, this.time);
      }
    }

    this.wakeTrail.advect(dt, this.medium, 0, this._wakeRefresh);
    this.thermalTrail.advect(dt, this.medium, TRAIL.thermalRise, this._thermalRefresh);
  }

  /**
   * Dump accumulated hull heat into the world as a decoy.
   *
   * The emergency vent's mechanism. The heat does not vanish — it is shed as a
   * cluster of stationary parcels behind the ship, so something following heat
   * arrives somewhere the ship no longer is. A countermeasure that deleted the
   * heat outright would be strictly better than not using it, which Pillar 2
   * forbids. The parcels carry the dumped heat exactly: `sum(parcel) == dumped`.
   */
  dumpHeat(fraction, ship, parcels = 6) {
    const dumped = this.thermal * clamp01(fraction);
    if (dumped <= 0) return 0;
    this.thermal -= dumped;
    const p = ship.position;
    const back = ship.forward ? ship.forward : { x: 0, y: 0, z: 0 };
    const each = dumped / parcels;
    for (let i = 0; i < parcels; i++) {
      const s = -20 - i * 14;
      this.thermalTrail.shed(
        p.x + back.x * s, p.y + back.y * s, p.z + back.z * s,
        each, TRAIL.thermalTau, this.time, this.medium);
    }
    return dumped;
  }

  /** A struck hull. Contract §3.2's last row: 110 dB(V) and +2.5 s⁻¹. */
  impact(severity = 1) {
    const s = clamp01(severity);
    this._crackDb = Math.max(this._crackDb, lerp(70, 110, s));
    this._wakeImpulse = Math.max(this._wakeImpulse, 2.5 * s);
  }

  // --- reading -----------------------------------------------------------

  /** All six, in contract units. The object is reused; copy it if you keep it. */
  values() { return this._values; }

  /**
   * Why each channel reads what it reads, right now.
   *
   * This is the requirement that keeps Pillar 3 honest: the relationships must
   * be learnable through consistent feedback, never hidden. The HUD renders this
   * directly. Acoustic shares are computed in the power domain — a 46 dB engine
   * beside an 18 dB reactor is 99.8% of the noise, not 72%, and showing the
   * ratio of the decibel numbers would teach the player something false.
   *
   * **This allocates.** One object per contributor plus a sort, by design: the
   * caller keeps the result and the preallocated records are overwritten next
   * step. Call it at the HUD's refresh rate — 10 Hz is plenty for a panel of
   * text — and never per frame, per PERFORMANCE_BUDGET.md §141. `dominant()`
   * below is the zero-allocation path for anything that only needs the largest.
   */
  breakdown(channel = null) {
    if (channel) {
      const key = CHANNEL_ALIASES[channel] || channel;
      const p = this._parts[key];
      if (!p) return [];
      const items = p.items.slice(0, p.count).map((it) => ({ ...it }));
      const inPower = key === 'acoustic';
      let total = 0;
      for (const it of items) total += inPower ? dbToPower(it.value) : Math.abs(it.value);
      for (const it of items) {
        it.share = total > 0 ? (inPower ? dbToPower(it.value) : Math.abs(it.value)) / total : 0;
      }
      items.sort((a, b) => b.share - a.share);
      return items;
    }
    const out = {};
    for (const c of CHANNELS) out[c] = this.breakdown(c);
    return out;
  }

  /**
   * The largest single contributor to a channel, or null. HUD shorthand.
   *
   * Zero-allocation: one linear scan of the preallocated records into a
   * per-channel reused result. Safe to call every frame for all six.
   */
  dominant(channel) {
    const key = CHANNEL_ALIASES[channel] || channel;
    const p = this._parts[key];
    if (!p || p.count === 0) return null;
    const inPower = key === 'acoustic';
    let total = 0, bestW = -1, best = -1;
    for (let i = 0; i < p.count; i++) {
      const w = inPower ? dbToPower(p.items[i].value) : Math.abs(p.items[i].value);
      total += w;
      if (w > bestW) { bestW = w; best = i; }
    }
    const out = this._dom[key];
    out.label = p.items[best].label;
    out.value = p.items[best].value;
    out.share = total > 0 ? bestW / total : 0;
    return out;
  }

  /**
   * A 0..1 readout per channel and a blended total.
   *
   * **This is a convenience for the instruments and nothing detects on it.**
   * Detection is per channel, after transmission, against a creature's own
   * threshold; a single scalar cannot represent that and must never be allowed
   * to, or the six-channel design collapses back into the stealth meter the
   * header warns about. It exists because the player needs one number to see
   * that cutting the engines helped, and because a test needs something to
   * assert about "total detectability".
   */
  exposure() {
    const r = SIG.exposureRef;
    const per = {
      acoustic: clamp01((this.acoustic - SIG.hullFloorDb) / r.acoustic),
      thermal: clamp01(this.thermal / r.thermal),
      // Lumens span four decades between instrument glow and a scan flash, so a
      // linear bar would show nav lights and the search lamp as the same nothing.
      photic: clamp01(Math.log10(1 + this.photic) / Math.log10(1 + r.photic)),
      em: clamp01(this.em / r.em),
      wake: clamp01(this.wake / r.wake),
      relSpeed: clamp01(this.relSpeed / r.relSpeed),
    };
    let sum = 0, worst = null, worstV = -1;
    for (const c of CHANNELS) {
      sum += per[c];
      if (per[c] > worstV) { worstV = per[c]; worst = c; }
    }
    return { per, total: sum / CHANNELS.length, worst, worstValue: worstV };
  }

  /** Contract §4.4, the trail-channel stimulus at a receiver. */
  sampleWake(x, y, z, radius) { return this.wakeTrail.sample(x, y, z, radius, this.time); }
  sampleThermal(x, y, z, radius) { return this.thermalTrail.sample(x, y, z, radius, this.time); }

  /** Every live parcel, for the renderer and the trail instrument. Zero-alloc. */
  eachWake(fn) { this.wakeTrail.each(fn, this.time); }
  eachThermal(fn) { this.thermalTrail.each(fn, this.time); }

  /** For the trail instrument and for the parcel-cap test in §12. */
  trailStats() {
    const ow = this.wakeTrail.oldest(this.time);
    const ot = this.thermalTrail.oldest(this.time);
    return {
      wakeParcels: this.wakeTrail.count,
      thermalParcels: this.thermalTrail.count,
      wakeStrongest: this.wakeTrail.strongest(this.time),
      thermalStrongest: this.thermalTrail.strongest(this.time),
      wakeOldestAge: ow.age, wakeOldestValue: ow.value,
      thermalOldestAge: ot.age, thermalOldestValue: ot.value,
      // §12: "a parcel is never dropped while still above any creature's
      // threshold". Both of these must be 0 in any run.
      wakeDroppedLive: this.wakeTrail.droppedLive,
      thermalDroppedLive: this.thermalTrail.droppedLive,
      thermalTau: this._tauThermal,
    };
  }

  history(channel, seconds) { return this.recorder.history(channel, seconds); }

  /** Floating origin. Parcels are in world space and must move with everything else. */
  rebase(offset) {
    this.wakeTrail.rebase(offset.x, offset.y, offset.z);
    this.thermalTrail.rebase(offset.x, offset.y, offset.z);
    this.recorder.rebase(offset.x, offset.y, offset.z);
    const a = this._lastWakeShed, b = this._lastThermalShed;
    a.x -= offset.x; a.y -= offset.y; a.z -= offset.z;
    b.x -= offset.x; b.y -= offset.y; b.z -= offset.z;
  }

  /** One readable line per channel. The console version of the HUD. */
  report() {
    const out = {};
    for (const c of CHANNELS) {
      const d = this.dominant(c);
      out[c] = `${this[c].toFixed(c === 'photic' ? 0 : 2)} ${CHANNEL_UNITS[c]}` +
        (d ? `  (${d.label} ${(d.share * 100).toFixed(0)}%)` : '');
    }
    out.exposure = this.exposure().total.toFixed(3);
    return out;
  }

  /** Back to a cold hull. For tests, and for a restart. */
  reset() {
    this.time = 0; this._step = 0;
    this.acoustic = SIG.hullFloorDb; this.thermal = 0; this.photic = 0;
    this.em = 0; this.wake = SIG.wakeFloorInv; this.relSpeed = 0;
    this._sustainedPower = dbToPower(SIG.hullFloorDb);
    this._crackDb = 0; this._wakeSustained = SIG.wakeFloorInv; this._wakeImpulse = 0;
    this._ventPending = 0;
    this.density = 0; this.turbulence = 0;
    this._densityTarget = 0; this._turbTarget = 0;
    this.wakeTrail.reset(); this.thermalTrail.reset(); this.recorder.reset();
    this._wakeShedAcc = 0; this._thermalShedAcc = 0;
    this._lastWakeShed.valid = false; this._lastThermalShed.valid = false;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Ship systems — the things that emit
// ---------------------------------------------------------------------------

/**
 * Every emitter's published output, solved from the anchor table.
 *
 * These are not free parameters. Each one is an anchor row minus the assembler's
 * own hull terms, and the derivation is written beside it so that the next person
 * to change an anchor knows which number moves. All in clear air, ρ = 0, where
 * the anchors are quoted.
 */
export const SHIP_SYSTEMS = {
  // Row 2 (systems idle) minus row 1 (powered down).
  //   acoustic: 10^1.8 − 10^0.4 = 63.10 − 2.51 = 60.59 → 17.82 dB
  //   thermal:  12 ΔK steady = rate × 90 → 0.13333 K/s
  //   em:       1.0 by definition — contract §3.1 defines EMU so reactor idle is 1
  //   wake:     0.05 − 0.02 hull floor = 0.03
  reactor: { acousticDb: 17.82, thermalKps: 0.133333, emu: 1.0, wakeInv: 0.03 },

  // Row 2's 3 lm, less the plume (zero at idle). Instruments are never off: a
  // shuttered cockpit is contract row 1, which is a different ship state.
  instruments: { photicLm: 2.95 },

  // Row 3 (cruise) minus row 2, at throttle 1.
  //   acoustic: 10^4.6 = 39811 → 46.00 dB
  //   thermal:  (40 − 12) / 90 = 0.31111 K/s
  //   em:       2.2 − 1.0 = 1.2
  //   wake:     0.60 − 0.05 − 0.55·q(=1) = 0, the passage term covers it
  engineCruise: { acousticDb: 46.0, thermalKps: 0.311111, emu: 1.2, wakeInv: 0.0 },

  // Row 5 (boost). q = (237.0/148.0)² = 2.5652, so passage alone gives 1.411.
  //   acoustic: 10^7.8 → 78.00 dB
  //   thermal:  (130 − 12) / 90 = 1.31111 K/s
  //   em:       7.5 − 1.0 = 6.5
  //   wake:     4.0 − 0.02 − 0.03 − 1.411 = 2.539
  engineBoost: { acousticDb: 78.0, thermalKps: 1.311111, emu: 6.5, wakeInv: 2.539 },

  // Rows 6 and 7, verbatim. The search lamp's "+2 ΔK" is a steady state, so it
  // is a rate of 2/90 K/s and the hull takes a couple of minutes to get there —
  // which means switching the lamp off does not make you cold, it makes you dark.
  navLights: { photicLm: 1200, emu: 0.1 },
  searchLamp: { photicLm: 9000, emu: 0.4, thermalKps: 0.022222 },

  // Rows 8 and 9. Both thermal figures are *deposits over the phase*, not steady
  // states: the pre-charge lasts 1.5 s and the pulse 0.2 s against a 90 s thermal
  // constant, so a steady-state reading of "+3" would deliver 0.05 ΔK and the
  // anchor would be off by a factor of sixty.
  scan: {
    chargeSec: 1.5,
    chargeEmu: 20.0,          // ramps 0 → 20 across chargeSec
    chargeThermalKps: 2.0,    // 3 ΔK over 1.5 s
    pulseSec: 0.2,
    pulseAcousticDb: 96.0,    // a crack, not a level — see EmissionBus.add
    pulseLm: 40000.0,
    pulseEmu: 60.0,
    pulseThermalKps: 30.0,    // 6 ΔK over 0.2 s
  },
};

/**
 * How a `LightRig` light maps onto the photic and EM channels.
 *
 * Keyed by the rig's `key`, so the *state* of a lamp has exactly one home — the
 * renderer, which is what the player is looking at — and the *units* have
 * exactly one home, the contract table. `lights.js` already makes the point that
 * the signature number "has to be the same number the renderer is drawing with
 * or the player will learn to distrust it"; its own `signature()` returns
 * intensity × colour, which is a shader quantity and not lumens, so the shared
 * quantity is on/off and the conversion lives here.
 */
export const LIGHT_EMISSIONS = {
  'ship/nav': SHIP_SYSTEMS.navLights,
  'ship/lamp': SHIP_SYSTEMS.searchLamp,
};

const SCAN_IDLE = 'idle', SCAN_CHARGE = 'charging', SCAN_PULSE = 'pulse';

/**
 * The ship's emitters.
 *
 * This is the half of the signature system the player operates. Every switch on
 * it costs something on at least one channel and there is no configuration that
 * is quiet on all six — that is Pillar 2, and the anchor test asserts it by
 * sweeping the throttle and checking all six move the same way.
 *
 * It holds the one channel store the assembler deliberately does not: the scan
 * capacitor. EM is a field channel and stops the instant the ship stops
 * emitting, so a capacitor that visibly charges for a second and a half before
 * it fires cannot be a property of the channel — it is a property of a piece of
 * equipment, and it lives with the equipment. Contract §3.2's note is the reason
 * it matters: "an electromagnetic sense sees the intention to scan from about
 * 6 km away and the pulse itself from 10 km. Scanning announces itself twice."
 */
export class ShipSystems {
  constructor({ lightRig = null, lightMap = LIGHT_EMISSIONS } = {}) {
    /** Master power. Cutting the reactor is the powered-down anchor, row 1. */
    this.reactor = true;
    /** Engines respond to the ship's own throttle; this is the kill switch. */
    this.engines = true;
    this.instruments = true;
    this.navLights = false;
    this.searchLamp = false;

    this.scanState = SCAN_IDLE;
    this.scanT = 0;

    /** Fraction of hull heat vented per second. `Signature` conserves it. */
    this.ventRate = 0;

    this._rig = null;
    this._map = lightMap;
    this._resolved = null;
    if (lightRig) this.bindLightRig(lightRig, lightMap);

    // Reused so `emit` allocates nothing.
    this._e = { acousticDb: 0, acousticCrackDb: 0, thermalKps: 0, thermalK: 0, photicLm: 0, emu: 0, wakeInv: 0 };
  }

  /**
   * Take lamp on/off state from a `LightRig` instead of from this object.
   *
   * Duck-typed on purpose: anything exposing a `lights` map of objects with
   * `key` and `on` works, and this module does not import the renderer.
   */
  bindLightRig(rig, map = this._map) {
    this._rig = rig;
    this._map = map;
    this._resolved = null;
    return this;
  }

  _lightOn(key, fallback) {
    if (!this._rig) return fallback;
    if (!this._resolved) {
      this._resolved = new Map();
      const lights = this._rig.lights;
      if (lights && typeof lights.values === 'function') {
        for (const l of lights.values()) if (l && l.key) this._resolved.set(l.key, l);
      }
    }
    const l = this._resolved.get(key);
    return l ? !!l.on : fallback;
  }

  /** Fire a scan. Ignored while one is already running. Contract §3.2 rows 8–9. */
  scan() {
    if (this.scanState !== SCAN_IDLE) return false;
    this.scanState = SCAN_CHARGE;
    this.scanT = 0;
    return true;
  }

  /** Abort a charging scan. The capacitor bleeds down instantly; EM is a field. */
  abortScan() {
    if (this.scanState === SCAN_CHARGE) { this.scanState = SCAN_IDLE; this.scanT = 0; return true; }
    return false;
  }

  get scanning() { return this.scanState !== SCAN_IDLE; }

  /** Cut everything. Anchor row 1: the ship is a hull with a person in it. */
  powerDown() {
    this.reactor = false; this.engines = false; this.instruments = false;
    this.navLights = false; this.searchLamp = false;
    this.scanState = SCAN_IDLE; this.scanT = 0; this.ventRate = 0;
    return this;
  }

  /**
   * Publish this step's emissions.
   *
   * @param {EmissionBus} bus
   * @param {object} kin   `Signature.kin` — relSpeed, q, densityFactor, strain, sinSlip
   * @param {object} ship  throttleSmoothed / boostSmoothed are the only fields read
   * @param {number} dt    fixed step, for the capacitor's own clock
   */
  emit(bus, kin, ship, dt = 1 / 120) {
    const e = this._e;
    const zero = () => {
      e.acousticDb = 0; e.acousticCrackDb = 0; e.thermalKps = 0; e.thermalK = 0;
      e.photicLm = 0; e.emu = 0; e.wakeInv = 0;
    };

    if (this.reactor) {
      const r = SHIP_SYSTEMS.reactor;
      zero();
      e.acousticDb = r.acousticDb; e.thermalKps = r.thermalKps; e.emu = r.emu; e.wakeInv = r.wakeInv;
      bus.add('reactor', e);
    }

    if (this.instruments && this.reactor) {
      zero();
      e.photicLm = SHIP_SYSTEMS.instruments.photicLm;
      bus.add('instruments', e);
    }

    // --- engine ------------------------------------------------------------
    // Acoustic power scales as throttle⁴, and that exponent is derived rather
    // than dialled. Steady speed in this flight model is sqrt(thrust·throttle /
    // drag), so U ∝ √throttle; Lighthill's eighth-power law makes jet acoustic
    // power ∝ U⁸, hence ∝ throttle⁴. The consequence is the one the design
    // needs: half throttle is 12 dB below cruise — a factor of 16 in power — so
    // easing off is a real lever rather than something that only pays at zero.
    // Heat, EM and the plume's wake are burn-rate quantities and scale linearly.
    if (this.engines && this.reactor) {
      const t = clamp01(ship.throttleSmoothed || 0);
      const b = clamp01(ship.boostSmoothed || 0);
      if (t > 0.001) {
        const A = SHIP_SYSTEMS.engineCruise, B = SHIP_SYSTEMS.engineBoost;
        const t4 = t * t * t * t;
        const pw = lerp(dbToPower(A.acousticDb), dbToPower(B.acousticDb), b) * t4;
        zero();
        e.acousticDb = powerToDb(pw);
        e.thermalKps = lerp(A.thermalKps, B.thermalKps, b) * t;
        e.emu = lerp(A.emu, B.emu, b) * t;
        e.wakeInv = lerp(A.wakeInv, B.wakeInv, b) * t;
        bus.add('engine', e);
      }
    }

    // --- lights ------------------------------------------------------------
    if (this.reactor && this._lightOn('ship/nav', this.navLights)) {
      const n = this._map['ship/nav'] || SHIP_SYSTEMS.navLights;
      zero();
      e.photicLm = n.photicLm || 0; e.emu = n.emu || 0; e.thermalKps = n.thermalKps || 0;
      bus.add('nav lights', e);
    }
    if (this.reactor && this._lightOn('ship/lamp', this.searchLamp)) {
      const s = this._map['ship/lamp'] || SHIP_SYSTEMS.searchLamp;
      zero();
      e.photicLm = s.photicLm || 0; e.emu = s.emu || 0; e.thermalKps = s.thermalKps || 0;
      bus.add('search lamp', e);
    }

    // --- scan capacitor ----------------------------------------------------
    if (this.scanState !== SCAN_IDLE && this.reactor) {
      const S = SHIP_SYSTEMS.scan;
      this.scanT += dt;
      if (this.scanState === SCAN_CHARGE) {
        zero();
        e.emu = S.chargeEmu * clamp01(this.scanT / S.chargeSec);
        e.thermalKps = S.chargeThermalKps;
        bus.add('scan capacitor', e);
        if (this.scanT >= S.chargeSec) { this.scanState = SCAN_PULSE; this.scanT = 0; }
      } else {
        zero();
        e.emu = S.pulseEmu;
        e.photicLm = S.pulseLm;
        e.acousticCrackDb = S.pulseAcousticDb;
        e.thermalKps = S.pulseThermalKps;
        bus.add('scan pulse', e);
        if (this.scanT >= S.pulseSec) { this.scanState = SCAN_IDLE; this.scanT = 0; }
      }
    } else if (this.scanState !== SCAN_IDLE) {
      this.scanState = SCAN_IDLE; this.scanT = 0;
    }

    // --- vent --------------------------------------------------------------
    // A modifier, not an emission: it changes what the hull does with the heat
    // it has. `Signature._thermal` banks every kelvin of it into the trail.
    bus.thermalVentRate = this.reactor ? this.ventRate : 0;

    return bus;
  }

  /** What is switched on, for the HUD and for a report. */
  state() {
    return {
      reactor: this.reactor,
      engines: this.engines,
      instruments: this.instruments,
      navLights: this._lightOn('ship/nav', this.navLights),
      searchLamp: this._lightOn('ship/lamp', this.searchLamp),
      scan: this.scanState,
      scanT: this.scanT,
      ventRate: this.ventRate,
    };
  }
}

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
// file and the contract disagree the contract is right. `tests/signature.js`
// asserts every anchor.
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
// The interesting consequence of the acoustic constant is worth stating because
// it was not designed in, it fell out: a full power-down from cruise takes 15 s
// to fall below the Listener's 16 dB(V) threshold and 21 s to reach the hull
// floor. The Listener's silent listening window is 18–26 s. You cannot start
// going quiet when it goes quiet. You have to have started already.

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
 * `tests/signature.js` meaningless.
 */
export const SIG = {
  // --- reference kinematics ------------------------------------------------
  // The flight model's steady state at full main throttle: thrustMain 46 m/s²
  // against dragForward 0.0021 gives sqrt(46/0.0021) = 148.0 m/s. Cruise in the
  // anchor table means this. Boost gives sqrt(118/0.0021) = 237.0 m/s, so the
  // dynamic-pressure ratio q between boost and cruise is 2.56 and every
  // speed-driven term inherits it rather than being tuned twice.
  cruiseRel: 148.0,

  // --- acoustic, dB(V) -----------------------------------------------------
  // Combined in the power domain, never by adding decibels. Adding decibels is
  // the single most common unit error in game audio code and it silently makes
  // two quiet sources louder than one loud one.
  hullFloorDb: 4.0,          // creak and airflow over a dead hull; anchor row 1
  manoeuvreHardDb: 50.7,     // at strain 1.0; puts hard-turn-at-cruise on 52 dB
  manoeuvreGRef: 36.0,       // m/s² of lateral+vertical load that means strain 1
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

  // --- wake, s⁻¹ -----------------------------------------------------------
  // Every wake term is multiplied by the density factor, because wake is not a
  // thing the ship has, it is a thing the ship does to the vapour, and there has
  // to be vapour to do it to.
  wakeFloorInv: 0.02,        // hull adrift; anchor row 1
  wakePassageInv: 0.55,      // × q; puts cruise on 0.60 with the reactor's 0.03
  wakeSlipInv: 4.0,          // × q × sin(slip); hard turn at slip 0.30 rad → 1.78
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
    acoustic: 106.0,   // (dB - hullFloor) / this
    thermal: 130.0,
    photic: 40000.0,   // applied logarithmically; lumens span four decades
    em: 60.0,
    wake: 4.0,
    relSpeed: 148.0,
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

  thermalTau: 55.0,          // a shed parcel cools faster than the hull does
  thermalRise: 0.8,          // m/s; after three minutes the trail is 144 m up
  thermalRadius0: 8.0,
  thermalRadiusGrowth: 1.5,  // m/s

  // A shed parcel carries a fraction of the hull's excess, not all of it. 0.55
  // is not free choice: it is what makes a cruising ship's thermal trail fall
  // below the Wake Hunter's 1.5 ΔK threshold after 242 s, against the contract's
  // own statement that the longest usable thermal trail is about 245 s. The
  // buffer cap of 512 at 2 Hz was sized from that number, so getting this
  // fraction wrong would silently truncate trails or waste memory.
  thermalShedFraction: 0.55,

  // Cached flow per parcel, refreshed on a rota. Flow varies slowly in space —
  // it is three global advection winds plus a local convection term — so a
  // 2 s-old flow vector integrates to well under a parcel radius of error. The
  // failure this prevents is the honest one: 1280 parcels × 120 Hz × three
  // density evaluations per flowAt is 460k samples a second, which is the whole
  // 3 ms update budget spent on advecting smoke.
  flowRefreshSec: 2.0,
};

/** Recorder. Contract §3.4: 300 s at 2 Hz, six channels — 600 × 6 × 4 = 14.4 KB. */
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
  constructor(capacity = 24) {
    this.records = [];
    for (let i = 0; i < capacity; i++) {
      this.records.push({
        label: '', acousticDb: 0, acousticCrackDb: 0, thermalKps: 0, thermalK: 0,
        photicLm: 0, emu: 0, wakeInv: 0, wakeImpulse: 0,
      });
    }
    this.count = 0;

    // Modifiers rather than emissions: a system that changes how the *hull*
    // behaves writes here. The emergency vent is the only current user and it is
    // the whole of its later cost.
    this.thermalGain = 1;
    this.thermalTauScale = 1;
    this.thermalDumpFraction = 0;
  }

  reset() {
    this.count = 0;
    this.thermalGain = 1;
    this.thermalTauScale = 1;
    this.thermalDumpFraction = 0;
  }

  /**
   * Publish one source's emission. Fields omitted are zero.
   *
   * `acousticDb` is a sustained sound *level* and goes through the machinery
   * lag; `acousticCrackDb` is an impulse and decays reverberantly. Mixing the
   * two would make a 96 dB scan pulse audible for forty seconds.
   */
  add(label, e) {
    if (this.count >= this.records.length) return null;   // silently dropping is
    const r = this.records[this.count++];                 // worse than not adding
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
 * Five minutes of every channel, at 2 Hz.
 *
 * Contract §3.4 is explicit that this is a player-facing instrument and not a
 * debug tool. When the player is found and asks why, this is the honest answer
 * available to them — *you ran the search lamp for forty seconds and something
 * with eyes was inside 1.5 km* — without exposing a single creature internal.
 * It is also what makes the acoustic sense implementable at all: a creature 3 km
 * away hears what the ship was emitting 9.1 seconds ago, and that value has to
 * still exist somewhere.
 */
export class SignatureRecorder {
  constructor({ seconds = RECORDER.seconds, hz = RECORDER.hz } = {}) {
    this.hz = hz;
    this.capacity = Math.round(seconds * hz);
    this.data = new Float32Array(this.capacity * CHANNELS.length);
    this.times = new Float32Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this._acc = 0;
    this._period = 1 / hz;
  }

  /** Called every step; writes only on the 2 Hz boundary. */
  update(dt, time, values) {
    this._acc += dt;
    if (this._acc < this._period) return false;
    this._acc -= this._period;
    const base = this.head * CHANNELS.length;
    for (let i = 0; i < CHANNELS.length; i++) this.data[base + i] = values[CHANNELS[i]];
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
      out[k] = this.data[idx * CHANNELS.length + ci];
    }
    return out;
  }

  /**
   * What the ship was emitting `ageSec` ago, all channels.
   *
   * This is the acoustic sense's entry point. It returns null rather than
   * clamping when asked for something older than the buffer: a creature reading
   * the present and believing it to be the past would produce a detection that
   * cannot be explained, which contract §7 rates as the highest severity bug in
   * the project.
   */
  at(ageSec) {
    const back = Math.round(ageSec * this.hz);
    if (back >= this.count || back < 0) return null;
    const idx = (this.head - 1 - back + this.capacity * 2) % this.capacity;
    const base = idx * CHANNELS.length;
    const out = { simTime: this.times[idx] };
    for (let i = 0; i < CHANNELS.length; i++) out[CHANNELS[i]] = this.data[base + i];
    return out;
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
  constructor(cap, hasRadius) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.flow = new Float32Array(cap * 3);
    this.value0 = new Float32Array(cap);   // strength s⁻¹, or ΔK
    this.born = new Float32Array(cap);
    this.tau = new Float32Array(cap);
    this.hasRadius = hasRadius;
    this.head = 0;
    this.count = 0;
    this._flowCursor = 0;
    this._out = { x: 0, y: 0, z: 0, turbulence: 0 };
  }

  shed(x, y, z, value, tau, time, medium) {
    const i = this.head;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.value0[i] = value;
    this.born[i] = time;
    this.tau[i] = tau;
    if (medium) {
      medium.flowAt(x, y, z, this._out);
      this.flow[i * 3] = this._out.x;
      this.flow[i * 3 + 1] = this._out.y;
      this.flow[i * 3 + 2] = this._out.z;
    }
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
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

  /** Strongest live parcel, for tests and for the trail instrument. */
  strongest(time) {
    let best = 0;
    for (let i = 0; i < this.count; i++) {
      const v = this.value0[i] * Math.exp(-(time - this.born[i]) / this.tau[i]);
      if (v > best) best = v;
    }
    return best;
  }

  rebase(ox, oy, oz) {
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] -= ox; this.pos[i * 3 + 1] -= oy; this.pos[i * 3 + 2] -= oz;
    }
  }

  reset() { this.head = 0; this.count = 0; this._flowCursor = 0; }
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
    this.wakeTrail = new ParcelField(TRAIL.wakeCap, false);
    this.thermalTrail = new ParcelField(TRAIL.thermalCap, true);

    this._wakeShedAcc = 0;
    this._thermalShedAcc = 0;
    this._wakeRefresh = Math.max(1, Math.round(TRAIL.wakeCap / (TRAIL.flowRefreshSec * 120)));
    this._thermalRefresh = Math.max(1, Math.round(TRAIL.thermalCap / (TRAIL.flowRefreshSec * 120)));

    // Breakdown records, preallocated per channel for the same reason the bus is.
    this._parts = {};
    for (const c of CHANNELS) {
      this._parts[c] = { count: 0, items: Array.from({ length: 20 }, () => ({ label: '', value: 0, share: 0 })) };
    }

    this._values = { acoustic: 0, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 };
  }

  // --- the brief's vocabulary -------------------------------------------
  get vibration() { return this.acoustic; }
  get heat() { return this.thermal; }
  get light() { return this.photic; }
  get flowMismatch() { return this.relSpeed; }

  _part(channel, label, value) {
    const p = this._parts[channel];
    if (p.count >= p.items.length || value === 0) return;
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
   */
  update(dt, ship, systems = null) {
    this.time += dt;
    this._step++;
    this._resetParts();

    this._sampleMedium(dt, ship);
    this._kinematics(ship);

    this.bus.reset();
    if (systems) systems.emit(this.bus, this.kin, ship);

    this._acoustic(dt);
    this._thermal(dt);
    this._photic(ship);
    this._em();
    this._wake(dt);

    const v = this._values;
    v.acoustic = this.acoustic; v.thermal = this.thermal; v.photic = this.photic;
    v.em = this.em; v.wake = this.wake; v.relSpeed = this.relSpeed;

    this._shed(dt, ship);
    this.recorder.update(dt, this.time, v);
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

    if (this.bus.thermalDumpFraction > 0) {
      this.thermal *= (1 - clamp01(this.bus.thermalDumpFraction));
    }

    this.thermal += (rate - this.thermal / tau) * dt + deposit;
    this.thermal = clamp(this.thermal, 0, SIG.caps.thermal);
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
   */
  _shed(dt, ship) {
    const p = ship.position;
    this._wakeShedAcc += dt;
    const wakePeriod = 1 / TRAIL.wakeShedHz;
    if (this._wakeShedAcc >= wakePeriod) {
      this._wakeShedAcc -= wakePeriod;
      const tau = TRAIL.wakeTauBase / (1 + TRAIL.wakeTauTurbGain * this.turbulence);
      this.wakeTrail.shed(p.x, p.y, p.z, this.wake, tau, this.time, this.medium);
    }

    this._thermalShedAcc += dt;
    const thermPeriod = 1 / TRAIL.thermalShedHz;
    if (this._thermalShedAcc >= thermPeriod) {
      this._thermalShedAcc -= thermPeriod;
      this.thermalTrail.shed(p.x, p.y, p.z, this.thermal * TRAIL.thermalShedFraction,
        TRAIL.thermalTau, this.time, this.medium);
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
   * forbids.
   */
  dumpHeat(fraction, ship, parcels = 6) {
    const dumped = this.thermal * clamp01(fraction);
    if (dumped <= 0) return 0;
    this.thermal -= dumped;
    const p = ship.position;
    const back = ship.forward ? ship.forward : { x: 0, y: 0, z: 0 };
    for (let i = 0; i < parcels; i++) {
      const s = -20 - i * 14;
      this.thermalTrail.shed(
        p.x + back.x * s, p.y + back.y * s, p.z + back.z * s,
        (dumped * TRAIL.thermalShedFraction * 1.6) / parcels,
        TRAIL.thermalTau, this.time, this.medium);
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

  /** The largest single contributor to a channel, or null. HUD shorthand. */
  dominant(channel) {
    const b = this.breakdown(channel);
    return b.length ? b[0] : null;
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

  /** For the trail instrument and for the parcel-cap test in §12. */
  trailStats() {
    return {
      wakeParcels: this.wakeTrail.count,
      thermalParcels: this.thermalTrail.count,
      wakeStrongest: this.wakeTrail.strongest(this.time),
      thermalStrongest: this.thermalTrail.strongest(this.time),
      thermalTau: this._tauThermal ?? SIG.thermalTau,
    };
  }

  history(channel, seconds) { return this.recorder.history(channel, seconds); }

  /** Floating origin. Parcels are in world space and must move with everything else. */
  rebase(offset) {
    this.wakeTrail.rebase(offset.x, offset.y, offset.z);
    this.thermalTrail.rebase(offset.x, offset.y, offset.z);
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
}

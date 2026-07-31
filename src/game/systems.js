// What the ship's equipment publishes, every step.
//
// `Signature` owns the physics of six channels — how they combine, decay, ride
// the medium and get left behind. It owns none of the *causes*. Every cause is a
// piece of equipment with a switch on it, and this file is that equipment.
//
// The split matters, and it is the reason the signature system was silent for a
// week: `Signature.update()` calls `systems.emit(bus, kin, ship)` and with no
// systems attached the hull emits nothing but its own creak. Measured before
// this file existed, at full-throttle 148 m/s cruise: acoustic 4.00 dB, thermal
// 0, photic 0.05, em 0. Throttle 0→1 moved the acoustic channel by 0.00 dB. The
// tension the whole game rests on lives in this file.
//
// ---------------------------------------------------------------------------
// Where the numbers come from
// ---------------------------------------------------------------------------
// Every constant below is solved backwards from the anchor table in
// CREATURE_BEHAVIOR_CONTRACT.md §3.2, given the combination rules `Signature`
// already implements. None of them is a free parameter, and the derivation is
// written beside each one so the next person can check it rather than trust it:
//
//   acoustic  sums in the POWER domain, so the reactor's contribution is
//             10·log10(10^1.8 − 10^0.4) — not 18 − 4.
//   thermal   is an integrator with time constant 90 s in clear air, so a
//             steady source of R K/s settles at 90·R. Every `thermalKps` here
//             is (anchor ΔK)/90.
//   photic    is a field channel with no store: what is published is what is
//             read. `Signature` adds the thruster plume itself, so the
//             instrument glow published here is the anchor's 3 lm minus that.
//   em        is a field channel; the capacitor is the only store and it lives
//             here, because it is a piece of equipment (signature.js:769 says
//             exactly this and nothing implemented it).
//   wake      is summed linearly and then multiplied by the density factor,
//             which is 1.0 in clear air where the anchors are quoted.
//
// ---------------------------------------------------------------------------
// The one thing the contract does not pin
// ---------------------------------------------------------------------------
// The anchor table gives the engine at throttle 0 and at throttle 1 and says
// nothing about the middle. This file scales the engine's acoustic *level* by
// throttle, not its power. That is a choice, and its consequence is measured:
// the engine only overtakes the reactor above throttle 0.39 (17.82/46, measured
// by sweep in tests/systems.test.js), so the bottom half
// of the throttle range is genuinely quiet and idle is a real tactic rather
// than a slightly smaller number. Scaling power instead would put half throttle
// at 43 dB — three decibels below full cruise — and there would be no quiet
// setting at all. The other three engine channels scale linearly in throttle,
// because they are rates rather than levels.

import { clamp, clamp01, lerp } from '../core/math.js';

/**
 * Every emitter, in the contract's units.
 *
 * Two-element arrays are [at boost 0, at boost 1] and are interpolated on
 * `ship.boostSmoothed`.
 */
export const SYSTEMS = {
  // Reactor. Anchor row 2 ("systems idle, station keeping") minus the hull
  // floor, everywhere it is not additive:
  //   acoustic  10·log10(10^(18/10) − 10^(4/10)) = 17.82 dB(V)
  //   thermal   12 ΔK / 90 s = 0.1333 K/s
  //   em        1.0 EMU is the definition of the unit (contract §3.1)
  //   wake      0.05 − 0.02 hull floor = 0.03 s⁻¹
  reactor: { acousticDb: 17.82, thermalKps: 0.1333, emu: 1.0, wakeInv: 0.03 },

  // Instrument glow. The anchor is 3 lm; `Signature._photic` adds a 0.05 lm
  // plume at full throttle on top of whatever is published here, so this is
  // 3.00 − 0.05 and cruise lands exactly on the anchor.
  instruments: { photicLm: 2.95 },

  // Main engine, scaled by throttle. Endpoints from the cruise and boost rows:
  //   acoustic  46 → 78 dB(V) directly (power-summing puts cruise on 46.007)
  //   thermal   (40 − 12)/90 = 0.311 K/s → (130 − 12)/90 = 1.311 K/s
  //   em        2.2 − 1.0 = 1.2 EMU → 7.5 − 1.0 = 6.5 EMU
  //   wake      cruise needs 0: hull 0.02 + reactor 0.03 + passage 0.55·q
  //             already makes 0.60. Boost's q is 2.564, so passage alone is
  //             1.410 and the engine must supply 4.00 − 1.46 = 2.57 s⁻¹.
  engine: {
    acousticDb: [46.0, 78.0],
    thermalKps: [0.311, 1.311],
    emu: [1.2, 6.5],
    wakeInv: [0.0, 2.57],
  },

  // Control actuators, scaled by airframe strain (`kin.strain`, 1.0 at 36 m/s²).
  // The hard-turn row is +4 ΔK and +0.4 EMU over cruise and nothing else in the
  // system produces either: `Signature` handles the row's acoustic (airframe
  // load) and wake (slip) terms itself, but has no thermal or EM path for a
  // manoeuvre. 4/90 = 0.0444 K/s.
  //
  // Note which numbers are coupled here, because two files have to agree: the
  // hard-turn anchor assumes strain 1.0 (36 m/s², slip 0.30 rad), and the
  // shipped flight model's real sustained full-yaw turn is gLoad 59.6 / slip
  // 0.571 — strain 1.656. Both are reported by tests/systems.test.js.
  manoeuvre: { emu: 0.4, thermalKps: 0.04444 },

  // Nav lights and search lamp. Straight from their anchor rows; the lamp's
  // +2 ΔK is 2/90 K/s.
  navLights: { photicLm: 1200, emu: 0.1 },
  searchLamp: { photicLm: 9000, emu: 0.4, thermalKps: 0.02222 },

  /**
   * The scan capacitor. The only store in this file, and the reason it exists.
   *
   * Contract §3.2 gives it two rows and the note that "scanning announces itself
   * twice": the capacitor ramps to 20 EMU over 1.5 s *before* the pulse, which
   * an electromagnetic sense reads from about 6 km, and the pulse itself carries
   * from 10 km. The pre-charge is the tell, and it is the whole design of the
   * instrument — you cannot look without being looked at first.
   *
   * The two thermal figures are deposits in K, not rates. They last 1.5 s and
   * 0.2 s; treating them as steady-state offsets would deliver a fiftieth of the
   * stated heat, which signature.js:715 warns about by name.
   */
  scan: {
    chargeSec: 1.5,
    pulseSec: 0.2,
    chargeEmu: 20.0,
    chargeK: 3.0,
    pulseEmu: 60.0,
    pulseK: 6.0,
    pulseLm: 40000.0,
    pulseCrackDb: 96.0,
  },
};

/**
 * Lumens per unit of `LightRegistry.signature()` radiance, at the shipped
 * `shipLamp()` preset.
 *
 * **This is a recorded measurement, not a tuning knob.** `lights.js` works in
 * the CLOUD_PALETTE radiance scale (shipLamp: intensity 5.0 × max colour 1.00 =
 * 5.0) and this file works in lumens (search lamp: 9000). 9000/5.0 = 1800 lm
 * per radiance unit *for that preset only* — the thruster plume's preset reads
 * 2.2 radiance against a contract plume of 0.25 lm, i.e. 0.11 lm per radiance
 * unit, so the two scales are not proportional as shipped and a single global
 * conversion constant does not exist.
 *
 * The consequence, stated plainly rather than papered over: this file keeps the
 * lumen truth, because the lumens are what the anchor table specifies and what
 * every creature threshold is written against, and it *drives* the registry
 * (`syncLights`) so the picture cannot disagree with the number. Making the
 * registry the source instead would need the renderer's presets retuned against
 * the anchor table, which needs a GPU to verify.
 */
export const LAMP_LM_PER_RADIANCE = 1800.0;

const SCAN = { IDLE: 'idle', CHARGING: 'charging', PULSING: 'pulsing' };

/**
 * The ship's equipment.
 *
 * Everything is a plain switch the player (or a test) sets directly. There is no
 * internal policy here at all: a system that decided for itself when to run the
 * lamp would be a system the player cannot learn, and Pillar 3 forbids that.
 *
 * @param {object}  opts
 * @param {object}  opts.lights   optional `LightRegistry`. If given along with
 *   ids, `emit()` keeps the registry's on/intensity in step with the switches
 *   here, so the beam the player sees and the lumens the creatures read can
 *   never drift apart.
 * @param {number}  opts.stepSec  the fixed step. Used only when `emit()` is
 *   called without a `dt` — `Signature` passes one, so this is a fallback.
 */
export class ShipSystems {
  constructor({ lights = null, lampId = null, navId = null, stepSec = 1 / 120 } = {}) {
    // --- switches ---------------------------------------------------------
    this.reactor = true;
    this.instruments = true;
    this.engine = true;
    this.navLights = false;
    this.searchLamp = false;
    /** 0..1 dimmer on the search lamp. Lumens and the beam scale together. */
    this.searchLampLevel = 1.0;

    // --- the capacitor ----------------------------------------------------
    this.scanState = SCAN.IDLE;
    this.scanElapsed = 0;
    /** EMU currently held. Ramps 0→20 while charging, 60 during the pulse. */
    this.scanCharge = 0;
    this._chargeKLeft = 0;
    this._pulseKLeft = 0;
    /** Pulses completed. The instrument's own log; a scan is an event. */
    this.scanCount = 0;

    // --- optional coupling to the renderer --------------------------------
    this.lights = lights;
    this.lampId = lampId;
    this.navId = navId;
    this._lampBaseIntensity = null;

    this.stepSec = stepSec;
  }

  /**
   * Fire the scan: 1.5 s of pre-charge, then a 0.2 s pulse.
   *
   * Ignored while one is already running. Deliberately no cooldown — the
   * contract does not specify one, and the pre-charge is already the cost.
   *
   * @returns {boolean} whether this call started a scan.
   */
  scan() {
    if (this.scanState !== SCAN.IDLE) return false;
    this.scanState = SCAN.CHARGING;
    this.scanElapsed = 0;
    this.scanCharge = 0;
    this._chargeKLeft = SYSTEMS.scan.chargeK;
    this._pulseKLeft = SYSTEMS.scan.pulseK;
    return true;
  }

  /** Abort a pre-charge. Once the pulse has started it cannot be recalled. */
  abortScan() {
    if (this.scanState === SCAN.CHARGING) {
      this.scanState = SCAN.IDLE;
      this.scanElapsed = 0;
      this.scanCharge = 0;
      this._chargeKLeft = 0;
    }
    return this;
  }

  /** True while the capacitor is announcing itself but has not fired yet. */
  get scanCharging() { return this.scanState === SCAN.CHARGING; }
  get scanPulsing() { return this.scanState === SCAN.PULSING; }

  /**
   * Publish this step's emissions.
   *
   * @param {EmissionBus} bus
   * @param {object} kin   `Signature.kin` — relSpeed, q, densityFactor, strain
   * @param {object} ship  a `Flight`: throttleSmoothed, boostSmoothed
   * @param {number} dt    the step. `Signature` passes its own; the default is
   *                       for anything calling the three-argument form.
   */
  emit(bus, kin, ship, dt = this.stepSec) {
    const throttle = clamp01(ship?.throttleSmoothed || 0);
    const boost = clamp01(ship?.boostSmoothed || 0);

    if (this.reactor) bus.add('reactor', SYSTEMS.reactor);
    if (this.instruments) bus.add('instruments', SYSTEMS.instruments);

    if (this.engine && throttle > 1e-4) {
      const e = SYSTEMS.engine;
      bus.add('engine', {
        // Level scaled by throttle, not power — see the header.
        acousticDb: throttle * lerp(e.acousticDb[0], e.acousticDb[1], boost),
        thermalKps: throttle * lerp(e.thermalKps[0], e.thermalKps[1], boost),
        emu: throttle * lerp(e.emu[0], e.emu[1], boost),
        wakeInv: throttle * lerp(e.wakeInv[0], e.wakeInv[1], boost),
      });
    }

    const strain = kin?.strain || 0;
    if (strain > 1e-3) {
      bus.add('control actuators', {
        emu: SYSTEMS.manoeuvre.emu * strain,
        thermalKps: SYSTEMS.manoeuvre.thermalKps * strain,
      });
    }

    if (this.navLights) bus.add('nav lights', SYSTEMS.navLights);

    const lampLevel = this.searchLamp ? clamp01(this.searchLampLevel) : 0;
    if (lampLevel > 0) {
      const s = SYSTEMS.searchLamp;
      bus.add('search lamp', {
        photicLm: s.photicLm * lampLevel,
        emu: s.emu * lampLevel,
        thermalKps: s.thermalKps * lampLevel,
      });
    }

    this._emitScan(bus, dt);
    if (this.lights) this.syncLights(lampLevel);
    return this;
  }

  _emitScan(bus, dt) {
    const s = SYSTEMS.scan;
    if (this.scanState === SCAN.IDLE) { this.scanCharge = 0; return; }

    this.scanElapsed += dt;

    if (this.scanState === SCAN.CHARGING) {
      // Linear ramp, so the tell grows the way the contract describes it: an EM
      // sense watches the number climb rather than seeing it appear.
      this.scanCharge = s.chargeEmu * clamp01(this.scanElapsed / s.chargeSec);
      // Deposit the pre-charge heat over the ramp, tracking what is left so the
      // total is exactly chargeK however the step lands on the boundary.
      const want = Math.min(this._chargeKLeft, (s.chargeK / s.chargeSec) * dt);
      this._chargeKLeft -= want;
      bus.add('scan capacitor', { emu: this.scanCharge, thermalK: want });
      if (this.scanElapsed >= s.chargeSec) {
        this.scanState = SCAN.PULSING;
        this.scanElapsed = 0;
      }
      return;
    }

    // Pulsing. Flat for its whole 0.2 s, per the anchor row.
    this.scanCharge = s.pulseEmu;
    const want = Math.min(this._pulseKLeft, (s.pulseK / s.pulseSec) * dt);
    this._pulseKLeft -= want;
    bus.add('scan pulse', {
      emu: s.pulseEmu,
      photicLm: s.pulseLm,
      acousticCrackDb: s.pulseCrackDb,
      thermalK: want,
    });
    if (this.scanElapsed >= s.pulseSec) {
      this.scanState = SCAN.IDLE;
      this.scanElapsed = 0;
      this.scanCharge = 0;
      this.scanCount++;
    }
  }

  /**
   * Keep the renderer's lights in step with the switches.
   *
   * Only `on` and `intensity` — position and direction belong to whoever knows
   * where the ship is pointing, which is `main.js`. The lamp's shipped intensity
   * is read once and then scaled, so this cannot silently overwrite a preset
   * somebody retuned.
   */
  syncLights(lampLevel = (this.searchLamp ? clamp01(this.searchLampLevel) : 0)) {
    const rig = this.lights;
    if (!rig) return this;
    if (this.lampId !== null && this.lampId !== undefined) {
      if (this._lampBaseIntensity === null) {
        const l = rig.get ? rig.get(this.lampId) : null;
        this._lampBaseIntensity = l ? l.intensity : 0;
      }
      rig.set(this.lampId, {
        on: lampLevel > 0,
        intensity: this._lampBaseIntensity * lampLevel,
      });
    }
    if (this.navId !== null && this.navId !== undefined) {
      rig.set(this.navId, { on: !!this.navLights });
    }
    return this;
  }

  /** Everything a HUD or a capture needs, in one object. */
  snapshot() {
    return {
      reactor: this.reactor,
      instruments: this.instruments,
      engine: this.engine,
      navLights: this.navLights,
      searchLamp: this.searchLamp,
      searchLampLevel: +clamp(this.searchLampLevel, 0, 1).toFixed(3),
      scanState: this.scanState,
      scanCharge: +this.scanCharge.toFixed(2),
      scanCount: this.scanCount,
    };
  }

  /** Back to the powered-down hull of anchor row 1. */
  powerDown() {
    this.reactor = false;
    this.instruments = false;
    this.engine = false;
    this.navLights = false;
    this.searchLamp = false;
    this.abortScan();
    return this;
  }
}

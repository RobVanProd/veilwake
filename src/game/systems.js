// The ship's systems, and everything they give away.
//
//   import { ShipSystems } from './game/systems.js';
//   const systems = new ShipSystems({ lights: clouds.lights });
//   signature.update(dt, ship, systems);
//
// This file is the missing half of the signature system, and its absence was
// load-bearing in the worst way. `Signature.update()` calls
// `systems.emit(bus, kin, ship, dt)`, and **every emission except the airframe
// load term and a 0.05 lm plume arrives through that one call**. With no systems
// object the hull measured 4.00 dB acoustic, 0 thermal, 0 EM at full throttle —
// identical to a powered-down wreck on three of six channels. The whole game is
// built on the idea that surviving makes you louder, and nothing was loud.
//
// --- the design this exists to serve ---------------------------------------
//
// Pillar 2: there is no free countermeasure. Every system here buys the player
// something and charges for it on a channel some creature can hear. The engine
// buys distance and costs acoustic; the lamp buys sight and costs photic, which
// is the one channel that carries perfectly through cloud; the scan buys
// knowledge and costs *everything at once*, briefly and enormously.
//
// The interesting consequence is that the channels have different clocks, and a
// player learns the game by learning them. Field channels — photic, EM — die the
// frame you switch them off. Acoustic decays on the engine's 2.2 s power
// constant, so cutting power costs about fifteen seconds of still being audible.
// Thermal is a 90 second integrator: a boost stays warm for minutes, long after
// you have forgotten you used it. Nothing about that is explained to the player
// anywhere; it is meant to be learned by being caught.
//
// --- where the numbers come from --------------------------------------------
//
// CREATURE_BEHAVIOR_CONTRACT §3.2 publishes an anchor table: what the ship reads
// on each channel in each of a few named states. These publications were
// reconstructed from that table by an audit that drove them and confirmed all
// four anchor states reproduce within 1%. They are not invented and should not
// be adjusted without re-checking against §3.2 — the creature thresholds are
// tuned against these exact values, so moving one silently retunes the game.

/** Reactor idle. The floor of being switched on at all. */
const REACTOR = { acousticDb: 17.82, thermalKps: 0.1333, emu: 1.0, wakeInv: 0.03 };

/** Instruments. The dimmest thing that is still a light. */
const INSTRUMENTS = { photicLm: 2.95 };

/**
 * The engine, as endpoints. Throttle scales from nothing to the first column;
 * boost lerps from the first to the second.
 *
 * Boost is deliberately not "more throttle": it is roughly 1.7x the acoustic
 * power, 4x the thermal rate and 5x the EM of full military thrust, so it is
 * never the cheap answer to anything. It exists to be the decision you regret.
 */
const ENGINE = {
  cruise: { acousticDb: 46.0, thermalKps: 0.311, emu: 1.2, wakeInv: 0.0 },
  boost: { acousticDb: 78.0, thermalKps: 1.311, emu: 6.5, wakeInv: 2.57 },
};

/** Navigation lights. Cheap, and still a beacon in a world this dark. */
const NAV = { photicLm: 1200, emu: 0.1 };

/** The search lamp. The only thing that lets you see, and a flare on the photic channel. */
const LAMP = { photicLm: 9000, emu: 0.4, thermalKps: 0.0222 };

/**
 * The scan. Contract §3.2's two most dramatic rows, and the only emission in the
 * game that is an event rather than a state.
 *
 * It charges for `chargeSec`, during which EM climbs steadily and anything
 * listening on that channel watches you wind up — the tell is deliberate, so a
 * creature can react before the pulse rather than only after. Then it fires for
 * `pulseSec`: a crack, a flash and an EM spike together. Knowing where you are
 * costs telling everything else where you are.
 */
const SCAN = {
  chargeSec: 1.5,
  chargeEmu: 20,
  pulseSec: 0.2,
  pulse: { acousticCrackDb: 96, photicLm: 40000, emu: 60, thermalK: 6 },
  cooldownSec: 6.0,
};

export const SYSTEM_ANCHORS = { REACTOR, INSTRUMENTS, ENGINE, NAV, LAMP, SCAN };

const lerp = (a, b, t) => a + (b - a) * t;

export class ShipSystems {
  /**
   * @param {object}  opts
   * @param {object} [opts.lights] the LightRegistry, so photic is read from what
   *   is actually being drawn rather than from a constant that can drift away
   *   from it. If omitted, the nominal lumen figures above are used.
   */
  constructor({ lights = null } = {}) {
    this.lights = lights;

    /** Player-facing switches. The game writes these; nothing else does. */
    this.reactorOn = true;
    this.instrumentsOn = true;
    this.navLightsOn = false;
    this.lampOn = false;

    /** Scan state machine: 'idle' | 'charging' | 'pulsing' | 'cooldown'. */
    this.scanState = 'idle';
    this.scanTimer = 0;
    /** 0..1, and the number a charge indicator should show. */
    this.scanCharge = 0;

    this._lastPulse = -1e9;
  }

  /** Begin a scan. Ignored unless idle, so holding the key does not stack. */
  requestScan() {
    if (this.scanState !== 'idle') return false;
    this.scanState = 'charging';
    this.scanTimer = 0;
    return true;
  }

  /** Abandon a charging scan. The EM already radiated is not refunded. */
  cancelScan() {
    if (this.scanState === 'charging') {
      this.scanState = 'idle';
      this.scanTimer = 0;
      this.scanCharge = 0;
      return true;
    }
    return false;
  }

  /**
   * Publish this step's emissions.
   *
   * @param {import('./signature.js').EmissionBus} bus
   * @param {object} kin  kinematics the Signature already computed
   * @param {object} ship the flight model
   * @param {number} dt
   */
  emit(bus, kin, ship, dt) {
    const i = ship.input || {};
    const throttle = ship.throttleSmoothed !== undefined
      ? ship.throttleSmoothed : (i.throttle || 0);
    const boost = ship.boostSmoothed !== undefined
      ? ship.boostSmoothed : (i.boost ? 1 : 0);

    if (this.reactorOn) bus.add('reactor', REACTOR);
    if (this.instrumentsOn) bus.add('instruments', INSTRUMENTS);

    // --- engine ------------------------------------------------------------
    // Scaled by throttle, with boost lerping the endpoints. Note acousticDb is
    // scaled linearly in dB rather than in power: that is what the anchor table
    // does, and matching it matters more than being principled about it, because
    // every creature threshold in the contract was fitted against these rows.
    if (throttle > 1e-4 || boost > 1e-4) {
      const c = ENGINE.cruise, b = ENGINE.boost;
      bus.add('engine', {
        acousticDb: lerp(c.acousticDb, b.acousticDb, boost) * throttle,
        thermalKps: lerp(c.thermalKps, b.thermalKps, boost) * throttle,
        emu: lerp(c.emu, b.emu, boost) * throttle,
        wakeInv: lerp(c.wakeInv, b.wakeInv, boost) * throttle,
      });
    }

    // --- lights ------------------------------------------------------------
    // Photic comes from the light registry when there is one, so the number the
    // creatures hear is the number the renderer drew. Two sources of truth for
    // "how bright is the ship" is exactly how a signature system starts lying.
    const registryLm = this.lights && this.lights.signature
      ? this.lights.signature() * LUMENS_PER_RADIANCE : null;

    if (this.navLightsOn) {
      bus.add('nav', { photicLm: registryLm === null ? NAV.photicLm : 0, emu: NAV.emu });
    }
    if (this.lampOn) {
      bus.add('lamp', {
        photicLm: registryLm === null ? LAMP.photicLm : 0,
        emu: LAMP.emu, thermalKps: LAMP.thermalKps,
      });
    }
    if (registryLm !== null && registryLm > 0) {
      bus.add('emitters', { photicLm: registryLm });
    }

    // --- scan --------------------------------------------------------------
    this._scan(bus, dt);
  }

  _scan(bus, dt) {
    switch (this.scanState) {
      case 'charging': {
        this.scanTimer += dt;
        this.scanCharge = Math.min(1, this.scanTimer / SCAN.chargeSec);
        // The wind-up is audible on EM before the pulse fires. Deliberate: it
        // gives anything listening a reason to look your way *first*, so the
        // player who scans next to a creature is punished by their own tell
        // rather than by an unreadable rule.
        bus.add('scan/charge', { emu: SCAN.chargeEmu * this.scanCharge });
        if (this.scanTimer >= SCAN.chargeSec) { this.scanState = 'pulsing'; this.scanTimer = 0; }
        break;
      }
      case 'pulsing': {
        this.scanTimer += dt;
        bus.add('scan/pulse', SCAN.pulse);
        if (this.scanTimer >= SCAN.pulseSec) {
          this.scanState = 'cooldown'; this.scanTimer = 0; this.scanCharge = 0;
        }
        break;
      }
      case 'cooldown': {
        this.scanTimer += dt;
        if (this.scanTimer >= SCAN.cooldownSec) { this.scanState = 'idle'; this.scanTimer = 0; }
        break;
      }
      default: break;
    }
  }

  /** Whatever a HUD needs, without it reaching into the state machine. */
  snapshot() {
    return {
      reactorOn: this.reactorOn,
      instrumentsOn: this.instrumentsOn,
      navLightsOn: this.navLightsOn,
      lampOn: this.lampOn,
      scanState: this.scanState,
      scanCharge: this.scanCharge,
      scanReady: this.scanState === 'idle',
    };
  }
}

/**
 * Radiance in CLOUD_PALETTE's arbitrary scale to lumens.
 *
 * The registry reports a radiance sum (a lamp is 5.0) and the signature system
 * wants lumens (a lamp is 9000). The constant is set so the two agree on the
 * lamp, which is the anchor §3.2 actually publishes — derived from the table
 * rather than guessed, because guessing a normalisation constant is how four
 * separate bugs got into this project.
 */
const LUMENS_PER_RADIANCE = LAMP.photicLm / 5.0;

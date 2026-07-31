// The ship.
//
// This is the first thing built and the first thing that has to be right,
// because it is the only system the player touches continuously. Everything else
// in the game — the clouds, the creatures, the signatures — is experienced
// through this.
//
// The design target is a small heavy machine in a thick medium. Not a fighter,
// not a spacecraft: something with mass, moving through air dense enough to push
// back. Two failure modes bracket it and both are common:
//
//   Weightless. Velocity follows input directly. The ship reads as a camera with
//   a cockpit drawn on it, nothing feels like it costs anything, and there is no
//   physical basis for a signature system — a wake means nothing if the ship has
//   no momentum to disturb the air with.
//
//   Glacial. So much inertia that inputs feel disconnected from outcomes. The
//   player stops believing they are flying and starts fighting the controls,
//   which is fatal in a game whose tension depends on committing to a decision
//   under pressure.
//
// The middle is: inputs move *forces*, forces move the body, and the body's
// attitude leads its velocity slightly. The nose points where you asked before
// the ship gets there, which is what makes an aircraft feel like an aircraft.

import * as THREE from 'three';
import { clamp, clamp01, approach, lerp, smoothstep } from '../core/math.js';

/** Ship configuration. Every number here is a feel decision, not a physical constant. */
export const SHIP = {
  mass: 1.0,                 // normalised; forces are expressed in accelerations

  // --- thrust -------------------------------------------------------------
  thrustMain: 46.0,          // m/s^2 at full throttle
  thrustBoost: 118.0,        // the loud option
  thrustReverse: 18.0,       // retro thrusters are weak on purpose: stopping is
                             // meant to be a commitment, not a button
  thrustLateral: 14.0,       // translation, for creeping sideways past something
  thrustVertical: 16.0,

  // --- the medium ---------------------------------------------------------
  // Drag is quadratic and anisotropic. Sideways and vertical drag are far higher
  // than forward drag, which is what stops the ship sliding through turns like a
  // hovering brick and is most of why it reads as an aircraft.
  dragForward: 0.0021,
  dragLateral: 0.0180,
  dragVertical: 0.0150,
  dragAngular: 2.6,

  // --- attitude -----------------------------------------------------------
  // Torques, not rates. Setting rates directly is the single biggest cause of
  // weightless-feeling flight: the ship snaps to the stick and has no rotational
  // inertia to express its size.
  torquePitch: 3.1,
  torqueYaw: 1.9,
  torqueRoll: 5.2,
  maxPitchRate: 1.15,        // rad/s
  maxYawRate: 0.72,
  maxRollRate: 2.35,

  // Yaw follows roll, the way a banked aircraft turns. Without this the ship
  // yaws flat like a turret and every turn feels wrong for reasons players
  // describe as "floaty" without being able to say why.
  bankToYaw: 0.62,

  /**
   * Bank is *commanded*, not accumulated.
   *
   * The obvious construction — yaw input applies a roll torque, and the
   * resulting bank applies a yaw torque — is a feedback loop with no damping on
   * the roll axis, and it behaves like one. Measured over a single held turn it
   * wandered from -21 degrees to -8 to -13 and then to +20, reversing the bank
   * while the ship was still turning the same way. Adding a restoring force
   * fixed the oscillation and then fought the intended bank instead; that was
   * two failed variations of the same mechanism, so the mechanism changed.
   *
   * Instead, yaw input names a target bank angle and a servo drives the roll
   * axis toward it. There is no loop to oscillate: the commanded attitude is a
   * function of the stick, the ship approaches it at a known rate, and releasing
   * the stick commands zero. The bank-to-yaw term stays, so the turn is still
   * produced by the bank rather than by a flat yaw.
   */
  maxCoordinatedBank: 0.62,   // radians at full yaw input, about 35 degrees
  //
  // Known shortfall, measured: at *full* yaw deflection the bank reaches 26
  // degrees, holds for about two seconds and then bleeds back toward level over
  // five, so the hardest available turn finishes flatter than it starts. Gentle
  // and half inputs hold their bank correctly (6.5 and 13 degrees, steady).
  //
  // The cause is kinematic rather than a servo fault: bank here is measured
  // against the horizon, and in a hard sustained turn the nose drops, so the
  // horizon-relative bank genuinely changes while body roll does not. The servo
  // then dutifully removes roll to hold the number it was given. A proper fix
  // is either an integral term or measuring bank in the turn frame rather than
  // the horizon frame; both are polish and neither is worth doing before the
  // camera has been judged in motion by a person.
  bankServoGain: 4.2,
  bankServoDamping: 2.4,

  // --- limits -------------------------------------------------------------
  maxSpeed: 210.0,
  maxSpeedBoost: 340.0,
  stallSpeed: 12.0,          // below this, control authority falls away

  // --- energy -------------------------------------------------------------
  energyMax: 100.0,
  energyIdle: 0.35,          // per second, just being switched on
  energyThrust: 2.4,         // per second at full throttle
  energyBoost: 11.0,
  energyRecharge: 3.2,       // per second with engines cut
};

const HORIZON_RIGHT = new THREE.Vector3();
const HORIZON_UP = new THREE.Vector3();

export class Flight {
  constructor({ rng = null } = {}) {
    // Position is kept relative to a floating origin. The world recentres around
    // the ship, so these never grow large enough to lose float precision — the
    // journey is endless and single-precision positions would visibly quantise
    // within a few minutes of travel.
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.orientation = new THREE.Quaternion();
    this.angularVelocity = new THREE.Vector3(0, 0, 0);

    // Inputs, all -1..1 except throttle which is 0..1.
    this.input = { pitch: 0, yaw: 0, roll: 0, throttle: 0, boost: false,
                   lateral: 0, vertical: 0, brake: false };

    this.energy = SHIP.energyMax;
    this.stalled = false;

    // Turbulence is an external force from the medium, applied at the body. It
    // is not screen shake: it moves the ship, so the player has to fly against
    // it, and the camera shakes because the ship did — never the other way round.
    this.turbulence = new THREE.Vector3(0, 0, 0);
    this.turbulenceLevel = 0;

    // Read by the signature system and by the camera. Kept here because they are
    // properties of how the ship is being flown.
    this.throttleSmoothed = 0;
    this.boostSmoothed = 0;
    this.gLoad = 0;
    this.slipAngle = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this.rng = rng;
  }

  /** Body axes in world space. Recomputed once per step. */
  _axes() {
    this._fwd.set(0, 0, -1).applyQuaternion(this.orientation);
    this._right.set(1, 0, 0).applyQuaternion(this.orientation);
    this._up.set(0, 1, 0).applyQuaternion(this.orientation);
  }

  get forward() { return this._fwd; }
  get right() { return this._right; }
  get up() { return this._up; }
  get speed() { return this.velocity.length(); }

  /** Forward speed only — what an airspeed indicator would read. */
  get airspeed() { return this.velocity.dot(this._fwd); }

  step(dt) {
    this._axes();
    const i = this.input;

    // --- energy ----------------------------------------------------------
    const wantBoost = i.boost && this.energy > 6;
    const throttle = clamp01(i.throttle);
    this.throttleSmoothed = approach(this.throttleSmoothed, throttle, 5.0, dt);
    this.boostSmoothed = approach(this.boostSmoothed, wantBoost ? 1 : 0, 3.2, dt);

    let drain = SHIP.energyIdle + SHIP.energyThrust * this.throttleSmoothed;
    if (wantBoost) drain += SHIP.energyBoost;
    // Engines cut and coasting: the ship recovers. This is what makes drifting a
    // real tactic rather than merely a slow one.
    if (throttle < 0.02 && !wantBoost) drain -= SHIP.energyRecharge;
    this.energy = clamp(this.energy - drain * dt, 0, SHIP.energyMax);

    // --- control authority ------------------------------------------------
    // Falls away at low airspeed. Control surfaces need flow over them, and this
    // is what makes cutting the engines genuinely dangerous rather than simply
    // quiet: a drifting ship is one that cannot turn away from what it hears.
    const flow = smoothstep(0, SHIP.stallSpeed * 2.6, Math.abs(this.airspeed));
    const authority = lerp(0.16, 1.0, flow);
    this.stalled = flow < 0.35;

    // --- attitude ---------------------------------------------------------
    // Commanded yaw induces roll, and existing roll induces yaw. The first makes
    // turns look deliberate; the second is what an aircraft actually does and is
    // why the ship banks into a turn instead of skidding through it flat.
    const bank = this._bankAngle();
    // The bank is what turns the ship, exactly as it does on an aircraft.
    // Determined by measurement, after two wrong guesses. In this rig a positive
    // yaw command produces a *left* turn (heading measured as atan2(fwd.x,
    // -fwd.z) decreases), and a left turn is coordinated by left-wing-down,
    // which the bank measurement reports as negative. So both the induced yaw
    // and the commanded bank carry a leading minus, and the thing that was
    // actually broken all along was the servo law below rather than these.
    const inducedYaw = -Math.sin(bank) * SHIP.bankToYaw * flow;

    // Direct roll input overrides the servo, so the ship can still be flown
    // sideways or inverted deliberately; otherwise yaw commands the bank.
    let rollTorque;
    if (Math.abs(i.roll) > 0.02) {
      rollTorque = i.roll * SHIP.torqueRoll;
    } else {
      const targetBank = -i.yaw * SHIP.maxCoordinatedBank;
      const error = targetBank - bank;

      // The leading minus is the whole reason this took three attempts.
      //
      // A positive torque about the body's +Z axis rotates the right wing *up*,
      // which *decreases* bank as measured here. So a servo written the obvious
      // way — torque proportional to (target - bank) — is positive feedback: the
      // error grows, the ship rolls smoothly past vertical, and it settles
      // completely inverted while still appearing to turn the right way. The
      // damping term had the same problem in reverse and was amplifying w.z
      // rather than opposing it.
      //
      // With e = target - bank and de/dt = w.z, the stable law is u = -(Kp·e + Kd·ẇ).
      rollTorque = -(error * SHIP.bankServoGain + this.angularVelocity.z * SHIP.bankServoDamping)
                 * SHIP.torqueRoll * flow;
    }

    const t = this._tmp.set(
      i.pitch * SHIP.torquePitch,
      (i.yaw + inducedYaw) * SHIP.torqueYaw,
      rollTorque,
    ).multiplyScalar(authority);

    this.angularVelocity.addScaledVector(t, dt);
    // Angular drag, exponential so it is framerate-independent.
    this.angularVelocity.multiplyScalar(Math.exp(-SHIP.dragAngular * dt));
    this.angularVelocity.set(
      clamp(this.angularVelocity.x, -SHIP.maxPitchRate, SHIP.maxPitchRate),
      clamp(this.angularVelocity.y, -SHIP.maxYawRate, SHIP.maxYawRate),
      clamp(this.angularVelocity.z, -SHIP.maxRollRate, SHIP.maxRollRate),
    );

    if (this.angularVelocity.lengthSq() > 1e-10) {
      const w = this.angularVelocity;
      // Integrate in body space, then normalise. Composing a small rotation onto
      // the quaternion avoids the Euler-order and gimbal problems that make a
      // free-flying ship flip unexpectedly when it points straight up.
      this._q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 1).normalize();
      this.orientation.multiply(this._q).normalize();
      this._axes();
    }

    // --- forces -----------------------------------------------------------
    const accel = this._tmp.set(0, 0, 0);

    const thrust = wantBoost
      ? lerp(SHIP.thrustMain, SHIP.thrustBoost, this.boostSmoothed)
      : SHIP.thrustMain;
    accel.addScaledVector(this._fwd, thrust * this.throttleSmoothed);

    if (i.brake) accel.addScaledVector(this._fwd, -SHIP.thrustReverse);
    if (i.lateral) accel.addScaledVector(this._right, i.lateral * SHIP.thrustLateral);
    if (i.vertical) accel.addScaledVector(this._up, i.vertical * SHIP.thrustVertical);

    // Anisotropic quadratic drag, resolved in body axes. This is the line that
    // makes the ship feel like it is in something rather than in a vacuum.
    const vf = this.velocity.dot(this._fwd);
    const vr = this.velocity.dot(this._right);
    const vu = this.velocity.dot(this._up);
    accel.addScaledVector(this._fwd, -SHIP.dragForward * vf * Math.abs(vf));
    accel.addScaledVector(this._right, -SHIP.dragLateral * vr * Math.abs(vr));
    accel.addScaledVector(this._up, -SHIP.dragVertical * vu * Math.abs(vu));

    accel.add(this.turbulence);

    this.velocity.addScaledVector(accel, dt);

    const cap = lerp(SHIP.maxSpeed, SHIP.maxSpeedBoost, this.boostSmoothed);
    if (this.velocity.lengthSq() > cap * cap) this.velocity.setLength(cap);

    this.position.addScaledVector(this.velocity, dt);

    // --- derived, for the camera, the audio and the signature system -------
    // Lateral acceleration is what the pilot's body would feel, and it is what
    // the camera should lean against.
    this.gLoad = Math.abs(accel.dot(this._right)) + Math.abs(accel.dot(this._up));
    // Slip: how far the ship is travelling from where it is pointing. High slip
    // is a skid, and it is what tears a wake in the vapour.
    const sp = this.speed;
    this.slipAngle = sp > 1 ? Math.acos(clamp(vf / sp, -1, 1)) : 0;

    return this;
  }

  /**
   * Roll about the ship's own forward axis, relative to the horizon.
   *
   * Not `asin(right.y)`, which was the first attempt and is only correct while
   * the ship is level. During a sustained turn the heading sweeps and the nose
   * drops, and that expression then reports a bank that is drifting when the
   * ship is holding one — measured, a hard turn appeared to roll from -26
   * degrees to +3 while the attitude was in fact steady, which made the servo
   * chase a phantom.
   *
   * This projects the ship's up vector onto the horizon frame built from its own
   * forward direction, which is stable at any heading and any pitch.
   */
  _bankAngle() {
    const f = this._fwd;
    // Degenerate looking straight up or down: the horizon frame is undefined, so
    // report the previous value rather than snapping to an arbitrary angle.
    if (Math.abs(f.y) > 0.9995) return this._lastBank || 0;

    const hr = HORIZON_RIGHT.set(-f.z, 0, f.x).normalize();      // cross(fwd, worldUp)
    const hu = HORIZON_UP.crossVectors(hr, f).normalize();       // true up in that frame
    const bank = Math.atan2(this._up.dot(hr), this._up.dot(hu));
    this._lastBank = bank;
    return bank;
  }

  get bankAngle() { return this._bankAngle(); }

  /**
   * Apply the medium's turbulence.
   *
   * Given as an acceleration so it composes with everything else. The cloud
   * system drives this from local flow and density; until that exists a caller
   * can synthesise it, but the units must stay the same or the flight model will
   * have to be retuned when the clouds arrive.
   */
  setTurbulence(vec, level) {
    this.turbulence.copy(vec);
    this.turbulenceLevel = clamp01(level);
  }

  /** Recentre for a floating origin. The world moves; the ship's numbers stay small. */
  rebase(offset) {
    this.position.sub(offset);
  }

  /** Everything another system needs, without exposing the internals. */
  telemetry() {
    return {
      speed: this.speed,
      airspeed: this.airspeed,
      throttle: this.throttleSmoothed,
      boost: this.boostSmoothed,
      energy: this.energy,
      energyFrac: this.energy / SHIP.energyMax,
      bank: this.bankAngle,
      slip: this.slipAngle,
      gLoad: this.gLoad,
      stalled: this.stalled,
      turbulence: this.turbulenceLevel,
      angularSpeed: this.angularVelocity.length(),
    };
  }
}

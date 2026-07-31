// The camera.
//
// Its only job is to communicate mass and danger without making anyone ill, and
// those two pull in opposite directions: everything that sells weight is motion
// the player did not ask for, and motion the player did not ask for is what
// causes nausea. So every term here is small, every term is damped, and every
// term can be switched off independently — the comfort options are not a
// concession bolted on at the end, they are how the system is built.
//
// The rule the whole file obeys: **the camera never invents motion.** It lags
// behind the ship, it leans against forces the ship is actually experiencing,
// and it shakes because the hull is shaking. Nothing oscillates on a timer. A
// camera that adds a sine wave to sell "atmosphere" is the single most common
// cause of motion sickness in flight games, and it is also a lie about the
// simulation.

import * as THREE from 'three';
import { clamp, clamp01, lerp, approach, smoothstep } from '../core/math.js';

export const CAMERA_DEFAULTS = {
  // --- placement ---------------------------------------------------------
  /** Eye position in ship space. Slightly high and back — a cockpit, not a chase cam. */
  eye: [0, 0.55, 1.9],

  // --- lag ---------------------------------------------------------------
  /**
   * The camera is attached to the ship by a spring, not welded to it.
   *
   * Position lag is deliberately much stiffer than rotation lag. Positional
   * softness reads as the ship being made of rubber; rotational softness reads
   * as the pilot's head lagging the machine, which is exactly the impression
   * wanted. The two being equal is what makes most chase cameras feel cheap.
   */
  positionLag: 26.0,
  rotationLag: 11.0,

  // --- lean --------------------------------------------------------------
  /** How far the view leans against lateral acceleration, in metres. */
  leanDistance: 0.10,
  leanLag: 6.0,
  /** Extra roll beyond the ship's own bank, so turns feel committed. */
  bankLean: 0.16,

  // --- field of view -----------------------------------------------------
  baseFov: 62,
  /**
   * FOV widens with speed. The strongest speed cue available and nearly free:
   * a wider lens sweeps the frame edges past far faster while the centre barely
   * moves. Kept modest because FOV change is also a common nausea trigger.
   */
  fovAtMaxSpeed: 12,
  fovBoost: 6,
  fovLag: 2.4,

  // --- shake -------------------------------------------------------------
  /**
   * Peak hull shake in degrees. Deliberately tiny.
   *
   * Enough that the frame is never glassy — a perfectly still frame at speed
   * reads as effortless, and effortless reads as slow. Large enough to notice
   * consciously and it becomes nausea rather than speed.
   */
  shakeDegrees: 0.34,
  shakeFrequency: 13.0,
  turbulenceShake: 0.9,

  // --- threat ------------------------------------------------------------
  /**
   * How much the camera reacts to something enormous nearby. Restrained on
   * purpose: the mandate asks for threat-sensitive but *restrained* behaviour,
   * and a camera that lurches at every contact teaches the player to distrust
   * it. This is a slow, small drift toward the threat, not a snap.
   */
  threatDrift: 0.06,
  threatLag: 1.2,

  /** Hard ceiling on how fast the view may rotate itself, degrees per second. */
  maxSelfTurnRate: 210,
};

/** Everything a player might need to switch off. Defaults are the full experience. */
export const COMFORT_DEFAULTS = {
  shake: 1.0,          // 0 disables hull shake entirely
  roll: 1.0,           // 0 keeps the horizon level regardless of ship bank
  fovShift: 1.0,       // 0 pins the field of view
  lean: 1.0,
  threatCamera: 1.0,
  motionBlur: 1.0,
  horizonLine: 0.0,    // an artificial horizon for players who need one
};

export class ShipCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} opts
   */
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.cfg = { ...CAMERA_DEFAULTS, ...opts };
    this.comfort = { ...COMFORT_DEFAULTS };

    this.position = new THREE.Vector3();
    this.orientation = new THREE.Quaternion();

    this.fov = this.cfg.baseFov;
    this.lean = new THREE.Vector3();
    this.threatOffset = new THREE.Vector3();
    this.shakeSeed = Math.random() * 1000;

    this._eye = new THREE.Vector3(...this.cfg.eye);
    this._target = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._prevQuat = new THREE.Quaternion();
    this._initialised = false;

    /** Set by the game when something large is close. { dir: Vector3, weight: 0..1 } */
    this.threat = null;
  }

  /**
   * @param {import('./flight.js').Flight} ship
   * @param {number} dt
   * @param {number} time simulation time, for the shake phase
   */
  update(ship, dt, time) {
    const c = this.cfg, k = this.comfort;

    // --- where the eye wants to be --------------------------------------
    this._target.copy(this._eye).applyQuaternion(ship.orientation).add(ship.position);

    if (!this._initialised) {
      this.position.copy(this._target);
      this.orientation.copy(ship.orientation);
      this._prevQuat.copy(ship.orientation);
      this._initialised = true;
    }

    // --- lean against real forces ---------------------------------------
    // Uses the ship's measured lateral acceleration and slip, never a timer.
    const lateral = ship.velocity.dot(ship.right);
    const vertical = ship.velocity.dot(ship.up);
    const wantLean = this._tmp.set(
      -clamp(lateral / 90, -1, 1) * c.leanDistance,
      -clamp(vertical / 110, -1, 1) * c.leanDistance * 0.6,
      0,
    ).multiplyScalar(k.lean);
    this.lean.lerp(wantLean, 1 - Math.exp(-c.leanLag * dt));

    // --- threat drift ----------------------------------------------------
    const wantThreat = this._tmp.set(0, 0, 0);
    if (this.threat && k.threatCamera > 0) {
      wantThreat.copy(this.threat.dir).normalize()
        .multiplyScalar(c.threatDrift * clamp01(this.threat.weight) * k.threatCamera);
    }
    this.threatOffset.lerp(wantThreat, 1 - Math.exp(-c.threatLag * dt));

    // --- position --------------------------------------------------------
    const offset = this._tmp.copy(this.lean).add(this.threatOffset).applyQuaternion(ship.orientation);
    this._target.add(offset);
    this.position.lerp(this._target, 1 - Math.exp(-c.positionLag * dt));

    // --- orientation -----------------------------------------------------
    // Slerp toward the ship's attitude. The lag is what makes the machine feel
    // heavier than the view attached to it.
    this._q.copy(ship.orientation);

    // Extra bank, so a committed turn looks committed.
    if (k.roll > 0 && c.bankLean !== 0) {
      const extra = -ship.angularVelocity.y * c.bankLean;
      this._q.multiply(new THREE.Quaternion().setFromAxisAngle(FORWARD, extra));
    }

    const before = this._prevQuat.copy(this.orientation);
    this.orientation.slerp(this._q, 1 - Math.exp(-c.rotationLag * dt));

    // Comfort: keep the horizon level by removing roll entirely.
    if (k.roll <= 0) this._levelRoll();

    // Hard cap on self-rotation. A guarantee rather than an adjustment: whatever
    // the ship or a scripted event does, the view cannot spin faster than the
    // eye can follow, which is the difference between drama and disorientation.
    const maxStep = THREE.MathUtils.degToRad(c.maxSelfTurnRate) * dt;
    const step = before.angleTo(this.orientation);
    if (step > maxStep && step > 1e-6) {
      this.orientation.copy(before).slerp(this.orientation, maxStep / step);
    }

    // --- shake -----------------------------------------------------------
    // Driven by hull state, never by a clock alone. Two incommensurate
    // frequencies per axis so the pattern never settles into something the eye
    // learns to predict and then ignores.
    if (k.shake > 0 && c.shakeDegrees > 0) {
      const t = ship.telemetry();
      const load = clamp01(t.gLoad / 45) * 0.5 +
                   clamp01(t.turbulence) * c.turbulenceShake * 0.5 +
                   clamp01(t.boost) * 0.35;
      if (load > 0.002) {
        const amp = THREE.MathUtils.degToRad(c.shakeDegrees * load * k.shake);
        const f = c.shakeFrequency;
        const s = this.shakeSeed;
        const p = amp * (0.62 * Math.sin(time * f + s) + 0.38 * Math.sin(time * f * 1.618 + s * 1.7));
        const y = amp * (0.62 * Math.sin(time * f * 0.83 + s * 2.3) + 0.38 * Math.sin(time * f * 1.31 + s));
        this._q.setFromEuler(new THREE.Euler(p, y, 0, 'XYZ'));
        this.orientation.multiply(this._q);
      }
    }

    // --- field of view ---------------------------------------------------
    const t = ship.telemetry();
    const speedFrac = clamp01(t.speed / 210);
    let wantFov = c.baseFov;
    if (k.fovShift > 0) {
      wantFov += (speedFrac * c.fovAtMaxSpeed + t.boost * c.fovBoost) * k.fovShift;
    }
    this.fov = approach(this.fov, wantFov, c.fovLag, dt);

    // --- commit ----------------------------------------------------------
    this.camera.position.copy(this.position);
    this.camera.quaternion.copy(this.orientation);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Remove roll about the view axis, keeping pitch and yaw. */
  _levelRoll() {
    const fwd = FORWARD.clone().applyQuaternion(this.orientation);
    const up = new THREE.Vector3(0, 1, 0);
    // Degenerate when looking straight up or down; leave it alone rather than
    // snapping to an arbitrary roll.
    if (Math.abs(fwd.dot(up)) > 0.995) return;
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const trueUp = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const m = new THREE.Matrix4().makeBasis(right, trueUp, fwd.clone().negate());
    this.orientation.setFromRotationMatrix(m);
  }

  /** Recentre for the floating origin. */
  rebase(offset) {
    this.position.sub(offset);
  }

  setComfort(partial) { Object.assign(this.comfort, partial); }
}

const FORWARD = new THREE.Vector3(0, 0, -1);

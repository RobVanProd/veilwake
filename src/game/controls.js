// Input to flight commands.
//
// Kept apart from both the input devices and the flight model so that neither
// knows about the other. The flight model takes normalised commands and does not
// care where they came from; this file is the only place that knows a keyboard
// exists, which is what makes a replay, a scripted test flight and a gamepad all
// the same problem later.
//
// The one piece of real design here is the shaping. Raw digital keys produce
// square-wave input, and a ship flown by square waves feels twitchy no matter
// how good the physics underneath are — the smoothing below is doing as much for
// the feel of the ship as anything in flight.js.

import { clamp, clamp01, approach } from '../core/math.js';

export const BINDINGS = {
  pitchUp:    ['KeyS', 'ArrowDown'],
  pitchDown:  ['KeyW', 'ArrowUp'],
  yawLeft:    ['KeyA', 'ArrowLeft'],
  yawRight:   ['KeyD', 'ArrowRight'],
  rollLeft:   ['KeyQ'],
  rollRight:  ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight'],
  throttleDn: ['ControlLeft', 'ControlRight'],
  boost:      ['Space'],
  brake:      ['KeyX'],
  cutEngines: ['KeyZ'],
  lights:     ['KeyL'],
  scan:       ['KeyF'],
  liftUp:     ['KeyR'],
  liftDown:   ['KeyC'],
  strafeL:    ['KeyZ'],
  strafeR:    ['KeyV'],
};

export class Controls {
  /**
   * @param {import('../core/input.js').Input} input
   * @param {import('../core/pointer.js').Pointer} pointer
   */
  constructor(input, pointer = null) {
    this.input = input;
    this.pointer = pointer;

    /** Smoothed axes, so digital keys do not produce square-wave commands. */
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;
    this.throttle = 0.35;

    this.cutEngines = false;
    this.lightsOn = false;

    /** Edge-triggered, consumed by the game. */
    this.scanRequested = false;
    this.lightsToggled = false;

    // Asymmetric rates. Control returns to centre faster than it leaves it,
    // which is what stops a released key leaving the ship drifting into a turn
    // and is the difference between "responsive" and "twitchy".
    this.attackRate = 7.5;
    this.releaseRate = 11.0;
    this.mouseSensitivity = 1.0;
    this.useMouse = true;
  }

  _held(action) {
    return BINDINGS[action].some((k) => this.input.held(k));
  }

  _pressed(action) {
    return BINDINGS[action].some((k) => this.input.wasPressed(k));
  }

  /** @param {number} dt */
  update(dt) {
    const i = this.input;

    // --- attitude ---------------------------------------------------------
    let wantPitch = (this._held('pitchUp') ? 1 : 0) - (this._held('pitchDown') ? 1 : 0);
    // Left minus right, which looks backwards and is not.
    //
    // The flight model's internal convention is that a positive yaw command
    // produces a left turn — verified by measuring heading change, not assumed.
    // Mapping D to +1 therefore steered the ship left. The sign is corrected
    // here, at the boundary, rather than inside the flight model, because the
    // model's coupling signs are all consistent with each other and re-deriving
    // three of them to fix one key binding is how that consistency gets broken.
    let wantYaw = (this._held('yawLeft') ? 1 : 0) - (this._held('yawRight') ? 1 : 0);
    const wantRoll = (this._held('rollRight') ? 1 : 0) - (this._held('rollLeft') ? 1 : 0);

    // Mouse steers as a displacement from centre rather than as a rate, so the
    // stick returns when the hand does. A rate-based mouse in a ship with
    // rotational inertia compounds into an uncontrollable spin.
    if (this.useMouse && this.pointer) {
      const mx = clamp(this.pointer.x * this.mouseSensitivity, -1, 1);
      const my = clamp(this.pointer.y * this.mouseSensitivity, -1, 1);
      if (Math.abs(mx) > 0.02) wantYaw = clamp(wantYaw - mx, -1, 1);
      if (Math.abs(my) > 0.02) wantPitch = clamp(wantPitch + my, -1, 1);
    }

    this.pitch = this._shape(this.pitch, wantPitch, dt);
    this.yaw = this._shape(this.yaw, wantYaw, dt);
    this.roll = this._shape(this.roll, wantRoll, dt);

    // --- throttle ---------------------------------------------------------
    // A held axis, not a toggle. The ship should be flyable at any power
    // setting, because the whole signature system depends on the player
    // choosing to travel slowly.
    if (this._held('throttleUp')) this.throttle = clamp01(this.throttle + dt * 0.55);
    if (this._held('throttleDn')) this.throttle = clamp01(this.throttle - dt * 0.75);

    if (this._pressed('cutEngines')) this.cutEngines = !this.cutEngines;
    if (this._pressed('lights')) { this.lightsOn = !this.lightsOn; this.lightsToggled = true; }
    if (this._pressed('scan')) this.scanRequested = true;

    return this;
  }

  _shape(current, want, dt) {
    const rate = Math.abs(want) > Math.abs(current) ? this.attackRate : this.releaseRate;
    return approach(current, want, rate, dt);
  }

  /** Write the current commands into a flight model. */
  applyTo(ship) {
    ship.input.pitch = this.pitch;
    ship.input.yaw = this.yaw;
    ship.input.roll = this.roll;
    ship.input.throttle = this.cutEngines ? 0 : this.throttle;
    ship.input.boost = !this.cutEngines && this._held('boost');
    ship.input.brake = this._held('brake');
    ship.input.lateral = (this._held('strafeR') ? 1 : 0) - (this._held('strafeL') ? 1 : 0);
    ship.input.vertical = (this._held('liftUp') ? 1 : 0) - (this._held('liftDown') ? 1 : 0);
    return ship;
  }

  /** Consume the edge-triggered flags. */
  consumeEdges() {
    const out = { scan: this.scanRequested, lights: this.lightsToggled };
    this.scanRequested = false;
    this.lightsToggled = false;
    return out;
  }
}

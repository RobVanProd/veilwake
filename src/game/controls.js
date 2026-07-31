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
import { PAD } from '../core/gamepad.js';

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
  constructor(input, pointer = null, pad = null) {
    this.input = input;
    this.pointer = pointer;
    this.pad = pad;

    /** Which device last moved. Drives which prompts the interface shows. */
    this.lastDevice = 'keyboard';

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

    /**
     * The keyboard and the pad genuinely disagree about pitch: W is forward and
     * pitches *down* like a flight stick, while pushing the pad stick forward
     * pitches *up*. That is not an oversight — the two were flown separately and
     * each was called correct on its own device, which is the usual outcome
     * because a stick sits under the thumb and a key sits under the finger.
     * Left as-is, with a switch for anyone whose hands say otherwise.
     */
    this.invertPadPitch = false;
    this.padSensitivity = 1.0;
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
    // Roll shares yaw's convention: a positive command rolls *left*. Measured by
    // driving roll = +1 and reading the right wing's height, not assumed — the
    // model's internal signs are self-consistent, and both flips belong here at
    // the boundary rather than inside it.
    let wantRoll = (this._held('rollLeft') ? 1 : 0) - (this._held('rollRight') ? 1 : 0);

    // Mouse steers as a displacement from centre rather than as a rate, so the
    // stick returns when the hand does. A rate-based mouse in a ship with
    // rotational inertia compounds into an uncontrollable spin.
    if (this.useMouse && this.pointer) {
      const mx = clamp(this.pointer.x * this.mouseSensitivity, -1, 1);
      const my = clamp(this.pointer.y * this.mouseSensitivity, -1, 1);
      if (Math.abs(mx) > 0.02) wantYaw = clamp(wantYaw - mx, -1, 1);
      if (Math.abs(my) > 0.02) wantPitch = clamp(wantPitch + my, -1, 1);
    }

    // --- gamepad ----------------------------------------------------------
    //
    // Sticks are applied *after* the key shaping and are not passed through it.
    // A stick is already a continuous displacement, correct on arrival; running
    // it through a smoother built for square-wave keys only adds latency, and
    // that is the usual reason pad support ends up feeling worse than the
    // keyboard it was meant to improve.
    let padActive = false;
    if (this.pad && this.pad.connected) {
      const a = this.pad.axes, tr = this.pad.triggers;

      // Left stick flies: horizontal is yaw, vertical is pitch. The flight
      // model turns left on positive yaw, so the stick is negated here for the
      // same reason the D key is.
      if (Math.abs(a.lx) > 0.001 || Math.abs(a.ly) > 0.001) {
        const s = this.padSensitivity;
        wantYaw = clamp(wantYaw - a.lx * s, -1, 1);
        wantPitch = clamp(wantPitch - a.ly * s * (this.invertPadPitch ? -1 : 1), -1, 1);
        padActive = true;
      }
      // Right stick rolls. Deliberately not a second flight axis: the right
      // stick is where a player expects to look, and giving it authority over
      // attitude as well makes the ship feel like it is fighting them.
      if (Math.abs(a.rx) > 0.001) {
        wantRoll = clamp(wantRoll - a.rx * this.padSensitivity, -1, 1);
        padActive = true;
      }

      // Right trigger is throttle as an absolute position, not an increment.
      // This is the single biggest gain from a pad in this game: the whole
      // signature system asks the player to choose a power setting and hold it,
      // and an analog trigger makes that one gesture instead of a negotiation
      // with two keys.
      if (tr.right > 0.001) { this.throttle = tr.right; padActive = true; }
      if (tr.left > 0.001) padActive = true;

      if (this.pad.wasPressed(PAD.LS)) this.cutEngines = !this.cutEngines;
      if (this.pad.wasPressed(PAD.Y)) { this.lightsOn = !this.lightsOn; this.lightsToggled = true; }
      if (this.pad.wasPressed(PAD.X)) this.scanRequested = true;
      if (this.pad.buttons.size) padActive = true;
    }
    if (padActive) this.lastDevice = 'gamepad';

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
    const padBoost = this.pad && this.pad.connected &&
      (this.pad.held(PAD.A) || this.pad.triggers.left > 0.6);
    const padBrake = this.pad && this.pad.connected && this.pad.held(PAD.B);
    ship.input.boost = !this.cutEngines && (this._held('boost') || padBoost);
    ship.input.brake = this._held('brake') || padBrake;
    ship.input.lateral = (this._held('strafeR') ? 1 : 0) - (this._held('strafeL') ? 1 : 0);
    ship.input.vertical = (this._held('liftUp') ? 1 : 0) - (this._held('liftDown') ? 1 : 0);
    return ship;
  }

  /**
   * Drive the pad's motors from hull state.
   *
   * A continuous level rather than a series of events, because what it is
   * reporting is continuous: how hard the machine is working and how much the
   * medium is shaking it. The low motor carries engine and turbulence, the high
   * one carries electrical activity and damage — the same split the audio uses,
   * so the two channels agree about what is happening.
   *
   * This is also a gameplay readout: engine vibration is a signature the player
   * is trying to manage, and feeling it in the hands is the most direct possible
   * feedback that they are being loud.
   */
  updateRumble(ship, extra = {}) {
    if (!this.pad || !this.pad.connected) return;
    const t = ship.telemetry();
    const low = clamp01(t.throttle * 0.34 + t.boost * 0.40 + t.turbulence * 0.30);
    const high = clamp01((extra.electrical || 0) * 0.5 + (extra.damage || 0) * 0.35 + t.gLoad / 90 * 0.2);
    this.pad.setRumble(low, high);
  }

  /** Consume the edge-triggered flags. */
  consumeEdges() {
    const out = { scan: this.scanRequested, lights: this.lightsToggled };
    this.scanRequested = false;
    this.lightsToggled = false;
    return out;
  }
}

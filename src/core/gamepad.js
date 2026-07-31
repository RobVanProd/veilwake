// Gamepad input, and rumble.
//
// Worth doing properly here rather than as a keyboard emulation, for two
// reasons that are specific to this game.
//
// First, `controls.js` spends real effort smoothing digital keys into something
// that does not feel like a square wave, and a stick does not need any of it —
// it is already a continuous displacement. Running an analog axis through the
// key smoother adds latency to an input that was correct on arrival, which is
// the most common way gamepad support ends up feeling worse than the keyboard it
// was meant to improve.
//
// Second, the ship's **vibration is a gameplay signature**. The player is
// supposed to be constantly aware of how much noise their machine is making, and
// a rumble motor is a channel that says exactly that without occupying the
// screen or the mix. The rumble here is driven from hull state, never from
// events: it is a continuous readout, not a series of thumps.

import { clamp, clamp01 } from './math.js';

/**
 * Standard-layout button indices. Named because `buttons[7]` in flight code is
 * how a binding change becomes an hour of confusion.
 */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5,
  LT: 6, RT: 7,
  BACK: 8, START: 9,
  LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  GUIDE: 16,
};

export const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 };

export class Gamepad {
  constructor({ index = null } = {}) {
    this.index = index;
    this.connected = false;
    this.id = '';
    this.mapping = '';

    /**
     * Radial deadzone, not per-axis.
     *
     * A per-axis deadzone is the usual shortcut and it produces a square dead
     * region: pushing the stick diagonally at low deflection gives nothing on
     * either axis, then snaps to both at once. On a ship that is flown with
     * small continuous corrections that reads as the controls sticking.
     */
    this.deadzone = 0.14;

    /**
     * Response curve exponent. Above 1 gives fine control near centre while
     * keeping the full range at the edge, which is what a vehicle wants; a
     * linear stick makes small heading corrections almost impossible.
     */
    this.curve = 1.6;

    this.triggerDeadzone = 0.06;

    this.axes = { lx: 0, ly: 0, rx: 0, ry: 0 };
    this.triggers = { left: 0, right: 0 };
    this.buttons = new Set();
    this.pressed = new Set();
    this.released = new Set();

    this._prev = new Set();
    this._rumble = { low: 0, high: 0, until: 0 };
    this._lastRumbleSent = -1;

    addEventListener('gamepadconnected', (e) => {
      if (this.index === null) this.index = e.gamepad.index;
    });
    addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.index) { this.index = null; this.connected = false; }
    });
  }

  /** The raw pad, or null. */
  _pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.index !== null && pads[this.index]) return pads[this.index];
    // Adopt the first connected pad, so plugging one in mid-session works
    // without a menu.
    for (const p of pads) if (p && p.connected) { this.index = p.index; return p; }
    return null;
  }

  /** Radial deadzone plus curve, applied to a stick pair. */
  _stick(x, y) {
    const mag = Math.hypot(x, y);
    if (mag < this.deadzone) return [0, 0];
    // Rescale so the value just outside the deadzone starts at zero rather than
    // jumping straight to `deadzone` — without this the stick has a visible step.
    const scaled = Math.min(1, (mag - this.deadzone) / (1 - this.deadzone));
    const shaped = Math.pow(scaled, this.curve);
    const k = shaped / mag;
    return [x * k, y * k];
  }

  update() {
    const p = this._pad();
    this.connected = !!p;
    if (!p) {
      this.axes.lx = this.axes.ly = this.axes.rx = this.axes.ry = 0;
      this.triggers.left = this.triggers.right = 0;
      this.buttons.clear();
      return this;
    }

    this.id = p.id;
    this.mapping = p.mapping;

    const [lx, ly] = this._stick(p.axes[AXIS.LX] || 0, p.axes[AXIS.LY] || 0);
    const [rx, ry] = this._stick(p.axes[AXIS.RX] || 0, p.axes[AXIS.RY] || 0);
    this.axes.lx = lx; this.axes.ly = ly;
    this.axes.rx = rx; this.axes.ry = ry;

    // Triggers are analog buttons in the standard mapping, but some drivers
    // expose them as axes 4/5 in the -1..1 range instead. Handle both, because
    // getting this wrong means the throttle is either dead or stuck at half.
    const btn = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
    let lt = btn(PAD.LT), rt = btn(PAD.RT);
    if (lt === 0 && rt === 0 && p.axes.length > 5) {
      lt = (p.axes[4] + 1) * 0.5;
      rt = (p.axes[5] + 1) * 0.5;
    }
    const td = this.triggerDeadzone;
    this.triggers.left = lt < td ? 0 : (lt - td) / (1 - td);
    this.triggers.right = rt < td ? 0 : (rt - td) / (1 - td);

    this._prev = new Set(this.buttons);
    this.buttons.clear();
    for (let i = 0; i < p.buttons.length; i++) {
      if (p.buttons[i] && p.buttons[i].pressed) this.buttons.add(i);
    }
    this.pressed.clear(); this.released.clear();
    for (const b of this.buttons) if (!this._prev.has(b)) this.pressed.add(b);
    for (const b of this._prev) if (!this.buttons.has(b)) this.released.add(b);

    this._sendRumble(p);
    return this;
  }

  held(b) { return this.buttons.has(b); }
  wasPressed(b) { return this.pressed.has(b); }
  wasReleased(b) { return this.released.has(b); }

  /**
   * Set the continuous rumble level.
   *
   * Two motors with different characters, used for different things: the heavy
   * low-frequency motor carries engine and hull vibration, and the sharper
   * high-frequency one carries impacts and electrical activity. Driven every
   * frame as a *level*, so it reads as a machine running rather than as a series
   * of alerts.
   */
  setRumble(low, high = 0) {
    this._rumble.low = clamp01(low);
    this._rumble.high = clamp01(high);
  }

  /** A one-off knock, for a real impact. Decays on its own. */
  pulse(strength = 0.6, seconds = 0.18) {
    this._rumble.until = performance.now() + seconds * 1000;
    this._rumble.pulseLow = clamp01(strength);
    this._rumble.pulseHigh = clamp01(strength * 0.8);
  }

  _sendRumble(pad) {
    const act = pad.vibrationActuator;
    if (!act || !act.playEffect) return;

    let low = this._rumble.low, high = this._rumble.high;
    if (performance.now() < this._rumble.until) {
      low = Math.max(low, this._rumble.pulseLow || 0);
      high = Math.max(high, this._rumble.pulseHigh || 0);
    }

    // Re-issuing an identical effect every frame floods the driver and on some
    // pads causes the motors to stutter rather than hold. Only send when the
    // level has actually moved, and give each effect a duration slightly longer
    // than the resend interval so it never gaps.
    const level = Math.round(low * 40) * 41 + Math.round(high * 40);
    if (level === this._lastRumbleSent) return;
    this._lastRumbleSent = level;

    try {
      act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: 220,
        weakMagnitude: high,
        strongMagnitude: low,
      });
    } catch { /* unsupported; rumble is optional everywhere */ }
  }

  stopRumble() {
    this._rumble.low = this._rumble.high = 0;
    this._rumble.until = 0;
    const p = this._pad();
    if (p && p.vibrationActuator && p.vibrationActuator.reset) {
      try { p.vibrationActuator.reset(); } catch { /* ignore */ }
    }
  }
}

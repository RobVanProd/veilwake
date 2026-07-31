// Control polarity: does each input move the ship the way its name says?
//
// This file exists because polarity bugs cost two round-trips with the player,
// and neither was catchable by reading the code. The flight model's internal
// convention is that a *positive* yaw or roll command turns **left**, which is
// self-consistent and perfectly defensible — but it means every input binding is
// one forgotten minus sign away from steering backwards, and a backwards control
// is invisible in a diff and obvious within a second of flying.
//
// Two rules learned the hard way, both of which this file obeys:
//
// 1. **Measure world motion, never command signs.** Asserting that pressing D
//    produces `yaw === -1` tests that the code does what it does. The question
//    is which way the nose actually went.
//
// 2. **Never measure with `atan2` against a world axis.** The first version of
//    this test used `atan2(forward.x, forward.z)` as a heading and reported yaw
//    inverted when it was correct — very nearly "fixing" working code. Every
//    check below projects the new forward onto the ship's *own* axes from before
//    the input, so no world-space convention can enter the result at all.

import { Controls } from '../src/game/controls.js';
import { Flight } from '../src/game/flight.js';

const DT = 1 / 120;
const SETTLE = 180;  // steps to reach steady level flight before the input
const HOLD = 90;     // steps holding the input
const EPS = 0.02;    // below this, call it "no motion" rather than noise

/** A pad that reports exactly what a test tells it to. */
function stubPad() {
  return {
    connected: true,
    axes: { lx: 0, ly: 0, rx: 0, ry: 0 },
    triggers: { left: 0, right: 0 },
    buttons: new Set(),
    held: () => false,
    wasPressed: () => false,
    setRumble() {},
  };
}

/**
 * Fly with an input held, and report which way the ship went in its own frame.
 * @param {(keys: Set<string>, pad: object) => void} setup
 */
export function fly(setup) {
  const keys = new Set();
  const pad = stubPad();
  const input = { held: (k) => keys.has(k), wasPressed: () => false, endFrame() {} };
  const controls = new Controls(input, null, pad);
  controls.useMouse = false;                 // the pointer is not under test

  const ship = new Flight();
  ship.input.throttle = 0.6;
  for (let i = 0; i < SETTLE; i++) ship.step(DT);

  // The ship's own axes, captured before the input. Everything is measured
  // against these, so no world convention can leak into the answer.
  const right0 = ship.right.clone();
  const up0 = ship.up.clone();

  setup(keys, pad);
  for (let i = 0; i < HOLD; i++) { controls.update(DT).applyTo(ship); ship.step(DT); }

  const f = ship.forward;
  const sideways = f.dot(right0);   // nose swung toward the old right wing
  const vertical = f.dot(up0);      // nose swung toward the old canopy
  const wing = ship.right.y;        // right wing high or low

  return {
    turn: sideways > EPS ? 'right' : sideways < -EPS ? 'left' : 'none',
    // Rolling right drops the right wing, so a negative wing height is a right roll.
    roll: wing < -EPS ? 'right' : wing > EPS ? 'left' : 'none',
    nose: vertical > EPS ? 'up' : vertical < -EPS ? 'down' : 'none',
    sideways, vertical, wing,
  };
}

export const CASES = [
  // --- yaw: the keyboard ------------------------------------------------
  ['A yaws left',        (k) => k.add('KeyA'),          'turn', 'left'],
  ['D yaws right',       (k) => k.add('KeyD'),          'turn', 'right'],

  // --- yaw: the pad ------------------------------------------------------
  ['stick right yaws right', (k, p) => { p.axes.lx = 0.9; },  'turn', 'right'],
  ['stick left yaws left',   (k, p) => { p.axes.lx = -0.9; }, 'turn', 'left'],

  // --- roll --------------------------------------------------------------
  // The bug the player found: the right stick rolled the wrong way, and the
  // keyboard shared it silently because Q and E are rarely the first thing
  // anyone tries.
  ['E rolls right',      (k) => k.add('KeyE'),          'roll', 'right'],
  ['Q rolls left',       (k) => k.add('KeyQ'),          'roll', 'left'],
  ['right stick right rolls right', (k, p) => { p.axes.rx = 0.9; },  'roll', 'right'],
  ['right stick left rolls left',   (k, p) => { p.axes.rx = -0.9; }, 'roll', 'left'],

  // --- pitch -------------------------------------------------------------
  // Note the deliberate asymmetry: W (forward) pitches *down* like a flight
  // stick, while the pad stick forward pitches *up*. The two devices genuinely
  // disagree, and that is a preference rather than a bug — the player flew the
  // pad and called it right, so the default stands and `invertPadPitch` exists
  // for anyone who wants the other one. These cases pin the defaults so the
  // disagreement stays intentional rather than drifting.
  ['W pitches down',     (k) => k.add('KeyW'),          'nose', 'down'],
  ['S pitches up',       (k) => k.add('KeyS'),          'nose', 'up'],
  ['stick forward pitches up',  (k, p) => { p.axes.ly = -0.9; }, 'nose', 'up'],
  ['stick back pitches down',   (k, p) => { p.axes.ly = 0.9; },  'nose', 'down'],
];

/** Run every case. Returns { pass, fail, results }. */
export function run() {
  const results = CASES.map(([name, setup, field, want]) => {
    const got = fly(setup);
    return { name, want, got: got[field], ok: got[field] === want, detail: got };
  });
  return {
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok),
    results,
  };
}

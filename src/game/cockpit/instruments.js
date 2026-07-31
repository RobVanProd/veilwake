// The instruments.
//
// Every glowing thing in the cockpit is in one indexed mesh with one material
// and one draw call, and no vertex of it is ever rewritten. A bar graph is a row
// of quads that differ only in a number saying how far along the bar they sit;
// the fill is a comparison in the fragment shader against a uniform. That is why
// there is no per-frame allocation in an instrument panel — because there is no
// per-frame work at all beyond writing five floats.
//
// What they read, and why these five:
//
//   AIRSPEED   the only number the pilot steers by
//   ENERGY     what boost and lights are spent from
//   THROTTLE   commanded, so it can disagree with airspeed — which it does, and
//              that disagreement is the ship telling the player it is heavy
//   MEDIUM     density of the vapour the ship is actually inside. The one
//              readout that is about the world rather than the machine, and the
//              only cold-coloured thing on the panel.
//   TURBULENCE what the medium is doing to the hull
//
// GAME_VISION §1: the instruments are "limited, honest and slightly behind
// reality". They are not a HUD. There is no contact display here, nothing names
// a creature, and nothing on this panel will ever tell the player they are being
// hunted — Pillar 3 says the world does that.
//
// They are also DIM. In a frame whose median luminance is in the thirties these
// read easily at a linear value near 0.11, and the palette pass spent its entire
// budget getting brightness out of this game. The panel is not allowed to put it
// back; what it is allowed to be is the only warm thing within the player's
// reach.

import { Emis } from './builder.js';
import { LAYOUT } from './layout.js';

/** Gauge addresses. Shared with cockpit.js, which writes them. */
export const GAUGE = {
  AIRSPEED: 0,
  ENERGY: 1,
  THROTTLE: 2,
  MEDIUM: 3,
  TURBULENCE: 4,
  STALL: 5,
  LAMPS: 6,
  BOOST: 7,
  // --- the signature cluster ---------------------------------------------
  // The six channels from signature.js, in CHANNELS order, so that the panel
  // and the model cannot drift out of step: cockpit.js writes these by walking
  // CHANNELS itself rather than by naming them here.
  SIG_ACOUSTIC: 8,
  SIG_THERMAL: 9,
  SIG_PHOTIC: 10,
  SIG_EM: 11,
  SIG_WAKE: 12,
  SIG_RELSPEED: 13,
  /** Total exposure — the one number, per signature.js exposure(). */
  EXPOSURE: 14,
  /** The worst single channel. This is the warning light. */
  ALERT: 15,
};

/** Where the six channel columns start. Must stay contiguous and in CHANNELS
 *  order; cockpit.js writes `SIG_BASE + i` as it walks CHANNELS. */
export const SIG_BASE = GAUGE.SIG_ACOUSTIC;

/** A lamp's `frac` is negative: the shader reads its gauge as brightness. */
const LAMP = -1;
/** An always-on mark belongs to no gauge. */
const ETCH = -1;

/**
 * Panel colours.
 *
 * Warm by default and cold only where the readout is about the world outside.
 * The first pass gave the medium, turbulence and lamp readouts full-strength
 * cold values and, measured against the amber next to them, they came back
 * brighter — three pale blue-green blocks that took the "only warm thing in the
 * player's reach" away from the panel it was supposed to belong to. The cold
 * ones are now carried at roughly half the luminance of the warm ones, so they
 * are legible and they are never the thing the eye goes to first.
 */
const COL = {
  speed: [1.00, 0.60, 0.20],
  energy: [1.00, 0.52, 0.16],
  throttle: [1.00, 0.68, 0.30],
  medium: [0.16, 0.46, 0.38],
  turb: [0.26, 0.38, 0.50],
  stall: [1.00, 0.20, 0.05],
  boost: [1.00, 0.36, 0.09],
  lamps: [0.36, 0.42, 0.52],
  etch: [0.68, 0.44, 0.22],

  /**
   * The signature cluster: one colour for all six channels.
   *
   * Giving each channel its own hue is the obvious build and it is wrong. Six
   * differently coloured bars read as six unrelated instruments, and the thing
   * the player has to learn is that these are six faces of one quantity — the
   * shape of the whole cluster is the reading, not any single bar. A real engine
   * stack does the same thing with six identical EGT columns for the same
   * reason. Identity is carried by position, which is free and never ambiguous.
   *
   * Dimmer than the flight instruments on purpose. This is the readout the
   * player will end up staring at, and the palette pass spent its whole budget
   * getting brightness out of the frame; a cluster that competes with the window
   * would put it straight back.
   */
  sig: [0.74, 0.44, 0.17],
  /** Total exposure. Hotter than the channels, because it is the summary. */
  exposure: [1.00, 0.56, 0.14],
  /** The warning light. The only pure red in the cockpit besides the stall lamp,
   *  and it is off almost all of the time — which is what makes it mean anything. */
  alert: [1.00, 0.16, 0.04],
};

/** Lifted off the panel so it cannot z-fight, along the face normal. */
const LIFT = 0.004;

/**
 * A point on a sloping panel face, in ship space.
 *
 * `u` is across the face in x; `s` runs 0 at the upper, further edge to 1 at the
 * lower, nearer one. About the last 16% of every face is below the bottom of the
 * frame, so nothing is placed past s = 0.80.
 */
function facePoint(face, u, s) {
  const dy = face.aftY - face.fwdY, dz = face.aftZ - face.fwdZ;
  const len = Math.hypot(dy, dz);
  // Face normal, in the yz plane, pointing up and back at the pilot.
  const ny = dz / len, nz = -dy / len;
  return [u, face.fwdY + dy * s + ny * LIFT, face.fwdZ + dz * s + nz * LIFT];
}

/** One quad on a face. Wound so that its front side is the one facing the eye. */
function facePatch(e, face, u0, u1, s0, s1, color, gauge, frac) {
  e.quad(
    facePoint(face, u0, s0), facePoint(face, u0, s1),
    facePoint(face, u1, s1), facePoint(face, u1, s0),
    color, gauge, frac);
}

/** A segmented bar. `dir` +1 fills left to right, -1 right to left. */
function bar(e, face, u0, u1, s0, s1, n, color, gauge, dir = 1) {
  const span = (u1 - u0) / n;
  const gap = span * 0.19;
  for (let k = 0; k < n; k++) {
    const a = u0 + span * k + gap * 0.5;
    const b = a + span - gap;
    const frac = (k + 0.5) / n;
    facePatch(e, face, a, b, s0, s1, color, gauge, dir > 0 ? frac : 1 - frac);
  }
}

/**
 * A segmented column, filling upward — up the panel, away from the pilot.
 *
 * `sTop` is the far end, `sBot` the near one, and the fill runs from `sBot`
 * toward `sTop` as the value rises, which is the direction every stacked meter
 * has run since gauges were mechanical. Building it the other way is a
 * surprisingly easy mistake to make from the `s` parameterisation alone, where
 * larger is nearer, and it produces a cluster that empties as the ship gets
 * louder.
 */
function column(e, face, u0, u1, sTop, sBot, n, color, gauge) {
  const h = (sBot - sTop) / n;
  const gap = h * 0.22;
  for (let k = 0; k < n; k++) {
    const b = sBot - h * k - gap * 0.5;
    const a = b - h + gap;
    facePatch(e, face, u0, u1, a, b, color, gauge, (k + 0.5) / n);
  }
}

export function buildInstruments() {
  const e = new Emis();
  const p = LAYOUT.pod;

  const faceOf = (sign) => ({
    fwdY: p.faceFwdY, fwdZ: p.faceFwdZ, aftY: p.faceAftY, aftZ: p.faceAftZ,
    u0: sign < 0 ? -(p.outer - 0.015) : p.inner + 0.015,
    u1: sign < 0 ? -(p.inner + 0.015) : p.outer - 0.015,
  });

  // --- left pod: the machine's own state ----------------------------------
  {
    const F = faceOf(-1);
    // Airspeed. Fourteen segments, because a bar the pilot has to count is a bar
    // that is being read rather than glanced at, and glancing is the point.
    bar(e, F, F.u0, F.u1, 0.09, 0.235, 14, COL.speed, GAUGE.AIRSPEED);
    // Commanded throttle, under it, shorter, so the gap between what was asked
    // for and what the ship is doing is a length difference and not a number.
    bar(e, F, F.u0, F.u0 + (F.u1 - F.u0) * 0.62, 0.33, 0.425, 9, COL.throttle, GAUGE.THROTTLE);
    // Stall, at the outboard end of the throttle row. It moved here from the
    // centre well when the well became the signature cluster, and it belongs
    // here anyway: stall is a fact about the wing, and this is the wing's pod.
    facePatch(e, F, F.u0 + (F.u1 - F.u0) * 0.72, F.u1, 0.33, 0.425,
      COL.stall, GAUGE.STALL, LAMP);
    // Etched scale marks. Always lit, very dim: the panel has to have a shape in
    // total darkness or the cockpit disappears the moment the sun is behind.
    for (let k = 0; k <= 4; k++) {
      const u = F.u0 + (F.u1 - F.u0) * (k / 4);
      facePatch(e, F, u - 0.004, u + 0.004, 0.50, 0.545, COL.etch, ETCH, 0);
    }
    facePatch(e, F, F.u0, F.u1, 0.62, 0.638, COL.etch, ETCH, 0);
  }

  // --- right pod: the machine against the medium --------------------------
  {
    const F = faceOf(1);
    bar(e, F, F.u0, F.u1, 0.09, 0.235, 14, COL.energy, GAUGE.ENERGY);
    // Density of the vapour the ship is in. Cold, and the only cold thing here.
    bar(e, F, F.u0 + (F.u1 - F.u0) * 0.38, F.u1, 0.33, 0.425, 9, COL.medium, GAUGE.MEDIUM);
    // Exterior lights: a lamp, not a bar. It is on or it is not, and when it is
    // on the ship is broadcasting.
    facePatch(e, F, F.u0, F.u0 + 0.10, 0.33, 0.425, COL.lamps, GAUGE.LAMPS, LAMP);
    // Boost, beside it. Both of these are things the player switched on, and
    // both are expensive on the signature — so they sit together, next to the
    // energy bar they are spending.
    facePatch(e, F, F.u0 + 0.12, F.u0 + 0.22, 0.33, 0.425, COL.boost, GAUGE.BOOST, LAMP);
    // What the medium is doing to the hull.
    bar(e, F, F.u0, F.u1, 0.50, 0.565, 6, COL.turb, GAUGE.TURBULENCE);
    facePatch(e, F, F.u0, F.u1, 0.62, 0.638, COL.etch, ETCH, 0);
  }

  // --- the well: the signature cluster ------------------------------------
  //
  // Six columns, one per channel, in CHANNELS order left to right: acoustic,
  // thermal, photic, em, wake, relSpeed. Under them, total exposure as a wide
  // bar, and under that the warning light.
  //
  // This is the most important instrument in the ship and it is in the least
  // valuable piece of panel, which is the correct trade rather than a
  // compromise. The well sits below the deck line, so it is under the horizon
  // and in front of nothing; the player can read the whole cluster's *shape*
  // with a glance that never leaves the window, and reading a shape is what this
  // readout is for. Putting it at eye level would make it a HUD, and GAME_VISION
  // §1 is explicit that these instruments are not a HUD.
  //
  // Nothing here names a creature or reports being hunted — Pillar 3 says the
  // world does that. All this panel says is how loud the ship currently is,
  // which is a fact about the machine and the one the player is steering by.
  {
    const w = LAYOUT.well;
    const F = { fwdY: w.topY, fwdZ: w.fwdZ, aftY: w.topY * 0.35, aftZ: w.aftZ };
    const u0 = -w.halfWidth + 0.018, u1 = w.halfWidth - 0.018;
    const pitch = (u1 - u0) / 6;

    for (let i = 0; i < 6; i++) {
      const a = u0 + pitch * i + pitch * 0.16;
      const b = u0 + pitch * (i + 1) - pitch * 0.16;
      // Eight segments. Enough that the cluster has a readable silhouette,
      // few enough that no one is ever tempted to count them.
      column(e, F, a, b, 0.10, 0.545, 8, COL.sig, SIG_BASE + i);
    }

    // Total exposure, across the full width under the columns.
    bar(e, F, u0, u1, 0.60, 0.665, 12, COL.exposure, GAUGE.EXPOSURE);

    // The warning light: the worst single channel, not the average. A ship can
    // be quiet on five channels and still be lit up like a flare on the sixth,
    // and the average would hide exactly that.
    facePatch(e, F, u0 + pitch * 1.5, u1 - pitch * 1.5, 0.705, 0.755,
      COL.alert, GAUGE.ALERT, LAMP);

    // Etched division marks between the channel columns, always faintly lit, so
    // the cluster still has a shape when every channel reads zero.
    for (let i = 1; i < 6; i++) {
      const u = u0 + pitch * i;
      facePatch(e, F, u - 0.0025, u + 0.0025, 0.10, 0.545, COL.etch, ETCH, 0);
    }
  }

  return e;
}

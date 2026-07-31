// Mood, as a regression test.
//
// The palette is the easiest thing in this project to lose. Every future change
// that makes something "clearer" — a brighter lamp, a lifted ambient so a
// creature reads better, a nudge to exposure so a HUD is legible — pushes the
// frame back toward the daylight it started as, and each one is individually
// reasonable. Nobody ever decides to undo the art direction; it just erodes.
//
// So the direction is asserted rather than described. These are BANDS, not
// exact values: the point is not to freeze the look, it is to catch the day it
// stops being dark. A change that moves a number inside its band is fine and
// needs no permission. A change that leaves the band is a decision, and should
// have to be an explicit one.
//
// The bands come from measurement, not taste. The reference numbers:
//   before the mood pass, sunward — p50 190, dynamic 1.31, litFrac 65.3%
//   after,                sunward — p50  36, dynamic 6.75, litFrac 15.8%
//
// Two failure modes are guarded, and the second is the one worth explaining.
// Making the frame dark is trivially easy — scale the sun down and every
// contrast metric improves. Measured: sun x0.3 gave a beautiful-looking dynamic
// range while litFrac fell to 0.00 and the hue separation collapsed from 61.6 to
// 11.3. That image is not doom, it is an unlit scene. `litFrac` and
// `coldShadowSep` exist to fail that.

import { measureMood } from '../tools/mood.js';

/** Where the camera is put, relative to the sun. Both directions are the game. */
export const POSES = {
  // Into the sun: the case that was a washout, and the one god rays live in.
  toward: { sign: 1, lift: 40 },
  // Away from the sun: correctly dark. Guarded loosely because what belongs in
  // this half of the sky is the ship's own lamp, not the sun.
  away: { sign: -1, lift: 20 },
};

/**
 * @param {object} GAME the live game object
 * @param {{sign:number,lift:number}} pose
 */
export function shoot(GAME, pose, atSeconds = 66) {
  const C = GAME.clouds;
  const s = C.sun;
  const P = new GAME.THREE.Vector3(-90, 225, -190);
  GAME.seek(atSeconds);
  GAME.camera.position.copy(P);
  GAME.camera.lookAt(
    P.x + s.x * 1000 * pose.sign,
    P.y + pose.lift,
    P.z + s.z * 1000 * pose.sign,
  );
  GAME.camera.updateMatrixWorld();
  C.renderFrame(GAME.renderer, GAME.scene, GAME.camera);
  return measureMood(GAME.renderer);
}

const CASES = [
  // --- the frame must be dark -------------------------------------------
  { name: 'sunward frame is not daylight', pose: 'toward',
    check: (m) => m.p50 <= 70, got: (m) => `p50 ${m.p50}`, want: '<= 70' },
  { name: 'away frame is dark', pose: 'away',
    check: (m) => m.p50 <= 55, got: (m) => `p50 ${m.p50}`, want: '<= 55' },

  // --- but something in it must blaze -----------------------------------
  // The anti-cheat. Without this, turning the lights off passes every other case.
  { name: 'sunward: something is genuinely blazing', pose: 'toward',
    check: (m) => m.litFrac >= 0.8, got: (m) => `litFrac ${m.litFrac}%`, want: '>= 0.8%' },
  { name: 'sunward: not so much is blazing that it is weather again', pose: 'toward',
    check: (m) => m.litFrac <= 30, got: (m) => `litFrac ${m.litFrac}%`, want: '<= 30%' },

  // --- shafts in a dark room --------------------------------------------
  { name: 'sunward has real dynamic range', pose: 'toward',
    check: (m) => m.dynamic >= 3.0, got: (m) => `p99/p50 ${m.dynamic}`, want: '>= 3.0' },

  // --- the world is cold, and warmth is information ---------------------
  { name: 'sunward is not warm overall', pose: 'toward',
    check: (m) => m.warmth <= 2, got: (m) => `warmth ${m.warmth}`, want: '<= 2' },
  { name: 'away is cold', pose: 'away',
    check: (m) => m.warmth <= 0, got: (m) => `warmth ${m.warmth}`, want: '<= 0' },
  // Light warmer than shadow. Goes negative above sigmaT 0.22, which is the
  // measured point where the frame turns monochrome and the palette inverts.
  { name: 'sunward: light is warmer than shadow', pose: 'toward',
    check: (m) => m.coldShadowSep >= 4, got: (m) => `sep ${m.coldShadowSep}`, want: '>= 4' },

  // --- highlights must keep their shape ---------------------------------
  // A clipped highlight has no form, and the biggest objects in the game lose
  // their silhouette exactly where they are most lit.
  { name: 'highlights are not clipping to flat white', pose: 'toward',
    check: (m) => m.blownFrac <= 2.0, got: (m) => `blown ${m.blownFrac}%`, want: '<= 2%' },
];

export function run(GAME) {
  const shots = {};
  for (const [k, p] of Object.entries(POSES)) shots[k] = shoot(GAME, p);
  const results = CASES.map((c) => {
    const m = shots[c.pose];
    const ok = c.check(m);
    return { name: `${c.name}`, ok, want: c.want, got: c.got(m), pose: c.pose };
  });
  return { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok), results, shots };
}

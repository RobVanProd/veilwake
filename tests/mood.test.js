// Mood, as a regression test.
//
// The palette is the easiest thing in this project to lose. Every future change
// that makes something "clearer" — a brighter lamp, a lifted ambient so a
// creature reads, a nudge to exposure so a HUD is legible — pushes the frame
// back toward the daylight it started as, and each one is individually
// reasonable. Nobody ever decides to undo an art direction; it just erodes.
//
// THE FIRST VERSION OF THIS FILE WAS WORTHLESS, and how it failed is the most
// useful thing in it. It pinned ONE hand-placed camera at ONE sim time and
// reported 21/21 green while an adversarial pass, sweeping the camera the player
// actually looks through, found the art direction failing at 10 of 14 sampled
// times and continuously from t=120 to t=480. A test that samples a single
// moment does not measure a game, it measures a screenshot — and it gave a
// confident green light to a build whose default experience was still the exact
// "bland and too perky" the owner complained about.
//
// So this version obeys three rules, each of which the old one broke:
//
//   1. **Use the camera the player uses.** ShipCamera, driven by the ship, not a
//      camera teleported to a flattering spot. Note that shipCam.update() is a
//      silent no-op until ship.step() has run — it reads cached basis vectors —
//      so any evidence gathered by posing the ship by hand and calling update()
//      is invalid. The sim is stepped for real here.
//   2. **Sample across time.** The weather advects and the ship moves, so a mood
//      that holds at t=66 says nothing about t=300. Failures are reported as a
//      fraction of moments, because "usually right" is the property that matters.
//   3. **Render at a real size.** With the browser pane hidden the canvas never
//      resizes and sits at 300x150, so the old numbers came from 2850 sampled
//      pixels. Every measurement here forces a known size first.
//
// The bands are deliberately bands, not exact values: a change that moves a
// number inside its band needs no permission. Leaving one should be a decision.

import { measureMood } from '../tools/mood.js';

/** Sim times to sample. Spread across a run long enough for weather to change. */
export const TIMES = [40, 120, 200, 300, 420, 540];

/** How many of the sampled moments are allowed to fail before the suite does. */
const TOLERATED_FAILURE_FRACTION = 0.25;

const W = 640, H = 360;

/**
 * Advance the real simulation to `t` and render through the real ship camera.
 * Returns the mood of the frame the player would actually be looking at.
 */
export function sampleAt(GAME, t) {
  const C = GAME.clouds;
  GAME.seek(t);                       // steps the loop, so ship basis vectors are live
  GAME.renderer.setSize(W, H, false);
  GAME.camera.aspect = W / H;
  GAME.camera.updateProjectionMatrix();
  // One more real step so the spring camera has settled onto this frame's ship.
  GAME.loop.stepHeadless(2);
  C.renderFrame(GAME.renderer, GAME.scene, GAME.camera);
  const m = measureMood(GAME.renderer, 2);
  m.t = t;
  m.shipY = +GAME.ship.position.y.toFixed(0);
  return m;
}

/** The properties a frame must have. Each returns true when the frame is fine. */
const CHECKS = [
  { name: 'not daylight', want: 'p50 <= 90', f: (m) => m.p50 <= 90, got: (m) => `p50 ${m.p50}` },
  { name: 'not a wall of blaze', want: 'litFrac <= 35%', f: (m) => m.litFrac <= 35, got: (m) => `litFrac ${m.litFrac}%` },
  { name: 'not warm overall', want: 'warmth <= 4', f: (m) => m.warmth <= 4, got: (m) => `warmth ${m.warmth}` },
  { name: 'has dynamic range', want: 'p99/p50 >= 2.2', f: (m) => m.dynamic >= 2.2, got: (m) => `dyn ${m.dynamic}` },
  // The anti-cheat, and the one that matters most. Scaling the sun down improves
  // every contrast number while litFrac goes to zero. Measured: sun x0.3 gave a
  // beautiful dynamic range with litFrac 0.00 and hue separation collapsed from
  // 61.6 to 11.3. That image is not doom, it is an unlit scene.
  { name: 'something is blazing', want: 'litFrac >= 0.4%', f: (m) => m.litFrac >= 0.4, got: (m) => `litFrac ${m.litFrac}%` },
  { name: 'highlights keep their shape', want: 'blown <= 2%', f: (m) => m.blownFrac <= 2, got: (m) => `blown ${m.blownFrac}%` },
];

export function run(GAME) {
  const samples = TIMES.map((t) => sampleAt(GAME, t));
  const results = [];

  // Per-property, across time. A property that holds at every sampled moment is
  // the claim being made; one that holds sometimes is reported with the moments
  // it failed, because that is the information needed to fix it.
  for (const c of CHECKS) {
    const bad = samples.filter((m) => !c.f(m));
    const frac = bad.length / samples.length;
    const ok = frac <= TOLERATED_FAILURE_FRACTION;
    results.push({
      name: `${c.name} — through the gameplay camera, over time`,
      ok,
      want: `${c.want} at >= ${Math.round((1 - TOLERATED_FAILURE_FRACTION) * 100)}% of moments`,
      got: bad.length === 0
        ? `all ${samples.length} moments`
        : `failed ${bad.length}/${samples.length} — ` + bad.map((m) => `t${m.t}(${c.got(m)})`).join(', '),
    });
  }

  // The ship must stay in the world. This is not a mood property, but it is what
  // broke the mood: a uniform 0.65 m/s updraft in the flow field carried a level
  // ship from y=140 to y=3303 in ten minutes, out of the band the palette works
  // in. Guarded here because it is invisible in any single frame.
  const ys = samples.map((m) => m.shipY);
  const drift = Math.max(...ys) - Math.min(...ys);
  results.push({
    name: 'the ship stays in the cloud layer with no input',
    ok: drift < 1200 && Math.max(...ys) < 2400,
    want: 'drift < 1200 m and never above 2400 m',
    got: `y ${Math.min(...ys)}..${Math.max(...ys)} (drift ${drift} m)`,
  });

  return { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok), results, samples };
}

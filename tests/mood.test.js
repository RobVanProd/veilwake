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

/**
 * Sim times to sample.
 *
 * Spread across a full luminary cycle, not just far enough for the weather to
 * advect. The veil circles in 900 s and the ember is up between roughly 575 and
 * 1040, so a window that stopped at 540 — as the first version did — would only
 * ever see one light and could not tell a world with three from a world with a
 * sun. They must also be ASCENDING: seek() steps the fixed loop forward and
 * cannot go back, so an out-of-order list silently measures the same frame
 * repeatedly. That mistake produced three identical "different" captures once.
 */
export const TIMES = [60, 260, 460, 700, 950, 1250];

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

/**
 * The properties a frame must have.
 *
 * These were rewritten when the sun was replaced by luminaries, because two of
 * the originals encoded Earth without anyone noticing.
 *
 * `warmth <= 4` assumed the key is warm and the ambient cold, so it read a
 * legitimate copper-lit frame as a failure — under the ember the whole world is
 * *supposed* to be warm and wrong. And `coldShadowSep >= 4` asserted light is
 * warmer than shadow, which is only true beneath a warm key; under a green-cyan
 * one it inverts to -22 while the separation is just as strong. The property
 * that actually matters is that lit and shadow differ in HUE, not which way.
 */
const CHECKS = [
  { name: 'not daylight', want: 'p50 <= 90', f: (m) => m.p50 <= 90, got: (m) => `p50 ${m.p50}` },
  { name: 'not a wall of blaze', want: 'litFrac <= 35%', f: (m) => m.litFrac <= 35, got: (m) => `litFrac ${m.litFrac}%` },
  { name: 'has dynamic range', want: 'p99/p50 >= 2.2', f: (m) => m.dynamic >= 2.2, got: (m) => `dyn ${m.dynamic}` },
  // NOT GREY. The failure ART_DIRECTION names as most likely, and the one no
  // other number here can see: a frame can score a perfect cold warmth of -5 and
  // still be colourless, because R minus B says nothing about how far either is
  // from G. Before the luminaries this measured 0.055 at its worst — grey.
  { name: 'the frame has colour in it', want: 'chroma >= 0.12', f: (m) => m.chroma >= 0.12, got: (m) => `chroma ${m.chroma}` },
  // Lit and shadow differ in hue. Direction-agnostic on purpose: which way it
  // points is a fact about which luminary is up, not about whether the frame
  // works.
  { name: 'light and shadow differ in hue', want: '|sep| >= 6', f: (m) => Math.abs(m.coldShadowSep) >= 6, got: (m) => `sep ${m.coldShadowSep}` },
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

  // --- properties of the RUN, not of any one frame -----------------------
  //
  // These cannot be checked per-moment, and they are what the luminaries exist
  // for. A world lit by a sun passes every per-frame check above and still fails
  // both of these, because a sun is always the same colour and always there.

  // Something blazes SOMEWHERE. Per-frame this would be wrong — under the drown
  // alone the sky is genuinely dark and litFrac is correctly 0 — but a session
  // in which nothing is ever bright is an unlit scene rather than a dark one,
  // which is the exact cheat the old anti-cheat existed to catch.
  const brightest = Math.max(...samples.map((m) => m.litFrac));
  results.push({
    name: 'somewhere in the run, something blazes',
    ok: brightest >= 3,
    want: 'peak litFrac >= 3%',
    got: `brightest moment ${brightest.toFixed(2)}%`,
  });

  // The light CHANGES. ART_DIRECTION: "when the palette does shift, it should
  // mean something", and GAME_VISION's third beat lists "a light that was there
  // is not" as a warning the session structure depends on. Neither is writable
  // against a sun. A spread this wide can only come from more than one luminary.
  const warms = samples.map((m) => m.warmth);
  const warmthRange = Math.max(...warms) - Math.min(...warms);
  results.push({
    name: 'the light changes over the run',
    ok: warmthRange >= 25,
    want: 'warmth varies by >= 25 across the run',
    got: `warmth spans ${Math.min(...warms).toFixed(1)} to ${Math.max(...warms).toFixed(1)} (${warmthRange.toFixed(1)})`,
  });

  // Cold is the default and warmth is the event, not the other way round. Stated
  // as a median so one copper-lit moment is allowed to be exactly what it is.
  const sortedWarm = warms.slice().sort((a, b) => a - b);
  const medianWarm = sortedWarm[Math.floor(sortedWarm.length / 2)];
  results.push({
    name: 'cold is the default, warmth is the event',
    ok: medianWarm <= 0,
    want: 'median warmth <= 0',
    got: `median ${medianWarm.toFixed(1)}`,
  });

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

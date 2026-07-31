// The corridors, as a regression test.
//
// This carve existed on paper for a long time before it existed on screen, and
// the way it failed is the reason this file is here. Every part was present and
// correct — `CorridorField` modelled the tube, aged it, refilled it and served
// `clearance()`; the Listener carried a field and queried it; §2.3's duct test
// used it, so the creature's own hearing already travelled further down its own
// corridors. The renderer never carved, and the creature's `carving` flag
// defaults to false so that contract tests can pin one behaviour at a time,
// which meant the field in the running game stayed permanently empty.
//
// Nothing failed. Every unit test passed. The TRACE beat said SOMETHING CAME
// THROUGH HERE over undisturbed cloud for weeks.
//
// So these assertions deliberately span the seam rather than testing either side
// of it: the field carves, the renderer is told, the CPU density drops, and the
// CPU and the GPU still agree about what the field looks like afterwards. Any
// one of those breaking silently reproduces the original bug.

const SEG = 150;

/** Build a straight corridor through a point and register it with the renderer. */
function carveThrough(GAME, at, segments = 12) {
  // Whichever creature carves — the Listener today, but the test should not
  // care which slot the manager happens to be holding it in.
  const c = GAME.creatures.creatures.find((x) => x.corridor);
  if (!c) throw new Error('no creature carries a CorridorField');
  const f = c.corridor;
  f.reset();
  const t = GAME.loop.simTime;
  for (let k = 0; k < segments; k++) f.carve(at.x + k * SEG, at.y, at.z, t);
  f.tick(t);
  GAME.clouds.corridors.length = 0;
  GAME.clouds.corridors.push(f);
  GAME.clouds._packCorridors(at.x, at.y, at.z);
  return f;
}

/**
 * A point with real cloud in it, measured on an uncarved field.
 *
 * Deterministic on purpose. Math.random() here would make a marginal assertion
 * fail one run in twenty and pass on the retry, which is the failure mode that
 * teaches people to re-run the suite instead of reading it.
 */
function findCloud(GAME) {
  const C = GAME.clouds;
  C.corridors.length = 0;
  C._packCorridors(0, 0, 0);
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ 0x85ebca6b) >>> 0;
    return s / 4294967296;
  };
  let best = { x: 0, y: 700, z: 0, d: 0 };
  for (let i = 0; i < 8000; i++) {
    const x = (rnd() * 2 - 1) * 7000;
    const z = (rnd() * 2 - 1) * 7000;
    const y = 450 + rnd() * 600;
    const d = C.densityAt(x, y, z);
    if (d > best.d) best = { x, y, z, d };
    if (best.d > 0.5) break;
  }
  return best;
}

export function run(GAME) {
  const C = GAME.clouds;
  const results = [];
  const at = findCloud(GAME);
  const rawDensity = at.d;

  const f = carveThrough(GAME, at);
  const packed = C.marchUniforms.uCorridorCount.value;

  // 1. The field carves at all. This is the assertion that would have caught the
  //    original bug on its own: `carving` defaulting to false meant zero
  //    segments ever existed in the running game.
  results.push({
    name: 'a corridor has segments and reaches the renderer',
    ok: f.count > 0 && packed > 0,
    want: 'segments > 0 and packed into the march uniforms',
    got: `${f.count} segments, ${packed} packed`,
  });

  // 2. The carve removes what the contract says it removes. `strength` is 0.92,
  //    so on the axis 8% of the density survives.
  const onAxis = C.densityAt(at.x, at.y, at.z);
  const expected = rawDensity * (1 - f.strength);
  results.push({
    name: 'density on the axis drops by CorridorField.strength',
    ok: rawDensity > 0.05 && Math.abs(onAxis - expected) < Math.max(0.02, expected * 0.15),
    want: `${rawDensity.toFixed(3)} x (1 - ${f.strength}) = ${expected.toFixed(3)}`,
    got: onAxis.toFixed(3),
  });

  // 3. It is a tube, not a global dimming. A point outside the radius is
  //    untouched, and the edge is soft rather than a step — a hard wall would
  //    make the acoustic spreading exponent snap as a creature crossed it.
  //
  //    Probe ACROSS the corridor, never along it. The first version of this
  //    walked +x, which is the direction `carveThrough` lays segments down, and
  //    read 0.08 at three times the radius — correctly, since it never left the
  //    tunnel. It looked like the falloff was broken. Measuring along a corridor
  //    measures nothing.
  const rel = (dz) => C._carve(at.x - C.origin.x, at.y - C.origin.y, at.z + dz - C.origin.z);
  const inside = rel(0), edge = rel(f.radiusM * 0.9), outside = rel(f.radiusM * 3);
  results.push({
    name: 'the corridor is a soft-edged tube, not a global dimming',
    ok: inside < 0.2 && edge > inside && edge < 1 && Math.abs(outside - 1) < 1e-6,
    want: 'axis carved, edge partial, well outside untouched',
    got: `axis ${inside.toFixed(3)}, 0.9r ${edge.toFixed(3)}, 3r ${outside.toFixed(3)}`,
  });

  // 4. The renderer's copy agrees with the field's own maths. These are two
  //    implementations of `clearance()` — one in corridor.js for the creature's
  //    senses, one packed into uniforms for the march — and if they drift, what
  //    a creature hears and what the player sees stop being the same world.
  const fieldSays = f.clearance(at.x, at.y, at.z);
  const rendererSays = inside;
  results.push({
    name: 'the renderer and the creature agree about the corridor',
    ok: Math.abs(fieldSays - rendererSays) < 0.01,
    want: 'CorridorField.clearance() === CloudSystem._carve()',
    got: `field ${fieldSays.toFixed(3)}, renderer ${rendererSays.toFixed(3)}`,
  });

  // 5. And the GPU still matches the CPU with a carve live. verifyAgreement is
  //    the only thing standing between "the creatures sense the field the player
  //    sees" and a game that quietly lies about where the cloud is.
  const agree = C.verifyAgreement(GAME.renderer);
  results.push({
    name: 'CPU and GPU still agree with corridors live',
    ok: agree.ok,
    want: 'verifyAgreement passes',
    got: `maxAbsError ${agree.maxAbsError}, ${agree.cloudySamples} cloudy samples`,
  });

  // 6. Corridors refill. §10.1 says they last "several minutes" — if they were
  //    permanent the sky would fill up with tunnels over a long session.
  const t0 = GAME.loop.simTime;
  f.tick(t0 + f.lifeSec + 1);
  C._packCorridors(at.x, at.y, at.z);
  const afterLife = C.marchUniforms.uCorridorCount.value;
  f.tick(t0);
  C._packCorridors(at.x, at.y, at.z);
  results.push({
    name: 'a corridor closes once it is older than its life',
    ok: afterLife === 0,
    want: `nothing packed after ${f.lifeSec} s`,
    got: `${afterLife} segments still packed`,
  });

  // Leave the world as we found it.
  f.reset();
  C.corridors.length = 0;
  C._packCorridors(0, 0, 0);

  return { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok), results };
}

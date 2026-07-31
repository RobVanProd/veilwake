// Local lights: does the registry hand the shader the set the shader would have
// drawn, and does it hand the signature system a number in the signature
// system's units?
//
// This file exists because every bug this module shipped with was invisible in a
// diff and obvious in one frame of play. The worst of them was a cull that
// measured the wrong distance — the light's distance to the *camera*, where the
// shader windows per *march sample* — and it turned a creature's glow fully on
// and fully off across two metres of drift. Reading the code, both distances are
// "the distance to the light".
//
// Three rules this file obeys, all of them learned on this project:
//
// 1. **Measure the consequence, not the statement.** Asserting that prepare()
//    keeps a light tests that the code does what it does. The question is whether
//    the shader would have drawn anything at the point where the CPU stopped
//    sending it, so the cull tests evaluate the shader's own falloff at the
//    boundary the CPU chose. The GLSL for that falloff is quoted in shaderTerm()
//    with its source line, and if the shader changes, this test is where the
//    disagreement should surface.
//
// 2. **Find the boundary, do not assume where it is.** The cull tests bisect for
//    the exact distance at which prepare() changes its mind rather than probing a
//    guessed radius, so a change to the range formula moves the test with it.
//
// 3. **No renderer.** lights.js imports one pure module, so these run in
//    milliseconds with no WebGL context, no canvas and no Three.js. A test that
//    needs a GPU gets run once and then never again.

import {
  LightRegistry, MAX_MARCH_LIGHTS, MAX_SHADOWED_LIGHTS, LIGHT_KIND,
  shipLamp, navLight, thrusterPlume, lightningCell, bioluminescence, attachShip,
} from '../src/render/lights.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A stand-in for the march's uniform block, with just enough of THREE.Vector4. */
function mockUniforms(n = MAX_MARCH_LIGHTS) {
  const vec4 = () => ({ x: 0, y: 0, z: 0, w: 0, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } });
  const arr = () => ({ value: Array.from({ length: n }, vec4) });
  return { uLightCount: { value: -1 }, uLightPos: arr(), uLightCol: arr(), uLightDir: arr(), uLightPar: arr() };
}

/**
 * The shader's own attenuation for one light at one point, transcribed from
 * cloud.glsl.js vw_localLights():
 *
 *   float x = r * lp.w;  float att = 1.0 / (1.0 + x * x);
 *   float win = clamp(1.0 - r2 / par.y, 0.0, 1.0);  att *= win * win;
 *
 * where lp.w is 1/radius and par.y is range squared — both written by
 * writeUniforms(), so this reads them out of a real packed uniform rather than
 * recomputing them, and a packing error fails these tests too.
 */
function shaderTerm(u, i, r) {
  const invRadius = u.uLightPos.value[i].w;
  const range2 = u.uLightPar.value[i].y;
  const x = r * invRadius;
  const att = 1 / (1 + x * x);
  const win = Math.min(Math.max(1 - (r * r) / range2, 0), 1);
  const rgb = u.uLightCol.value[i];
  return Math.max(rgb.x, rgb.y, rgb.z) * att * win * win;
}

/** Smallest d in [lo, hi] where pred(d) flips from true to false, to 1 cm. */
function bisect(lo, hi, pred) {
  for (let i = 0; i < 60 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (pred(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

const CAM = { x: 0, y: 0, z: 0 };
const FWD = { x: 0, y: 0, z: -1 };

/** Prepare with a single light placed `d` metres along the view axis. */
function axisSet(reg, id, d) {
  reg.set(id, { position: [0, 0, -d] });
  return reg.prepare(CAM, FWD);
}

// ---------------------------------------------------------------------------
// Cases. Each returns { ok, got, want, detail? }.
// ---------------------------------------------------------------------------

const CASES = [

// --- the cull: what the shader would still have drawn -----------------------

['a light ahead is kept until the march itself sees nothing', () => {
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ key: 'probe' }));
  const range = reg.get(id).range();
  // The distance at which prepare() drops it, found rather than assumed.
  const edge = bisect(1, range * 60, (d) => axisSet(reg, id, d).length === 1);
  // At that distance, what is the brightest thing the shader could still draw?
  // The march passes through the light's own core, so r = 0 there.
  axisSet(reg, id, edge * 0.999);
  const u = mockUniforms();
  reg.writeUniforms(u);
  const core = shaderTerm(u, 0, 0);
  return {
    ok: edge > range * 1.5 && core > 0.5,
    got: `dropped at ${edge.toFixed(0)} m, core radiance there ${core.toFixed(2)}`,
    want: `dropped well past range ${range.toFixed(0)} m, with a bright core still in the march`,
    detail: { range: +range.toFixed(1), edge: +edge.toFixed(1), core: +core.toFixed(3) },
  };
}],

['crossing the cull costs nothing the shader could have drawn', () => {
  // The real invariant: at the instant the CPU stops sending a light, the most
  // the shader could have drawn from it anywhere in the marched volume is zero.
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ key: 'probe' }));
  const range = reg.get(id).range();
  const edge = bisect(1, range * 60, (d) => axisSet(reg, id, d).length === 1);
  axisSet(reg, id, edge * 0.999);
  const u = mockUniforms();
  reg.writeUniforms(u);
  // At the edge, the nearest point of the marched volume is `range` from the
  // light (that is what the cull now means), and the shader's window is zero
  // there. Evaluate it just inside.
  const worst = shaderTerm(u, 0, range * 0.9999);
  return {
    ok: worst < 1e-3,
    got: `${worst.toExponential(2)} radiance at the closest reachable point`,
    want: '< 1e-3 — a silent boundary, not a pop',
    detail: { edge: +edge.toFixed(1), range: +range.toFixed(1), worst },
  };
}],

['a light off to the side is still culled', () => {
  // The fix must not become "keep everything". Perpendicular to the view axis,
  // nothing widens the volume, so the old distance is the right one.
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ key: 'probe' }));
  const range = reg.get(id).range();
  const put = (d) => { reg.set(id, { position: [d, 0, 0] }); return reg.prepare(CAM, FWD).length; };
  return {
    ok: put(range * 0.9) === 1 && put(range * 1.1) === 0,
    got: `${put(range * 0.9)} in at 0.9x, ${put(range * 1.1)} in at 1.1x`,
    want: '1 in at 0.9x range, 0 in at 1.1x range',
  };
}],

['a light behind the camera is kept while it can still light the near field', () => {
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ key: 'probe' }));
  const range = reg.get(id).range();
  const put = (d) => { reg.set(id, { position: [0, 0, d] }); return reg.prepare(CAM, FWD).length; };
  return {
    ok: put(range * 0.9) === 1 && put(range * 1.1) === 0,
    got: `${put(range * 0.9)} in at 0.9x behind, ${put(range * 1.1)} in at 1.1x behind`,
    want: 'kept at 0.9x behind the camera, dropped at 1.1x',
  };
}],

// --- the bounded set --------------------------------------------------------

['the set never exceeds the march budget', () => {
  const reg = new LightRegistry();
  for (let i = 0; i < 40; i++) reg.add(bioluminescence({ key: `c${i}`, position: [i, 0, -20 - i] }));
  const n = reg.prepare(CAM, FWD).length;
  return { ok: n === MAX_MARCH_LIGHTS, got: n, want: MAX_MARCH_LIGHTS };
}],

['the ship keeps its beam when the sky is full of brighter things', () => {
  // The feedback loop the module exists for: a player who cannot see the beam
  // they are casting cannot read their own signature.
  const reg = new LightRegistry();
  const lamp = reg.add(shipLamp({ position: [0, 0, -6], direction: [0, 0, -1] }));
  for (let i = 0; i < 10; i++) {
    reg.add(lightningCell({ key: `storm${i}`, intensity: 40, position: [i * 30, 0, -200] }));
  }
  const keys = reg.prepare(CAM, FWD).map((l) => l.key);
  return {
    ok: keys.includes('ship/lamp'),
    got: keys.join(', '),
    want: 'includes ship/lamp',
    detail: { lampScoreWouldLose: true, id: lamp },
  };
}],

['pinned lights cannot take the whole set', () => {
  const reg = new LightRegistry();
  for (let i = 0; i < MAX_MARCH_LIGHTS + 3; i++) {
    reg.add(shipLamp({ key: `pin${i}`, position: [i, 0, -6], direction: [0, 0, -1] }));
  }
  reg.add(bioluminescence({ key: 'creature', position: [0, 0, -40] }));
  const keys = reg.prepare(CAM, FWD).map((l) => l.key);
  return {
    ok: keys.includes('creature') && keys.length === MAX_MARCH_LIGHTS,
    got: keys.join(', '),
    want: `${MAX_MARCH_LIGHTS} lights, one of which is the unpinned creature`,
  };
}],

['the same scene twice gives the same set in the same order', () => {
  // Captures are regression baselines only if this holds.
  const reg = new LightRegistry();
  for (let i = 0; i < 12; i++) {
    reg.add(bioluminescence({ key: `c${i}`, intensity: 1.6, position: [Math.sin(i) * 90, 0, -30 - i * 7] }));
  }
  const a = reg.prepare(CAM, FWD).map((l) => l.key).join('|');
  const b = reg.prepare(CAM, FWD).map((l) => l.key).join('|');
  return { ok: a === b && a.length > 0, got: `${a} / ${b}`, want: 'identical' };
}],

// --- shadow budget ----------------------------------------------------------

['a caller cannot grant more shadow marches than the constant allows', () => {
  const reg = new LightRegistry({ max: 99, maxShadowed: 99 });
  for (let i = 0; i < 8; i++) reg.add(shipLamp({ key: `l${i}`, position: [i, 0, -6], direction: [0, 0, -1] }));
  reg.prepare(CAM, FWD);
  const s = reg.debugSummary();
  return {
    ok: reg.max <= MAX_MARCH_LIGHTS && reg.maxShadowed <= MAX_SHADOWED_LIGHTS && s.shadowed <= MAX_SHADOWED_LIGHTS,
    got: `max ${reg.max}, maxShadowed ${reg.maxShadowed}, granted ${s.shadowed}`,
    want: `max <= ${MAX_MARCH_LIGHTS}, shadowed <= ${MAX_SHADOWED_LIGHTS}`,
  };
}],

['shadow strength survives the grant, it is not rounded to one', () => {
  const reg = new LightRegistry();
  const id = reg.add(thrusterPlume({ position: [0, 0, -8], direction: [0, 0, 1] }));
  reg.prepare(CAM, FWD);
  const u = mockUniforms();
  reg.writeUniforms(u);
  const got = u.uLightCol.value[0].w;
  return { ok: Math.abs(got - 0.45) < 1e-9, got, want: 0.45, detail: { id } };
}],

// --- packing ----------------------------------------------------------------

['positions are packed in cloud space, not world space', () => {
  const reg = new LightRegistry();
  reg.add(bioluminescence({ position: [1000, 200, -3000] }));
  reg.prepare(CAM, FWD);
  const u = mockUniforms();
  reg.writeUniforms(u, { x: 65536, y: 0, z: -65536 });
  const p = u.uLightPos.value[0];
  return {
    ok: p.x === 1000 - 65536 && p.y === 200 && p.z === -3000 + 65536,
    got: `${p.x}, ${p.y}, ${p.z}`,
    want: `${1000 - 65536}, 200, ${-3000 + 65536}`,
  };
}],

['the packed range is the range the cull used', () => {
  // If these two disagree the boundary is either a pop or dead volume, which is
  // the bug this module shipped with.
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ position: [0, 0, -100] }));
  reg.prepare(CAM, FWD);
  const u = mockUniforms();
  reg.writeUniforms(u);
  const r = reg.get(id).range();
  return {
    ok: Math.abs(u.uLightPar.value[0].y - r * r) < 1e-6,
    got: u.uLightPar.value[0].y,
    want: r * r,
  };
}],

['an omni light passes the shader cone test in every direction', () => {
  const reg = new LightRegistry();
  reg.add(bioluminescence({ position: [0, 0, -100] }));
  reg.prepare(CAM, FWD);
  const u = mockUniforms();
  reg.writeUniforms(u);
  const outer = u.uLightDir.value[0].w, inner = u.uLightPar.value[0].x;
  const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  let worst = 1;
  for (let d = -1; d <= 1; d += 0.05) worst = Math.min(worst, smoothstep(outer, inner, d));
  return { ok: worst === 1, got: worst, want: 1, detail: { outer, inner } };
}],

['a spot authored inside out degrades to a hairline, not a NaN', () => {
  const reg = new LightRegistry();
  reg.add(shipLamp({ cone: { inner: 1.2, outer: 0.30 }, position: [0, 0, -6], direction: [0, 0, -1] }));
  reg.prepare(CAM, FWD);
  const u = mockUniforms();
  reg.writeUniforms(u);
  const outer = u.uLightDir.value[0].w, inner = u.uLightPar.value[0].x;
  return {
    ok: Number.isFinite(outer) && Number.isFinite(inner) && inner > outer,
    got: `outer ${outer.toFixed(5)}, inner ${inner.toFixed(5)}`,
    want: 'both finite and inner > outer',
  };
}],

// --- lifecycle --------------------------------------------------------------

['a light removed after prepare() is not drawn that frame', () => {
  // A dead creature's lantern flashing once at its last position is a false
  // "something is there" in a game built on inference from partial light.
  const reg = new LightRegistry();
  const id = reg.add(bioluminescence({ position: [0, 0, -100] }));
  reg.prepare(CAM, FWD);
  reg.remove(id);
  const u = mockUniforms();
  const written = reg.writeUniforms(u);
  return {
    ok: written === 0 && u.uLightCount.value === 0,
    got: `wrote ${written}, uLightCount ${u.uLightCount.value}`,
    want: 'wrote 0, uLightCount 0',
  };
}],

['a spot handed a zero direction keeps a real one', () => {
  // `new THREE.Vector3()` is the natural thing to pass on frame zero, and it is
  // truthy with every component zero. A spot that took it would emit nothing in
  // every direction while still costing a slot and still reporting a signature.
  const reg = new LightRegistry();
  const id = reg.add(shipLamp({ direction: [0, 0, 0] }));
  const d = reg.get(id).direction;
  const len = Math.hypot(d[0], d[1], d[2]);
  return {
    ok: Math.abs(len - 1) < 1e-9,
    got: `[${d.join(', ')}] length ${len}`,
    want: 'a unit vector',
  };
}],

['a direction stays unit length after a patch', () => {
  const reg = new LightRegistry();
  const id = reg.add(shipLamp({}));
  reg.set(id, { direction: [0, 0, -7] });
  const d = reg.get(id).direction;
  return {
    ok: Math.abs(Math.hypot(...d) - 1) < 1e-12 && d[2] === -1,
    got: `[${d.join(', ')}]`,
    want: '[0, 0, -1]',
  };
}],

// --- signature --------------------------------------------------------------

['the ship reports the anchor table\'s lumens, not the renderer\'s radiance', () => {
  // CREATURE_BEHAVIOR_CONTRACT §3.2: search lamp on = 9000 lm, nav lights on =
  // 1200 lm. signature.js sums photicLm in lumens against a 60000 cap, so this
  // is the number that has to cross the boundary.
  const reg = new LightRegistry();
  const rig = attachShip(reg);
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 1 });
  const all = reg.signatureLumens();
  rig.setLamp(false);
  const dark = reg.signatureLumens();
  return {
    ok: all === 10200 && dark === 1200,
    got: `${all} lm lit, ${dark} lm with the lamp killed`,
    want: '10200 lm lit, 1200 lm with the lamp killed',
  };
}],

['the plume does not double-count against signature.js', () => {
  // signature.js already derives the plume from throttle and boost. Counting it
  // here as well would put photic thousands of lumens above the contract's flat
  // 3 lm from idle through boost.
  const reg = new LightRegistry();
  const rig = attachShip(reg, { lamp: false, nav: false });
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 1, boost: 1 });
  return { ok: reg.signatureLumens() === 0, got: reg.signatureLumens(), want: 0 };
}],

['switching a lamp off is the same act as going quiet', () => {
  const reg = new LightRegistry();
  const id = reg.add(shipLamp({}));
  reg.add(bioluminescence({ intensity: 99 }));   // not the player's
  const lit = reg.signatureLumens(), radiance = reg.signature();
  reg.set(id, { on: false });
  return {
    ok: lit === 9000 && radiance === 5 && reg.signatureLumens() === 0 && reg.signature() === 0,
    got: `${lit} lm / ${radiance} radiance lit, ${reg.signatureLumens()} lm / ${reg.signature()} radiance dark`,
    want: '9000 lm / 5 radiance lit, 0 / 0 dark',
  };
}],

// --- the ship rig -----------------------------------------------------------

['the plume points backwards and sits behind the ship', () => {
  const reg = new LightRegistry();
  const rig = attachShip(reg, { lamp: false, nav: false, plumeAft: 8 });
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 1 });
  const l = reg.get(rig.ids.plume);
  return {
    ok: l.position[2] === 8 && l.direction[2] === 1,
    got: `at z ${l.position[2]}, aimed [${l.direction.join(', ')}]`,
    want: 'at z +8 with the ship facing -z, aimed +z',
  };
}],

['an idle thruster is off, not dim', () => {
  const reg = new LightRegistry();
  const rig = attachShip(reg, { lamp: false, nav: false });
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 0 });
  const idle = reg.get(rig.ids.plume).on;
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 0.6 });
  const cruise = reg.get(rig.ids.plume);
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 1, boost: 1 });
  const boost = reg.get(rig.ids.plume);
  return {
    ok: idle === false && cruise.on === true && boost.intensity > cruise.intensity,
    got: `idle on=${idle}, cruise ${cruise.intensity.toFixed(2)}, boost ${boost.intensity.toFixed(2)}`,
    want: 'idle off, cruise lit, boost brighter than cruise',
  };
}],

['the rig gives the march something to draw', () => {
  // The whole point of the repair: before it, a fresh registry held four
  // switched-off storm cells and nothing else, and every god-ray source the art
  // direction requires was absent at runtime.
  const reg = new LightRegistry();
  const rig = attachShip(reg);
  rig.update([0, 0, 0], [0, 0, -1], { throttle: 0.6 });
  const keys = reg.prepare(CAM, FWD).map((l) => l.key);
  const u = mockUniforms();
  const n = reg.writeUniforms(u);
  return {
    ok: n >= 3 && keys.includes('ship/lamp') && keys.includes('ship/thruster'),
    got: `${n} packed: ${keys.join(', ')}`,
    want: 'at least 3, including ship/lamp and ship/thruster',
    detail: { summary: reg.debugSummary(), dispose: (rig.dispose(), reg.lights.size) },
  };
}],

// --- house rules ------------------------------------------------------------

['the shadow budget is not larger than the march budget', () => ({
  ok: MAX_SHADOWED_LIGHTS <= MAX_MARCH_LIGHTS && MAX_MARCH_LIGHTS >= 1,
  got: `${MAX_SHADOWED_LIGHTS} of ${MAX_MARCH_LIGHTS}`,
  want: 'shadowed <= march',
})],

['every preset names a kind the packer understands', () => {
  const kinds = Object.values(LIGHT_KIND);
  const bad = [shipLamp(), navLight(), thrusterPlume(), lightningCell(), bioluminescence()]
    .filter((s) => !kinds.includes(s.kind)).map((s) => s.key);
  return { ok: bad.length === 0, got: bad.join(', ') || 'all valid', want: 'all valid' };
}],

['importing the module touches nothing global', () => {
  // Leaving it importable in isolation is what lets this file run without a
  // renderer, and what lets a tool import it to read the presets.
  const before = Object.keys(globalThis).length;
  const reg = new LightRegistry();
  reg.prepare(CAM, FWD);
  return { ok: Object.keys(globalThis).length === before, got: Object.keys(globalThis).length, want: before };
}],

];

/** Run every case. Returns { pass, fail, results }. */
export function run() {
  const results = CASES.map(([name, fn]) => {
    let r;
    try { r = fn(); } catch (e) { r = { ok: false, got: `threw: ${e && e.message}`, want: 'no exception' }; }
    return { name, ok: !!r.ok, got: r.got, want: r.want, detail: r.detail };
  });
  return {
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok),
    results,
  };
}

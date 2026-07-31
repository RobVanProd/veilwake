// The Wake Hunter, measured.
//
// Same shape as `controls.test.js` and `creature.test.js`: `run()` returns
// `{ pass, fail, results }` and every case reports the number it measured rather
// than the assertion it made.
//
// Two rules this file obeys, both learned elsewhere in this project and both
// expensive to relearn:
//
// 1. **Drive it against the real trail system.** Almost every case below builds a
//    real `Signature` and a real `ShipSystems` and flies a ship through them, so
//    what is under test is the archetype reading the parcels the game actually
//    sheds — with their real decay, their real advection and their real 0.8 m/s
//    climb. A stub trail would let this file pass while the creature read a field
//    that does not exist.
//
// 2. **Check the instrument first.** The first case asserts that the synthetic
//    ship reproduces contract §3.2's cruise and boost anchors. If that fails,
//    every number after it is measuring the wrong ship and the archetype is not
//    the thing to go and fix. Five "the feature is broken" results in this
//    project were all test errors.
//
// Everything here runs headless: no Three.js, no WebGL, no `document` outside
// `mount()`.
//
// HOW TO RUN
//
//   Open any page of the project (http://127.0.0.1:8182/) and paste:
//
//     const T = await import('/tests/wakehunter.test.js?v=' + Date.now()); T.mount();
//
//   `T.report()` returns the same thing as text. The cache-buster is not optional.

import {
  WakeHunter, WakeHunterPack, createWakeHunterPack, WAKE_HUNTER, createTrailView,
} from '../src/game/creatures/wakehunter.js';
import {
  STATE, SENSE_PERIOD, createFlatMedium, countingMedium, vec, vdist, azimuthDir,
} from '../src/game/creatures/creature.js';
import { CreatureManager } from '../src/game/creatures/manager.js';
import { Signature, ShipSystems, SIG, TRAIL } from '../src/game/signature.js';
import { Rng, seedFrom } from '../src/core/rng.js';

const DT = 1 / 120;

const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });
const f = (x, n = 2) => (typeof x === 'number' && isFinite(x) ? x.toFixed(n) : String(x));
const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(b));

// ---------------------------------------------------------------------------
// Synthetic worlds
// ---------------------------------------------------------------------------

/**
 * A ship with just the telemetry `Signature.update` reads.
 *
 * `speed` is metres per second through the world; in still air that is also
 * `relSpeed`, which is what §3.2's anchors are quoted at. `boost` drives
 * `boostSmoothed`, and the two together are what put the ship on the cruise row
 * or the boost row.
 */
function makeShip({ x = 0, y = 0, z = 0, speed = SIG.cruiseRel, heading = 0, boost = 0, climb = 0 } = {}) {
  return {
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    gLoad: 0,
    slipAngle: 0,
    throttleSmoothed: 1,
    boostSmoothed: boost,
    speed, heading, climb,
    step(dt) {
      const d = azimuthDir(this.heading);
      this.velocity.x = d.x * this.speed;
      this.velocity.y = this.climb;
      this.velocity.z = d.z * this.speed;
      this.forward.x = d.x; this.forward.y = 0; this.forward.z = d.z;
      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
      this.position.z += this.velocity.z * dt;
    },
  };
}

/** A `CloudSystem`-shaped stub: clear air, with a stated flow and turbulence. */
function makeAir({ flow = { x: 0, y: 0, z: 0 }, turbulence = 0, density = 0 } = {}) {
  return {
    densityAt: () => density,
    flowAt(x, y, z, out = {}) {
      out.x = flow.x; out.y = flow.y; out.z = flow.z;
      out.turbulence = turbulence;
      return out;
    },
  };
}

/**
 * Fly a ship through a real `Signature` while creatures read its trails.
 *
 * `ctx.trails` is the `Signature` itself; `createTrailView` takes it from there.
 * Nothing hands the creatures `ctx.signature`, because the Wake Hunter has no
 * business reading the recorder — see the archetype's header.
 */
function driveWorld({
  seconds, hunters = [], manager = null, ship, air = null,
  medium = createFlatMedium(), onStep = null, fly = null, systems = undefined,
  clearTrails = false, start = 0,
}) {
  const sig = new Signature({ medium: air });
  const sys = systems === undefined ? new ShipSystems() : systems;
  const ctx = {
    t: start, tick: 0, shipPos: ship.position, medium,
    signature: null, trails: sig, rng: null,
  };
  const n = Math.round(seconds * 120);
  for (let tick = 0; tick < n; tick++) {
    const t = start + tick * DT;
    if (fly) fly(t, ship, sys);
    ship.step(DT);
    sig.update(DT, ship, sys, t);
    if (clearTrails) { sig.wakeTrail.reset(); sig.thermalTrail.reset(); }
    ctx.t = t; ctx.tick = tick; ctx.shipPos = ship.position;
    if (manager) manager.update(DT, tick, ctx);
    else for (let i = 0; i < hunters.length; i++) hunters[i].update(DT, tick, ctx);
    if (onStep) onStep(t, tick, ctx, sig);
  }
  return { sig, sys, ctx };
}

/**
 * Hold a hunter still in a trail of an exactly known strength.
 *
 * The pin is the point: a hunter left free flies out of a single-parcel trail
 * within a couple of seconds, the §4.4 falloff changes under it, and a timing
 * measurement against §5.4 turns into a measurement of how fast it left. Pinning
 * makes the stimulus a constant so the only thing moving is the integrator.
 */
function driveStatic(h, trails, seconds, {
  shipPos = vec(0, 0, 8000), medium = createFlatMedium(), onStep = null, pin = true,
} = {}) {
  const at = vec(h.position.x, h.position.y, h.position.z);
  const ctx = { t: 0, tick: 0, shipPos, medium, signature: null, trails, rng: null };
  const n = Math.round(seconds * 120);
  for (let tick = 0; tick < n; tick++) {
    ctx.t = tick * DT; ctx.tick = tick;
    h.update(DT, tick, ctx);
    if (pin) { h.position.x = at.x; h.position.y = at.y; h.position.z = at.z; }
    if (onStep) onStep(ctx.t, tick, ctx);
  }
  return ctx;
}

/** A hunter with no randomness at all: no false positives, no voice jitter. */
function quietHunter(opts = {}) {
  const h = new WakeHunter({ id: 0, falsePositiveBase: 0, ...opts });
  h.simLevel = 'full';
  return h;
}

/** Wake stimulus in `value` at a stated place: one parcel of §4.4's own shape. */
const oneParcel = (value, age = 10, at = { x: 0, y: 0, z: 0 }) => ({
  wake: [{ x: at.x, y: at.y, z: at.z, value, age }],
  thermal: [],
});

/** Read the archetype's two senses at a point, without moving it there for good. */
function probe(h, ctx, x, y, z) {
  h.position.x = x; h.position.y = y; h.position.z = z;
  const out = h.sense(ctx);
  let wake = 0, thermal = 0;
  for (const p of out) {
    if (!p.real) continue;
    if (p.channel === 'wake') wake = p.strength;
    if (p.channel === 'thermal') thermal = p.strength;
  }
  return { wake, thermal, percepts: out.length };
}

// ---------------------------------------------------------------------------
// 0. The instrument
// ---------------------------------------------------------------------------

test('instrument: the synthetic ship sits on §3.2\'s cruise and boost anchors', () => {
  const read = (boost) => {
    const ship = makeShip({ speed: boost ? SIG.boostRel : SIG.cruiseRel, boost });
    const { sig } = driveWorld({ seconds: 400, ship });
    return { wake: sig.wake, thermal: sig.thermal, acoustic: sig.acoustic, em: sig.em };
  };
  const c = read(0), b = read(1);
  // The anchors, §3.2 rows 3 and 5. Thermal is an integrator with a 90 s
  // constant, so 400 s reaches 98.8% of its steady state and the tolerance has
  // to allow that rather than pretending it is instant.
  const ok = pct(c.wake, 0.60) < 0.05 && pct(c.thermal, 40) < 0.05 && pct(c.acoustic, 46) < 0.02
    && pct(b.wake, 4.0) < 0.05 && pct(b.thermal, 130) < 0.05 && pct(b.acoustic, 78) < 0.02;
  return {
    ok,
    detail: `cruise wake ${f(c.wake, 3)}/0.60  thermal ${f(c.thermal, 1)}/40  acoustic ${f(c.acoustic, 1)}/46 | `
      + `boost wake ${f(b.wake, 3)}/4.00  thermal ${f(b.thermal, 1)}/130  acoustic ${f(b.acoustic, 1)}/78`,
  };
});

test('§4.4 the parcel scan reproduces ParcelField.sample, to float precision', () => {
  // Two independent implementations of one formula is how two systems disagree
  // by 3% in a way nobody can find. This is the check that they do not.
  const ship = makeShip();
  const h = quietHunter({ position: vec(0, 0, 900) });
  let worstWake = 0, worstTherm = 0, samples = 0;
  driveWorld({
    seconds: 40, hunters: [h], ship,
    onStep: (t, tick, ctx, sig) => {
      h.position.x = 0; h.position.y = 0; h.position.z = 900;
      if ((tick % SENSE_PERIOD) !== 0 || tick === 0) return;
      const mineW = h._wakeFit.stimulus, mineT = h._thermalFit.stimulus;
      const refW = sig.sampleWake(0, 0, 900, WAKE_HUNTER.wakeSenseRadiusM);
      const refT = sig.sampleThermal(0, 0, 900, WAKE_HUNTER.thermalSenseRadiusM);
      if (refW > 0) { worstWake = Math.max(worstWake, Math.abs(mineW - refW) / refW); samples++; }
      if (refT > 0) worstTherm = Math.max(worstTherm, Math.abs(mineT - refT) / refT);
    },
  });
  return {
    ok: samples > 20 && worstWake < 1e-9 && worstTherm < 1e-9,
    detail: `${samples} compared sense ticks; worst relative Δ wake ${worstWake.toExponential(2)}, `
      + `thermal ${worstTherm.toExponential(2)}`,
  };
});

// ---------------------------------------------------------------------------
// 1. It senses the trail, and only the trail
// ---------------------------------------------------------------------------

test('§10.3 it cannot smell the ship: 60 m away, loud, with the trail deleted', () => {
  const ship = makeShip();
  const h = quietHunter({ position: vec(60, 0, 0) });
  let percepts = 0, liveWake = 0, liveThermal = 0;
  driveWorld({
    seconds: 120, hunters: [h], ship, clearTrails: true,
    onStep: (t, tick, ctx, sig) => {
      // Pin it beside the ship, so distance is never the reason it fails to see.
      h.position.x = ship.position.x + 60;
      h.position.y = ship.position.y;
      h.position.z = ship.position.z;
      liveWake = sig.wake; liveThermal = sig.thermal;
      percepts += h._percepts.length;
    },
  });
  return {
    ok: percepts === 0 && h.attention === 0 && h.state === STATE.UNAWARE,
    detail: `${percepts} percepts in 120 s at 60 m, attention ${f(h.attention, 4)}, state ${h.state}. `
      + `The ship was emitting wake ${f(liveWake, 2)} s⁻¹ (24× threshold) and thermal `
      + `${f(liveThermal, 1)} ΔK (26× threshold) the whole time.`,
  };
});

test('§10.3 it finds a ship kilometres away by standing in its old trail', () => {
  // The first version of this case parked the hunter 500 m up the ship's own
  // launch line and reported a detection at 34 m — the ship had simply flown
  // through it at t=3.4 s. That measured nothing. The hunter is dormant until
  // the ship is well gone, so the only thing it can possibly be reading is a
  // trail that was laid before it woke up.
  const ship = makeShip();
  const h = quietHunter({ position: vec(0, 0, 500) });
  h.dormant = true;
  let distanceAtDetect = 0, ageAtDetect = 0, tDetect = null;
  driveWorld({
    seconds: 100, hunters: [h], ship,
    onStep: (t, tick, ctx) => {
      if (t >= 40) h.dormant = false;
      h.position.x = 0; h.position.y = 0; h.position.z = 500;   // parked on the road
      if (tDetect === null && h.state !== STATE.UNAWARE) {
        tDetect = t;
        distanceAtDetect = vdist(h.position, ship.position);
        ageAtDetect = h.estimate ? h.estimate.ageSec : 0;
      }
    },
  });
  return {
    ok: tDetect !== null && h.state === STATE.COMMITTED && distanceAtDetect > 4000,
    detail: `woken at t=40 s; first escalation at t=${f(tDetect, 1)} s with the ship `
      + `${f(distanceAtDetect, 0)} m away, on evidence ${f(ageAtDetect, 1)} s old; ended `
      + `${h.state} with the ship ${f(vdist(h.position, ship.position), 0)} m off`,
  };
});

// ---------------------------------------------------------------------------
// 2. §5.4 and §6 — the timing the contract states
// ---------------------------------------------------------------------------

test('§5.4/§6 UNAWARE → COMMITTED at excess 0.4 in the stated 4.2 s', () => {
  // excess 0.4 on the wake channel is a stimulus of 0.05 + 0.4·(2.0 − 0.05) =
  // 0.83 s⁻¹, which is one parcel of 0.83 at zero range (falloff exactly 1).
  const strength = WAKE_HUNTER.wakeThreshold
    + 0.4 * (WAKE_HUNTER.wakeSaturation - WAKE_HUNTER.wakeThreshold);
  const h = quietHunter({ position: vec(0, 0, 0), senseOffset: 0 });
  let tCommit = null, excess = 0;
  driveStatic(h, oneParcel(strength), 20, {
    onStep: (t) => {
      if (h.estimate) excess = (h.estimate.strength - WAKE_HUNTER.wakeThreshold)
        / (WAKE_HUNTER.wakeSaturation - WAKE_HUNTER.wakeThreshold);
      if (tCommit === null && h.state === STATE.COMMITTED) tCommit = t;
    },
  });
  // One sense tick is 0.1 s, so 4.2 s is only resolvable to ±0.1 s by
  // construction; anything inside two ticks of the contract's figure is the
  // contract's figure.
  return {
    ok: tCommit !== null && Math.abs(tCommit - 4.2) <= 0.2,
    detail: `stimulus ${f(strength, 3)} s⁻¹ → excess ${f(excess, 3)}; COMMITTED at `
      + `t=${f(tCommit, 3)} s against the contract's 4.2 (fill 0.55, 10 Hz ticks of 0.022 each)`,
  };
});

test('§6/§7 the whole ladder, up and down, with an event for every transition', () => {
  // A weaker trail so the rungs are far enough apart to read: excess 0.15.
  const strength = WAKE_HUNTER.wakeThreshold
    + 0.15 * (WAKE_HUNTER.wakeSaturation - WAKE_HUNTER.wakeThreshold);
  const h = quietHunter({ position: vec(0, 0, 0), senseOffset: 0 });
  const trail = oneParcel(strength);
  const trace = [];
  let last = h.state;
  const watch = (t) => { if (h.state !== last) { trace.push(`${last}→${h.state} @${f(t, 1)}`); last = h.state; } };
  driveStatic(h, trail, 20, { onStep: watch });
  trail.wake.length = 0;                       // the scent goes cold
  driveStatic(h, trail, 60, { onStep: (t) => watch(t + 20) });

  const log = h.detectionLog();
  const transitions = trace.length;
  const events = log.filter((e) => e.channel !== 'promotion').length;
  const reachedCommitted = trace.some((s) => s.includes('→COMMITTED'));
  const demotedToSearching = trace.some((s) => s.startsWith('COMMITTED→SEARCHING'));
  return {
    ok: transitions === events && reachedCommitted && demotedToSearching && h.state === STATE.UNAWARE,
    detail: `${trace.join('  ')} | ${transitions} transitions, ${events} DetectionEvents`,
  };
});

// ---------------------------------------------------------------------------
// 3. §10.3 — following the trail forwards
// ---------------------------------------------------------------------------

test('§10.3 the fit recovers the ship\'s own speed through the medium', () => {
  // The slope of position against parcel age is |v_ship − flow|, which is
  // contract §4.5's relSpeed. The pack measures how fast its target was going
  // from the trail alone, and nothing told it the number.
  const ship = makeShip({ speed: SIG.cruiseRel });
  const h = quietHunter({ position: vec(0, 0, 600) });
  let measured = 0, conf = 0;
  driveWorld({
    seconds: 40, hunters: [h], ship,
    onStep: () => {
      h.position.x = 0; h.position.y = 0; h.position.z = 600;
      if (h.estimate) { measured = h.estimate.trailSpeedMps; conf = h.estimate.forwardConfidence; }
    },
  });
  return {
    ok: pct(measured, SIG.cruiseRel) < 0.05 && conf > 0.99,
    detail: `measured ${f(measured, 1)} m/s from the parcels alone against the ship's `
      + `${f(SIG.cruiseRel, 1)} (${f(pct(measured, SIG.cruiseRel) * 100, 2)}% out), fit R² ${f(conf, 4)}`,
  };
});

test('§10.3 pursuit is along your own line: it follows the corner, it does not cut it', () => {
  // The ship flies +z for 40 s, turns and flies +x for 40 s, then stops. A
  // creature that could smell the ship would fly the hypotenuse. One that
  // follows a trail forwards has to go round the corner.
  const ship = makeShip({ speed: SIG.cruiseRel, heading: 0 });
  const h = quietHunter({ position: vec(0, 0, 300), heading: 0 });
  const corner = vec(0, 0, SIG.cruiseRel * 40);
  const hypot = { x: 0, y: 0, z: 0 };
  let nearestCorner = Infinity, nearestShip = Infinity, maxCut = 0;
  driveWorld({
    seconds: 170, hunters: [h], ship,
    fly: (t, s) => {
      if (t >= 40 && t < 80) s.heading = Math.PI / 2;
      if (t >= 80) s.speed = 0;
    },
    onStep: (t) => {
      nearestCorner = Math.min(nearestCorner, vdist(h.position, corner));
      nearestShip = Math.min(nearestShip, vdist(h.position, ship.position));
      // How far the hunter ever got from both legs at once: a cut corner shows up
      // as a track that is off the +z leg and off the +x leg simultaneously.
      if (h.position.z < corner.z - 200 && h.position.x > 200) {
        maxCut = Math.max(maxCut, Math.min(h.position.x, corner.z - h.position.z));
      }
    },
  });
  return {
    ok: nearestCorner < 400 && nearestShip < 400 && maxCut < 400,
    detail: `passed within ${f(nearestCorner, 0)} m of the corner at (0, 0, ${f(corner.z, 0)}), `
      + `closed to ${f(nearestShip, 0)} m of the stopped ship, worst corner-cut ${f(maxCut, 0)} m; `
      + `final state ${h.state}`,
  };
});

// ---------------------------------------------------------------------------
// 4. §10.3's three avoidance levers, and its mysterious behaviour
// ---------------------------------------------------------------------------

test('§10.3 lever 3: the heat it hunts is above the path that was flown', () => {
  // The thermal trail climbs at 0.8 m/s, so a two-minute-old parcel is 96 m up.
  // Sweep a probe vertically through an old part of the trail and find the peak.
  const ship = makeShip({ speed: SIG.cruiseRel });
  const { sig } = driveWorld({ seconds: 150, ship });
  const h = quietHunter();
  const ctx = { t: 150, tick: 18000, shipPos: ship.position, medium: createFlatMedium(), trails: sig };
  const age = 120;
  const z = SIG.cruiseRel * (150 - age);
  let bestY = 0, bestT = 0, bestWakeY = 0, bestWake = 0;
  for (let y = -200; y <= 200; y += 4) {
    const r = probe(h, ctx, 0, y, z);
    if (r.thermal > bestT) { bestT = r.thermal; bestY = y; }
    if (r.wake > bestWake) { bestWake = r.wake; bestWakeY = y; }
  }
  const expected = TRAIL.thermalRise * age;
  return {
    ok: Math.abs(bestY - expected) < 20 && Math.abs(bestWakeY) < 20 && bestT > 0,
    detail: `${age} s-old trail: heat peaks ${f(bestY, 0)} m above the flown path `
      + `(0.8 × ${age} = ${f(expected, 0)}), wake peaks at ${f(bestWakeY, 0)} m. `
      + `Descending is safety; climbing puts you in your own history.`,
  };
});

test('§10.3 the mysterious behaviour: in a crosswind the trail is where you never flew', () => {
  // A 12 m/s crossflow carries a 90 s-old trail 1.08 km sideways. The pack that
  // "swings wide in a direction the player never flew" is tracking accurately.
  const U = 12;
  const ship = makeShip({ speed: SIG.cruiseRel });
  const { sig } = driveWorld({ seconds: 130, ship, air: makeAir({ flow: { x: U, y: 0, z: 0 } }) });
  const h = quietHunter();
  const ctx = { t: 130, tick: 15600, shipPos: ship.position, medium: createFlatMedium(), trails: sig };
  const age = 90;
  const z = ship.position.z - SIG.cruiseRel * age;
  const onPath = probe(h, ctx, 0, 0, z);
  const offset = U * age;
  const onTrail = probe(h, ctx, offset, 0, z);
  // Where the peak actually is, swept rather than assumed.
  let bestX = 0, best = 0;
  for (let x = -200; x <= 1600; x += 20) {
    const r = probe(h, ctx, x, 0, z);
    if (r.wake > best) { best = r.wake; bestX = x; }
  }
  return {
    ok: onPath.wake === 0 && onTrail.wake > WAKE_HUNTER.wakeThreshold && Math.abs(bestX - offset) < 120,
    detail: `${age} s-old wake: nothing on the flown line (x=0, stimulus ${f(onPath.wake, 3)}), `
      + `${f(onTrail.wake, 3)} s⁻¹ at x=${f(offset, 0)} m downwind; swept peak at x=${f(bestX, 0)} m `
      + `against 12 m/s × ${age} s = ${f(offset, 0)} m`,
  };
});

test('§10.3 lever 1 and the "three-minute trail": measured trail life, and boost\'s cost', () => {
  // Fly, then cut power and stop, and watch the strongest parcel decay past the
  // Wake Hunter's own 0.05 s⁻¹ threshold. §3.3's worked figures are 106 s for
  // cruise in still air and 188 s for boost; §10.3's lever 1 is that rough air
  // cuts the first of those to about 20 s.
  const life = ({ boost = 0, turbulence = 0 }) => {
    const ship = makeShip({ speed: boost ? SIG.boostRel : SIG.cruiseRel, boost });
    let bornStrength = 0, dead = null, tStop = 30;
    driveWorld({
      seconds: 300, ship, air: makeAir({ turbulence }),
      fly: (t, s, sys) => {
        if (t >= tStop && s.speed !== 0) { s.speed = 0; s.boostSmoothed = 0; sys.powerDown(); }
      },
      onStep: (t, tick, ctx, sig) => {
        if (t < tStop) bornStrength = Math.max(bornStrength, sig.wakeTrail.strongest(t));
        else if (dead === null && sig.wakeTrail.strongest(t) < WAKE_HUNTER.wakeThreshold) dead = t - tStop;
      },
    });
    return { bornStrength, dead };
  };
  const cruise = life({});
  const boosted = life({ boost: 1 });
  const rough = life({ turbulence: 0.8 });
  const ratio = boosted.bornStrength / cruise.bornStrength;
  return {
    // The contract's own worked numbers, within 10%: 106 s, 188 s, ~20 s.
    ok: pct(cruise.dead, 106) < 0.12 && pct(boosted.dead, 188) < 0.12 && pct(rough.dead, 20) < 0.25,
    detail: `still air: cruise trail followable ${f(cruise.dead, 1)} s (contract 106), `
      + `boost ${f(boosted.dead, 1)} s (contract 188 — "three minutes"); rough air (u 0.8) `
      + `cruise ${f(rough.dead, 1)} s (contract ~20). Boost writes ${f(ratio, 2)}× the wake `
      + `strength of cruise (${f(boosted.bornStrength, 2)} vs ${f(cruise.bornStrength, 2)} s⁻¹).`,
  };
});

// ---------------------------------------------------------------------------
// 5. §10.3 — the pack
// ---------------------------------------------------------------------------

test('§10.3 one finds it and the others converge on it', () => {
  // Four hunters spread across the front, one of them sitting on the trail. The
  // other three have no percept of their own and must still turn towards it.
  const ship = makeShip({ speed: SIG.cruiseRel });
  const pack = createWakeHunterPack({
    size: 4, position: vec(0, 0, 600), heading: 0, falsePositiveBase: 0,
  });
  // Put the finder on the road (x = 0, where the ship flies) and the rest well
  // off it, in one line abreast. The first version of this case spaced them
  // −900/−300/+300/+900 and nobody was on the trail at all, so it measured a pack
  // converging on nothing.
  const lay = [-900, -300, 0, 900];
  pack.members.forEach((m, i) => { m.simLevel = 'full'; m.position.x = lay[i]; });
  const before = pack.members.map((m) => m.position.x);
  const { sig } = driveWorld({ seconds: 50, hunters: pack.members, ship });
  const after = pack.members.map((m) => m.position.x);
  const finder = pack.members.find((m) => m.estimate && m.estimate.real);
  const others = pack.members.filter((m) => m !== finder);
  const ownPercepts = others.filter((m) => m.lastPerceptTime > -Infinity).length;
  const converged = others.filter((m, i) => Math.abs(after[pack.members.indexOf(m)])
    < Math.abs(before[pack.members.indexOf(m)]) - 100).length;
  return {
    ok: !!finder && pack.shares > 0 && converged >= 2,
    detail: `finder #${finder ? finder.id : '-'} shared ${pack.shares} contacts; `
      + `x before ${before.map((v) => f(v, 0)).join('/')} → after ${after.map((v) => f(v, 0)).join('/')}; `
      + `${converged}/${others.length} non-finders closed on the trail, ${ownPercepts} of them on `
      + `evidence of their own`,
  };
});

test('§10.3 the pack sweeps a 600 m front and closes to single file on TRACKING', () => {
  const pack = new WakeHunterPack({ id: 1 });
  for (let i = 0; i < 5; i++) new WakeHunter({ id: i, pack, falsePositiveBase: 0 });
  const lanes = pack.members.map((m) => pack.laneOffset(m.packIndex));
  const front = Math.max(...lanes) - Math.min(...lanes);
  const searchSpread = front * WAKE_HUNTER.formationSpread[STATE.SEARCHING];
  const trackSpread = front * WAKE_HUNTER.formationSpread[STATE.TRACKING];
  return {
    ok: Math.abs(front - WAKE_HUNTER.packFrontM) < 1e-6 && trackSpread === 0,
    detail: `lanes ${lanes.map((v) => f(v, 0)).join(' / ')} m — a ${f(front, 0)} m front; `
      + `SEARCHING spreads ${f(searchSpread, 0)} m, TRACKING ${f(trackSpread, 0)} m (single file)`,
  };
});

test('§6/§11.1 the one-COMMITTED rule against a pack that all found the same trail', () => {
  // The conflict, measured rather than argued. §10.3's COMMITTED row is a pack
  // behaviour; §6 allows one committed creature in the world and manager.js
  // enforces it every step.
  const ship = makeShip({ speed: SIG.cruiseRel });
  const mgr = new CreatureManager();
  const pack = createWakeHunterPack({ size: 5, position: vec(0, 0, 700), falsePositiveBase: 0 });
  for (const m of pack.members) { m.position.x = 0; mgr.add(m); }
  let maxCommitted = 0;
  driveWorld({
    seconds: 90, manager: mgr, ship,
    onStep: () => {
      const n = pack.members.filter((m) => m.state === STATE.COMMITTED).length;
      if (n > maxCommitted) maxCommitted = n;
    },
  });
  const yieldEvents = mgr.detectionLog().filter((e) => e.channel === 'yield').length;
  const log = mgr.detectionLog();
  return {
    // The rule holds. Whether it should is the finding, not the failure.
    ok: maxCommitted <= 1,
    detail: `${mgr.yields} yields in 90 s, ${yieldEvents} of the last ${log.length} log entries `
      + `are yields (${f(100 * yieldEvents / Math.max(log.length, 1), 0)}% of §7's 64-entry window); `
      + `never more than ${maxCommitted} COMMITTED at once`,
  };
});

// ---------------------------------------------------------------------------
// 6. §5.3, §8, §9, §12
// ---------------------------------------------------------------------------

test('§5.3 the wake false-positive rate rises with turbulence, at the stated 3.0 × u', () => {
  const measure = (u) => {
    const h = new WakeHunter({ id: 0, rng: new Rng(seedFrom(`fp-${u}`)) });
    h.simLevel = 'full';
    let n = 0, ticks = 0;
    const orig = h.sense.bind(h);
    h.sense = (c) => {
      const out = orig(c);
      ticks++;
      for (const p of out) if (!p.real && p.channel === 'wake') n++;
      return out;
    };
    driveStatic(h, { wake: [], thermal: [] }, 2000, { medium: createFlatMedium({ turbulence: u }) });
    return { hz: n / 2000, n, ticks };
  };
  const calm = measure(0), rough = measure(0.8);
  const wantCalm = WAKE_HUNTER.wakeFalsePositiveBase;
  const wantRough = WAKE_HUNTER.wakeFalsePositiveBase * (1 + 3.0 * 0.8);
  return {
    ok: pct(calm.hz, wantCalm) < 0.2 && pct(rough.hz, wantRough) < 0.2,
    detail: `u=0: ${f(calm.hz, 4)} Hz over ${calm.ticks} sense ticks (want ${f(wantCalm, 3)}); `
      + `u=0.8: ${f(rough.hz, 4)} Hz (want ${f(wantRough, 3)}) — a pack in rough air spends `
      + `${f(rough.hz / calm.hz, 1)}× as much time chasing eddies`,
  };
});

test('§8 the sense costs one medium sample a tick against a budget of thirty-two', () => {
  const ship = makeShip();
  const medium = countingMedium(createFlatMedium());
  const h = quietHunter({ position: vec(0, 0, 600) });
  let worst = 0, worstParcels = 0;
  driveWorld({
    seconds: 60, hunters: [h], ship, medium,
    onStep: () => {
      h.position.x = 0; h.position.y = 0; h.position.z = 600;
      worst = Math.max(worst, h.mediumSamplesLastTick);
      worstParcels = Math.max(worstParcels, h.parcelsScanned);
    },
  });
  return {
    ok: worst <= 32,
    detail: `worst ${worst} medium samples per sense tick (§8 allows 32) — there is no path `
      + `integral because §4.4 does not transmit trails. The cost is elsewhere: `
      + `${worstParcels} parcels examined per tick`,
  };
});

test('§10.3 the chirp rate reads trail strength and is blind to proximity', () => {
  const chirps = (strength, shipDistance) => {
    const h = quietHunter({ position: vec(0, 0, 0), senseOffset: 0 });
    driveStatic(h, oneParcel(strength), 60, { shipPos: vec(0, 0, shipDistance) });
    return h.chirpCount;
  };
  const strongFar = chirps(1.5, 9000);
  const strongNear = chirps(1.5, 90);
  const weakNear = chirps(0.10, 90);
  return {
    // Identical across distance, different across strength. That is the whole claim.
    ok: strongFar === strongNear && strongFar > weakNear * 1.5,
    detail: `strong trail (1.5 s⁻¹): ${strongFar} chirps in 60 s at 9 km and ${strongNear} at 90 m — `
      + `identical. Nearly-cold trail (0.10 s⁻¹) at 90 m: ${weakNear}. A fast-chirping pack far `
      + `away means your trail is strong.`,
  };
});

test('the pack cannot outrun the ship, in any state', () => {
  const top = Math.max(...Object.values(WAKE_HUNTER.speedMps));
  return {
    ok: top < SIG.cruiseRel && top < SIG.boostRel,
    detail: `fastest state ${f(top, 0)} m/s against cruise ${f(SIG.cruiseRel, 0)} `
      + `(${f(top / SIG.cruiseRel, 2)}×) and boost ${f(SIG.boostRel, 0)} (${f(top / SIG.boostRel, 2)}×). `
      + `Boost always opens the distance — and buys a ${f(188, 0)} s trail for it.`,
  };
});

test('§12 the same seed and the same flight reproduce the detection log exactly', () => {
  const play = () => {
    const mgr = new CreatureManager();
    const rng = new Rng(seedFrom('wakehunter-replay'));
    const pack = createWakeHunterPack({ size: 4, rng, position: vec(0, 0, 650) });
    for (const m of pack.members) mgr.add(m);
    const ship = makeShip({ speed: SIG.cruiseRel });
    driveWorld({
      seconds: 120, manager: mgr, ship, air: makeAir({ turbulence: 0.4, flow: { x: 6, y: 0, z: 0 } }),
      medium: createFlatMedium({ turbulence: 0.4 }),
      fly: (t, s) => { s.heading = Math.sin(t * 0.02) * 0.6; },
    });
    return mgr.detectionLog();
  };
  const a = play(), b = play();
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  const fp = a.filter((e) => e.real === false).length;
  return {
    ok: sa === sb && a.length > 0,
    detail: `${a.length} events, byte-identical across two runs: ${sa === sb}; `
      + `${fp} of them caused by a false positive`,
  };
});

test('createTrailView takes a Signature, a pair of ParcelFields, or plain arrays', () => {
  const ship = makeShip();
  const { sig } = driveWorld({ seconds: 20, ship });
  const count = (v, which) => { let n = 0; v[which]((x, y, z, val) => { if (val > 0) n++; }); return n; };
  const fromSig = createTrailView(sig);
  const fromFields = createTrailView({ wakeTrail: sig.wakeTrail, thermalTrail: sig.thermalTrail, time: sig.time });
  const fromArrays = createTrailView({ wake: [{ x: 0, y: 0, z: 0, value: 1, age: 3 }], thermal: [] });
  const empty = createTrailView(null);
  const a = count(fromSig, 'eachWake'), b = count(fromFields, 'eachWake');
  return {
    ok: a > 0 && a === b && count(fromArrays, 'eachWake') === 1 && !empty.has,
    detail: `Signature ${a} live wake parcels, raw ParcelField ${b}, array shape `
      + `${count(fromArrays, 'eachWake')}, null → has:${empty.has}`,
  };
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run every case. Returns { pass, fail, results }. */
export function run() {
  const results = CASES.map(({ name, fn }) => {
    let r;
    try { r = fn(); }
    catch (e) { r = { ok: false, detail: `threw: ${e && e.message}` }; }
    return { name, ok: !!r.ok, detail: r.detail, got: r.detail };
  });
  return {
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok),
    results,
  };
}

/** The same thing as text, for a console. */
export function report() {
  const r = run();
  const lines = r.results.map((x) => `${x.ok ? 'pass' : 'FAIL'}  ${x.name}\n        ${x.detail}`);
  return `${r.fail.length ? `${r.fail.length} FAILED — ` : 'all '}${r.pass}/${r.results.length} passed\n\n`
    + lines.join('\n');
}

/** Render into the current page. Self-contained; touches nothing that exists. */
export function mount(root = document.body) {
  const r = run();
  const el = document.createElement('div');
  el.style.cssText = 'margin:0;padding:28px;background:#05070b;color:#b9c7da;'
    + 'font:13px/1.7 ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;position:fixed;'
    + 'inset:0;overflow:auto;z-index:99999';
  const head = document.createElement('div');
  head.style.cssText = `font-size:14px;margin-bottom:16px;color:${r.fail.length ? '#ff8b8b' : '#8fe3a8'}`;
  head.textContent = r.fail.length
    ? `${r.fail.length} FAILED — ${r.pass}/${r.results.length} passed`
    : `all ${r.pass} passed`;
  el.appendChild(head);
  for (const x of r.results) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:3px 0;border-bottom:1px solid #121b26';
    row.innerHTML = `<span style="color:${x.ok ? '#8fe3a8' : '#ff8b8b'}">${x.ok ? 'pass' : 'FAIL'}</span>`
      + ` <span style="color:#cfe2f5">${x.name}</span>`
      + `<div style="color:#55677e;padding-left:44px">${x.detail}</div>`;
    el.appendChild(row);
  }
  root.appendChild(el);
  globalThis.WAKEHUNTER_TESTS = r;
  return r;
}

if (typeof document !== 'undefined' && import.meta.url.includes('autorun')) mount();

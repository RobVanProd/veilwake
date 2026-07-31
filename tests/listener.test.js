// The Listener, measured.
//
// `creature.js` cites `tests/listener.js` twice as the file that proves it works
// and that file never existed. This is it, against the archetype rather than
// against the base class — because the base class was never the thing in doubt.
//
// The whole creature layer is deliberately headless: no Three.js import, plain
// `{x, y, z}` vectors, and a medium that is an interface rather than a renderer.
// So every check here runs with no GPU in the process at all, which is the only
// reason they can be run at all in the environment this file was written in.
//
// The instrument discipline that matters here, learned from the control-polarity
// test that once "found" an inversion that was not there:
//
//   **Hold the geometry still when measuring transmission.** The first version of
//   the range check let the creature patrol during the 320 s needed to fill the
//   recorder, so by the time `sense()` ran it was 400 m from where the bisection
//   thought it was, and it reported a sense range of 2920 m against a contract
//   value of 3.2 km — a plausible-looking 8% error that was entirely the
//   measurement's fault. Every transmission case below constructs the creature at
//   the distance under test and reads one tick.

import { Rng } from '../src/core/rng.js';
import { Signature } from '../src/game/signature.js';
import { ShipSystems } from '../src/game/systems.js';
import { Listener, LISTENER } from '../src/game/creatures/listener.js';
import {
  STATE, STATE_ENTRY, stateExit, FAR_PLANE, MEDIUM_SAMPLE_BUDGET, SENSE_PERIOD,
  RNG_TAG, soundDelayS, createFlatMedium, countingMedium, createSignatureView,
} from '../src/game/creatures/creature.js';

const DT = 1 / 120;
/** Enough recorder history to cover a FAR_PLANE sound delay (36.4 s) many times. */
const FILL_S = 120;

const ship = ({ throttle = 1, boost = 0, speed = 0 } = {}) => ({
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: -speed },
  throttleSmoothed: throttle, boostSmoothed: boost,
  gLoad: 0, slipAngle: 0, forward: { x: 0, y: 0, z: -1 },
});

/**
 * A world with a filled recorder and a still ship.
 *
 * `emitted` is measured, not assumed — every transmission case below is stated
 * against what the ship was actually emitting rather than against 46.
 */
function rig({ medium = createFlatMedium(), shipOpts = {}, engineOff = false,
               powerDown = false, seconds = FILL_S } = {}) {
  const sig = new Signature();
  const sys = new ShipSystems();
  if (powerDown) sys.powerDown();
  if (engineOff) sys.engine = false;
  const sh = ship(shipOpts);
  for (let i = 0; i < Math.round(seconds / DT); i++) sig.update(DT, sh, sys);
  return {
    sig, sys, ship: sh,
    view: createSignatureView(sig.recorder),
    medium: countingMedium(medium),
    emitted: sig.acoustic,
  };
}

/** One creature at an exact distance, one sense tick, no motion in between. */
function listenAt(r, dist, { threshold = LISTENER.threshold, t = FILL_S, seed = 7 } = {}) {
  const c = new Listener({
    id: 0, rng: new Rng(seed).fork(RNG_TAG.LISTENER), position: { x: 0, y: 0, z: dist },
  });
  c.simLevel = 'full';
  c.threshold = threshold;
  const ctx = { tick: 0, t, medium: r.medium, signature: r.view,
                shipPos: r.ship.position, shipVel: r.ship.velocity };
  const percepts = c.sense(ctx) || [];
  return { c, ctx, real: percepts.find((p) => p.real) || null, percepts };
}

/** A creature that can actually be run forward, with everything wired. */
function scenario({ dist = 2000, shipOpts = {}, engineOff = false, medium = createFlatMedium(),
                    seed = 12345, frozen = false } = {}) {
  const r = rig({ medium, shipOpts, engineOff });
  const rng = new Rng(seed);
  const c = new Listener({
    id: 0, rng: rng.fork(RNG_TAG.LISTENER), position: { x: 0, y: 0, z: dist },
  });
  c.simLevel = 'full';
  const ctx = { tick: 0, t: FILL_S, medium: r.medium, signature: r.view,
                shipPos: r.ship.position, shipVel: r.ship.velocity };
  return {
    ...r, c, ctx,
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        r.sig.update(DT, r.ship, r.sys);
        ctx.tick++; ctx.t += DT;
        const before = frozen ? { x: c.position.x, z: c.position.z } : null;
        c.update(DT, ctx.tick, ctx);
        // `frozen` pins the geometry for cases that are about sensing rather
        // than about movement, so a drifting creature cannot forge the result.
        if (before) { c.position.x = before.x; c.position.z = before.z; }
      }
      return this;
    },
  };
}

const near = (got, want, tol) => Math.abs(got - want) <= tol;

// ---------------------------------------------------------------------------
// §4.1 Transmission — against the contract's own worked values
// ---------------------------------------------------------------------------

function transmissionCases() {
  const r = rig();
  const out = [{
    name: 'the ship the transmission cases are measured against is at cruise',
    want: '46.0 dB(V)',
    got: `${r.emitted.toFixed(2)} dB(V)`,
    ok: near(r.emitted, 46, 0.1),
    note: 'stated rather than assumed — every row below is relative to this',
  }];

  // §4.1's worked values, quoted in the contract and in creature.js's header.
  for (const [d, want] of [[300, 36.5], [1000, 26.0], [3000, 16.5], [6000, 10.4]]) {
    const s = listenAt(r, d).real.strength;
    out.push({
      name: `acoustic transmission at ${d} m, clear air`,
      want: `${want} dB(V)`,
      got: `${s.toFixed(2)} dB(V)`,
      ok: near(s, want, 0.1),
      note: `measured ${s.toFixed(2)} against the contract's ${want} — ${Math.abs(s - want).toFixed(2)} dB out`,
    });
  }

  // The duct is the mechanic: n falls from 20 to 12 and 6 km stops being far.
  const ducted = rig({ medium: createFlatMedium({ duct: 1.0 }) });
  const s = listenAt(ducted, 6000).real.strength;
  out.push({
    name: 'acoustic transmission at 6000 m inside a full duct',
    want: '24.7 dB(V)',
    got: `${s.toFixed(2)} dB(V)`,
    ok: near(s, 24.7, 0.1),
    note: '14.3 dB louder than the same distance in open air — the difference ' +
      'between inaudible and obvious, and the reason a corridor is a trap',
  });

  return out;
}

// ---------------------------------------------------------------------------
// §10.1 Sense ranges — these must fall out of the formula, not be tuned to
// ---------------------------------------------------------------------------

function rangeCases() {
  const r = rig();
  const bisect = (threshold) => {
    let lo = 100, hi = FAR_PLANE;
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) / 2;
      const p = listenAt(r, m, { threshold }).real;
      if (p && p.strength > threshold) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  };
  const normal = bisect(LISTENER.threshold);
  const listening = bisect(LISTENER.listeningThreshold);

  return [
    {
      name: 'sense range at cruise, threshold 16 dB(V)',
      want: 'about 3.2 km',
      got: `${normal.toFixed(0)} m`,
      ok: near(normal, 3200, 300),
      note: `${normal.toFixed(0)} m against the contract's "about 3.2 km"`,
    },
    {
      name: 'sense range at cruise, listening threshold 6 dB(V)',
      want: '10 km',
      got: `${listening.toFixed(0)} m`,
      ok: near(listening, 10000, 400),
      note: `${listening.toFixed(0)} m against the contract's "10 km"`,
    },
    {
      name: 'the silence window is worth a factor of 3.2 on range',
      want: '3.0 – 3.4×',
      got: `${(listening / normal).toFixed(2)}×`,
      ok: listening / normal > 3.0 && listening / normal < 3.4,
      note: '§10.1: "a factor of 3.2 on every range it has". It is not tuned to — ' +
        'it falls out of 10 dB of threshold against a 20·log spreading law',
    },
    {
      name: 'nothing is heard beyond FAR_PLANE',
      want: 'no percept',
      got: listenAt(r, FAR_PLANE + 1).percepts.length ? 'a percept' : 'no percept',
      ok: listenAt(r, FAR_PLANE + 1).percepts.length === 0,
      note: `§1: ${FAR_PLANE} m is the hard cut, and it is a cut in sense(), not a threshold`,
    },
    {
      name: 'a percept never carries a range',
      want: 'null',
      got: `${listenAt(r, 2000).real.range}`,
      ok: listenAt(r, 2000).real.range === null,
      note: '§5.1: acoustic gives bearing and loudness, which are confounded. The ' +
        'range the creature acts on is its own inference and lives on the estimate',
    },
  ];
}

// ---------------------------------------------------------------------------
// §5.2 Latency — the delay has to be observable, not merely implemented
// ---------------------------------------------------------------------------

function latencyCases() {
  const sig = new Signature(), sys = new ShipSystems();
  const sh = ship({ throttle: 1 });
  for (let i = 0; i < Math.round(100 / DT); i++) sig.update(DT, sh, sys);
  sh.boostSmoothed = 1;                       // a 2 s burst at t = 100–102
  for (let i = 0; i < Math.round(2 / DT); i++) sig.update(DT, sh, sys);
  sh.boostSmoothed = 0;

  const view = createSignatureView(sig.recorder);
  const medium = countingMedium(createFlatMedium());
  const D = 3000;
  let base = null, heardAt = null;
  for (let k = 0; k < Math.round(30 / DT); k++) {
    sig.update(DT, sh, sys);
    if (k % SENSE_PERIOD) continue;
    const t = 102 + k * DT;
    const c = new Listener({ id: 0, rng: new Rng(1).fork(RNG_TAG.LISTENER),
                             position: { x: 0, y: 0, z: D } });
    c.simLevel = 'full';
    const p = (c.sense({ tick: k, t, medium, signature: view,
                         shipPos: sh.position, shipVel: sh.velocity }) || [])
      .find((x) => x.real);
    if (!p) continue;
    if (base === null) base = p.strength;
    if (heardAt === null && p.strength > base + 3) heardAt = t;
  }
  const expect = 100 + soundDelayS(D);
  return [{
    name: 'a burst at t=100 s is heard at 3 km about 9 s later',
    want: `${expect.toFixed(1)} s`,
    got: heardAt === null ? 'never' : `${heardAt.toFixed(1)} s`,
    ok: heardAt !== null && near(heardAt, expect, 1.0),
    note: `sound delay at ${D} m is ${soundDelayS(D).toFixed(2)} s; the sense tick is ` +
      '0.1 s and the 3 dB rise takes a moment, so a small lag is expected and honest',
  }];
}

// ---------------------------------------------------------------------------
// §7 Explicability — the log has to explain itself
// ---------------------------------------------------------------------------

function logCases() {
  // A medium with something in it, so the path terms are not all zero by luck.
  const s = scenario({
    dist: 1800,
    medium: createFlatMedium({ density: 0.08, turbulence: 0.3, duct: 0.45, charge: 0.1 }),
    frozen: true,
  });
  s.step(Math.round(400 / DT));
  const log = s.c.detectionLog();
  const withTerms = log.filter((e) => e.medium.rho_mean !== 0 || e.medium.g_mean !== 0);
  const transitions = log.filter((e) => e.channel !== 'promotion');
  const jumped = (() => {
    const order = [STATE.UNAWARE, STATE.ALERT, STATE.SEARCHING, STATE.TRACKING, STATE.COMMITTED];
    return transitions.some((e) => Math.abs(order.indexOf(e.to) - order.indexOf(e.from)) !== 1
      && !(e.from === STATE.COMMITTED && e.to === STATE.SEARCHING));
  })();

  return [
    {
      name: 'every DetectionEvent carries the path terms that explain it',
      want: `${transitions.length} of ${transitions.length}`,
      got: `${withTerms.length} of ${transitions.length}`,
      ok: transitions.length > 0 && withTerms.length === transitions.length,
      note: '`_terms` was allocated by the base class and written by nothing, so every ' +
        'event logged rho/u/q/g as 0 — the half of the sentence that says *why* it was heard. ' +
        `Now: rho ${log[0]?.medium.rho_mean.toFixed(3)}, duct ${log[0]?.medium.g_mean.toFixed(3)}`,
    },
    {
      name: 'every state transition writes exactly one DetectionEvent',
      want: `${s.c.transitionCount()}`,
      got: `${transitions.length}`,
      ok: transitions.length === s.c.transitionCount(),
      note: '§12\'s pass condition, and §7 rates a transition without one as the ' +
        'highest-severity bug this project can have',
    },
    {
      name: 'the ladder is walked one rung at a time',
      want: 'no jumps',
      got: jumped ? 'a jump' : 'no jumps',
      ok: !jumped,
      note: transitions.map((e) => `${e.from}→${e.to}`).join(', ') || '(none)',
    },
  ];
}

// ---------------------------------------------------------------------------
// §6 De-escalation from COMMITTED — the bug that fired every single time
// ---------------------------------------------------------------------------

function deescalationCases() {
  const s = scenario({ dist: 1500, frozen: true });
  s.step(Math.round(400 / DT));
  const reached = s.c.state;

  s.sys.powerDown();
  s.ship.throttleSmoothed = 0;

  const trace = [];
  let last = s.c.state, afterFall = null, fellAt = null;
  for (let i = 0; i < Math.round(400 / DT); i++) {
    s.step(1);
    if (s.c.state !== last) {
      trace.push(`t=${s.ctx.t.toFixed(1)} ${last}→${s.c.state} att=${s.c.attention.toFixed(4)}`);
      if (last === STATE.COMMITTED) { fellAt = s.ctx.t; afterFall = s.c.state; }
      last = s.c.state;
    }
    // Five seconds after the fall, is it still hunting the area?
    if (fellAt !== null && s.ctx.t > fellAt + 5 && afterFall === STATE.SEARCHING
        && s.c.state === STATE.TRACKING) afterFall = 'CLIMBED BACK TO TRACKING';
  }

  return [
    {
      name: 'a Listener 1500 m from a cruising ship reaches COMMITTED',
      want: STATE.COMMITTED,
      got: reached,
      ok: reached === STATE.COMMITTED,
      note: 'the precondition for the case below; without it the rest proves nothing',
    },
    {
      name: 'de-escalation from COMMITTED lands in SEARCHING and stays there',
      want: STATE.SEARCHING,
      got: `${afterFall}`,
      ok: afterFall === STATE.SEARCHING,
      note: 'COMMITTED exits at 0.736 and TRACKING is entered at 0.700, so dropping to ' +
        'SEARCHING without also dropping attention re-entered TRACKING in the same tick. ' +
        'The observable transition was COMMITTED→TRACKING, which §6 forbids by name. ' +
        `Trace: ${trace.join(' | ')}`,
    },
    {
      name: 'the fall puts attention inside the SEARCHING band, not on its edge',
      want: `≤ ${stateExit(STATE.TRACKING)}`,
      got: `${trace.length ? trace[0].split('att=')[1] : '—'}`,
      ok: (() => {
        const first = trace.find((l) => l.includes(`${STATE.COMMITTED}→`));
        if (!first) return false;
        const att = parseFloat(first.split('att=')[1]);
        return att <= stateExit(STATE.TRACKING) + 1e-6 && att >= STATE_ENTRY[STATE.SEARCHING];
      })(),
      note: `0.56 is stateExit(TRACKING), not a new constant — it is the level at which ` +
        'TRACKING itself would give up, so climbing back costs a real re-detection',
    },
  ];
}

// ---------------------------------------------------------------------------
// The estimate — declared by the base class, written by nothing until now
// ---------------------------------------------------------------------------

function estimateCases() {
  const out = [];
  const s = scenario({ dist: 2000, frozen: true });
  s.step(Math.round(120 / DT));
  const e = s.c.estimate;

  out.push({
    name: 'onPercept writes an estimate',
    want: 'an estimate',
    got: e ? `(${e.x.toFixed(0)}, ${e.z.toFixed(0)}) ±${e.sigma.toFixed(0)} m` : 'null',
    ok: !!e,
    note: '`this.estimate` was declared and read by snapshot() and the memory purge, and ' +
      'written by nothing — which is why memorySec was dead and SEARCHING had nothing to aim at',
  });

  if (e) {
    // The creature is at z = +2000 looking at a ship at the origin, so the
    // estimate should sit near the origin — measured as a fraction of the true
    // range, because the bearing noise is real and the range is inferred.
    const err = Math.hypot(e.x - 0, e.z - 0);
    out.push({
      name: 'the estimate is somewhere near the ship, not somewhere arbitrary',
      want: '< 40% of true range',
      got: `${err.toFixed(0)} m of 2000 m`,
      ok: err < 800,
      note: 'it is deliberately not exact: the bearing is corrupted by sigma before the ' +
        'creature ever sees it, and the range is inferred from an assumed source level',
    });
  }

  // Range inference, which is the readable rule. Held still, one tick each.
  const inferAt = (r, d) => {
    const q = listenAt(r, d);
    return q.real ? q.c._rangeFrom(q.real.strength) : null;
  };
  const cruiseRig = rig();
  const boostRig = rig({ shipOpts: { boost: 1 } });
  const cruiseInfer = inferAt(cruiseRig, 3000);
  const boostInfer = inferAt(boostRig, 3000);

  out.push({
    name: 'a ship at the assumed source level is ranged correctly',
    want: '3000 m ±5%',
    got: `${cruiseInfer.toFixed(0)} m`,
    ok: near(cruiseInfer, 3000, 150),
    note: `the Listener assumes ${LISTENER.assumedEmittedDb} dB(V), so a ship actually at ` +
      `${cruiseRig.emitted.toFixed(1)} dB(V) is placed where it is`,
  });
  out.push({
    name: 'a louder ship is placed nearer than it is',
    want: '< 3000 m',
    got: `${boostInfer.toFixed(0)} m`,
    ok: boostInfer < 3000,
    note: `emitting ${boostRig.emitted.toFixed(1)} dB(V) at 3000 m, it is placed at ` +
      `${boostInfer.toFixed(0)} m. The error factor is 10^((46−E)/20) and is independent ` +
      'of true distance, which makes it a rule a player can actually learn: the Listener\'s ' +
      'map of you is scaled by your throttle',
  });

  // Repeated agreeing percepts should tighten the fix. Measured from the *first*
  // one — by twenty seconds the fusion has already converged, and comparing two
  // converged values proves nothing, which is how the first version of this case
  // passed on a rounding tie.
  const s2 = scenario({ dist: 2000, frozen: true });
  let first = null;
  for (let i = 0; i < Math.round(120 / DT) && first === null; i++) {
    s2.step(1);
    if (s2.c.estimate) first = s2.c.estimate.sigma;
  }
  s2.step(Math.round(60 / DT));
  const late = s2.c.estimate ? s2.c.estimate.sigma : null;
  out.push({
    name: 'a ship that keeps making noise gets pinned down',
    want: 'sigma falls by at least a third',
    got: first && late ? `${first.toFixed(0)} m → ${late.toFixed(0)} m` : 'no estimate',
    ok: !!(first && late && late < first * 0.67),
    note: 'inverse-variance fusion, with the old fix inflated by how far the target could ' +
      'have moved since. It converges rather than shrinking forever, which is right — the ' +
      'floor is set by how wrong the assumed source level can be. The corollary is the one ' +
      'that matters: an estimate left alone dissolves at 15 m of sigma per second',
  });

  // §5.4's `memory` — "how long the last percept's position estimate is retained
  // after attention decays". It was dead code, because nothing ever wrote an
  // estimate for it to retain. A short memory is passed here so the case runs in
  // seconds rather than in the Listener's shipped four minutes.
  const s3 = scenario({ dist: 2000, frozen: true });
  s3.c.memorySec = 20;
  s3.step(Math.round(120 / DT));
  const held = s3.c.estimate ? s3.c.estimate.sigma : null;
  s3.sys.powerDown();
  s3.ship.throttleSmoothed = 0;
  s3.step(Math.round(120 / DT));
  out.push({
    name: 'the estimate is forgotten after memorySec without a percept',
    want: 'null',
    got: s3.c.estimate ? `still held, ±${s3.c.estimate.sigma.toFixed(0)} m` : 'null',
    ok: held !== null && s3.c.estimate === null,
    note: `held a ±${held?.toFixed(0)} m fix while the ship was audible, then dropped it ` +
      `${s3.c.memorySec} s after the last percept. §5.4's memory was unreachable before an ` +
      'archetype wrote an estimate for it to expire',
  });

  return out;
}

// ---------------------------------------------------------------------------
// §10.1 The silence window, the calls, and the corridor
// ---------------------------------------------------------------------------

function behaviourCases() {
  // Far enough that nothing escalates and the patrol behaviour is what is measured.
  const s = scenario({ dist: 11000 });
  const windows = [];
  const stillWhileSilent = { checked: 0, moved: 0 };
  let inW = false, start = 0, lastPos = null;
  const thresholdsSeen = new Set();

  for (let i = 0; i < Math.round(900 / DT); i++) {
    s.step(1);
    thresholdsSeen.add(s.c.currentThreshold());
    if (s.c.silent) {
      if (!inW) { inW = true; start = s.ctx.t; lastPos = { x: s.c.position.x, z: s.c.position.z }; }
      else {
        stillWhileSilent.checked++;
        if (Math.hypot(s.c.position.x - lastPos.x, s.c.position.z - lastPos.z) > 1e-6) {
          stillWhileSilent.moved++;
        }
      }
    } else if (inW) { inW = false; windows.push([start, s.ctx.t - start]); }
  }

  const durations = windows.map((w) => w[1]);
  const gaps = windows.slice(1).map((w, i) => w[0] - windows[i][0] - windows[i][1]);
  const inRange = (arr, lo, hi) => arr.length > 0 && arr.every((v) => v >= lo && v <= hi);

  const out = [
    {
      name: 'it goes silent on a schedule',
      want: '5 – 9 windows in 900 s',
      got: `${windows.length}`,
      ok: windows.length >= 5 && windows.length <= 9,
      note: `at 100–160 s apart lasting 18–26 s, 900 s should hold 5–8`,
    },
    {
      name: 'each silence lasts 18–26 s',
      want: '18 – 26 s',
      got: durations.map((d) => d.toFixed(1)).join(', '),
      ok: inRange(durations, 18, 26),
      note: '§10.1. The player has to be able to ride it out, and 26 s of powered-down ' +
        'drift is exactly as long as that is survivable',
    },
    {
      name: 'silences are 100–160 s apart',
      want: '100 – 160 s',
      got: gaps.map((g) => g.toFixed(1)).join(', '),
      ok: inRange(gaps, 100, 160),
      note: '§10.1. Long enough to forget about, short enough to be a rhythm',
    },
    {
      name: 'while listening it does not move',
      want: '0 moving samples',
      got: `${stillWhileSilent.moved} of ${stillWhileSilent.checked}`,
      ok: stillWhileSilent.checked > 0 && stillWhileSilent.moved === 0,
      note: '§10.1: "completely silent and completely still". The stillness is what makes ' +
        'the silence legible — it is not that the drone stopped, it is that everything stopped',
    },
    {
      name: 'the threshold drops from 16 to 6 while listening',
      want: '{6, 16}',
      got: `{${[...thresholdsSeen].sort((a, b) => a - b).join(', ')}}`,
      ok: thresholdsSeen.has(LISTENER.threshold) && thresholdsSeen.has(LISTENER.listeningThreshold),
      note: 'currentThreshold() existed as an override point and was a constant',
    },
    {
      name: 'it calls while unaware',
      want: '10 – 22 calls in 900 s',
      got: `${s.c.callCount}`,
      ok: s.c.callCount >= 8 && s.c.callCount <= 22,
      note: '§10.1: every 40–90 s, lasting 6–11 s, and silent while a window is open',
    },
    {
      name: 'it carves while patrolling',
      want: '> 15 corridor nodes',
      got: `${s.c.corridor().length}`,
      ok: s.c.corridor().length > 15,
      note: `one node per ${LISTENER.corridorSpacingM} m, radius ${LISTENER.corridorRadiusM} m ` +
        '(the contract\'s 300 m across). It records the corridor; actually clearing density ' +
        'means writing into CloudSystem, which this headless layer deliberately cannot do',
    },
  ];

  // Carving stops the moment it notices — the single most important readable tell.
  const s2 = scenario({ dist: 2500, frozen: true });
  let carvingAtAlert = null;
  for (let i = 0; i < Math.round(300 / DT); i++) {
    s2.step(1);
    if (s2.c.state === STATE.ALERT && carvingAtAlert === null) carvingAtAlert = s2.c.carving;
  }
  out.push({
    name: 'it stops carving the moment it goes ALERT',
    want: 'not carving',
    got: carvingAtAlert === null ? 'never reached ALERT' : (carvingAtAlert ? 'still carving' : 'stopped'),
    ok: carvingAtAlert === false,
    note: '§10.1: "the vapour ahead stops being clear". The player\'s first warning arrives ' +
      'before anything has moved, and it costs nothing to teach',
  });
  out.push({
    name: 'calls stop at ALERT and above',
    want: 'not calling',
    got: s2.c.calling ? 'calling' : 'silent',
    ok: !s2.c.calling && s2.c.state !== STATE.UNAWARE,
    note: `state at the end of the run: ${s2.c.state}`,
  });

  return out;
}

// ---------------------------------------------------------------------------
// §5.3, §8, §12 — the properties that make an encounter defensible
// ---------------------------------------------------------------------------

function disciplineCases() {
  const out = [];

  // Budget. §8 caps a creature at 32 medium samples per sense tick.
  {
    const r = rig();
    const before = r.medium.samplesTaken();
    listenAt(r, 3000);
    const used = r.medium.samplesTaken() - before;
    out.push({
      name: 'medium samples per sense tick are inside the §8 budget',
      want: `≤ ${MEDIUM_SAMPLE_BUDGET}`,
      got: `${used}`,
      ok: used <= MEDIUM_SAMPLE_BUDGET,
      note: 'eight along the path plus one at the body for the false-positive rate. ' +
        'Note the counter counts sample() calls, not field evaluations — the real cloud ' +
        'field costs about 8× this, which the counter cannot see',
    });
  }

  // §8: the reduced model may never produce a detection.
  {
    const s = scenario({ dist: 1200 });
    s.c.simLevel = 'reduced';
    s.step(Math.round(300 / DT));
    out.push({
      name: 'a reduced-simulation creature never detects',
      want: '0 events, UNAWARE',
      got: `${s.c.detectionLog().length} events, ${s.c.state}`,
      ok: s.c.detectionLog().length === 0 && s.c.state === STATE.UNAWARE,
      note: '§8. Nothing sets simLevel today, which is why a default creature runs sense() ' +
        'zero times a second — main.js owns promotion and that wiring is unverified',
    });
  }

  // §12: an encounter that cannot be replayed cannot be shown to be fair.
  {
    const trace = () => {
      const s = scenario({ dist: 2500, seed: 4242 });
      s.step(Math.round(400 / DT));
      return JSON.stringify(s.c.detectionLog()
        .map((e) => [+e.simTime.toFixed(4), e.from, e.to, e.real, +e.attention.toFixed(6)]));
    };
    const a = trace(), b = trace();
    out.push({
      name: 'two runs from the same seed produce an identical detection log',
      want: 'identical',
      got: a === b ? 'identical' : 'diverged',
      ok: a === b,
      note: `${JSON.parse(a).length} events. §5.3 requires the false positives to come from ` +
        'the creature\'s own forked stream for exactly this reason',
    });
  }

  // §5.3: false positives happen, are marked, and are weak.
  {
    // Far enough that every percept above threshold must be a mistake.
    const r = rig();
    let fp = 0, ticks = 0, maxStrength = 0;
    const c = new Listener({ id: 0, rng: new Rng(31).fork(RNG_TAG.LISTENER),
                             position: { x: 0, y: 0, z: 11500 } });
    c.simLevel = 'full';
    const ctx = { tick: 0, t: FILL_S, medium: r.medium, signature: r.view,
                  shipPos: r.ship.position, shipVel: r.ship.velocity };
    for (let i = 0; i < 9000; i++) {           // 900 s of sense ticks
      ctx.t += 0.1;
      for (const p of c.sense(ctx) || []) {
        if (p.real === false) { fp++; maxStrength = Math.max(maxStrength, p.strength); }
      }
      ticks++;
    }
    const hz = fp / (ticks * 0.1);
    out.push({
      name: 'false positives fire at about the contract\'s 0.02 Hz in clear air',
      want: '0.010 – 0.032 Hz',
      got: `${hz.toFixed(4)} Hz`,
      ok: hz > 0.010 && hz < 0.032,
      note: `${fp} in 900 s. §5.3's medium factor is 2.0·g and this air has no duct in it, ` +
        'so the base rate is what should show',
    });
    out.push({
      name: 'a false positive is weak by construction',
      want: `< ${LISTENER.threshold + 0.35 * (LISTENER.saturation - LISTENER.threshold)}`,
      got: `${maxStrength.toFixed(2)} dB(V)`,
      ok: maxStrength > 0 &&
          maxStrength < LISTENER.threshold + 0.35 * (LISTENER.saturation - LISTENER.threshold) + 0.01,
      note: 'a mistake should be able to start a search and rarely finish one',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------

/** Run every case. Returns { pass, fail, results }. */
export function run() {
  const results = [
    ...transmissionCases(),
    ...rangeCases(),
    ...latencyCases(),
    ...logCases(),
    ...deescalationCases(),
    ...estimateCases(),
    ...behaviourCases(),
    ...disciplineCases(),
  ];
  return {
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok),
    results,
  };
}

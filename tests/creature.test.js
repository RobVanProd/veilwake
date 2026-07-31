// The creature layer, measured.
//
// Same shape as `controls.test.js`: `run()` returns `{ pass, fail, results }` and
// every case reports the number it measured, not the assertion it made. The rule
// that file learned the hard way applies here too — a check that restates the
// implementation tests that the code does what it does. So: the transmission
// cases are checked against the worked values written in the contract, not
// against the formula in `creature.js`; the state machine is driven and its log
// is read back rather than its thresholds being compared; the propagation delay
// is found by recording a burst and looking for when it is heard.
//
// Everything here runs headless. There is no Three.js import and no WebGL
// context anywhere in this file or in anything it imports, because a test that
// needs a GPU is a test that stops being run.
//
// HOW TO RUN
//
//   Open any page of the project (http://127.0.0.1:8182/) and paste:
//
//     const T = await import('/tests/creature.test.js?v=' + Date.now()); T.mount();
//
//   `mount()` renders a table into the page. `T.run()` returns the raw result and
//   `T.report()` returns it as text for a console. The cache-buster is not
//   optional: the browser will happily serve the module graph from before your
//   edit and make a fixed bug look unfixed.
//
//   When `tests/index.html` is free to edit, two lines add it to the runner:
//     const C = await import(`./creature.test.js?v=${v}&bust=${v}`);
//     ...merge C.run() into the same table.

import {
  Creature, CreatureManager, Listener, LISTENER, CorridorField, createCarvingSource,
  STATE, STATE_ORDER, STATE_ENTRY, stateExit, SENSE_PERIOD, SENSE_DT,
  FAR_PLANE, ACOUSTIC_REF, SOUND_SPEED, PATH_SAMPLES, MEDIUM_SAMPLE_BUDGET,
  visibilityM, soundDelayS, ductFromField, pathTerms, acousticReceived,
  acousticBearingSigma, makePercept, perceptExcess, azimuth, azimuthDir, wrapAngle,
  createMedium, createFlatMedium, countingMedium, createSignatureView,
  PositionHistory, formatEvent, vec, vdist,
} from '../src/game/creatures/index.js';
import { SignatureRecorder } from '../src/game/signature.js';
import { Rng, seedFrom } from '../src/core/rng.js';

const DT = 1 / 120;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CASES = [];
/** @param {string} name @param {() => {ok:boolean, detail:string}} fn */
const test = (name, fn) => CASES.push({ name, fn });

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(b));
const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n) : String(x));

// ---------------------------------------------------------------------------
// Synthetic worlds
// ---------------------------------------------------------------------------

/**
 * A `CloudSystem`-shaped source with a field that can be moved.
 *
 * The advection array is the real one's mechanism: `CloudSystem.densityAt` has no
 * time parameter, and the field's time dependence lives entirely in
 * `field.shapeAdvect`. Reproducing that here is what makes the cache-determinism
 * case a real test rather than a test of a stub.
 */
function makeSource({ scale = 900, amp = 0.5, bias = 0.5 } = {}) {
  const field = { shapeAdvect: [0, 0, 0] };
  const counts = { densityAt: 0, flowAt: 0 };
  const density = (x, y, z) => {
    const a = field.shapeAdvect;
    const u = (x + a[0]) / scale, v = (y + a[1]) / scale, w = (z + a[2]) / scale;
    return Math.max(0, Math.min(1,
      bias + amp * Math.sin(u) * Math.cos(v * 0.7) * Math.sin(w * 1.3)));
  };
  return {
    field, counts,
    densityAt(x, y, z) { counts.densityAt++; return density(x, y, z); },
    flowAt(x, y, z, out = {}) {
      counts.flowAt++;
      // Three internal density evaluations, exactly like CloudSystem.flowAt.
      const a = density(x, y - 26, z), b = density(x, y + 26, z), c = density(x, y, z);
      out.x = 11; out.y = (b - a) * 46; out.z = -4.6;
      out.turbulence = Math.max(0, Math.min(1, 1 - Math.abs(c * 2 - 1)));
      return out;
    },
  };
}

/** A density-only source: legal per `createMedium`'s own guard, and it used to throw. */
const densityOnlySource = () => ({ densityAt: () => 0.2 });

/** Path terms at a distance through a stated uniform medium. */
function termsAt(d, opts = {}) {
  const m = createFlatMedium(opts);
  return pathTerms(m, 0, 0, 0, 0, 0, d, 0, {});
}

/** A creature whose stimulus a test sets directly. Everything above it is real. */
class Probe extends Creature {
  constructor(o = {}) {
    super({
      archetype: 'Probe', threshold: 16, saturation: 60,
      fillRate: LISTENER.fillRate, decayRate: LISTENER.decayRate,
      memorySec: LISTENER.memorySec, ...o,
    });
    this.stim = 0;
    this.senses = 0;
    this.simLevel = o.simLevel ?? 'full';
  }
  sense() {
    this.senses++;
    if (this.stim <= 0) return [];
    return [makePercept('acoustic', this.stim, 0, 0.03, 0, 1, true,
      { emitted: 46, distance: 1000 })];
  }
}

function ctxAt(t, tick, shipPos = vec(0, 0, 1000)) {
  return { t, tick, shipPos, medium: null, signature: null };
}

/** Drive one creature for `seconds`, returning the tick it first reached `state`. */
function driveTo(c, state, seconds = 60) {
  const n = Math.round(seconds * 120);
  for (let tick = 0; tick < n; tick++) {
    c.update(DT, tick, ctxAt(tick * DT, tick));
    if (c.state === state) return tick * DT;
  }
  return null;
}

/**
 * A whole scripted world: a real `SignatureRecorder`, a real `PositionHistory`,
 * a medium, and whatever creatures the case wants.
 */
function scriptedWorld({
  seconds, creatures, medium, shipPosAt, acousticAt, manager = null, onStep = null,
}) {
  const rec = new SignatureRecorder();
  const positions = new PositionHistory();
  const signature = createSignatureView(rec, { positions });
  const ctx = { t: 0, tick: 0, shipPos: vec(), medium, signature };
  const values = { acoustic: 0, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 };
  const n = Math.round(seconds * 120);

  for (let tick = 0; tick < n; tick++) {
    const t = tick * DT;
    const sp = shipPosAt(t);
    ctx.t = t; ctx.tick = tick; ctx.shipPos = sp;
    // Record before sensing: age 0 must exist by the time anything reads it.
    values.acoustic = acousticAt(t);
    rec.update(DT, t, values);
    positions.record(DT, t, sp);

    if (manager) manager.update(DT, tick, ctx);
    else for (const c of creatures) c.update(DT, tick, ctx);
    if (onStep) onStep(t, tick, ctx);
  }
  return { rec, positions, signature, ctx };
}

// ---------------------------------------------------------------------------
// §1 and §4 — the formulas, against the contract's own worked values
// ---------------------------------------------------------------------------

test('§1 visibility_m reproduces the contract sanity table', () => {
  const want = [[0, 4000], [0.25, 987], [0.5, 244], [0.75, 60], [1, 15]];
  const got = want.map(([rho]) => visibilityM(rho));
  // Tolerance is half of the contract's own last printed digit, not a flat
  // percentage. The table is published to three significant figures, so "15"
  // means anything from 14.5 to 15.5, and the measured 14.8 is inside it. A flat
  // 1% tolerance called that a failure — it was measuring the contract's
  // rounding rather than the implementation's accuracy.
  // Half a unit, since the table prints integers, or 0.5% for the large values
  // where three significant figures is the real limit. 14.8 against a printed
  // "15" is inside the rounding; a flat 1% called it a failure.
  const ok = want.every(([, w], i) => Math.abs(got[i] - w) <= Math.max(0.5, w * 0.005) + 1e-9);
  return { ok, detail: got.map((g) => f(g, 1)).join(' / ') + '  vs  4000/987/244/60/15' };
});

test('§4.1 acoustic transmission hits every worked value within 5%', () => {
  const cases = [
    [300, 0, 36.5], [1000, 0, 26.0], [3000, 0, 16.5], [6000, 0, 10.4], [6000, 1, 24.7],
  ];
  const got = cases.map(([d, g]) => acousticReceived(46, termsAt(d, { duct: g })));
  const worst = Math.max(...cases.map(([, , w], i) => Math.abs(got[i] - w)));
  return {
    ok: worst < 0.05,
    detail: cases.map(([d, g], i) => `${d}m${g ? ' duct' : ''} ${f(got[i], 2)}`).join(', ')
      + `  worst Δ ${f(worst, 3)} dB`,
  };
});

test('§10.1 sense ranges fall out: 3.2 km at threshold 16, 10 km at 6', () => {
  const rangeFor = (thr) => {
    let lo = 100, hi = FAR_PLANE * 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (acousticReceived(46, termsAt(mid)) >= thr) lo = mid; else hi = mid;
    }
    return lo;
  };
  const a = rangeFor(LISTENER.threshold), b = rangeFor(LISTENER.listeningThreshold);
  // The factor is sqrt(10) = 3.1623, exactly, and that is the point rather than
  // a near miss. The two thresholds differ by 10 dB, and under 20*log10(r)
  // spherical spreading a 10 dB difference IS a sqrt(10) difference in range.
  // The contract prints 3.2 because it is prose; the implementation is more
  // precise than its own specification, and asserting against the rounded figure
  // to two decimal places failed a formula that is exactly correct.
  const ok = pct(a, 3200) < 0.02 && pct(b, 10000) < 0.01 && near(b / a, Math.sqrt(10), 0.01);
  return { ok, detail: `${f(a, 0)} m → ${f(b, 0)} m, factor ${f(b / a, 3)} (= sqrt(10), contract prints 3.2)` };
});

test('§2.3 duct is derived, not authored: 0 flat, 1 at a gradient, 0 in a core', () => {
  const flat = ductFromField(0, 0.1);
  const shear = ductFromField(0.002, 0.1);
  const core = ductFromField(0.002, 0.95);
  return {
    ok: flat === 0 && shear > 0.99 && core === 0,
    detail: `flat ${f(flat, 3)}, shear ${f(shear, 3)}, dense core ${f(core, 3)}`,
  };
});

test('§4.1 bearing sigma grows with turbulence and duct, as stated', () => {
  const clear = acousticBearingSigma(termsAt(3000));
  const ducted = acousticBearingSigma(termsAt(3000, { duct: 1 }));
  const rough = acousticBearingSigma(termsAt(3000, { turbulence: 1, duct: 1 }));
  return {
    ok: near(clear, 0.03, 1e-9) && near(ducted, 0.53, 1e-9) && near(rough, 1.43, 1e-9),
    detail: `clear ${f(clear, 3)}, duct ${f(ducted, 3)}, duct+turbulence ${f(rough, 3)} rad`,
  };
});

test('azimuth and azimuthDir are exact inverses over 64 bearings', () => {
  let worst = 0;
  const from = vec(137, -22, 401);
  for (let i = 0; i < 64; i++) {
    const a = -Math.PI + (i + 0.5) * (Math.PI * 2) / 64;
    const d = azimuthDir(a);
    // Measured against a direction built here, never against a world axis.
    const to = vec(from.x + d.x * 1000, from.y, from.z + d.z * 1000);
    worst = Math.max(worst, Math.abs(wrapAngle(azimuth(from, to) - a)));
  }
  return { ok: worst < 1e-12, detail: `max round-trip error ${worst.toExponential(2)} rad` };
});

// ---------------------------------------------------------------------------
// §5.4 — the attention integrator
// ---------------------------------------------------------------------------

test('§5.4 UNAWARE → COMMITTED in 19 s at excess 0.4', () => {
  const p = new Probe();
  p.stim = p.threshold + 0.4 * (p.saturation - p.threshold);
  const t = driveTo(p, STATE.COMMITTED, 60);
  return { ok: t !== null && near(t, 19, 0.5), detail: `${f(t, 2)} s (contract 19 s)` };
});

test('§6 the ladder walks one rung at a time, one event per rung', () => {
  const p = new Probe();
  p.stim = p.threshold + 0.4 * (p.saturation - p.threshold);
  driveTo(p, STATE.COMMITTED, 60);
  const log = p.detectionLog();
  const pairs = log.map((e) => `${e.from}→${e.to}`);
  const ok = p.transitionCount() === 4 && log.length === 4 &&
    pairs.join(' ') === 'UNAWARE→ALERT ALERT→SEARCHING SEARCHING→TRACKING TRACKING→COMMITTED';
  return { ok, detail: log.map((e) => `${f(e.simTime, 1)}s ${e.from}→${e.to}`).join(', ') };
});

// ---------------------------------------------------------------------------
// §6 — the escalation machine, including the bug that was in it
// ---------------------------------------------------------------------------

test('§6 leaving COMMITTED lands in SEARCHING and stays there (was COMMITTED→TRACKING)', () => {
  // The exact band the audit found: COMMITTED's exit is 0.736 and TRACKING's
  // entry is 0.70, so every decaying creature passes through this.
  const bad = [];
  for (let a = 0.700; a <= 0.7359; a += 0.0005) {
    const p = new Probe();
    p.state = STATE.COMMITTED;
    p.attention = a;
    p._resolveStates(ctxAt(0, 0), null);
    if (p.state !== STATE.SEARCHING) bad.push(`${f(a, 4)}→${p.state}`);
    const jumped = p.detectionLog().some((e) => e.from === STATE.COMMITTED && e.to === STATE.TRACKING);
    const laundered = p.detectionLog().some((e) => e.from === STATE.SEARCHING && e.to === STATE.TRACKING);
    if (jumped || laundered) bad.push(`${f(a, 4)} re-escalated in the same tick`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join(', ') : '72 attention values, all land SEARCHING' };
});

test('§6 a creature that loses you hunts the area — no COMMITTED→TRACKING in a full decay', () => {
  const p = new Probe();
  p.stim = p.threshold + 0.4 * (p.saturation - p.threshold);
  driveTo(p, STATE.COMMITTED, 60);
  p.attention = 0.92;
  p.stim = 0;
  const trace = [];
  for (let tick = 0; tick < 120 * 200; tick++) {
    const before = p.state;
    p.update(DT, tick, ctxAt(tick * DT, tick));
    if (p.state !== before) trace.push(`${f(tick * DT, 1)}s ${before}→${p.state}`);
    if (p.state === STATE.UNAWARE) break;
  }
  const afterCommit = trace.find((s) => s.includes('COMMITTED→'));
  return {
    ok: !!afterCommit && afterCommit.includes('COMMITTED→SEARCHING'),
    detail: trace.join(', ') || 'no de-escalation observed',
  };
});

test('§6 the machine settles in one tick — 1005 (state, attention) pairs', () => {
  let unsettled = 0;
  for (const s of STATE_ORDER) {
    for (let i = 0; i <= 200; i++) {
      const p = new Probe();
      p.state = s;
      p.attention = i / 200;
      p._resolveStates(ctxAt(0, 0), null);
      const first = p.state;
      p._resolveStates(ctxAt(0, 0), null);
      if (p.state !== first) unsettled++;
    }
  }
  return { ok: unsettled === 0, detail: `${unsettled} of 1005 changed on a second resolve` };
});

test('§6 hysteresis suppresses chatter at all four boundaries', () => {
  const flips = [];
  for (const s of ['ALERT', 'SEARCHING', 'TRACKING', 'COMMITTED']) {
    const p = new Probe();
    p.attention = STATE_ENTRY[STATE[s]];
    p.state = STATE[s];
    let n = 0, last = p.state;
    for (let tick = 0; tick < 120 * 10; tick++) {
      // Alternate percept / no percept every sense tick, holding attention on
      // the line. Without hysteresis this is a state change every 0.1 s.
      p.attention = STATE_ENTRY[STATE[s]];
      p.stim = (Math.floor(tick / SENSE_PERIOD) % 2) ? p.threshold + 1 : 0;
      p.update(DT, tick, ctxAt(tick * DT, tick));
      if (p.state !== last) { n++; last = p.state; }
    }
    flips.push(`${s} ${n}`);
  }
  return { ok: flips.every((s) => s.endsWith(' 0')), detail: flips.join(', ') };
});

// ---------------------------------------------------------------------------
// §5.3 — false positives
// ---------------------------------------------------------------------------

test('§5.3 false-positive rate is 0.02 Hz, and 0.06 Hz at duct 1', () => {
  const measure = (mediumFactor) => {
    let hits = 0, ticks = 0;
    for (let seed = 0; seed < 6; seed++) {
      const p = new Probe({ rng: new Rng(seedFrom(`fp:${seed}`)), falsePositiveBase: 0.02 });
      for (let i = 0; i < 40000; i++) {
        if (p.rollFalsePositive(mediumFactor, 0, 0.1, 'acoustic')) hits++;
        ticks++;
      }
    }
    return hits / (ticks * SENSE_DT);
  };
  const base = measure(0), ducted = measure(2.0 * 1.0);
  return {
    ok: pct(base, 0.02) < 0.08 && pct(ducted, 0.06) < 0.08,
    detail: `base ${f(base, 4)} Hz (0.02), duct ${f(ducted, 4)} Hz (0.06), 240k ticks each`,
  };
});

test('§5.3 two creatures forked from one parent do not share a mistake sequence', () => {
  const parent = new Rng(seedFrom('shared'));
  const a = new Probe({ rng: parent, falsePositiveBase: 0.5 });
  const b = new Probe({ rng: parent, falsePositiveBase: 0.5 });
  let same = 0;
  for (let i = 0; i < 2000; i++) {
    if (!!a.rollFalsePositive(0, 0, 0.1, 'acoustic') === !!b.rollFalsePositive(0, 0, 0.1, 'acoustic')) same++;
  }
  // The bound this shipped with was `same < 1800`, justified by "independent
  // streams agree by chance about 50% of the time". True of a coin, false of this
  // experiment — which makes it the guessed constant HANDOFF.md's standing
  // discipline warns about, committed in a test rather than in a module. Each
  // draw is a rare event, not a coin flip: the rate is
  // falsePositiveBase · (1 + mediumFactor) · SENSE_DT = 0.5 · 1 · 0.1 = 0.05, so
  // two INDEPENDENT streams agree whenever both fire or neither does —
  // 0.05² + 0.95² = 90.5%, about 1810 of 2000 with a standard deviation near 13.
  // The old bound sat below the expected value of a passing run and could never
  // be met by correct code.
  const p = 0.5 * SENSE_DT;
  const expected = 2000 * (p * p + (1 - p) * (1 - p));
  // 1900 is seven standard deviations above that expectation and a hundred draws
  // clear of the 2000 a shared stream would produce; the lower bound catches a
  // stream that has stopped producing variety at all.
  return {
    ok: same < 1900 && same > 1700,
    detail: `${same}/2000 draws agreed; independent streams predict ${f(expected, 0)} ` +
      `at p=${p}, a shared stream would give 2000`,
  };
});

// ---------------------------------------------------------------------------
// §3.4 / §5.2 — the signature view, and the age-versus-absolute-time bug
// ---------------------------------------------------------------------------

test('§5.2 the view reads an AGE, and agrees with SignatureRecorder.at', () => {
  const rec = new SignatureRecorder();
  const v = createSignatureView(rec);
  for (let i = 0; i < 120 * 60; i++) rec.update(DT, (i + 1) * DT, { acoustic: (i + 1) * DT, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 });
  const age = soundDelayS(3000);              // 9.09 s
  const got = v.at(age);
  // The recorder stores acoustic = the sim time it was written at, so the value
  // read back is the timestamp of the sample and can be checked directly.
  const ok = got !== null && near(got.acoustic, 60 - age, 0.6) && near(got.simTime, 60 - age, 0.6);
  return { ok, detail: `at(${f(age, 2)}) → simTime ${f(got && got.simTime, 2)} (want ≈${f(60 - age, 2)})` };
});

test('§5.2 the view still works past the recorder length — the old bug was silent deafness', () => {
  const rec = new SignatureRecorder();
  const v = createSignatureView(rec);
  for (let i = 0; i < 120 * 400; i++) rec.update(DT, (i + 1) * DT, { acoustic: (i + 1) * DT, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 });
  const ds = [300, 3000, 6000, 12000];
  const got = ds.map((d) => v.at(soundDelayS(d)));
  const ok = got.every((g, i) => g !== null && near(g.simTime, 400 - soundDelayS(ds[i]), 0.6));
  return {
    ok,
    detail: ds.map((d, i) => `${d}m→${got[i] ? f(got[i].simTime, 1) : 'null'}`).join(', ') + '  at t=400 s',
  };
});

test('§5.2 asking for something older than the buffer returns null, not the present', () => {
  const rec = new SignatureRecorder();
  const v = createSignatureView(rec);
  for (let i = 0; i < 120 * 20; i++) rec.update(DT, (i + 1) * DT, { acoustic: 46, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 });
  const inside = v.at(10), outside = v.at(60);
  return {
    ok: inside !== null && outside === null,
    detail: `span ${f(v.spanSec(), 1)} s: at(10) ${inside ? 'sample' : 'null'}, at(60) ${outside ? 'sample' : 'null'}`,
  };
});

test('PositionHistory interpolates and reproduces a known track', () => {
  const p = new PositionHistory();
  const v = 148;
  for (let i = 0; i < 120 * 120; i++) {
    const t = (i + 1) * DT;
    p.record(DT, t, { x: 0, y: 0, z: v * t });
  }
  const errs = [1, 5, 9.09, 30, 90].map((age) => {
    const q = p.at(age);
    return Math.abs(q.z - v * (120 - age));
  });
  const worst = Math.max(...errs);
  return { ok: worst < 2, detail: `worst position error ${f(worst, 2)} m over a 148 m/s track` };
});

// ---------------------------------------------------------------------------
// §2 — the medium adapter
// ---------------------------------------------------------------------------

test('§2.1 the derived-field cache is deterministic: warm equals cold', () => {
  const src = makeSource();
  const warmM = createMedium(src);
  const p = [3353, 850, 1573];

  // Warm the cache at one field state, then move the field, then re-sample.
  warmM.sample(p[0], p[1], p[2], 5.0);
  src.field.shapeAdvect[0] += 900;
  const warm = { ...warmM.sample(p[0], p[1], p[2], 5.0) };

  const coldM = createMedium(src);
  const cold = { ...coldM.sample(p[0], p[1], p[2], 5.0) };

  const dDuct = Math.abs(warm.duct - cold.duct);
  const dTurb = Math.abs(warm.turbulence - cold.turbulence);
  const dRho = Math.abs(warm.density - cold.density);
  return {
    ok: dDuct === 0 && dTurb === 0 && dRho === 0,
    detail: `Δduct ${dDuct.toExponential(1)}, Δturbulence ${dTurb.toExponential(1)}, Δrho ${dRho.toExponential(1)}`,
  };
});

test('§2.1 the same field state gives the same answer however warm the cache is', () => {
  const src = makeSource();
  const m = createMedium(src);
  const first = { ...m.sample(1200, 300, -800, 0) };
  for (let i = 0; i < 200; i++) m.sample(i * 37 - 3000, 200, i * 53 - 2000, 0);
  const again = { ...m.sample(1200, 300, -800, 3.7) };
  return {
    ok: first.duct === again.duct && first.turbulence === again.turbulence && first.density === again.density,
    detail: `duct ${f(first.duct, 6)} vs ${f(again.duct, 6)}, turbulence ${f(first.turbulence, 6)} vs ${f(again.turbulence, 6)}`,
  };
});

test('§2 a density-only source samples instead of throwing', () => {
  let threw = null, s = null;
  try { s = { ...createMedium(densityOnlySource()).sample(0, 0, 0, 0) }; }
  catch (e) { threw = e.message; }
  return {
    ok: !threw && s.density === 0.2 && s.turbulence === 0 && s.flow.x === 0,
    detail: threw ? `threw: ${threw}` : `density ${f(s.density, 2)}, still air, duct ${f(s.duct, 2)}`,
  };
});

test('§8 the sample counter and the real field cost are both reported, and differ', () => {
  const src = makeSource();
  const m = countingMedium(createMedium(src));
  const c0 = { ...src.counts };
  pathTerms(m, 0, 200, 0, 0, 200, 6000, 0, {});
  const samples = m.samplesTaken();
  const evals = m.fieldEvals();
  const realDensity = src.counts.densityAt - c0.densityAt;
  const realFlow = src.counts.flowAt - c0.flowAt;
  // flowAt makes three density evaluations of its own, exactly as CloudSystem does.
  const trueCost = realDensity + realFlow * 3;
  return {
    ok: samples === PATH_SAMPLES && evals.densityAt === realDensity && evals.flowAt === realFlow
      && trueCost > samples * 4,
    detail: `sample() ${samples}, densityAt ${evals.densityAt}, flowAt ${evals.flowAt}` +
      `  → ${trueCost} real field evaluations, ${f(trueCost / samples, 1)}× the counter`,
  };
});

// ---------------------------------------------------------------------------
// The Listener
// ---------------------------------------------------------------------------

function makeListener(o = {}) {
  return new Listener({
    id: 0, rng: new Rng(seedFrom(o.seed || 'listener')),
    position: vec(0, 200, 0), falsePositiveBase: 0, ...o,
  });
}

test('§8 a reduced creature never senses; a full one senses at exactly 10 Hz', () => {
  const clear = createFlatMedium({ density: 0 });
  const reduced = makeListener({ seed: 'a' });
  const full = makeListener({ seed: 'a' });
  full.simLevel = 'full';
  let rn = 0, fn = 0;
  const wrap = (c, count) => { const s = c.sense.bind(c); c.sense = (x) => { count(); return s(x); }; };
  wrap(reduced, () => rn++);
  wrap(full, () => fn++);
  scriptedWorld({
    seconds: 1, creatures: [reduced, full], medium: clear,
    shipPosAt: () => vec(0, 200, 1000), acousticAt: () => 46,
  });
  return { ok: rn === 0 && fn === 10, detail: `reduced ${rn} sense ticks, full ${fn} in one second` };
});

test('§5.2 the propagation delay is observable: heard for something done 9 s ago', () => {
  const clear = createFlatMedium({ density: 0 });
  const l = makeListener({ seed: 'delay' });
  l.simLevel = 'full';
  l.carving = false;
  const heard = [];
  const base = l.onPercept.bind(l);
  l.onPercept = (p, c) => { heard.push({ t: c.t, emitted: p.emitted, age: p.ageSec }); base(p, c); };

  // HOLD THE GEOMETRY STILL. This is the instrument, not the subject, and getting
  // it wrong here produced a result that looked exactly like a bug in the
  // transmission model: the creature was left free to patrol for the 100 s before
  // the burst, closed 300 m in that time, and so the true delay when the sound
  // arrived was 8.20 s — while the assertion was still computing 9.09 s from the
  // distance it started at. It reported the burst arriving 0.59 s EARLY, and
  // hearing something before the sound could reach you is precisely the kind of
  // impossible result that sends the next person off to rewrite correct code.
  // controls.test.js records the same lesson in its own header.
  const held = vec(l.position.x, l.position.y, l.position.z);
  const shipPos = vec(0, 200, 3000);
  const D = vdist(held, shipPos);

  scriptedWorld({
    seconds: 118, creatures: [l], medium: clear,
    shipPosAt: () => shipPos,
    // A 70 dB burst for two seconds on top of a 46 dB cruise floor.
    acousticAt: (t) => (t >= 100 && t < 102 ? 70 : 46),
    onStep: () => { l.position.x = held.x; l.position.y = held.y; l.position.z = held.z; },
  });

  const burst = heard.filter((h) => h.emitted > 60);
  const first = burst.length ? burst[0].t : null;
  const expect = 100 + soundDelayS(D);
  // Late is expected and honest — the recorder buckets at 2 Hz and the sense tick
  // is 0.1 s, so the burst cannot be noticed before the first bucket boundary past
  // its arrival. Early would mean hearing something before it happened, so the
  // window is deliberately asymmetric.
  return {
    ok: first !== null && first >= expect - 0.05 && first <= expect + 0.7
        && near(burst[0].age, soundDelayS(D), 0.3),
    detail: first === null ? 'the burst was never heard'
      : `emitted at t=100.0, first heard at t=${f(first, 2)} — a ${f(first - 100, 2)} s lag ` +
        `at ${f(D, 0)} m (soundDelay ${f(soundDelayS(D), 2)} s); percept age ${f(burst[0].age, 2)} s`,
  };
});

test('§4.1 the geometry uses where the ship WAS, not where it is', () => {
  const clear = createFlatMedium({ density: 0 });
  const l = makeListener({ seed: 'geom' });
  l.simLevel = 'full';
  const seen = [];
  const base = l.onPercept.bind(l);
  l.onPercept = (p, c) => { seen.push({ t: c.t, d: p.distance, exact: p.positionExact }); base(p, c); };
  const v = 148;
  scriptedWorld({
    seconds: 60, creatures: [l], medium: clear,
    // Flying straight away at cruise from 2 km out.
    shipPosAt: (t) => vec(0, 200, 2000 + v * t),
    acousticAt: () => 78,   // boost, so it stays audible as it leaves
  });
  const last = seen[seen.length - 1];
  const nowD = 2000 + v * last.t;
  const lag = nowD - last.d;
  return {
    ok: last.exact === true && lag > 500,
    detail: `at t=${f(last.t, 1)} the ship is ${f(nowD, 0)} m away; it was ranged at ${f(last.d, 0)} m ` +
      `— ${f(lag, 0)} m of flight time, positionExact ${last.exact}`,
  };
});

test('§10.1 the silence drops the threshold 16 → 6 and multiplies every range by 3.2', () => {
  const l = makeListener({ seed: 'silence' });
  const normal = l.currentThreshold();
  l.listening = true;
  const listening = l.currentThreshold();
  const rangeFor = (thr) => {
    let lo = 100, hi = 40000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (acousticReceived(46, termsAt(mid)) >= thr) lo = mid; else hi = mid;
    }
    return lo;
  };
  const a = rangeFor(normal), b = rangeFor(listening);
  return {
    ok: normal === 16 && listening === 6 && near(b / a, 3.162, 0.01),
    detail: `${normal} → ${listening} dB(V); cruise heard at ${f(a, 0)} m → ${f(b, 0)} m, ×${f(b / a, 3)}`,
  };
});

test('§10.1 the silence window fires every 100–160 s and lasts 18–26 s', () => {
  const l = makeListener({ seed: 'window' });
  l.simLevel = 'full';
  const windows = [];
  let open = null;
  const clear = createFlatMedium({ density: 0 });
  scriptedWorld({
    seconds: 700, creatures: [l], medium: clear,
    shipPosAt: () => vec(0, 200, 40000), acousticAt: () => 4,
    onStep: (t) => {
      if (l.listening && open === null) open = t;
      if (!l.listening && open !== null) { windows.push([open, t - open]); open = null; }
    },
  });
  const lens = windows.map((w) => w[1]);
  const gaps = windows.slice(1).map((w, i) => w[0] - (windows[i][0] + windows[i][1]));
  const ok = windows.length >= 4 &&
    lens.every((x) => x >= 17.9 && x <= 26.1) &&
    gaps.every((x) => x >= 99.9 && x <= 160.1);
  return {
    ok,
    detail: `${windows.length} windows; lengths ${lens.map((x) => f(x, 1)).join('/')} s; ` +
      `gaps ${gaps.map((x) => f(x, 1)).join('/')} s`,
  };
});

test('§10.1 during the silence it emits nothing and it does not move', () => {
  const l = makeListener({ seed: 'still' });
  l.simLevel = 'full';
  let movedWhileListening = 0, dbWhileListening = 0, samples = 0;
  let stillFraction = 0, listeningSteps = 0;
  const clear = createFlatMedium({ density: 0 });
  let prev = null;
  scriptedWorld({
    seconds: 400, creatures: [l], medium: clear,
    shipPosAt: () => vec(0, 200, 40000), acousticAt: () => 4,
    onStep: () => {
      if (l.listening) {
        listeningSteps++;
        if (prev) movedWhileListening = Math.max(movedWhileListening, vdist(l.position, prev) / DT);
        dbWhileListening = Math.max(dbWhileListening, l.emissionDb);
        if (l.speed < 1e-3) stillFraction++;
        samples++;
      }
      prev = vec(l.position.x, l.position.y, l.position.z);
    },
  });
  const frac = stillFraction / Math.max(listeningSteps, 1);
  return {
    ok: dbWhileListening === 0 && frac > 0.85,
    detail: `emission ${f(dbWhileListening, 1)} dB(V) while listening; fully stopped for ` +
      `${f(frac * 100, 1)}% of the window (peak speed ${f(movedWhileListening, 2)} m/s during the brake)`,
  };
});

test('§8 the Listener stays inside the 32-sample budget', () => {
  const src = makeSource();
  const medium = countingMedium(createMedium(src));
  const l = makeListener({ seed: 'budget' });
  l.simLevel = 'full';
  let worst = 0;
  scriptedWorld({
    seconds: 20, creatures: [l], medium,
    shipPosAt: () => vec(0, 200, 3000), acousticAt: () => 46,
    onStep: () => { worst = Math.max(worst, l.mediumSamplesLastTick); },
  });
  return {
    ok: worst > 0 && worst <= MEDIUM_SAMPLE_BUDGET,
    detail: `${worst} medium samples per sense tick, cap ${MEDIUM_SAMPLE_BUDGET} ` +
      `(${PATH_SAMPLES} path + 1 at the ear)`,
  };
});

test('§7 every state transition wrote a DetectionEvent, and the path terms are in it', () => {
  const clear = createFlatMedium({ density: 0.02, duct: 0.4 });
  const l = makeListener({ seed: 'explain' });
  l.simLevel = 'full';
  scriptedWorld({
    seconds: 40, creatures: [l], medium: clear,
    shipPosAt: () => vec(0, 200, 2000), acousticAt: () => 46,
  });
  const log = l.detectionLog();
  const escalations = log.filter((e) => e.channel === 'acoustic');
  const zeroed = escalations.filter((e) => e.medium.rho_mean === 0 && e.medium.g_mean === 0);
  return {
    ok: log.length === l.transitionCount() && escalations.length > 0 && zeroed.length === 0
      && escalations.every((e) => e.mediumFresh === true),
    detail: `${log.length} events for ${l.transitionCount()} transitions; ` +
      (escalations[0] ? formatEvent(escalations[escalations.length - 1]) : 'none'),
  };
});

test('§5.1 loudness and range are confounded — an idling ship is placed 25× too far', () => {
  const clear = createFlatMedium({ density: 0 });
  const run = (db, distance) => {
    const l = makeListener({ seed: 'confound' });
    l.simLevel = 'full';
    scriptedWorld({
      seconds: 12, creatures: [l], medium: clear,
      shipPosAt: () => vec(0, 200, distance), acousticAt: () => db,
    });
    return l.estimate ? l.estimate.range : null;
  };
  // A cruising ship, which is what it assumes, is placed correctly.
  const cruise = run(46, 3000);
  // An idling ship on the edge of audibility is placed at the same loudness,
  // which it reads as three kilometres.
  const idle = run(18, 125);
  return {
    ok: cruise !== null && pct(cruise, 3000) < 0.02 && idle !== null && idle / 125 > 15,
    detail: `cruise at 3000 m → estimated ${f(cruise, 0)} m; idle at 125 m → estimated ` +
      `${f(idle, 0)} m (${f(idle / 125, 1)}× too far)`,
  };
});

test('§7.1 it does not turn towards the player without a percept', () => {
  const clear = createFlatMedium({ density: 0 });
  const l = makeListener({ seed: 'nopercept' });
  l.simLevel = 'full';
  let closest = Infinity, escalated = false;
  scriptedWorld({
    seconds: 200, creatures: [l], medium: clear,
    // Powered down and drifting: contract §3.2 row 1 is 4 dB(V).
    shipPosAt: () => vec(0, 200, 2500), acousticAt: () => 4,
    onStep: () => {
      closest = Math.min(closest, vdist(l.position, vec(0, 200, 2500)));
      if (l.state !== STATE.UNAWARE) escalated = true;
    },
  });
  return {
    ok: !escalated && l.estimate === null && l.attention === 0,
    detail: `state ${l.state}, attention ${f(l.attention, 4)}, estimate ${l.estimate ? 'set' : 'null'}; ` +
      `a 4 dB(V) hull at 2.5 km is inaudible against a 16 dB(V) threshold`,
  };
});

// ---------------------------------------------------------------------------
// §10.1 — corridors, and §2.3's claim that they duct on their own
// ---------------------------------------------------------------------------

test('§2.3 a carved corridor produces a duct where uniform air produces none', () => {
  const uniform = {
    field: { shapeAdvect: [0, 0, 0] },
    densityAt: () => 0.5,
    flowAt: (x, y, z, out = {}) => { out.x = 0; out.y = 0; out.z = 0; out.turbulence = 0; return out; },
  };
  const plain = createMedium(uniform);
  const flat = plain.sample(0, 200, 1000, 0).duct;

  const field = new CorridorField({ radiusM: LISTENER.corridorRadiusM, lifeSec: 240 });
  for (let z = -1000; z <= 8000; z += 100) field.carve(0, 200, z, 0);
  field.tick(10);
  const carved = createMedium(createCarvingSource(uniform, field));

  const profile = [];
  for (let r = 0; r <= 320; r += 20) profile.push([r, carved.sample(r, 200, 1000, 10).duct]);
  const peak = profile.reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    ok: flat === 0 && peak[1] > 0.5,
    detail: `uniform air duct ${f(flat, 3)}; corridor peaks at ${f(peak[1], 3)} at r=${peak[0]} m ` +
      `(axis ${f(profile[0][1], 3)}, wall band ${profile.filter((p) => p[1] > 0.1).map((p) => p[0]).join('/')} m)`,
  };
});

test('§10.1 the corridor is the place a call carries — measured in dB at 6 km', () => {
  const uniform = {
    field: { shapeAdvect: [0, 0, 0] },
    densityAt: () => 0.35,
    flowAt: (x, y, z, out = {}) => { out.x = 0; out.y = 0; out.z = 0; out.turbulence = 0; return out; },
  };
  const field = new CorridorField({ radiusM: LISTENER.corridorRadiusM, lifeSec: 240 });
  for (let z = -400; z <= 6400; z += 100) field.carve(0, 200, z, 0);
  field.tick(10);

  const open = createMedium(uniform);
  const carved = createMedium(createCarvingSource(uniform, field));
  // A flight line 110 m off the axis, which is inside the 300 m corridor.
  const off = 110;
  const a = acousticReceived(46, pathTerms(open, off, 200, 0, off, 200, 6000, 10, {}));
  const b = acousticReceived(46, pathTerms(carved, off, 200, 0, off, 200, 6000, 10, {}));
  return {
    ok: b - a > 10,
    detail: `open vapour ${f(a, 1)} dB, same path inside the corridor ${f(b, 1)} dB — ` +
      `${f(b - a, 1)} dB, inaudible to obvious against a 16 dB(V) threshold`,
  };
});

test('§2.2 carving is off by default, so the creature cannot use a corridor the player cannot see', () => {
  const l = makeListener({ seed: 'carveoff' });
  l.simLevel = 'full';
  const clear = createFlatMedium({ density: 0 });
  scriptedWorld({
    seconds: 60, creatures: [l], medium: clear,
    shipPosAt: () => vec(0, 200, 40000), acousticAt: () => 4,
  });
  const off = l.corridor.liveCount();
  const l2 = makeListener({ seed: 'carveon', carving: true });
  l2.simLevel = 'full';
  scriptedWorld({
    seconds: 60, creatures: [l2], medium: clear,
    shipPosAt: () => vec(0, 200, 40000), acousticAt: () => 4,
  });
  const on = l2.corridor.liveCount();
  return {
    ok: l.carving === false && off === 0 && on > 0,
    detail: `carving:false → ${off} segments; carving:true → ${on} segments in 60 s of patrol`,
  };
});

// ---------------------------------------------------------------------------
// The manager — §6 and §8
// ---------------------------------------------------------------------------

test('§6 only one creature is COMMITTED, and the demotion is in the log', () => {
  const mgr = new CreatureManager();
  const probes = [0, 1, 2].map((i) => mgr.add(new Probe({ id: i, position: vec(i * 10, 0, 0) })));
  for (const p of probes) p.stim = p.threshold + 0.4 * (p.saturation - p.threshold);
  const ctx = ctxAt(0, 0);
  for (let tick = 0; tick < 120 * 30; tick++) {
    ctx.t = tick * DT; ctx.tick = tick;
    mgr.update(DT, tick, ctx);
  }
  const committed = probes.filter((p) => p.state === STATE.COMMITTED);
  const yields = mgr.detectionLog().filter((e) => e.channel === 'yield');
  return {
    ok: committed.length === 1 && yields.length >= 2,
    detail: `${committed.length} COMMITTED of 3 identical probes; ` +
      `${yields.length} yield events logged; states ${probes.map((p) => p.state).join('/')}`,
  };
});

test('§8 at most six are fully simulated, and every promotion is logged', () => {
  const mgr = new CreatureManager({ maxFull: 6 });
  const probes = [];
  for (let i = 0; i < 9; i++) {
    const p = new Probe({ id: i, position: vec(0, 0, 200 + i * 100), longestSenseRange: 3000, simLevel: 'reduced' });
    probes.push(mgr.add(p));
  }
  const ctx = ctxAt(0, 0, vec(0, 0, 0));
  for (let tick = 0; tick <= 24; tick++) { ctx.t = tick * DT; ctx.tick = tick; mgr.update(DT, tick, ctx); }
  const full = probes.filter((p) => p.fullySimulated);
  const promos = mgr.detectionLog().filter((e) => e.channel === 'promotion');
  const radius = probes[0].promotionRadius;
  return {
    ok: full.length === 6 && promos.length === 6 && near(radius, 4200, 1e-9),
    detail: `${full.length} full of 9 (cap 6), ${promos.length} promotion events; ` +
      `promotion radius ${f(radius, 0)} m = 1.4 × 3000`,
  };
});

test('§8 the reduced model never produces a detection', () => {
  const mgr = new CreatureManager();
  // Placed beyond its own promotion radius with an overwhelming stimulus
  // waiting for it. If the reduced model could detect, this would commit.
  const p = mgr.add(new Probe({ id: 0, position: vec(0, 0, 9000), longestSenseRange: 3000, simLevel: 'reduced' }));
  p.stim = 60;
  const ctx = ctxAt(0, 0, vec(0, 0, 0));
  for (let tick = 0; tick < 120 * 60; tick++) { ctx.t = tick * DT; ctx.tick = tick; mgr.update(DT, tick, ctx); }
  const detections = mgr.detectionLog().filter((e) => e.channel !== 'promotion');
  return {
    ok: p.senses === 0 && detections.length === 0 && p.state === STATE.UNAWARE,
    detail: `${p.senses} sense ticks in 60 s at 9 km (promotion radius ${f(p.promotionRadius, 0)} m); ` +
      `${detections.length} non-promotion events`,
  };
});

test('§12 the same seed and the same inputs reproduce the detection log exactly', () => {
  const play = () => {
    const mgr = new CreatureManager();
    const l = new Listener({
      id: 0, rng: new Rng(seedFrom('replay')), position: vec(0, 200, 0),
      falsePositiveBase: LISTENER.falsePositiveBase, carving: true,
    });
    l.simLevel = 'full';
    mgr.add(l);
    scriptedWorld({
      seconds: 240, creatures: [l], medium: createMedium(makeSource()), manager: mgr,
      // Close enough to actually be heard. The path this shipped with orbited
      // 2200–3100 m through a medium whose mean density is 0.5, which is 13–23 dB
      // of absorption on top of the spreading term: measured across the whole
      // 240 s the received level peaked at 15.73 dB(V) against a 16 dB threshold,
      // so the creature was correctly deaf for the entire run and `log.length > 0`
      // could never be true. A determinism case with nothing to compare passes
      // vacuously in one direction and fails permanently in the other; either way
      // it is not measuring replay. Halving the radii puts the ship between about
      // 700 m and 1500 m, which spans the threshold rather than sitting under it —
      // so the log now holds escalation *and* de-escalation, which is a stronger
      // thing to replay than a constant detection would have been.
      shipPosAt: (t) => vec(Math.sin(t * 0.05) * 700, 200, 1100 + Math.cos(t * 0.03) * 400),
      acousticAt: (t) => (t % 60 < 20 ? 18 : 46),
    });
    return { log: mgr.detectionLog(), l };
  };
  const a = play(), b = play();
  const sa = JSON.stringify(a.log), sb = JSON.stringify(b.log);
  return {
    ok: sa === sb && a.log.length > 0,
    detail: `${a.log.length} events, byte-identical across two runs: ${sa === sb}; ` +
      `${a.l.silenceCount} silence windows, ${a.l.callCount} calls`,
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
  globalThis.CREATURE_TESTS = r;
  return r;
}

// Self-runnable without editing the shared runner: import with `?autorun`.
if (typeof document !== 'undefined' && import.meta.url.includes('autorun')) mount();

// The Lantern, measured.
//
// Same shape as `controls.test.js`: `run()` returns `{ pass, fail, results }` and
// every case reports the number it measured rather than the assertion it made.
// The rule that file learned the hard way applies here too — a check that
// restates the implementation tests that the code does what it does. So nothing
// below reads `LANTERN.dimRate` and asserts the dimming; the creature is driven
// against a synthetic ship for as long as it takes and the lights are read.
//
// Two things this file goes out of its way to do, because they are the two ways
// this creature could be wrong in a way that looked right:
//
// 1. **The detection ranges are found by bisection through `sense()`**, not by
//    calling `photicReceived` and comparing. The formulas are already proved
//    against §4.2/§4.3 in `creature.test.js`; what is unproved here is the
//    wiring — that the Lantern reads the right channel, at the right threshold,
//    with the source and receiver the right way round. A sense path with the
//    endpoints swapped reproduces every formula perfectly and detects nothing.
//
// 2. **The dimming is tested as a cause, not a correlation.** Two runs, identical
//    in elapsed time, distance and geometry, differing only in what the ship
//    emits. If the lights track the clock or the state name, both runs agree and
//    the case fails. It is the only test here that would catch a timer wearing
//    the right label.
//
// Everything runs headless. No Three.js import, no WebGL, nothing that needs a
// GPU, because a test that needs a GPU is a test that stops being run.
//
// HOW TO RUN
//
//   Open any page of the project (http://127.0.0.1:8182/) and paste:
//
//     const T = await import('/tests/lantern.test.js?v=' + Date.now()); T.mount();
//
//   `T.report()` returns it as text for a console. The cache-buster is not
//   optional: the browser will serve the module graph from before your edit and
//   make a fixed bug look unfixed.
//
//   `tests/index.html` is owned elsewhere and is not edited by this file. When it
//   is free to change, one line adds this suite to the shared runner:
//     ['./lantern.test.js', 'the Lantern', 'the dimming, and why'],

// `index.js` is owned by the orchestrator and does not re-export this archetype
// yet, so the Lantern comes straight from its own file and everything shared
// comes from the one import point, exactly as it will once the line is added.
import { Lantern, LANTERN } from '../src/game/creatures/lantern.js';
import {
  CreatureManager, STATE, STATE_ORDER,
  SENSE_PERIOD, FAR_PLANE, MEDIUM_SAMPLE_BUDGET,
  createMedium, createFlatMedium, countingMedium, createSignatureView,
  PositionHistory, formatEvent, vec, vdist, photicReceived,
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

/** A ship that emits a fixed set of channels from a fixed place. */
const ZERO = { acoustic: 0, thermal: 0, photic: 0, em: 0, wake: 0, relSpeed: 0 };

/**
 * Drive one Lantern against a scripted ship through the real adapters.
 *
 * `emit(t)` returns the six channels; `shipAt(t)` returns where the ship is. The
 * signature goes through a real `SignatureRecorder` and a real `PositionHistory`
 * so the sense path is the shipped one — including the half-second the recorder's
 * 2 Hz costs a zero-latency channel.
 */
function drive({
  seconds, emit, shipAt, medium = createFlatMedium(), lanternAt = vec(0, 0, 0),
  seed = 'lantern', onStep = null, lureCount = 14, manager = null,
}) {
  const rng = new Rng(seedFrom(seed));
  const l = new Lantern({ id: 1, rng, position: lanternAt, lureCount });
  l.simLevel = 'full';
  if (manager) manager.add(l);

  const rec = new SignatureRecorder();
  const positions = new PositionHistory();
  const signature = createSignatureView(rec, { positions });
  const ctx = { t: 0, tick: 0, shipPos: vec(), medium, signature };
  const values = { ...ZERO };
  const n = Math.round(seconds * 120);

  for (let tick = 0; tick < n; tick++) {
    const t = tick * DT;
    const sp = shipAt(t);
    ctx.t = t; ctx.tick = tick; ctx.shipPos = sp;
    Object.assign(values, ZERO, emit(t));
    // Record before sensing: age 0 has to exist by the time anything reads it.
    rec.update(DT, t, values);
    positions.record(DT, t, sp);
    if (manager) manager.update(DT, tick, ctx);
    else l.update(DT, tick, ctx);
    if (onStep) onStep(l, t, tick, ctx);
  }
  return { l, ctx, rec, positions, signature };
}

/** A ship parked at `d` metres, emitting `emit`, for `seconds`. */
const parked = (d, emit, seconds, extra = {}) => drive({
  seconds, emit: () => emit, shipAt: () => vec(0, 0, d), ...extra,
});

/**
 * The distance at which the Lantern's own `sense()` first produces a percept on
 * `channel`, found by bisection. Two sense ticks is enough — the percept is
 * produced or it is not — but the recorder needs a moment to hold a sample at
 * age 0, so each probe runs 2 s.
 */
function senseRange(channel, emit, opts = {}) {
  const detects = (d) => {
    let got = false;
    parked(d, emit, 2, {
      ...opts,
      onStep: (l) => { for (const p of l._percepts) if (p.channel === channel && p.real) got = true; },
    });
    return got;
  };
  let lo = 20, hi = FAR_PLANE * 1.2;
  if (!detects(lo)) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (detects(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// §5.4 — the attention integrator, at the Lantern's own numbers
// ---------------------------------------------------------------------------

/**
 * The photic stimulus that sits exactly at §5.4's excess 0.4, and the ship
 * brightness that produces it at 1000 m in clear air.
 *
 * Solved rather than assumed: the whole point of the 29 s figure is that it comes
 * out of `fillRate * excess * dt`, so the excess has to actually be 0.4 at the
 * receiver and not 0.4 at the emitter.
 */
const EXCESS_04 = LANTERN.photic.threshold
  + 0.4 * (LANTERN.photic.saturation - LANTERN.photic.threshold);
const LUMENS_FOR_EXCESS_04 = (() => {
  const terms = { distance: 1000, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0 };
  // photicReceived is linear in lumens, so one evaluation gives the scale.
  return EXCESS_04 / photicReceived(1, terms).total;
})();

test('§5.4 UNAWARE → COMMITTED in 29 s at excess 0.4, through the real sense path', () => {
  const marks = {};
  parked(1000, { photic: LUMENS_FOR_EXCESS_04 }, 60, {
    onStep: (l, t) => { if (marks[l.state] === undefined) marks[l.state] = t; },
  });
  const t = marks[STATE.COMMITTED];
  // The contract prints 29; the arithmetic is 0.92 / (0.08 * 0.4 * 0.1) = 287.5
  // sense ticks = 28.75 s, and the implementation is more precise than its own
  // specification. Half a second of tolerance is the printed figure's rounding.
  return {
    ok: t !== undefined && near(t, 28.75, 0.5),
    detail: `${f(t, 2)} s (contract ~29, arithmetic 28.75) · ladder `
      + STATE_ORDER.slice(1).map((s) => `${s} ${f(marks[s], 1)}`).join(' → '),
  };
});

test('§6 the ladder is walked one rung at a time and every rung has an event', () => {
  const { l } = parked(1000, { photic: LUMENS_FOR_EXCESS_04 }, 40);
  const log = l.detectionLog().filter((e) => e.channel !== 'promotion');
  let ok = log.length >= 4;
  for (let i = 0; i < log.length; i++) {
    const a = STATE_ORDER.indexOf(log[i].from), b = STATE_ORDER.indexOf(log[i].to);
    if (Math.abs(a - b) !== 1) ok = false;
  }
  return {
    ok: ok && l.state === STATE.COMMITTED,
    detail: `${log.length} events · ` + log.map((e) => `${e.from}→${e.to}@${f(e.simTime, 1)}`).join(' '),
  };
});

test('§7 the log line names the channel and quotes that channel\'s threshold', () => {
  // EM only, at the scan pre-charge — loud enough on that channel to escalate
  // inside the run. If the base class's single `threshold` field were left
  // pointing at the photic set, the sentence would read "em ... threshold 0.004"
  // and be a lie that nothing type-checks.
  const { l } = parked(1000, { em: 20 }, 60);
  const ev = l.detectionLog().find((e) => e.channel === 'em');
  const ok = !!ev && near(ev.threshold, LANTERN.em.threshold, 1e-9);
  return { ok, detail: ev ? formatEvent(ev) : 'no em event' };
});

// ---------------------------------------------------------------------------
// §10.2 — the senses, measured through sense() rather than through the formula
// ---------------------------------------------------------------------------

test('§10.2 EM detection ranges: idle 1340, cruise 1990, boost 3670, pre-charge 6000 m', () => {
  const want = [['idle', 1.0, 1340], ['cruise', 2.2, 1990], ['boost', 7.5, 3670],
    ['pre-charge', 20, 6000]];
  const got = want.map(([, emu]) => senseRange('em', { em: emu }));
  const worst = Math.max(...want.map(([, , w], i) => pct(got[i], w)));
  return {
    ok: worst < 0.02,
    detail: want.map(([n, , w], i) => `${n} ${f(got[i], 0)}/${w}`).join(', ')
      + `  worst ${f(worst * 100, 1)}%`,
  };
});

test('§10.2 photic ranges land below the printed 550/1500/3160 m, by a known term', () => {
  const want = [['nav', 1200, 550], ['lamp', 9000, 1500], ['scan', 40000, 3160]];
  const got = want.map(([, lm]) => senseRange('photic', { photic: lm }));
  // §4.2's printed ranges are the pure inverse-square answers: sqrt(1200/0.004)
  // is 548, sqrt(9000/0.004) is 1500, sqrt(40000/0.004) is 3162. The formula
  // printed directly above them also carries the extinction/scatter weighting
  // `through + 0.6*(1-through)`, which is 0.95 at 550 m and 0.78 at 3160 m and
  // pulls every range down. This case pins the *measured* numbers and the size of
  // the gap so that it is a documented property of the contract's arithmetic and
  // not an unnoticed 11% error in this creature. The bound is one-sided: the
  // Lantern must never see *further* than the printed figure.
  const ratios = want.map(([, , w], i) => got[i] / w);
  return {
    ok: ratios.every((r) => r > 0.85 && r <= 1.001),
    detail: want.map(([n, , w], i) => `${n} ${f(got[i], 0)}/${w} (${f(ratios[i] * 100, 1)}%)`).join(', '),
  };
});

test('§10.2 a dense cloud costs bearing, not detection', () => {
  const clear = createFlatMedium({ density: 0 });
  const thick = createFlatMedium({ density: 0.55 });
  const grab = (medium) => {
    let p = null;
    parked(900, { photic: 9000 }, 2, {
      medium, onStep: (l) => { for (const q of l._percepts) if (q.channel === 'photic' && q.real) p = { ...q }; },
    });
    return p;
  };
  const a = grab(clear), b = grab(thick);
  // §4.2: "Fog does not make your lights dimmer. It makes them a glow that fills
  // the sky, no less visible and no longer locatable." 900 m through rho 0.55 is
  // 4.9 visibility lengths, so §12's "bearing sigma reaches >= 1.2 rad for a
  // light at 3 visibility lengths" is the number to hold it to. The clear-air
  // figure is 0.178 rather than the 0.02 floor because 900 m is already a
  // quarter of a visibility length in perfectly clear air — measured, not
  // assumed, and the first version of this case asserted 0.1 and was wrong.
  const ok = !!a && !!b && b.strength > a.strength * 0.5 && b.bearingSigma >= 1.2
    && a.bearingSigma < 0.2;
  return {
    ok,
    detail: a && b
      ? `clear ${f(a.strength, 4)} lux-eq @ σ ${f(a.bearingSigma, 3)} rad · `
        + `ρ=0.55 ${f(b.strength, 4)} @ σ ${f(b.bearingSigma, 3)} rad`
      : 'no percept',
  };
});

test('§8 nine medium samples per sense tick, against a budget of 32', () => {
  const m = countingMedium(createFlatMedium({ density: 0.2, charge: 0.1 }));
  let worst = 0;
  parked(6, { photic: 9000, em: 2.2 }, 6, {
    medium: m,
    onStep: (l, t, tick) => {
      if ((tick + l.senseOffset) % SENSE_PERIOD === 0) worst = Math.max(worst, l.mediumSamplesLastTick);
    },
  });
  return {
    ok: worst > 0 && worst <= MEDIUM_SAMPLE_BUDGET,
    detail: `${worst} samples/tick (8 path + 1 local), budget ${MEDIUM_SAMPLE_BUDGET}`,
  };
});

// ---------------------------------------------------------------------------
// §5.1 / §5.4 — range by inversion, and cross-channel agreement
// ---------------------------------------------------------------------------

test('§5.1 the optical range is an inversion, wrong by exactly sqrt(1200 / lumens)', () => {
  // The Lantern assumes every light it sees is a ship's nav lights. §5.1 gives
  // photic no range at all, so this is the only range it can have, and it is
  // wrong by the square root of how wrong the assumption is. Each ship is placed
  // at half its own §4.2 detection range so all five are comfortably detected.
  const cases = [[40000, 1581], [9000, 750], [1200, 274], [300, 137], [100, 79]];
  const got = cases.map(([lm, d]) => {
    const e = parked(d, { photic: lm }, 30).l.estimate;
    return e ? e.range / d : NaN;
  });
  // The headline factor is sqrt(1200 / lumens). The second term is the
  // extinction weighting the inversion deliberately does not undo: §4.2's total
  // is `I/d^2 * (through + 0.6*(1-through))`, and reading that as a bare
  // inverse square places the source further out by `1/sqrt(f)` — 7% at 1581 m
  // in perfectly clear air and much more in cloud. Measuring against the bare
  // ratio called that a 7.2% error in the creature; it is not an error, it is
  // the reason fog buys distance in the Lantern's belief as well as bearing.
  const fAt = (d) => {
    const terms = { distance: d, rho_mean: 0, u_mean: 0, q_mean: 0, g_mean: 0, Rho: 0 };
    return photicReceived(1, terms).total * d * d;
  };
  const bare = cases.map(([lm]) => Math.sqrt(LANTERN.photic.assumedSourceLm / lm));
  const want = cases.map(([lm, d], i) => bare[i] / Math.sqrt(fAt(d)));
  const worst = Math.max(...got.map((g, i) => pct(g, want[i])));
  return {
    ok: worst < 0.02,
    detail: cases.map(([lm], i) =>
      `${lm} lm ${f(got[i], 3)}x (sqrt(1200/I) ${f(bare[i], 3)}, with extinction ${f(want[i], 3)})`)
      .join(', ') + `  worst ${f(worst * 100, 2)}%`,
  };
});

test('§5.4 a second channel tightens the range; repetition alone does not', () => {
  // 400 m: inside the nav-light range of 534 m and inside the idle-EM range of
  // 1342 m, so both channels fire.
  const both = parked(400, { photic: 1200, em: 1.0 }, 30).l.estimate;
  const eyeOnly = parked(400, { photic: 1200 }, 30).l.estimate;
  const emOnly = parked(400, { em: 1.0 }, 30).l.estimate;
  // 300 sense ticks of the same observation. If the range sigma fused across
  // time like the bearing does, this would be ~20x tighter than one tick and the
  // dimming would be a timer. The systematic error cannot be averaged away.
  const long = parked(400, { photic: 1200, em: 1.0 }, 300).l.estimate;
  const ok = both && eyeOnly && emOnly && long
    && both.rangeLnSigma < eyeOnly.rangeLnSigma * 0.5
    && both.rangeLnSigma < emOnly.rangeLnSigma
    && near(long.rangeLnSigma, both.rangeLnSigma, 1e-6);
  return {
    ok,
    detail: `σln — eye only ${f(eyeOnly && eyeOnly.rangeLnSigma, 3)}, reactor only `
      + `${f(emOnly && emOnly.rangeLnSigma, 3)}, both ${f(both && both.rangeLnSigma, 3)}; `
      + `after 10x longer still ${f(long && long.rangeLnSigma, 3)} · agreement `
      + `${f(both && both.agreement, 3)}, disagreement ${f(both && both.disagreement, 3)}σ`,
  };
});

test('§5.4 the two assumptions never disagree by a full sigma across §3.2', () => {
  // Every combination of the ship's photic and EM anchors, at every distance
  // where both channels fire. The chi inflation in `onPercept` is a guard, and
  // this measures whether the ship can trigger it: if the worst disagreement
  // across the whole operating envelope is under 1 sigma, then §3.2's photic and
  // EM anchors are mutually consistent under §4.2 and §4.3, which is a property
  // of the contract worth knowing and not something this creature invented.
  const photic = [1200, 9000, 40000];
  const em = [1.0, 2.2, 7.5, 20, 60];
  let worst = 0, worstAt = '', pairs = 0;
  for (const lm of photic) {
    for (const emu of em) {
      for (const d of [200, 400, 800, 1400]) {
        const e = parked(d, { photic: lm, em: emu }, 20).l.estimate;
        if (!e || e.channels !== 2) continue;
        pairs++;
        if (e.disagreement > worst) { worst = e.disagreement; worstAt = `${lm} lm / ${emu} EMU @ ${d} m`; }
      }
    }
  }
  return {
    ok: pairs > 20 && worst < 1,
    detail: `${pairs} two-channel fixes, worst disagreement ${f(worst, 3)}σ at ${worstAt} `
      + `(inflation fires above 1σ, so the ship cannot trigger it)`,
  };
});

// ---------------------------------------------------------------------------
// §10.2 — THE DIMMING
// ---------------------------------------------------------------------------

test('§10.2 the dimming is caused by emission, not by elapsed time', () => {
  // Five runs, identical in duration, true distance, geometry and seed. The only
  // thing that changes is what the ship emits — and therefore how well the
  // Lantern can place it. A timer, or a curve keyed to the state name, gives the
  // same brightness in all five.
  //
  // 1300 m and 25 s are chosen so that no run reaches COMMITTED, where §6's own
  // definition sends the need to zero and would flatten the comparison: at 400 m
  // even an idling ship commits it in 89 s, and every run read 0.000, which
  // looked like a broken creature and was a badly placed measurement.
  const ships = [
    ['idle', { em: 1.0 }],
    ['cruise', { em: 2.2 }],
    ['+ nav lights', { em: 2.2, photic: 1200 }],
    ['+ search lamp', { em: 2.2, photic: 9000 }],
    ['scanning', { em: 20, photic: 40000 }],
  ];
  const runs = ships.map(([, e]) => parked(1300, e, 25).l);
  const got = runs.map((l) => l.lureOutput);
  let monotone = true;
  for (let i = 1; i < got.length; i++) if (got[i] > got[i - 1] + 0.03) monotone = false;
  return {
    ok: monotone && got[0] > got[got.length - 1] * 3
      && runs.every((l) => l.state !== STATE.COMMITTED),
    detail: `all 25 s at 1300 m — `
      + ships.map(([n], i) => `${n} ${f(got[i], 3)}`).join(' → ')
      + ` · states ${runs.map((l) => l.state[0] + l.state.slice(1).toLowerCase()).join('/')}`,
  };
});

test('§10.2 the dimming is caused by distance too, at one fixed emission', () => {
  // The other half of §10.2's sentence. Same ship, same 25 s, five distances.
  const at = [2400, 1800, 1400, 1100, 900];
  const runs = at.map((d) => parked(d, { em: 2.2, photic: 9000 }, 25).l);
  const got = runs.map((l) => l.lureOutput);
  let monotone = true;
  for (let i = 1; i < got.length; i++) if (got[i] > got[i - 1] + 0.03) monotone = false;
  return {
    ok: monotone && got[0] > got[got.length - 1] * 2,
    detail: at.map((d, i) => `${d} m ${f(got[i], 3)}`).join(' → '),
  };
});

test('§10.2 an approach fades the array from 14 lights to none, monotonically', () => {
  // The curve the player actually sees. Full brightness at distance — §10.2's
  // *"a beautiful thing at distance, worth approaching"* — then fewer and fewer
  // lights, then nothing.
  const curve = [];
  const l = drive({
    seconds: 260,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: (t) => vec(0, 0, Math.max(300, 2600 - 14 * t)),
    onStep: (c, t, tick, ctx) => {
      if (tick % (120 * 20)) return;
      curve.push([Math.round(ctx.shipPos.z), c.lureOutput, c.litCount, c.state]);
    },
  }).l;
  let monotone = true;
  for (let i = 1; i < curve.length; i++) if (curve[i][1] > curve[i - 1][1] + 0.03) monotone = false;
  return {
    ok: monotone && curve[0][1] === 1 && curve[0][2] === l.lures.length
      && l.lureOutput === 0 && l.litCount === 0 && l.state === STATE.COMMITTED,
    detail: curve.filter((_, i) => i % 2 === 0).map(([d, o, n]) => `${d}m ${n}×${f(o, 2)}`).join(' → ')
      + ` → 0 lights (${l.state})`,
  };
});

test('§10.2 the brightest the array gets falls at every rung of the ladder', () => {
  // The correlation the player is asked to learn, stated as the contract's own
  // escalation table states it. It is a *consequence* of `_lureNeed` rather than
  // a lookup, so it is measured — and what it measures is the ceiling per state,
  // because the value at the instant of entering a state is mid-fade and says
  // more about `dimRate` than about the creature.
  const top = new Map();
  const l = drive({
    seconds: 260,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: (t) => vec(0, 0, Math.max(300, 2600 - 14 * t)),
    onStep: (c) => { top.set(c.state, Math.max(top.get(c.state) ?? 0, c.lureOutput)); },
  }).l;
  const order = STATE_ORDER.filter((s) => top.has(s));
  let monotone = true;
  for (let i = 1; i < order.length; i++) if (top.get(order[i]) > top.get(order[i - 1])) monotone = false;
  return {
    ok: monotone && order.length === 5 && top.get(STATE.UNAWARE) === 1
      && top.get(STATE.COMMITTED) < 0.15 && l.lureOutput === 0,
    detail: order.map((s) => `${s} ≤${f(top.get(s), 3)}`).join(' → '),
  };
});

test('§10.2 COMMITTED is fully dark, and it is the only state that is', () => {
  const seen = new Map();
  drive({
    seconds: 200,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: (t) => vec(0, 0, Math.max(260, 2600 - 14 * t)),
    onStep: (c) => {
      const v = seen.get(c.state);
      if (v === undefined || c.emittedLumens() < v) seen.set(c.state, c.emittedLumens());
    },
  });
  const committed = seen.get(STATE.COMMITTED);
  return {
    ok: committed === 0 && [...seen].every(([s, v]) => s === STATE.COMMITTED || v > 0),
    detail: [...seen].map(([s, v]) => `${s} min ${f(v, 0)} lm`).join(' · '),
  };
});

test('§10.2 the crackle keeps going after the light stops — the only COMMITTED cue', () => {
  let darkSteps = 0, cracklesWhileDark = 0, lastCount = 0;
  const l = drive({
    seconds: 220,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: (t) => vec(0, 0, Math.max(260, 2600 - 14 * t)),
    onStep: (c) => {
      if (c.emittedLumens() === 0) {
        darkSteps++;
        cracklesWhileDark += c.crackleCount - lastCount;
      }
      lastCount = c.crackleCount;
    },
  }).l;
  const hz = darkSteps > 0 ? cracklesWhileDark / (darkSteps * DT) : 0;
  // §9.4: interval = calm * (1 - 0.85 * attention). At attention ~0.95 that is
  // 0.3 / 0.1925 = 1.56 Hz. Anything at or above the calm 0.3 Hz proves the
  // circuit is still cycling in the dark.
  return {
    ok: darkSteps > 0 && hz > LANTERN.tremoloHz,
    detail: `${f(darkSteps * DT, 1)} s fully dark, ${cracklesWhileDark} crackles = ${f(hz, 2)} Hz `
      + `(calm ${LANTERN.tremoloHz}, §9.4 at attention ${f(l.attention, 2)} → `
      + `${f(LANTERN.tremoloHz / (1 - 0.85 * l.attention), 2)} Hz)`,
  };
});

test('§10.2 going dark is not a one-way door: lose the ship and it lights up again', () => {
  // The player is the reason it dimmed, so removing the player has to undo it —
  // and it has to undo it well before §5.4's 400 s of memory expires, or the rule
  // the player learns becomes "it knew where I was at some point" rather than
  // "it knows where I am". A latched "dark once committed" passes every other
  // case in this file and fails this one.
  let committed = false, darkest = 1, relitAt = null;
  const l = drive({
    seconds: 500,
    emit: (t) => (t < 60 ? { photic: LUMENS_FOR_EXCESS_04 } : {}),
    shipAt: (t) => vec(0, 0, t < 60 ? 1000 : 30000),
    onStep: (c, t) => {
      if (c.state === STATE.COMMITTED) committed = true;
      darkest = Math.min(darkest, c.lureOutput);
      if (committed && relitAt === null && c.lureOutput > 0.9) relitAt = t - 60;
    },
  }).l;
  return {
    ok: committed && darkest === 0 && relitAt !== null && relitAt < 400
      && l.lureOutput > 0.9 && l.state === STATE.UNAWARE,
    detail: `fully dark at COMMITTED (min output ${darkest}) → back above 0.9 ${f(relitAt, 0)} s `
      + `after the ship left, well inside the ${LANTERN.memorySec} s of §5.4 memory · ends `
      + `${f(l.lureOutput, 3)}, ${l.state}, attention ${f(l.attention, 3)}, `
      + `${l.litCount}/${l.lures.length} lit`,
  };
});

test('the lure cascade is exact: total lumens = arrayLumens x output x tremolo', () => {
  let worst = 0, samples = 0;
  drive({
    seconds: 150,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: (t) => vec(0, 0, Math.max(300, 2600 - 14 * t)),
    onStep: (c, t, tick) => {
      if (tick % 37) return;
      const sum = c.lights().reduce((a, x) => a + x.lumens, 0);
      worst = Math.max(worst, Math.abs(sum - c.emittedLumens()));
      samples++;
    },
  });
  return {
    ok: samples > 100 && worst < 1e-6,
    detail: `${samples} samples, worst |Σ lights − emittedLumens| = ${worst.toExponential(2)} lm`,
  };
});

// ---------------------------------------------------------------------------
// §10.2 — the ring, the array and the environmental signature
// ---------------------------------------------------------------------------

test('§10.2 the array is 9–20 lights, 4 m each, spanning 400 m while it drifts', () => {
  const counts = new Set();
  let span = 0;
  for (let i = 0; i < 40; i++) {
    const l = new Lantern({ id: i, rng: new Rng(seedFrom(`array${i}`)) });
    counts.add(l.lures.length);
    l.behave(DT, { t: 0, tick: 0 });
    const xs = l.lures.map((x) => x.x), zs = l.lures.map((x) => x.z);
    span = Math.max(span, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  }
  const lo = Math.min(...counts), hi = Math.max(...counts);
  return {
    ok: lo >= LANTERN.lureCountRange[0] && hi <= LANTERN.lureCountRange[1]
      && near(span, LANTERN.lureSpanM, 8) && LANTERN.lureDiameterM === 4,
    detail: `${counts.size} distinct counts in [${lo}, ${hi}] over 40 seeds · widest span ${f(span, 1)} m`,
  };
});

test('§10.2 the ring closes at 40 m/min on TRACKING, measured', () => {
  const trace = [];
  drive({
    seconds: 400,
    emit: () => ({ photic: 9000, em: 2.2 }),
    shipAt: () => vec(0, 0, 900),
    onStep: (c, t) => { if (c.state === STATE.TRACKING) trace.push([t, c.ringRadius]); },
  });
  // Rate over the first 60 s of TRACKING, while it is still shrinking rather
  // than parked at the floor.
  const seg = trace.filter(([t]) => t <= trace[0][0] + 60);
  const rate = seg.length > 2
    ? (seg[0][1] - seg[seg.length - 1][1]) / ((seg[seg.length - 1][0] - seg[0][0]) / 60)
    : 0;
  return {
    ok: near(rate, 40, 1),
    detail: `${f(rate, 2)} m/min inward (contract 40) · ${f(trace[0][1], 0)} m → `
      + `${f(trace[trace.length - 1][1], 0)} m over ${f(trace[trace.length - 1][0] - trace[0][0], 0)} s`,
  };
});

test('the ring is never evenly thick — there is always a gap to leave through', () => {
  const l = new Lantern({ id: 3, rng: new Rng(seedFrom('gap')) });
  const even = (Math.PI * 2) / l.lures.length;
  let worst = 0;
  for (let i = 0; i < 120 * 600; i++) {
    l.behave(DT, { t: i * DT, tick: i });
    if (i % 6000 === 0) worst = Math.max(worst, l.widestGapRad());
  }
  return {
    ok: worst > even * 1.15,
    detail: `${l.lures.length} lights, even spacing ${f(even, 3)} rad, `
      + `widest gap seen ${f(worst, 3)} rad (${f(worst / even, 2)}x) over 600 s`,
  };
});

test('§10.2 q climbs by up to 0.5 within 600 m, through the medium the player reads', () => {
  const l = new Lantern({ id: 4, rng: new Rng(seedFrom('charge')), position: vec(0, 0, 0) });
  l.behave(DT, { t: 0, tick: 0 });
  // Handed to `createMedium` as a storm, which is the path `chargeFromStorms`
  // already implements — so this is the value the player's own EM instrument
  // would read, not a private field.
  const medium = createMedium({ densityAt: () => 0, storms: [l.stormCell()] });
  // Sampled at multiples of 64 m because that is the derived-field cache cell in
  // `createMedium`: charge is evaluated at the cell centre, so a query at 600 m
  // is answered from 576 m. The contract's 600 m therefore lands between the last
  // non-zero cell (576) and the first zero one (640), and this case says so
  // rather than claiming a resolution the medium does not have.
  const at = (d) => medium.sample(0, 0, d, 0).charge;
  const ds = [0, 320, 576, 640, 1024];
  const q = ds.map(at);
  let monotone = true;
  for (let i = 1; i < q.length; i++) if (q[i] > q[i - 1]) monotone = false;
  return {
    ok: near(q[0], LANTERN.chargePeak, 1e-6) && monotone && q[2] > 0 && q[3] === 0
      && near(q[1], LANTERN.chargePeak * (1 - 320 / 600), 0.01),
    detail: ds.map((d, i) => `${d} m ${f(q[i], 3)}`).join(' · ')
      + `  (peak ${LANTERN.chargePeak}, reach ${LANTERN.chargeReachM} m, 64 m cache cells)`,
  };
});

test('lights() is plain data the renderer can place, with no renderer in it', () => {
  const l = new Lantern({ id: 5, rng: new Rng(seedFrom('lights')) });
  l.behave(DT, { t: 0, tick: 0 });
  const arr = l.lights();
  const one = arr[0];
  const ok = arr.length === l.lures.length
    && typeof one.x === 'number' && typeof one.y === 'number' && typeof one.z === 'number'
    && one.color.length === 3 && one.intensity > 0 && one.radius > 0
    && arr.every((e) => Number.isFinite(e.x + e.y + e.z + e.lumens + e.intensity));
  return {
    ok,
    detail: `${arr.length} lights · first { x ${f(one.x, 1)}, y ${f(one.y, 1)}, z ${f(one.z, 1)}, `
      + `${f(one.lumens, 0)} lm, intensity ${f(one.intensity, 2)}, colour [${one.color.join(', ')}], `
      + `radius ${one.radius} m }`,
  };
});

// ---------------------------------------------------------------------------
// §5.3, §7, §8 — mistakes, records and the rules the manager owns
// ---------------------------------------------------------------------------

test('§5.3 false positives happen, scale with the medium, and are logged as false', () => {
  const run = (opts) => {
    let n = 0;
    parked(11000, {}, 400, {
      ...opts,
      // Counted on the sense tick only. `_percepts` is a reused array that
      // survives between ticks, so counting it every step multiplies every rate
      // by SENSE_PERIOD — the first version of this case read 1.26 Hz against a
      // base of 0.08 and looked like a broken creature rather than a broken
      // measurement.
      onStep: (l, t, tick) => {
        if ((tick + l.senseOffset) % SENSE_PERIOD !== 0) return;
        for (const p of l._percepts) if (!p.real) n++;
      },
    });
    return n / 400;
  };
  // Nothing to detect: the ship is beyond FAR_PLANE and emitting nothing, so
  // every percept below is a mistake.
  const calm = run({ medium: createFlatMedium({ density: 0, charge: 0 }), seed: 'fp-calm' });
  const busy = run({ medium: createFlatMedium({ density: 0.9, charge: 0.9 }), seed: 'fp-calm' });
  // §10.2 base rates are 0.05 + 0.03 = 0.08 Hz; §5.3's gains are 1.5*rho and
  // 4.0*q, so at rho=q=0.9 the combined rate is 0.05*2.35 + 0.03*4.6 = 0.256 Hz.
  return {
    ok: calm > 0.03 && busy > calm * 2 && pct(calm, 0.08) < 0.5 && pct(busy, 0.256) < 0.5,
    detail: `clear air ${f(calm, 3)} Hz (base 0.080) · ρ=q=0.9 ${f(busy, 3)} Hz (predicted 0.256) `
      + `· ${f(busy / calm, 2)}x`,
  };
});

test('§7 the same seed reproduces the same log, mistakes included', () => {
  const go = () => {
    const { l } = drive({
      seconds: 300,
      emit: (t) => (t % 60 < 30 ? { photic: 1200, em: 1.0 } : {}),
      shipAt: (t) => vec(0, 0, 800 + 400 * Math.sin(t / 40)),
      medium: createFlatMedium({ density: 0.3, charge: 0.4 }),
      seed: 'replay',
    });
    return { log: l.detectionLog(), l };
  };
  const a = go(), b = go();
  const sa = JSON.stringify(a.log), sb = JSON.stringify(b.log);
  return {
    ok: sa === sb && a.log.length > 0,
    detail: `${a.log.length} events, byte-identical across two runs: ${sa === sb}; `
      + `${a.l.crackleCount} crackles, ${a.l.pulseCount} pulses`,
  };
});

test('§8 a reduced Lantern drifts and never detects', () => {
  const manager = new CreatureManager();
  let sawFull = false;
  const { l } = drive({
    seconds: 120,
    emit: () => ({ photic: 40000, em: 60 }),
    // Beyond 1.4 x 6000 = 8400 m, so it must stay reduced.
    shipAt: () => vec(0, 0, 9500),
    medium: createFlatMedium({ flow: vec(3, 0, -1) }),
    manager,
    onStep: (c) => { if (c.fullySimulated) sawFull = true; },
  });
  const drifted = Math.hypot(l.position.x, l.position.z);
  return {
    ok: !sawFull && l.state === STATE.UNAWARE && l.attention === 0 && drifted > 300,
    detail: `simLevel ${l.simLevel}, attention ${f(l.attention, 3)}, drifted ${f(drifted, 0)} m `
      + `on the flow in 120 s (§8 allows flow response, not senses)`,
  };
});

test('§8 promotion happens outside its own detection range', () => {
  const manager = new CreatureManager();
  let promoteAt = null;
  drive({
    seconds: 60,
    emit: () => ({ em: 20 }),
    // Closing from far outside, so the promotion has to land before 6000 m.
    shipAt: (t) => vec(0, 0, 11000 - 100 * t),
    manager,
    onStep: (c, t, tick, ctx) => {
      if (promoteAt === null && c.fullySimulated) promoteAt = vdist(c.position, ctx.shipPos);
    },
  });
  return {
    ok: promoteAt !== null && promoteAt > LANTERN.longestSenseRange
      && near(promoteAt, LANTERN.longestSenseRange * 1.4, 120),
    detail: `promoted at ${f(promoteAt, 0)} m, longest sense range ${LANTERN.longestSenseRange} m, `
      + `§8 wants 1.4x = ${LANTERN.longestSenseRange * 1.4} m`,
  };
});

test('§7.1 no percept, no turn: an unfed Lantern never orients', () => {
  const l = new Lantern({ id: 9, rng: new Rng(seedFrom('still')), heading: 0.7 });
  l.simLevel = 'full';
  const ctx = { t: 0, tick: 0, shipPos: vec(0, 0, 50), medium: null, signature: null };
  for (let i = 0; i < 120 * 300; i++) { ctx.t = i * DT; ctx.tick = i; l.update(DT, i, ctx); }
  return {
    ok: l.heading === 0.7 && l.estimate === null && l.state === STATE.UNAWARE,
    detail: `heading ${f(l.heading, 4)} unchanged over 300 s with the ship 50 m away and `
      + `no medium to sense through; state ${l.state}`,
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
  globalThis.LANTERN_TESTS = r;
  return r;
}

// Self-runnable without editing the shared runner: import with `?autorun`.
if (typeof document !== 'undefined' && import.meta.url.includes('autorun')) mount();

// The ship's signature, against the anchor table.
//
// CREATURE_BEHAVIOR_CONTRACT.md §3.2 is the acceptance test for this system and
// says so in the document: "The signature system must produce these values, to
// within about 10%, in these states." `signature.js` has claimed since it was
// written that `tests/signature.js` asserts every anchor, and no such file ever
// existed — so the ten rows that define what the player's whole toolkit costs
// were the one part of this project nothing checked.
//
// Same shape and same rules as `creature.test.js`: `run()` returns
// `{ pass, fail, results }`, every case reports the number it measured rather
// than the assertion it made, and nothing here imports Three.js.
//
// Two decisions about how the ship is driven, both load-bearing:
//
// 1. **Stubbed telemetry, not a real `Flight`.** What is under test is the
//    signature's response to a ship state, so the ship state is supplied
//    directly. Driving it through the flight model would make every anchor
//    conditional on the aerodynamics, and two of these rows are not reachable
//    that way at all: sustained boost is impossible because the energy bar
//    drains in under two seconds, and a station-keeping ship at 148 m/s of
//    relative flow has no control input that produces it.
//
// 2. **The hard-turn row is driven with the flight model's MEASURED turn**, not
//    with the contract's assumed inputs. `SIG.manoeuvreGRef` is calibrated to
//    gLoad 59.635 / slip 0.5705 rad / 112.47 m/s — the real sustained full-yaw
//    state — and the comment beside it names those three numbers as coupled. The
//    contract's assumed 36 m/s² / 0.30 rad is kept as a second, reported case, so
//    that if anyone retunes the flight model the divergence shows up as a number
//    instead of as a silently-passing test.

import { Signature, SIG, TRAIL, CHANNELS, ShipSystems, SHIP_SYSTEMS } from '../src/game/signature.js';

const DT = 1 / 120;

/** Long enough for the 90 s thermal integrator to sit inside 0.4% of steady. */
const SETTLE_S = 500;

/** Contract §3.2: "to within about 10%". */
const TOL = 0.10;
/** For rows whose contract value is zero, where a ratio means nothing. */
const ABS_TOL = { acoustic: 0.05, thermal: 0.05, photic: 0.05, em: 0.01, wake: 0.005 };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n) : String(x));
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
const pctOf = (got, want) => (want === 0 ? 0 : ((got - want) / want) * 100);

/** A ship, as telemetry. Only the fields `Signature` actually reads. */
function stubShip({ speed = 0, throttle = 0, boost = 0, gLoad = 0, slip = 0 } = {}) {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -speed },
    throttleSmoothed: throttle,
    boostSmoothed: boost,
    gLoad,
    slipAngle: slip,
    forward: { x: 0, y: 0, z: -1 },
  };
}

/** Run one ship state to steady and hand back both objects. */
function settle({ ship, setup = () => {}, seconds = SETTLE_S, move = false }) {
  const sig = new Signature();
  const sys = new ShipSystems();
  setup(sys);
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    sig.update(DT, ship, sys);
    // Only when a case cares about the trail: the anchor table is entirely live
    // channels, and moving the ship costs the whole parcel field every step.
    if (move) ship.position.z -= speed * DT;
  }
  return { sig, sys };
}

/** One row of the anchor table, as one case per channel. */
function anchorRow(name, ship, setup, want, tol = TOL) {
  test(`§3.2 ${name}`, () => {
    const { sig } = settle({ ship, setup });
    const parts = [];
    let ok = true;
    for (const ch of Object.keys(want)) {
      const got = sig[ch], w = want[ch];
      const pass = w === 0 ? Math.abs(got) <= ABS_TOL[ch] : Math.abs(got - w) <= Math.abs(w) * tol;
      if (!pass) ok = false;
      parts.push(`${ch} ${fmt(got)}/${w}` +
        (w === 0 ? '' : ` ${pctOf(got, w) >= 0 ? '+' : ''}${pctOf(got, w).toFixed(1)}%`) +
        (pass ? '' : ' ✗'));
    }
    return { ok, detail: parts.join('  ') };
  });
}

// ---------------------------------------------------------------------------
// §3.2 — the absolute rows
// ---------------------------------------------------------------------------

anchorRow('powered down, drifting', stubShip(), (s) => s.powerDown(),
  { acoustic: 4, thermal: 0, photic: 0, em: 0, wake: 0.02 });

anchorRow('systems idle, station keeping', stubShip(), (s) => { s.engines = false; },
  { acoustic: 18, thermal: 12, photic: 3, em: 1.0, wake: 0.05 });

anchorRow('cruise', stubShip({ speed: SIG.cruiseRel, throttle: 1 }), () => {},
  { acoustic: 46, thermal: 40, photic: 3, em: 2.2, wake: 0.6 });

// The flight model's real sustained full-yaw turn — the three numbers
// SIG.manoeuvreGRef is calibrated against.
const TURN = { speed: 112.47, gLoad: 59.635, slip: 0.5705 };
anchorRow('hard turn at cruise (flight model\'s measured turn)',
  stubShip({ speed: TURN.speed, throttle: 1, gLoad: TURN.gLoad, slip: TURN.slip }), () => {},
  { acoustic: 52, thermal: 44, photic: 3, em: 2.6, wake: 1.8 });

// Photic is deliberately 3.25 rather than 3 at boost: the contract's flat 3 lm
// would make boost and cruise *equal* on that channel, and one of this system's
// load-bearing properties is that boost is strictly worse on all six. 8.3% out,
// inside the stated tolerance, and recorded rather than discovered.
anchorRow('boost', stubShip({ speed: 237.0, throttle: 1, boost: 1 }), () => {},
  { acoustic: 78, thermal: 130, photic: 3, em: 7.5, wake: 4.0 });

// ---------------------------------------------------------------------------
// The coupling between this file and the flight model
// ---------------------------------------------------------------------------

test('§3.2 the hard-turn row is coupled to the flight model, and says by how much', () => {
  const measured = settle({
    ship: stubShip({ speed: TURN.speed, throttle: 1, gLoad: TURN.gLoad, slip: TURN.slip }),
  }).sig;
  const assumed = settle({
    ship: stubShip({ speed: SIG.cruiseRel, throttle: 1, gLoad: 36, slip: 0.30 }),
  }).sig;
  // Both must clear the contract's 10%. The point of the case is the pair of
  // numbers in the detail: if someone retunes the flight model and forgets
  // manoeuvreGRef, the measured column drifts and this says so in one line.
  const inTol = (s) => ['acoustic', 'thermal', 'em', 'wake'].every((c) => {
    const w = { acoustic: 52, thermal: 44, em: 2.6, wake: 1.8 }[c];
    return Math.abs(s[c] - w) <= w * TOL;
  });
  return {
    ok: inTol(measured) && inTol(assumed),
    detail: `measured turn (g ${TURN.gLoad}, slip ${TURN.slip}, ${TURN.speed} m/s): ` +
      `${f(measured.acoustic)} dB / ${f(measured.thermal)} ΔK / ${f(measured.em)} EMU / ` +
      `${f(measured.wake)} s⁻¹  ·  contract's assumed inputs (g 36, slip 0.30, 148 m/s): ` +
      `${f(assumed.acoustic)} / ${f(assumed.thermal)} / ${f(assumed.em)} / ${f(assumed.wake)} ` +
      `— strain ${f(TURN.gLoad / SIG.manoeuvreGRef)} against ${f(36 / SIG.manoeuvreGRef)}`,
  };
});

// ---------------------------------------------------------------------------
// §3.2 — the delta rows
// ---------------------------------------------------------------------------

test('§3.2 nav lights and search lamp add exactly what the table says', () => {
  const base = settle({ ship: stubShip({ speed: SIG.cruiseRel, throttle: 1 }) }).sig;
  const rows = [
    ['nav lights', (s) => { s.navLights = true; }, { photic: 1200, em: 0.1, thermal: 0 }],
    ['search lamp', (s) => { s.searchLamp = true; }, { photic: 9000, em: 0.4, thermal: 2 }],
  ];
  const parts = [];
  let ok = true;
  for (const [name, setup, want] of rows) {
    const { sig } = settle({ ship: stubShip({ speed: SIG.cruiseRel, throttle: 1 }), setup });
    for (const ch of Object.keys(want)) {
      const got = sig[ch] - base[ch], w = want[ch];
      const pass = w === 0 ? Math.abs(got) <= ABS_TOL[ch] : Math.abs(got - w) <= Math.abs(w) * TOL;
      if (!pass) ok = false;
      parts.push(`${name} ${ch} +${fmt(got)}/${w}${pass ? '' : ' ✗'}`);
    }
  }
  return { ok, detail: parts.join('  ') };
});

// ---------------------------------------------------------------------------
// The scan capacitor — §3.2's two most dramatic rows
//
// "Scanning announces itself twice": the capacitor ramps to 20 EMU over 1.5 s
// *before* the pulse, so an electromagnetic sense reads the intention from about
// 6 km and the pulse itself from 10 km. The pre-charge is the whole design of the
// instrument — you cannot look without being looked at first — so the ramp being
// a ramp is asserted, not just its endpoint.
// ---------------------------------------------------------------------------

test('§3.2 the scan pre-charge ramps to 20 EMU over 1.5 s and deposits 3 ΔK', () => {
  const ship = stubShip({ speed: SIG.cruiseRel, throttle: 1 });
  const { sig, sys } = settle({ ship });
  const em0 = sig.em, th0 = sig.thermal;
  sys.scan();

  const ramp = [];
  let steps = 0, peak = 0, thermalAtPulse = null;
  for (let i = 0; i < Math.round(3 / DT); i++) {
    const wasCharging = sys.scanState === 'charging';
    sig.update(DT, ship, sys);
    if (!wasCharging) continue;
    steps++;
    peak = Math.max(peak, sig.em);
    if (steps % 30 === 0) ramp.push(sig.em - em0);
    if (sys.scanState !== 'charging' && thermalAtPulse === null) thermalAtPulse = sig.thermal;
  }
  const monotone = ramp.every((v, i) => i === 0 || v > ramp[i - 1]);
  const dur = steps * DT;
  const heat = (thermalAtPulse ?? sig.thermal) - th0;
  return {
    ok: near(peak - em0, SHIP_SYSTEMS.scan.chargeEmu, SHIP_SYSTEMS.scan.chargeEmu * TOL)
      && near(dur, SHIP_SYSTEMS.scan.chargeSec, 0.02) && monotone && near(heat, 3, 0.3),
    detail: `reached +${f(peak - em0)} EMU over ${f(dur, 3)} s (want 20 / 1.5), ` +
      `+${f(heat)} ΔK (want 3), ${monotone ? 'strictly rising' : 'NOT MONOTONE'}: ` +
      ramp.map((v) => f(v, 1)).join(' → '),
  };
});

test('§3.2 the scan pulse is 96 dB, 40000 lm and 60 EMU for 0.2 s, then nothing', () => {
  const ship = stubShip({ speed: SIG.cruiseRel, throttle: 1 });
  const { sig, sys } = settle({ ship });
  const em0 = sig.em, ph0 = sig.photic;
  sys.scan();

  let steps = 0, em = 0, lm = 0, db = 0;
  for (let i = 0; i < Math.round(3 / DT); i++) {
    const wasPulsing = sys.scanState === 'pulse';
    sig.update(DT, ship, sys);
    if (!wasPulsing) continue;
    steps++;
    em = Math.max(em, sig.em); lm = Math.max(lm, sig.photic); db = Math.max(db, sig.acoustic);
  }
  const dur = steps * DT;
  return {
    ok: near(em - em0, 60, 6) && near(lm - ph0, 40000, 4000) && near(db, 96, 9.6)
      && near(dur, SHIP_SYSTEMS.scan.pulseSec, 0.02)
      && sys.scanState === 'idle' && near(sig.em, em0, 0.01),
    detail: `+${f(em - em0)} EMU / +${fmt(lm - ph0)} lm / ${f(db)} dB(V) for ${f(dur, 3)} s ` +
      `(want 60 / 40000 / 96 / 0.2); afterwards em ${f(sig.em)} back to the cruise ${f(em0)} — ` +
      'an empty store emits nothing, which is what makes EM a field channel',
  };
});

// ---------------------------------------------------------------------------
// §3.2 — the impact row
// ---------------------------------------------------------------------------

test('§3.2 a hull impact is 110 dB(V) and +2.5 s⁻¹, and is gone within 6 s', () => {
  const ship = stubShip();
  const { sig, sys } = settle({ ship, setup: (s) => s.powerDown() });
  const wake0 = sig.wake;
  sig.impact(1);
  let db = 0, wake = 0;
  for (let i = 0; i < 12; i++) {
    sig.update(DT, ship, sys);
    db = Math.max(db, sig.acoustic); wake = Math.max(wake, sig.wake);
  }
  for (let i = 0; i < Math.round(6 / DT); i++) sig.update(DT, ship, sys);
  return {
    ok: near(db, 110, 11) && near(wake - wake0, 2.5, 0.25) && sig.acoustic <= 4.1,
    detail: `${f(db)} dB(V) (want 110), wake +${f(wake - wake0)} (want 2.5); ` +
      `back to ${f(sig.acoustic)} dB(V) after 6 s — an impulse run through the machinery ` +
      'constant instead of the reverberant one would still be audible here',
  };
});

// ---------------------------------------------------------------------------
// What the anchor table implies but does not state
// ---------------------------------------------------------------------------

test('Pillar 2: throttle 0→1 drives every channel up, with no quiet setting', () => {
  const sweep = [0, 0.25, 0.5, 0.75, 1].map((th) => {
    const { sig } = settle({ ship: stubShip({ speed: SIG.cruiseRel * th, throttle: th }) });
    return { th, acoustic: sig.acoustic, thermal: sig.thermal, em: sig.em, wake: sig.wake };
  });
  const chans = ['acoustic', 'thermal', 'em', 'wake'];
  const rising = chans.filter((c) => sweep.every((s, i) => i === 0 || s[c] > sweep[i - 1][c]));
  return {
    ok: rising.length === chans.length,
    detail: `${rising.length}/${chans.length} monotone; acoustic ` +
      sweep.map((s) => `${s.th}:${f(s.acoustic, 1)}`).join(' ') +
      `  (${chans.filter((c) => !rising.includes(c)).join(', ') || 'none reversed'})`,
  };
});

test('the engine follows throttle⁴, so easing off is a real lever', () => {
  // signature.js derives this rather than dialling it: steady speed is
  // sqrt(thrust·throttle/drag) so U ∝ √throttle, and Lighthill's eighth-power law
  // makes jet acoustic power ∝ U⁸ ∝ throttle⁴. Four powers of throttle is 12.04 dB
  // per halving, which is the number this checks — measured on the engine's own
  // contribution, with the reactor and hull subtracted out in the power domain.
  const dbToP = (db) => Math.pow(10, db * 0.1);
  const pToDb = (p) => 10 * Math.log10(Math.max(p, 1e-12));
  const engineOnly = (th) => {
    const { sig } = settle({ ship: stubShip({ speed: SIG.cruiseRel * th, throttle: th }) });
    const floor = settle({ ship: stubShip(), setup: (s) => { s.engines = false; } }).sig;
    return pToDb(dbToP(sig.acoustic) - dbToP(floor.acoustic));
  };
  const full = engineOnly(1), half = engineOnly(0.5);
  return {
    ok: near(full - half, 12.04, 0.5),
    detail: `engine alone: ${f(full)} dB at full throttle, ${f(half)} at half — ` +
      `a ${f(full - half)} dB drop for one halving (throttle⁴ predicts 12.04)`,
  };
});

test('a full power-down takes about 15 s to fall under the Listener\'s threshold', () => {
  const ship = stubShip({ speed: SIG.cruiseRel, throttle: 1 });
  const { sig, sys } = settle({ ship });
  sys.powerDown();
  ship.throttleSmoothed = 0;
  ship.velocity.z = 0;
  let under16 = null, under6 = null;
  for (let i = 0; i < Math.round(60 / DT); i++) {
    sig.update(DT, ship, sys);
    const t = (i + 1) * DT;
    if (under16 === null && sig.acoustic < 16) under16 = t;
    if (under6 === null && sig.acoustic < 6) under6 = t;
  }
  return {
    ok: under16 !== null && under16 > 13 && under16 < 18,
    detail: `under 16 dB(V) at ${f(under16)} s, under the listening threshold of 6 at ` +
      `${f(under6)} s. The second number is the one that matters: §10.1's silence window ` +
      'is 18–26 s, so a player who starts the power-down as it opens does get under the ' +
      'listening threshold in time for the longer half of that range',
  };
});

test('the relSpeed exposure bar has headroom above cruise', () => {
  const cruise = settle({ ship: stubShip({ speed: SIG.cruiseRel, throttle: 1 }) }).sig;
  const boost = settle({ ship: stubShip({ speed: 237, throttle: 1, boost: 1 }) }).sig;
  const c = cruise.exposure().per.relSpeed, b = boost.exposure().per.relSpeed;
  return {
    ok: c < 0.99 && b > c,
    detail: `cruise ${f(c, 3)}, boost ${f(b, 3)}; SIG.exposureRef.relSpeed is ` +
      `${SIG.exposureRef.relSpeed} (the boost reference). It was 148 — the cruise value — ` +
      'so this bar read exactly 1.000 in ordinary flight and could not report a boost at all',
  };
});

// ---------------------------------------------------------------------------
// The trail channels
//
// The regression that matters most in this file. Shedding used to run on a
// wall-clock timer with no spatial gate, so a ship that was not moving stacked
// hundreds of parcels at one point and `ParcelField.sample()` summed every one:
// a drifting ship read 4.595 s⁻¹ against a Wake Hunter threshold of 0.05 — 4.5×
// louder than the same ship at full cruise — and a station-keeping ship showed
// 572.69 ΔK of thermal trail against a hull that was 11.86 ΔK above ambient.
// That inverted the design's central promise. These cases stop it returning.
// ---------------------------------------------------------------------------

/** The Wake Hunter's sensing geometry, per §10.3. */
const HUNTER = { wakeRadius: 165, wakeThreshold: 0.05, thermalRadius: 220 };

function trailAt(speed, seconds = 400) {
  const ship = stubShip({ speed, throttle: speed > 0 ? 1 : 0 });
  const { sig } = settle({ ship, seconds, move: true });
  const p = ship.position;
  return {
    wake: sig.sampleWake(p.x, p.y, p.z, HUNTER.wakeRadius),
    thermal: sig.sampleThermal(p.x, p.y, p.z, HUNTER.thermalRadius),
    hull: sig.thermal,
    parcels: sig.wakeTrail.count,
  };
}

test('§3.3 the wake trail rises with speed — a parked ship is not the loudest thing', () => {
  const still = trailAt(0), slow = trailAt(20), cruise = trailAt(SIG.cruiseRel);
  return {
    ok: still.wake < slow.wake && slow.wake < cruise.wake,
    detail: `still ${f(still.wake, 4)} < 20 m/s ${f(slow.wake, 4)} < cruise ` +
      `${f(cruise.wake, 4)} s⁻¹ at the Wake Hunter's ${HUNTER.wakeRadius} m radius ` +
      '(this read 4.595 / — / 1.011 before shedding was gated on distance)',
  };
});

test('§3.3 a drifting ship is genuinely below every threshold', () => {
  const ship = stubShip();
  const { sig } = settle({ ship, setup: (s) => s.powerDown(), seconds: 400, move: true });
  const w = sig.sampleWake(0, 0, 0, HUNTER.wakeRadius);
  return {
    ok: w < HUNTER.wakeThreshold,
    detail: `${f(w, 4)} s⁻¹ against a threshold of ${HUNTER.wakeThreshold} — §3.3 states this ` +
      'in words: "drifting genuinely leaves no wake trail"',
  };
});

test('§3.3 the thermal trail is not orders of magnitude above the hull that made it', () => {
  // Sampled at the trail's OWN altitude, not at the ship. Heat rises at 0.8 m/s,
  // so after 400 s of station keeping the parcel sits 320 m up and a receiver at
  // the ship reads exactly 0.000 — which made the first version of this case pass
  // while measuring nothing at all, the same vacuous pass that made §12 in the
  // creature suite unfalsifiable. Sampling where the heat actually went both
  // measures the thing and demonstrates §3.3's "anything following heat searches
  // above you".
  const ship = stubShip();
  const { sig } = settle({ ship, seconds: 400, move: true });
  const tt = sig.thermalTrail;
  let top = 0;
  for (let i = 0; i < tt.count; i++) top = Math.max(top, tt.pos[i * 3 + 1]);
  const atTrail = sig.sampleThermal(0, top, 0, HUNTER.thermalRadius);
  const atShip = sig.sampleThermal(0, 0, 0, HUNTER.thermalRadius);
  return {
    ok: tt.count > 0 && atTrail > 0.5 && atTrail < sig.thermal * 3,
    detail: `${tt.count} parcel(s); ${f(atTrail)} ΔK at the trail's altitude of ${f(top, 0)} m ` +
      `against a hull of ${f(sig.thermal)} ΔK (${f(atTrail / Math.max(sig.thermal, 1e-9))}×), ` +
      `and ${f(atShip)} ΔK back down at the ship. It was 48× — 572.69 against 11.86 — when ` +
      'parcels piled up at one point and were summed',
  };
});

test('§3.3 cruise still sheds at the contract\'s 4 Hz', () => {
  const cruise = trailAt(SIG.cruiseRel);
  return {
    ok: cruise.parcels === TRAIL.wakeCap,
    detail: `${cruise.parcels} parcels of ${TRAIL.wakeCap} after 400 s. The spatial gate is ` +
      `${f(TRAIL.wakeSpacingM, 1)} m, which is exactly how far the ship travels between shed ` +
      'events at cruise — so cruise behaviour is unchanged and only slower states are gated',
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

export { CHANNELS };

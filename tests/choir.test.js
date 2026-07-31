// The Choir, driven rather than described. Contract §10.4.
//
// Every case below builds a synthetic world, runs the simulation loop at the
// real 120 Hz step for as long as the behaviour under test actually takes, and
// measures what came out. Nothing here asserts that a constant equals itself.
//
// Three of these cases exist because of specific ways this creature can be
// wrong in a way that reads as working:
//
//   - **It can hunt by accident.** §10.4 says it never enters TRACKING or
//     COMMITTED. The implementation achieves that by setting both attention
//     rates to zero rather than by special-casing the state machine, which is
//     the right way round — but it means a single non-zero rate anywhere would
//     silently turn the shoal into a fifth predator. `never hunts` drives 900 s
//     of a loud ship at close range and measures every state it was ever in.
//
//   - **It can invent.** §10.4's deepest promise is that every echo is a record
//     of something that was genuinely present. A bug that echoed a *zeroed*
//     recording, or that let a false positive into the memory, would still look
//     like a working Choir on screen. `does not invent` runs the same world with
//     a powered-down ship and requires the shoal to hold nothing and say nothing.
//
//   - **The tell can be an illusion.** The whole skill ceiling of this creature
//     is a rule the player can check: one channel, and the Choir's own bearing.
//     It is easy to write a Choir where that is true in the code and unusable in
//     play. Four cases measure it as a *separation* — with numbers — from
//     outside the shoal and from inside it, where §10.4 says it must degrade.
//
// A note on measuring: the receiver in the "draws other creatures" cases is a
// bare `Creature` whose only sense is `senseEchoes`, with the Listener's own
// attention rates from §5.4. That is deliberate. It means the escalation it
// shows was produced entirely by the shared machinery in `creature.js` against
// an echo, with nothing archetype-specific in the path, so the 19 s figure it
// reports is directly comparable to §5.4's own.

import {
  Creature, STATE, STEP,
  createFlatMedium, countingMedium, createSignatureView, PositionHistory,
  azimuth, vec,
} from '../src/game/creatures/creature.js';
import {
  Choir, CHOIR, POSTURE, EchoBus, senseEchoes, crossReference,
  choirAbsorptionDb, choirEmSigmaAdd, chordThroughSphere, RECORDING_FLOOR,
} from '../src/game/creatures/choir.js';
import { Rng } from '../src/core/rng.js';
import { shortestAngle } from '../src/core/math.js';

const DT = STEP;

// §3.2's anchor rows, so nothing in this file invents a ship.
const SHIP = {
  down:   { acoustic: 4,  thermal: 0,  photic: 0,     em: 0,   wake: 0.02, relSpeed: 0 },
  idle:   { acoustic: 18, thermal: 12, photic: 3,     em: 1.0, wake: 0.05, relSpeed: 0 },
  cruise: { acoustic: 46, thermal: 40, photic: 3,     em: 2.2, wake: 0.6,  relSpeed: 148 },
  lamp:   { acoustic: 46, thermal: 42, photic: 9003,  em: 2.6, wake: 0.6,  relSpeed: 148 },
  scan:   { acoustic: 96, thermal: 46, photic: 40000, em: 60,  wake: 0.6,  relSpeed: 148 },
};

/**
 * A ship that emits a fixed signature from a fixed point.
 *
 * Shaped as a `SignatureRecorder`, so `createSignatureView` treats it as history
 * and `at(ageSec)` means an age in seconds — the convention `creature.js` warns
 * about at length. `count`/`hz` exist so `spanSec()` is a number rather than NaN
 * if anything asks.
 */
class Ship {
  constructor(pos, state = 'cruise') {
    this.position = vec(pos.x, pos.y, pos.z);
    this.state = state;
    this.count = 600; this.hz = 2;
    this.positions = new PositionHistory();
    this.time = 0;
  }
  set(state) { this.state = state; return this; }
  step(dt, t) { this.time = t; this.positions.record(dt, t, this.position); }
  at(ageSec) {
    if (ageSec < 0 || ageSec > 300) return null;
    return { ...SHIP[this.state], simTime: this.time - ageSec };
  }
}

/** A peer creature with a voice, for §11.3. Nothing else about it is simulated. */
class Voice {
  constructor({ id, archetype, bodyLength, db, pos }) {
    this.id = id; this.archetype = archetype; this.bodyLength = bodyLength;
    this.position = vec(pos.x, pos.y, pos.z);
    this.db = db;
  }
  voiceState() { return { fundamentalHz: 24, partials: [1, 2, 3, 4], emittedDb: this.db }; }
}

/**
 * A world. Clear air unless told otherwise, so every worked value in §4 applies
 * unmodified and a surprise is a bug rather than the weather.
 */
function world({ ship, medium = createFlatMedium({ density: 0 }), peers = null, trails = null } = {}) {
  const counted = countingMedium(medium);
  const signature = createSignatureView(ship, { positions: ship.positions });
  const echoes = new EchoBus();
  const ctx = {
    t: 0, tick: 0, shipPos: ship.position, medium: counted, signature,
    echoes, creatures: peers, trails, rng: null,
  };
  return {
    ctx, echoes, medium: counted, ship,
    /** Run `seconds` of simulation. `onTick(ctx)` fires once per step. */
    run(seconds, creatures, onTick) {
      const steps = Math.round(seconds / DT);
      for (let i = 0; i < steps; i++) {
        ctx.tick++;
        ctx.t += DT;
        ship.step(DT, ctx.t);
        for (const c of creatures) c.update(DT, ctx.tick, ctx);
        if (onTick) onTick(ctx);
      }
      return this;
    },
  };
}

/** A Choir wired for a test: fully simulated, deterministic, on the shared bus. */
function makeChoir(w, opts = {}) {
  const c = new Choir({
    id: opts.id ?? 1,
    position: opts.position ?? vec(0, 20000, 0),
    rng: new Rng(opts.seed ?? 0xC401A2),
    echoes: w.echoes,
    radiusM: opts.radiusM ?? 2000,
    ...opts,
  });
  c.simLevel = 'full';
  return c;
}

/**
 * A receiver with the Listener's §5.4 attention rates whose only sense is
 * echoes. Nothing archetype-specific is in the path, so what it does is what the
 * shared machinery does with a Choir echo.
 */
class EchoReceiver extends Creature {
  constructor(opts = {}) {
    super({
      archetype: 'EchoReceiver',
      fillRate: 0.12, decayRate: 0.012, memorySec: 240,
      threshold: 16, saturation: 60,      // the Listener's acoustic pair, §10.1
      falsePositiveBase: 0,               // isolate the echo
      ...opts,
    });
    this.simLevel = 'full';
    this.spec = opts.spec || { acoustic: { threshold: 16, saturation: 60 } };
    this._out = [];
    this.lastBearing = null;
  }
  sense(ctx) {
    this._out.length = 0;
    senseEchoes(this, ctx, this.spec, this._out);
    return this._out;
  }
  onPercept(p) { this.lastBearing = p.bearing; }
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const deg = (r) => r * 180 / Math.PI;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

// --- §10.4: it does not hunt ----------------------------------------------

test('never leaves UNAWARE, 900 s of a loud ship at 600 m', () => {
  const ship = new Ship(vec(600, 20000, 0), 'scan');
  const w = world({ ship });
  const c = makeChoir(w, { position: vec(0, 20000, 0), radiusM: 300 });
  const states = new Set();
  let maxAttention = 0;
  w.run(900, [c], () => { states.add(c.state); maxAttention = Math.max(maxAttention, c.attention); });
  const only = [...states].join(',');
  return {
    ok: only === STATE.UNAWARE && maxAttention === 0,
    got: `${only}, max attention ${maxAttention}`,
    want: 'UNAWARE, max attention 0',
    detail: `${c.recordCount} recordings, ${c.echoCount} echoes emitted`,
  };
});

test('emits no DetectionEvent on the §6 ladder', () => {
  const ship = new Ship(vec(600, 20000, 0), 'cruise');
  const w = world({ ship });
  const c = makeChoir(w);
  w.run(600, [c]);
  const log = c.detectionLog();
  const ladder = log.filter((e) => e.channel !== 'posture');
  return {
    ok: ladder.length === 0 && c.transitionCount() === 0,
    got: `${ladder.length} ladder events, ${c.transitionCount()} transitions, ${log.length} posture events`,
    want: '0 ladder events',
  };
});

// --- §10.4: it does not invent --------------------------------------------

test('a powered-down ship leaves nothing in the memory and nothing on the bus', () => {
  // acoustic 4 dB(V) is below the 6 dB(V) floor before it has travelled a metre;
  // photic 0 and em 0 are below theirs everywhere.
  const ship = new Ship(vec(400, 20000, 0), 'down');
  const w = world({ ship });
  const c = makeChoir(w);
  w.run(900, [c]);
  return {
    ok: c.memory.length === 0 && c.echoCount === 0 && w.echoes.count() === 0,
    got: `memory ${c.memory.length}, echoes ${c.echoCount}`,
    want: 'memory 0, echoes 0',
    detail: `exposure ${c._exposure01.toFixed(4)}, density ${c.density01.toFixed(3)}`,
  };
});

test('every echo names a source that was really recorded', () => {
  const peers = [new Voice({ id: 9, archetype: 'Listener', bodyLength: 240, db: 40, pos: vec(-1500, 20000, 0) })];
  const ship = new Ship(vec(900, 20000, 0), 'lamp');
  const w = world({ ship, peers });
  const c = makeChoir(w);
  w.run(900, [c]);
  const kinds = new Set(c.echoHistory().map((e) => e.sourceKind));
  const heard = new Set(c.memory.map((r) => r.sourceKind));
  const orphan = [...kinds].filter((k) => !heard.has(k));
  return {
    ok: c.echoCount > 0 && orphan.length === 0 && [...kinds].every((k) => k === 'ship' || k === 'Listener'),
    got: `echoed ${[...kinds].join('+') || 'nothing'} from a memory of ${[...heard].join('+')}`,
    want: 'no echo without a matching recording',
    detail: `${c.echoCount} echoes, ${c.memory.length} recordings held`,
  };
});

// --- §5.4: memory 600 s ---------------------------------------------------

test('a recording is forgotten 600 s after it was made, not before', () => {
  const ship = new Ship(vec(1500, 20000, 0), 'cruise');
  const w = world({ ship });
  const c = makeChoir(w);
  w.run(20, [c]);                       // hear it
  const held = c.memory.length;
  const madeAt = Math.max(...c.memory.map((r) => r.t));
  ship.set('down');                     // and then nothing at all
  let clearedAt = null;
  w.run(700, [c], (ctx) => { if (clearedAt === null && c.memory.length === 0) clearedAt = ctx.t; });
  const life = clearedAt === null ? Infinity : clearedAt - madeAt;
  return {
    ok: held > 0 && Math.abs(life - CHOIR.memorySec) < 2,
    got: `${life === Infinity ? 'never' : life.toFixed(2) + ' s'}`,
    want: `${CHOIR.memorySec} s (±2)`,
    detail: `${held} recordings made by t=${madeAt.toFixed(1)}`,
  };
});

// --- §10.4: postures and echo rate ----------------------------------------

test('concurrent echoes per posture match the rate × life derivation', () => {
  const out = {};
  for (const [posture, expect] of [[POSTURE.DISPERSED, 2.4], [POSTURE.GATHERING, 7.5], [POSTURE.DENSE, 24]]) {
    const ship = new Ship(vec(1500, 20000, 0), 'cruise');
    const w = world({ ship });
    const c = makeChoir(w, { radiusM: 1500 });
    // Pin the density: the echo *rate* is what is under test here, not what
    // drives density, and letting the shoal thicken during the measurement would
    // make it a measurement of two things.
    c.density01 = posture === POSTURE.DENSE ? 0.95 : posture === POSTURE.GATHERING ? 0.45 : 0.10;
    c._updateDensity = () => {};
    const samples = [];
    // Settle for one echo life, then measure the steady state over five more.
    w.run(CHOIR.echoLifeSec, [c]);
    w.run(CHOIR.echoLifeSec * 5, [c], () => samples.push(c.echoes.count()));
    out[posture] = { measured: mean(samples), expect, posture: c.posture };
  }
  const errs = Object.values(out).map((o) => Math.abs(o.measured - o.expect) / o.expect);
  return {
    ok: Math.max(...errs) < 0.25,
    got: Object.entries(out).map(([k, o]) => `${k} ${o.measured.toFixed(1)}`).join(' · '),
    want: 'DISPERSED 2.4 · GATHERING 7.5 · DENSE 24 (±25%)',
    detail: `worst error ${(Math.max(...errs) * 100).toFixed(1)}%`,
  };
});

test('a loud ship thickens the shoal it is hiding in', () => {
  const ship = new Ship(vec(700, 20000, 0), 'down');
  const w = world({ ship });
  const c = makeChoir(w, { radiusM: 1200 });
  c._ambient = 0.08; c._nextAmbientAt = 1e9;    // hold the weather still
  c.density01 = 0.08;
  w.run(120, [c]);
  const quiet = c.density01, quietPosture = c.posture;
  ship.set('cruise');
  w.run(240, [c]);
  const loud = c.density01, loudPosture = c.posture;
  return {
    ok: loud > quiet + 0.3 && quietPosture === POSTURE.DISPERSED && loudPosture !== POSTURE.DISPERSED,
    got: `${quiet.toFixed(3)} ${quietPosture} → ${loud.toFixed(3)} ${loudPosture}`,
    want: 'DISPERSED while silent, thicker and busier while cruising',
    detail: `exposure ${c._exposure01.toFixed(3)}`,
  };
});

test('RESONANT is reached only by replaying a large creature that was really there', () => {
  const peers = [new Voice({ id: 9, archetype: 'Listener', bodyLength: 240, db: 40, pos: vec(-1200, 20000, 0) })];
  const ship = new Ship(vec(700, 20000, 0), 'cruise');
  const w = world({ ship, peers });
  const c = makeChoir(w, { radiusM: 1200 });
  c.density01 = 0.9; c._ambient = 0.9; c._nextAmbientAt = 1e9;
  let sawResonant = false;
  w.run(600, [c], () => { if (c.posture === POSTURE.RESONANT) sawResonant = true; });
  const largeHeld = c.memory.filter((r) => r.large).length;
  const largeEchoes = c.echoHistory().filter((e) => e.large).length;

  // The control: the same shoal with no large creature in the world at all.
  const ship2 = new Ship(vec(700, 20000, 0), 'cruise');
  const w2 = world({ ship: ship2 });
  const c2 = makeChoir(w2, { radiusM: 1200, id: 2 });
  c2.density01 = 0.9; c2._ambient = 0.9; c2._nextAmbientAt = 1e9;
  let control = false;
  w2.run(600, [c2], () => { if (c2.posture === POSTURE.RESONANT) control = true; });

  return {
    ok: sawResonant && largeHeld > 0 && largeEchoes > 0 && !control,
    got: `with a Listener: ${sawResonant ? 'RESONANT' : 'never'} (${largeHeld} held, ${largeEchoes} echoed) · without: ${control ? 'RESONANT' : 'never'}`,
    want: 'RESONANT only when a large creature was really present',
  };
});

// --- §10.4: the tell ------------------------------------------------------

/**
 * Build one instrument sweep: what a sensor at `at` sees this instant, from the
 * real ship on every field channel plus every live echo. This is the union a
 * cross-referencing instrument works on, and `crossReference` is the rule.
 */
function sweep(w, choirSensor, at, ctx) {
  choirSensor.position.x = at.x; choirSensor.position.y = at.y; choirSensor.position.z = at.z;
  const real = choirSensor.sense(ctx).map((p) => ({ ...p, _src: 'real' }));
  const rec = new EchoReceiver({
    id: 77, position: vec(at.x, at.y, at.z), rng: new Rng(7),
    spec: {
      acoustic: { threshold: RECORDING_FLOOR.acoustic, saturation: 60 },
      photic: { threshold: RECORDING_FLOOR.photic, saturation: 0.2 },
      em: { threshold: RECORDING_FLOOR.em, saturation: 4 },
    },
  });
  const echo = senseEchoes(rec, ctx, rec.spec, []).map((p) => ({ ...p, _src: 'echo' }));
  return { real, echo, all: real.concat(echo) };
}

test('a real contact is corroborated across channels; an echo never is', () => {
  // The ship lit and running: acoustic, photic and em all clear their floors at
  // 900 m, which is what "two or more channels with consistent bearings" means.
  const ship = new Ship(vec(900, 20000, 0), 'lamp');
  const w = world({ ship });
  const choir = makeChoir(w, { position: vec(-2500, 20000, 2500), radiusM: 400 });
  const sensor = makeChoir(w, { id: 3, position: vec(0, 20000, 0), radiusM: 1, seed: 99 });
  sensor.echoes = new EchoBus();       // the sensor must not publish into the bus
  w.run(240, [choir]);

  let realGroups = 0, realCorroborated = 0, echoGroups = 0, echoSingle = 0, maxEchoChannels = 0;
  for (let i = 0; i < 200; i++) {
    w.run(0.5, [choir]);
    const s = sweep(w, sensor, vec(0, 20000, 0), w.ctx);
    if (!s.echo.length) continue;
    for (const g of crossReference(s.real)) { realGroups++; if (g.corroborated) realCorroborated++; }
    for (const g of crossReference(s.echo)) {
      echoGroups++;
      if (g.single) echoSingle++;
      maxEchoChannels = Math.max(maxEchoChannels, g.nChannels);
    }
  }
  const realPct = 100 * realCorroborated / Math.max(realGroups, 1);
  const echoPct = 100 * echoSingle / Math.max(echoGroups, 1);
  return {
    ok: realGroups > 0 && echoGroups > 0 && realPct === 100 && echoPct === 100 && maxEchoChannels === 1,
    got: `real ${realPct.toFixed(1)}% corroborated (n=${realGroups}), echo ${echoPct.toFixed(1)}% single (n=${echoGroups})`,
    want: '100% / 100%',
    detail: `widest echo group ${maxEchoChannels} channel(s)`,
  };
});

test('an echo bears on the Choir, not on the thing it is imitating', () => {
  const ship = new Ship(vec(0, 20000, 4000), 'cruise');       // due north
  const w = world({ ship });
  const choir = makeChoir(w, { position: vec(4000, 20000, 0), radiusM: 400 });  // due east
  const at = vec(0, 20000, 0);
  w.run(240, [choir]);

  const rec = new EchoReceiver({
    id: 5, position: vec(at.x, at.y, at.z), rng: new Rng(11),
    spec: { acoustic: { threshold: RECORDING_FLOOR.acoustic, saturation: 60 } },
  });
  const toShip = azimuth(at, ship.position);
  const toChoir = azimuth(at, choir.position);
  const errChoir = [], errShip = [];
  for (let i = 0; i < 400; i++) {
    w.run(0.5, [choir]);
    for (const p of senseEchoes(rec, w.ctx, rec.spec, [])) {
      errChoir.push(Math.abs(shortestAngle(toChoir, p.bearing)));
      errShip.push(Math.abs(shortestAngle(toShip, p.bearing)));
    }
  }
  const mc = deg(mean(errChoir)), ms = deg(mean(errShip));
  return {
    ok: errChoir.length > 0 && mc < 8 && ms > 80,
    got: `${mc.toFixed(2)}° from the Choir, ${ms.toFixed(2)}° from the ship`,
    want: '<8° from the Choir, >80° from the ship',
    detail: `${errChoir.length} echo percepts, shoal 90° off the ship`,
  };
});

test('the tell degrades inside the shoal, and by how much', () => {
  const ship = new Ship(vec(0, 20000, 6000), 'cruise');
  const w = world({ ship });
  const choir = makeChoir(w, { position: vec(0, 20000, 0), radiusM: 2000 });
  w.run(300, [choir]);

  const spreadAt = (at) => {
    const rec = new EchoReceiver({
      id: 6, position: vec(at.x, at.y, at.z), rng: new Rng(13),
      spec: { acoustic: { threshold: RECORDING_FLOOR.acoustic, saturation: 60 } },
    });
    const toCentre = azimuth(at, choir.position);
    const errs = [];
    for (let i = 0; i < 300; i++) {
      w.run(0.4, [choir]);
      for (const p of senseEchoes(rec, w.ctx, rec.spec, [])) {
        errs.push(shortestAngle(toCentre, p.bearing));
      }
    }
    return { n: errs.length, spread: deg(sd(errs)) };
  };

  const outside = spreadAt(vec(0, 20000, -9000));   // 9 km from a 2 km shoal
  const inside = spreadAt(vec(0, 20000, 0));        // at its centre
  const ratio = inside.spread / Math.max(outside.spread, 1e-6);
  return {
    ok: outside.n > 0 && inside.n > 0 && outside.spread < 15 && inside.spread > 60 && ratio > 4,
    got: `${outside.spread.toFixed(1)}° at 9 km, ${inside.spread.toFixed(1)}° inside (${ratio.toFixed(1)}×)`,
    want: 'tight outside, near-uniform inside',
    detail: `${outside.n} / ${inside.n} echo percepts`,
  };
});

// --- §10.4: it draws other creatures --------------------------------------

test('a creature commits to an echo, and commits to the wrong place', () => {
  // §5.4 anchors the Listener at 0 → COMMITTED in 19 s at excess 0.4. Excess 0.4
  // against thresholds 16/60 is a received 33.6 dB(V); a 46 dB(V) engine note in
  // clear air is 33.6 dB at 100·10^(12.4/20) = 416.9 m. Placing the shoal there,
  // with a radius small enough that the geometry is the geometry, makes this a
  // direct measurement of §5.4's own figure through the echo path.
  //
  // **The clock runs from the first echo, not from t=0.** A freshly spawned
  // shoal waits one echo interval before it says anything, which is correct
  // behaviour and has nothing to do with the number under test. The first
  // version of this case measured absolute sim time, reported 47.7 s against a
  // stated 19, and the discrepancy was entirely the wait — the *rate* over the
  // ladder was 0.0479/s against a predicted 0.048. That was a broken instrument,
  // not a broken creature, which is this project's most common failure by a
  // wide margin.
  const ship = new Ship(vec(0, 20000, 7000), 'cruise');       // 7 km, due north
  const w = world({ ship });
  const choir = makeChoir(w, { position: vec(416.9, 20000, 0), radiusM: 4 });  // due east
  choir.density01 = 0.95; choir._ambient = 0.95; choir._nextAmbientAt = 1e9;

  const rec = new EchoReceiver({ id: 8, position: vec(0, 20000, 0), rng: new Rng(3) });
  const seen = {};
  let committedAt = null, startedAt = null;
  w.run(180, [choir, rec], (ctx) => {
    if (startedAt === null && rec.attention > 0) startedAt = ctx.t;
    if (!(rec.state in seen)) seen[rec.state] = ctx.t;
    if (rec.state === STATE.COMMITTED && committedAt === null) committedAt = ctx.t;
  });
  const elapsed = committedAt === null ? null : committedAt - startedAt;

  const at = rec.position;
  const toShip = deg(Math.abs(shortestAngle(azimuth(at, ship.position), rec.lastBearing ?? 0)));
  const toChoir = deg(Math.abs(shortestAngle(azimuth(at, choir.position), rec.lastBearing ?? 0)));
  const events = rec.detectionLog();
  const allFalse = events.length > 0 && events.filter((e) => e.channel === 'acoustic').every((e) => e.real === false);
  const strength = (rec._lastCause && rec._lastCause.strength) || 0;
  return {
    ok: elapsed !== null && Math.abs(elapsed - 19) < 1.5 && toChoir < 15 && toShip > 75 && allFalse,
    got: `COMMITTED ${elapsed === null ? 'never' : elapsed.toFixed(2) + ' s'} after the first echo, aimed ${toChoir.toFixed(1)}° off the Choir and ${toShip.toFixed(1)}° off the ship`,
    want: '§5.4: 19 s at excess 0.4 (±1.5), aimed at the Choir',
    detail: `received ${strength.toFixed(2)} dB(V) (excess ${((strength - 16) / 44).toFixed(3)}); ` +
      `ladder ${Object.entries(seen).map(([s, t]) => `${s}@${(+t - startedAt).toFixed(1)}`).join('→')}; ` +
      `all acoustic events real:false = ${allFalse}`,
  };
});

test('the same echo leaves the real ship undetected', () => {
  // The control for the case above: nothing in the receiver's own world is
  // audible, so everything it did was the shoal's doing.
  const ship = new Ship(vec(0, 20000, 7000), 'cruise');
  const w = world({ ship });
  const rec = new EchoReceiver({ id: 12, position: vec(0, 20000, 0), rng: new Rng(3) });
  w.run(120, [rec]);
  return {
    ok: rec.state === STATE.UNAWARE && rec.attention === 0 && rec.detectionLog().length === 0,
    got: `${rec.state}, attention ${rec.attention}`,
    want: 'UNAWARE with an empty bus',
  };
});

// --- §10.4: scanning poisons it -------------------------------------------

test('one scan is still on the instruments ten minutes later', () => {
  const ship = new Ship(vec(300, 20000, 0), 'cruise');
  const w = world({ ship });
  const c = makeChoir(w, { radiusM: 800 });
  w.run(30, [c]);
  ship.set('scan');
  w.run(2, [c]);                       // §3.2: the pulse is 0.2 s; 2 s is generous
  const scanAt = w.ctx.t;
  ship.set('cruise');
  const held = c.scanMemoryCount();

  // Counted at emission time rather than from `echoHistory()`, which only keeps
  // the last 64 and would silently lose the early repeats.
  w.run(700, [c]);
  const count = c.scanEchoCount;
  const span = c.lastScanEchoAt - scanAt;

  return {
    // It has to last, and it has to *end*: §5.4's memory is 600 s and a poison
    // with no end removes the player's reason to wait it out. See `_record`.
    ok: held > 0 && count >= 10 && span > 500 && span <= CHOIR.memorySec + 5
      && c.scanMemoryCount() === 0,
    got: `${held} scan recording(s), ${count} repeats over ${span.toFixed(0)} s, then silence`,
    want: `≥10 repeats spanning 500–${CHOIR.memorySec} s, scan memory empty afterwards`,
    detail: `memory now ${c.memory.length}, scans still held ${c.scanMemoryCount()}`,
  };
});

test('a scan survives four hundred louder, newer recordings', () => {
  const ship = new Ship(vec(300, 20000, 0), 'scan');
  const w = world({ ship });
  const c = makeChoir(w);
  w.run(3, [c]);
  const scans = c.scanMemoryCount();
  // Flood the memory with distinct ordinary sources, past the cap.
  for (let i = 0; i < CHOIR.capacity + 120; i++) {
    c._record({ t: w.ctx.t + i * 0.01 }, 'acoustic', 46, 'flood', i, 0, {});
  }
  return {
    ok: scans > 0 && c.scanMemoryCount() === scans && c.memory.length <= CHOIR.capacity + scans,
    got: `${scans} scans in, ${c.scanMemoryCount()} out, memory ${c.memory.length}`,
    want: 'scans survive capacity eviction',
    detail: `${c.forgotCount} ordinary recordings forgotten`,
  };
});

// --- §4.4: the two trail channels -----------------------------------------

test('a wake echo obeys §4.4 falloff and dies at the receiver\'s sense radius', () => {
  // A parcel field that says "there is a trail here", nothing more. §4.4's
  // stimulus is a property of the receiver's radius, so the source only has to
  // report a number.
  const trails = { sampleWake: () => 0.9, sampleThermal: () => 12.0 };
  const ship = new Ship(vec(400, 20000, 0), 'cruise');
  const w = world({ ship, trails });
  const c = makeChoir(w, { radiusM: 2 });      // a point, so the geometry is clean
  c.density01 = 0.95; c._ambient = 0.95; c._nextAmbientAt = 1e9;
  w.run(120, [c]);

  const held = c.memory.filter((r) => r.channel === 'wake' || r.channel === 'thermal');
  const R = 165;
  const spec = { wake: { threshold: 0.05, saturation: 2.0, senseRadiusM: R } };
  const at = (dz) => {
    const rec = new EchoReceiver({ id: 20, position: vec(0, 20000, dz), rng: new Rng(2), spec });
    return senseEchoes(rec, w.ctx, spec, []);
  };
  const near = at(40);      // ~40 m from the shoal
  const far = at(200);      // outside the 165 m radius
  // Checked against each percept's **own** distance, not against a nominal 40 m.
  // The shoal has a 2 m radius, so the echoes are 38–42 m out and a single
  // predicted value is wrong by 0.6% for reasons that have nothing to do with
  // §4.4 — which is exactly how this project has manufactured five imaginary
  // bugs before.
  const worst = near.length
    ? Math.max(...near.map((p) => Math.abs(p.strength - 0.9 * (1 - p.distance / R))))
    : Infinity;
  return {
    ok: held.length >= 2 && near.length > 0 && far.length === 0 && worst < 1e-12,
    got: `${held.length} trail recordings; ${near.length} percept(s) at 40 m, ${far.length} at 200 m; worst |Δ| ${worst.toExponential(1)} s⁻¹`,
    want: `§4.4 falloff exactly, nothing past ${R} m`,
    detail: `channels held: ${[...new Set(held.map((r) => r.channel))].join('+')}; ` +
      `strength ${near[0] ? near[0].strength.toFixed(4) : '—'} s⁻¹ at ${near[0] ? near[0].distance.toFixed(1) : '—'} m`,
  };
});

// --- §8: the reduced model -------------------------------------------------

test('a reduced shoal stops recording but keeps echoing what it already had', () => {
  // The judgement call documented at the foot of `choir.js`. Pinned here so it
  // is visible rather than assumed: §8 forbids the reduced model producing a
  // *detection*, and this file's reading is that an echo is a source and not a
  // sense. If the orchestrator rejects that reading, this is the case that
  // changes.
  const ship = new Ship(vec(500, 20000, 0), 'lamp');
  const w = world({ ship });
  const c = makeChoir(w, { radiusM: 500 });
  c.density01 = 0.95; c._ambient = 0.95; c._nextAmbientAt = 1e9;
  w.run(120, [c]);
  const recordsWhenFull = c.recordCount;
  const echoesWhenFull = c.echoCount;

  c.simLevel = 'reduced';
  w.run(120, [c]);
  const newRecords = c.recordCount - recordsWhenFull;
  const newEchoes = c.echoCount - echoesWhenFull;
  return {
    ok: recordsWhenFull > 0 && newRecords === 0 && newEchoes > 10,
    got: `reduced: +${newRecords} recordings, +${newEchoes} echoes`,
    want: '+0 recordings, echoes continue',
    detail: `held ${c.memory.length} recordings made while fully simulated`,
  };
});

// --- §10.4: environmental signature ---------------------------------------

test('acoustic absorption is 6 dB per km of shoal, scaled by density', () => {
  const c = new Choir({ id: 1, position: vec(0, 20000, 0), radiusM: 2000, rng: new Rng(1) });
  c.density01 = 1.0;
  const through = choirAbsorptionDb([c], vec(-6000, 20000, 0), vec(6000, 20000, 0));  // full diameter
  c.density01 = 0.25;
  const thin = choirAbsorptionDb([c], vec(-6000, 20000, 0), vec(6000, 20000, 0));
  const past = choirAbsorptionDb([c], vec(-6000, 20000, 3000), vec(6000, 20000, 3000)); // clean miss
  const glance = choirAbsorptionDb([c], vec(-6000, 20000, 1936), vec(6000, 20000, 1936)); // ~1000 m chord
  const chord = chordThroughSphere(-6000, 20000, 1936, 6000, 20000, 1936, 0, 20000, 0, 2000);
  return {
    ok: Math.abs(through - 24) < 0.01 && Math.abs(thin - 6) < 0.01 && past === 0
      && Math.abs(glance - CHOIR.absorbDbPerKm * 0.25 * chord / 1000) < 0.01,
    got: `diameter ${through.toFixed(2)} dB at ρ=1, ${thin.toFixed(2)} dB at ρ=0.25, ${past} dB past it`,
    want: '24.00 / 6.00 / 0',
    detail: `glancing chord ${chord.toFixed(0)} m → ${glance.toFixed(2)} dB`,
  };
});

test('EM bearing error rises to 0.8 rad across a dense shoal', () => {
  const c = new Choir({ id: 1, position: vec(0, 20000, 0), radiusM: 2000, rng: new Rng(1) });
  c.density01 = 1.0;
  const full = choirEmSigmaAdd([c], vec(-6000, 20000, 0), vec(6000, 20000, 0));
  c.density01 = 0.5;
  const half = choirEmSigmaAdd([c], vec(-6000, 20000, 0), vec(6000, 20000, 0));
  const miss = choirEmSigmaAdd([c], vec(-6000, 20000, 3000), vec(6000, 20000, 3000));
  return {
    ok: Math.abs(full - CHOIR.emSigmaAddMax) < 1e-6 && Math.abs(half - 0.4) < 1e-6 && miss === 0,
    got: `${full.toFixed(3)} / ${half.toFixed(3)} / ${miss.toFixed(3)} rad`,
    want: '0.800 / 0.400 / 0.000',
    detail: `${deg(full).toFixed(0)}° of error across a dense shoal`,
  };
});

// --- §8 and §12 -----------------------------------------------------------

test('medium samples stay inside the §8 budget of 32 per sense tick', () => {
  const peers = [
    new Voice({ id: 9, archetype: 'Listener', bodyLength: 240, db: 40, pos: vec(-1500, 20000, 0) }),
    new Voice({ id: 10, archetype: 'Lantern', bodyLength: 90, db: 20, pos: vec(1500, 20000, 900) }),
  ];
  const ship = new Ship(vec(700, 20000, 0), 'lamp');
  const w = world({ ship, peers });
  const c = makeChoir(w);
  let worst = 0;
  w.run(300, [c], () => { worst = Math.max(worst, c.mediumSamplesLastTick); });
  return {
    ok: worst > 0 && worst <= 32,
    got: `${worst} samples on the busiest sense tick`,
    want: '≤ 32',
  };
});

test('the same seed replays the same shoal, echo for echo', () => {
  const runOnce = () => {
    const peers = [new Voice({ id: 9, archetype: 'Listener', bodyLength: 240, db: 40, pos: vec(-1500, 20000, 0) })];
    const ship = new Ship(vec(800, 20000, 0), 'lamp');
    const w = world({ ship, peers });
    const c = makeChoir(w, { seed: 0x5EED });
    w.run(600, [c]);
    return c.echoHistory().map((e) =>
      `${e.channel}|${e.sourceKind}|${e.t0.toFixed(3)}|${e.pitch.toFixed(6)}|${e.x.toFixed(3)}|${e.z.toFixed(3)}`).join(';');
  };
  const a = runOnce(), b = runOnce();
  return {
    ok: a.length > 0 && a === b,
    got: a === b ? `identical over ${a.split(';').length} echoes` : 'diverged',
    want: 'identical',
  };
});

test('pitch stays inside §10.4\'s 0.7–1.3×', () => {
  const ship = new Ship(vec(800, 20000, 0), 'lamp');
  const w = world({ ship });
  const c = makeChoir(w);
  c.density01 = 0.95; c._ambient = 0.95; c._nextAmbientAt = 1e9;
  w.run(900, [c]);
  const pitches = c.echoHistory().map((e) => e.pitch);
  const lo = Math.min(...pitches), hi = Math.max(...pitches);
  return {
    ok: pitches.length > 20 && lo >= 0.7 && hi <= 1.3,
    got: `${lo.toFixed(3)}–${hi.toFixed(3)} over ${pitches.length} echoes`,
    want: '0.700–1.300',
  };
});

test('it has no voice of its own', () => {
  const ship = new Ship(vec(800, 20000, 0), 'lamp');
  const w = world({ ship });
  const c = makeChoir(w);
  w.run(300, [c]);
  const v = c.voiceState();
  return {
    ok: v.emittedDb === 0 && v.calling === false && v.fundamentalHz === null,
    got: `emittedDb ${v.emittedDb}, calling ${v.calling}, fundamental ${v.fundamentalHz}`,
    want: 'silent',
    detail: `absorbing ${v.absorbDbPerKm.toFixed(2)} dB/km, ${v.echoes.length} echoes live`,
  };
});

// ---------------------------------------------------------------------------

/** Run every case. Returns { pass, fail, results }. */
export function run() {
  const results = CASES.map(({ name, fn }) => {
    try {
      const r = fn();
      return { name, ok: !!r.ok, want: r.want, got: r.got, detailText: r.detail ?? '' };
    } catch (e) {
      return { name, ok: false, want: 'no exception', got: `threw: ${e.message}`, detailText: '' };
    }
  });
  return {
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok),
    results,
  };
}

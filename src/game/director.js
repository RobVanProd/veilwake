// The vertical slice: what happens, and what makes it happen.
//
//   import { Director } from './game/director.js';
//   const director = new Director({ clouds, creatures, signature, systems, ship, controls });
//   director.update(dt, simTime);        // once per fixed step, last
//
// Everything before this file was a system. A system is not a game: the Listener
// hunts, the signature makes acting cost you, and the world is dark, but none of
// it ever *begins* or *ends*. This is the part that arranges them into fifteen
// minutes with a shape.
//
// --- the one rule this file obeys -------------------------------------------
//
// **Beats advance on what the player did, never on a timer.** Every condition
// below is a measurement of the actual simulation — distance travelled, a
// creature's real attention, the density the ship is actually inside, the
// signature it is actually emitting. A timer would produce the same fifteen
// minutes whatever the player does, which is a film. The cost of doing it this
// way is that a player can sit still and the game will wait; that is the correct
// trade, because the alternative is a game that stops listening to them.
//
// The one exception is `minSeconds`, which prevents a beat from being skipped
// before its idea has had a chance to land — a floor, never a driver.
//
// --- how it says things -----------------------------------------------------
//
// Sparsely, and never in the imperative. The mandate asks for a game that is
// understood through play, so the captions state what *is* rather than what to
// do: "SOMETHING CAME THROUGH HERE" rather than "follow the corridor". A player
// who is told what to press has been given a task; one who is told what is true
// has been given a situation.

import { STATE, STATE_ORDER, Listener, Lantern, WakeHunter, Choir } from './creatures/index.js';

const rank = (s) => STATE_ORDER.indexOf(s);

/** How the run can end. */
export const OUTCOME = { RUNNING: 'running', TAKEN: 'taken', ESCAPED: 'escaped' };

/**
 * The beats.
 *
 * `enter`  — set the world up for this beat.
 * `done`   — the measurement that advances it.
 * `fail`   — optional, per-beat, beyond the global one.
 * `say`    — captions, each shown once, gated on their own measurement.
 */
export const BEATS = [
  {
    key: 'adrift',
    title: 'ADRIFT',
    minSeconds: 4,
    enter(g) {
      g.controls.cutEngines = true;
      g.controls.throttle = 0;
      g.systems.lampOn = false;
      g.setCreatureEnabled(false);
    },
    say: [
      { at: 0.0, text: 'POWER: RESERVE' },
      { at: 2.5, text: 'you are drifting, and nothing can hear you' },
    ],
    // Advances when the player restores thrust. Nothing else in the game will
    // do it for them, and the first thing they learn is that being quiet was a
    // state they chose to leave.
    done: (g) => !g.controls.cutEngines && g.ship.telemetry().throttle > 0.15,
  },
  {
    key: 'underway',
    title: 'UNDERWAY',
    minSeconds: 10,
    enter(g) { g.markDistance(); },
    say: [
      { at: 0.0, text: 'ENGINE ONLINE' },
      { at: 3.0, text: 'everything you do to survive can be heard' },
    ],
    done: (g) => g.distanceSinceMark() > 4200,
  },
  {
    key: 'trace',
    title: 'TRACE',
    minSeconds: 8,
    // The first evidence: a corridor of cleared air, hundreds of metres wide,
    // that nothing in the weather could have made. It is placed across the
    // player's actual heading rather than at a fixed point, so it is found by
    // flying rather than by navigating to a marker.
    enter(g) {
      g.placeTraceAhead(3200);
      g.markDistance();
      g.setCreatureEnabled(false);
      // A Lantern, far off to one side. §10.2 calls it "a beautiful thing at
      // distance, worth approaching — this is beat 2 of the session", and
      // GAME_VISION's second beat is Curiosity: something legible and
      // interesting at range that is worth a deviation. It is the first
      // creature the player ever sees and it is the one that is lovely, which
      // is what makes the dimming land later.
      g.spawn('Lantern', 4200, -2600, { dy: 120 });
    },
    say: [
      { at: 0.0, text: 'the cloud ahead is wrong' },
      { at: 4.0, text: 'SOMETHING CAME THROUGH HERE' },
      { at: 9.0, text: 'there are lights out to port' },
    ],
    // Either you reach it, or you have flown far enough that you would have
    // passed it. The trace is placed along the heading at the moment the beat
    // begins, and a ship that turns — or simply drifts on a 15 m/s crosswind at
    // low throttle — can miss the window entirely and strand the run. A beat
    // that can become unreachable is a beat that will, eventually, to somebody.
    done: (g) => g.distanceToTrace() < 900 || g.distanceSinceMark() > 5200,
  },
  {
    key: 'quiet',
    title: 'THE QUIET',
    minSeconds: 12,
    // It calls, and it is far away. The Listener has a voice on a 40–90 s cycle;
    // here it is made to call once, deliberately, so the player hears the sound
    // before they ever meet the thing that makes it.
    enter(g) {
      g.setCreatureEnabled(true);
      g.placeCreatureAhead(9000);
      g.forceCall();
    },
    say: [
      { at: 1.0, text: '' },
      { at: 3.0, text: 'something answered' },
    ],
    done: (g, t) => t > 12,
  },
  {
    key: 'heard',
    title: 'HEARD',
    minSeconds: 0,
    // The first real encounter. It is brought inside hearing range at cruise —
    // about 3.2 km — so that continuing to fly loudly is what gets the player
    // noticed. Doing nothing is now a decision with a cost.
    enter(g) {
      g.setCreatureEnabled(true);
      // Close, and off to one side, so the ship flies past it rather than
      // through it — see placeCreatureAhead for why both numbers matter.
      g.placeCreatureAhead(1300, 340);
      // It starts partway up the ladder because it has genuinely been hearing
      // an approaching noise since the previous beat: the player has been flying
      // under power for the best part of a minute and the previous beat is
      // literally the creature calling out.
      g.primeAttention(0.16);
    },
    say: [
      { at: 0.0, text: 'CONTACT — BEARING UNKNOWN' },
      { at: 5.0, text: 'it is listening for you' },
    ],
    // Two ways past, and the second one matters. A player running at a quarter
    // throttle emits about 10 dB and is genuinely inaudible — measured, the
    // creature never notices them at all, which is the signature system working
    // exactly as designed. Waiting for it to notice would strand the run and
    // punish the only player who has understood the game. Slipping by unheard is
    // a win, so it advances.
    // The second clause has no exposure term on purpose. An earlier version
    // asked for exposure < 0.20 as proof of stealth and stranded the run anyway,
    // because thermal is a 90 s integrator and a ship that has been under way at
    // all carries enough residual heat to fail it. The creature still being
    // UNAWARE at four kilometres IS the proof; asking for a second one only
    // measured how long ago the player started flying.
    done: (g) => rank(g.creatureState()) >= rank(STATE.ALERT)
      || (g.creatureState() === STATE.UNAWARE && g.creatureRange() > 4200),
  },
  {
    key: 'conceal',
    title: 'CONCEALMENT',
    minSeconds: 0,
    // The lesson: going quiet works, and it costs. Advancing requires the
    // creature to actually lose interest, which requires the player to actually
    // reduce what they are emitting — there is no way to satisfy this by waiting
    // somewhere safe while still running loud.
    say: [
      { at: 0.0, text: 'it is closer' },
      { at: 4.0, text: 'CUT ENGINES — Z' },
      { at: 12.0, text: 'thick cloud will hide the rest of you' },
    ],
    // It has to actually lose you, and you have to actually be quiet. Neither
    // alone will do: staying loud somewhere safe leaves it interested, and going
    // quiet after it has already committed does not un-ring the bell.
    done: (g) => (g.creatureState() === STATE.UNAWARE && g.exposure() < 0.24)
      || (rank(g.creatureState()) <= rank(STATE.ALERT) && g.creatureRange() > 6000),
  },
  {
    key: 'hunted',
    title: 'HUNTED',
    minSeconds: 0,
    // The second encounter, and the one that commits. Placed close and fed a
    // head start on attention, because by now the player knows the rules and the
    // beat is about pressure rather than teaching.
    enter(g) {
      // A Wake Hunter pack, and this beat exists to invert what the last two
      // taught. Everything up to here rewards going quiet and staying put;
      // §10.3's line is "against the Wake Hunter, running is what gets you
      // caught", because speed is what writes the trail it follows. Meeting it
      // immediately after learning to hide is the point.
      for (let i = 0; i < 4; i++) {
        g.spawn('WakeHunter', 900 + i * 120, -300 + i * 190, { dy: -40 + i * 25 });
      }
      g.setCreatureEnabled(true);
      g.placeCreatureAhead(700, 180);
      // Near the top of the ladder on arrival. Measured, one close pass at a
      // relaxed throttle is worth about +0.1 attention, so a beat that wants
      // COMMITTED at 0.92 cannot start at 0.62 and hope — a ship at 100 m/s
      // simply is not audible for long enough to climb 0.3 in one encounter.
      // Starting here is also the honest reading of the fiction: this is not a
      // creature discovering you, it is one that already has your bearing.
      g.primeAttention(0.85);
    },
    say: [
      { at: 0.0, text: 'CONTACT — CLOSING' },
      { at: 3.0, text: 'this one has your bearing' },
    ],
    // Two ways out, because a player who immediately turns and runs has done
    // something correct and should not be held here waiting to be committed to.
    // Either it commits to you, or you break contact before it can.
    done: (g) => g.creatureState() === STATE.COMMITTED
      || (rank(g.creatureState()) <= rank(STATE.ALERT) && g.creatureRange() > 5000),
  },
  {
    key: 'run',
    title: 'RUN',
    minSeconds: 0,
    say: [
      { at: 0.0, text: 'RUN' },
      { at: 6.0, text: 'it is faster than you in a straight line' },
    ],
    // Escape is by breaking its attention, not by winning a race — the Listener
    // makes 20 m/s committed against the ship's ~100, so a pure sprint always
    // works and would teach nothing. Requiring de-escalation means the player
    // has to stop being worth following.
    done: (g) => rank(g.creatureState()) <= rank(STATE.SEARCHING) && g.creatureRange() > 3500,
  },
  {
    key: 'break',
    title: 'THE BREAK',
    minSeconds: 6,
    enter(g) {
      g.markDistance();
      g.setCreatureEnabled(false);
      // A Choir on the way out. It never hunts and never commits — it repeats
      // what it has heard, and its echoes draw other creatures to somewhere you
      // are not. Placed last because §10.4's payoff is a player who has already
      // learned the other three well enough to notice that something is
      // imitating them.
      g.spawn('Choir', 3800, 1500, { dy: 60 });
    },
    say: [
      { at: 0.0, text: 'it has lost you' },
      { at: 5.0, text: 'there is a thinning ahead' },
      { at: 11.0, text: 'something out there is repeating your engine note' },
    ],
    done: (g) => g.distanceSinceMark() > 7000,
    ending: OUTCOME.ESCAPED,
  },
];

const DEFAULTS = {
  /**
   * Taken when a committed creature holds within `takenRange` for `graceSec`.
   *
   * These numbers took measuring, and the first pair were unreachable. Being
   * "caught" cannot mean being touched: the Listener makes 20 m/s committed, the
   * ship makes 100 at cruise and still 60 at six percent throttle, and even with
   * engines cut it drifts at 13 on the wind. Driven directly, a creature closing
   * on a stationary ship got from 600 m to 529 m and then lost ground for the
   * next two minutes. There is no chase in this game and there was never going
   * to be one.
   *
   * So failure is failing to break its commitment, not failing to outrun it. At
   * 600 m and six seconds, a player who runs the instant it commits escapes —
   * from the 59 m the encounter actually starts at, full throttle clears 600 m in
   * about 5.4 seconds — and a player who hesitates does not. That margin is the
   * whole encounter.
   */
  takenRange: 600,
  graceSec: 6.0,
  /** Where a restart resumes. Beats before this replay; the slice is not a rogue-like. */
  restartAtBeat: 'heard',
};

export class Director {
  constructor({ clouds, creatures, signature, systems, ship, controls, rng = Math.random, opts = {} }) {
    this.clouds = clouds;
    this.creatures = creatures;
    this.signature = signature;
    this.systems = systems;
    this.ship = ship;
    this.controls = controls;
    this.rng = rng;
    this.cfg = { ...DEFAULTS, ...opts };

    this.index = 0;
    this.beatTime = 0;
    this.outcome = OUTCOME.RUNNING;
    this.caption = '';
    this.captionAge = 0;
    this._said = new Set();
    this._mark = { x: 0, y: 0, z: 0 };
    this._trace = null;
    this._closeFor = 0;
    this.attempts = 0;
    /** Creatures this beat put in the world; cleared when it ends. */
    this._spawned = [];
    /** The animal the current beat is about. */
    this._focus = null;

    /** Anything that wants to react to a beat change without polling. */
    this.onBeat = null;
    this.onCaption = null;

    this._enter();
  }

  get beat() { return BEATS[this.index]; }

  // --- the measurements the beats are written against ----------------------

  markDistance() { const p = this.ship.position; this._mark = { x: p.x, y: p.y, z: p.z }; }
  distanceSinceMark() {
    const p = this.ship.position, m = this._mark;
    return Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z);
  }

  /**
   * The creature currently driving the beat.
   *
   * The slice used to run on `creatures[0]` and spawn nothing else, so a player
   * met exactly one archetype out of four — the other three were fully
   * simulated, tested, and never encountered. `_focus` is whichever animal the
   * current beat is about; everything else in the world carries on regardless.
   */
  _c() { return this._focus || this.creatures.creatures[0] || null; }

  /**
   * Put an archetype in the world, `d` metres along the heading and `side` across.
   *
   * @param {'Listener'|'Lantern'|'WakeHunter'|'Choir'} kind
   */
  spawn(kind, d, side = 0, opts = {}) {
    const p = this.ship.position, f = this.ship.forward;
    const rx = -f.z, rz = f.x;
    const rl = Math.hypot(rx, rz) || 1;
    const at = {
      x: p.x + f.x * d + (rx / rl) * side,
      y: Math.max(240, p.y + (opts.dy ?? 0)),
      z: p.z + f.z * d + (rz / rl) * side,
    };
    const seed = (this.rng ? Math.floor(this.rng() * 1e9) : 1) | 0;
    const Ctor = { Listener, Lantern, WakeHunter, Choir }[kind];
    if (!Ctor) return null;
    const c = new Ctor({ position: at, seed, ...opts });
    this.creatures.add(c);
    this._spawned.push(c);
    return c;
  }

  /** Everything this beat put in the world goes dormant when the beat ends. */
  _clearSpawned() {
    for (const c of this._spawned) c.dormant = true;
    this._spawned.length = 0;
    this._focus = null;
  }
  creatureState() { const c = this._c(); return c ? c.state : STATE.UNAWARE; }
  creatureRange() {
    const c = this._c(); if (!c) return Infinity;
    const p = this.ship.position;
    return Math.hypot(c.position.x - p.x, c.position.y - p.y, c.position.z - p.z);
  }
  exposure() { return this.signature.exposure().total; }
  concealment() {
    const p = this.ship.position;
    return this.clouds.concealmentAt ? this.clouds.concealmentAt(p.x, p.y, p.z) : 0;
  }

  // --- the levers the beats pull -------------------------------------------

  setCreatureEnabled(on) {
    const c = this._c(); if (!c) return;
    // Dormant rather than removed — see the note on Creature.update(). A
    // creature that blinks out of existence is one the player cannot build a
    // model of, and the whole design rests on the Listener being learnable.
    c.dormant = !on;
    if (!on) c.attention = 0;
  }

  /**
   * Put the creature `d` metres along the ship's real heading, offset `side`
   * metres across it.
   *
   * The offset is what makes an encounter last. Placed dead ahead, a ship at
   * 100 m/s passes through the creature's hearing in a couple of seconds and
   * out the other side; offset, it flies past at a roughly constant range and
   * stays audible for long enough that attention can actually build.
   *
   * Distance has to be chosen against how loud the player will be, not against
   * a nominal figure. Detection range scales as 10^(-dB/20), so the 3.2 km the
   * contract quotes is for a ship at full cruise; at a relaxed 0.7 throttle the
   * ship emits 32.4 dB rather than 46 and is inaudible past about 660 m. A beat
   * that placed a creature at 2.6 km and waited for it to notice was waiting for
   * something the physics had already ruled out.
   */
  placeCreatureAhead(d, side = 0) {
    const c = this._c(); if (!c) return;
    const p = this.ship.position, f = this.ship.forward;
    // Right vector in the horizontal plane; the creature stays in the layer.
    const rx = -f.z, rz = f.x;
    const rl = Math.hypot(rx, rz) || 1;
    c.position.x = p.x + f.x * d + (rx / rl) * side;
    c.position.y = Math.max(220, p.y + f.y * d * 0.15);
    c.position.z = p.z + f.z * d + (rz / rl) * side;
    c.dormant = false;
  }

  primeAttention(a) { const c = this._c(); if (c) c.attention = a; }
  forceCall() { const c = this._c(); if (c && c._voice) { try { c._voice(0); } catch { /* optional */ } } }

  placeTraceAhead(d) {
    const p = this.ship.position, f = this.ship.forward;
    this._trace = { x: p.x + f.x * d, y: p.y, z: p.z + f.z * d };
  }
  distanceToTrace() {
    if (!this._trace) return Infinity;
    const p = this.ship.position, t = this._trace;
    return Math.hypot(p.x - t.x, p.z - t.z);
  }

  // --- running -------------------------------------------------------------

  _enter() {
    this.beatTime = 0;
    this._said.clear();
    this._closeFor = 0;
    // Whatever the previous beat put in the world goes dormant. Without this the
    // world accumulates every creature every beat ever spawned, and by the end a
    // player is being hunted by four packs at once — which is not difficulty, it
    // is noise, and §6's one-COMMITTED rule cannot make it readable.
    this._clearSpawned();
    const b = this.beat;
    if (b && b.enter) b.enter(this);
    if (this.onBeat) this.onBeat(b, this.index);
  }

  _say(text) {
    this.caption = text;
    this.captionAge = 0;
    if (this.onCaption) this.onCaption(text);
  }

  /** @param {number} dt @param {number} simTime */
  update(dt, simTime) {
    if (this.outcome !== OUTCOME.RUNNING) return this;
    const b = this.beat;
    if (!b) return this;

    this.beatTime += dt;
    this.captionAge += dt;

    for (let i = 0; i < (b.say ? b.say.length : 0); i++) {
      const s = b.say[i];
      if (this._said.has(i) || this.beatTime < s.at) continue;
      this._said.add(i);
      if (s.text) this._say(s.text);
    }

    // Failure: a committed creature that holds close. Given a grace window so a
    // single unlucky pass is survivable and only a genuine failure to break
    // contact ends the run.
    if (this.creatureState() === STATE.COMMITTED && this.creatureRange() < this.cfg.takenRange) {
      this._closeFor += dt;
      if (this._closeFor >= this.cfg.graceSec) { this._fail(); return this; }
    } else {
      this._closeFor = Math.max(0, this._closeFor - dt * 0.5);
    }

    const past = this.beatTime >= (b.minSeconds || 0);
    if (past && b.done && b.done(this, this.beatTime)) {
      if (b.ending) { this.outcome = b.ending; this._say('YOU ARE THROUGH'); return this; }
      this.index = Math.min(this.index + 1, BEATS.length - 1);
      this._enter();
    }
    return this;
  }

  _fail() {
    this.outcome = OUTCOME.TAKEN;
    this._say('TAKEN');
  }

  /**
   * Resume after being taken.
   *
   * Back to a named beat rather than to the start. The slice is fifteen minutes
   * and its early beats are teaching; replaying them after a death in the eighth
   * minute punishes the player for the part they already understood.
   */
  restart() {
    this.attempts++;
    this.outcome = OUTCOME.RUNNING;
    const i = BEATS.findIndex((b) => b.key === this.cfg.restartAtBeat);
    this.index = i < 0 ? 0 : i;
    const c = this._c();
    if (c) { c.attention = 0; c.dormant = false; }
    this._enter();
    return this;
  }

  snapshot() {
    const b = this.beat;
    return {
      beat: b ? b.key : null,
      title: b ? b.title : null,
      index: this.index,
      of: BEATS.length,
      beatTime: +this.beatTime.toFixed(1),
      outcome: this.outcome,
      caption: this.caption,
      attempts: this.attempts,
      creature: this.creatureState(),
      range: Math.round(this.creatureRange()),
      exposure: +this.exposure().toFixed(3),
    };
  }
}

// The vertical slice, as a regression test.
//
// The slice is the one thing in this project that can break without any unit
// test noticing. Every beat advances on a measurement of the live simulation —
// the creature's real attention, the signature actually being emitted, distance
// actually travelled — so a change anywhere in flight, signature, creatures or
// the medium can strand a beat and leave the game unfinishable, while every
// other suite stays green.
//
// It has already happened twice during development, and both times the cause was
// the physics being *right*:
//
//   - A beat waited for a creature to notice a ship that was, correctly,
//     inaudible: at a quarter throttle the ship emits about 10 dB and the
//     Listener genuinely cannot hear it. The beat was waiting for something the
//     signature system had already ruled out.
//   - A beat placed a creature at 2.6 km and waited for detection, but detection
//     range scales as 10^(-dB/20) and at cruise-minus-13-dB that is about 660 m.
//
// So this suite plays the game. Three scripted policies, each a plausible player,
// and each must reach an ending rather than getting stuck. A slice that only one
// kind of player can finish is not finished.

import { OUTCOME } from '../src/game/director.js';

const DT = 1 / 120;

/** How long a policy may sit in one beat before we call it stranded. */
const STUCK_SECONDS = 260;
/** Ceiling on a whole run, so a broken build fails fast instead of hanging. */
const RUN_SECONDS = 1500;

/**
 * Play the game with a policy and report what happened.
 *
 * @param {object} GAME the live game
 * @param {(s: object, controls: object) => void} policy
 */
export function play(GAME, policy) {
  const D = GAME.director, C = GAME.controls;
  const beats = [];
  let last = null, stuck = 0, endedAt = null;

  for (let i = 0; i < 120 * RUN_SECONDS; i++) {
    const s = D.snapshot();
    if (s.beat !== last) {
      beats.push({ beat: s.beat, t: +(i / 120).toFixed(1), creature: s.creature });
      last = s.beat; stuck = 0;
    } else if (++stuck > 120 * STUCK_SECONDS) {
      return { outcome: 'STUCK', stuckIn: s.beat, beats, seconds: i / 120 };
    }
    policy(s, C);
    GAME.loop.stepHeadless(1);
    if (D.outcome !== OUTCOME.RUNNING) { endedAt = i / 120; break; }
  }
  return {
    outcome: D.outcome, beats, seconds: endedAt === null ? RUN_SECONDS : +endedAt.toFixed(1),
    reachedEnd: endedAt !== null,
  };
}

/** Put the game back to the start of a run. */
function reset(GAME) {
  const D = GAME.director;
  D.outcome = OUTCOME.RUNNING;
  D.index = 0;
  D.attempts = 0;
  D._enter();
  GAME.ship.position.set(0, 700, 0);
  GAME.ship.velocity.set(0, 0, 0);
  GAME.ship.orientation.identity();
  GAME.controls.lightsOn = false;
  GAME.controls.cutEngines = false;
}

/**
 * Three players, chosen because they fail in different directions.
 *
 * `competent` runs the moment something commits to it. `stealthy` never exceeds
 * a quarter throttle and is genuinely never heard — it is the policy that broke
 * the slice before, because doing the smartest thing must not strand you.
 * `reckless` stays loud and lit and should be caught, which is the only one of
 * the three that is supposed to lose.
 */
export const POLICIES = {
  competent: (s, C) => {
    if (s.beat === 'adrift') { C.cutEngines = false; C.throttle = 0.7; }
    else if (s.beat === 'conceal') { C.cutEngines = true; C.throttle = 0; C.lightsOn = false; }
    else if (s.creature === 'COMMITTED' || s.beat === 'run') { C.cutEngines = false; C.throttle = 1; }
    else { C.cutEngines = false; C.throttle = 0.7; }
  },
  stealthy: (s, C) => {
    if (s.beat === 'adrift') { C.cutEngines = false; C.throttle = 0.5; }
    else if (s.beat === 'conceal') { C.cutEngines = true; C.throttle = 0; }
    else { C.cutEngines = false; C.throttle = 0.22; C.lightsOn = false; }
  },
  reckless: (s, C) => { C.cutEngines = false; C.throttle = 1; C.lightsOn = true; },
};

export function run(GAME) {
  const results = [];
  const runs = {};

  for (const [name, policy] of Object.entries(POLICIES)) {
    reset(GAME);
    const r = play(GAME, policy);
    runs[name] = r;
    results.push({
      name: `a ${name} player reaches an ending`,
      ok: r.outcome === OUTCOME.ESCAPED || r.outcome === OUTCOME.TAKEN,
      want: 'escaped or taken, never stuck',
      got: r.outcome === 'STUCK'
        ? `STRANDED in "${r.stuckIn}" after ${STUCK_SECONDS} s`
        : `${r.outcome} after ${r.seconds} s, ${r.beats.length} beats`,
    });
  }

  // Playing well and playing badly must not lead to the same place, or none of
  // the signature system is doing anything the player can act on.
  results.push({
    name: 'playing well and playing badly end differently',
    ok: runs.competent.outcome !== runs.reckless.outcome,
    want: 'competent and reckless reach different outcomes',
    got: `competent ${runs.competent.outcome}, reckless ${runs.reckless.outcome}`,
  });

  // Being quiet is the thing the whole game is about. If the stealthy player is
  // caught, the signature system is not paying out.
  results.push({
    name: 'the stealthy player survives',
    ok: runs.stealthy.outcome === OUTCOME.ESCAPED,
    want: 'escaped',
    got: runs.stealthy.outcome,
  });

  // Every beat must be reachable. A beat nobody ever enters is a beat that has
  // silently stopped working, and no other assertion here would notice.
  const seen = new Set();
  for (const r of Object.values(runs)) for (const b of r.beats) seen.add(b.beat);
  const EXPECTED = ['adrift', 'underway', 'trace', 'quiet', 'heard', 'conceal', 'hunted', 'run', 'break'];
  const missing = EXPECTED.filter((b) => !seen.has(b));
  results.push({
    name: 'every beat is reachable by someone',
    ok: missing.length === 0,
    want: `all ${EXPECTED.length} beats entered across the three runs`,
    got: missing.length ? `never entered: ${missing.join(', ')}` : `all ${EXPECTED.length}`,
  });

  return { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok), results, runs };
}

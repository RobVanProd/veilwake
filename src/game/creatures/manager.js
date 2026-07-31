// The two rules a creature cannot enforce for itself.
//
// A `Creature` can see the medium, the ship's emissions and its own attention.
// It cannot see its peers and it cannot see the simulation budget, so §6's
// one-COMMITTED rule and §8's promotion rule have nowhere to live inside the base
// class. They live here, above it, and `main.js` owns one of these rather than an
// array of creatures.
//
// Both rules are correctness rules rather than optimisations, and both are stated
// that way in the contract:
//
//   §8 — *"The reduced model may never produce a detection... the alternative is
//   being detected by something that was not running the detection code properly,
//   which is unexplainable by construction and therefore violates section 7."*
//
//   §6 — *"at most one creature may be COMMITTED at any time. Two simultaneous
//   committed pursuers produce a situation with no readable solution, which reads
//   as unfair regardless of whether it is."*
//
// Every demotion this file performs writes a `DetectionEvent`, because §7 does
// not carve out an exception for state changes the game engine caused rather than
// the player. A creature that gives up its commitment because another creature
// had a better fix is a thing that happened, and the log has to say so.

import { STATE, SENSE_PERIOD, formatEvent } from './creature.js';

export class CreatureManager {
  /**
   * @param {object}  opts
   * @param {number} [opts.maxFull]     §8: fully simulated creatures, ≤ 6
   * @param {number} [opts.logCapacity] §7: `detectionLog()` returns the last 64
   * @param {number} [opts.promotePeriod] steps between promotion passes
   */
  constructor({ maxFull = 6, logCapacity = 64, promotePeriod = 12 } = {}) {
    this.creatures = [];
    this.maxFull = maxFull;
    this.promotePeriod = promotePeriod;
    this._log = [];
    this._logCapacity = logCapacity;
    this._sink = (ev) => {
      this._log.push(ev);
      if (this._log.length > this._logCapacity) this._log.shift();
    };
    this._order = [];
    this.committed = null;
    this.yields = 0;
  }

  add(creature) {
    // §5.2 staggers senses by creature index, which is what spreads the cost
    // across frames and what *is* the 0–100 ms of sensing latency.
    creature.senseOffset = this.creatures.length % SENSE_PERIOD;
    creature.logSink = this._sink;
    this.creatures.push(creature);
    return creature;
  }

  remove(creature) {
    const i = this.creatures.indexOf(creature);
    if (i >= 0) { creature.logSink = null; this.creatures.splice(i, 1); }
    return this;
  }

  /**
   * One simulation step for the whole roster.
   *
   * `ctx` is passed straight through to the creatures and must carry, at minimum:
   * `{ t, tick, shipPos, medium, signature }`.
   */
  update(dt, tick, ctx) {
    if (tick % this.promotePeriod === 0) this._promote(ctx);
    for (let i = 0; i < this.creatures.length; i++) this.creatures[i].update(dt, tick, ctx);
    this._enforceSingleCommit(ctx);
    return this;
  }

  /**
   * §8. Promotion happens on distance, at 1.4× the creature's longest sense
   * range, so nothing is ever promoted already inside its own hearing — which is
   * how a creature would otherwise appear from nowhere with a detection already
   * in progress.
   *
   * The sort is over the whole roster and runs on the promotion period rather
   * than every step: at 10 Hz with a handful of creatures it is free, and the
   * alternative — promoting on a slow rota — can leave a creature reduced for
   * several frames after it has crossed its own promotion radius.
   */
  _promote(ctx) {
    const ship = ctx.shipPos;
    const list = this._order;
    list.length = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      const dx = c.position.x - ship.x, dy = c.position.y - ship.y, dz = c.position.z - ship.z;
      list.push({ c, d: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }
    list.sort((a, b) => a.d - b.d);

    let full = 0;
    for (let i = 0; i < list.length; i++) {
      const { c, d } = list[i];
      const want = (full < this.maxFull && d <= c.promotionRadius) ? 'full' : 'reduced';
      if (want === 'full') full++;
      if (c.simLevel !== want) {
        const from = c.simLevel;
        c.simLevel = want;
        if (want === 'reduced') {
          // §8: a reduced creature has no senses and no attention. Leaving
          // attention behind would let it resume mid-escalation the moment it
          // came back, which is a detection produced partly by the reduced model.
          c.attention = 0;
          c.estimate = null;
          if (c.state !== STATE.UNAWARE) c.forceState(STATE.UNAWARE, ctx, 'demotion');
        }
        c.logPromotion(ctx, from, want, d);
      }
    }
  }

  /**
   * §6 / §11.1. At most one COMMITTED.
   *
   * The one that keeps it is the one with the most attention, which is the only
   * tie-break that is not arbitrary: it is the creature with the best case for
   * being there. The rest go to SEARCHING — the same landing the state machine
   * uses for losing you, so a yielded creature behaves like one that lost the
   * scent rather than like one that was switched off.
   */
  _enforceSingleCommit(ctx) {
    let best = null;
    let n = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (c.state !== STATE.COMMITTED) continue;
      n++;
      if (!best || c.attention > best.attention) best = c;
    }
    this.committed = best;
    if (n <= 1) return;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (c.state === STATE.COMMITTED && c !== best) {
        c.forceState(STATE.SEARCHING, ctx, 'yield');
        this.yields++;
      }
    }
  }

  /** §7. The last 64 across the whole roster, oldest first. `GAME.detectionLog()`. */
  detectionLog() { return this._log.slice(); }

  /** The same list as sentences. One line per event, per §7. */
  detectionLines() { return this._log.map(formatEvent); }

  fullySimulated() { return this.creatures.filter((c) => c.fullySimulated); }

  snapshot() {
    return {
      creatures: this.creatures.map((c) => c.snapshot()),
      full: this.fullySimulated().length,
      committed: this.committed ? this.committed.id : null,
      yields: this.yields,
      events: this._log.length,
    };
  }
}

// The frame loop.
//
// Fixed-timestep simulation with an interpolated render. This is not ceremony:
// a simulation stepped by the wall clock produces different results on different
// machines and on the same machine under load, which makes a "deterministic
// baseline" a fiction and makes any physics that feeds back on itself unstable
// at low frame rates. Fixing the step and interpolating the presentation is the
// only arrangement where the game plays the same everywhere and still looks
// smooth on a 144 Hz display.

import { Perf } from './perf.js';

export class Loop {
  /**
   * @param {object} opts
   * @param {number} [opts.hz]        simulation rate
   * @param {number} [opts.maxCatchUp] most steps allowed in one frame
   * @param {(dt:number, tick:number)=>void} opts.update
   * @param {(alpha:number, frameMs:number)=>void} opts.render
   */
  constructor({ hz = 120, maxCatchUp = 5, update, render }) {
    this.stepMs = 1000 / hz;
    this.stepSec = 1 / hz;
    this.maxCatchUp = maxCatchUp;
    this.update = update;
    this.render = render;

    this.perf = new Perf();
    this.running = false;
    this.paused = false;
    this.tick = 0;
    this.simTime = 0;

    this._accum = 0;
    this._last = 0;
    this._raf = 0;
    this._frame = this._frame.bind(this);

    /** Set non-zero to run the simulation at a fixed step regardless of the
     *  wall clock — used by the headless smoke test and by capture, where
     *  reproducibility matters more than real time. */
    this.lockedStepsPerFrame = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._accum = 0;
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);

    const frameMs = now - this._last;
    this._last = now;
    this.perf.frame(frameMs);

    if (this.paused) {
      // Still present, so a paused game can render its menu and stay responsive.
      this.perf.begin('render');
      this.render(1, frameMs);
      this.perf.end('render');
      return;
    }

    this.perf.begin('update');
    if (this.lockedStepsPerFrame > 0) {
      for (let i = 0; i < this.lockedStepsPerFrame; i++) {
        this.update(this.stepSec, this.tick++);
        this.simTime += this.stepSec;
      }
      this._accum = 0;
    } else {
      // Clamp the delta before accumulating. A tab that was backgrounded for ten
      // seconds must not try to simulate ten seconds on the frame it returns —
      // that is a multi-second freeze, and it is how a spiral of death starts.
      this._accum += Math.min(frameMs, this.stepMs * this.maxCatchUp);

      let steps = 0;
      while (this._accum >= this.stepMs && steps < this.maxCatchUp) {
        this.update(this.stepSec, this.tick++);
        this.simTime += this.stepSec;
        this._accum -= this.stepMs;
        steps++;
      }
      // Whatever could not be caught up on is discarded rather than carried, so
      // a slow machine runs in slow motion instead of accumulating debt it will
      // pay back as a lurch.
      if (steps >= this.maxCatchUp) this._accum = 0;
    }
    this.perf.end('update');

    this.perf.begin('render');
    this.render(this._accum / this.stepMs, frameMs);
    this.perf.end('render');
  }

  /** Run N simulation steps with no rendering. For tests and warm-up. */
  stepHeadless(steps) {
    for (let i = 0; i < steps; i++) {
      this.update(this.stepSec, this.tick++);
      this.simTime += this.stepSec;
    }
  }
}

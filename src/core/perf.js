// Frame timing.
//
// An average frame rate is the least informative number a game can report: it
// hides exactly the thing players feel, which is the occasional frame that takes
// four times as long as its neighbours. Everything here is about the tail.
//
// Budgets are declared, not discovered. A number without a budget beside it is
// a number nobody will ever act on.

/**
 * Budgets for VEILWAKE. Everything is milliseconds.
 *
 * Target is 60 Hz at 1080p on the development machine (Ryzen 7 5700, RX 7800
 * XT). These are deliberately tighter than "whatever runs", because the whole
 * game is a volumetric ray march and a ray march will happily consume any budget
 * it is given — the step count has to be answerable to a number rather than to
 * how it looks in a still.
 *
 * The p99 and hitch figures matter more here than in most games. This is a slow,
 * quiet game about listening for something enormous; a stutter at the moment a
 * creature passes is not a performance problem, it is a broken scare.
 */
export const BUDGET = {
  frameMedian: 16.7,
  frameP95: 20.0,
  frameP99: 25.0,
  hitch: 45.0,      // one bad frame during an encounter ruins the encounter
  update: 3.0,      // simulation, creature AI, flight model
  render: 11.0,     // everything drawn, volumetrics included
  volumetric: 7.0,  // the cloud march alone, half-res
  shaderCompile: 1200,
  startup: 3000,
};

export class Perf {
  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.frames = new Float32Array(capacity);
    this.count = 0;
    this.head = 0;

    this.updateMs = 0;
    this.renderMs = 0;
    this.hitches = 0;
    this.totalFrames = 0;

    // Marks let a subsystem report its own cost without a global profiler.
    this.marks = new Map();
    this._open = new Map();
  }

  begin(name) {
    this._open.set(name, performance.now());
  }

  end(name) {
    const t0 = this._open.get(name);
    if (t0 === undefined) return 0;
    this._open.delete(name);
    const dt = performance.now() - t0;
    // Exponential average: one bad frame should be visible but not dominant.
    const prev = this.marks.get(name) ?? dt;
    this.marks.set(name, prev + (dt - prev) * 0.1);
    return dt;
  }

  /** Record one presented frame. */
  frame(ms) {
    this.frames[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.totalFrames++;
    if (ms >= BUDGET.hitch) this.hitches++;
  }

  /** Sorted copy of the window. Only called when stats are actually wanted. */
  _sorted() {
    const out = Array.prototype.slice.call(this.frames, 0, this.count);
    out.sort((a, b) => a - b);
    return out;
  }

  percentile(p) {
    if (this.count === 0) return 0;
    const s = this._sorted();
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }

  stats() {
    if (this.count === 0) {
      return { median: 0, p95: 0, p99: 0, worst: 0, fps: 0, hitches: 0, frames: 0 };
    }
    const s = this._sorted();
    const at = (p) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
    const median = at(50);
    return {
      median,
      p95: at(95),
      p99: at(99),
      worst: s[s.length - 1],
      fps: median > 0 ? 1000 / median : 0,
      hitches: this.hitches,
      frames: this.totalFrames,
    };
  }

  /** Every budget that is currently being missed. Empty means healthy. */
  violations() {
    const s = this.stats();
    const out = [];
    if (s.median > BUDGET.frameMedian) out.push(`median ${s.median.toFixed(1)}ms > ${BUDGET.frameMedian}`);
    if (s.p95 > BUDGET.frameP95) out.push(`p95 ${s.p95.toFixed(1)}ms > ${BUDGET.frameP95}`);
    if (s.p99 > BUDGET.frameP99) out.push(`p99 ${s.p99.toFixed(1)}ms > ${BUDGET.frameP99}`);
    if (this.hitches > 0) out.push(`${this.hitches} hitch(es) over ${BUDGET.hitch}ms`);
    return out;
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.hitches = 0;
    this.totalFrames = 0;
    this.marks.clear();
  }
}

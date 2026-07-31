// The audio engine: the plumbing underneath the score and the creature voices.
//
// Nothing in this file decides *what* is heard. `music.js` decides which eight
// seconds of the score should be playing and how loud silence should be;
// `language.js` decides what a creature sounds like at 900 m through dense
// cloud. This file is what both of them are plugged into — the mix graph, the
// gesture that is legally allowed to start it, the bytes, and the ducking that
// keeps the two out of each other's way.
//
// It extends `core/audio.js` rather than replacing it. That class already owns
// the synthesis primitives the whole creature language is built from (tone,
// noise, drone, reverb) and its `buses.sfx` is where `AudioLanguage.attach`
// hangs every voice. Re-implementing the graph next to it would have produced
// two AudioContexts, two limiters, and a game whose creature calls and score
// could not duck each other because they were in different graphs.
//
// The header comment in core/audio.js says there are no audio files in this
// project. That was true when it was written and is no longer: 46 authored
// mp3s live in assets/music. The synthesis is still the right answer for
// anything that has to be a continuous function of game state — this engine
// adds file playback alongside it, it does not replace it.

import { Audio } from '../core/audio.js';

/**
 * What the mixer is doing, in the terms a menu needs to phrase it.
 *
 * `IDLE` is the one that matters: every browser refuses to start an
 * AudioContext until the user has interacted with the page, and a game that
 * simply comes up silent is indistinguishable from one that is broken. The UI
 * is expected to read this and say "click to enable sound" rather than let the
 * player conclude the audio does not work.
 */
export const AUDIO_STATE = Object.freeze({
  UNSUPPORTED: 'unsupported',  // no WebAudio at all
  IDLE: 'idle',                // built or buildable, waiting for a gesture
  RUNNING: 'running',
  SUSPENDED: 'suspended',      // was running; tab hidden, or resume() lost a race
});

/** Every event that counts as the user touching the page. */
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchstart', 'touchend'];

export class AudioEngine extends Audio {
  constructor({ cacheTracks = 4, cacheBytes = 48 * 1024 * 1024 } = {}) {
    super();
    this._state = AUDIO_STATE.IDLE;
    this._stateListeners = new Set();
    this._graphExtended = false;
    this._armed = false;

    /** bus name -> { gain node between the bus and master, active requests }. */
    this.ducks = {};
    this._duckReq = { music: new Map(), sfx: new Map(), ui: new Map() };

    this.tracks = new TrackCache({ limit: cacheTracks, maxBytes: cacheBytes });

    this._armGestures();
    // If the page has already been interacted with — a reload after a click, or
    // a browser that grants autoplay — this succeeds immediately and the player
    // never sees the prompt. If it does not, nothing is lost: the graph is only
    // built when the context can actually run.
    this.start();
  }

  // -------------------------------------------------------------------------
  // Starting, which is mostly a fight with autoplay policy
  // -------------------------------------------------------------------------

  /**
   * Deliberately empty; `_armGestures` replaces it.
   *
   * The base class arms the same three events but unhooks them inside the first
   * handler, whether or not the context actually reached 'running'. On a first
   * `keydown` in a background tab, or when `resume()` rejects, that spends the
   * one chance the page had and the game is silent for the rest of the session.
   * This override runs from the base constructor, before any field of this class
   * exists, so it must touch nothing.
   */
  _arm() { /* see _armGestures */ }

  _armGestures() {
    if (this._armed) return;
    this._armed = true;

    const onGesture = () => {
      this.start();
      // Only stop listening once it is genuinely running. Anything else and we
      // have thrown away the retry.
      if (this._state === AUDIO_STATE.RUNNING || this._state === AUDIO_STATE.UNSUPPORTED) {
        for (const ev of GESTURES) removeEventListener(ev, onGesture, true);
      }
    };
    // Capture phase: the game canvas calls preventDefault on pointer events for
    // flight control, and a listener on the bubble phase behind a stopped event
    // never runs.
    for (const ev of GESTURES) addEventListener(ev, onGesture, true);

    // Chrome suspends the context when the tab is hidden and does not always
    // resume it on return. Without this the audio dies the first time the player
    // alt-tabs, which reads as a crash.
    addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => this._syncState(), () => this._syncState());
      }
    });
  }

  /** Safe to call as often as you like. Only the first call builds anything. */
  start() {
    const first = !this.started;
    super.start();

    if (!this.started || !this.ctx) { this._setState(AUDIO_STATE.UNSUPPORTED); return; }
    if (first) {
      this._extendGraph();
      this.ctx.onstatechange = () => this._syncState();
    }
    if (this.ctx.state !== 'running') {
      // resume() returns a promise that rejects when there was no gesture. The
      // rejection is expected and is not an error worth logging every click.
      this.ctx.resume().then(() => this._syncState(), () => this._syncState());
    }
    this._syncState();
  }

  /**
   * Insert one gain per bus between the bus and the master.
   *
   * Ducking has to happen somewhere other than the bus gain itself, because the
   * bus gain is the player's volume slider. The base class's `duck()` ramps the
   * slider down and back up to `volumes[bus]`, which means a duck that overlaps
   * a volume change snaps the level, and two overlapping ducks each restore full
   * volume when they end — the second one un-ducks the first. A separate node
   * multiplies instead, so the slider and the duck are independent and the duck
   * can be the deepest of several concurrent requests.
   */
  _extendGraph() {
    if (this._graphExtended) return;
    const ctx = this.ctx;
    for (const name of Object.keys(this.buses)) {
      const bus = this.buses[name];
      const duck = ctx.createGain();
      duck.gain.value = 1;
      bus.disconnect();              // base connected it straight to master
      bus.connect(duck);
      duck.connect(this.master);
      this.ducks[name] = duck;
      if (!this._duckReq[name]) this._duckReq[name] = new Map();
    }

    // A meter on the output of the limiter. This exists for two reasons that are
    // both about verification rather than the player: a UI level indicator, and
    // an answer to "is anything actually coming out" that does not require
    // someone to listen. `fftSize` is the minimum — this is an RMS probe, not a
    // spectrum display, and a larger window only costs time.
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 256;
    this.meter.smoothingTimeConstant = 0;
    this._meterBuf = new Float32Array(this.meter.fftSize);
    this.limiter.connect(this.meter);   // a tap: the analyser has no output

    this._graphExtended = true;
  }

  _syncState() {
    if (!this.enabled) return this._setState(AUDIO_STATE.UNSUPPORTED);
    if (!this.ctx) return this._setState(AUDIO_STATE.IDLE);
    if (this.ctx.state === 'running') return this._setState(AUDIO_STATE.RUNNING);
    // 'suspended' before the graph has ever run is just "waiting for a click";
    // after it has run it is a real suspension the UI may want to report.
    return this._setState(this._everRan ? AUDIO_STATE.SUSPENDED : AUDIO_STATE.IDLE);
  }

  _setState(s) {
    if (s === AUDIO_STATE.RUNNING) this._everRan = true;
    if (s === this._state) return;
    this._state = s;
    for (const fn of this._stateListeners) { try { fn(s, this); } catch { /* a listener must not break audio */ } }
  }

  get state() { return this._state; }
  /** True when the UI should be showing "click to enable sound". */
  get needsGesture() { return this._state === AUDIO_STATE.IDLE; }
  get running() { return this._state === AUDIO_STATE.RUNNING; }

  /** @returns {() => void} an unsubscribe function. */
  onState(fn) {
    this._stateListeners.add(fn);
    fn(this._state, this);
    return () => this._stateListeners.delete(fn);
  }

  // -------------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------------

  /** What an options screen needs to build itself, without knowing this file. */
  mixerChannels() {
    return [
      { key: 'master', label: 'Master', value: this.volumes.master },
      { key: 'music', label: 'Score', value: this.volumes.music },
      { key: 'sfx', label: 'World', value: this.volumes.sfx },
      { key: 'ui', label: 'Interface', value: this.volumes.ui },
    ];
  }

  /**
   * Output level in dBFS, or -120 when there is no signal.
   *
   * Peak rather than RMS of the whole buffer would be dominated by the limiter's
   * attack; this is the honest continuous level, and it is what the tests read
   * to assert that the game is not silent.
   */
  levelDb() {
    if (!this.meter) return -120;
    this.meter.getFloatTimeDomainData(this._meterBuf);
    let sum = 0;
    for (let i = 0; i < this._meterBuf.length; i++) sum += this._meterBuf[i] * this._meterBuf[i];
    const rms = Math.sqrt(sum / this._meterBuf.length);
    return rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }

  // -------------------------------------------------------------------------
  // Ducking
  // -------------------------------------------------------------------------

  /**
   * Hold a bus down for as long as the caller keeps asking.
   *
   * `depth` is the fraction taken *off*: 0.45 means the bus plays at 55%. That
   * is the reading the creature layer wants — `lantern.js` publishes
   * `duckMusic: 0.45` for its crackle at COMMITTED, and a crackle is a small
   * bright event that needs the score out of the way, not annihilated.
   *
   * Requests are keyed and the deepest one wins, so a Lantern crackling while a
   * discharge is ducking does not produce two independent ramps fighting over
   * one parameter.
   */
  setDuck(bus, key, depth = 0, { attack = 0.03, release = 0.35 } = {}) {
    const reqs = this._duckReq[bus];
    if (!reqs) return;
    const d = depth > 0 ? Math.min(depth, 0.95) : 0;
    const prev = reqs.get(key);
    if (d <= 0) {
      if (!prev) return;
      reqs.delete(key);
    } else if (prev && prev.depth === d && prev.until === Infinity) {
      return;                                    // unchanged; do not re-ramp
    } else {
      reqs.set(key, { depth: d, until: Infinity, attack, release });
    }
    this._applyDuck(bus);
  }

  /**
   * A one-shot duck, in the base class's signature so `language.js` keeps
   * working unchanged: `a.duck('music', 0.25, 0.5, 1.6)` for the storm
   * discharge. Note the different convention — here `amount` is the multiplier
   * that survives, not the fraction removed. That is the base class's meaning
   * and there is one caller of it in the tree; changing it silently would have
   * been worse than the inconsistency.
   */
  duck(bus, amount = 0.5, hold = 0.12, release = 0.35) {
    const reqs = this._duckReq[bus];
    if (!reqs || !this.ctx) return;
    const key = `one:${this._duckSeq = (this._duckSeq || 0) + 1}`;
    reqs.set(key, {
      depth: 1 - Math.max(0, Math.min(1, amount)),
      until: this.ctx.currentTime + hold,
      attack: 0.012,                              // a stinger's duck must precede it
      release,
    });
    this._applyDuck(bus);
    // Expire on a timer as well as in update(). Belt and braces, and both are
    // needed: a caller that forgets update() would otherwise leave the score
    // ducked for the rest of the session (measured — the music stayed at 25%
    // indefinitely), while background tabs clamp timers to once a second, which
    // update() covers. Whichever fires first removes the request; the other
    // finds it already gone.
    setTimeout(() => {
      if (reqs.delete(key)) this._applyDuck(bus);
    }, Math.max(0, hold * 1000) + 20);
  }

  _applyDuck(bus) {
    const node = this.ducks[bus];
    if (!node || !this.ctx) return;
    let deepest = 0;
    let attack = 0.03, release = 0.35;
    for (const r of this._duckReq[bus].values()) {
      if (r.depth > deepest) { deepest = r.depth; attack = r.attack; release = r.release; }
    }
    const target = 1 - deepest;
    const t = this.ctx.currentTime;
    // setTargetAtTime reaches ~95% in 3 tau, so the tau is a third of the time
    // the duck is allowed to take. Attack is short because the sound that asked
    // for the duck is starting on this same frame; release is long because a
    // Lantern crackles repeatedly and a fast recovery pumps the whole score.
    const tau = Math.max(1e-3, (target < node.gain.value ? attack : release) / 3);
    node.gain.setTargetAtTime(target, t, tau);
  }

  /** Expire one-shot ducks. Cheap; call every frame. */
  update() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const bus of Object.keys(this._duckReq)) {
      const reqs = this._duckReq[bus];
      let changed = false;
      for (const [k, r] of reqs) {
        if (r.until !== Infinity && t >= r.until) { reqs.delete(k); changed = true; }
      }
      if (changed) this._applyDuck(bus);
    }
  }

  /** For diagnostics: how far each bus is currently pulled down, 0..1. */
  duckDepths() {
    const out = {};
    for (const [name, node] of Object.entries(this.ducks)) out[name] = +(1 - node.gain.value).toFixed(3);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Track bytes
// ---------------------------------------------------------------------------

/**
 * A small LRU of whole music files, held as blobs.
 *
 * Two facts about this project force this design, and both of them were checked
 * rather than assumed.
 *
 * 1. **The dev server sends `Cache-Control: no-store`** (tools/serve.py, and for
 *    a good reason — a cached ES module means debugging a file you already
 *    fixed). So warming the *HTTP* cache does nothing: every `el.src = ...`
 *    would re-download four megabytes, and a crossfade would begin with a
 *    network stall.
 * 2. **It does not implement Range requests** — `SimpleHTTPRequestHandler` never
 *    answers 206. The music director selects an eight-second *window* and sets
 *    `el.currentTime` to reach it, and an element streaming from a server with
 *    no Range support can only seek inside what it has already buffered. The
 *    seek would be silently ignored and the director would appear to work while
 *    always playing from the top of the file.
 *
 * A blob URL fixes both: the resource is local and fully seekable the moment
 * metadata parses. The cost is holding compressed bytes in memory — about 4.5 MB
 * per track, so the default limit of four is ~18 MB. Decoding to AudioBuffers
 * instead would be roughly 100 MB *per track* of float PCM, which is why
 * music.js streams through media elements in the first place.
 *
 * Eviction never touches a pinned entry, because revoking an object URL that a
 * playing element may still re-read (a seek, a loop) breaks it mid-cue.
 */
export class TrackCache {
  constructor({ limit = 4, maxBytes = 48 * 1024 * 1024, onEvict = null } = {}) {
    this.limit = limit;
    this.maxBytes = maxBytes;
    /**
     * Called with the source URL the moment its blob is revoked.
     *
     * Not optional decoration. Whoever handed the blob URL to a consumer has to
     * be told, or that consumer is left holding a revoked URL that loads as an
     * empty resource — silently, with no error and no sound. In this game that
     * consumer is the music index, and the failure would look like one track in
     * forty-six that mysteriously plays nothing.
     */
    this.onEvict = onEvict;
    this.entries = new Map();     // url -> { objectURL, bytes, used, pins }
    this.pending = new Map();     // url -> Promise<string>
    this.bytes = 0;
    this.fetched = 0;
    this._clock = 0;
  }

  /** The blob URL for a source, or null if it is not resident yet. */
  urlFor(src) {
    const e = this.entries.get(src);
    if (!e) return null;
    e.used = ++this._clock;
    return e.objectURL;
  }

  has(src) { return this.entries.has(src); }

  /**
   * Fetch and hold a track. Idempotent, and concurrent calls share one request —
   * without the pending map, a director that wants the same track twice in one
   * second downloads it twice.
   */
  load(src) {
    const hit = this.entries.get(src);
    if (hit) { hit.used = ++this._clock; return Promise.resolve(hit.objectURL); }
    const inflight = this.pending.get(src);
    if (inflight) return inflight;

    const p = fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`${src}: ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const objectURL = URL.createObjectURL(blob);
        this.entries.set(src, { objectURL, bytes: blob.size, used: ++this._clock, pins: 0 });
        this.bytes += blob.size;
        this.fetched++;
        this.pending.delete(src);
        this._evict();
        return objectURL;
      })
      .catch((err) => {
        this.pending.delete(src);
        // A missing track must not take the frame down. The director will keep
        // its http URL and stream it, degraded but audible.
        console.warn('[audio] track load failed', src, err && err.message);
        return null;
      });

    this.pending.set(src, p);
    return p;
  }

  pin(src) { const e = this.entries.get(src); if (e) { e.pins++; e.used = ++this._clock; } }
  unpin(src) { const e = this.entries.get(src); if (e && e.pins > 0) e.pins--; }

  /** Drop every pin, so the next _evict can reconsider all of them. */
  unpinAll() { for (const e of this.entries.values()) e.pins = 0; }

  _evict() {
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      let victim = null, oldest = Infinity;
      for (const [src, e] of this.entries) {
        if (e.pins > 0) continue;
        if (e.used < oldest) { oldest = e.used; victim = src; }
      }
      if (!victim) return;               // everything resident is in use
      const e = this.entries.get(victim);
      this.entries.delete(victim);
      this.bytes -= e.bytes;
      // Tell the consumer *before* revoking, so it can stop pointing at the URL
      // while the URL is still valid.
      if (this.onEvict) { try { this.onEvict(victim); } catch { /* never break the cache */ } }
      URL.revokeObjectURL(e.objectURL);
    }
  }

  stats() {
    return {
      resident: this.entries.size,
      pinned: [...this.entries.values()].filter((e) => e.pins > 0).length,
      megabytes: +(this.bytes / 1048576).toFixed(1),
      fetched: this.fetched,
      inflight: this.pending.size,
    };
  }

  dispose() {
    for (const e of this.entries.values()) URL.revokeObjectURL(e.objectURL);
    this.entries.clear();
    this.bytes = 0;
  }
}

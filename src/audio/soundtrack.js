// The soundtrack: one object that turns a frame of game state into sound.
//
// Three finished pieces already existed and none of them were connected to
// anything:
//
//   music.js     — the director. 46 authored tracks, indexed as 2091 eight-second
//                  windows, chosen by a threat model rather than by cue name.
//   music.js     — BedLayers. Three thin loops that stack over any cue.
//   language.js  — the creature voice synthesis, the ship, the cloud ambience.
//
// This file is the wiring, and deliberately nothing else. It does not decide
// what the score should be doing — `weightsFor` and `gainFor` in music.js
// already do, and they are measured. What it does is: keep the director's bytes
// resident before it needs them, repair the one place where streaming media
// silently ignores the director's decision, translate a frame of the game into
// the two state shapes the two subsystems ask for, and duck the score when a
// creature speaks.
//
// GOTCHA, recorded because it will catch the next person: inside this directory
// `new Audio(...)` means the HTMLAudioElement constructor, and music.js relies
// on that. Do NOT `import { Audio } from '../core/audio.js'` here — it shadows
// the global and turns every media element into a mixer.

import { MusicDirector, BedLayers, weightsFor, gainFor } from './music.js';
import { AudioLanguage, idleState } from './language.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * The director's own lead-in, duplicated here.
 *
 * `MusicDirector._crossfadeTo` starts playback `min(2, t)` seconds before the
 * window it chose, so the crossfade lands inside the window rather than at its
 * edge. `_repairSeek` below has to know where the playhead was *meant* to be, so
 * it needs the same number. If music.js ever changes it, this is the other copy.
 */
const CUE_LEAD_S = 2.0;

export class Soundtrack {
  /**
   * @param {import('./engine.js').AudioEngine} engine
   */
  constructor(engine, {
    indexUrl = 'assets/music_index.json',
    prefetch = 2,
    beds = true,
    language = true,
  } = {}) {
    this.engine = engine;
    this.director = new MusicDirector(engine, { indexUrl });
    this.beds = beds ? new BedLayers(engine) : null;
    this.language = language ? new AudioLanguage() : null;

    this.prefetch = prefetch;
    this.enabled = true;
    this.ready = false;
    this.error = null;

    /** The original http URLs, kept so a track can fall back to streaming. */
    this._httpSrc = [];
    this._rankAt = -1e9;
    this._rankWeights = null;
    this._ranked = [];
    this._seenCue = null;
    /** Cues that landed somewhere other than where the director asked. */
    this.seekFailures = 0;
    this.lastSeekFailure = null;
    this._waitSince = null;
    this._gateSaved = null;
    this._world = defaultWorld();

    // The moment the context genuinely starts, let the director pick again on
    // the next update instead of waiting out its 22-second hold. Without this,
    // clicking to enable sound is followed by up to 22 seconds of nothing, which
    // every tester reads as "the button did not work".
    this._unsub = engine.onState((s) => {
      if (s === 'running') {
        this.director.lastSwitch = -1e9;
        if (this.ready) this._rank(0, true);
      }
    });
  }

  /** Load the segment index. Cheap — 90 KB of JSON, no audio touched. */
  async load() {
    try {
      await this.director.load();
      this._httpSrc = this.director.index.tracks.map((t) => t.src);
      this._trackByHttp = new Map(this._httpSrc.map((src, i) => [src, i]));
      // When the cache drops a track, put its http URL back in the index in the
      // same tick. Leave the blob URL there and the director will one day set
      // `el.src` to a revoked blob, which loads as an empty resource: no error,
      // no sound, and a bug that only appears after the fifth distinct track of
      // a session.
      this.engine.tracks.onEvict = (src) => {
        const ti = this._trackByHttp.get(src);
        if (ti !== undefined) this.director.index.tracks[ti].src = src;
      };
      this.ready = true;
      // Fetch what an unthreatened opening will want, before the player has
      // clicked anything. This is the only prefetch that happens off the back of
      // a guess rather than the live threat model, and it is worth it: the first
      // cue is the one the player is most likely to notice arriving late.
      this._rank(0, true);
    } catch (err) {
      this.error = err;
      this.ready = false;
      console.warn('[audio] music index failed to load:', err.message);
    }
    return this.ready;
  }

  /** Attach the creature/ship/ambience synthesis. Needs a running context. */
  attachLanguage() {
    if (!this.language || this.language.attached) return false;
    return this.language.attach(this.engine);
  }

  /**
   * One frame.
   *
   * @param {number} dt seconds
   * @param {number} now monotonic seconds — pass the sim clock, not wall time,
   *        so that a headless seek advances the score along with everything else
   * @param {object} world  see `readWorld`
   * @param {object} [langState] see `readLanguageState`; omit to leave the
   *        creature voices idle
   */
  update(dt, now, world, langState = null) {
    this.engine.update(dt);
    if (!this.engine.running || !this.enabled) return;

    if (world) this._world = world;
    const w = this._world;

    // The creature voices and the cloud ambience. Done before the music so that
    // a duck requested this frame is already in the graph when the cue level is
    // set below.
    if (this.language) {
      if (!this.language.attached) this.attachLanguage();
      if (this.language.attached && langState) this.language.update(dt, langState);
    }

    if (this.ready) {
      this.director.setState(w.threat);
      this._rank(now, false);
      this._gateSwitch(now);
      this.director.update(dt, now);
      this._repairSeek();
    }

    if (this.beds) this.beds.update(w.beds, dt);
  }

  /**
   * Duck the score under a creature.
   *
   * `lantern.js` publishes `duckMusic` from `voiceState()` — 0.45 while it is
   * crackling at COMMITTED, because at that range the crackle is the only cue
   * the player gets and it lives in the same band as the score's high strings.
   * The value is a *depth*: 0.45 leaves the music at 55%.
   *
   * Every creature is polled rather than only the Lantern, so an archetype that
   * grows a voice later needs no change here — it publishes the field and it
   * ducks.
   */
  duckFromCreatures(creatures) {
    if (!creatures) return 0;
    const list = creatures.creatures || creatures;
    let deepest = 0;
    for (const c of list) {
      if (!c || typeof c.voiceState !== 'function') continue;
      const d = c.voiceState().duckMusic || 0;
      if (d > deepest) deepest = d;
    }
    this.engine.setDuck('music', 'creature', deepest);
    return deepest;
  }

  // -------------------------------------------------------------------------
  // Bytes
  // -------------------------------------------------------------------------

  /**
   * Rank tracks by how well their *best* window matches the current blend, and
   * make the top few resident.
   *
   * This deliberately re-implements the scoring instead of calling the
   * director's `_bestSegment`, because it wants a different answer: the director
   * needs the single best window and biases towards staying where it is, while
   * the cache needs the handful of *files* any near-future decision could land
   * in. Reaching into a private method for a different question would have
   * coupled the two and produced a worse cache.
   *
   * Throttled two ways, and the second one is not optional. Time alone was the
   * first version and it was wrong: `load()` ranks against the default state
   * (drift), the game's first `update` then sets a real threat model, and a
   * 1.5-second timer skipped the re-rank — so the opening cue was chosen from a
   * blend nothing had prefetched for, and it streamed over http. Measured: the
   * director asked for vw_17 while the cache held vw_21 and vw_06. So a blend
   * that has moved is a re-rank regardless of the clock.
   *
   * 0.12 is an L1 distance over five weights that each sum to 1, i.e. about 6%
   * of the blend having moved from one role to another. Smaller and it re-ranks
   * on noise; larger and a slow slide into pursuit is not prefetched until it
   * has already happened.
   */
  _rank(now, force) {
    const w = weightsFor(this.director.state);
    if (!force) {
      let moved = 0;
      if (this._rankWeights) {
        for (const k of Object.keys(w)) moved += Math.abs(w[k] - this._rankWeights[k]);
      } else moved = 99;
      if (moved < 0.12 && now - this._rankAt < 1.5) return;
    }
    this._rankAt = now;
    this._rankWeights = w;

    const tracks = this.director.index.tracks;
    const scores = new Array(tracks.length);
    for (let ti = 0; ti < tracks.length; ti++) {
      const seg = tracks[ti].seg;
      let best = -1;
      for (let si = 0; si < seg.length; si++) {
        const s = seg[si];
        const m = w.drift * s[1] + w.unease * s[2] + w.pursuit * s[3] + w.conceal * s[4] + w.awe * s[5];
        if (m > best) best = m;
      }
      scores[ti] = best;
    }
    this._ranked = scores
      .map((score, ti) => ({ ti, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.prefetch)
      .map((e) => e.ti);

    const cache = this.engine.tracks;
    // Repin from scratch each pass: the only thing that must never be evicted is
    // what a voice is playing right now, plus the current candidates.
    cache.unpinAll();
    const keep = new Set(this._ranked);
    if (this.director.current) keep.add(this.director.current.trackIndex);
    for (const v of this.director.voices) if (v.track !== null) keep.add(v.track);

    for (const ti of keep) {
      const http = this._httpSrc[ti];
      if (!http) continue;
      cache.pin(http);
      if (cache.has(http)) this._useBlob(ti);
      else cache.load(http).then((url) => { if (url) this._useBlob(ti); });
    }
  }

  /**
   * Hold a switch back until the bytes it needs are here.
   *
   * Prefetching cannot help when the threat model changes all at once, which is
   * exactly when the score most needs to move: the blend flips to pursuit, the
   * re-rank starts a 4.5 MB download, and the director — free to switch,
   * because its 22-second hold expired long ago — crossfades in the same frame.
   * Measured: it chose vw_08 @ 156 s, streamed it over http, and landed at 1 s.
   * The right material, the wrong two minutes of it, and no complaint from
   * anything.
   *
   * So the switch waits for residency. It is a *deferral*, not a skip: the
   * director still runs every frame, so the level keeps tracking `gainFor`, and
   * whatever was playing keeps playing. The player hears the transition arrive
   * about a second late rather than arriving in the wrong place.
   *
   * `lastSwitch` is saved and restored rather than left where the deferral put
   * it. Setting it to `now` is what makes MusicDirector.update return early —
   * but leaving it there would then impose the full 22-second hold from the
   * moment the wait ended, which for the very first cue means 22 seconds of
   * silence at the start of the game.
   */
  _gateSwitch(now) {
    const ti = this._ranked[0];
    const resident = ti === undefined || this.engine.tracks.has(this._httpSrc[ti]);

    if (resident) {
      this._waitSince = null;
    } else {
      if (this._waitSince === null) this._waitSince = now;
      // A cap, because a download that fails or stalls must not mean a game
      // with no music. Three seconds is several times what a local file takes
      // and short enough to pass as musical timing; the first cue gets longer
      // because nothing is covering it and there is no wrong-window risk worth
      // trading a silent opening for.
      const limit = this.director.current ? 3 : 6;
      if (now - this._waitSince > limit) this._waitSince = null;
    }

    if (this._waitSince !== null) {
      if (this._gateSaved === null) this._gateSaved = this.director.lastSwitch;
      this.director.lastSwitch = now;
    } else if (this._gateSaved !== null) {
      this.director.lastSwitch = this._gateSaved;   // as though it had never been held
      this._gateSaved = null;
    }
  }

  /**
   * Point the index entry at the resident copy.
   *
   * The director reads `index.tracks[i].src` at the moment it crossfades, so
   * swapping it here is enough — no change to music.js, and a track that failed
   * to download keeps its http URL and streams instead.
   */
  _useBlob(ti) {
    const http = this._httpSrc[ti];
    const blob = this.engine.tracks.urlFor(http);
    if (blob) this.director.index.tracks[ti].src = blob;
  }

  /**
   * Put the playhead where the director asked for it.
   *
   * `_crossfadeTo` sets `el.currentTime` immediately after assigning `el.src`,
   * inside a try/catch. At that instant the element has no metadata and no
   * duration, so the assignment is either thrown away or clamped to 0 — the
   * director believes it is playing a window 140 seconds into vw_25 and is in
   * fact playing the opening of it. Nothing reports this: the music plays, the
   * readout says the right thing, and the selection is silently inert.
   *
   * So: notice the cue change, and if the seek did not take, redo it as soon as
   * metadata arrives. The fade-in is six seconds and the repair lands within a
   * few tens of milliseconds of the start, at a gain still near zero, so the
   * jump is inaudible.
   *
   * The one-second tolerance is loose on purpose. Media elements do not seek to
   * exactly the requested time — mp3 frames are ~26 ms and the browser rounds to
   * a frame boundary — and re-seeking because of that error would loop forever.
   *
   * This cannot rescue a track that is streaming over http, and it does not
   * pretend to. Measured on this dev server: setting `currentTime = 140` on an
   * element sourced from a URL reads back 140 immediately, and once metadata
   * arrives it is 0 with `seekable.end(0) === 0` — the seek is accepted, then
   * silently discarded, on any offset outside what is already buffered. That is
   * what `seekFailures` counts, and it is the number that says the cache is not
   * keeping up rather than that the music is fine.
   */
  _repairSeek() {
    const cue = this.director.current;
    if (!cue || cue === this._seenCue) return;
    this._seenCue = cue;

    const voice = this.director.voices[this.director.active];
    if (!voice) return;
    const el = voice.el;
    const want = Math.max(0, cue.t - Math.min(CUE_LEAD_S, cue.t));
    if (want < 0.5) return;                     // the top of the file is the top of the file

    const apply = () => {
      try {
        if (Math.abs(el.currentTime - want) > 1.0) el.currentTime = want;
      } catch { /* still not seekable; the cue plays from wherever it is */ }
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });

    // Check the claim rather than trusting it. 900 ms is comfortably past the
    // point where a local blob has parsed its metadata and seeked, and still
    // early enough in the six-second fade that the readout describes the cue the
    // player is hearing.
    setTimeout(() => {
      if (this.director.current !== cue) return;      // already moved on
      const drift = Math.abs(el.currentTime - want);
      if (drift > 2.5 + 0.9) {                        // 0.9 s of legitimate playback
        this.seekFailures++;
        this.lastSeekFailure = `${this._httpSrc[cue.trackIndex]} wanted ${want.toFixed(0)}s, at ${el.currentTime.toFixed(0)}s`;
      }
    }, 900);
  }

  // -------------------------------------------------------------------------

  /** Everything a diagnostics overlay or a test wants, in one object. */
  readout() {
    const d = this.ready ? this.director.readout() : { ready: false };
    // The director names the track from the URL it is playing, which is a blob
    // once the cache has it — a readout that says `b216e466-2aeb-…` instead of
    // `vw_08.mp3` is the diagnostic quietly ceasing to be one.
    const cur = this.ready ? this.director.current : null;
    if (cur && this._httpSrc[cur.trackIndex]) d.track = this._httpSrc[cur.trackIndex].split('/').pop();
    return {
      state: this.engine.state,
      levelDb: +this.engine.levelDb().toFixed(1),
      music: d,
      duck: this.engine.duckDepths(),
      cache: this.engine.tracks.stats(),
      beds: this.beds ? this.beds.started : false,
      language: this.language ? this.language.attached : false,
      seekFailures: this.seekFailures,
      lastSeekFailure: this.lastSeekFailure,
      error: this.error ? this.error.message : null,
    };
  }

  stop(fade = 2.0) {
    if (this.ready) this.director.stop(fade);
    if (this.beds) this.beds.stop(fade);
  }

  dispose() {
    this.stop(0.2);
    if (this.language && this.language.attached) this.language.detach();
    if (this._unsub) this._unsub();
    this.engine.tracks.onEvict = null;   // it closes over this instance's index
    this.engine.tracks.dispose();
  }
}

// ---------------------------------------------------------------------------
// Reading the game
//
// Both subsystems want a described state rather than the game's objects, which
// is right — it is what lets them be tested without a world. These two functions
// are the only place that knows the game's field names, and they are written to
// survive a missing one, because audio must never be the reason a frame throws.
// ---------------------------------------------------------------------------

function defaultWorld() {
  return {
    threat: { certainty: 0, detected: 0, hiding: 0, escaping: 0, safety: 1, damage: 0, wonder: 0 },
    beds: { depth: 0.3, shipActivity: 0, damage: 0, wonder: 0, altitude: 0 },
    nearest: Infinity,
  };
}

/**
 * The threat model, from the frame the game just simulated.
 *
 * @param {object} game  anything with { ship, systems, creatures, clouds }
 * @param {object} [out] reused across frames; this runs every frame and should
 *                       not allocate
 */
export function readWorld(game, out = defaultWorld()) {
  const ship = game.ship || null;
  const systems = game.systems || null;
  const list = game.creatures ? (game.creatures.creatures || []) : [];
  const p = ship && ship.position ? ship.position : null;

  let certainty = 0, detected = 0, nearest = Infinity;
  for (const c of list) {
    if (!c || !c.position || !p) continue;
    const dx = c.position.x - p.x, dy = c.position.y - p.y, dz = c.position.z - p.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < nearest) nearest = dist;
    // The same curve language.js uses for its own certainty, so the score and
    // the voices agree about when something has become "near". Two different
    // thresholds here would show up as the music tensing before or after the
    // creature audibly did.
    const near = smoothstep(1600, 400, dist);
    const att = clamp01(c.attention || 0);
    if (near * (0.35 + 0.65 * att) > certainty) certainty = near * (0.35 + 0.65 * att);
    // Detection is the top third of attention: TRACKING starts at 0.70 and
    // COMMITTED at 0.92 (creature.js STATE_ENTRY), so this crosses zero exactly
    // where the creature starts behaving as though it knows.
    const det = clamp01((att - 0.70) / 0.30);
    if (det > detected) detected = det;
  }

  const throttle = ship && ship.input ? clamp01(ship.input.throttle || 0) : 0;
  const speed = ship ? Math.abs(ship.speed || 0) : 0;
  // Hiding is not a mode the player toggles; it is a description of what they
  // are doing. Engines nearly off and the lamps out is the posture the
  // signature system rewards, so it is what the score should hear.
  //
  // Speed is in here as well as throttle, and it has to be: cutting the engines
  // at cruise leaves the ship coasting at 140 m/s for a long time, still
  // tearing a wake through the cloud. Measured in a live tab with throttle at 0
  // and speed at 90 m/s, throttle alone reported hiding = 1.0 and the score
  // dropped to a third of its level while the player was visibly running. 120
  // m/s is roughly the speed above which the wake channel dominates the ship's
  // signature.
  const activity = Math.max(throttle / 0.25, speed / 120);
  const quiet = 1 - clamp01(activity);
  const dark = systems && systems.lampOn ? 0.35 : 1;

  const t = out.threat;
  t.certainty = certainty;
  t.detected = detected;
  t.hiding = quiet * dark;
  t.escaping = detected * throttle;
  t.safety = 1 - certainty;
  t.damage = ship && ship.integrity01 !== undefined ? 1 - clamp01(ship.integrity01) : 0;
  // NOT DERIVED. Nothing in the game currently publishes a "this is a vista"
  // signal, and inventing one from density and altitude would make the score
  // swell at arbitrary moments — worse than never reaching for awe at all. The
  // director beats in game/director.js are where this should come from; until
  // then a caller can set it directly.
  t.wonder = t.wonder || 0;

  let density = 0.3;
  if (game.clouds && game.clouds.densityAt && p) {
    density = clamp01(game.clouds.densityAt(p.x, p.y, p.z));
  }
  const b = out.beds;
  b.depth = density;
  b.shipActivity = Math.max(throttle, ship ? clamp01((ship.speed || 0) / 160) : 0);
  b.damage = t.damage;
  b.wonder = t.wonder;
  // Altitude is normalised against the band the cloud palette is tuned for —
  // main.js records the ship drifting out of it above ~1250 m — so 2000 m is
  // "as high as this game means anything at".
  b.altitude = p ? clamp01(p.y / 2000) : 0;

  out.nearest = nearest;
  return out;
}

/**
 * Beyond this, a creature gets no voice.
 *
 * Not a mix decision — a node-count one. Every contact builds a CreatureVoice,
 * and a CreatureVoice is a Spatialiser, which is thirteen nodes before the
 * synthesis on top of it. A live frame in this game already carries six contacts
 * with five of them a WakeHunter's chain at 3.3 km, which cannot be heard at
 * all: `geometricGain(3300)` is 0.03, or -30 dB, under a score that is itself
 * only -18 dBFS.
 *
 * 2500 m rather than the 1600 m where `certainty` saturates, so that something
 * closing on the player is already sounding before it becomes a threat, and so
 * the fade-in at the boundary happens at about -27 dB where nobody hears it
 * arrive.
 */
const MAX_CONTACT_RANGE = 2500;

const KIND_BY_ARCHETYPE = {
  listener: 'listener',
  lantern: 'lantern',
  wakehunter: 'wake',
  wake: 'wake',
  choir: 'choir',
};

/**
 * The creature language's state, from the same frame.
 *
 * Bearing is computed in the ship's frame rather than the world's, because the
 * spatialiser's whole job is to tell the player which way to turn. Using world
 * axes would leave every creature apparently fixed in space while the ship
 * rotated around it — the classic version of this bug, silent and total.
 */
export function readLanguageState(game, out = idleState()) {
  const ship = game.ship;
  const systems = game.systems;
  if (!ship || !ship.position) return out;

  const s = out.ship;
  s.throttle = clamp01(ship.input ? ship.input.throttle || 0 : 0);
  s.rpm01 = s.throttle;
  s.speed = ship.speed || 0;
  s.hullStress01 = clamp01(ship.stress01 || 0);
  s.integrity01 = ship.integrity01 !== undefined ? clamp01(ship.integrity01) : 1;
  s.lightsOn = !!(systems && systems.lampOn);
  s.scanning = !!(systems && systems.scanState && systems.scanState !== 'idle');

  const p = ship.position;
  if (game.clouds) {
    const d = game.clouds.densityAt ? clamp01(game.clouds.densityAt(p.x, p.y, p.z)) : 0.2;
    out.medium.density01 = d;
    out.medium.visibility01 = 1 - d;
    if (game.clouds.flowAt) {
      const f = game.clouds.flowAt(p.x, p.y, p.z);
      out.medium.turbulence01 = f ? clamp01(f.turbulence || 0) : 0;
    }
  }

  const f = ship.forward, r = ship.right, u = ship.up;
  const contacts = out.contacts;
  // The contact objects are pooled rather than rebuilt. This runs every frame
  // with up to a handful of contacts, and the garbage is the kind that shows up
  // as an occasional 3 ms collection in a 8.3 ms budget rather than as a bug.
  const pool = (out._pool || (out._pool = []));
  let n = 0;
  const list = game.creatures ? (game.creatures.creatures || []) : [];
  for (const c of list) {
    if (!c || !c.position) continue;
    const dx = c.position.x - p.x, dy = c.position.y - p.y, dz = c.position.z - p.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
    if (dist > MAX_CONTACT_RANGE) continue;
    const fwd = f ? dx * f.x + dy * f.y + dz * f.z : dz;
    const rgt = r ? dx * r.x + dy * r.y + dz * r.z : dx;
    const up = u ? dx * u.x + dy * u.y + dz * u.z : dy;
    const att = clamp01(c.attention || 0);
    const o = pool[n] || (pool[n] = {});
    o.id = c.id;
    o.kind = KIND_BY_ARCHETYPE[String(c.archetype || '').toLowerCase()] || 'listener';
    o.distance = dist;
    o.azimuth = Math.atan2(rgt, fwd);
    o.elevation = Math.asin(Math.max(-1, Math.min(1, up / dist)));
    // language.js wants 0 unaware / 1 searching / 2 fixed on you, continuous.
    // creature.js counts attention 0..1 with SEARCHING entered at 0.45, so the
    // curve is piecewise to put the landmark in the right place.
    o.awareness = att < 0.45 ? att / 0.45 : 1 + (att - 0.45) / 0.55;
    o.strokeHz = c.strokeHz || 0.6;
    contacts[n] = o;
    n++;
  }
  contacts.length = n;

  out.hiding = s.throttle < 0.08 && !s.lightsOn;
  out.escaping = s.throttle > 0.6;
  out.concealment01 = clamp01(out.medium.density01);
  out.risk01 = 0;
  for (const c of contacts) out.risk01 = Math.max(out.risk01, clamp01(c.awareness / 2));
  return out;
}

/**
 * The whole audio subsystem in one call, for main.js.
 *
 *   const audio = createAudio();          // module scope
 *   await audio.load();
 *   ...
 *   audio.frame(dt, loop.simTime, GAME);  // in update(), after creatures
 *
 * Kept here rather than in main.js so that the field names the game exposes are
 * read in exactly one place.
 */
export function createAudio(engine, opts = {}) {
  const st = new Soundtrack(engine, opts);
  const world = defaultWorld();
  let lang = idleState();
  st.frame = (dt, now, game) => {
    readWorld(game, world);
    lang = readLanguageState(game, lang);
    st.duckFromCreatures(game.creatures);
    st.update(dt, now, world, lang);
    return world;
  };
  return st;
}

export { weightsFor, gainFor };

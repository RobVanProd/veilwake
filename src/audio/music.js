// The music director.
//
// The score is 26 authored tracks, all generated from one prompt describing a
// single continuous arc: isolation, curiosity, warning, recognition,
// concealment, detection and pursuit, temporary safety. That origin dictates the
// whole design here, and it was established by measurement rather than assumed.
//
// Measuring whole tracks produced a null result, and the null result was the
// useful one: every track scored 'unease' between 0.79 and 0.89, with spectral
// centroid varying only 1.96x across all 26. In aggregate they are the same
// piece. There is no "pursuit track" to select.
//
// Windowed at 8 seconds, the same material separates cleanly — 1158 segments
// with 'conceal' spanning 0.10 to 0.72 and 'pursuit' 0.27 to 0.86. The arc is
// inside each track; averaging destroyed it. So the unit of selection is a
// window, not a file, and the director moves between *positions*.
//
// That is also what the material was written for. Every variant shares tempo
// (44-52 BPM), harmonic language and the three-note motif, so any window sits
// against any other without clashing — which is what makes crossfading between
// arbitrary points in arbitrary tracks musically safe rather than a gamble.
//
// Streamed through HTMLAudioElement rather than decoded into AudioBuffers: 26
// tracks of about four minutes each is roughly 109 MB of source, and decoding
// that to float PCM would be well over a gigabyte of resident memory for no
// benefit, since the director only ever needs two playheads.

const ROLES = ['drift', 'unease', 'pursuit', 'conceal', 'awe'];

/**
 * The threat model, mapped to what the music should be doing.
 *
 * Deliberately not a state machine with named cues. The mandate is explicit that
 * music must respond to a threat *model* rather than switch between calm and
 * combat, so this returns a weight per role and the director finds the material
 * that best matches the blend. Two situations that are 70% similar produce
 * 70% similar music, which a switch cannot do.
 */
export function weightsFor(s) {
  const certainty = clamp01(s.certainty ?? 0);      // belief something is near
  const detected = clamp01(s.detected ?? 0);        // it knows where you are
  const hiding = clamp01(s.hiding ?? 0);            // engines down, deliberately still
  const escaping = clamp01(s.escaping ?? 0);
  const safety = clamp01(s.safety ?? 1);            // 1 = sheltered, 0 = exposed
  const damage = clamp01(s.damage ?? 0);
  const wonder = clamp01(s.wonder ?? 0);            // discovery, vista, scale

  const w = { drift: 0, unease: 0, pursuit: 0, conceal: 0, awe: 0 };

  // Baseline: the emptier and safer it is, the more it drifts.
  w.drift = (1 - certainty) * safety * (1 - hiding);
  // Suspicion, before confirmation. The largest band in normal play.
  w.unease = certainty * (1 - detected) * (1 - hiding) + damage * 0.35;
  // Only once it knows.
  w.pursuit = detected * (0.65 + escaping * 0.35);
  // Held breath.
  w.conceal = hiding * (0.55 + certainty * 0.45);
  // Awe is not a reward state; it is what the game is for.
  w.awe = wonder * (1 - detected * 0.8);

  let total = 0;
  for (const r of ROLES) total += w[r];
  if (total < 1e-6) { w.drift = 1; total = 1; }
  for (const r of ROLES) w[r] /= total;
  return w;
}

/**
 * How loud the music should be, which is a separate question from what it should be.
 *
 * The design calls for deliberate silence: the most dangerous moments should
 * contain *less* music, not more. Two places earn it. Deep concealment, where
 * the player is straining to hear a creature and any score is actively in the
 * way — the environment is supposed to feel like it is listening. And the moment
 * of recognition, where a short duck under a first sighting does more than any
 * sting.
 */
export function gainFor(s) {
  const hiding = clamp01(s.hiding ?? 0);
  const certainty = clamp01(s.certainty ?? 0);
  const detected = clamp01(s.detected ?? 0);

  let g = 1;
  // Concealment pulls the score down hard, and the deeper the suspicion the
  // quieter it gets — inverted from the obvious mapping, on purpose.
  g *= 1 - hiding * (0.55 + certainty * 0.35);
  // A brief hollow at the point of recognition: high certainty, not yet
  // detected. This is where a lesser score would put a stinger.
  const recognition = certainty * (1 - detected);
  g *= 1 - recognition * 0.30;
  return clamp(g, 0.06, 1);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class MusicDirector {
  /**
   * @param {import('../core/audio.js').Audio} audio
   * @param {object} opts
   */
  constructor(audio, { indexUrl = 'assets/music_index.json', crossfade = 6.0 } = {}) {
    this.audio = audio;
    this.indexUrl = indexUrl;
    this.crossfadeSeconds = crossfade;

    this.index = null;
    this.ready = false;
    this.enabled = true;

    /** Two voices, so a change is always a crossfade and never a cut. */
    this.voices = [];
    this.active = 0;

    this.current = null;        // { track, t, score }
    this.lastSwitch = -1e9;
    this.minHold = 22;          // seconds; below this the score fidgets
    this.targetGain = 1;
    this.masterGain = 0.85;

    this.state = { certainty: 0, detected: 0, hiding: 0, escaping: 0, safety: 1, damage: 0, wonder: 0 };
    this._weights = weightsFor(this.state);
  }

  async load() {
    const res = await fetch(this.indexUrl);
    if (!res.ok) throw new Error(`music index: ${res.status}`);
    this.index = await res.json();
    this.ready = true;
    return this.index;
  }

  /** Build the two streaming voices. Requires a user gesture to have happened. */
  _ensureVoices() {
    if (this.voices.length || !this.audio.started) return;
    const ctx = this.audio.ctx;
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.loop = false;
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.audio.buses.music || this.audio.master);
      this.voices.push({ el, src, gain, track: null });
    }
  }

  /** Update the threat model. Cheap; call every frame. */
  setState(partial) {
    Object.assign(this.state, partial);
    this._weights = weightsFor(this.state);
    this.targetGain = gainFor(this.state);
  }

  /**
   * Score every segment against the current blend and return the best.
   *
   * Two terms beyond the match itself. A penalty for the segment already
   * playing, so the director does not thrash between two near-identical
   * windows; and a mild preference for staying in the same file, because
   * continuing within a track preserves whatever long-form shape it has.
   */
  _bestSegment() {
    const w = this._weights;
    let best = null, bestScore = -1e9;
    for (let ti = 0; ti < this.index.tracks.length; ti++) {
      const tr = this.index.tracks[ti];
      for (let si = 0; si < tr.seg.length; si++) {
        const s = tr.seg[si];
        // [t, drift, unease, pursuit, conceal, awe, rmsDb]
        const match = w.drift * s[1] + w.unease * s[2] + w.pursuit * s[3] +
                      w.conceal * s[4] + w.awe * s[5];
        let score = match;
        if (this.current && this.current.trackIndex === ti) {
          score += 0.04;
          if (Math.abs(this.current.t - s[0]) < this.index.hop * 1.5) score -= 0.25;
        }
        if (score > bestScore) { bestScore = score; best = { trackIndex: ti, segIndex: si, t: s[0], score: match }; }
      }
    }
    return best;
  }

  update(dt, now) {
    if (!this.ready || !this.enabled) return;
    this._ensureVoices();
    if (!this.voices.length) return;

    const ctx = this.audio.ctx;
    const t = ctx.currentTime;

    // Master level follows the threat model continuously, independent of which
    // material is playing.
    const activeVoice = this.voices[this.active];
    if (activeVoice.track !== null) {
      activeVoice.gain.gain.setTargetAtTime(this.targetGain * this.masterGain, t, 0.4);
    }

    // Only consider changing material occasionally. Continuous re-selection
    // would crossfade forever and never let a passage establish itself.
    if (now - this.lastSwitch < this.minHold) return;

    const best = this._bestSegment();
    if (!best) return;

    // Switch only when the new material is meaningfully better, or when the
    // current playhead has run off the end of its track.
    const currentScore = this.current ? this._scoreOf(this.current) : -1;
    const drifted = this.current && (this.current.playedFor ?? 0) > 60;
    if (!this.current || best.score > currentScore + 0.06 || drifted) {
      this._crossfadeTo(best, now);
    }
  }

  _scoreOf(cur) {
    const w = this._weights;
    const s = this.index.tracks[cur.trackIndex].seg[cur.segIndex];
    return w.drift * s[1] + w.unease * s[2] + w.pursuit * s[3] + w.conceal * s[4] + w.awe * s[5];
  }

  _crossfadeTo(target, now) {
    const ctx = this.audio.ctx;
    const t = ctx.currentTime;
    const next = 1 - this.active;
    const from = this.voices[this.active];
    const to = this.voices[next];
    const tr = this.index.tracks[target.trackIndex];

    // Start slightly before the window so the crossfade lands *inside* it rather
    // than arriving at its edge.
    const lead = Math.min(2.0, target.t);
    if (to.el.src !== new URL(tr.src, location.href).href) to.el.src = tr.src;
    try { to.el.currentTime = Math.max(0, target.t - lead); } catch { /* not seekable yet */ }

    const play = to.el.play();
    if (play && play.catch) play.catch(() => { /* blocked until a gesture; retried next switch */ });

    const xf = this.crossfadeSeconds;
    to.gain.gain.cancelScheduledValues(t);
    to.gain.gain.setValueAtTime(Math.max(to.gain.gain.value, 0.0001), t);
    to.gain.gain.linearRampToValueAtTime(this.targetGain * this.masterGain, t + xf);

    from.gain.gain.cancelScheduledValues(t);
    from.gain.gain.setValueAtTime(from.gain.gain.value, t);
    from.gain.gain.linearRampToValueAtTime(0, t + xf);
    const fading = from.el;
    setTimeout(() => { if (fading !== this.voices[this.active].el) fading.pause(); }, (xf + 0.4) * 1000);

    to.track = target.trackIndex;
    this.active = next;
    this.current = { ...target, playedFor: 0, startedAt: now };
    this.lastSwitch = now;
  }

  /** What the director is doing, for the diagnostics overlay and for tests. */
  readout() {
    const cur = this.current;
    return {
      ready: this.ready,
      weights: this._weights,
      gain: +this.targetGain.toFixed(3),
      track: cur ? this.index.tracks[cur.trackIndex].src.split('/').pop() : null,
      at: cur ? cur.t : null,
      match: cur ? +this._scoreOf(cur).toFixed(3) : null,
    };
  }

  stop(fade = 2.0) {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => v.el.pause(), (fade + 0.2) * 1000);
    }
    this.current = null;
  }
}

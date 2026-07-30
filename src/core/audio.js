// Audio.
//
// Everything is synthesised. There are no audio files in this project and there
// will not be: nothing can be licensed cleanly, nothing can be authored at
// volume here, and — more importantly — a sound that is *computed* can be a
// continuous function of game state in a way a sample never is. A sample can be
// triggered and pitched; a synthesised voice can be steered.
//
// The mix is built once, as a small fixed graph:
//
//   voices -> bus (sfx | music | ui) -> master gain -> limiter -> destination
//
// The limiter is not decoration. Additive synthesis with many simultaneous
// voices clips hard and unpredictably, and a game that distorts at its loudest
// moment is distorting at exactly the moment the player is paying most
// attention.

export class Audio {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.master = null;
    this.limiter = null;
    this.enabled = true;
    this.started = false;

    this.volumes = { master: 0.8, sfx: 1.0, music: 0.7, ui: 0.9 };

    // Browsers refuse to start audio without a gesture. Rather than scatter
    // resume() calls through the game, arm every plausible first interaction.
    this._arm();
  }

  _arm() {
    const start = () => {
      this.start();
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        removeEventListener(ev, start);
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      addEventListener(ev, start, { once: false });
    }
  }

  /** Safe to call repeatedly. */
  start() {
    if (this.started) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }

    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.limiter = this.ctx.createDynamicsCompressor();
    // Fast, high-ratio, near-0dB: a safety net, not a character effect. Anything
    // slower lets transients through; anything lower colours the whole mix.
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(this.limiter);

    for (const name of ['sfx', 'music', 'ui']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(this.master);
      this.buses[name] = g;
    }

    this.started = true;
  }

  get time() { return this.ctx ? this.ctx.currentTime : 0; }

  setVolume(name, value) {
    this.volumes[name] = value;
    const node = name === 'master' ? this.master : this.buses[name];
    if (node) node.gain.setTargetAtTime(value, this.time, 0.02);
  }

  /** Noise buffer, cached. White noise is the raw material for most texture. */
  noiseBuffer(seconds = 2) {
    if (!this.ctx) return null;
    const key = `noise${seconds}`;
    if (this[key]) return this[key];
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let s = 0x2545f491;
    for (let i = 0; i < len; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      data[i] = (s / 2147483648) - 1;
    }
    this[key] = buf;
    return buf;
  }

  /**
   * A single struck/blown voice with an exponential envelope.
   *
   * Exponential rather than linear on purpose: loudness is perceived roughly
   * logarithmically, so a linear fade sounds like it stops abruptly at the end
   * and a linear attack sounds soft. setTargetAtTime is the cheap correct shape.
   */
  tone({
    freq = 440, type = 'sine', bus = 'sfx',
    gain = 0.2, attack = 0.005, decay = 0.25,
    detune = 0, pan = 0, glideTo = 0, glideTime = 0.1, when = 0,
  } = {}) {
    if (!this.enabled || !this.started) return null;
    const t = when || this.time;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.value = detune;
    if (glideTo > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(glideTo, 1), t + glideTime);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

    let node = env;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      env.connect(p);
      node = p;
    }

    osc.connect(env);
    node.connect(this.buses[bus] || this.master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.02);
    return osc;
  }

  /** Filtered noise burst — impacts, breath, friction, wind gusts. */
  noise({
    bus = 'sfx', gain = 0.2, attack = 0.002, decay = 0.3,
    filter = 'bandpass', freq = 900, q = 1.2, sweepTo = 0, pan = 0, when = 0,
  } = {}) {
    if (!this.enabled || !this.started) return null;
    const t = when || this.time;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = filter;
    bp.frequency.setValueAtTime(freq, t);
    bp.Q.value = q;
    if (sweepTo > 0) bp.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 20), t + decay);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

    let node = env;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      env.connect(p);
      node = p;
    }

    src.connect(bp); bp.connect(env);
    node.connect(this.buses[bus] || this.master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
    return src;
  }

  /**
   * A held voice the game can steer for as long as it likes.
   *
   * Returned with setters rather than raw nodes so callers cannot accidentally
   * set a value directly and cause a click — every change is ramped.
   */
  drone({ freq = 110, type = 'sawtooth', bus = 'music', gain = 0.0, filter = 1200, q = 0.7 } = {}) {
    if (!this.enabled || !this.started) return null;
    const t = this.time;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(filter, t);
    lp.Q.value = q;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);

    osc.connect(lp); lp.connect(g);
    g.connect(this.buses[bus] || this.master);
    osc.start(t);

    const ctx = this.ctx;
    return {
      osc, filterNode: lp, gainNode: g,
      setGain(v, tau = 0.08) { g.gain.setTargetAtTime(Math.max(v, 0), ctx.currentTime, tau); },
      setFreq(v, tau = 0.08) { osc.frequency.setTargetAtTime(Math.max(v, 1), ctx.currentTime, tau); },
      setFilter(v, tau = 0.08) { lp.frequency.setTargetAtTime(Math.max(v, 20), ctx.currentTime, tau); },
      stop(fade = 0.3) {
        g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        osc.stop(ctx.currentTime + fade + 0.1);
      },
    };
  }

  /** Cheap stereo reverb from a synthesised impulse. Built once, on demand. */
  reverb({ seconds = 2.2, decay = 2.6, wet = 0.25 } = {}) {
    if (!this.enabled || !this.started) return null;
    if (this._reverb) return this._reverb;

    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    let s = 0x9e3779b9;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        const n = (s / 2147483648) - 1;
        d[i] = n * Math.pow(1 - i / len, decay);
      }
    }

    const conv = this.ctx.createConvolver();
    conv.buffer = buf;
    const wetGain = this.ctx.createGain();
    wetGain.gain.value = wet;
    conv.connect(wetGain);
    wetGain.connect(this.master);

    this._reverb = { node: conv, wetGain };
    return this._reverb;
  }

  /** Duck a bus briefly — used to keep an important cue readable in a dense mix. */
  duck(bus, amount = 0.5, hold = 0.12, release = 0.35) {
    const g = this.buses[bus];
    if (!g) return;
    const t = this.time;
    const base = this.volumes[bus];
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(base * amount, t + 0.02);
    g.gain.setValueAtTime(base * amount, t + hold);
    g.gain.linearRampToValueAtTime(base, t + hold + release);
  }
}

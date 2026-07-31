// The audio language.
//
// This is the vocabulary, not the mixer. `core/audio.js` owns the graph, the
// buses and the limiter; this file decides what a given game state is allowed to
// sound like, and it is the single source of truth for every number in
// AUDIO_LANGUAGE.md. If a mapping is described in that document and not exported
// from here, one of the two is wrong.
//
// Interface
// ---------
//   const lang = new AudioLanguage();
//   lang.attach(audio);                  // a started core/audio.js instance
//   lang.update(dt, state);              // once per fixed step, STATE_SHAPE below
//   lang.event('discharge', { azimuth }) // one-shots the sim cannot schedule
//   lang.detach();
//
//   await probe({ ... })                 // offline render of one creature voice
//   describe(pcm, sampleRate)            // pure analysis of a rendered buffer
//   estimate(describe(...))              // recovers distance / bearing / awareness
//   await discriminationTest({ trials })  // the whole thing, scored
//
// The load-bearing structural decision: every creature voice is built against a
// bare AudioContext and a destination node, never against the live mixer. That
// is the only reason the audio can be verified at all — the same constructor
// runs inside an OfflineAudioContext, renders to a Float32Array, and gets
// measured. It is the audio equivalent of preserveDrawingBuffer in main.js: the
// system has to be able to hand back what it produced, because nobody
// developing this can hear it.
//
// The other load-bearing decision is in MEDIUM, and it is worth stating before
// any of the numbers. Cloud density attenuates and low-passes by an amount the
// player cannot know. Therefore *any cue encoded as an absolute level, or as a
// ratio between widely separated bands, is destroyed by the medium* — a close
// creature behind dense cloud and a distant one in clear air produce the same
// quiet, dull sound. A cue that must survive the medium has to be either a ratio
// taken inside one narrow band, or an interval in time. Both are invariant under
// an unknown gain and an unknown low-pass. Everything discriminative here is one
// of those two things.

import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The shape `update()` consumes. Documented as a literal rather than prose so
 * that whoever wires the game can copy it and so that `idleState()` below stays
 * honest — a silent default that drifts from the real shape is how an audio
 * system ends up throwing on the first frame of a build nobody tested muted.
 *
 *   ship.throttle      0..1    commanded thrust
 *   ship.rpm01         0..1    actual spool, lags throttle
 *   ship.boost         0..1    overdrive fraction
 *   ship.heat01        0..1    core temperature toward the limit
 *   ship.hullStress01  0..1    instantaneous structural load
 *   ship.integrity01   1..0    accumulated damage, 1 is undamaged
 *   ship.speed         m/s     airspeed relative to local flow
 *   ship.energy01      1..0    reserve remaining
 *   ship.lightsOn      bool    exterior lamps
 *   ship.scanning      bool    active scan pulse held
 *
 *   medium.density01     0..1  local cloud density at the ship
 *   medium.turbulence01  0..1  local shear
 *   medium.charge01      0..1  electrical potential building nearby
 *   medium.visibility01  1..0  1 is clear air
 *
 *   contacts[]  { id, kind, distance, azimuth, elevation, awareness, strokeHz }
 *     kind      'listener' | 'lantern' | 'wake' | 'choir'
 *     distance  metres
 *     azimuth   radians, 0 ahead, +right, wraps at ±pi
 *     elevation radians, ±0.6 useful
 *     awareness 0..2 continuous — 0 unaware, 1 searching, 2 fixed on you
 *     strokeHz  its locomotion rate, 0.2..2.0
 *
 *   risk01           0..1  probability mass that something is about to notice
 *   concealment01    0..1  how well the medium is currently hiding the ship
 *   safetyDistance01 0..1  0 at a known safe position, 1 at the far edge
 *   hiding, escaping bool
 *   instruments.reliability01  1..0, 1 is trustworthy
 */
export const STATE_SHAPE = Object.freeze({});

export function idleState() {
  return {
    ship: {
      throttle: 0, rpm01: 0, boost: 0, heat01: 0, hullStress01: 0,
      integrity01: 1, speed: 0, energy01: 1, lightsOn: false, scanning: false,
    },
    medium: { density01: 0.2, turbulence01: 0, charge01: 0, visibility01: 1 },
    contacts: [],
    risk01: 0, concealment01: 0, safetyDistance01: 0,
    hiding: false, escaping: false,
    instruments: { reliability01: 1 },
  };
}

// ---------------------------------------------------------------------------
// The medium
// ---------------------------------------------------------------------------

/**
 * How the cloud treats sound. These constants are the physics of the game more
 * than they are a mix decision, so they live in one frozen table that both the
 * runtime and the offline test read.
 *
 * C_SOUND / C_PRESSURE is the important pair. A creature's movement puts a
 * compression through the dense body of the cloud, which travels fast; its call
 * travels through the air, which is slow. The gap between the shove and the
 * sound is therefore a pure time interval proportional to range, and no amount
 * of attenuation can forge it. It is the primary long-range distance cue and the
 * only one the player can trust when the medium is at its worst.
 */
export const MEDIUM = Object.freeze({
  C_SOUND: 330,        // m/s, airborne
  C_PRESSURE: 1100,    // m/s, through the cloud body
  LAG_PER_M: 1 / 330 - 1 / 1100,   // 2.121 ms per metre — 470 m per second of gap
  LAG_MAX: 3.2,        // s; beyond ~1500 m the gap stops being countable

  GEO_REF: 60,         // m, distance at which geometric loss is unity
  GEO_EXP: 0.9,        // slightly under inverse-square-in-amplitude; far things stay present

  // Frequency-dependent absorption. The density term dominates: droplets and
  // eddies scatter short wavelengths and ignore long ones.
  ABSORB_AIR: 0.0016,
  ABSORB_DENSITY: 0.0075,
  CUTOFF_MAX: 18000,
  CUTOFF_MIN: 140,

  // Below this the medium is transparent — a 60 Hz wavelength is 5.5 m and does
  // not see a droplet. This is why the sub chain bypasses the medium filter, and
  // why every density-immune cue in the language lives underneath it.
  SUB_HINGE: 120,

  // Near-field displacement. Falls as 1/r^2 rather than 1/r because it is the
  // animal pushing the medium about, not radiating into it.
  NEAR_REF: 110,       // m, where stroke modulation is half depth

  SCATTER_SCALE: 0.55,
  SCATTER_GEO_EXP: 0.35,   // scatter falls far more slowly than direct: that gap is the cue
});

/** Broadband level loss from range alone. */
export function geometricGain(distance) {
  return Math.pow(MEDIUM.GEO_REF / Math.max(distance, MEDIUM.GEO_REF), MEDIUM.GEO_EXP);
}

/**
 * Where the medium's low-pass sits, in Hz.
 *
 * Worth reading as a table, because the ambiguity it creates is deliberate:
 *   clear air, 500 m  -> 8.1 kHz      dense cloud, 120 m -> 6.0 kHz
 *   clear air, 1500 m -> 1.6 kHz      dense cloud, 500 m -> 190 Hz
 * A close creature in thick cloud is still bright; a far one never is. Brightness
 * is therefore an honest *near* cue and a useless *far* one, and it saturates at
 * the floor, which is exactly where the time and ratio cues take over.
 */
export function mediumCutoff(distance, density01) {
  const k = MEDIUM.ABSORB_AIR + MEDIUM.ABSORB_DENSITY * clamp01(density01);
  return clamp(MEDIUM.CUTOFF_MAX * Math.exp(-k * Math.max(distance, 0)),
    MEDIUM.CUTOFF_MIN, MEDIUM.CUTOFF_MAX);
}

/** Seconds between the felt shove and the heard call. */
export function arrivalLag(distance) {
  return Math.min(distance * MEDIUM.LAG_PER_M, MEDIUM.LAG_MAX);
}

/** Distance recovered from that gap. The inverse of arrivalLag, for the test. */
export function distanceFromLag(seconds) {
  return seconds / MEDIUM.LAG_PER_M;
}

/**
 * Depth of the stroke modulation on the sub band, 0..1.
 *
 * This is a ratio taken inside one narrow band, so a uniform gain and a
 * high-frequency low-pass both cancel out of it. It is the density-immune close
 * cue, and it is the reason the sub chain must never be culled for performance.
 */
export function nearFieldDepth(distance) {
  const r = Math.max(distance, 1) / MEDIUM.NEAR_REF;
  return 1 / (1 + r * r);
}

export function distanceFromDepth(depth) {
  const d = clamp(depth, 1e-4, 0.999);
  return MEDIUM.NEAR_REF * Math.sqrt(1 / d - 1);
}

/** How much of a voice goes to the diffuse scatter bus. */
export function scatterSend(distance, density01) {
  return MEDIUM.SCATTER_SCALE
    * Math.pow(clamp01(density01) + 0.05, 0.7)
    * Math.pow(geometricGain(distance), MEDIUM.SCATTER_GEO_EXP);
}

// ---------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------

/**
 * The three states a creature's voice can be in, and what changes between them.
 *
 * Every parameter here is chosen to be orthogonal to distance and immune to the
 * medium. Interval regularity survives any filter. Attack time survives any
 * filter — the smearing a 140 Hz low-pass applies is about 7 ms, against attacks
 * of 60 to 900 ms. Partial stretch is a ratio between neighbouring partials, so
 * it survives a tilt. None of them can be faked by moving closer or by the cloud
 * thinning, which is the whole point: the player must never confuse "it is near"
 * with "it knows".
 *
 * The sweep is the cruel one. A searching creature emits a slow narrow-band
 * sweep — that is the sound of it looking. When it finds you the sweep stops,
 * because it no longer needs to look. The transition to maximum danger is marked
 * by a sound *ending*.
 */
export const AWARENESS = Object.freeze([
  Object.freeze({   // 0 — unaware. Broadcasting, not addressing.
    name: 'unaware',
    interval: 14.0, jitter: 0.45,
    stretch: 0.085,          // strongly inharmonic: a phenomenon, not a voice
    attack: 0.90, decay: 3.4,
    driftSemitones: 7.0, driftHz: 0.02,
    sweep: 0.0,
    level: 0.85,
  }),
  Object.freeze({   // 1 — searching. It has a bearing on you, not a fix.
    name: 'searching',
    interval: 5.5, jitter: 0.16,
    stretch: 0.034,
    attack: 0.35, decay: 2.1,
    driftSemitones: 2.0, driftHz: 0.05,
    sweep: 1.0,
    level: 1.0,
  }),
  Object.freeze({   // 2 — fixed. Regular, harmonic, aimed, and silent between.
    name: 'fixed',
    interval: 2.0, jitter: 0.04,
    stretch: 0.004,          // integer harmonics: it has become a voice
    attack: 0.06, decay: 1.3,
    driftSemitones: 0.0, driftHz: 0.0,
    sweep: 0.0,              // the search is over
    level: 1.15,
  }),
]);

/** Continuous interpolation across the three states. */
export function awarenessParams(a) {
  const t = clamp(a, 0, 2);
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const A = AWARENESS[i], B = AWARENESS[Math.min(2, i + 1)];
  return {
    interval: lerp(A.interval, B.interval, f),
    jitter: lerp(A.jitter, B.jitter, f),
    stretch: lerp(A.stretch, B.stretch, f),
    attack: lerp(A.attack, B.attack, f),
    decay: lerp(A.decay, B.decay, f),
    driftSemitones: lerp(A.driftSemitones, B.driftSemitones, f),
    driftHz: lerp(A.driftHz, B.driftHz, f),
    sweep: lerp(A.sweep, B.sweep, f),
    level: lerp(A.level, B.level, f),
  };
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

/**
 * One instrument each, in the same grammar.
 *
 * They are separated by register and by material, not by melody, because the
 * player will usually hear them through several hundred metres of cloud where
 * melody is the first thing to go. Register and texture survive.
 */
export const CREATURES = Object.freeze({
  // Hears engine vibration. Lives almost entirely under the medium's floor, so
  // distance and density barely change its timbre — you always hear it, you just
  // cannot tell how far away it is without counting.
  listener: Object.freeze({
    f0: 34, partials: 3, partialTilt: 0.55,
    // Every call carries some energy above MEDIUM.SUB_HINGE even when the
    // creature itself does not, because that is what lets the call be
    // time-stamped separately from the shove while the medium still passes it.
    // When the medium no longer does, both events fall into the sub band and are
    // separated by their spacing instead — see `describe`.
    breath: 0.16, breathCentre: 240,
    bodyHz: 27, strokeHz: 0.28, sweepLo: 60, sweepHi: 190,
    scatterScale: 1.0,
  }),
  // Light and electrical activity. High, granular, and therefore the creature the
  // cloud hides best — its whole signature sits where absorption is strongest.
  lantern: Object.freeze({
    f0: 210, partials: 5, partialTilt: 0.72,
    breath: 0.35, breathCentre: 3200,
    bodyHz: 58, strokeHz: 1.6, sweepLo: 400, sweepHi: 3600,
    crackle: 9.0,
    scatterScale: 1.0,
  }),
  // Turbulence and directional change. Nearly no tonal content: it is heard as a
  // change in the shape of the noise floor, which means a player running a loud
  // engine cannot hear it at all.
  wake: Object.freeze({
    f0: 0, partials: 0, partialTilt: 0,
    breath: 1.0, breathCentre: 380, breathQ: 0.9,
    bodyHz: 41, strokeHz: 0.9, sweepLo: 150, sweepHi: 900,
    scatterScale: 1.0,
  }),
  // Interferes with perception. Emits imitations of the other three at wrong
  // ranges and wrong bearings. Its tell is that the fakes are *too clean* — it
  // synthesises the direct sound and cannot synthesise several hundred metres of
  // scattering, so its direct-to-scatter ratio is far too high for the distance
  // it is claiming. A player who has learned the tail can hear the lie.
  choir: Object.freeze({
    f0: 96, partials: 4, partialTilt: 0.6,
    breath: 0.2, breathCentre: 900,
    bodyHz: 34, strokeHz: 0.55, sweepLo: 200, sweepHi: 2000,
    scatterScale: 0.12,
  }),
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * A private RNG.
 *
 * Deliberately not core/rng.js: audio must not draw from the world stream, or
 * turning the volume down would change the terrain. It also has to be
 * reproducible on its own so a probe and a capture agree.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAFE = 1e-4;
/** exponentialRampToValueAtTime throws on zero, and a thrown ramp is silence. */
const pos = (v) => (v > SAFE ? v : SAFE);
/** setTargetAtTime with tau <= 0 is a no-op that looks like a stuck parameter. */
const tau = (v) => (v > 1e-3 ? v : 1e-3);

function ramp(param, value, when, seconds = 0.05) {
  param.setTargetAtTime(value, when, tau(seconds / 3));
}

// ---------------------------------------------------------------------------
// Spatialiser
// ---------------------------------------------------------------------------

/**
 * Bearing, built by hand rather than with a PannerNode.
 *
 * PannerNode's HRTF mode is a fixed measured set and its equal-power mode is a
 * pure amplitude pan, and neither is right here. The problem is that this game's
 * most important sounds are at 30 to 120 Hz, where the head casts no acoustic
 * shadow at all: interaural *level* difference is essentially zero and the only
 * cue that exists is interaural *time* difference. An amplitude pan on a 34 Hz
 * tone is inaudible as direction, which would leave the Listener — the creature
 * that hunts by sound — with no bearing at all.
 *
 * So: split at 500 Hz, pan the high band fully and the low band barely, and
 * delay the two ears independently for both. The delay is what actually carries
 * the direction below 500 Hz.
 *
 * Front/back and elevation are pinna cues and live above 2 kHz, which the medium
 * removes first. That is not a bug to paper over — see AUDIO_LANGUAGE.md, the
 * fallback is that the player must turn, and turning costs a wake.
 */
export const SPATIAL = Object.freeze({
  SPLIT_HZ: 500,
  ITD_MAX: 0.00063,     // s, roughly a head width at 330 m/s
  ITD_BASE: 0.0008,     // both delays sit here so the difference can go either way
  ILD_LOW: 0.12,        // pan authority below the split — small, because physics
  ILD_HIGH: 1.0,
  REAR_NOTCH_HZ: 4000, REAR_NOTCH_DB: -9, REAR_NOTCH_Q: 1.4,
  REAR_SHELF_HZ: 3000, REAR_SHELF_DB: -2.5,
  FRONT_PEAK_HZ: 3200, FRONT_PEAK_DB: 4, FRONT_PEAK_Q: 1.2,
  ELEV_NOTCH_LO: 6200, ELEV_NOTCH_HI: 9400,
});

export class Spatialiser {
  /** @param {BaseAudioContext} ctx @param {AudioNode} dest */
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.input = ctx.createGain();

    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass'; lo.frequency.value = SPATIAL.SPLIT_HZ; lo.Q.value = 0.5;

    const hi = ctx.createBiquadFilter();
    hi.type = 'highpass'; hi.frequency.value = SPATIAL.SPLIT_HZ; hi.Q.value = 0.5;

    this.fbPeak = ctx.createBiquadFilter();
    this.fbPeak.type = 'peaking';
    this.fbPeak.frequency.value = SPATIAL.FRONT_PEAK_HZ;
    this.fbPeak.Q.value = SPATIAL.FRONT_PEAK_Q;
    this.fbPeak.gain.value = 0;

    this.fbShelf = ctx.createBiquadFilter();
    this.fbShelf.type = 'highshelf';
    this.fbShelf.frequency.value = SPATIAL.REAR_SHELF_HZ;
    this.fbShelf.gain.value = 0;

    this.elev = ctx.createBiquadFilter();
    this.elev.type = 'peaking';
    this.elev.frequency.value = 7500;
    this.elev.Q.value = 2.2;
    this.elev.gain.value = -6;

    this.panLow = ctx.createStereoPanner();
    this.panHigh = ctx.createStereoPanner();

    const sum = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.delayL = ctx.createDelay(0.01);
    this.delayR = ctx.createDelay(0.01);
    this.delayL.delayTime.value = SPATIAL.ITD_BASE;
    this.delayR.delayTime.value = SPATIAL.ITD_BASE;

    this.output = ctx.createGain();

    this.input.connect(lo); lo.connect(this.panLow); this.panLow.connect(sum);
    this.input.connect(hi); hi.connect(this.fbPeak); this.fbPeak.connect(this.fbShelf);
    this.fbShelf.connect(this.elev); this.elev.connect(this.panHigh); this.panHigh.connect(sum);

    sum.connect(split);
    split.connect(this.delayL, 0); split.connect(this.delayR, 1);
    this.delayL.connect(merge, 0, 0); this.delayR.connect(merge, 0, 1);
    merge.connect(this.output);
    this.output.connect(dest);

    this._nodes = [this.input, lo, hi, this.fbPeak, this.fbShelf, this.elev,
      this.panLow, this.panHigh, sum, split, merge, this.delayL, this.delayR, this.output];
  }

  /** @param {number} azimuth radians, 0 ahead, +right @param {number} elevation radians */
  set(azimuth, elevation = 0, when = 0, glide = 0.06) {
    const t = when || this.ctx.currentTime;
    const s = Math.sin(azimuth);
    const c = Math.cos(azimuth);

    ramp(this.panLow.pan, clamp(s * SPATIAL.ILD_LOW, -1, 1), t, glide);
    ramp(this.panHigh.pan, clamp(s * SPATIAL.ILD_HIGH, -1, 1), t, glide);

    // A source to the right reaches the right ear first, so the *left* delay is
    // the longer one. Getting this backwards produces a bearing that is correct
    // for the level cue and inverted for the time cue, which is far worse than
    // no cue at all — the two fight and the image collapses to the centre.
    const itd = SPATIAL.ITD_MAX * s;
    ramp(this.delayL.delayTime, SPATIAL.ITD_BASE + Math.max(0, itd), t, glide);
    ramp(this.delayR.delayTime, SPATIAL.ITD_BASE + Math.max(0, -itd), t, glide);

    const front = clamp01((c + 1) * 0.5);
    ramp(this.fbPeak.gain, lerp(SPATIAL.REAR_NOTCH_DB, SPATIAL.FRONT_PEAK_DB, front), t, glide);
    this.fbPeak.frequency.setTargetAtTime(
      lerp(SPATIAL.REAR_NOTCH_HZ, SPATIAL.FRONT_PEAK_HZ, front), t, tau(glide));
    ramp(this.fbShelf.gain, lerp(SPATIAL.REAR_SHELF_DB, 0, front), t, glide);

    const e = clamp01((elevation / 0.6 + 1) * 0.5);
    this.elev.frequency.setTargetAtTime(
      lerp(SPATIAL.ELEV_NOTCH_LO, SPATIAL.ELEV_NOTCH_HI, e), t, tau(glide));
  }

  dispose() {
    for (const n of this._nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------------------
// Creature voice
// ---------------------------------------------------------------------------

/**
 * One creature, audible.
 *
 * Two layers, and they carry different information on purpose:
 *
 *   presence — a continuous sub pair, amplitude-modulated at the stroke rate.
 *              Always present, never filtered by the medium, and its modulation
 *              *depth* is the close-range distance cue.
 *   calls    — discrete events, scheduled ahead. Each is preceded by a pressure
 *              shove that arrives early; the gap is the long-range distance cue.
 *              Their interval, attack and harmonicity carry awareness.
 *
 * Nothing about level carries anything, because level is what the medium eats.
 */
export class CreatureVoice {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} dest        dry destination (an sfx bus, or an offline sink)
   * @param {AudioNode|null} scatterDest  the shared diffuse/reverb input
   * @param {object} opts { kind, seed }
   */
  constructor(ctx, dest, scatterDest, { kind = 'listener', seed = 1 } = {}) {
    this.ctx = ctx;
    this.kind = kind;
    this.def = CREATURES[kind] || CREATURES.listener;
    this.rand = mulberry32(seed);

    this.spatial = new Spatialiser(ctx, dest);
    this.scatterDest = scatterDest;

    // `source` is the voice before the world gets at it. Everything a call
    // produces lands here, and the two paths out of it are the whole distance
    // model.
    //
    // The scatter tap has to come off `source`, not off `direct`. Tapping after
    // the geometric attenuation makes the scattered field fall off at the same
    // rate as the direct one, which holds their ratio roughly constant — and the
    // direct-to-scatter ratio is precisely the cue that is supposed to fall with
    // range. Get this wrong and distance is silently unencoded while every
    // individual gain still looks correct.
    this.source = ctx.createGain();

    this.direct = ctx.createGain();
    this.medium = ctx.createBiquadFilter();
    this.medium.type = 'lowpass';
    this.medium.frequency.value = MEDIUM.CUTOFF_MAX;
    this.medium.Q.value = 0.6;
    this.source.connect(this.direct);
    this.direct.connect(this.medium);
    this.medium.connect(this.spatial.input);

    if (scatterDest) {
      this.scatter = ctx.createGain();
      this.scatter.gain.value = 0;
      // Pre-delay is not polish. It keeps the scattered field out of the first
      // 60 ms after arrival, which is the window the onset detector — and the
      // player — uses to time-stamp the call. Without it the tail smears the
      // attack and the long-range distance cue stops being measurable.
      this.scatterDelay = ctx.createDelay(0.5);
      this.scatterDelay.delayTime.value = 0.05;
      this.source.connect(this.scatterDelay);
      this.scatterDelay.connect(this.scatter);
      this.scatter.connect(scatterDest);
    }

    // Presence — the near-field displacement layer, and the carrier for the
    // close-range distance cue.
    //
    // The carrier is a fundamental and its octave, not two detuned voices. Two
    // close voices beat, and a beat is a slow amplitude modulation in exactly the
    // band the stroke modulation occupies — it would be measured as depth, and
    // depth is inverted straight into metres. An octave pair has a periodic
    // waveform and no sub-audio beat at all.
    //
    // Both partials sit under MEDIUM.SUB_HINGE for every creature, whatever its
    // call pitch. That is `bodyHz`: near-field displacement is set by how big the
    // animal is, not by what noises it makes, so all four share this register and
    // are told apart by stroke rate instead. It is also what keeps the layer
    // density-immune — a presence above the hinge would be eaten by the cloud
    // like everything else.
    this.presenceGain = ctx.createGain();
    this.presenceGain.gain.value = 0;
    this.presenceMod = ctx.createGain();
    // Intrinsic 1 with an LFO of amplitude `depth` summed onto it, so the gain
    // swings over [1-depth, 1+depth] about a mean of 1. That makes the measured
    // modulation index exactly `nearFieldDepth(r)` — any other arrangement puts a
    // scale factor between the cue and its inversion.
    this.presenceMod.gain.value = 1;
    this.presenceGain.connect(this.presenceMod);
    this.presenceMod.connect(this.spatial.input);   // sub bypasses the medium

    const body = this.def.bodyHz;
    this.subA = ctx.createOscillator();
    this.subA.type = 'sine';
    this.subA.frequency.value = body;
    this.subB = ctx.createOscillator();
    this.subB.type = 'sine';
    this.subB.frequency.value = body * 2;
    this.subA.connect(this.presenceGain);
    this.subB.connect(this.presenceGain);

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this.def.strokeHz;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.presenceMod.gain);

    // Sweep — the sound of a creature searching. Present only in state 1.
    this.sweepGain = ctx.createGain();
    this.sweepGain.gain.value = 0;
    this.sweepFilter = ctx.createBiquadFilter();
    this.sweepFilter.type = 'bandpass';
    this.sweepFilter.frequency.value = this.def.sweepLo;
    this.sweepFilter.Q.value = 7;
    this.sweepSrc = null;
    this.sweepFilter.connect(this.sweepGain);
    this.sweepGain.connect(this.source);

    this.started = false;
    this.nextCall = 0;
    this.pitchPhase = this.rand() * TAU;
    this.lastCallAt = -1e9;
    this.state = { distance: 500, azimuth: 0, elevation: 0, awareness: 0, density: 0.3 };
  }

  start(when = 0) {
    if (this.started) return;
    const t = when || this.ctx.currentTime;
    this.subA.start(t); this.subB.start(t); this.lfo.start(t);

    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuffer(this.ctx, 3);
    src.loop = true;
    src.connect(this.sweepFilter);
    src.start(t);
    this.sweepSrc = src;

    this.started = true;
    this.nextCall = t + 0.6 + this.rand() * 2.0;
  }

  /** Continuous parameters. Cheap; safe to call every fixed step. */
  set({ distance, azimuth, elevation = 0, awareness = 0, density01 = 0.3 }, when = 0) {
    const t = when || this.ctx.currentTime;
    const s = this.state;
    s.distance = Math.max(distance, 1);
    s.azimuth = azimuth; s.elevation = elevation;
    s.awareness = awareness; s.density = density01;

    const p = awarenessParams(awareness);
    const geo = geometricGain(s.distance);

    this.medium.frequency.setTargetAtTime(mediumCutoff(s.distance, density01), t, tau(0.15));
    ramp(this.direct.gain, geo * p.level, t, 0.12);
    if (this.scatter) {
      ramp(this.scatter.gain, scatterSend(s.distance, density01) * this.def.scatterScale, t, 0.2);
      this.scatterDelay.delayTime.setTargetAtTime(
        Math.min(0.45, 0.02 + s.distance / MEDIUM.C_SOUND * 0.6 + 0.12 * density01), t, tau(0.3));
    }

    // Presence: the carrier level follows geometry, but the *depth* is the cue,
    // so it is set from nearFieldDepth alone and never touched by density.
    const depth = nearFieldDepth(s.distance);
    ramp(this.presenceGain.gain, 0.16 * geo, t, 0.25);
    ramp(this.lfoDepth.gain, depth, t, 0.25);
    this.lfo.frequency.setTargetAtTime(this.def.strokeHz, t, tau(0.5));

    ramp(this.sweepGain.gain, p.sweep * 0.10 * geo, t, 0.4);
  }

  /**
   * Schedule any calls due in the next `lookahead` seconds.
   *
   * Scheduling ahead rather than firing on the frame is not an optimisation. A
   * call is a two-part event — a shove, then the sound, up to three seconds
   * later — and the interval between them is the distance cue. Timing that off
   * the render loop would put frame jitter directly into the one measurement the
   * player is asked to make.
   */
  pump(lookahead = 0.4) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const p = awarenessParams(this.state.awareness);
    let guard = 0;
    while (this.nextCall < now + lookahead && guard++ < 8) {
      this.call(Math.max(this.nextCall, now + 0.02));
      const jitter = 1 + (this.rand() * 2 - 1) * p.jitter;
      this.nextCall += Math.max(0.4, p.interval * jitter);
    }
    if (this.nextCall < now) this.nextCall = now + p.interval;
  }

  /**
   * One call: a pressure shove now, the airborne sound `arrivalLag` later.
   *
   * @param {number} at context time of the *shove*
   */
  call(at) {
    const ctx = this.ctx;
    const s = this.state;
    const p = awarenessParams(s.awareness);
    const geo = geometricGain(s.distance);
    const lag = arrivalLag(s.distance);

    this.spatial.set(s.azimuth, s.elevation, at);

    // The shove. Sub only, so it is immune to the medium and arrives whatever
    // the cloud is doing. Two components: a 14 Hz half cycle that is felt, and a
    // 55 Hz thump so it is audible on hardware with no bottom octave.
    for (const [f, g, d] of [[14, 0.5, 0.5], [55, 0.28, 0.22]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, at + d);
      const e = ctx.createGain();
      e.gain.setValueAtTime(SAFE, at);
      e.gain.exponentialRampToValueAtTime(pos(g * geo * p.level), at + 0.012);
      e.gain.exponentialRampToValueAtTime(SAFE, at + d);
      o.connect(e);
      e.connect(this.spatial.input);   // never through this.medium
      o.start(at); o.stop(at + d + 0.05);
    }

    const t = at + lag;
    this.lastCallAt = t;

    // The call itself. Partial stretch is the piano formula: at beta = 0.085 the
    // fourth partial is 8% sharp and the stack refuses to fuse into a pitch —
    // it is heard as a phenomenon. At 0.004 it fuses, and a fused stack in this
    // register is unmistakably a voice addressing you.
    const drift = p.driftSemitones === 0 ? 0
      : Math.sin(this.pitchPhase + t * TAU * p.driftHz) * p.driftSemitones;
    const f0 = Math.max(this.def.f0, 8) * Math.pow(2, drift / 12);
    const beta = p.stretch;

    for (let n = 1; n <= this.def.partials; n++) {
      const fn = f0 * n * Math.sqrt(1 + beta * (n * n - 1));
      if (fn > 18000) break;
      const o = ctx.createOscillator();
      o.type = n === 1 ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(fn, t);
      const e = ctx.createGain();
      const g = 0.20 * Math.pow(n, -this.def.partialTilt) * p.level;
      e.gain.setValueAtTime(SAFE, t);
      e.gain.exponentialRampToValueAtTime(pos(g), t + p.attack);
      e.gain.exponentialRampToValueAtTime(SAFE, t + p.attack + p.decay);
      o.connect(e); e.connect(this.source);
      o.start(t); o.stop(t + p.attack + p.decay + 0.05);
    }

    if (this.def.breath > 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 3);
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(this.def.breathCentre, t);
      bp.frequency.exponentialRampToValueAtTime(
        Math.max(60, this.def.breathCentre * 0.45), t + p.attack + p.decay);
      bp.Q.value = this.def.breathQ ?? 1.1;
      const e = ctx.createGain();
      e.gain.setValueAtTime(SAFE, t);
      e.gain.exponentialRampToValueAtTime(pos(0.20 * this.def.breath * p.level), t + p.attack);
      e.gain.exponentialRampToValueAtTime(SAFE, t + p.attack + p.decay);
      src.connect(bp); bp.connect(e); e.connect(this.source);
      src.start(t); src.stop(t + p.attack + p.decay + 0.1);
    }

    return t;
  }

  dispose() {
    try { this.subA.stop(); this.subB.stop(); this.lfo.stop(); } catch { /* not started */ }
    try { if (this.sweepSrc) this.sweepSrc.stop(); } catch { /* not started */ }
    this.spatial.dispose();
  }
}

/** Shared white noise, cached per context. Regenerating it per voice is a stall. */
const _noiseCache = new WeakMap();
export function noiseBuffer(ctx, seconds = 2) {
  let byLen = _noiseCache.get(ctx);
  if (!byLen) { byLen = new Map(); _noiseCache.set(ctx, byLen); }
  if (byLen.has(seconds)) return byLen.get(seconds);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    d[i] = (s / 2147483648) - 1;
  }
  byLen.set(seconds, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

/**
 * Engine, hull and airflow.
 *
 * The engine is the loudest thing the player controls and therefore the main
 * thing standing between them and the information they need. That is the design:
 * the engine masks the 200 Hz to 2 kHz band where the Wake Hunter lives and where
 * the searching sweep sits, so running hot is not only *emitting* signature, it
 * is *deafening you*. Cutting the engine does not add a sound, it removes one,
 * and the cloud is revealed underneath.
 */
export const SHIP = Object.freeze({
  RPM_LO: 46, RPM_HI: 132,          // Hz, fundamental across the throttle range
  HARMONICS: [1, 2, 3, 4.5],
  HARMONIC_GAIN: [1.0, 0.55, 0.32, 0.14],
  BOOST_NOISE_HZ: 1400,
  HULL_MODES: [63, 108, 171, 268],  // structural resonances the creaks ring on
  CREAK_MIN_S: 0.35, CREAK_MAX_S: 9.0,
  GROAN_STRESS: 0.60,
  TICK_STRESS: 0.85,
});

class ShipVoice {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.rand = mulberry32(0x51f3a2);

    this.engine = audio.drone({ freq: SHIP.RPM_LO, type: 'sawtooth', bus: 'sfx', gain: 0, filter: 700 });
    this.harm = SHIP.HARMONICS.slice(1).map((m, i) =>
      audio.drone({ freq: SHIP.RPM_LO * m, type: 'triangle', bus: 'sfx', gain: 0, filter: 1800 }));

    this.wind = audio.drone({ freq: 90, type: 'sine', bus: 'sfx', gain: 0, filter: 400 });
    this.groan = audio.drone({ freq: SHIP.HULL_MODES[0], type: 'sawtooth', bus: 'sfx', gain: 0, filter: 260 });

    this.creakTimer = 2.0;
    this.tickTimer = 0.5;
    this.windSrc = null;
    this._buildWind();
  }

  _buildWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 3);
    src.loop = true;
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = 'bandpass';
    this.windBP.frequency.value = 500;
    this.windBP.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windBP); this.windBP.connect(this.windGain);
    this.windGain.connect(this.audio.buses.sfx);
    src.start();
    this.windSrc = src;
  }

  update(dt, s) {
    const t = this.ctx.currentTime;
    const sh = s.ship;
    const rpm = lerp(SHIP.RPM_LO, SHIP.RPM_HI, clamp01(sh.rpm01 + sh.boost * 0.25));

    // Turbulence wobbles the intake, so the engine's pitch is not steady in rough
    // air. This is the cue that tells a player they have entered shear before the
    // instruments do.
    const wob = 1 + Math.sin(t * 7.3) * 0.012 * s.medium.turbulence01;
    const load = clamp01(sh.rpm01 * 0.8 + sh.boost * 0.5);

    this.engine.setFreq(rpm * wob, 0.05);
    this.engine.setGain(0.16 * load, 0.10);
    this.engine.setFilter(lerp(420, 2600, load), 0.15);
    for (let i = 0; i < this.harm.length; i++) {
      this.harm[i].setFreq(rpm * SHIP.HARMONICS[i + 1] * wob, 0.05);
      this.harm[i].setGain(0.16 * load * SHIP.HARMONIC_GAIN[i + 1] * (0.4 + sh.boost * 0.6), 0.12);
    }

    // Airflow. Centre frequency tracks speed, gain tracks speed and turbulence.
    const spd = clamp01(sh.speed / 90);
    this.windBP.frequency.setTargetAtTime(lerp(220, 1600, spd), t, tau(0.2));
    this.windBP.Q.setTargetAtTime(lerp(0.9, 0.35, s.medium.turbulence01), t, tau(0.3));
    ramp(this.windGain.gain, 0.05 + 0.16 * spd + 0.10 * s.medium.turbulence01, t, 0.2);

    // Low-frequency buffeting rides on the same term, well below the engine, so
    // it is still readable at full throttle.
    this.wind.setFreq(lerp(70, 118, s.medium.turbulence01), 0.3);
    this.wind.setGain(0.10 * s.medium.turbulence01 * (0.4 + spd), 0.25);

    // Hull. Creak rate is exponential in stress: at 0.2 it is background, at 0.9
    // it is continuous, and the change between them is felt long before the gauge
    // moves.
    const stress = clamp01(sh.hullStress01 + (1 - sh.integrity01) * 0.35);
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creak(stress);
      const rate = lerp(SHIP.CREAK_MAX_S, SHIP.CREAK_MIN_S, Math.pow(stress, 0.6));
      this.creakTimer = rate * (0.5 + this.rand());
    }

    this.groan.setFreq(SHIP.HULL_MODES[0] * lerp(1.0, 0.86, 1 - sh.integrity01), 0.5);
    this.groan.setGain(0.11 * smoothstep(SHIP.GROAN_STRESS, 1.0, stress), 0.4);

    // Above the tick threshold the hull emits a sparse metallic tick that has no
    // other meaning: it exists only to say the structure is about to fail. It is
    // the one sound in the game that is a warning and nothing else.
    if (stress > SHIP.TICK_STRESS) {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.audio.tone({ freq: 2600 + this.rand() * 900, type: 'square', bus: 'sfx',
          gain: 0.05, attack: 0.001, decay: 0.05 });
        this.tickTimer = 0.18 + this.rand() * 0.22;
      }
    }
  }

  creak(stress) {
    const mode = SHIP.HULL_MODES[(this.rand() * SHIP.HULL_MODES.length) | 0];
    const g = 0.03 + 0.10 * stress;
    this.audio.noise({ bus: 'sfx', gain: g * 0.6, attack: 0.004,
      decay: 0.22 + stress * 0.5, filter: 'bandpass', freq: mode * 3.2, q: 3.5,
      sweepTo: mode * 1.4, pan: this.rand() * 1.6 - 0.8 });
    this.audio.tone({ freq: mode, type: 'triangle', bus: 'sfx',
      gain: g, attack: 0.006, decay: 0.5 + stress * 0.9 });
  }

  dispose() {
    this.engine.stop(); this.groan.stop(); this.wind.stop();
    for (const h of this.harm) h.stop();
    try { this.windSrc.stop(); } catch { /* not started */ }
  }
}

// ---------------------------------------------------------------------------
// Ambience, electrical activity, risk and concealment
// ---------------------------------------------------------------------------

export const AMBIENCE = Object.freeze({
  // Reverb shape is the density readout, and it is deliberately not level. Clear
  // air is a long thin dry tail; dense cloud is a short close wet one. That gives
  // density its own dimension, so it cannot be confused with distance, which is
  // carried by the direct-to-scatter *ratio* rather than by the tail's shape.
  WET_CLEAR: 0.10, WET_DENSE: 0.42,
  TILT_CLEAR: 9000, TILT_DENSE: 800,

  // Detection risk removes a band rather than adding a sound. A hole at 1 kHz in
  // an otherwise continuous ambience reads as something listening, and it costs
  // no headroom at the moment the mix is busiest.
  RISK_NOTCH_HZ: 1000, RISK_NOTCH_DB: -18, RISK_NOTCH_Q: 1.1,

  // Concealment is the only comfort in the language: close, soft, high, and
  // present only when the ship is quiet inside dense cloud.
  VEIL_HZ: 5200, VEIL_GAIN: 0.055,

  DISCHARGE_WARN_S: 0.40,   // the crackle stops before the strike
});

class Ambience {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.rand = mulberry32(0x2b71c9);

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 3);
    src.loop = true;

    this.tilt = ctx.createBiquadFilter();
    this.tilt.type = 'lowpass';
    this.tilt.frequency.value = AMBIENCE.TILT_CLEAR;
    this.tilt.Q.value = 0.5;

    this.riskNotch = ctx.createBiquadFilter();
    this.riskNotch.type = 'peaking';
    this.riskNotch.frequency.value = AMBIENCE.RISK_NOTCH_HZ;
    this.riskNotch.Q.value = AMBIENCE.RISK_NOTCH_Q;
    this.riskNotch.gain.value = 0;

    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0.03;

    src.connect(this.tilt); this.tilt.connect(this.riskNotch);
    this.riskNotch.connect(this.bedGain);
    this.bedGain.connect(audio.buses.sfx);
    src.start();
    this.bedSrc = src;

    // Veil — concealment.
    const vs = ctx.createBufferSource();
    vs.buffer = noiseBuffer(ctx, 3);
    vs.loop = true;
    this.veilBP = ctx.createBiquadFilter();
    this.veilBP.type = 'bandpass';
    this.veilBP.frequency.value = AMBIENCE.VEIL_HZ;
    this.veilBP.Q.value = 0.7;
    this.veilGain = ctx.createGain();
    this.veilGain.gain.value = 0;
    vs.connect(this.veilBP); this.veilBP.connect(this.veilGain);
    this.veilGain.connect(audio.buses.sfx);
    vs.start();
    this.veilSrc = vs;

    this.reverb = audio.reverb({ seconds: 2.6, decay: 2.4, wet: AMBIENCE.WET_CLEAR });
    this.crackleTimer = 1;
    this.dischargeArmed = 0;
  }

  update(dt, s) {
    const t = this.ctx.currentTime;
    const d = clamp01(s.medium.density01);

    this.tilt.frequency.setTargetAtTime(lerp(AMBIENCE.TILT_CLEAR, AMBIENCE.TILT_DENSE, d), t, tau(0.6));
    ramp(this.bedGain.gain, lerp(0.030, 0.016, d), t, 0.5);
    if (this.reverb) ramp(this.reverb.wetGain.gain, lerp(AMBIENCE.WET_CLEAR, AMBIENCE.WET_DENSE, d), t, 0.8);

    ramp(this.riskNotch.gain, AMBIENCE.RISK_NOTCH_DB * clamp01(s.risk01), t, 0.9);
    ramp(this.veilGain.gain, AMBIENCE.VEIL_GAIN * clamp01(s.concealment01), t, 0.7);

    // Electrical. Crackle rate is exponential in charge, and the 400 ms of
    // silence immediately before a discharge is the only warning — a sound
    // stopping, again, rather than a sound starting.
    const q = clamp01(s.medium.charge01);
    if (this.dischargeArmed > 0) {
      this.dischargeArmed -= dt;
    } else if (q > 0.02) {
      this.crackleTimer -= dt * (0.4 + q * 14);
      if (this.crackleTimer <= 0) {
        this.crackleTimer = 1;
        this.audio.noise({ bus: 'sfx', gain: 0.02 + 0.05 * q, attack: 0.001, decay: 0.03 + this.rand() * 0.05,
          filter: 'bandpass', freq: 2200 + this.rand() * 4200, q: 4, pan: this.rand() * 1.8 - 0.9 });
      }
    }
  }

  /** Arm the pre-strike silence, then the strike. */
  discharge(azimuth = 0, strength = 1) {
    this.dischargeArmed = AMBIENCE.DISCHARGE_WARN_S;
    const a = this.audio;
    const t = a.time + AMBIENCE.DISCHARGE_WARN_S;
    const pan = clamp(Math.sin(azimuth), -1, 1);
    a.noise({ bus: 'sfx', gain: 0.5 * strength, attack: 0.001, decay: 0.35,
      filter: 'highpass', freq: 1800, q: 0.7, pan, when: t });
    a.tone({ freq: 62, type: 'sine', bus: 'sfx', gain: 0.42 * strength,
      attack: 0.004, decay: 1.1, glideTo: 30, glideTime: 0.9, when: t });
    a.duck('music', 0.25, 0.5, 1.6);
  }

  dispose() {
    try { this.bedSrc.stop(); this.veilSrc.stop(); } catch { /* not started */ }
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Instrument reliability, made audible.
 *
 * An unreliable instrument must not simply be wrong, because a player cannot
 * learn from a reading that is silently false. It has to *sound* unreliable, so
 * that doubt is information rather than noise. Three things degrade together:
 * the ping's onset jitters in time, a detuned second copy appears, and some
 * fraction of pings are phantoms with no contact behind them.
 */
export const INSTRUMENTS = Object.freeze({
  PING_HZ: 1180,
  JITTER_MAX_S: 0.090,
  DETUNE_MAX_CENTS: 45,
  PHANTOM_MAX: 0.35,
});

class InstrumentVoice {
  constructor(audio) {
    this.audio = audio;
    this.rand = mulberry32(0x77aa31);
    this.reliability = 1;
  }

  update(dt, s) { this.reliability = clamp01(s.instruments?.reliability01 ?? 1); }

  /** @returns {boolean} true if the ping was a phantom */
  ping({ azimuth = 0, distance = 400, real = true } = {}) {
    const r = this.reliability;
    const unreliability = 1 - r;
    const phantom = real && this.rand() < unreliability * INSTRUMENTS.PHANTOM_MAX;
    const when = this.audio.time + this.rand() * unreliability * INSTRUMENTS.JITTER_MAX_S;
    const pan = clamp(Math.sin(azimuth) * 0.8, -1, 1);
    const g = 0.10 * lerp(1, 0.55, clamp01(distance / 1200));

    this.audio.tone({ freq: INSTRUMENTS.PING_HZ, type: 'sine', bus: 'ui',
      gain: g, attack: 0.002, decay: 0.20, pan, when });
    if (unreliability > 0.05) {
      this.audio.tone({ freq: INSTRUMENTS.PING_HZ, type: 'sine', bus: 'ui',
        gain: g * 0.7 * unreliability, attack: 0.002, decay: 0.20, pan: -pan,
        detune: unreliability * INSTRUMENTS.DETUNE_MAX_CENTS, when: when + 0.012 });
    }
    return phantom;
  }
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * Music as a threat model.
 *
 * There is no calm cue and no combat cue. Seven layers, each gated by a
 * continuous quantity, summed — and then the whole thing multiplied by the
 * subtraction rule below.
 *
 * The subtraction rule is the point of the entire score. `terror` rises only
 * when a creature is simultaneously near, certain, and fixed on the player, and
 * at full terror the music is at 15% of its level. The most dangerous moment in
 * the game is the quietest, because at that moment every scrap of attention the
 * player has should be on the diegetic signal — the stroke modulation, the
 * interval between shove and call — and a score competing for the same
 * frequencies would be actively taking information away from them.
 */
export const SCORE = Object.freeze({
  LAYERS: [
    { name: 'bed',      freq: 38.9,  type: 'sine',     gain: 0.075, filter: 300 },
    { name: 'depth',    freq: 58.3,  type: 'triangle', gain: 0.060, filter: 420 },
    { name: 'unease',   freq: 622.3, type: 'sine',     gain: 0.020, filter: 2400 },
    { name: 'uneaseB',  freq: 625.9, type: 'sine',     gain: 0.020, filter: 2400 },  // 3.6 Hz beat
    { name: 'pressure', freq: 77.8,  type: 'sawtooth', gain: 0.055, filter: 520 },
    { name: 'wound',    freq: 29.1,  type: 'sine',     gain: 0.070, filter: 200 },
    { name: 'flight',   freq: 155.6, type: 'sawtooth', gain: 0.045, filter: 1300 },
  ],
  TERROR_NEAR_M: 600, TERROR_CLOSE_M: 180,
  TERROR_DUCK: 0.85,        // at full terror the score is at 15%
  RELIEF_S: 6.0,            // silence after an escape, before anything returns
});

class Score {
  constructor(audio) {
    this.audio = audio;
    this.layers = SCORE.LAYERS.map((L) => ({
      def: L,
      voice: audio.drone({ freq: L.freq, type: L.type, bus: 'music', gain: 0, filter: L.filter }),
    }));
    this.relief = 0;
    this.terror = 0;
  }

  update(dt, s, derived) {
    const sh = s.ship;
    const { certainty01, detected01, nearest } = derived;

    // Terror needs all three: near, certain, and known to be fixed. Two out of
    // three keeps the music — being hunted at range should feel scored, being
    // found at close range should not.
    const proximity = smoothstep(SCORE.TERROR_NEAR_M, SCORE.TERROR_CLOSE_M, nearest);
    const target = certainty01 * detected01 * proximity;
    this.terror += (target - this.terror) * (1 - Math.exp(-2.5 * dt));

    if (this.relief > 0) this.relief -= dt;

    const drive = {
      bed: 1,
      depth: clamp01(s.safetyDistance01),
      unease: certainty01,
      uneaseB: certainty01,
      pressure: detected01,
      wound: 1 - clamp01(sh.integrity01),
      flight: s.escaping ? 1 : 0,
    };

    const scale = (1 - SCORE.TERROR_DUCK * this.terror)
      * (this.relief > 0 ? 0 : 1)
      * lerp(0.65, 1.0, clamp01(s.medium.visibility01))
      * lerp(0.7, 1.0, clamp01(sh.energy01));

    for (const L of this.layers) {
      L.voice.setGain(L.def.gain * (drive[L.def.name] ?? 0) * scale, 0.9);
      // Damage pulls the whole score flat by up to 90 cents. Nothing announces
      // it; the world simply stops being in tune with itself.
      const detuneOct = -0.075 * (1 - clamp01(sh.integrity01));
      L.voice.setFreq(L.def.freq * Math.pow(2, detuneOct), 1.2);
      L.voice.setFilter(L.def.filter * lerp(0.45, 1.0, clamp01(s.medium.visibility01)), 1.0);
    }
  }

  /** Called on escape or on a creature losing the player. Silence, then return. */
  relieve(seconds = SCORE.RELIEF_S) { this.relief = seconds; }

  dispose() { for (const L of this.layers) L.voice.stop(); }
}

// ---------------------------------------------------------------------------
// AudioLanguage
// ---------------------------------------------------------------------------

export class AudioLanguage {
  constructor() {
    this.audio = null;
    this.ctx = null;
    this.attached = false;
    this.voices = new Map();   // contact id -> CreatureVoice
    this._seed = 0x1a2b3c;
  }

  static idleState() { return idleState(); }

  /** @param {import('../core/audio.js').Audio} audio a started instance */
  attach(audio) {
    if (this.attached || !audio || !audio.started) return false;
    this.audio = audio;
    this.ctx = audio.ctx;
    this.ambience = new Ambience(audio);
    this.ship = new ShipVoice(audio);
    this.instruments = new InstrumentVoice(audio);
    this.score = new Score(audio);
    this.attached = true;
    return true;
  }

  detach() {
    if (!this.attached) return;
    for (const v of this.voices.values()) v.dispose();
    this.voices.clear();
    this.ship.dispose(); this.ambience.dispose(); this.score.dispose();
    this.attached = false;
  }

  /**
   * One fixed step.
   *
   * Deliberately tolerant of a missing or partial state, because audio must never
   * be the reason a frame throws. A silent game is a bug; a game that stops
   * rendering because the mixer disagreed about a field name is a catastrophe.
   */
  update(dt, state) {
    if (!this.attached) return;
    const s = state || idleState();
    if (!s.ship || !s.medium) return;

    const contacts = s.contacts || [];

    // Contacts come and go; the voice graph must follow without churn, because
    // building a Spatialiser is thirteen nodes and doing it per frame audibly
    // stutters the audio thread.
    const seen = new Set();
    let nearest = 4000;
    let certainty = 0;
    let detected = 0;

    for (const c of contacts) {
      seen.add(c.id);
      let v = this.voices.get(c.id);
      if (!v) {
        v = new CreatureVoice(this.ctx, this.audio.buses.sfx,
          this.ambience.reverb ? this.ambience.reverb.node : null,
          { kind: c.kind, seed: (this._seed = (this._seed * 1664525 + 1013904223) >>> 0) });
        v.start();
        this.voices.set(c.id, v);
      }
      v.set({
        distance: c.distance, azimuth: c.azimuth, elevation: c.elevation || 0,
        awareness: c.awareness || 0, density01: s.medium.density01,
      });
      v.spatial.set(c.azimuth, c.elevation || 0);
      v.pump();

      nearest = Math.min(nearest, c.distance);
      certainty = Math.max(certainty, smoothstep(1600, 400, c.distance));
      detected = Math.max(detected, clamp01((c.awareness || 0) - 1));
    }

    for (const [id, v] of this.voices) {
      if (!seen.has(id)) { v.dispose(); this.voices.delete(id); }
    }

    this.ship.update(dt, s);
    this.ambience.update(dt, s);
    this.instruments.update(dt, s);
    this.score.update(dt, s, { certainty01: certainty, detected01: detected, nearest });
  }

  /** One-shots the simulation cannot schedule ahead. */
  event(name, opts = {}) {
    if (!this.attached) return null;
    switch (name) {
      case 'discharge': return this.ambience.discharge(opts.azimuth || 0, opts.strength ?? 1);
      case 'ping':      return this.instruments.ping(opts);
      case 'creak':     return this.ship.creak(clamp01(opts.stress ?? 0.5));
      case 'relief':    return this.score.relieve(opts.seconds);
      default:          return null;
    }
  }
}

// ===========================================================================
// Analysis
//
// Everything below is pure: Float32Array in, numbers out, no WebAudio. It is
// what turns "this sounds like distance" into a figure that can be argued with.
// ===========================================================================

/** RBJ biquad coefficients. Only the three shapes the analysis needs. */
export function biquadCoeffs(type, f0, Q, sr) {
  const w0 = TAU * f0 / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }   // bandpass, constant peak gain
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function filterInPlace(x, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

/** Two cascaded sections each side, so a "band" is actually a band. */
export function band(x, sr, lo, hi) {
  const out = Float32Array.from(x);
  if (lo > 0) { const c = biquadCoeffs('highpass', lo, 0.707, sr); filterInPlace(out, c); filterInPlace(out, c); }
  if (hi < sr / 2) { const c = biquadCoeffs('lowpass', hi, 0.707, sr); filterInPlace(out, c); filterInPlace(out, c); }
  return out;
}

export function rms(x, from = 0, to = x.length) {
  let s = 0; const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
}

/** Single-frequency magnitude. Cheaper than an FFT when a handful of bins will do. */
export function goertzel(x, sr, f, from = 0, to = x.length) {
  const k = 2 * Math.cos(TAU * f / sr);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = x[i] + k * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const n = Math.max(1, to - from);
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (n / 2);
}

/**
 * Rectify and smooth, with independent attack and release corners.
 *
 * Both corners are needed, and an instant-attack peak follower will not do. The
 * onset detector below compares a fast envelope against a slow one, and if the
 * slow one also attacks instantly the two rise together and their ratio at an
 * onset is exactly 1 — the detector then fires on nothing and misses everything.
 *
 * `poles` is not decoration either. A one-pole follower at 60 Hz applied to the
 * sub band tracks the *waveform* of a 27 Hz carrier rather than its envelope,
 * and every measurement downstream then describes the oscillator instead of the
 * creature. Anything below MEDIUM.SUB_HINGE needs two poles and a corner well
 * under the carrier; rectification puts the ripple at twice the carrier, so two
 * poles at 8 Hz leave about 2% of it.
 */
export function envelope(x, sr, attackHz, releaseHz = attackHz, poles = 1) {
  let src = x;
  let out = null;
  for (let p = 0; p < Math.max(1, poles); p++) {
    const ka = Math.exp(-TAU * attackHz / sr);
    const kr = Math.exp(-TAU * releaseHz / sr);
    out = new Float32Array(src.length);
    let y = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i] < 0 ? -src[i] : src[i];
      const k = v > y ? ka : kr;
      y = y * k + v * (1 - k);
      out[i] = y;
    }
    src = out;
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[i];
}

/**
 * Onset detector settings, per register.
 *
 * The two bands need different followers for the reason given on `envelope`:
 * the sub band carries a 27–58 Hz carrier and cannot be followed quickly, the
 * upper band carries nothing below 120 Hz and can.
 *
 * THRESHOLD is the one number here that was tuned rather than derived, and it is
 * the first thing to adjust if the test misbehaves — see the tuning order in
 * AUDIO_LANGUAGE.md §9. Too low and the presence layer's own swell trips it a
 * hundred times a minute; too high and only the sharpest calls register.
 */
export const ONSET = Object.freeze({
  SUB: Object.freeze({ fastHz: 12, slowHz: 0.7, poles: 2 }),
  UPPER: Object.freeze({ fastHz: 60, slowHz: 0.7, poles: 1 }),
  THRESHOLD: 2.2,
  // 0.25 s is the smallest gap the detector will resolve, which sets the closest
  // range the time cue can measure: 0.25 / LAG_PER_M is about 118 m. At 118 m
  // the near-field modulation depth is 0.47, so the two cues hand over with a
  // wide overlap rather than leaving a hole.
  MIN_GAP_S: 0.25,
});

export function onsets(x, sr, {
  fastHz = ONSET.UPPER.fastHz, slowHz = ONSET.UPPER.slowHz, poles = ONSET.UPPER.poles,
  threshold = ONSET.THRESHOLD, minGapS = ONSET.MIN_GAP_S,
} = {}) {
  const fast = envelope(x, sr, fastHz, fastHz / 5, poles);
  const slow = envelope(x, sr, slowHz, slowHz * 0.7, poles);
  const minGap = Math.floor(minGapS * sr);
  const out = [];
  let last = -minGap;
  // A floor relative to the record's own level, never an absolute one: these
  // buffers span forty decibels of attenuation and a fixed threshold would only
  // ever work at one distance.
  const floor = percentile(Float32Array.from(slow).sort(), 70) * 0.12 + 1e-9;
  for (let i = 1; i < x.length; i++) {
    if (i - last < minGap) continue;
    if (slow[i] < floor) continue;
    if (fast[i] >= slow[i] * threshold) { out.push(i / sr); last = i; }
  }
  return out;
}

/**
 * Period and strength of an event train, by normalised autocorrelation.
 *
 * Takes onset *times*, not an envelope. Correlating the envelope directly does
 * not work here and the failure is silent: the strongest periodicity in the sub
 * band is the stroke modulation, not the call train, so the measurement returns
 * the creature's swimming rate and the caller then excludes that frequency from
 * the stroke search — deleting the very cue it was looking for. Onsets contain
 * events only, and the stroke swell produces none.
 *
 * The shove and call trains interleave, offset by the arrival lag. That adds a
 * second peak at the offset rather than at the interval, but both trains
 * contribute to the true peak and only the cross term contributes to the
 * spurious one, so the true period wins by roughly two to one.
 */
export function periodicity(times, { minLagS = 0.9, maxLagS = 22, dsHz = 50, totalS = null } = {}) {
  if (!times || times.length < 3) return { periodS: null, strength: 0 };
  const total = totalS || (times[times.length - 1] + 1);
  const n = Math.floor(total * dsHz);
  if (n < 16) return { periodS: null, strength: 0 };

  const d = new Float32Array(n);
  // Each onset is smeared over a few bins so that a one-bin timing wobble cannot
  // null the correlation peak outright.
  const kern = [0.25, 0.5, 1.0, 0.5, 0.25];
  for (const t of times) {
    const c = Math.round(t * dsHz);
    for (let j = 0; j < kern.length; j++) {
      const i = c + j - 2;
      if (i >= 0 && i < n) d[i] += kern[j];
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) { d[i] -= mean; energy += d[i] * d[i]; }
  if (energy < 1e-18) return { periodS: null, strength: 0 };

  const lo = Math.max(1, Math.floor(minLagS * dsHz));
  const hi = Math.min(n - 4, Math.floor(maxLagS * dsHz));
  let bestLag = -1, best = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += d[i] * d[i + lag];
    // Normalise by the overlap so long lags are not penalised for having fewer
    // samples, which would bias every measurement toward short periods.
    const r = acc / (energy * (1 - lag / n) + 1e-18);
    if (r > best) { best = r; bestLag = lag; }
  }
  if (bestLag < 0) return { periodS: null, strength: 0 };
  return { periodS: bestLag / dsHz, strength: clamp01(best) };
}

/**
 * Loss of the two-pole envelope follower plus the rectifier, measured rather
 * than derived.
 *
 * A sinusoidal modulation of index D, taken through `envelope(sub, 8, 8, 2)` and
 * read at its own frequency, comes back at 0.895·D — consistently across the
 * whole usable range. Without the correction the depth reads low, which inverts
 * into a distance that reads *high*, which is the reassuring direction and
 * therefore the dangerous one.
 *
 * Verified against a synthetic presence layer at 60 to 500 m; residual error
 * after correction is about 1% out to 300 m and 6% at 400 m.
 */
export const AM_CALIBRATION = 0.895;

/**
 * Depth of a sinusoidal amplitude modulation, as a single spectral line.
 *
 * `depth = |E(f)| / mean(E)`, which for `E = M·(1 + D·sin(2πft))` returns D.
 * Measuring it that way rather than as a spread of the envelope's values is what
 * makes it usable: a call transient is broadband in the envelope domain and is
 * diluted across the whole record at any one frequency, and whatever ripple the
 * follower leaves on the carrier sits two octaves above the stroke band.
 *
 * `strokeHz` is the normal path. The game knows a contact's stroke rate as soon
 * as it has identified what the contact *is*, which happens by register and
 * timbre long before ranging matters — so the search is the fallback, not the
 * design. The test exercises both.
 */
export function modulationDepth(env, sr, { strokeHz = null, excludeHz = null, dsHz = 50 } = {}) {
  const step = Math.max(1, Math.floor(sr / dsHz));
  const n = Math.floor(env.length / step);
  if (n < 16) return { depth: 0, strokeHz: null, mean: 0 };

  const d = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { d[i] = env[i * step]; mean += d[i]; }
  mean /= n;
  if (mean < 1e-12) return { depth: 0, strokeHz: null, mean };
  for (let i = 0; i < n; i++) d[i] -= mean;

  const at = (f) => clamp01(goertzel(d, dsHz, f) / mean / AM_CALIBRATION);

  if (strokeHz) return { depth: at(strokeHz), strokeHz, mean };

  // Grid step, from the record length rather than picked by eye. An unwindowed
  // Goertzel's main lobe is 1/T wide, so a grid coarser than that steps straight
  // over the peak and under-reports the depth — which inverts into a distance
  // that reads too far. A quarter-lobe grid holds scalloping loss under 3%.
  const T = n / dsHz;
  const df = Math.max(0.0008, 0.25 / T);

  // The call rate and its second harmonic are excluded. A creature fixed on the
  // player calls every two seconds — 0.5 Hz, squarely inside the plausible
  // stroke range — and locking onto it would report a large depth and therefore
  // a distance of nearly nothing, at exactly the moment being wrong about the
  // distance matters most. The exclusion stops at the second harmonic and is
  // kept narrow because the Lantern's 1.6 Hz stroke sits close to the third.
  const blocked = (f) => {
    if (!excludeHz) return false;
    for (let k = 1; k <= 2; k++) {
      const h = excludeHz * k;
      if (Math.abs(f - h) < h * 0.08) return true;
    }
    return false;
  };

  let bestF = null, bestV = 0;
  for (let f = 0.20; f <= 2.0001; f += df) {
    if (blocked(f)) continue;
    const v = at(f);
    if (v > bestV) { bestV = v; bestF = f; }
  }
  return { depth: bestV, strokeHz: bestF, mean };
}

/**
 * Everything measurable about a rendered buffer.
 *
 * Ordered so each measurement can use the ones before it: the event trains are
 * found first, because the call rate is needed to keep the stroke search off it.
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sr
 * @param {object} [opts] `strokeHz` pins the modulation search to a known rate.
 */
export function describe(left, right, sr, opts = {}) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;

  const top = Math.min(8000, sr * 0.45);
  const sub = band(mono, sr, 18, MEDIUM.SUB_HINGE);
  const low = band(mono, sr, MEDIUM.SUB_HINGE, 500);
  const mid = band(mono, sr, 500, 2000);
  const high = band(mono, sr, 2000, top);
  const upper = band(mono, sr, MEDIUM.SUB_HINGE, top);

  const skip = Math.floor(sr * 0.5);          // let the filters settle
  const seconds = mono.length / sr;

  // Onsets are found twice, in two registers, because the record contains two
  // different events that must not be confused.
  //
  // The shove is sub only — it is a compression through the body of the cloud
  // and has no upper content by construction. The call does have upper content
  // whenever the medium still passes any. So the band above the hinge finds
  // calls and only calls, and the band below finds both. That is exactly how the
  // player separates them: by register, not by loudness.
  //
  // When the medium has closed down to its 140 Hz floor there is no upper band
  // left and both events land in the sub list. They remain separable there
  // because they are spaced by the arrival lag, which is what is being measured.
  const onSub = onsets(sub, sr, ONSET.SUB);
  const onCall = onsets(upper, sr, ONSET.UPPER);
  const hasUpper = rms(upper, skip) > rms(sub, skip) * 0.02 && onCall.length >= 3;
  const on = onCall.length >= 2 ? onCall : onSub;

  const per = periodicity(hasUpper ? onCall : onSub, { totalS: seconds });

  // Modulation depth inside the sub band — the close-range distance cue.
  const senv = envelope(sub, sr, 8, 8, 2);
  const dep = modulationDepth(senv, sr, {
    strokeHz: opts.strokeHz || null,
    excludeHz: per.periodS ? 1 / per.periodS : null,
  });

  // Direct-to-scatter, and rise time.
  //
  // Both are measured on the upper band only. Rise time cannot be taken from the
  // sub band at all: the presence layer holds a slowly swelling pedestal there,
  // and a 10-to-90% measurement across it returns the width of the search window
  // for every call regardless of how fast the call actually was. When the medium
  // has closed the upper band there is therefore no rise-time feature, and
  // awareness has to be read from period and regularity alone — which is a real
  // limitation of the language in the worst cloud, not of this function.
  let dr = null, attackMs = null;
  if (hasUpper && onCall.length > 0) {
    const uenv = envelope(upper, sr, 25, 25, 1);
    const drs = [], atk = [];
    for (const t of onCall) {
      const i0 = Math.floor(t * sr);
      const iD = Math.min(mono.length, i0 + Math.floor(0.060 * sr));
      const iS0 = Math.min(mono.length, i0 + Math.floor(0.300 * sr));
      const iS1 = Math.min(mono.length, i0 + Math.floor(0.900 * sr));
      if (iS1 - iS0 >= sr * 0.1) {
        const dRms = rms(mono, i0, iD), sRms = rms(mono, iS0, iS1);
        if (sRms > 1e-8) drs.push(20 * Math.log10(dRms / sRms));
      }

      // Measured against the local pedestal rather than against zero, and
      // searched backwards from the detected onset — a slow swell begins long
      // before it trips a detector, and measuring its rise from the trip point
      // would report every call as fast, collapsing the feature that separates
      // the awareness states most cleanly.
      const a = Math.max(0, i0 - Math.floor(1.8 * sr));
      const b = Math.min(uenv.length, i0 + Math.floor(0.30 * sr));
      if (b - a < 10) continue;
      let peak = 0, base = Infinity;
      for (let i = a; i < b; i++) { if (uenv[i] > peak) peak = uenv[i]; if (uenv[i] < base) base = uenv[i]; }
      if (!(peak > base * 1.5)) continue;
      const loT = base + 0.1 * (peak - base), hiT = base + 0.9 * (peak - base);
      let t10 = -1, t90 = -1;
      for (let i = a; i < b; i++) {
        if (t10 < 0 && uenv[i] >= loT) t10 = i;
        if (t10 >= 0 && uenv[i] >= hiT) { t90 = i; break; }
      }
      if (t10 >= 0 && t90 > t10) atk.push((t90 - t10) / sr * 1000);
    }
    if (drs.length) { drs.sort((a2, b2) => a2 - b2); dr = percentile(drs, 50); }
    if (atk.length) { atk.sort((a2, b2) => a2 - b2); attackMs = percentile(atk, 50); }
  }

  // Interaural time difference, by cross-correlation of the low band where the
  // cue actually lives. Windowed to six seconds: the lag is constant for the
  // whole record, so correlating eighty seconds of it costs eighty times as much
  // and answers the same question.
  const lLow = band(left, sr, 60, 900), rLow = band(right, sr, 60, 900);
  const maxLag = Math.ceil(0.0012 * sr);
  const winFrom = Math.min(skip, Math.max(0, lLow.length - 1));
  const winTo = Math.min(lLow.length, winFrom + Math.floor(6 * sr));
  let best = -Infinity, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0;
    const from = Math.max(winFrom, -lag);
    const to = Math.min(winTo, lLow.length - Math.max(0, lag));
    for (let i = from; i < to; i += 2) acc += lLow[i] * rLow[i + lag];
    if (acc > best) { best = acc; bestLag = lag; }
  }
  // Sign, carefully, because getting it backwards produces a plausible bearing
  // that is exactly wrong and nothing else in the system would notice.
  //
  // Spatialiser delays the *far* ear, so a source on the right gives
  // L(t) = R(t - itd) with itd > 0. The sum above peaks where i + lag lines up
  // with i - itd·sr, so a right-hand source produces a negative bestLag.
  const itd = -bestLag / sr;

  const hL = rms(band(left, sr, 2000, top)), hR = rms(band(right, sr, 2000, top));
  const ild = 20 * Math.log10((hR + 1e-9) / (hL + 1e-9));

  return {
    sampleRate: sr, seconds,
    bands: { sub: rms(sub, skip), low: rms(low, skip), mid: rms(mid, skip), high: rms(high, skip) },
    subAM: dep.depth, strokeHz: dep.strokeHz,
    onsets: on, onsetCount: on.length,
    onsetsSub: onSub, onsetsCall: onCall, hasUpper,
    dr, attackMs,
    regularity: per.strength, meanInterval: per.periodS,
    itd, ild,
  };
}

/**
 * Recover the game state from the measurement.
 *
 * Deliberately crude — a nearest-centroid on three features and two closed-form
 * inversions. That is the argument: if something this simple can read the signal
 * out of the rendered audio at every cloud density, then the encoding is
 * genuinely present in the waveform and a trained listener can learn it. A
 * cleverer estimator would prove less, not more.
 *
 * @param {ReturnType<describe>} d
 * @param {object} hint { shoveAt } context time of the felt shove, when the sim
 *        knows it; without it the far cue cannot be used, exactly as for a
 *        player who was not paying attention.
 */
export function estimate(d, hint = {}) {
  // Near cue: modulation depth in the sub band. Trustworthy under ~500 m, where
  // the depth is still large enough to measure against the noise floor.
  const nearD = distanceFromDepth(d.subAM);
  const nearConf = clamp01(smoothstep(0.012, 0.06, d.subAM));

  // Far cue: the gap between the shove and the call.
  //
  // The call is taken from the upper register when the medium left any, because
  // that list contains calls only. Otherwise it is taken from the sub list,
  // skipping past the shove's own onset — hence the MIN_GAP_S guard, which is
  // also what sets the closest range this cue can report.
  let farD = null, farConf = 0;
  if (hint.shoveAt != null) {
    const after = hint.shoveAt + ONSET.MIN_GAP_S;
    const list = d.onsetsCall.length ? d.onsetsCall : d.onsetsSub;
    const hit = list.find((t) => t > after && t < hint.shoveAt + MEDIUM.LAG_MAX + 0.5);
    if (hit != null) {
      farD = distanceFromLag(hit - hint.shoveAt);
      // The gap is only meaningful if the call could be time-stamped at all. A
      // slow unaware swell has no edge to stamp, so confidence is gated on the
      // measured attack rather than assumed.
      const stampable = d.attackMs == null ? 0.2 : clamp01(smoothstep(700, 250, d.attackMs));
      farConf = clamp01(smoothstep(80, 260, farD)) * stampable;
    }
  }

  let distance;
  if (farD != null && farConf > 0.05) {
    const w = farConf / (farConf + nearConf + 1e-9);
    distance = lerp(nearD, farD, w);
  } else {
    distance = nearD;
  }

  // Bearing. ITD is primary because it is the only cue that exists below 500 Hz
  // and the only one dense cloud does not remove. ILD refines it when the high
  // band survived, and is what resolves front from back — see the fallback in
  // AUDIO_LANGUAGE.md when it has not.
  const sinAz = clamp(d.itd / SPATIAL.ITD_MAX, -1, 1);
  const azimuth = Math.asin(sinAz);
  const frontBackConfident = d.bands.high > d.bands.low * 0.02;

  // Awareness. Three features, all invariant under an unknown gain and an
  // unknown low-pass: how regular the event train is, how fast the call rises,
  // and how often it comes.
  //
  // The rise feature is unavailable whenever the medium has closed the upper
  // band, so its weight is dropped to zero rather than its value being defaulted.
  // Defaulting would place a dense-cloud contact at a coordinate no class
  // occupies and let the nearest centroid pick arbitrarily; dropping the
  // dimension classifies it on the evidence that actually exists.
  const feats = awarenessFeatures(d);
  const w = AWARENESS_WEIGHTS.slice();
  if (d.attackMs == null) w[1] = 0;

  let bestI = 0, bestDist = Infinity;
  for (let i = 0; i < AWARENESS_CENTROIDS.length; i++) {
    let acc = 0;
    for (let k = 0; k < feats.length; k++) {
      const e = (feats[k] - AWARENESS_CENTROIDS[i][k]) * w[k];
      acc += e * e;
    }
    if (acc < bestDist) { bestDist = acc; bestI = i; }
  }

  // Fewer than three events over a window several times the longest call
  // interval is not a missing measurement, it is the measurement. A creature
  // that has not called is a creature that is not addressing you.
  if (d.onsetCount < 3) bestI = 0;

  return {
    distance, nearD, farD, nearConf, farConf,
    azimuth, sinAz, frontBackConfident,
    awareness: bestI, awarenessFeatures: feats, awarenessWeights: w,
    awarenessScore: (feats[0] + feats[1] + feats[2]) / 3,
  };
}

/** The three medium-invariant features, normalised to 0..1. */
export function awarenessFeatures(d) {
  return [
    clamp01(d.regularity),
    d.attackMs == null ? 0.0 : clamp01(1 - d.attackMs / 1000),
    d.meanInterval == null ? 0.0 : clamp01(1 - d.meanInterval / 16),
  ];
}

/**
 * Class centroids for [regularity, riseSpeed, callRate].
 *
 * Measured, not derived. The obvious approach — computing the centroids from the
 * AWARENESS table, since that is what produced the signal — is wrong for all
 * three: regularity is the strength of a normalised autocorrelation peak and has
 * no closed form in terms of the jitter behind it; riseSpeed comes back longer
 * than the synthesised attack because the detector stamps the onset partway up
 * the swell; and callRate saturates for the unaware state, whose 14 s interval
 * measures at about 16.5 s once the shove train is folded in.
 *
 * These are from a synthetic reconstruction of the presence layer and the call
 * train, not from the renderer itself. They are the right shape and roughly the
 * right place. `discriminationTest` returns `awareness.featureMeans`, so
 * refitting against the real thing is a matter of copying three rows.
 *
 * Separation is carried almost entirely by callRate: 0.04 / 0.67 / 0.88.
 * Regularity barely separates unaware from searching (0.25 against 0.35), which
 * is why it is weighted lowest.
 */
export const AWARENESS_CENTROIDS = Object.freeze([
  Object.freeze([0.25, 0.10, 0.04]),   // unaware
  Object.freeze([0.35, 0.65, 0.67]),   // searching
  Object.freeze([0.50, 0.94, 0.88]),   // fixed
]);

export const AWARENESS_WEIGHTS = Object.freeze([0.5, 1.2, 1.4]);

// ---------------------------------------------------------------------------
// Offline probe
// ---------------------------------------------------------------------------

/**
 * Render one creature in isolation, offline, and hand back the samples.
 *
 * This is the whole verification story for audio. The voice is the same class
 * the game uses, wired to an OfflineAudioContext instead of the mixer, so a
 * claim about what the player can hear is checked against the thing the player
 * actually hears rather than against a description of it.
 */
export async function probe({
  kind = 'listener', distance = 400, azimuth = 0, elevation = 0,
  awareness = 0, density01 = 0.3, seconds = 20, seed = 1,
  sampleRate = 48000, callAt = null, withScatter = true,
} = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('no OfflineAudioContext');
  const ctx = new OAC(2, Math.ceil(seconds * sampleRate), sampleRate);

  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);

  let scatterIn = null;
  if (withScatter) {
    // A local convolver, same synthesis as core/audio.js reverb(): the scatter
    // tail is a measured quantity here, so it must be the same tail.
    const len = Math.floor(sampleRate * 2.6);
    const buf = ctx.createBuffer(2, len, sampleRate);
    let s = 0x9e3779b9;
    for (let ch = 0; ch < 2; ch++) {
      const dd = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        dd[i] = ((s / 2147483648) - 1) * Math.pow(1 - i / len, 2.4);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    const wet = ctx.createGain();
    wet.gain.value = lerp(AMBIENCE.WET_CLEAR, AMBIENCE.WET_DENSE, clamp01(density01));
    conv.connect(wet); wet.connect(out);
    scatterIn = conv;
  }

  const v = new CreatureVoice(ctx, out, scatterIn, { kind, seed });
  v.start(0);
  v.set({ distance, azimuth, elevation, awareness, density01 }, 0.001);
  v.spatial.set(azimuth, elevation, 0.001, 0.001);

  // Calls are placed explicitly rather than by the live scheduler, because a
  // test needs to know where the shove was in order to score the gap.
  const p = awarenessParams(awareness);
  const shoves = [];
  const rand = mulberry32(seed ^ 0x5bd1e995);
  if (callAt != null) {
    for (const t of [].concat(callAt)) { v.call(t); shoves.push(t); }
  } else {
    let t = 1.0;
    while (t < seconds - p.attack - p.decay - arrivalLag(distance) - 0.2) {
      v.call(t);
      shoves.push(t);
      t += Math.max(0.4, p.interval * (1 + (rand() * 2 - 1) * p.jitter));
    }
  }

  const rendered = await ctx.startRendering();
  return {
    left: rendered.getChannelData(0),
    right: rendered.getChannelData(1),
    sampleRate,
    shoves,
    truth: { kind, distance, azimuth, elevation, awareness, density01 },
  };
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

/**
 * Bars this has to clear. Written down before the numbers came in, because a
 * threshold chosen after seeing the result is not a threshold.
 */
export const BARS = Object.freeze({
  nearMedianRelErr: 0.20, nearP90RelErr: 0.35, nearRange: [40, 450],
  farMedianRelErr: 0.15, farP90RelErr: 0.28, farRange: [250, 1500],
  distanceDensitySpearman: 0.20,
  bearingMedianDeg: 20, bearingRange: [20, 160],
  awarenessAccuracy: 0.95, awarenessAccuracyDense: 0.90,
  awarenessDistanceCorrelation: 0.15,
});

function spearman(a, b) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - ma, y = rb[i] - ma;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-9);
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-9);
}

const med = (v) => { const s = v.slice().sort((a, b) => a - b); return percentile(s, 50); };
const p90 = (v) => { const s = v.slice().sort((a, b) => a - b); return percentile(s, 90); };

/**
 * Render N random scenarios, decode each one, and score the result against BARS.
 *
 * The rendering is cheap — OfflineAudioContext runs far faster than real time —
 * and the analysis is not, so the cost is roughly linear in `trials` at about a
 * second each. 60 trials for a quick answer, 200 before believing a number.
 *
 * The result is a plain object. POST it to /__evidence/ and read it as a file:
 * the same trick main.js uses for pictures, for the same reason. Nobody
 * developing this can hear the game either.
 *
 * `sampleRate` defaults to 24 kHz rather than 48. Nothing in the language above
 * 8 kHz carries information, the analysis bands stop at 8 kHz, and halving the
 * rate halves every filter pass and every correlation in `describe`.
 */
export async function discriminationTest({
  trials = 120, seed = 7, sampleRate = 24000,
  kinds = ['listener', 'lantern', 'choir'],
  onProgress = null,
} = {}) {
  const rand = mulberry32(seed);
  const rows = [];

  for (let i = 0; i < trials; i++) {
    if (onProgress) onProgress(i, trials);
    const kind = kinds[(rand() * kinds.length) | 0];
    const distance = lerp(40, 1500, Math.pow(rand(), 0.8));
    const density01 = rand();
    const azimuth = (rand() * 2 - 1) * Math.PI;
    const awareness = (rand() * 3) | 0;
    const p = awarenessParams(awareness);
    // Long enough for at least four intervals, so regularity is measurable.
    const seconds = clamp(p.interval * 5 + arrivalLag(distance) + 4, 12, 80);
    const shove = 1.0;

    const r = await probe({ kind, distance, azimuth, awareness, density01, seconds, sampleRate, seed: (i * 2654435761) >>> 0 });

    // Two decodes of the same buffer. The hinted one is how the game will work —
    // a contact is identified by register long before ranging it matters, and
    // identification supplies the stroke rate. The unhinted one has to find the
    // rate itself, which is the harder case and the one that can collide with
    // the call train. Both are reported; conflating them would hide which of the
    // two is failing.
    const d = describe(r.left, r.right, sampleRate, { strokeHz: CREATURES[kind].strokeHz });
    const dBlind = describe(r.left, r.right, sampleRate);
    const e = estimate(d, { shoveAt: shove });
    const eBlind = estimate(dBlind, { shoveAt: shove });

    rows.push({
      kind, distance, density01, azimuth, awareness,
      estDistance: e.distance, estNear: e.nearD, estFar: e.farD,
      estNearBlind: eBlind.nearD, foundStrokeHz: dBlind.strokeHz,
      estAz: e.azimuth, estAwareness: e.awareness, awarenessScore: e.awarenessScore,
      feats: e.awarenessFeatures,
      subAM: d.subAM, trueStrokeHz: CREATURES[kind].strokeHz, dr: d.dr,
      regularity: d.regularity, attackMs: d.attackMs, meanInterval: d.meanInterval,
      hasUpper: d.hasUpper,
      itd: d.itd, ild: d.ild, onsets: d.onsetCount,
      onsetsSub: d.onsetsSub.length, onsetsCall: d.onsetsCall.length,
    });
  }

  const relErr = (r, est) => Math.abs(est - r.distance) / r.distance;

  const near = rows.filter((r) => r.distance >= BARS.nearRange[0] && r.distance <= BARS.nearRange[1]);
  const far = rows.filter((r) => r.distance >= BARS.farRange[0] && r.distance <= BARS.farRange[1]
    && r.awareness >= 1 && r.estFar != null);

  const nearErrs = near.map((r) => relErr(r, r.estNear));
  const nearBlindErrs = near.map((r) => relErr(r, r.estNearBlind));
  const farErrs = far.map((r) => relErr(r, r.estFar));

  // The negative control, and the single most important number here. If the
  // estimate tracks density, then what is being measured is loudness wearing
  // distance's clothes.
  const mid = rows.filter((r) => r.distance > 200 && r.distance < 800);
  const rhoDensity = mid.length > 8 ? spearman(mid.map((r) => r.estDistance), mid.map((r) => r.density01)) : 0;

  const lateral = rows.filter((r) => {
    const a = Math.abs(r.azimuth) * 180 / Math.PI;
    return a >= BARS.bearingRange[0] && a <= BARS.bearingRange[1];
  });
  const bearingErrs = lateral.map((r) => {
    // sin(az) is what ITD encodes, so front/back is compared separately; the
    // lateral error is the error in the angle the time cue can actually carry.
    const trueLat = Math.asin(clamp(Math.sin(r.azimuth), -1, 1));
    return Math.abs(trueLat - r.estAz) * 180 / Math.PI;
  });

  const awOK = rows.filter((r) => r.estAwareness === r.awareness).length / Math.max(1, rows.length);
  const dense = rows.filter((r) => r.density01 > 0.8);
  const awDense = dense.length ? dense.filter((r) => r.estAwareness === r.awareness).length / dense.length : 1;
  const awVsDist = pearson(rows.map((r) => r.awarenessScore), rows.map((r) => r.distance));

  // Measured feature means per true class, and the confusion matrix.
  //
  // These exist so that AWARENESS_CENTROIDS can be refitted from a run rather
  // than guessed. The regularity centroid in particular is declared, not
  // derived — copy `featureMeans[k][0]` into it once the other bars are clear.
  const featureMeans = [0, 1, 2].map((k) => {
    const g = rows.filter((r) => r.awareness === k);
    if (!g.length) return null;
    return [0, 1, 2].map((f) => g.reduce((a, r) => a + (r.feats[f] || 0), 0) / g.length);
  });
  const confusion = [0, 1, 2].map((t) => [0, 1, 2].map((e2) =>
    rows.filter((r) => r.awareness === t && r.estAwareness === e2).length));

  const result = {
    trials, seed, sampleRate,
    near: { n: near.length, median: med(nearErrs), p90: p90(nearErrs) },
    nearBlind: { n: near.length, median: med(nearBlindErrs), p90: p90(nearBlindErrs) },
    far: { n: far.length, median: med(farErrs), p90: p90(farErrs) },
    densitySpearman: rhoDensity,
    bearing: { n: lateral.length, medianDeg: med(bearingErrs), p90Deg: p90(bearingErrs) },
    awareness: {
      accuracy: awOK, accuracyDense: awDense, nDense: dense.length,
      distanceCorrelation: awVsDist, featureMeans, confusion,
      centroids: AWARENESS_CENTROIDS.map((c) => c.slice()),
    },
    bars: BARS,
    rows,
  };

  result.pass = {
    B1_near: result.near.median < BARS.nearMedianRelErr && result.near.p90 < BARS.nearP90RelErr,
    B2_far: result.far.median < BARS.farMedianRelErr && result.far.p90 < BARS.farP90RelErr,
    B3_density: Math.abs(result.densitySpearman) < BARS.distanceDensitySpearman,
    B4_bearing: result.bearing.medianDeg < BARS.bearingMedianDeg,
    B5_awareness: result.awareness.accuracy >= BARS.awarenessAccuracy
      && result.awareness.accuracyDense >= BARS.awarenessAccuracyDense
      && Math.abs(result.awareness.distanceCorrelation) < BARS.awarenessDistanceCorrelation,
  };
  result.allPass = Object.values(result.pass).every(Boolean);
  return result;
}

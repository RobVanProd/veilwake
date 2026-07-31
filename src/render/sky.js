// The luminaries.
//
//   import { Luminaries } from './render/sky.js';
//   const sky = new Luminaries({ seed });
//   sky.update(simTime);              // once per frame, before clouds.update
//   sky.applyTo(clouds);              // writes the palette the march reads
//
// There is no sun in this world, and removing it is not a cosmetic decision.
//
// A single white key above white clouds is Earth, and it is what the renderer was
// quietly assuming: the key measured [2.30, 2.24, 2.02] — white in all but name —
// and the frames it produced measured a chroma of 0.055 at the worst sampled
// moment, which is grey. "Not generic grey fog" is the failure mode
// ART_DIRECTION names as the most likely one, and a neutral light on a neutral
// medium is the shortest path to it. You cannot tint your way out either: a
// white source through a white medium gives white, and every attempt to colour
// the result afterwards reads as a filter laid over a photograph.
//
// So the light itself is coloured, there are several of them, and they change.
// ART_DIRECTION asks for exactly this and the line was there from the start:
//
//   > The palette should be cold and deep by default — blues, slates, the
//   > green-black of deep water — so that any warm light reads as an event.
//   > **When the palette does shift, it should mean something.**
//
// GAME_VISION's third beat lists *"a light that was there is not"* among the
// ambiguous warnings the whole structure of a session rests on. That beat is
// unwritable against a sun, because a sun is always there.
//
// --- the three, and why these three ----------------------------------------
//
// **VEIL** — the pale green-cyan the world is lit by most of the time. Cold,
// diffuse, low. It is the closest thing here to daylight and it is nobody's idea
// of daylight, which is the point: the first frame should establish that this is
// not a sky you have flown under before.
//
// **EMBER** — small, deep amber, and mostly absent. It rises and sets on its own
// long cycle, and when it is up the whole world reads as warm and wrong. This is
// the palette shift that "means something": under it, everything the art
// direction reserves warmth for — creature light, discharge, your own lamps —
// stops being distinguishable at a glance, so the safest-looking hours are also
// the ones where you can least trust your eyes.
//
// **DROWN** — a deep indigo counter-light from the opposite side, always present
// and always dim. It exists so shadow is a colour rather than an absence. A
// shadow side lit by nothing is black, black has no hue, and a frame whose dark
// half has no hue is halfway to grey no matter what the lit half is doing.
//
// --- the cycle --------------------------------------------------------------
//
// Long, and prime-ish against each other so the combination does not visibly
// repeat inside a session. A player should be able to say "the light was
// different last time" without being able to say what the pattern is.

import * as THREE from 'three';
import { clamp01, lerp } from '../core/math.js';

const TAU = Math.PI * 2;

/**
 * Radiance in the same arbitrary linear scale as CLOUD_PALETTE, so these numbers
 * are directly comparable with the key the palette used to carry.
 */
export const LUMINARY = {
  veil: {
    key: 'veil',
    // Cool green-cyan. Tinted, not neon.
    //
    // The first attempt used [0.62, 1.72, 1.44] — green nearly three times red —
    // and measured a chroma of 0.54 against a starting point of 0.055. That is
    // not a corrected sky, it is a flat teal wall: a light this saturated stops
    // reading as light and starts reading as a filter, and every mass in frame
    // collapses to one hue. The target is a frame that is unmistakably not
    // Earth's and still looks lit rather than tinted, which measures around
    // 0.18–0.25.
    color: [1.02, 1.42, 1.30],
    /** Peak radiance when fully risen. */
    intensity: 1.70,
    /** Elevation in radians, low so light travels through the forms not onto them. */
    elevation: [0.05, 0.22],
    /** Seconds for a full circuit of the sky. */
    period: 900,
    phase: 0.0,
    /** Fraction of the cycle it is above the horizon at all. */
    duty: 0.78,
  },
  ember: {
    key: 'ember',
    // Deep amber, nearly red. The only saturated warm thing that is ever large.
    // Deep copper-red, and dim. An earlier pass had this at [1.62, 0.92, 0.52]
    // and intensity 1.05, which measured a perfectly respectable p50 of 70 and
    // rendered a lovely amber sunset — beautiful, and completely wrong. This
    // luminary's job is to make the world look warm and UNSAFE, and a peach sky
    // reads as a holiday. Pushed toward red and darkened until the frame is lit
    // by something you would rather was not there.
    color: [1.38, 0.54, 0.24],
    intensity: 0.70,
    elevation: [0.03, 0.14],
    period: 1370,
    phase: 0.42,
    // Up for a third of its cycle. Rare enough that its arrival is an event.
    duty: 0.34,
  },
  drown: {
    key: 'drown',
    // Indigo, dim, opposite. Never the dominant light; it exists to give the
    // dark half of the frame a hue.
    color: [0.60, 0.68, 1.14],
    intensity: 0.52,
    elevation: [0.10, 0.30],
    period: 1103,
    phase: 0.66,
    duty: 1.0,           // always present
  },
};

/**
 * How much of the light's colour the SKY inherits. 1 = fully, 0 = grey.
 *
 * The key light keeps its full colour regardless; this only affects the large
 * flat areas — sky gradient, haze, ambient — and those are what set the chroma
 * of the whole image, because they are most of it. Driven at the light's own
 * saturation the frame measured 0.54 and read as a flat teal wall.
 */
export const SKY_SATURATION = 0.42;

/**
 * The medium's own colour.
 *
 * Real cloud is white because water scatters neutrally across the visible band.
 * This is not water. A slight cast in the albedo means the vapour has a colour
 * of its own even under a neutral light, and — more importantly — it means the
 * lit and shadowed faces of the same mass differ in hue and not only in value,
 * which is what stops a cloud reading as a grey shape with a bright edge.
 *
 * Kept subtle. Past about 0.12 of separation the clouds start reading as painted
 * rather than lit, and the point is a medium that is not water, not a medium
 * that is coloured smoke.
 */
export const MEDIUM_ALBEDO = [0.82, 0.94, 0.99];

/** Smooth rise and fall over a duty cycle, zero outside it. */
function riseFall(u, duty) {
  if (duty >= 1) return 1;
  const t = u % 1;
  if (t > duty) return 0;
  const x = t / duty;                 // 0..1 across the time it is up
  // sin^2 gives a soft horizon at both ends without a discontinuity in slope.
  const s = Math.sin(x * Math.PI);
  return s * s;
}

export class Luminaries {
  constructor({ seed = 0, defs = LUMINARY } = {}) {
    this.defs = defs;
    this.seed = seed;
    /** Live state, one entry per luminary. */
    this.lights = Object.values(defs).map((d) => ({
      key: d.key,
      def: d,
      dir: new THREE.Vector3(0, 1, 0),
      color: new THREE.Vector3(),
      intensity: 0,
      above: 0,
    }));
    /** The one the march treats as its key light. */
    this.dominant = this.lights[0];
    /** Sky gradient, derived rather than authored — see _composeSky. */
    this.skyZenith = new THREE.Vector3();
    this.skyHorizon = new THREE.Vector3();
    this.skyGround = new THREE.Vector3();
    this.ambientTop = new THREE.Vector3();
    this.ambientBottom = new THREE.Vector3();
    this.haze = new THREE.Vector3();
    this.deepTint = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this.update(0);
  }

  /** @param {number} t simulation seconds */
  update(t) {
    let best = null;
    for (const L of this.lights) {
      const d = L.def;
      const u = (t / d.period + d.phase) % 1;
      const a = riseFall(u, d.duty);
      L.above = a;
      L.intensity = d.intensity * a;

      // Azimuth walks the whole circle over the period; elevation breathes
      // between its two bounds on a slower beat so the light is never quite in
      // the same place twice.
      const az = u * TAU;
      const el = lerp(d.elevation[0], d.elevation[1],
        0.5 + 0.5 * Math.sin(t / (d.period * 0.37) + d.phase * TAU));
      const ce = Math.cos(el);
      L.dir.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
      L.color.set(d.color[0], d.color[1], d.color[2]);

      if (!best || L.intensity > best.intensity) best = L;
    }
    this.dominant = best;
    this._composeSky();
    return this;
  }

  /**
   * Build the sky and ambient from whatever is currently up.
   *
   * Derived rather than authored, because an authored sky stops agreeing with
   * the lights the moment they move — and a sky that disagrees with its own
   * light is the single most reliable way to make a rendered world look fake.
   */
  _composeSky() {
    let r = 0, g = 0, b = 0, total = 0;
    for (const L of this.lights) {
      if (L.intensity <= 0) continue;
      r += L.color.x * L.intensity;
      g += L.color.y * L.intensity;
      b += L.color.z * L.intensity;
      total += L.intensity;
    }
    if (total <= 0) { r = 0.10; g = 0.14; b = 0.30; total = 1; }
    let mr = r / total, mg = g / total, mb = b / total;

    // Desaturate what the sky and haze inherit from the light.
    //
    // The sky is the single largest area in frame, so it sets the chroma of the
    // whole image. Driven at the light's own saturation it measured 0.54 and
    // rendered as a flat teal wall — the medium stopped reading as lit and
    // started reading as tinted. Pulling the *sky's* copy toward neutral while
    // leaving the *key* fully coloured is what separates the two: masses are lit
    // by a coloured light against a sky that only leans that way.
    const lum = mr * 0.2126 + mg * 0.7152 + mb * 0.0722;
    const K = SKY_SATURATION;
    mr = lerp(lum, mr, K); mg = lerp(lum, mg, K); mb = lerp(lum, mb, K);

    // The sky is the mixed light, heavily darkened. Zenith is nearly black — a
    // cloud is only monumental if the thing behind it is empty.
    //
    // The horizon-to-zenith ratio is deliberately steep, and the haze is
    // deliberately far below the horizon it sits in front of. A first pass had
    // the haze at 0.040 against a horizon of 0.055 and the frame came out as a
    // flat wall of one colour: at this camera you are looking along the layer,
    // so almost every ray terminates in far field rather than in sky, and if the
    // far field is as bright as the sky there is no gradient left to read depth
    // from. Distance has to get DARKER here, not just hazier — which is also
    // what happens in a medium lit from the side rather than from above.
    this.skyZenith.set(mr * 0.003, mg * 0.005, mb * 0.016);
    this.skyHorizon.set(mr * 0.030, mg * 0.036, mb * 0.055);
    this.skyGround.set(mr * 0.010, mg * 0.013, mb * 0.022);
    this.haze.set(mr * 0.011, mg * 0.014, mb * 0.021);

    // Ambient is the sky, so shadowed faces are lit by what is actually up
    // there. The bottom is the dim return off whatever is below the layer.
    this.ambientTop.set(mr * 0.055, mg * 0.072, mb * 0.135);
    this.ambientBottom.set(mr * 0.008, mg * 0.011, mb * 0.019);

    // Deeply multiple-scattered light forgets where it came from and keeps only
    // the coldest part of it. Above 1 in blue on purpose: it should read as a
    // colour rather than as a darker version of the key.
    const cold = Math.max(mb, mg);
    this.deepTint.set(mr * 0.30, mg * 0.55, cold * 1.20);
  }

  /** The key light the volumetric march uses for shafts and shadows. */
  keyDirection() { return this.dominant.dir; }
  keyColor(out = new THREE.Vector3()) {
    return out.copy(this.dominant.color).multiplyScalar(this.dominant.intensity);
  }

  /**
   * Push the whole palette into a CloudSystem.
   *
   * Everything the march reads about light comes from here, so there is exactly
   * one place that decides what colour this world is.
   */
  applyTo(clouds) {
    const mu = clouds.marchUniforms, cu = clouds.compositeUniforms;
    clouds.sun.copy(this.dominant.dir);
    const key = this.keyColor(this._key || (this._key = new THREE.Vector3()));
    mu.uSunDir.value.copy(clouds.sun);
    cu.uSunDir.value.copy(clouds.sun);
    mu.uSunColor.value.copy(key);
    cu.uSunColor.value.copy(key);
    mu.uAmbTop.value.copy(this.ambientTop);
    mu.uAmbBottom.value.copy(this.ambientBottom);
    mu.uDeepTint.value.copy(this.deepTint);
    mu.uHazeColor.value.copy(this.haze);
    cu.uHazeColor.value.copy(this.haze);
    cu.uSkyZenith.value.copy(this.skyZenith);
    cu.uSkyHorizon.value.copy(this.skyHorizon);
    cu.uSkyGround.value.copy(this.skyGround);
    return this;
  }

  /** Everything a HUD or a capture might want to say about the current sky. */
  snapshot() {
    return {
      dominant: this.dominant.key,
      lights: this.lights.map((L) => ({
        key: L.key,
        up: +L.above.toFixed(3),
        intensity: +L.intensity.toFixed(3),
        elevationDeg: +(Math.asin(L.dir.y) * 57.2958).toFixed(1),
      })),
    };
  }
}

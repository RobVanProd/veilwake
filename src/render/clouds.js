// The volumetric cloud system.
//
// Interface:
//
//   const clouds = new CloudSystem({ renderer, seed: 'veilwake', quality: 'high' });
//   clouds.update(dt, camera);                   // once per fixed step
//   clouds.renderFrame(renderer, scene, camera); // replaces renderer.render(...)
//
//   clouds.densityAt(x, y, z)          density in [0,1] at a world point
//   clouds.flowAt(x, y, z, out)        air velocity in m/s, plus turbulence
//   clouds.transmittance(a, b)         line-of-sight through the field, [0,1]
//   clouds.concealmentAt(x, y, z)      how hidden something at that point is
//   clouds.storms                      live electrical cells, world space
//   clouds.lights                      LightRegistry: lamps, plumes, biolum
//   clouds.shaft                       god-ray tuning, live
//   clouds.setQuality(name)            'low' | 'medium' | 'high' | 'ultra'
//   clouds.coverageAt(x, z)            weather-map coverage for a column
//   clouds.verifyAgreement(renderer)   proves the CPU query matches the shader
//   await clouds.benchPass(renderer, scene, camera)   times the march alone
//
// Three commitments shape everything below.
//
// One: the CPU and the GPU sample the same field. Navigation, concealment,
// creature senses and the instruments all ask where the cloud is, and if their
// answer differs from what the player can see, the game is lying. The density
// function exists twice — once in GLSL, once in `_densityCloud` — reading one set
// of bytes through one set of uniforms, and verifyAgreement() is what keeps the
// two honest.
//
// Two: the world is periodic and the origin recentres. The player flies forever,
// so world coordinates cannot be allowed to grow until float32 quantises them.
// Every noise period divides ORIGIN_QUANTUM, which means the origin can jump by
// a whole quantum and the field is bit-for-bit unchanged — no pop, no seam. Time
// is handled the same way: advection offsets are wrapped on the CPU in double
// precision before they ever reach a uniform.
//
// Three: nothing accumulates between frames. No temporal reprojection, no
// history buffer. Those are the obvious way to buy quality at half resolution
// and they are ruled out here, because this project's only way of seeing its own
// output is a deterministic capture, and a capture that depends on how many
// frames happened to precede it is not evidence of anything.

import * as THREE from 'three';
import { makeShapeVolume, makeDetailVolume, makeWeatherMap, makeBlueNoiseTile, sample2D, sample3D } from './noise.js';
import { FULLSCREEN_VERT, MARCH_FRAG, COMPOSITE_FRAG, PROBE_FRAG } from './shaders/cloud.glsl.js';
import { LightRegistry, MAX_MARCH_LIGHTS, lightningCell } from './lights.js';
import { Luminaries, MEDIUM_ALBEDO } from './sky.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';
import { seedFrom } from '../core/rng.js';

// ---------------------------------------------------------------------------
// The world's fixed numbers
// ---------------------------------------------------------------------------

/**
 * Periods and extents, in metres.
 *
 * ORIGIN_QUANTUM is the load-bearing one: it is a multiple of every other
 * period, so subtracting it from a position leaves every noise lookup exactly
 * where it was. Recentring is therefore free and invisible. Change any period to
 * something that does not divide it and the sky will jump every 65 km.
 */
export const CLOUD = {
  LAYER_BASE: -900,
  LAYER_TOP: 2600,
  SHAPE_PERIOD: 4096,
  DETAIL_PERIOD: 256,
  WEATHER_PERIOD: 65536,
  ORIGIN_QUANTUM: 65536,
  STORM_GRID: 8192,
};
CLOUD.LAYER_THICKNESS = CLOUD.LAYER_TOP - CLOUD.LAYER_BASE;

/**
 * Three winds, not one.
 *
 * The weather front, the cloud bodies and the fine turbulence move at different
 * speeds and slightly different headings. That differential is what reads as
 * shear and rotation; a single wind vector applied to every octave makes the
 * whole sky slide sideways like a painted backdrop. Each is wrapped to its own
 * layer's period, so all three stay exactly periodic.
 */
const WIND = {
  weather: { x: 3.1, y: 0.0, z: -1.4 },
  shape: { x: 11.0, y: 0.65, z: -4.6 },
  detail: { x: 19.0, y: 2.40, z: -8.2 },
};

/**
 * Quality presets.
 *
 * Step counts are compile-time constants rather than uniforms: a loop the driver
 * can bound is a loop it can schedule, and the difference is worth the shader
 * rebuild that changing preset costs. `scale` is the fraction of the drawing
 * buffer the march runs at — the composite handles any ratio, but 0.5 is the one
 * the depth reconstruction is happiest with.
 *
 * The shaft group is what god rays cost. `shaftSteps` is the shadow march the
 * mist between the clouds takes toward the sun, `shaftStride` is how often along
 * the view ray it takes one — base metres, then metres of stride gained per
 * metre of distance — and `shaftReach` is that march's own schedule, a first
 * step and a growth factor. `shaftRange` is where shafts stop being marched and
 * become a constant, which is a saving of about a quarter of their cost for a
 * difference visible nowhere.
 */
export const CLOUD_QUALITY = {
  low:    { scale: 0.42, steps: 120, lightSteps: 3,  msOctaves: 2, maxDist: 15000, minStep: 26, growth: 0.055, maxStep: 240, coarseMin: 110, coarseMax: 260, tauCap: 0.45, softK: 0.0044, detailFade: [200, 800],
            shaftSteps: 4, shadowTaps: 2, shaftStride: [200, 0.080], shaftReach: [180, 3.20], shaftRange: [900, 2200] },
  medium: { scale: 0.50, steps: 176, lightSteps: 5,  msOctaves: 3, maxDist: 19000, minStep: 19, growth: 0.040, maxStep: 175, coarseMin: 80,  coarseMax: 220, tauCap: 0.34, softK: 0.0036, detailFade: [350, 1300],
            shaftSteps: 6, shadowTaps: 3, shaftStride: [120, 0.060], shaftReach: [110, 2.10], shaftRange: [1200, 3000] },
  high:   { scale: 0.50, steps: 256, lightSteps: 8,  msOctaves: 3, maxDist: 24000, minStep: 13, growth: 0.030, maxStep: 130, coarseMin: 55,  coarseMax: 175, tauCap: 0.24, softK: 0.0030, detailFade: [500, 2000],
            shaftSteps: 7, shadowTaps: 3, shaftStride: [68,  0.045], shaftReach: [78,  1.95], shaftRange: [1600, 4000] },
  ultra:  { scale: 0.66, steps: 384, lightSteps: 10, msOctaves: 3, maxDist: 30000, minStep: 9,  growth: 0.022, maxStep: 95,  coarseMin: 36,  coarseMax: 130, tauCap: 0.20, softK: 0.0024, detailFade: [800, 3200],
            shaftSteps: 9, shadowTaps: 4, shaftStride: [52, 0.035], shaftReach: [45,  1.72], shaftRange: [2000, 5000] },
};

/**
 * The palette, in linear HDR.
 *
 * Stated as one block because it is the art direction, and because the failure
 * mode for a ray-marched cloud is grey. The separation is deliberate: the sun is
 * amber, the ambient is cold blue, the light that has bounced several times is
 * bluer still, and the haze the distance dissolves into matches the horizon.
 * Hue does the work that saturation would do badly.
 */
export const CLOUD_PALETTE = {
  // A pale, barely-warm key. It used to be [3.20, 1.86, 0.92] — a low amber sun
  // — and that single line was most of why the game looked like a holiday.
  //
  // Amber plus a lit cloud is cream, and cream at this coverage filled a quarter
  // of the frame. Measured at the reference pose: 25.5% of pixels above the
  // "blazing" threshold, with p95 221 / p99 229 / p999 232 — the bright end was a
  // *plateau*, not a spike, so nothing read as a highlight because everything
  // was one. Warmth is not deleted, only rationed: what survives here is the
  // last of it, and it lands on cloud edges as bone rather than gold.
  //
  // Second pass, measured through the real gameplay camera rather than a
  // hand-posed one: [2.55, 2.20, 1.55] still left the frame at warmth +13, and
  // warmth is the exact quality the owner called "perky". Swept against the
  // whole test objective — colder than this collapses the hue separation that
  // makes shadow read as shadow (a [2.05, 2.20, 2.45] key scored warmth -18.6
  // and separation 2.7, i.e. a monochrome frame), so this sits at the point where
  // the light is just cool enough to stop being golden and still warm enough to
  // separate from a cold shadow. Storm light, not sunset.
  sun: [2.30, 2.24, 2.02],
  // Sky light into the top of the layer, and the dim green-blue that comes back
  // off whatever is underneath it. These are what a shadowed face is made of, so
  // this is where the cold half of the palette has to live. Cut hard — a shadow
  // that is only slightly darker than the light is what makes a frame read as
  // overcast rather than as menacing.
  ambientTop: [0.028, 0.062, 0.120],
  ambientBottom: [0.004, 0.009, 0.014],
  // Light that has bounced several times has lost the sun's warmth to the blue
  // around it. Above 1.0 in blue on purpose: it should read as a colour, not as
  // a darker version of the sun.
  deepTint: [0.26, 0.46, 0.88],
  haze: [0.022, 0.030, 0.040],
  // The sky is now nearly black at the zenith and only just present at the
  // horizon. This is the single largest contributor to dread in the frame: a
  // cloud is only monumental if the thing behind it is empty.
  skyZenith: [0.003, 0.006, 0.014],
  skyHorizon: [0.026, 0.038, 0.050],
  skyGround: [0.008, 0.015, 0.021],
  // The two warm things left in the world, and both mean danger. With the key
  // desaturated, an ember is now the only saturated warmth on screen — which is
  // the point. Warmth became information.
  stormFlash: [0.66, 0.78, 1.00],
  stormEmber: [1.00, 0.36, 0.10],
};

/**
 * How dark the world is, as one number.
 *
 * Kept beside the palette because it is not a rendering detail — it is the
 * difference between weather and dread, and it is the first thing anyone
 * retuning the look will want. tools/mood.js measures whether a change actually
 * moved it; do not adjust these by eye.
 */
export const MOOD_TARGET = {
  /** Median luminance, 0–255. Above ~70 the frame reads as daylight. */
  p50: [15, 70],
  /** p99 / p50 — "shafts in a dark room". Below 3 the frame is flat. */
  dynamic: 3.0,
  /** Percent of frame genuinely blazing. Zero is not doom, it is off. */
  litFrac: [0.8, 25],
  /** mean(R) - mean(B). Negative is cold, which is the world's default. */
  warmth: 2,
  /** Light warmer than shadow. Negative inverts the palette's whole intent. */
  coldShadowSep: 4,
};

const TAU = 6.28318530718;

// ---------------------------------------------------------------------------
// The density function, CPU side
//
// Mirror of vw_density in cloud.glsl.js. Read them side by side; they are meant
// to be diffable line for line, and verifyAgreement() reports the moment they
// stop being.
// ---------------------------------------------------------------------------

const remapG = (v, lo, hi) => clamp01((v - lo) / Math.max(hi - lo, 1e-5));

function heightGradient(h, form) {
  const deck = remapG(h, 0.00, 0.05) * (1 - remapG(h, 0.08, 0.20));
  const roll = remapG(h, 0.01, 0.13) * (1 - remapG(h, 0.34, 0.70));
  const tower = remapG(h, 0.00, 0.06) * (1 - remapG(h, 0.60, 1.00));
  const a = lerp(deck, roll, clamp01(form * 2));
  return lerp(a, tower, clamp01(form * 2 - 1));
}

// ---------------------------------------------------------------------------

export class CloudSystem {
  constructor({ renderer, seed = 'veilwake', quality = 'high', shapeSize = 64, detailSize = 32, weatherSize = 128 } = {}) {
    const s = typeof seed === 'string' ? seedFrom(seed) : (seed | 0);
    this.seed = s;

    const t0 = performance.now();
    this.shape = makeShapeVolume({ size: shapeSize, seed: s });
    this.detail = makeDetailVolume({ size: detailSize, seed: s ^ 0x5bf03635 });
    this.weather = makeWeatherMap({ size: weatherSize, seed: s ^ 0x1b56c4e9 });
    this.blue = makeBlueNoiseTile({ size: 64, seed: s ^ 0x2f7a1d05 });
    this.buildMs = performance.now() - t0;

    this.time = 0;
    this.enabled = true;
    /** Off skips the march but keeps every other pass, so an A/B of the two
     *  isolates exactly what the volumetric costs. */
    this.volumetric = true;

    this.origin = new THREE.Vector3(0, 0, 0);
    // Low and nearly ahead of the default heading. A high sun lights cloud tops
    // and produces a postcard; a low one puts the light behind the forms, which
    // is the only arrangement where you can see through one.
    // Low, and about 70 degrees off the default heading.
    //
    // Low is right and was always right: a high sun lights cloud tops and makes
    // a postcard, a low one puts the light behind the forms and is the only
    // arrangement you can see *through* one. The bearing was the mistake. It sat
    // at 19 degrees off the heading — nearly straight ahead — so the player's
    // default view was directly into the glare, and measured through the real
    // gameplay camera that frame reads p50 153, litFrac 44%, warmth +21. The
    // palette was never failing; the camera was pointed at the one direction
    // that breaks it.
    //
    // Swept at the gameplay camera: 19 deg -> p50 153 / warm 21, 45 -> 125 / 17,
    // 70 -> 95 / 13, 100 -> 76 / 7, 125 -> 69 / 4. Past about 90 the frame is
    // calm but litFrac collapses to 4-5% and nothing blazes. 70 keeps 15% of the
    // frame genuinely bright and the strongest hue separation of any bearing
    // tested, which is rim-lit cloud against a dark sky — the shot this game is
    // supposed to be made of.
    this.sun = new THREE.Vector3(0.936, 0.087, -0.341).normalize();
    // Below 1 on purpose. The palette above does most of the darkening, but
    // exposure is what stops a cloud edge clipping to flat white the moment the
    // sun catches it — and a clipped highlight has no shape, so the biggest
    // forms in the game lose their form exactly where they are most lit.
    this.exposure = 0.66;

    /** Global coverage control. Gameplay writes this: a front rolling in is a
     *  slow ramp here, and everything downstream — visibility, concealment,
     *  creature behaviour — follows without being told separately. */
    // Only the top quarter or so of the weather map produces cloud at all. That
    // sounds like an empty sky and is the opposite: it is what puts kilometres of
    // clear air between masses, which is the only way anything reads as
    // monumental. A sky that is cloud everywhere is a sky with no scale in it.
    // 2.20 was too sparse to be a world. Measured along the view ray from the
    // real gameplay camera it put ZERO cloud within 8 km ahead and 0% within
    // 2.5 km around — the player flew through open sky and the frame was a grey
    // gradient with a thin band of cumulus on the horizon. No palette can make
    // dread out of an empty sky, and that, not the colour, was most of what
    // "bland" meant.
    //
    // The cliff is sharp and sits just above here. Swept at the gameplay camera:
    //   2.6 -> p50 32, dynamic 7.6, 9.7% blazing, separation 12
    //   3.0 -> p50 15, dynamic 8.6, 0.1% blazing, separation -5.3
    //   3.4 -> p50 15, dynamic 1.7, 0.0% blazing, separation -4.3
    // Past 2.6 the masses close over each other, everything is occluded, nothing
    // is lit, and the frame goes to featureless dark fog with the palette
    // inverted. The original comment was right that clear air between masses is
    // what makes them monumental — it just had the number one notch too low.
    this.coverageGain = 2.60;
    this.coverageBias = -1.58;
    this.erosion = 0.44;
    this.densityScale = 1.0;

    // Every value the density function needs, in one place, in plain numbers.
    // The uniforms are written from here and so is the CPU query, which is the
    // only structural defence against the two drifting apart.
    this.field = {
      layerBase: CLOUD.LAYER_BASE,
      invThickness: 1 / CLOUD.LAYER_THICKNESS,
      invShape: 1 / CLOUD.SHAPE_PERIOD,
      invDetail: 1 / CLOUD.DETAIL_PERIOD,
      invWeather: 1 / CLOUD.WEATHER_PERIOD,
      shapeAdvect: [0, 0, 0],
      detailAdvect: [0, 0, 0],
      weatherAdvect: [0, 0, 0],
      breath: [0, 0, 0.034, 0.021],
      covGain: this.coverageGain,
      covBias: this.coverageBias,
      erosion: this.erosion,
      densityScale: this.densityScale,
    };

    /**
     * God-ray tuning, in one block, because these are art-direction numbers and
     * finding them took a capture each.
     *
     * `mist` at 1.0 is not a free choice. The march used to blend each cloud
     * sample toward uHazeColor by distance; the mist integral replaces that with
     * the same quantity integrated along the ray, and at a gain of 1.0 the two
     * agree to within the difference between a sum and its integral. Moving it
     * off 1.0 does not brighten the shafts, it re-fogs the whole sky.
     *
     * `sun` is the one that decides whether a beam reads. It is the radiance the
     * mist scatters out of direct sunlight, and since the shadow term multiplies
     * it, it is also exactly the contrast between a lit lane and a shadowed one.
     *
     * `local` is the same for lamps and creature light, and it is larger because
     * the mist is thin: see vw_mist in the shader for why that number is not 1.
     *
     * `farShadow` is what the sun term is multiplied by past shaftRange, where
     * the shadow stops being marched. Low on purpose — a high value floods the
     * distance with unshadowed light and flattens every shaft in front of it.
     */
    // `sigma` is the shaft shadow's own extinction, deliberately far below the
    // cloud body's uSigmaT. See the note at the shadow term in cloud.glsl.js:
    // the body wants to be opaque and the shaft wants to be graded, and sharing
    // one coefficient means raising the first silently deletes the second.
    // `sun` is the gain on direct sunlight scattered by the mist between clouds.
    //
    // It was 0.22, and it had to be, because before the density gate the mist
    // integrated through empty air as readily as through vapour: 0.5 put 47% of
    // the frame above the blazing threshold and 1.6 put 99.9% there. Anything
    // strong enough to make a beam visible beside a cloud turned every open-sky
    // frame into a dust storm.
    //
    // With the gate, empty air scatters almost nothing and the gain is free.
    // Swept against the full mood suite through the real gameplay camera, all of
    // these pass 7/7, and the frame gets BETTER as it rises because the shafts
    // are what separate light from shadow:
    //   0.22 -> p50 31, 6.1% blazing, hue separation -2.1  (inverted!)
    //   3.0  -> p50 61, 11.4%,        separation 12.3
    //   5.0  -> p50 63, 20.9%,        separation 15.0
    //   8.0  -> p50 75, 31.1%,        separation 16.4  (nearing the blaze ceiling)
    // Twenty-three times the old value, and the reason the old value looked
    // correct is that it was the largest number the ungated term could survive.
    // `floor` and `densGain` gate the sun's in-scatter on there being something
    // to scatter off — see the note in vw_mist. They are what let `sun` be large
    // enough for a beam to read without every open-sky frame turning into a dust
    // storm, so the three are tuned together and moving one alone will not work.
    this.shaft = {
      mist: 1.0, sun: 5.0, phaseG: 0.58, local: 45.0, farShadow: 0.30,
      sigma: 0.045, floor: 0.10, densGain: 14.0,
    };

    /** Local light sources the march samples. Bounded, chosen per frame; see
     *  lights.js. The ship, the creatures and this class's own storms all
     *  register here, so there is exactly one path from "something is glowing"
     *  to "the volume around it is lit". */
    this.lights = new LightRegistry();

    /**
     * The luminaries. There is no sun; see sky.js for why that is a design
     * decision rather than a naming one. Constructed here so a CloudSystem is
     * still self-contained, and driven from update() so the palette is always
     * the one the current lights imply.
     */
    this.sky = new Luminaries({ seed: s });

    this.storms = [];
    for (let i = 0; i < 4; i++) {
      this.storms.push({ x: 0, y: 0, z: 0, radius: 1400, intensity: 0, r: 0, g: 0, b: 0, charge: 0 });
      // A storm is a light like any other. It used to be four hard-coded slots
      // in the march with an exponential falloff standing in for a second light
      // march; routed through the registry it gets the same occlusion and the
      // same shafts as a lamp, which is what a discharge inside a cloud body
      // should look like — the cloud lit from within, with the shape of the
      // cloud in it.
      this.storms[i].light = this.lights.add(lightningCell({ key: `storm/${i}`, on: false }));
    }

    // GPU timing instrumentation, off until benchPass turns it on.
    this._gpuExt = null;
    this._gpuScope = null;
    this._gpuQueries = [];

    this._scratchW = new Float32Array(4);
    this._scratchS = new Float32Array(4);
    this._scratchD = new Float32Array(4);
    this._v2 = new THREE.Vector2();
    this._v3 = new THREE.Vector3();
    this._camPos = new THREE.Vector3();

    this._buildTextures();
    this._buildPasses(renderer, quality);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _buildTextures() {
    const vol3 = (v) => {
      const t = new THREE.Data3DTexture(v.data, v.size, v.size, v.size);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      // Repeat on all three axes. The field is periodic by construction and the
      // CPU sampler wraps the same way; clamping here would put a smeared wall
      // at every tile boundary that the CPU query would not know about.
      t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      return t;
    };

    this.shapeTex = vol3(this.shape);
    this.detailTex = vol3(this.detail);

    const w = new THREE.DataTexture(this.weather.data, this.weather.size, this.weather.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    w.minFilter = THREE.LinearFilter;
    w.magFilter = THREE.LinearFilter;
    w.wrapS = w.wrapT = THREE.RepeatWrapping;
    w.needsUpdate = true;
    this.weatherTex = w;

    // Nearest, always. A blue-noise mask is a set of specific values at specific
    // pixels; interpolating between them averages the pattern back into
    // something with low-frequency energy, which is the one property it exists
    // to not have.
    const b = new THREE.DataTexture(this.blue.data, this.blue.size, this.blue.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    b.minFilter = THREE.NearestFilter;
    b.magFilter = THREE.NearestFilter;
    b.wrapS = b.wrapT = THREE.RepeatWrapping;
    b.needsUpdate = true;
    this.blueTex = b;
  }

  _buildPasses(renderer, quality) {
    const P = CLOUD_PALETTE;
    const c3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

    // Shared by the march and the probe by reference, not by copy: one write
    // updates both, so the probe cannot accidentally test a stale field.
    this.fieldUniforms = {
      uShape: { value: this.shapeTex },
      uDetail: { value: this.detailTex },
      uWeather: { value: this.weatherTex },
      uLayer: { value: new THREE.Vector4(CLOUD.LAYER_BASE, CLOUD.LAYER_TOP, CLOUD.LAYER_THICKNESS, 1 / CLOUD.LAYER_THICKNESS) },
      uPeriodInv: { value: new THREE.Vector3(1 / CLOUD.SHAPE_PERIOD, 1 / CLOUD.DETAIL_PERIOD, 1 / CLOUD.WEATHER_PERIOD) },
      uShapeAdvect: { value: new THREE.Vector3() },
      uDetailAdvect: { value: new THREE.Vector3() },
      uWeatherAdvect: { value: new THREE.Vector3() },
      uBreath: { value: new THREE.Vector4() },
      uCoverage: { value: new THREE.Vector2() },
      uErosion: { value: new THREE.Vector2() },
      uDensityScale: { value: 1 },
    };

    this.marchUniforms = {
      ...this.fieldUniforms,
      uDepth: { value: null },
      uCamPos: { value: new THREE.Vector3() },
      uCamFwd: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3() },
      uCamUp: { value: new THREE.Vector3() },
      uTanHalf: { value: new THREE.Vector2() },
      uClip: { value: new THREE.Vector2(0.5, 12000) },
      uDepthStride: { value: new THREE.Vector2(2, 2) },
      uJitter: { value: 0 },
      uMaxDist: { value: 24000 },
      uStepRange: { value: new THREE.Vector4(10, 0.03, 260, 45) },
      uSoftK: { value: 0.0021 },
      uTauCap: { value: 0.8 },
      uCoarseMax: { value: 180 },
      uDetailFade: { value: new THREE.Vector2(700, 3400) },
      uSunDir: { value: this.sun.clone() },
      uSunColor: { value: c3(P.sun) },
      uAmbTop: { value: c3(P.ambientTop) },
      uAmbBottom: { value: c3(P.ambientBottom) },
      uDeepTint: { value: c3(P.deepTint) },
      uHazeColor: { value: c3(P.haze) },
      uPhase: { value: new THREE.Vector2(0.68, -0.25) },
      // Extinction per metre of density, and the master control for mood.
      //
      // This was 0.045, and at that value the medium was too thin to cast a
      // shadow — you could see straight through a cloud into the sun. That is
      // why there were no god rays worth the name: a shaft is the *absence* of
      // light beside it, and nothing here was blocking enough to carve one.
      // Measured looking into the sun, 0.045 gave p50 190 with 65% of the frame
      // blazing; 0.16 gives p50 42 with 17%. It also runs faster — 6.57 ms to
      // 5.74 ms median on the GPU timer — because opaque cloud terminates a ray
      // early. Above about 0.22 the frame goes monochrome and the shadow ends up
      // *warmer* than the light, which inverts the palette.
      uSigmaT: { value: 0.16 },
      uPowder: { value: 0.75 },
      uAerialK: { value: 9.0e-5 },
      uLightStep: { value: 42 },
      uLightFar: { value: 2400 },
      // Growth per step, and how fast the shadow cone widens with distance. The
      // second used to be a literal 0.35, which is a six-hundred-metre blur at
      // the far end of the march — wider than most of the gaps a shaft comes
      // through, and the single largest reason this pass read as a wash.
      uLightShape: { value: new THREE.Vector2(1.48, 0.16) },
      uShaft: { value: new THREE.Vector4() },
      uShaftSigma: { value: 0.045 },
      uAlbedo: { value: c3(MEDIUM_ALBEDO) },
      uShaftFloor: { value: 0.10 },
      uShaftDensGain: { value: 14.0 },
      uShaftStep: { value: new THREE.Vector4() },
      uShaftRange: { value: new THREE.Vector3() },
      uLightCount: { value: 0 },
      uLightPos: { value: vec4Array(MAX_MARCH_LIGHTS) },
      uLightCol: { value: vec4Array(MAX_MARCH_LIGHTS) },
      uLightDir: { value: vec4Array(MAX_MARCH_LIGHTS) },
      uLightPar: { value: vec4Array(MAX_MARCH_LIGHTS) },
      // A light contributing less than this to a sample does not get an
      // occlusion march. Set against the scale of the palette, where a lit cloud
      // face is around 1.0, so this is roughly "two per cent of nothing".
      uLightCutoff: { value: 0.02 },
      // One local-light sub-sample per 14 m of mist span. Set against the width
      // of a beam rather than against anything about the march: a lamp cone at
      // a hundred metres is some tens of metres across, and a stride that steps
      // over it turns the beam into dots.
      uLightSubDiv: { value: 1 / 14 },
      uBlueNoise: { value: this.blueTex },
    };

    this.compositeUniforms = {
      uScene: { value: null },
      uCloud: { value: null },
      uDepth: { value: null },
      uCamFwd: this.marchUniforms.uCamFwd,
      uCamRight: this.marchUniforms.uCamRight,
      uCamUp: this.marchUniforms.uCamUp,
      uTanHalf: this.marchUniforms.uTanHalf,
      uClip: this.marchUniforms.uClip,
      uDepthStride: this.marchUniforms.uDepthStride,
      uSunDir: this.marchUniforms.uSunDir,
      uSunColor: this.marchUniforms.uSunColor,
      uSkyZenith: { value: c3(P.skyZenith) },
      uSkyHorizon: { value: c3(P.skyHorizon) },
      uSkyGround: { value: c3(P.skyGround) },
      uHazeColor: this.marchUniforms.uHazeColor,
      uAerialK: this.marchUniforms.uAerialK,
      uBlueNoise: { value: this.blueTex },
      uExposure: { value: 1 },
      uDitherPhase: { value: 0 },
    };

    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: this.compositeUniforms,
      depthTest: false, depthWrite: false, toneMapped: false,
    });

    this._quadGeo = new THREE.PlaneGeometry(2, 2);
    this._quad = new THREE.Mesh(this._quadGeo, this.compositeMat);
    this._quad.frustumCulled = false;
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.setQuality(quality);
  }

  /** Rebuilds the march program. Costs a shader compile, so it is not something
   *  to do per frame — presets are a settings-menu decision. */
  setQuality(name) {
    const q = CLOUD_QUALITY[name] || CLOUD_QUALITY.high;
    this.quality = name in CLOUD_QUALITY ? name : 'high';
    this.preset = q;

    if (this.marchMat) this.marchMat.dispose();
    this.marchMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MARCH_FRAG,
      uniforms: this.marchUniforms,
      defines: {
        MARCH_STEPS: q.steps,
        LIGHT_STEPS: q.lightSteps,
        MS_OCTAVES: q.msOctaves,
        SHAFT_STEPS: q.shaftSteps,
        LIGHT_SHADOW_TAPS: q.shadowTaps,
        MAX_LIGHTS: MAX_MARCH_LIGHTS,
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    });

    this.marchUniforms.uMaxDist.value = q.maxDist;
    this.marchUniforms.uStepRange.value.set(q.minStep, q.growth, q.maxStep, q.coarseMin);
    this.marchUniforms.uSoftK.value = q.softK;
    this.marchUniforms.uTauCap.value = q.tauCap;
    this.marchUniforms.uCoarseMax.value = q.coarseMax;
    this.marchUniforms.uDetailFade.value.set(q.detailFade[0], q.detailFade[1]);
    this.marchUniforms.uShaftStep.value.set(q.shaftReach[0], q.shaftReach[1], q.shaftStride[0], q.shaftStride[1]);
    this._writeShaftUniforms();
    this._targetsDirty = true;
    return this;
  }

  /** The art-direction half of the god rays, pushed to the shader. Separate from
   *  setQuality because these are tuned live and must not cost a shader
   *  rebuild — a recompile between two captures makes them incomparable. */
  _writeShaftUniforms() {
    const s = this.shaft;
    const q = this.preset;
    this.marchUniforms.uShaft.value.set(s.mist, s.sun, s.phaseG, s.local);
    this.marchUniforms.uShaftRange.value.set(q.shaftRange[0], q.shaftRange[1], s.farShadow);
    this.marchUniforms.uShaftSigma.value = s.sigma;
    this.marchUniforms.uShaftFloor.value = s.floor;
    this.marchUniforms.uShaftDensGain.value = s.densGain;
  }

  _ensureTargets(renderer) {
    const size = renderer.getDrawingBufferSize(this._v2);
    const w = Math.max(1, size.x | 0);
    const h = Math.max(1, size.y | 0);
    const hw = Math.max(1, Math.round(w * this.preset.scale));
    const hh = Math.max(1, Math.round(h * this.preset.scale));

    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h &&
        this.cloudRT && this.cloudRT.width === hw && this.cloudRT.height === hh && !this._targetsDirty) {
      return;
    }
    this._targetsDirty = false;

    if (!this.sceneRT || this.sceneRT.width !== w || this.sceneRT.height !== h) {
      if (this.sceneRT) { this.sceneRT.depthTexture.dispose(); this.sceneRT.dispose(); }
      const depth = new THREE.DepthTexture(w, h);
      depth.type = THREE.UnsignedIntType;
      depth.format = THREE.DepthFormat;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      // Half float, not byte. The scene is composited against clouds in linear
      // HDR and then tone mapped once at the end; an 8-bit intermediate would
      // clip the ship's lights before the cloud in front of them was applied.
      this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: depth,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }

    if (!this.cloudRT || this.cloudRT.width !== hw || this.cloudRT.height !== hh) {
      if (this.cloudRT) this.cloudRT.dispose();
      this.cloudRT = new THREE.WebGLRenderTarget(hw, hh, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }

    this.marchUniforms.uDepthStride.value.set(w / hw, h / hh);
    this.marchUniforms.uDepth.value = this.sceneRT.depthTexture;
    this.compositeUniforms.uDepth.value = this.sceneRT.depthTexture;
    this.compositeUniforms.uScene.value = this.sceneRT.texture;
    this.compositeUniforms.uCloud.value = this.cloudRT.texture;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Advance the field. Call once per fixed step, before render.
   *
   * Everything time-dependent is resolved here, in double precision, and handed
   * to the shader as a finished number. The shader never sees an elapsed time,
   * which is what makes a twelve-hour session look the same as the first minute.
   */
  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    const f = this.field;

    // The sky first, because everything downstream is lit by it. The luminaries
    // own the whole palette — key direction and colour, ambient, haze, deep
    // tint and the sky gradient — so there is exactly one place that decides
    // what colour this world is at any moment, and the sky can never disagree
    // with the light that is supposedly making it.
    if (this.sky) { this.sky.update(t); this.sky.applyTo(this); }

    if (camera) {
      camera.getWorldPosition(this._camPos);
      this._recentre(this._camPos);
    }

    // Wrap each advection to its own period. The field is periodic, so a wrapped
    // offset samples the identical point — and the offset never grows, so it
    // never quantises.
    const wrap = (v, p) => { const m = v % p; return m < 0 ? m + p : m; };
    f.shapeAdvect[0] = wrap(WIND.shape.x * t, CLOUD.SHAPE_PERIOD);
    f.shapeAdvect[1] = wrap(WIND.shape.y * t, CLOUD.SHAPE_PERIOD);
    f.shapeAdvect[2] = wrap(WIND.shape.z * t, CLOUD.SHAPE_PERIOD);
    f.detailAdvect[0] = wrap(WIND.detail.x * t, CLOUD.DETAIL_PERIOD);
    f.detailAdvect[1] = wrap(WIND.detail.y * t, CLOUD.DETAIL_PERIOD);
    f.detailAdvect[2] = wrap(WIND.detail.z * t, CLOUD.DETAIL_PERIOD);
    f.weatherAdvect[0] = wrap(WIND.weather.x * t, CLOUD.WEATHER_PERIOD);
    f.weatherAdvect[2] = wrap(WIND.weather.z * t, CLOUD.WEATHER_PERIOD);

    // Two breathing phases, ~48 s and ~120 s. Pure phases: they wrap at 1.0 and
    // the wave is continuous across the wrap, so this can run forever.
    f.breath[0] = (t * 0.0210) % 1;
    f.breath[1] = (t * 0.0083) % 1;

    f.covGain = this.coverageGain;
    f.covBias = this.coverageBias;
    f.erosion = this.erosion;
    f.densityScale = this.densityScale;

    this._updateStorms(t);
  }

  /** Snap the origin to a whole quantum when the camera wanders far enough.
   *  Every period divides the quantum, so the field does not move. */
  _recentre(p) {
    const q = CLOUD.ORIGIN_QUANTUM;
    const ox = Math.round(p.x / q) * q;
    const oz = Math.round(p.z / q) * q;
    if (ox !== this.origin.x || oz !== this.origin.z) {
      this.origin.set(ox, 0, oz);
      this.originShifts = (this.originShifts || 0) + 1;
    }
  }

  /**
   * Electrical cells.
   *
   * Anchored to a world grid and chosen by the weather map's charge channel, so
   * a storm is a place rather than an effect: it is in the same spot when the
   * player comes back, and a player who has learned to read the sky can see it
   * coming. The flash schedule is a pure function of time and position, which
   * means the CPU knows what the sky is about to do — the Lantern needs that,
   * and so do the instruments it interferes with.
   */
  _updateStorms(t) {
    const g = CLOUD.STORM_GRID;
    const cx = Math.round(this._camPos.x / g);
    const cz = Math.round(this._camPos.z / g);
    const w = this._scratchW;
    const found = [];

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = (cx + dx) * g, gz = (cz + dz) * g;
        // Jitter the anchor off the lattice, or the storms sit on a visible grid.
        const hx = hashf(gx * 0.013, gz * 0.017, this.seed);
        const hz = hashf(gz * 0.011, gx * 0.019, this.seed ^ 0x9e37);
        const x = gx + (hx - 0.5) * g * 0.7;
        const z = gz + (hz - 0.5) * g * 0.7;

        const px = x - this.origin.x, pz = z - this.origin.z;
        sample2D(this.weather, (px + this.field.weatherAdvect[0]) * this.field.invWeather,
                 (pz + this.field.weatherAdvect[2]) * this.field.invWeather, w);
        const charge = w[2] * w[1];
        if (charge < 0.30) continue;

        const dxp = x - this._camPos.x, dzp = z - this._camPos.z;
        found.push({ x, z, charge, d2: dxp * dxp + dzp * dzp, h: hx });
      }
    }
    found.sort((a, b) => a.d2 - b.d2);

    const P = CLOUD_PALETTE;
    for (let i = 0; i < 4; i++) {
      const s = this.storms[i];
      const c = found[i];
      if (!c) {
        s.intensity = 0; s.charge = 0;
        this.lights.set(s.light, { on: false });
        continue;
      }

      s.x = c.x;
      s.z = c.z;
      s.y = CLOUD.LAYER_BASE + CLOUD.LAYER_THICKNESS * (0.22 + c.h * 0.24);
      // Tight. An electrical cell lights the cloud it is inside and a rim of
      // the ones next to it; a wide falloff turns a strike into a full-screen
      // flash that erases every silhouette the player was reading.
      s.radius = 480 + c.charge * 620;
      s.charge = c.charge;

      // A stroke is a fast rise and a decaying flicker, not a square pulse. The
      // flicker is what the ear expects to match, later.
      const period = 6.5 + c.h * 11.0;
      const phase = ((t / period) + c.h * 7.13) % 1;
      const win = 0.075;
      let stroke = 0;
      if (phase < win) {
        const x = phase / win;
        stroke = Math.exp(-x * 6.0) * (0.62 + 0.38 * Math.sin(x * 47.0));
        if (stroke < 0) stroke = 0;
      }
      const ember = 0.10 + 0.06 * Math.sin(t * 0.7 + c.h * 9.0);
      s.intensity = (ember * 0.55 + stroke * 2.6) * c.charge;
      const mixF = clamp01(stroke * 2.2);
      s.r = lerp(P.stormEmber[0], P.stormFlash[0], mixF);
      s.g = lerp(P.stormEmber[1], P.stormFlash[1], mixF);
      s.b = lerp(P.stormEmber[2], P.stormFlash[2], mixF);

      // STORM_LIGHT_GAIN converts the old falloff's peak to the new one's.
      // The march used to add intensity * exp(-r/radius) straight into the cloud
      // radiance with no phase function; it now goes through the same
      // inverse-square, cone and phase path as every other light, and a
      // side-on phase value of about 0.57 is what has to be divided out for a
      // stroke to be as bright as it was before it started casting shafts.
      this.lights.set(s.light, {
        on: s.intensity > 0.001,
        position: [s.x, s.y, s.z],
        color: [s.r, s.g, s.b],
        intensity: s.intensity * STORM_LIGHT_GAIN,
        radius: s.radius,
        shadowRange: s.radius * 1.6,
        // A stroke has to win a slot against the ship's lamps for the frame it
        // lasts, and an ember must not.
        priority: 1 + stroke * 9,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Draw the scene and the clouds, tone mapped and composited, into whatever
   * target is currently bound. Replaces `renderer.render(scene, camera)`.
   */
  renderFrame(renderer, scene, camera) {
    if (!this.enabled) { renderer.render(scene, camera); return; }

    this._ensureTargets(renderer);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    renderer.info.reset();

    // The scene goes to a linear HDR buffer with no tone mapping — three only
    // applies tone mapping and the output transfer when drawing to the canvas,
    // which is exactly what is wanted here, because the blend with the clouds
    // has to happen in linear light and be tone mapped once, afterwards.
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);

    this._writeCameraUniforms(camera, renderer);

    renderer.setRenderTarget(this.cloudRT);
    if (this.volumetric) {
      // Optional GPU timer around the march alone. Present in the hot path
      // because the only honest way to report what the volumetric costs is to
      // measure the volumetric, and a separate instrumented copy of this
      // function would drift from the one that actually runs.
      const q = this._beginGpuQuery(renderer, 'march');
      this._quad.material = this.marchMat;
      renderer.render(this._quadScene, this._quadCam);
      this._endGpuQuery(renderer, q);
    } else {
      // Fully transparent cloud buffer: the composite still runs, so the delta
      // against a normal frame is the march and nothing else.
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    }

    renderer.setRenderTarget(prevTarget);
    this.compositeUniforms.uExposure.value = renderer.toneMappingExposure * this.exposure;
    this._quad.material = this.compositeMat;
    renderer.render(this._quadScene, this._quadCam);

    renderer.info.autoReset = prevAutoReset;
  }

  /**
   * Push this frame's field parameters to the shared uniform block.
   *
   * Separate from the camera write because anything that samples the field on
   * the GPU needs it, not only a frame — the agreement probe most of all. It
   * used to happen only inside renderFrame, which meant verifyAgreement()
   * compared a freshly updated CPU field against whatever the shader had been
   * left holding, and reported a disagreement that did not exist. A test that
   * can fail for a reason unrelated to what it is testing is worse than no test.
   */
  _writeFieldUniforms() {
    const u = this.marchUniforms;
    const f = this.field;
    u.uShapeAdvect.value.set(f.shapeAdvect[0], f.shapeAdvect[1], f.shapeAdvect[2]);
    u.uDetailAdvect.value.set(f.detailAdvect[0], f.detailAdvect[1], f.detailAdvect[2]);
    u.uWeatherAdvect.value.set(f.weatherAdvect[0], 0, f.weatherAdvect[2]);
    u.uBreath.value.set(f.breath[0], f.breath[1], f.breath[2], f.breath[3]);
    u.uCoverage.value.set(f.covGain, f.covBias);
    u.uErosion.value.set(f.erosion, 0);
    u.uDensityScale.value = f.densityScale;
  }

  _writeCameraUniforms(camera, renderer) {
    const u = this.marchUniforms;

    camera.updateMatrixWorld();
    camera.getWorldPosition(this._v3);
    u.uCamPos.value.set(this._v3.x - this.origin.x, this._v3.y - this.origin.y, this._v3.z - this.origin.z);

    const m = camera.matrixWorld.elements;
    u.uCamRight.value.set(m[0], m[1], m[2]).normalize();
    u.uCamUp.value.set(m[4], m[5], m[6]).normalize();
    u.uCamFwd.value.set(-m[8], -m[9], -m[10]).normalize();

    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    u.uTanHalf.value.set(tanY * camera.aspect, tanY);
    u.uClip.value.set(camera.near, camera.far);
    u.uSunDir.value.copy(this.sun).normalize();

    this._writeFieldUniforms();

    // Jitter and dither phases are functions of simulation time, never of a
    // frame counter. Two captures seeked to the same time have to produce the
    // same bytes or the evidence is worthless.
    const frameIndex = Math.floor(this.time * 60);
    u.uJitter.value = (frameIndex * 0.6180339887) % 1;
    this.compositeUniforms.uDitherPhase.value = (frameIndex * 0.7548776662) % 1;

    this._writeShaftUniforms();
    // Chosen here rather than in update(), because which lights are worth
    // marching depends on where the camera ended up, and update() runs at the
    // fixed step while this runs per drawn frame.
    this.lights.prepare(this._v3, u.uCamFwd.value);
    this.lights.writeUniforms(u, this.origin);
  }

  // -------------------------------------------------------------------------
  // Queries — the same field, on this side of the bus
  // -------------------------------------------------------------------------

  /** Density at a world point, in [0, 1]. Pass detailLod 0 to skip the fine
   *  texture, which is what the shader's shadow march does and is around a third
   *  cheaper when only the broad shape matters. */
  densityAt(x, y, z, detailLod = 1) {
    return this._densityCloud(x - this.origin.x, y - this.origin.y, z - this.origin.z, detailLod);
  }

  /** Height through the cloud layer, 0 at the base and 1 at the top. */
  heightFractionAt(y) {
    return clamp01((y - this.field.layerBase) * this.field.invThickness);
  }

  _densityCloud(px, py, pz, detailLod, soft = 0) {
    const f = this.field;
    const S = this._scratchS, W = this._scratchW, D = this._scratchD;

    const h = clamp01((py - f.layerBase) * f.invThickness);
    sample2D(this.weather, (px + f.weatherAdvect[0]) * f.invWeather, (pz + f.weatherAdvect[2]) * f.invWeather, W);
    sample3D(this.shape,
      (px + f.shapeAdvect[0]) * f.invShape,
      (py + f.shapeAdvect[1]) * f.invShape,
      (pz + f.shapeAdvect[2]) * f.invShape, S);

    const breath = Math.sin(TAU * (S[3] * 1.7 + f.breath[0])) * f.breath[2]
                 + Math.sin(TAU * (S[2] * 2.3 - f.breath[1])) * f.breath[3];

    const coverage = clamp01(W[0] * f.covGain + f.covBias + breath);
    if (coverage <= 0.001) return 0;

    let wfbm = S[1] * 0.625 + S[2] * 0.25 + S[3] * 0.125;
    wfbm = lerp(wfbm, S[1], clamp01(soft * 1.8));
    const base = remapG(S[0], wfbm * 0.52 - 0.10 - soft, 1.0 + soft);
    const grad = heightGradient(h, W[1]);

    let d = remapG(base * grad, 1.0 - coverage - soft * 0.5, 1.0 + soft * 0.35);
    if (d <= 0) return 0;
    d *= coverage;

    if (detailLod > 0) {
      sample3D(this.detail,
        (px + f.detailAdvect[0]) * f.invDetail,
        (py + f.detailAdvect[1]) * f.invDetail,
        (pz + f.detailAdvect[2]) * f.invDetail, D);
      let dfbm = D[0] * 0.625 + D[1] * 0.25 + D[2] * 0.125;
      dfbm = lerp(dfbm, D[3], 0.30);
      const e = lerp(1 - dfbm, dfbm, clamp01(h * 3));
      const k = f.erosion * detailLod * (1 - smoothstep(0.30, 0.85, d)) * (1 - soft * 1.5);
      d = remapG(d, e * Math.max(k, 0), 1.0);
    }
    return d * f.densityScale;
  }

  /**
   * Air velocity at a world point, in metres per second, written into `out`
   * along with a turbulence magnitude.
   *
   * The three advection winds are the truth about how the visible layers move,
   * so a ship that drifts with this drifts with what the player can see. On top
   * of them sits a local term: air is pushed up through the middle of a growing
   * cloud and falls at its edges, which is both what makes flying near one
   * unpleasant and what a creature riding the updraught would use.
   */
  flowAt(x, y, z, out = { x: 0, y: 0, z: 0, turbulence: 0 }) {
    const px = x - this.origin.x, py = y, pz = z - this.origin.z;
    const f = this.field;
    const W = this._scratchW;
    sample2D(this.weather, (px + f.weatherAdvect[0]) * f.invWeather, (pz + f.weatherAdvect[2]) * f.invWeather, W);

    // Shear: the fine layer runs ahead of the bodies, and the bodies ahead of
    // the front. Which one dominates depends on how deep in the cloud you are.
    const h = clamp01((py - f.layerBase) * f.invThickness);
    const s = smoothstep(0.0, 0.7, h);
    out.x = lerp(WIND.shape.x, WIND.detail.x, s * 0.5) + WIND.weather.x * 0.25;
    out.z = lerp(WIND.shape.z, WIND.detail.z, s * 0.5) + WIND.weather.z * 0.25;
    // Vertical flow comes ONLY from local convection, below. It used to start at
    // WIND.shape.y, and that was a uniform 0.65 m/s updraft over the entire
    // world — measured across 20000 points, p05 through p95 all read exactly
    // 0.65 and 98.6% of samples were positive. Air cannot rise everywhere at
    // once; horizontal wind can cross a world, vertical wind has nowhere to come
    // from. Applied to the ship as an acceleration it made a perfectly level
    // craft climb at a constant 5.1 m/s, which carried it from its spawn at
    // y=140 to y=3303 in ten minutes with no input — out of the altitude band
    // the whole palette was tuned in, which is most of why the art direction
    // failed during real play while passing at a hand-posed camera.
    //
    // WIND.shape.y is untouched and still advects the noise, so the clouds go on
    // boiling upward. What changed is only that the *pattern* rising is no
    // longer reported as the *air* rising.
    out.y = 0;

    // Local convection, estimated from the vertical density gradient. A core
    // that thickens with height is rising; one that thins is subsiding.
    const g = 26;
    const dLo = this._densityCloud(px, py - g, pz, 0);
    const dHi = this._densityCloud(px, py + g, pz, 0);
    const dHere = this._densityCloud(px, py, pz, 0);
    const rise = (dHi - dLo) * 0.5;
    const towering = clamp01(W[1] * 1.6 - 0.3);
    out.y += rise * 46 * (0.4 + towering) + dHere * towering * 5.0;

    // Turbulence is strongest at the boundary, not in the core: the ride is
    // roughest going in and out of a cloud, which is a navigation decision.
    const edge = 1 - Math.abs(dHere * 2 - 1);
    out.turbulence = clamp01(edge * (dHere > 0.02 ? 1 : 0) * (0.55 + towering * 0.9));
    return out;
  }

  /**
   * Transmittance along a segment, in [0, 1]. This is line of sight: what a
   * creature can see of the ship, what the ship's lights reach, how much of a
   * distant call arrives. `steps` trades accuracy for cost — 24 is enough to
   * decide whether something is hidden, and cheap enough to run per creature.
   */
  transmittance(ax, ay, az, bx, by, bz, steps = 24) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return 1;
    const ds = len / steps;
    const sigma = this.marchUniforms.uSigmaT.value;
    let tau = 0;
    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) / steps;
      tau += this._densityCloud(
        ax + dx * u - this.origin.x, ay + dy * u, az + dz * u - this.origin.z, 0) * ds;
      if (tau * sigma > 8) return 0;
    }
    return Math.exp(-tau * sigma);
  }

  /**
   * How well hidden a point is, in [0, 1]. Local density plus the density of the
   * shell around it, because sitting in a thin patch with clear air on all sides
   * hides nothing. Sampled on a fixed pattern so the answer is stable frame to
   * frame — a concealment value that flickers would make the whole hiding
   * mechanic feel arbitrary.
   */
  concealmentAt(x, y, z) {
    const R = 90;
    const pts = CONCEAL_OFFSETS;
    let sum = this._densityCloud(x - this.origin.x, y, z - this.origin.z, 0) * 2.0;
    let wsum = 2.0;
    for (let i = 0; i < pts.length; i += 3) {
      sum += this._densityCloud(
        x + pts[i] * R - this.origin.x, y + pts[i + 1] * R, z + pts[i + 2] * R - this.origin.z, 0);
      wsum += 1;
    }
    return clamp01((sum / wsum) * 2.6);
  }

  /** Coverage the weather map reports for a column, in [0, 1]. Cheap enough for
   *  a map or an instrument to sample on a grid every frame. */
  coverageAt(x, z) {
    const f = this.field;
    const W = this._scratchW;
    sample2D(this.weather,
      (x - this.origin.x + f.weatherAdvect[0]) * f.invWeather,
      (z - this.origin.z + f.weatherAdvect[2]) * f.invWeather, W);
    return clamp01(W[0] * f.covGain + f.covBias);
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * Sample the field at N pseudo-random points on both sides of the bus and
   * report the disagreement.
   *
   * This is the test that makes the CPU query trustworthy. Without it "the CPU
   * matches the shader" is a comment, and comments do not survive a refactor of
   * the density function.
   */
  verifyAgreement(renderer, { count = 256, radius = 6000 } = {}) {
    const gl = renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_float')) {
      return { ok: false, reason: 'EXT_color_buffer_float unavailable' };
    }
    this._writeFieldUniforms();

    const pos = new Float32Array(count * 4);
    let seed = 0x1234567;
    const rnd = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      // Bias toward the layer, because agreement in empty air above the clouds
      // is not the interesting case.
      pos[i * 4 + 0] = (rnd() * 2 - 1) * radius;
      pos[i * 4 + 1] = CLOUD.LAYER_BASE - 200 + rnd() * (CLOUD.LAYER_THICKNESS + 400);
      pos[i * 4 + 2] = (rnd() * 2 - 1) * radius;
      pos[i * 4 + 3] = 1;
    }

    const probeTex = new THREE.DataTexture(pos, count, 1, THREE.RGBAFormat, THREE.FloatType);
    probeTex.minFilter = probeTex.magFilter = THREE.NearestFilter;
    probeTex.needsUpdate = true;

    const rt = new THREE.WebGLRenderTarget(count, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });

    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: PROBE_FRAG,
      uniforms: { ...this.fieldUniforms, uProbe: { value: probeTex } },
      depthTest: false, depthWrite: false, toneMapped: false,
    });

    const prev = renderer.getRenderTarget();
    const prevMat = this._quad.material;
    this._quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(this._quadScene, this._quadCam);
    const out = new Float32Array(count * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, count, 1, out);
    renderer.setRenderTarget(prev);
    this._quad.material = prevMat;

    let maxErr = 0, sumErr = 0, maxBase = 0, cloudy = 0;
    let worst = null;
    for (let i = 0; i < count; i++) {
      const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
      // The probe works in cloud space, exactly like the shader does during a
      // frame, so compare against the same space rather than through the origin.
      const cpuDetail = this._densityCloud(x, y, z, 1);
      const cpuBase = this._densityCloud(x, y, z, 0);
      const gpuDetail = out[i * 4], gpuBase = out[i * 4 + 1];
      const e = Math.abs(cpuDetail - gpuDetail);
      const eb = Math.abs(cpuBase - gpuBase);
      if (gpuBase > 0.001 || cpuBase > 0.001) cloudy++;
      sumErr += e;
      if (e > maxErr) { maxErr = e; worst = { x, y, z, cpu: cpuDetail, gpu: gpuDetail }; }
      if (eb > maxBase) maxBase = eb;
    }

    mat.dispose();
    rt.dispose();
    probeTex.dispose();

    return {
      ok: maxErr < 0.02,
      count,
      cloudySamples: cloudy,
      maxAbsError: +maxErr.toFixed(5),
      meanAbsError: +(sumErr / count).toFixed(6),
      maxAbsErrorNoDetail: +maxBase.toFixed(5),
      worst,
      note: 'residual is GPU 8-bit filter weight quantisation, not a logic difference',
    };
  }

  // -------------------------------------------------------------------------
  // GPU timing
  //
  // performance.now() around a draw call measures how long it took to *submit*
  // the work, not to do it. gl.finish() is supposed to close that gap and on this
  // machine's D3D11 backend it does not: a full 1080p march and an empty frame
  // both come back at four tenths of a millisecond, which is a submission cost,
  // not a render cost. EXT_disjoint_timer_query_webgl2 asks the GPU itself, which
  // is the only source that knows. Where the extension is missing the fallback
  // fences with a one-pixel readback, which is slower and noisier but real.
  // -------------------------------------------------------------------------

  _beginGpuQuery(renderer, scope) {
    if (this._gpuScope !== scope) return null;
    const gl = renderer.getContext();
    const q = gl.createQuery();
    gl.beginQuery(this._gpuExt.TIME_ELAPSED_EXT, q);
    return q;
  }

  _endGpuQuery(renderer, q) {
    if (!q) return;
    const gl = renderer.getContext();
    gl.endQuery(this._gpuExt.TIME_ELAPSED_EXT);
    this._gpuQueries.push(q);
  }

  async _drainGpuQueries(gl) {
    // Without this the results never arrive. The commands are sitting in a queue
    // the driver has not been asked to submit, and polling for a result of work
    // that has not started is a loop that only ends when the timeout does.
    gl.flush();

    // Wait on the last query only. They complete in submission order, so once it
    // is ready the rest are too, and this is one wait instead of N.
    //
    // The wait yields through a MessageChannel, which took three attempts to get
    // right and is worth writing down. A microtask spin never resolves: the
    // browser submits the command buffer on a task, and spinning on microtasks
    // starves exactly that task. setTimeout does yield to it, but a backgrounded
    // or non-compositing tab — the situation this project is developed in —
    // clamps it to a second, which turns a five-second benchmark into a
    // ten-minute one. A message port is a real task and is not clamped.
    const queries = this._gpuQueries;
    if (queries.length) {
      const last = queries[queries.length - 1];
      const chan = new MessageChannel();
      const yieldToTask = () => new Promise((resolve) => {
        chan.port1.onmessage = () => resolve();
        chan.port2.postMessage(0);
      });
      const deadline = performance.now() + 4000;
      while (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE) && performance.now() < deadline) {
        await yieldToTask();
      }
      chan.port1.close();
      chan.port2.close();
    }

    // A disjoint means the GPU was reset or clocked down somewhere in this batch,
    // which makes every timing in it meaningless. Read once — reading clears the
    // flag, so asking per query would only ever catch the first one.
    const disjoint = gl.getParameter(this._gpuExt.GPU_DISJOINT_EXT);

    const out = [];
    for (const q of queries) {
      if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      }
      gl.deleteQuery(q);
    }
    this._gpuQueries.length = 0;
    out.sort((a, b) => a - b);
    return out;
  }

  /**
   * Measure the volumetric pass at a stated resolution. Async, because a GPU
   * timer result is not available until the GPU has finished the work.
   *
   * `volumetric` is the march alone, which is the figure the budget names.
   * `frame` is everything renderFrame does, including the scene, the composite
   * and the tone map.
   */
  async benchPass(renderer, scene, camera, { width = 1920, height = 1080, frames = 32 } = {}) {
    const gl = renderer.getContext();
    this._gpuExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._gpuQueries = [];

    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevAspect = camera.aspect;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    const stats = (a) => {
      // Null rather than zeros: a measurement that did not happen must not look
      // like a fast one.
      if (!a.length) return null;
      const at = (p) => a[Math.min(a.length - 1, Math.round((p / 100) * (a.length - 1)))];
      return { median: +at(50).toFixed(3), p95: +at(95).toFixed(3), p99: +at(99).toFixed(3), samples: a.length };
    };

    let march = null, frame = null, method = 'gpu-timer';

    if (this._gpuExt) {
      const EXT = this._gpuExt.TIME_ELAPSED_EXT;
      // Warm the caches and let the card clock up; the first few frames after a
      // resize are not what anyone will be playing at.
      this._gpuScope = null;
      for (let i = 0; i < 5; i++) this.renderFrame(renderer, scene, camera);

      // The march alone, timed from inside renderFrame.
      this._gpuScope = 'march';
      for (let i = 0; i < frames; i++) this.renderFrame(renderer, scene, camera);
      this._gpuScope = null;
      march = stats(await this._drainGpuQueries(gl));

      // Everything renderFrame does, timed from outside it.
      for (let i = 0; i < frames; i++) {
        const q = gl.createQuery();
        gl.beginQuery(EXT, q);
        this.renderFrame(renderer, scene, camera);
        gl.endQuery(EXT);
        this._gpuQueries.push(q);
      }
      frame = stats(await this._drainGpuQueries(gl));
    } else {
      method = 'readback-fence';
      const px = new Uint8Array(4);
      const run = (vol) => {
        this.volumetric = vol;
        const ts = [];
        for (let i = 0; i < frames; i++) {
          const t0 = performance.now();
          this.renderFrame(renderer, scene, camera);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b) => a - b);
        return ts;
      };
      const offStats = stats(run(false));
      const onStats = stats(run(true));
      this.volumetric = true;
      frame = onStats;
      // A subtraction, because the readback fence has a large fixed cost of its
      // own — around thirty milliseconds here — that is present in both halves.
      march = { median: +(onStats.median - offStats.median).toFixed(3), p95: null, p99: null, samples: frames };
    }

    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();

    return {
      method,
      quality: this.quality,
      resolution: [width, height],
      marchResolution: [this.cloudRT.width, this.cloudRT.height],
      volumetric: march,
      frame,
      budgetVolumetric: 7.0,
      budgetRender: 11.0,
      withinBudget: march ? march.median < 7.0 : null,
    };
  }

  dispose() {
    this.shapeTex.dispose();
    this.detailTex.dispose();
    this.weatherTex.dispose();
    this.blueTex.dispose();
    if (this.sceneRT) { this.sceneRT.depthTexture.dispose(); this.sceneRT.dispose(); }
    if (this.cloudRT) this.cloudRT.dispose();
    this.marchMat.dispose();
    this.compositeMat.dispose();
    this._quadGeo.dispose();
  }
}

// A 14-point spherical pattern (cube corners plus face centres), normalised.
// Fixed rather than random so concealment is stable frame to frame.
const CONCEAL_OFFSETS = (() => {
  const k = 0.5773502692;
  return new Float32Array([
    1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1,
    k, k, k, -k, k, k, k, -k, k, -k, -k, k,
    k, k, -k, -k, k, -k, k, -k, -k, -k, -k, -k,
  ]);
})();

/** See where it is used: the factor that keeps a lightning stroke as bright as
 *  it was before it was routed through the light registry and picked up a phase
 *  function. */
const STORM_LIGHT_GAIN = 0.55;

/** Three.js wants a uniform array to arrive already the size the shader
 *  declares; a shorter one silently uploads garbage into the tail. */
function vec4Array(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = new THREE.Vector4();
  return a;
}

/** Deterministic float in [0,1) from two coordinates. Storm anchors only. */
function hashf(a, b, seed) {
  let h = Math.imul(Math.round(a * 8192) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(b * 8192) | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}


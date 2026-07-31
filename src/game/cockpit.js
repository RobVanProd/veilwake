// The cockpit.
//
//   import { Cockpit } from './game/cockpit.js';
//   const cockpit = new Cockpit({ clouds });
//   cockpit.syncPalette(CLOUD_PALETTE);
//   scene.add(cockpit.object3D);
//   cockpit.warmup(renderer, scene, camera);   // before loop.start()
//   // once per fixed step, after ship.step():
//   cockpit.update(dt, ship, camera, controls.lightsOn);
//
// It is real geometry in the world, not an overlay. It is drawn into the same
// linear HDR scene buffer everything else is, composited by the cloud pass, and
// tone mapped once with the rest of the frame — so it is subject to the same
// exposure and the same palette, and there is no way for it to drift out of the
// look the way a DOM or an orthographic-overlay cockpit always eventually does.
//
// --- why it exists ----------------------------------------------------------
//
// The world just got very dark. p50 luminance went from 190 to 36 looking into
// the sun. Darkness on its own does not read as dread; it reads as *empty*,
// because there is nothing in frame for it to be dark in relation to. A near
// field fixes that, and this is the only near field the game has. It is also the
// only thing on screen that states, continuously and without a number, how small
// the machine is.
//
// --- the three things it has to do ------------------------------------------
//
// **Be rigid while the camera is not.** CAMERA_DEFAULTS puts the eye at
// [0, 0.55, 1.9] in ship space on a spring — positionLag 26, rotationLag 11.
// This geometry is welded to the ship at the same origin. So under any real
// input the frame and the eye disagree by a few centimetres and a few degrees,
// and the frame swings against a world that is not swinging. That disagreement
// is mass. Attaching the cockpit to the camera instead would delete it, and is
// the single most common way this feature is built wrong.
//
// **Receive the world's light.** Not a scene light — the *world's*. The sun's
// direction and colour come off the cloud system, and how much of it arrives is
// CloudSystem.transmittance() along the real ray, so flying into a thunderhead
// puts the cockpit out. The canopy frame then cuts what is left into bars that
// sweep across the interior as the ship turns. See materials.js.
//
// **Cost nothing.** It is on screen 100% of the time, so its cost is permanent.
// Two draw calls, under a thousand triangles, no shadow map, no render target,
// no material variants, and — measured, not assumed — no allocation per frame.
// It is also a net *saving* on the volumetric: the third of the frame it covers
// is a third of the frame the cloud march terminates in under two metres.

import * as THREE from 'three';
import { approach, clamp01 } from '../core/math.js';
import { buildStructure } from './cockpit/structure.js';
import { buildInstruments, GAUGE, SIG_BASE } from './cockpit/instruments.js';
import { surfaceMaterial, instrumentMaterial } from './cockpit/materials.js';
import { LAYOUT, EYE, wallAt, roofAt, deckAt, clearance } from './cockpit/layout.js';
import { CHANNELS, SIG } from './signature.js';

export { GAUGE, LAYOUT };

/**
 * How many luminaries the shell is lit by.
 *
 * Fixed at compile time because the shader's uniform arrays are sized to it and
 * PERFORMANCE_BUDGET §7 forbids a second variant. sky.js defines exactly three
 * and says why there are three; if a fourth is ever added, this and the arrays
 * in materials.js change together and the shader is rebuilt at startup.
 */
const LUMINARIES = 3;

/**
 * The panel's normalisation of the six signature channels, in CHANNELS order.
 *
 * This mirrors `Signature.exposure()` and deliberately does not call it: that
 * method allocates a fresh object per call by design, and PERFORMANCE_BUDGET §5
 * puts steady-state allocation at zero rather than "few". Every divisor is read
 * from `SIG.exposureRef` rather than copied, so retuning the model retunes the
 * instrument and the two can never disagree about what a full bar means.
 *
 * The order is asserted against CHANNELS at construction, because the columns in
 * the well are addressed as `SIG_BASE + i` and a silent reordering upstream
 * would relabel every bar in the cockpit without changing a line of this file.
 */
function normaliseChannel(i, v) {
  const r = SIG.exposureRef;
  switch (i) {
    case 0: return clamp01((v.acoustic - SIG.hullFloorDb) / r.acoustic);
    case 1: return clamp01(v.thermal / r.thermal);
    // Lumens span four decades between instrument glow and a scan flash, so a
    // linear bar would show the nav lights and the search lamp as the same
    // nothing. Same log form the model uses.
    case 2: return clamp01(Math.log10(1 + v.photic) / Math.log10(1 + r.photic));
    case 3: return clamp01(v.em / r.em);
    case 4: return clamp01(v.wake / r.wake);
    default: return clamp01(v.relSpeed / r.relSpeed);
  }
}

export const COCKPIT_DEFAULTS = {
  /**
   * How far along the sun ray line-of-sight is integrated, in metres.
   *
   * Not "to the sun". The sun in this game is a direction, not a place, and the
   * cloud layer is 3.5 km thick — past a couple of kilometres the answer stops
   * changing and the samples are just cost. Matched to the march's own
   * shaftRange at high quality so the cockpit dims at the same moment the shafts
   * outside it do.
   */
  sunProbeRange: 2200,
  sunProbeSteps: 10,
  /**
   * Floor under the sun's transmittance.
   *
   * Deep inside a cloud the direct term is zero, and a cockpit that goes
   * absolutely black is not dramatic, it is a bug report. This stands in for the
   * multiply-scattered light that does still arrive — the same quantity the
   * march's own multiple-scattering octaves account for outside.
   */
  sunFloor: 0.085,
  /** Overall gain on the world's sun, for the interior only. */
  sunGain: 1.0,
  /**
   * How hard the interior ambient is lifted above the cloud palette's.
   *
   * A closed box physically gets *less* sky than open air, so this ought to be
   * below 1. It is 4.5 because of an interaction that only shows up in a
   * capture: the palette's ambientTop is [0.028, 0.062, 0.120] and the cockpit's
   * albedo is around 0.05, which puts an ambient-lit facet at 0.003 linear —
   * under 5/255 after exposure and ACES, i.e. flat black with no facet edges
   * visible at all. A shape-less near field is worse than a slightly generous
   * one, and the lift is spent entirely on making the shell's eight facets
   * distinguishable from each other in shadow. It is still nearly black.
   */
  ambientLift: 4.5,
  /** Light returning off vapour lit by the ship's own lamps. Part of the price
   *  of switching them on: the pilot can suddenly see their own hands. */
  lampBounce: 0.055,
  /** Instrument brightness. The whole panel's budget, and it is small. */
  instrumentGain: 0.115,
  /**
   * Where the warning light starts to come up, as a fraction of full scale on
   * the worst single channel.
   *
   * 0.55 rather than something tidier because of what the channels actually do
   * in play: cruising with everything off sits the worst channel around 0.3 to
   * 0.4 — relSpeed alone does that, and a warning that is on during ordinary
   * flight is not a warning, it is decoration. Boost or the lamp puts a channel
   * past 0.7 immediately. So the lamp is dark while the player is being careful
   * and lit the moment they spend something, which is exactly the relationship
   * the panel is there to teach.
   */
  alertFrom: 0.55,
  /** How often the medium is sampled, in fixed steps. 12 at 120 Hz is 10 Hz,
   *  which is far faster than cloud density changes around a moving ship. */
  probeEvery: 12,
};

export class Cockpit {
  /**
   * @param {object}  opts
   * @param {import('../render/clouds.js').CloudSystem} opts.clouds
   *        The world's light. Optional — without it the cockpit falls back to a
   *        fixed key and stops responding to the medium, which is a legible
   *        degradation rather than a crash.
   */
  constructor({ clouds = null, signature = null, ...opts } = {}) {
    this.cfg = { ...COCKPIT_DEFAULTS, ...opts };
    this.clouds = clouds;
    /**
     * The ship's own emissions, for the signature cluster in the centre well.
     *
     * Optional, like `clouds`. Without it the six columns sit at zero and the
     * rest of the panel is unaffected, which is a legible degradation rather
     * than a crash — and it means this can be wired in main.js independently of
     * everything else here.
     */
    this.signature = signature;

    // The panel addresses the six columns positionally, as SIG_BASE + i. If the
    // model ever reorders or renames its channels, every bar in the cockpit
    // silently relabels itself and nothing else in the game notices. Fail here,
    // at construction, where it is one line to read rather than a mystery.
    const EXPECTED = 'acoustic,thermal,photic,em,wake,relSpeed';
    if (CHANNELS.join(',') !== EXPECTED) {
      throw new Error(
        `cockpit: signature CHANNELS changed to [${CHANNELS}] — the well's ` +
        `columns are positional and normaliseChannel() must be updated to match`);
    }

    this.group = new THREE.Group();
    this.group.name = 'cockpit';
    // Matrices are written by hand every step from the ship's own transform.
    this.group.matrixAutoUpdate = true;

    this.surfMat = surfaceMaterial();
    this.emisMat = instrumentMaterial();
    this.emisMat.uniforms.uGain.value = this.cfg.instrumentGain;

    this._buildMeshes();

    // --- live state, all preallocated -------------------------------------
    /** Total light arriving, summed over the luminaries. Written by update();
     *  initialised here so stats() is callable before the first step. */
    this.sunVis = 0;
    this.density = 0;
    this.gauges = this.emisMat.uniforms.uGauge.value;   // Float32Array(16)
    this._probe = 0;

    /**
     * Per-luminary transmittance through the medium, smoothed, and its target.
     *
     * Two arrays rather than one so the probe can run at 10 Hz while the value
     * the shader sees moves continuously. A cockpit that steps its brightness at
     * the probe rate reads as a flickering light rather than as weather.
     */
    this.lightVis = new Float32Array(LUMINARIES).fill(1);
    this._visTarget = new Float32Array(LUMINARIES).fill(1);
    /** Live intensity per luminary, for stats() and for skipping dead probes. */
    this._lightUp = new Float32Array(LUMINARIES);

    this._invQ = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    /** Fallback light direction, used only when there is no CloudSystem. */
    this._fallbackDir = new THREE.Vector3(0, 0.1, -1).normalize();

    this._triangles = this.structure.geometry.index.count / 3
                    + this.instruments.geometry.index.count / 3;
  }

  _buildMeshes() {
    const surf = buildStructure();
    const emis = buildInstruments();

    this.structure = new THREE.Mesh(surf.build(), this.surfMat);
    this.instruments = new THREE.Mesh(emis.build(), this.emisMat);

    for (const m of [this.structure, this.instruments]) {
      // Always in view by construction, and its bounding sphere overlaps the
      // near plane, which is exactly the case where a frustum test is both
      // useless and occasionally wrong.
      m.frustumCulled = false;
      // Drawn before everything else so the depth buffer rejects the third of
      // the frame it covers before any of it is shaded.
      m.renderOrder = -10;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
    this.structure.updateMatrix();
    this.instruments.updateMatrix();
  }

  /** The thing to add to the scene. */
  get object3D() { return this.group; }

  /**
   * One fixed step.
   *
   * Call after `ship.step(dt)`. Order against `shipCam.update` does not matter —
   * the cockpit reads the camera only for a specular highlight, and being one
   * step stale on that is not observable.
   *
   * @param {number} dt
   * @param {import('./flight.js').Flight} ship
   * @param {THREE.Camera} camera
   * @param {boolean|{lightsOn?: boolean}} [state] exterior lights, on or off.
   *        A bare boolean is preferred at the call site: an object literal here
   *        is an allocation every fixed step, which is 120 a second against a
   *        budget of zero (PERFORMANCE_BUDGET §5). The object form is accepted
   *        so that more ship state can be added later without a signature break,
   *        but a caller using it should hoist the object.
   */
  update(dt, ship, camera, state) {
    const u = this.surfMat.uniforms;
    const c = this.cfg;

    // --- welded to the ship ------------------------------------------------
    this.group.position.copy(ship.position);
    this.group.quaternion.copy(ship.orientation);

    // Ship space is this group's object space, so every light term below is a
    // rotation of a world vector into it and nothing more.
    this._invQ.copy(ship.orientation).invert();

    this._v.set(0, 1, 0).applyQuaternion(this._invQ);
    u.uUpLocal.value.copy(this._v);

    if (camera) {
      this._v.copy(camera.position).sub(ship.position).applyQuaternion(this._invQ);
      u.uEyeLocal.value.copy(this._v);
    }

    const sky = this.clouds && this.clouds.sky;
    const lights = sky && sky.lights;

    // --- the medium, sampled slowly ---------------------------------------
    // These are CPU queries into the cloud field. None of them changes fast
    // relative to a ship crossing it, and all are smoothed on arrival rather
    // than stepped, so the interior brightens and dims continuously instead of
    // ticking at the probe rate.
    //
    // Probed before the uniforms are written, not after. Writing first and
    // probing second costs a step of lag on every light term for nothing, and
    // more to the point it makes the order load-bearing without saying so.
    if (this.clouds && (this._probe-- <= 0)) {
      this._probe = c.probeEvery;
      const p = ship.position, R = c.sunProbeRange;
      for (let i = 0; i < LUMINARIES; i++) {
        const L = lights && lights[i];
        // A luminary that is below the horizon contributes nothing, and probing
        // a kilometre of cloud to discover that is the most expensive way to
        // multiply by zero. The ember is down for two thirds of its cycle, so
        // this is a third of the probe cost saved most of the time.
        if (!L || L.intensity <= 0) { this._visTarget[i] = 0; continue; }
        const s = L.dir;
        this._visTarget[i] = c.sunFloor + (1 - c.sunFloor) * this.clouds.transmittance(
          p.x, p.y, p.z, p.x + s.x * R, p.y + s.y * R, p.z + s.z * R, c.sunProbeSteps);
      }
      this._densTarget = clamp01(this.clouds.densityAt(p.x, p.y, p.z, 0) * 2.2);

      // Ambient follows the sky the luminaries compose, so a shadowed facet is
      // lit by what is actually up there. Written on the probe rather than every
      // step: it is a slow quantity and this is four vector writes at 10 Hz.
      if (sky) {
        const k = c.ambientLift;
        u.uAmbTop.value.copy(sky.ambientTop).multiplyScalar(k);
        u.uAmbBottom.value.copy(sky.ambientBottom).multiplyScalar(k);
      }
    }
    for (let i = 0; i < LUMINARIES; i++) {
      this.lightVis[i] = approach(this.lightVis[i], this._visTarget[i], 2.5, dt);
    }
    this.density = approach(this.density, this._densTarget ?? 0, 1.8, dt);

    // --- the luminaries ----------------------------------------------------
    //
    // Read live, every step, from the same `sky.lights` that the volumetric
    // march and main.js's DirectionalLights read. Nothing is cached and nothing
    // is a constant: when the ember rises, the inside of this ship turns the
    // colour of it on the same frame the clouds do, and when it sets the
    // interior goes back to being lit by the veil and the drown alone.
    //
    // Direction is rotated into ship space here rather than in the shader
    // because the canopy shadow is expressed in ship space — three rotations a
    // frame on the CPU against a per-pixel matrix multiply on the GPU.
    let lit = 0;
    for (let i = 0; i < LUMINARIES; i++) {
      const L = lights && lights[i];
      if (L) {
        u.uLightDir.value[i].copy(L.dir).applyQuaternion(this._invQ);
        u.uLightColor.value[i].copy(L.color).multiplyScalar(L.intensity * c.sunGain);
        this._lightUp[i] = L.intensity;
      } else if (i === 0) {
        // No CloudSystem: one dim, fixed key so the shape is still readable.
        u.uLightDir.value[i].copy(this._fallbackDir).applyQuaternion(this._invQ);
        u.uLightColor.value[i].set(1.0, 1.1, 1.2);
        this._lightUp[i] = 1;
      } else {
        u.uLightColor.value[i].set(0, 0, 0);
        this._lightUp[i] = 0;
      }
      u.uLightVis.value[i] = this.lightVis[i];
      lit += this._lightUp[i] * this.lightVis[i];
    }

    /**
     * One scalar for "how much light is getting in", for the diagnostic line and
     * for the vapour bounce below. Not a uniform — the shader has the three
     * separately and mixing them into one would be throwing away the only thing
     * that makes three luminaries worth having.
     */
    this.sunVis = lit;

    // --- light coming back off the vapour ahead ----------------------------
    // The lamp is the loudest thing the player can do on the photic channel, and
    // this is the half of that cost they can see from where they sit: switch the
    // lights on in thick cloud and the inside of the cockpit lifts.
    const lamp = (state === true || (state !== null && typeof state === 'object' && state.lightsOn)) ? 1 : 0;
    const b = c.lampBounce * lamp * (0.22 + 2.4 * this.density) + 0.0045 * this.sunVis;
    u.uBounce.value.set(b, b * 0.985, b * 0.94);

    // --- instruments -------------------------------------------------------
    const g = this.gauges;
    const t = ship;
    g[GAUGE.AIRSPEED] = clamp01(Math.abs(t.airspeed) / 210);
    g[GAUGE.ENERGY] = clamp01(t.energy / 100);
    g[GAUGE.THROTTLE] = clamp01(t.throttleSmoothed);
    g[GAUGE.MEDIUM] = this.density;
    g[GAUGE.TURBULENCE] = clamp01(t.turbulenceLevel);
    // Lamps. Approached rather than set, so none of them can snap — an
    // instrument that switches instantly reads as a UI event, and beats 3 to 5
    // of the emotional sequence die the moment a warning is a UI event.
    g[GAUGE.STALL] = approach(g[GAUGE.STALL], t.stalled ? 1 : 0, 6.0, dt);
    g[GAUGE.LAMPS] = approach(g[GAUGE.LAMPS], lamp, 7.0, dt);
    g[GAUGE.BOOST] = approach(g[GAUGE.BOOST], clamp01(t.boostSmoothed), 5.0, dt);

    // --- the signature cluster ---------------------------------------------
    //
    // Six channels, total exposure, and the worst channel as a warning light.
    // Read straight off the live model, normalised the way the model normalises
    // itself, and approached rather than assigned for the same reason the lamps
    // are: a bar that steps reads as a UI event, and the moment a warning is a
    // UI event the player is looking at software instead of at a machine.
    //
    // The rates are not uniform, and that is the point. The channels move at 4,
    // fast enough that cutting the engine is visibly answered inside a quarter
    // of a second — the feedback loop the whole hiding mechanic is learned
    // through. Exposure moves at 2.5, so the summary lags its own parts and the
    // player sees the cause before the consequence. The warning light rises at
    // 5 and is deliberately not smoothed on the way down by the same amount:
    // see below.
    if (this.signature) {
      const v = this.signature.values();
      let worst = 0, sum = 0;
      for (let i = 0; i < CHANNELS.length; i++) {
        const x = normaliseChannel(i, v);
        sum += x;
        if (x > worst) worst = x;
        g[SIG_BASE + i] = approach(g[SIG_BASE + i], x, 4.0, dt);
      }
      g[GAUGE.EXPOSURE] = approach(g[GAUGE.EXPOSURE], sum / CHANNELS.length, 2.5, dt);

      // The warning light leads on the way up and lags on the way down.
      //
      // A light that fades out as fast as it came on lets the player stop paying
      // for a mistake the instant they stop making it, which teaches that the
      // emission is the danger. It is not — the emission is already gone; what
      // is still out there is whatever heard it. Holding the lamp up after the
      // spike is the only honest thing this panel can say about that, and it
      // costs one asymmetric rate.
      const alertTarget = clamp01((worst - c.alertFrom) / (1 - c.alertFrom));
      const rising = alertTarget > g[GAUGE.ALERT];
      g[GAUGE.ALERT] = approach(g[GAUGE.ALERT], alertTarget, rising ? 5.0 : 0.7, dt);
    }

    return this;
  }

  /**
   * Seed the ambient from a static palette.
   *
   * Kept for the call in main.js and for a cockpit built without a CloudSystem,
   * but it is no longer how the interior gets its light: `update()` takes the
   * ambient live from `clouds.sky`, which recomposes it from whichever
   * luminaries are currently up. This only decides what the first frame looks
   * like before the first probe lands, and what a cockpit with no world at all
   * falls back to.
   *
   * The palette's `sun` is deliberately ignored. There is no sun — see sky.js —
   * and reading one here is how the interior ended up lit by a single fixed key
   * while the world outside it had three moving ones.
   */
  syncPalette(palette) {
    if (!palette) return this;
    const u = this.surfMat.uniforms;
    const at = palette.ambientTop, ab = palette.ambientBottom;
    const k = this.cfg.ambientLift;
    if (at) u.uAmbTop.value.set(at[0] * k, at[1] * k, at[2] * k);
    if (ab) u.uAmbBottom.value.set(ab[0] * k, ab[1] * k, ab[2] * k);
    return this;
  }

  /**
   * Compile up front.
   *
   * PERFORMANCE_BUDGET §7 makes zero post-startup shader compiles a hard rule,
   * and a cockpit added to the scene but not warmed compiles on the first frame
   * it is visible. Call after adding to the scene and before `loop.start()`.
   *
   * **Pass the real scene.** The first version compiled against `this.group`,
   * which looks like it should work and does not: three's program cache key
   * includes the light counts of the render state it was built for, whatever the
   * material actually uses. Compiling against a bare Group therefore produced
   * two programs keyed for zero lights, the draw inside a scene holding a
   * directional and a hemisphere light missed them, and the count went 3 -> 5 on
   * warm-up and 5 -> 7 on the first draw: two compiles still landing during
   * play, plus two dead programs. Measured, not reasoned about.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene the scene this cockpit was added to
   * @param {THREE.Camera} camera
   */
  warmup(renderer, scene, camera) {
    // And the render target has to match too, for the same reason: three keys a
    // program partly on tone mapping and output colour space, and both of those
    // are read from whether a render target is bound. The cockpit is drawn into
    // the cloud system's linear HDR scene buffer, never to the canvas, so a
    // compile done with no target bound produces programs the real draw misses —
    // measured, 3 compiled at warm-up and 2 more still landing on frame one.
    //
    // sceneRT does not exist until the cloud system has sized its targets, which
    // happens inside the first renderFrame. Called before that, this warms what
    // it can and the remaining two compile on frame one, which is startup rather
    // than play; called after one frame has been drawn, it warms everything.
    const target = this.clouds && this.clouds.sceneRT ? this.clouds.sceneRT : null;
    const prev = renderer.getRenderTarget();
    try {
      if (target) renderer.setRenderTarget(target);
      renderer.compile(scene || this.group, camera);
    } catch (_) { /* the first frame will do it */ } finally {
      renderer.setRenderTarget(prev);
    }
    return this;
  }

  /** Rebuild the geometry after editing layout.js. Iteration only; the shadow
   *  is baked into the shader, so this rebuilds the material too. */
  rebuild() {
    for (const m of [this.structure, this.instruments]) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.surfMat.dispose();
    this.emisMat.dispose();
    this.surfMat = surfaceMaterial();
    this.emisMat = instrumentMaterial();
    this.emisMat.uniforms.uGain.value = this.cfg.instrumentGain;
    this.gauges = this.emisMat.uniforms.uGauge.value;
    this._buildMeshes();
    return this;
  }

  /** What it costs, for the diagnostic line. */
  stats() {
    return {
      drawCalls: 2,
      triangles: this._triangles,
      /** Total light arriving, summed over the luminaries. Not a fraction. */
      sunVis: +this.sunVis.toFixed(3),
      /** Per-luminary transmittance, in sky.js order: veil, ember, drown. */
      lightVis: Array.from(this.lightVis).map((v) => +v.toFixed(3)),
      lightUp: Array.from(this._lightUp).map((v) => +v.toFixed(3)),
      density: +this.density.toFixed(3),
      /**
       * The seal, as one pair of numbers. `backing` is the closest the backing
       * shell comes to the design eye and it must stay above `camera.near`
       * (0.5) by more than the camera's worst excursion, or the near plane cuts
       * a hole in the cockpit. See LAYOUT.hullThickness.
       */
      clearance: clearance(EYE),
      signature: !!this.signature,
      eye: EYE,
      /** Area of the canopy aperture as a fraction of the frame, base FOV, 16:9.
       *  The aperture only — see openFraction(). */
      apertureOpen: openFraction(),
      /**
       * What the cockpit actually covers, aperture plus pods plus rail plus
       * coaming, as a fraction of the frame.
       *
       * Re-measured after the backing shell and the detail geometry went in, by
       * classifying a 100x56 grid of pixels with a raycast that models the near
       * plane and comparing against a render with the cockpit hidden. Two
       * independent methods, same answer. The previous figure here was 0.48 and
       * came from counting pixels on the old mesh at the mood test's two
       * reference poses; it is 0.459 now because the aperture is unchanged and
       * the grid is finer, not because anything opened up.
       */
      coverageMeasured: 0.459,
    };
  }

  dispose() {
    for (const m of [this.structure, this.instruments]) m.geometry.dispose();
    this.surfMat.dispose();
    this.emisMat.dispose();
    this.group.clear();
  }
}

/**
 * How much of the frame is clear of the canopy aperture, at the base FOV, 16:9.
 *
 * "It must not occlude so much that flying becomes unpleasant" is a requirement,
 * and a requirement with no number attached is a preference — so this exists to
 * be checked against a capture rather than to replace one.
 *
 * It computes the actual octagon's area by shoelace, which the first version did
 * not: it multiplied the horizontal opening by the average vertical opening, as
 * though the aperture were a rectangle, and reported 0.729 for a frame that was
 * measured — against a bare render, pixel for pixel — to be covering 53%. The
 * chamfered corners were a quarter of the image that no arithmetic anywhere
 * accounted for. Treat this as the aperture only: it does not include the
 * instrument pods, the coaming rail, or the halo the cloud composite's
 * depth-aware filter leaves along the silhouette, which between them are worth
 * roughly another eight points. `stats().coverageMeasured` in the report is the
 * number that counted pixels.
 */
export function openFraction() {
  const TAN_Y = 0.6009, TAN_X = TAN_Y * 16 / 9;
  const cx = LAYOUT.cornerX, cy = LAYOUT.cornerY;
  let best = 1;
  // Scan: the profile is curved, so the tightest cross-section in screen terms
  // is not guaranteed to be at either end.
  for (let d = 0.40; d <= LAYOUT.mouth + 1e-6; d += 0.02) {
    const sx = Math.min(1, wallAt(d) / (TAN_X * d));
    const st = Math.min(1, roofAt(d) / (TAN_Y * d));
    const sb = Math.min(1, deckAt(d) / (TAN_Y * d));
    const p = [
      [sx, st * cy], [sx * cx, st], [-sx * cx, st], [-sx, st * cy],
      [-sx, -sb * cy], [-sx * cx, -sb], [sx * cx, -sb], [sx, -sb * cy],
    ];
    let area2 = 0;
    for (let i = 0; i < 8; i++) {
      const a = p[i], b = p[(i + 1) & 7];
      area2 += a[0] * b[1] - b[0] * a[1];
    }
    // Frame area in these normalised coordinates is 2 x 2.
    best = Math.min(best, Math.abs(area2) / 2 / 4);
  }
  return +best.toFixed(3);
}

// The Wake Hunter's body.
//
//   import { WakeHunterView } from './render/bodies/wakehunter.view.js';
//   views.register('WakeHunter', (c, o) => new WakeHunterView(c, o));
//
// One view per member. The pack is three to seven of these and nothing here
// knows about the others except through `creature.packIndex`, which is enough:
// the simulation already spreads them across its 600 m front, and what this file
// has to add is that they do not *move* identically. See `_phase`.
//
// --- what this body is for ---------------------------------------------------
//
// §10.3 is the only fast creature and the only one that hunts in numbers, and
// the whole avoidance vocabulary — turbulence erases, cross-flow separates, fly
// under your heat — is worthless to a player who has not first understood that
// running is what wrote the trail. So the single thing this shape has to say,
// from the first glimpse and at any distance, is **several small things moving
// quickly and together**. Not one mass, not slow. Everything below is in service
// of that sentence:
//
//   * a lean blade of a body, 6.7 : 1 and laterally compressed, so the flank
//     silhouette is tall and the head-on silhouette is nearly nothing — you see
//     them when they turn across you, which is when they are hunting;
//   * a travelling body wave whose beat frequency is derived from the animal's
//     own speed, so `UNAWARE` at 12 m/s idles and `COMMITTED` at 120 m/s thrashes
//     and the state ladder is legible without a single explicit state check;
//   * a lunate caudal fin a quarter of the body long, because a forked tail is
//     the most universally readable "this thing is fast" in nature;
//   * a bank into turns, which the simulation does not have and does not need —
//     see `_roll`;
//   * and the vapour tell, below, which is the part §10.3 actually promises.
//
// --- the tell ----------------------------------------------------------------
//
// §10.3: they raise `u` to about 0.6 within 200 m, "**visible in the vapour
// before they are**". The simulation publishes `turbulenceAt()` and says plainly
// that nothing consumes it yet, and the medium is not this file's to write. So
// the tell here is rendered rather than simulated — but it is rendered as a
// *modulation of the medium*, not as objects hanging in it, and the difference
// is the whole of this section.
//
// It is driven by speed, which is the honest coupling — speed is what writes the
// trail in §3.3 and speed is what stirs the air — so a drifting pack has almost
// no tell and a committed one arrives inside a disturbance the player can see
// first. That is §10.3's escalation table's last row, "turbulence arriving
// before they do", drawn instead of described.
//
// --- why the obvious mechanism cannot work -----------------------------------
//
// The first two attempts at this drew additive ribbons, and both were wrong in
// the same way. The measurement that settles it, from `evidence/whA_*` — the
// same frame captured with the tell forced on and forced off, differenced:
//
//   background      range   worst pixel, tell off -> on        delta
//   lit cloud       150 m   (179,208,214) -> (  8, 13, 21)     -186
//   lit cloud       400 m   (169,200,206) -> ( 11, 17, 26)     -174
//   lit cloud       700 m   (166,198,204) -> (  9, 14, 22)     -174
//   dark sky        150 m   (  6, 13, 25) -> ( 87,111,141)      +98
//   dark sky        400 m   ( 10, 19, 35) -> ( 66, 86,113)      +67
//
// The tell was a hole on cloud and a lamp on sky, at every range a pack is
// fought at, and the *reason* is structural rather than a matter of tuning.
//
// `COMPOSITE_FRAG` resolves every pixel as `bg * cloud.a + cloud.rgb`, where
// `bg` is the scene buffer only when the depth buffer says something is there —
// `if (myDist > 9.0e5) bg = vw_sky(rd)` throws the scene colour away otherwise.
// So a mesh in this scene has exactly two options and no third:
//
//   * write no depth, and be **deleted**. The composite never samples `uScene`
//     for it and the march runs past it to the far plane. Measured at seven
//     times the intended opacity it showed nothing at all.
//   * write depth, and **replace** everything beyond it. The march stops at the
//     mesh, so `cloud.rgb` no longer contains the cloud behind it, and that
//     pixel becomes the mesh's own colour and nothing else.
//
// A constant colour in the second case is a constant *substitution* into a
// background that ranges from 0.005 to about 1.0 in linear light — two hundred
// to one. There is no constant that is not a hole at one end and a lamp at the
// other. The previous pass answered the review by fading the streaks out beyond
// 500 m, which removed them from the capture being argued about and left them
// intact across 150-500 m, where the numbers above were taken.
//
// --- what this draws instead --------------------------------------------------
//
// The trap in the paragraph above is the word "beyond". A depth-writing fragment
// has to state what is behind it *at the depth it claims to be at* — and nothing
// says the sleeve has to claim to be where it is.
//
// So it does not. **Every fragment of the tell writes the depth at which the
// cloud march was going to stop anyway** — where its ray leaves the layer, or
// the far plane if it never does — instead of the sleeve's real distance. That
// one decision is the whole design, and it buys four things at once:
//
//   * the march is not stopped at the animal, so `cloud.rgb` and `cloud.a` still
//     contain the whole column of vapour the player was looking at. The
//     background is delivered by the compositor, exactly, with no reconstruction
//     error at all — which is the failure every earlier attempt died of;
//   * the composite still reads the scene buffer for those pixels, because the
//     depth is inside the frustum, so the fragment can add to what is there;
//   * the tell loses the depth test against every solid thing in the scene, so
//     it can never cover the animal, a pack member, or the ship. The whole class
//     of "it deleted what was behind it" is gone rather than bounded;
//   * and the composite multiplies the scene buffer by `cloud.a` — the
//     transmittance of the entire column — so a disturbance drawn this way is
//     *automatically* buried by cloud in front of it, in exactly the proportion
//     the medium says it should be.
//
// What the fragment writes is the value that makes the composite land on
// `B * (1 + s)`, where `B` is the background and `s` is a signed turbulence
// field — vapour piled up in some places and scoured thin in others. Working
// `bg * cloud.a + cloud.rgb` backwards through the aerial mix gives
//
//     scene = (sky(rd) + s * B / cloud.a - haze * aer) / (1 - aer)
//
// and the only quantity in it this file has to go and find is `B / cloud.a`,
// which comes from `clouds.cloudRT`. That ratio scales the *perturbation* and
// nothing else: an error in it makes the stirring slightly too strong or too
// weak. It cannot make a hole, because the hole would have to come from the
// background term, and the background term never passes through this file.
//
// Multiplicative is the other half of the point. The disturbance is a fraction
// *of the medium that is actually there*, so against a lit mass it is a visible
// stirring and against empty sky it is nothing — 30% of 0.005 is invisible, and
// no amount of it will ever be a lamp. The sign flip that made this "the worst
// thing in the deliverable" is gone by construction rather than by tuning.
//
// Two costs, stated rather than hidden:
//
//   * **`cloudRT` is one frame old.** During the scene pass the march has not
//     run yet, so what is there is the previous frame's. It is re-projected
//     through `compositeUniforms.uCamFwd/Right/Up/TanHalf` — the very basis that
//     produced that buffer — which makes the correction exact for camera
//     rotation and leaves only translation parallax, about 1.5 px per frame at
//     cruise against cloud a couple of kilometres out. It only ever mis-scales
//     the perturbation, so a stale frame is a slightly wrong amount of stirring
//     rather than a wrong picture.
//   * **A ray that never leaves the layer cannot be given its true stop.**
//     `uMaxDist` is 24 km and the camera's far plane is 12, so anything within
//     about eight degrees of level, seen from inside the deck, has to settle for
//     the far plane and loses the tail of its column beyond it. That is the only
//     residual left, it is confined to a horizontal band, and it is measured
//     rather than assumed: `evidence/whD_*` is the same frame captured with the
//     stirring forced to zero and the discard removed, which makes a correct
//     sleeve invisible and any error in the mechanism the whole of what is left.
//
// --- where this actually stands ----------------------------------------------
//
// The defect is fixed and the feature is not finished. Both halves of that are
// measured, and the second half is not hedging.
//
// **Fixed.** Against dark sky the tell now changes *nothing* — 0 pixels at 150,
// 300, 400, 700 and 1200 m, against +98, +73, +67 and +50 before. Against lit
// cloud the mean change over the sleeve is about 1.3 levels with localised
// maxima around 50, against a flat -174 to -186 across the whole footprint at
// every range before. There are no dashes, no capsules and no hard ends, because
// there is no discrete geometry left to have ends. The sign flip cannot come
// back: the background never passes through this file, and the disturbance is a
// multiplier on it.
//
// **Not finished.** The disturbance is too faint to read. With the stirring
// forced to zero the sleeve still changes the frame by a mean of 1.0 level —
// that is the mechanism's own residual — and at the shipped amplitude the signal
// is only about twice that. Two things are eating it, both outside this file:
//
//   * `camera.far` is 12 km and `uMaxDist` is 24, so a ray that is still inside
//     the cloud layer at the far plane cannot be given the depth the march would
//     have stopped at. Those fragments now decline to draw rather than deleting
//     the column beyond — which is why the tell is absent for views within about
//     eight degrees of level, and a pack flies at your altitude. Making the two
//     numbers meet removes the whole restriction.
//   * everything written here lands *behind* the cloud column and is multiplied
//     by its transmittance, measured at 0.002 to 0.08. Most of the amplitude is
//     spent before it reaches the pixel, and the only way to spend less is to
//     truncate the march nearer, which is what put the hole there in the first
//     place.
//
// The honest fix is still for the disturbance to be density in the volume rather
// than light behind it, and it still belongs to `clouds.js`: a handful of
// spheres in the field with a turbulence weight, fed from the `turbulenceAt()`
// the simulation already publishes and nothing consumes. Everything above is
// what a view file can reach, and it is not enough.
//
// --- what this file is not allowed to do -------------------------------------
//
// It never writes to `this.creature`. Every number below is read from the
// simulation — `speed`, `heading`, `pitch`, `state`, `trailExcess`, `packIndex`,
// `bodyLength` — or derived from the contract. If the body and the AI ever
// disagree about what a Wake Hunter is doing, this file is the one that is wrong.

import * as THREE from 'three';
import { CreatureView, fleshMaterial, glowMaterial } from '../creatures.js';
import { clamp, clamp01, lerp } from '../../core/math.js';

const TAU = Math.PI * 2;

/**
 * Everything the shape is, in one block, in the same spirit as `WAKE_HUNTER`.
 *
 * Values that come from the contract or from the simulation's own constants are
 * marked; the rest say what they were derived from and what breaks if changed.
 */
export const WAKE_HUNTER_VIEW = {
  /**
   * Body radius at the shoulders, as a fraction of body length.
   *
   * 0.075 gives an 8.2 m tall, 4.8 m wide animal on the contract's 55 m — a
   * 6.7 : 1 blade. Fatter than about 0.10 and it stops reading as fast; thinner
   * than about 0.05 and it disappears at the ranges these are usually seen at,
   * which are kilometres.
   */
  radiusFrac: 0.075,

  /**
   * Body-wave beat: one tail cycle per this many body lengths travelled.
   *
   * Real carangiform swimmers hold a stride of roughly 0.7 body lengths per
   * beat across their whole speed range, and holding it here is what makes the
   * speed ladder legible: `speedMps` runs 12 → 120 m/s, so this maps directly to
   * 0.31 Hz when drifting and 3.1 Hz when committed, a factor of ten in visible
   * urgency with no state machine in this file at all. A fixed frequency instead
   * would make a drifting pack look like a hunting one.
   */
  strideBodies: 0.7,
  /** Floor, so an idling animal still looks alive rather than dead-still. */
  minBeatHz: 0.22,

  /**
   * Lateral amplitude at the tail tip, as a fraction of body length, at speed.
   *
   * 0.055 each way is 0.11 L peak-to-peak, which is what a real fish does. Much
   * more and the animal reads as an eel — slow, sinuous, the wrong creature.
   */
  tailAmpFrac: 0.055,

  /**
   * Waves along the body at any instant. Just over one, which is the carangiform
   * signature: the head stays nearly still and the wave grows aft. Below ~0.6 the
   * whole body slews side to side and looks like it is being dragged.
   */
  waveCount: 1.15,

  /**
   * Bank into a turn, radians per rad/s of yaw rate.
   *
   * The simulation deliberately has no roll — `creatures.js` says so — and it is
   * right not to: rolling is not a behaviour, it is what a fast body does when it
   * turns. At the contract's 1.09 rad/s maximum turn rate this gives 0.60 rad,
   * about 35°, which is a hard bank and reads instantly at any distance. Without
   * it a turning hunter looks like it is sliding sideways on rails, and turning
   * is nearly all a pack does.
   */
  bankPerYawRate: 0.55,
  maxBank: 0.7,
  /** Seconds for the bank to catch up. Instant banking looks like a glitch. */
  bankLagSec: 0.28,

  /**
   * How far the body bends into a turn, in body lengths per rad/s.
   *
   * Separate from the bank because they are separate things: the bank is the
   * whole animal rotating, this is the spine curving. Together they are what
   * makes a carve read as a carve.
   */
  bendPerYawRate: 3.2,

  /** Pectoral blade length and where it is rooted, in body lengths. */
  finLenFrac: 0.20,
  /** Caudal lobe height, each lobe, in body lengths. 0.13 → a 0.26 L span. */
  caudalFrac: 0.13,
  /** Sensory filaments at the head, in body lengths. */
  barbelFrac: 0.22,

  // --- the tell ------------------------------------------------------------

  /**
   * How far the sleeve of disturbed vapour reaches ahead of and behind the
   * nose, in body lengths, and how fat it gets.
   *
   * §10.3's turbulence field is 200 m in radius. 1.9 L ahead is 105 m, so the
   * disturbance genuinely arrives before the animal at roughly the scale the
   * contract states, and it sits inside the field rather than pretending to be
   * all of it. Reaching much further ahead than this stops reading as this
   * animal's wake and starts reading as weather that happens to be there.
   *
   * 0.52 L of radius makes the sleeve about one body length across. That is the
   * largest it can be for the reason in the header: whatever it covers, it
   * replaces, and the only thing it is entitled to replace is medium.
   */
  tellAheadBodies: 1.9,
  tellBehindBodies: 2.6,
  tellRadiusBodies: 0.52,

  /**
   * Speeds between which the tell fades up, m/s.
   *
   * Straight off `WAKE_HUNTER.speedMps`: 25 is above the ALERT speed of 30's
   * lower neighbour and below SEARCHING's 55, and 120 is COMMITTED exactly. So a
   * drifting pack disturbs nothing, a searching one shimmers, and the one that
   * has your trail arrives inside a visible mess. If these ever stop matching
   * that ladder the tell stops being a readout of anything.
   */
  tellSpeedRange: [25, 120],

  /**
   * How hard the medium is stirred, as a fraction of whatever brightness is
   * already there, at the committed speed.
   *
   * There is no distance fade and there must not be one. The previous pass had
   * `tellFadeRangeM: [500, 1400]`, which existed to hide a hole that got worse
   * with range; a fraction of the background is *already* range-correct, because
   * the background it is a fraction of has been through the same aerial
   * perspective as everything else in the frame. Falloff now happens because the
   * sleeve subtends fewer pixels, which is the only reason anything else in this
   * game gets smaller.
   *
   * 1.0 means the medium can be doubled or scoured away entirely, which sounds
   * violent and is not: almost all of it is spent on the way out. The stirring
   * is written behind the whole cloud column and the composite multiplies it by
   * that column's transmittance, which measures 0.002 to 0.08 through anything
   * worth looking at, so what survives at the pixel is a small fraction of this
   * number. Measured against the same frame with the stirring forced to zero,
   * the mean change over the sleeve runs 1.0 level at an amplitude of 0 (that is
   * the mechanism's own residual), 1.5 at 0.3, and 2.3 at 1.0.
   *
   * It is set where the signal is about twice the residual rather than where the
   * picture is right, because at present the picture is not right — see the
   * bottom of the header. Raising it further is safe (the residual does not move
   * with it) and buys progressively less.
   */
  tellAmplitude: 1.0,

  /**
   * Size of the turbulent features, in body lengths: across the flight axis and
   * along it.
   *
   * Anisotropic on purpose, and by a factor of four. Shear stretches structure
   * along the flow, so features half a body length across and two body lengths
   * long read as something being dragged through the air. Isotropic noise at the
   * same scale reads as static.
   *
   * The lateral figure is also load-bearing for the reconstruction: filaments
   * have to be thin enough that a clean cloud-buffer tap exists within
   * `TELL_TAP_TEXELS` of every fragment, or the tell starts sampling its own
   * shadow and darkens back into the hole this rewrite exists to remove.
   */
  tellFeatureBodies: [0.50, 2.0],

  /**
   * Eyespot diameter in body lengths, and how bright.
   *
   * 0.026 L is 1.4 m — three pixels at 300 m, nothing at all beyond about a
   * kilometre, and the reason it exists is that a pack should be hard to *count*.
   * Pinpricks that appear and vanish as heads turn are what makes five of
   * something read as an unknown number of something.
   *
   * This is the one self-lit thing on the animal and it is deliberately below
   * the level the signature system would model: §10.3 gives the Wake Hunter no
   * photic emission, so anything brighter than a wet eye catching a luminary
   * would be the render telling the player something the simulation does not
   * believe. Same argument `creatures.js` makes for `FLESH.rim`.
   *
   * Both numbers came down after the first capture: at 1.4 m and 0.42 the
   * eyespot was the brightest thing in the frame and, being a quad, it read as a
   * literal white square stuck to the head. `evidence/wh_b_hero`. At 0.9 m and a
   * sixth of that brightness it is a glint that vanishes as the head turns,
   * which is the job.
   */
  eyeFrac: 0.016,
  eyeOpacity: [0.03, 0.09],
};

// --- mesh resolution ---------------------------------------------------------
//
// These are small on purpose. A 55 m animal at the ranges §10.3 works at — the
// pack sweeps a 600 m front and is usually a kilometre or more away — subtends a
// few dozen pixels, and seven of them must not cost more than a rounding error
// against PERFORMANCE_BUDGET's 400k triangles.

const RINGS = 17;          // spine samples, head (s=0) to tail tip (s=1)
const RADIAL = 8;          // around the body; the crest below hides the facets
const FIN_RING = 3;        // pectoral root, s = 0.1875 — the shoulder
const BARBEL_RING = 1;     // filament root, s = 0.0625 — the head
const TAIL_RING = RINGS - 1;
const BARBELS = 6;
const BARBEL_STATIONS = 5;
/**
 * The tell's carrier: a closed spindle around the flight axis.
 *
 * The geometry does nothing except deliver fragments over the region the
 * disturbance occupies and give each one an object-space coordinate. Nothing is
 * animated here and no vertex is ever rewritten — the churn lives entirely in
 * `uScroll`, which is one float per frame instead of the 560 vertices per animal
 * per frame the ribbons cost.
 *
 * 20 x 14 is 560 triangles, and it is that coarse because the silhouette is
 * never seen: `rimFade` in the shader takes the strength to zero where the
 * surface turns edge-on, so the visible boundary of the sleeve is a fade rather
 * than an outline and the facets are inside the part that has already faded out.
 * That is the same reason there is no `alphaTest` any more — the shape ends by
 * ceasing to perturb, not by an edge.
 */
const TELL_STATIONS = 20;
const TELL_RADIAL = 14;

/**
 * Spacing of the nine taps that read `B / cloud.a`, in half-res cloud texels.
 *
 * One, because that is the spacing `COMPOSITE_FRAG` reconstructs the cloud at,
 * and this kernel exists to be the same kernel. See the comment at the taps.
 *
 * A plain weighted mean, not a rank filter. An earlier pass took the brightest
 * of a spiral to reject taps the tell had truncated the frame before, and that
 * was wrong twice over: a truncated tap is darker than a clean one against cloud
 * but *brighter* against sky, because cutting the march short leaves the
 * transmittance high and the sky term unattenuated, so the rejection inverted
 * exactly when the background did. And any rank filter over a neighbourhood
 * dilates: at a cloud edge it measured 155 where the truth was 21. Neither
 * failure can happen now, because the depth claim means nothing here is
 * truncated relative to what the composite is using.
 */
const TELL_TAP_TEXELS = 1.0;

/**
 * Ceiling on `1 / cloud.a` — how far the stirring may be pre-amplified.
 *
 * The perturbation is written *behind* the whole column, so it has to be
 * pre-divided by the column's transmittance for the composite to multiply it
 * back out, and that divide is the one genuinely fragile thing in the shader:
 * an error of a few percent in a transmittance of 0.002 is an error of a few
 * hundred percent in the light that comes back.
 *
 * 60 puts the knee at a transmittance of 0.017. Measured over the band the
 * sleeve occupies, the median column reads 0.079 against a lit mass and 0.26
 * against open sky, so a normal frame is delivered at full strength and what
 * tails off is the inside of solid weather.
 *
 * The ceiling is set by stability, not by taste, and it was measured by panning
 * the camera a degree between the frame the cloud buffer came from and the frame
 * being drawn — which is what a brisk look-around actually does to the
 * reprojection. Peak error against a still frame: 0.7 levels at a gain of 20,
 * 1.3 at 60, 4.3 at 200, and 37 by a thousand, where a tap that disagrees with
 * the composite about whether it is inside a cloud stops being a small error and
 * starts being a flare. 60 is inside the flat part of that curve.
 */
const TELL_MAX_GAIN = 60.0;

/**
 * Body profile, half-height and half-width at each ring as a fraction of the
 * shoulder radius. Two separate curves rather than one radius because the
 * lateral compression *is* the design: tall from the flank, a sliver head-on.
 */
// The first pass ran 0.05 → 0.46 → 0.78 over the first three rings and produced
// a billfish: a long elegant taper to a point, which is a beautiful animal and
// entirely the wrong one. §10.3's hunter is blunt and front-heavy — the mass is
// in the head, because the head is the part that arrives. `evidence/wh_b_hero`
// is the marlin; the numbers below are what replaced it.
const PROFILE_H = [
  0.22, 0.62, 0.88, 1.00, 1.00, 0.95, 0.88, 0.79, 0.69,
  0.59, 0.49, 0.40, 0.31, 0.23, 0.16, 0.11, 0.06,
];
const PROFILE_W = [
  0.16, 0.42, 0.55, 0.59, 0.58, 0.55, 0.51, 0.46, 0.40,
  0.34, 0.28, 0.22, 0.17, 0.12, 0.08, 0.05, 0.03,
];
/**
 * Dorsal crest, added to the single topmost vertex of each ring.
 *
 * One vertex rather than a separate fin mesh: it costs nothing, it survives to
 * the furthest LOD because it is part of the body geometry, and a raised ridge
 * over the front half is what stops the flank silhouette reading as a cigar.
 */
const PROFILE_CREST = [
  0.00, 0.06, 0.28, 0.60, 0.88, 1.00, 0.94, 0.79, 0.62,
  0.46, 0.32, 0.20, 0.11, 0.05, 0.02, 0.00, 0.00,
];
const CREST_SCALE = 0.62;   // × shoulder radius, at the peak

/**
 * The body material, shared by every Wake Hunter on screen.
 *
 * Shared and therefore never disposed per-view — see `dispose()`. Roughness is
 * lower than `FLESH.roughness` (0.94) because this is the one animal in the
 * roster that moves fast enough for a sliding highlight to carry information: at
 * 0.86 an edge catches a luminary as it turns, and that flash *is* the speed cue
 * at ranges where the body wave is sub-pixel. Any lower and it starts to look
 * wet and mineral rather than like an animal.
 */
let BODY_MATERIAL = null;
function bodyMaterial() {
  if (!BODY_MATERIAL) {
    BODY_MATERIAL = fleshMaterial({
      roughness: 0.86,
      side: THREE.DoubleSide,   // the fins are single-sided blades
    });
  }
  return BODY_MATERIAL;
}

/** Deterministic per-member jitter. Not `Math.random`: a replay must repeat. */
function memberHash(i) {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// The tell's shader
// ---------------------------------------------------------------------------
//
// GLSL ES 3.00, declared through `glslVersion: GLSL3` — the same as
// `cloud.glsl.js`, which is the shader this one has to agree with. It is not
// optional here: `gl_FragDepth` does not exist in ES 1.00 without an extension,
// and writing depth is the mechanism.

const TELL_VERT = /* glsl */`
out vec3 vObj;
out vec3 vWorld;
out vec3 vNrm;
out vec3 vView;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // World normal. Used only for the rim fade, so the non-uniform part of the
  // model matrix (there is none — the view scales uniformly) does not matter.
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 vp = viewMatrix * wp;
  // View space is carried through because the composite's aerial term is a
  // function of slant range, not of depth: it reconstructs a view-space z from
  // the buffer and divides by cos(angle off axis). Reproducing that needs the
  // angle, and the angle is the view-space direction. Using one distance for the
  // whole sleeve instead puts a radial gradient of error across the frame — the
  // corner of a 62 degree view is off axis by fifty.
  //
  // (No backticks anywhere in these shader strings: they are template literals,
  // and a backtick in a comment ends the shader mid-word. It cost a boot.)
  vView = vp.xyz;
  gl_Position = projectionMatrix * vp;
}
`;

const TELL_FRAG = /* glsl */`
precision highp float;

in vec3 vObj;
in vec3 vWorld;
in vec3 vNrm;
in vec3 vView;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uCloud;      // last frame's march: rgb in-scatter, a transmittance
uniform vec2  uCloudTexel;     // 1 / cloudRT size
uniform vec3  uPrevFwd;        // the basis that produced uCloud, not this frame's
uniform vec3  uPrevRight;
uniform vec3  uPrevUp;
uniform vec2  uPrevTanHalf;

uniform vec3  uSkyZenith;      // the composite's own sky, so the reconstruction
uniform vec3  uSkyHorizon;     // of an empty pixel matches what it would have been
uniform vec3  uSkyGround;
uniform vec3  uHaze;
uniform float uAerialK;

uniform float uStrength;       // 0 at a drift, tellAmplitude at the committed speed
uniform float uScroll;         // seconds of aft-streaming, pre-wrapped on the CPU
uniform vec3  uSpan;           // object-space z ahead, z behind, sleeve radius
uniform vec2  uFeature;        // turbulence cell size, lateral and along the axis
uniform float uTapPx;          // ratio tap reach, in cloud-buffer texels
uniform vec3  uSlab;           // cloud layer base, top, and the march's max range
uniform vec2  uClipNF;         // camera near and far, for encoding gl_FragDepth

// --- the sky, as COMPOSITE_FRAG builds it ---------------------------------
//
// The same two smoothsteps over the same three colours. The sun halo is left
// out: it peaks at 0.02 against a horizon of 0.032 and only within about twelve
// degrees of a light that is never on screen, and carrying it would mean this
// file owning a copy of a number that belongs to the composite.
vec3 tellSky(vec3 rd) {
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(uSkyGround, uSkyHorizon, smoothstep(0.10, 0.50, t));
  return mix(c, uSkyZenith, smoothstep(0.50, 0.98, t));
}

float tellHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float tellNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(tellHash(i + vec3(0,0,0)), tellHash(i + vec3(1,0,0)), f.x),
        mix(tellHash(i + vec3(0,1,0)), tellHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(tellHash(i + vec3(0,0,1)), tellHash(i + vec3(1,0,1)), f.x),
        mix(tellHash(i + vec3(0,1,1)), tellHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

void main() {
  vec3 toEye = vWorld - cameraPosition;
  float dist = length(toEye);
  vec3 rd = toEye / max(dist, 1e-4);

  // --- how hard the medium is stirred here ---------------------------------
  //
  // u runs 0 at the leading tip of the sleeve to 1 at the trailing one.
  float u = clamp((vObj.z - uSpan.x) / (uSpan.y - uSpan.x), 0.0, 1.0);

  // Swirl before sampling: the sleeve is rolled about its own axis at a rate
  // that varies along it, so the filaments wind rather than lying in planes.
  // Without this the noise is stationary in the animal's frame and the whole
  // disturbance reads as a decal painted on a tube.
  float roll = uScroll * 0.55 + u * 2.3;
  float cs = cos(roll), sn = sin(roll);
  vec2 sw = vec2(vObj.x * cs - vObj.y * sn, vObj.x * sn + vObj.y * cs);
  vec3 q = vec3(sw / uFeature.x, vObj.z / uFeature.y + uScroll);

  // Two octaves. A third buys detail finer than the filaments the taps can see
  // around, which is the resolution limit set out in the header.
  float n = tellNoise(q) * 0.66 + tellNoise(q * 2.7 + 11.3) * 0.34;
  n = n * 2.0 - 1.0;

  // Ridges, not blobs. Everything under the knee is flat air; what survives is
  // thin signed filaments — piled up where n is high, scoured where it is low.
  // A plain n would fill the whole sleeve and there would be no clean tap left
  // anywhere inside it.
  float s = n * smoothstep(0.30, 0.85, abs(n));

  // Ends: fade to nothing well inside the geometry so the spindle has no tip.
  float ends = smoothstep(0.0, 0.22, u) * (1.0 - smoothstep(0.72, 1.0, u));
  // Rim: the drawn surface is the far wall of the sleeve, so it turns edge-on
  // exactly at the silhouette. Killing the strength there is what removes the
  // outline — the shape ends in a fade instead of a boundary, which is the whole
  // difference between vapour and a prop.
  float rim = pow(abs(dot(vNrm, rd)), 0.8);

  s *= uStrength * ends * rim;

  // No discard, and that is deliberate — it is the opposite of what an
  // alpha-tested effect wants and it was measured both ways.
  //
  // Every fragment of this sleeve writes a depth far from anything else in the
  // frame, and COMPOSITE_FRAG reconstructs the cloud with a filter that refuses
  // to mix samples whose depths disagree. So every edge of the drawn region is a
  // seam in that reconstruction. Discarding the weak fragments makes an edge
  // around *every filament*: it measured a 92-level fringe. Drawing all of them
  // leaves exactly one edge, the sleeve's own outline, where the rim fade has
  // already taken the strength to nothing — 28 levels at worst, and falling.
  //
  // --- how much light one unit of s is worth --------------------------------
  //
  // Re-project into the buffer's own frame first. uPrev* is the basis the march
  // used, which is one frame behind this one; inverting COMPOSITE_FRAG's ray
  // construction with it makes the lookup exact under rotation.
  float pz = max(dot(rd, uPrevFwd), 1e-3);
  // Clamped, not discarded, for the reason above: a fragment that fell outside
  // last frame's frustum still has to write its depth, or the frame edge grows a
  // seam every time the camera turns. Clamping reads the nearest edge texel,
  // which is the right answer to within the parallax of one frame.
  vec2 uv = clamp(vec2(dot(rd, uPrevRight) / (pz * uPrevTanHalf.x),
                       dot(rd, uPrevUp)    / (pz * uPrevTanHalf.y)) * 0.5 + 0.5,
                  vec2(0.0), vec2(1.0));

  vec3 sky = tellSky(rd);
  // The same three-by-three Gaussian COMPOSITE_FRAG reconstructs the cloud with,
  // and for the same reason: what this fragment needs is not the background but
  // the *ratio* the composite is about to divide by, and a ratio taken through a
  // different filter than the divisor is not that ratio.
  //
  // This was measured. A five-tap spiral at 1.5 texels overshot by a factor of
  // three where the kernels disagreed most — across a hard cloud silhouette,
  // where the transmittance swings from 0.9 to 0.01 inside the neighbourhood —
  // and put an 88-level darkening on filaments meant to carry about twenty.
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float w = exp(-float(i * i + j * j) * 0.9);
      acc += texture(uCloud, uv + vec2(i, j) * uTapPx * uCloudTexel) * w;
      wsum += w;
    }
  }
  acc /= wsum;

  // B is the composite's own expression for a pixel with nothing in it. The
  // divide by the column's transmittance is what the composite is about to undo
  // when it multiplies the scene buffer by that same number: between them the
  // fragment delivers exactly s * B of change and the background passes
  // through untouched.
  //
  // The divide is bounded, and the bound is the honest limit of this whole
  // approach. Transmittance in this world runs from 0.68 down to 0.0013 —
  // measured, three decades — and a divide by the bottom of that range amplifies
  // every disagreement between this frame's cloud and last frame's by the same
  // three decades. Unbounded it put 200-level flares on filaments meant to carry
  // twenty. Bounded at TELL_MAX_GAIN the stirring is delivered in full wherever
  // the column still passes 1 / TELL_MAX_GAIN of its light, and tails off into
  // masses more opaque than that, which is most of the way to being right for
  // the wrong reason: a disturbance in the clear air in front of a solid wall of
  // cloud does not have much to disturb.
  vec3 B = acc.rgb + acc.a * sky;
  vec3 ratio = B * min(1.0 / max(acc.a, 1.0e-4), ${TELL_MAX_GAIN.toFixed(1)});

  // --- decide where to claim to be -----------------------------------------
  //
  // MARCH_FRAG clips every ray to the cloud slab before it starts, and stops at
  // whichever comes first, the slab or uMaxDist. Reproducing that clip here
  // gives the one distance at which writing depth costs *nothing*: claim to be
  // exactly where the march was going to stop anyway and the column it
  // accumulates over this pixel is unchanged, sample for sample.
  //
  // Only rays that stay inside the layer past the far plane — everything within
  // about eight degrees of level, from inside the deck — cannot be given that
  // distance, and those settle for the far plane and lose the tail beyond it.
  float sT0 = 0.0, sT1 = uSlab.z;
  if (abs(rd.y) > 1e-5) {
    float a = (uSlab.x - cameraPosition.y) / rd.y;
    float b = (uSlab.y - cameraPosition.y) / rd.y;
    sT0 = max(sT0, min(a, b));
    sT1 = min(sT1, max(a, b));
  }
  sT0 = max(sT0, 0.0);
  // How far this particular fragment is allowed to claim. The limit is the far
  // plane in *view-space z*, and view-space z is the slant range foreshortened
  // by the angle off the view axis — so a pixel in the corner of a 62 degree
  // frame, fifty degrees off axis, can honestly claim half again as far as one
  // in the middle. Using the far plane as a slant range instead throws that away
  // and truncates the edges of the frame harder than it has to.
  float cosA = -vView.z / max(length(vView), 1e-4);
  float farLimit = uClipNF.y * 0.999 / max(cosA, 0.30);
  bool inSlab = sT1 > sT0;

  // --- exact, or not at all -------------------------------------------------
  //
  // If the claim has to be clamped, the march loses everything between the far
  // plane and uMaxDist over this fragment, and that loss is not subtle: with the
  // stirring forced to zero it deletes whole distant cloud banks inside the
  // sleeve's outline and leaves a hard curved seam where the sleeve ends — see
  // evidence/whN_lit_150_on against its _off, and the amplified difference that
  // goes with it. It is the same failure the ribbons had, in a new place.
  //
  // Fading the stirring cannot fix it, because the loss does not go through the
  // stirring; only *not writing depth* fixes it. So this fragment does not
  // write depth at all unless the claim can be honoured exactly, and the
  // strength is taken to zero as that limit is approached so the boundary is a
  // fade rather than an edge.
  //
  // The cost is stated plainly because it is large. From inside the deck, a ray
  // has to be more than about eight degrees off level to leave the layer within
  // twelve kilometres, so a pack viewed level — which is most of the time, since
  // they fly at your altitude — has no tell. That is not a tuning choice: the
  // march runs to 24 km and the camera main.js builds ends at 12, and no depth a
  // view can write reaches past the second number. Raising camera.far to meet
  // uMaxDist, or lowering uMaxDist to meet it, removes this entirely and is a
  // one-line change in a file this one does not own.
  float honest = inSlab ? 1.0 - smoothstep(0.80, 1.0, sT1 / farLimit) : 0.0;
  if (honest <= 0.0) discard;
  s *= honest;
  float claim = clamp(sT1, 1.0, farLimit);

  // The march dims the *sky* by the mist it crossed, but only for pixels with no
  // geometry in them — geometry is faded by the composite instead, so that it is
  // not fogged twice. Writing depth flips this pixel from the first rule to the
  // second, and the sky term arrives undimmed unless it is dimmed here. Left
  // out, it measured as a broad, hard-edged brightening over the whole sleeve.
  float mist = exp(-uAerialK * (sT1 - sT0));

  // --- write it where the composite will find it ----------------------------
  //
  // The composite mixes the scene buffer toward haze by the aerial term before
  // it uses it, and computes that term from the slant range it reconstructs out
  // of the depth this shader is about to write — not from where the sleeve
  // actually is. Same distance, both sides.
  float aer = 1.0 - exp(-claim * uAerialK);
  vec3 scene = (sky * mist + s * ratio - uHaze * aer) / max(1.0 - aer, 1e-3);

  // Window depth for a point at the claimed slant range along this ray. The depth
  // buffer holds view-space z, which is the slant range foreshortened by the
  // angle off the view axis, and the composite divides that back out.
  float viewZ = max(claim * cosA, uClipNF.x * 2.0);
  float ndc = ((uClipNF.y + uClipNF.x) - 2.0 * uClipNF.y * uClipNF.x / viewZ)
            / (uClipNF.y - uClipNF.x);
  gl_FragDepth = 0.5 * (ndc + 1.0);
  fragColor = vec4(max(scene, vec3(0.0)), 1.0);
}
`;

/**
 * One Wake Hunter, drawn.
 *
 * Three meshes at most, and only one of them at range:
 *   body   — spine, fins, caudal and filaments in a single buffer, one draw call
 *   tell   — the sleeve of stirred vapour; near and mid, dropped at far
 *   eyes   — two quads, near only
 *
 * Measured, five members with all of them inside 1,200 m: 17 draw calls and
 * 8,110 triangles, against budgets of 120 and 400,000.
 */
export class WakeHunterView extends CreatureView {
  constructor(creature, opts = {}) {
    super(creature, opts);

    // YXZ so pitch happens in the yawed frame and roll happens in the pitched
    // one. With Three's default XYZ the pitch axis stays world-X and a hunter
    // diving on a heading of 90° corkscrews instead of nosing over — which it
    // does constantly, because §10.3's third avoidance lever is that the thermal
    // trail is above you and these things spend their lives climbing into it.
    this.object3D.rotation.order = 'YXZ';

    const L = creature.bodyLength || 55;
    const i = creature.packIndex || 0;
    const h = memberHash(i);

    /**
     * Per-member size jitter, ±11%.
     *
     * The pack must be hard to count and a rank of identical models is easy to
     * count. Small enough that nobody could use it to identify an individual,
     * large enough that the eye stops matching them up.
     */
    this.scaleJitter = 0.89 + h * 0.22;
    this.object3D.scale.setScalar(this.scaleJitter);

    this.L = L;
    this.R = L * WAKE_HUNTER_VIEW.radiusFrac;

    /**
     * Phase offset for this member's body wave.
     *
     * The single most important number in this file for the pack reading as a
     * pack. In phase, seven hunters beat like one animation clip played seven
     * times and the group reads as a rigid formation of props; out of phase by
     * an irrational-ish stride they read as seven animals that happen to be
     * going the same way. Derived from `packIndex` so it is stable across a
     * reload and identical in a replay.
     */
    this._phase = h * TAU;
    /** ±6% beat rate, for the same reason. Identical rates re-sync visibly. */
    this._beatScale = 0.94 + h * 0.12;

    this._roll = 0;
    this._bend = 0;
    this._prevHeading = creature.heading || 0;
    this._yawRate = 0;
    this._barbelPhase = 0;
    this._deformTick = 0;
    this._lastLod = null;
    this._tellAllowed = false;
    this._camDist = 0;
    /**
     * Per-member offset into the turbulence, in the scroll's own units.
     *
     * Without it every animal in the pack is standing inside a bit-for-bit
     * identical disturbance, and five identical patterns moving together read as
     * one texture rather than as five animals stirring their own air.
     */
    this._tellScroll = h * 37.0;

    // Reused scratch: the spine, resolved once per deform and read by the body,
    // the fins, the caudal and the filaments. PERFORMANCE_BUDGET forbids
    // per-frame allocation in the render path and this is the render path.
    this._spX = new Float32Array(RINGS);   // lateral offset of the spine
    this._spZ = new Float32Array(RINGS);   // along-body position
    this._sSx = new Float32Array(RINGS);   // side basis vector, x
    this._sSz = new Float32Array(RINGS);   // side basis vector, z
    this._sFx = new Float32Array(RINGS);   // headward basis vector, x
    this._sFz = new Float32Array(RINGS);   // headward basis vector, z
  }

  build() {
    this._buildBody();
    this._buildTell();
    this._buildEyes();
    this._built = true;
    // One deform at rest so the first frame a body appears is not the flat
    // template. Cheap insurance: a creature can be spawned already visible.
    this._deform(0);
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  /**
   * Body, pectorals, caudal and filaments in one buffer.
   *
   * One buffer because they share a material and a separate mesh per part would
   * be four draw calls per animal and twenty-eight for a pack, against a budget
   * of a hundred and twenty for the entire frame. The filaments are indexed
   * *last* so `setDrawRange` can drop them at range without touching anything
   * else — see `_applyLod`.
   */
  _buildBody() {
    const L = this.L, R = this.R;
    const pos = [];
    const idx = [];

    // Per-vertex animation metadata, parallel to `pos`. The deform reads these
    // instead of branching on vertex index.
    const vRing = [];    // which spine ring this vertex hangs off
    const vLX = [], vLY = [], vLZ = [];  // local coords in that ring's frame
    const vKind = [];    // 0 body · 1 pectoral · 2 caudal · 3 filament
    const vSide = [];    // ±1 for the mirrored parts
    const vSpan = [];    // 0..1 along a fin or filament, for the flex

    const push = (ring, lx, ly, lz, kind, side, span) => {
      pos.push(0, 0, 0);
      vRing.push(ring); vLX.push(lx); vLY.push(ly); vLZ.push(lz);
      vKind.push(kind); vSide.push(side); vSpan.push(span);
      return (pos.length / 3) - 1;
    };

    // --- the body tube -------------------------------------------------------
    const ringBase = [];
    for (let i = 0; i < RINGS; i++) {
      ringBase.push(pos.length / 3);
      const hw = PROFILE_W[i] * R;
      const hh = PROFILE_H[i] * R;
      for (let j = 0; j < RADIAL; j++) {
        const th = (j / RADIAL) * TAU;
        const cx = Math.cos(th) * hw;
        let cy = Math.sin(th) * hh;
        // j === 2 is exactly +Y. The crest is a single pulled vertex, which
        // gives a hard ridge with the two neighbours as its slopes.
        if (j === 2) cy += PROFILE_CREST[i] * CREST_SCALE * R;
        push(i, cx, cy, 0, 0, 0, 0);
      }
    }
    for (let i = 0; i < RINGS - 1; i++) {
      const a = ringBase[i], b = ringBase[i + 1];
      for (let j = 0; j < RADIAL; j++) {
        const k = (j + 1) % RADIAL;
        idx.push(a + j, b + j, a + k);
        idx.push(a + k, b + j, b + k);
      }
    }
    // The nose is capped and the tail is not. The nose ring is 1.3 m across
    // after the head was blunted and the material is double-sided, so an open
    // one shows the inside of the animal from dead ahead — which is the one
    // angle a hunter that has your trail presents. Nine triangles. The tail ring
    // is 12 cm and the caudal covers it.
    {
      const tip = push(0, 0, 0, this.L * 0.012, 0, 0, 0);
      const a = ringBase[0];
      for (let j = 0; j < RADIAL; j++) idx.push(a + j, tip, a + ((j + 1) % RADIAL));
    }

    // --- the caudal fin ------------------------------------------------------
    //
    // Vertical and lunate, because the body is laterally compressed and a fish
    // that swims by sweeping its tail sideways has a tail that stands upright.
    // Forked rather than a single paddle: the notch is what separates "fast" from
    // "large" at a glance, and this animal must never read as large.
    const cH = L * WAKE_HUNTER_VIEW.caudalFrac;
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const stations = [0, 0.45, 1.0];
      for (let n = 0; n < stations.length; n++) {
        const v = stations[n];
        const y = side * cH * v;
        // Swept back, and the chord narrows to a point: a straight-edged tail
        // reads as a rudder rather than as something that moves water.
        const zc = -cH * 0.62 * v * v - L * 0.012;
        const half = lerp(L * 0.030, L * 0.006, v);
        push(TAIL_RING, 0, y, zc + half, 2, side, v);
        push(TAIL_RING, 0, y, zc - half, 2, side, v);
      }
      for (let n = 0; n < stations.length - 1; n++) {
        const a = base + n * 2, b = base + (n + 1) * 2;
        idx.push(a, b, a + 1);
        idx.push(a + 1, b, b + 1);
      }
    }

    // --- the pectoral blades -------------------------------------------------
    //
    // Scythes, swept hard back. They do almost nothing hydrodynamically here —
    // their whole job is that a shape with two swept blades at the shoulders is
    // recognisably a hunting animal at a range where nothing else on it resolves.
    const fL = L * WAKE_HUNTER_VIEW.finLenFrac;
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const stations = [0, 0.38, 0.72, 1.0];
      for (let n = 0; n < stations.length; n++) {
        const v = stations[n];
        const x = side * fL * v;
        const y = -fL * 0.18 * v * v;              // droops
        const zc = -fL * 0.85 * v;                 // sweeps aft
        const half = lerp(L * 0.055, L * 0.008, v);
        push(FIN_RING, x, y, zc + half, 1, side, v);
        push(FIN_RING, x, y, zc - half, 1, side, v);
      }
      for (let n = 0; n < stations.length - 1; n++) {
        const a = base + n * 2, b = base + (n + 1) * 2;
        idx.push(a, b, a + 1);
        idx.push(a + 1, b, b + 1);
      }
    }

    // Everything up to here is what a mid- or far-LOD body draws.
    this._coreIndexCount = idx.length;

    // --- the filaments -------------------------------------------------------
    //
    // §10.3's senses are both trail channels: it never smells the ship, only
    // where the ship has been. These are that, made visible — six sensory
    // filaments trailing under and beside the head, which sweep faster when the
    // scent is strong (`trailExcess`). It is the only part of the animal that
    // tells the player *why* it is where it is, and it is near-LOD only because
    // at any range where the answer matters you are already too close.
    const bL = L * WAKE_HUNTER_VIEW.barbelFrac;
    const rw = PROFILE_W[BARBEL_RING] * this.R;
    const rh = PROFILE_H[BARBEL_RING] * this.R;
    for (let b = 0; b < BARBELS; b++) {
      const psi = (b - (BARBELS - 1) / 2) * 0.52;   // splayed around the throat
      const dx = Math.sin(psi), dy = -Math.cos(psi);
      const px = Math.cos(psi), py = Math.sin(psi); // ribbon width direction
      const rootX = dx * rw, rootY = dy * rh;
      const base = pos.length / 3;
      for (let n = 0; n < BARBEL_STATIONS; n++) {
        const v = n / (BARBEL_STATIONS - 1);
        const x = rootX + dx * bL * 0.42 * v;
        const y = rootY + dy * bL * 0.30 * v - bL * 0.22 * v * v;
        const z = bL * 0.90 * v;
        const half = lerp(L * 0.008, L * 0.002, v);
        push(BARBEL_RING, x + px * half, y + py * half, z, 3, b, v);
        push(BARBEL_RING, x - px * half, y - py * half, z, 3, b, v);
      }
      for (let n = 0; n < BARBEL_STATIONS - 1; n++) {
        const a = base + n * 2, c = base + (n + 1) * 2;
        idx.push(a, c, a + 1);
        idx.push(a + 1, c, c + 1);
      }
    }

    const g = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', posAttr);
    g.setIndex(idx);
    // Frustum culling reads this and the deform moves vertices outside the rest
    // pose, so it is set once with slack rather than recomputed. Recomputing per
    // frame would be an allocation and a full vertex pass for a sphere that is
    // never wrong by more than the wave amplitude.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), L * 0.75);

    this._geo = g;
    this._meta = {
      ring: new Uint8Array(vRing), lx: new Float32Array(vLX),
      ly: new Float32Array(vLY), lz: new Float32Array(vLZ),
      kind: new Uint8Array(vKind), side: new Int8Array(vSide),
      span: new Float32Array(vSpan),
      count: vRing.length,
    };
    this._pos = posAttr;

    this._body = new THREE.Mesh(g, bodyMaterial());
    this._body.frustumCulled = true;
    this.object3D.add(this._body);

    // Normals are computed once, on the rest pose, and never again. The deform
    // rotates each cross-section with the local spine tangent so the error is
    // bounded by the wave's curvature, and on a body this dark under this
    // little light the difference is not resolvable — where recomputing normals
    // every frame for seven animals is a full second vertex pass for nothing.
    //
    // The spine has to be solved first: the frames start as zeroed arrays, and
    // computing normals off that collapses every vertex onto the axis and bakes
    // a degenerate mesh's normals in for the life of the object.
    this._solveSpine(0);
    this._deformBody(0);
    g.computeVertexNormals();
  }

  /**
   * The tell: a sleeve of stirred vapour on the flight axis.
   *
   * A closed spindle, built once and never touched again. Its radius goes to
   * zero at both tips, which is what closes it — a capped cylinder would put a
   * disc of constant depth across the nose, and a disc is exactly the kind of
   * flat-ended shape the review caught the ribbons being.
   */
  _buildTell() {
    const L = this.L;
    const zA = L * WAKE_HUNTER_VIEW.tellAheadBodies;
    const zB = -L * WAKE_HUNTER_VIEW.tellBehindBodies;
    const rMax = L * WAKE_HUNTER_VIEW.tellRadiusBodies;

    const pos = [];
    const nrm = [];
    const idx = [];
    for (let n = 0; n < TELL_STATIONS; n++) {
      const u = n / (TELL_STATIONS - 1);
      const z = lerp(zA, zB, u);
      // sin(pi u)^0.6 rather than sin(pi u): the 0.6 fattens the sleeve early
      // and holds it wide over most of its length, so the profile is a spindle
      // with blunt shoulders rather than a rugby ball. The ball tapers so far
      // ahead of the nose that the disturbance stops covering the part of the
      // sky the animal is about to arrive from, which is the one part §10.3
      // cares about.
      const r = rMax * Math.pow(Math.sin(Math.PI * Math.max(u, 1e-4)), 0.6);
      // Slope of the profile, for the true surface normal. A cylinder's normal
      // (radial, flat) would make `rimFade` wrong near the tips: the surface
      // there is nearly perpendicular to the axis, and calling it radial would
      // hold the strength up exactly where the shape is supposed to have ended.
      const du = 1 / (TELL_STATIONS - 1);
      const u0 = Math.max(u - du, 1e-4), u1 = Math.min(u + du, 1 - 1e-4);
      const dr = rMax * (Math.pow(Math.sin(Math.PI * u1), 0.6)
                       - Math.pow(Math.sin(Math.PI * u0), 0.6));
      const dz = (zB - zA) * (u1 - u0);
      // Outward normal of a surface of revolution: (-z', r') in the (radial, z)
      // plane. `rimFade` only ever takes its absolute value, so a sign error
      // here is invisible — which is exactly why it is worth getting right on
      // paper rather than by looking at a capture.
      const nr = -dz, nz = dr;
      const nl = Math.hypot(nz, nr) || 1;
      for (let j = 0; j < TELL_RADIAL; j++) {
        const th = (j / TELL_RADIAL) * TAU;
        const cx = Math.cos(th), cy = Math.sin(th);
        pos.push(cx * r, cy * r, z);
        nrm.push(cx * nr / nl, cy * nr / nl, nz / nl);
      }
    }
    for (let n = 0; n < TELL_STATIONS - 1; n++) {
      const a = n * TELL_RADIAL, b = (n + 1) * TELL_RADIAL;
      for (let j = 0; j < TELL_RADIAL; j++) {
        const k = (j + 1) % TELL_RADIAL;
        idx.push(a + j, b + j, a + k);
        idx.push(a + k, b + j, b + k);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, (zA + zB) * 0.5), (zA - zB) * 0.5 + rMax);

    /**
     * Opaque, back faces only, and no blending at all.
     *
     * No blending because the value written *is* the answer: it is the exact
     * number that makes `COMPOSITE_FRAG` land on a stirred background, and a
     * fraction of it would land somewhere else.
     *
     * Back faces because the sleeve is a closed shell and both walls write the
     * same depth, so drawing both would rasterise every pixel twice for one
     * result. Which wall is kept is not arbitrary: the far one is the surface
     * whose normal turns edge-on at the silhouette in the direction `rimFade`
     * expects, and it is the one whose object-space coordinate puts the noise
     * behind the animal rather than in front of it.
     *
     * Two sleeves that overlap on screen do not compound — the depth test is
     * `LessEqual` and both are at the same depth, so the later draw replaces the
     * earlier. Both fade to nothing at their rims, so what that costs is a soft
     * boundary between two low-contrast fields rather than a seam.
     */
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: TELL_VERT,
      fragmentShader: TELL_FRAG,
      uniforms: {
        uCloud: { value: null },
        uCloudTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uPrevFwd: { value: new THREE.Vector3(0, 0, -1) },
        uPrevRight: { value: new THREE.Vector3(1, 0, 0) },
        uPrevUp: { value: new THREE.Vector3(0, 1, 0) },
        uPrevTanHalf: { value: new THREE.Vector2(1, 1) },
        uSkyZenith: { value: new THREE.Vector3() },
        uSkyHorizon: { value: new THREE.Vector3() },
        uSkyGround: { value: new THREE.Vector3() },
        uHaze: { value: new THREE.Vector3() },
        uAerialK: { value: 9.0e-5 },
        uStrength: { value: 0 },
        uScroll: { value: this._tellScroll },
        uSpan: { value: new THREE.Vector3(zA, zB, rMax) },
        uFeature: {
          value: new THREE.Vector2(L * WAKE_HUNTER_VIEW.tellFeatureBodies[0],
                                   L * WAKE_HUNTER_VIEW.tellFeatureBodies[1]),
        },
        uTapPx: { value: TELL_TAP_TEXELS },
        uSlab: { value: new THREE.Vector3(-900, 2600, 24000) },
        uClipNF: { value: new THREE.Vector2(0.5, 12000) },
      },
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NoBlending,
    });
    m.userData.owned = true;       // per-view, so `dispose()` may free it

    this._tellGeo = g;
    this._tellMat = m;
    this._tell = new THREE.Mesh(g, m);
    this._tell.frustumCulled = true;
    // Off until something has decided how strong it is, and off for good if the
    // clouds are not running: with no `cloudRT` there is no background to give
    // back, and a sleeve that guesses one is the artefact this replaced.
    this._tell.visible = false;
    this.object3D.add(this._tell);
  }

  /**
   * Two eyespots. Four triangles, and the reason a pack is uncountable.
   *
   * Quads on the sides of the head rather than spheres: at 1.4 m they are never
   * more than a few pixels and a sphere would be sixty triangles to render the
   * same three.
   */
  _buildEyes() {
    const e = this.L * WAKE_HUNTER_VIEW.eyeFrac * 0.5;
    const rw = PROFILE_W[BARBEL_RING] * this.R;
    const rh = PROFILE_H[BARBEL_RING] * this.R;
    const z = this._spineZ(BARBEL_RING);
    const pos = [];
    const idx = [];
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const x = side * rw * 0.92;
      const y = rh * 0.30;
      pos.push(x, y - e, z - e, x, y + e, z - e, x, y + e, z + e, x, y - e, z + e);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, z), this.L * 0.1);

    // Pale and cold. ART_DIRECTION reserves warmth for events, and a wet eye
    // catching a luminary is not an event; it is the least this creature could
    // possibly emit and still be looking at you.
    // `forceSinglePass` for the same reason as the tell: two quads facing
    // opposite ways do not need a two-pass sort, and the second pass is a draw
    // call per animal.
    const m = glowMaterial(0xa8d2dd, 1, {
      side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true,
    });
    m.userData.owned = true;
    this._eyeMat = m;
    this._eyes = new THREE.Mesh(g, m);
    this._eyeGeo = g;
    this.object3D.add(this._eyes);
  }

  // ---------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------

  /** Along-body position of a ring. Nose at +L/2, tail tip at -L/2. */
  _spineZ(i) { return (0.5 - i / (RINGS - 1)) * this.L; }

  step(dt, d, ctx) {
    const c = this.creature;
    this._camDist = d;

    // Yaw rate, measured rather than asked for: the simulation turns by writing
    // `heading` and does not publish the rate. Wrapped through ±π so a heading
    // crossing the branch cut does not produce a 360°/frame spike and snap the
    // animal onto its back.
    let dh = (c.heading || 0) - this._prevHeading;
    while (dh > Math.PI) dh -= TAU;
    while (dh < -Math.PI) dh += TAU;
    this._prevHeading = c.heading || 0;
    const raw = dt > 1e-5 ? dh / dt : 0;
    // Smoothed towards the measurement rather than taken from it: at 120 Hz one
    // frame of yaw is noise, and an unsmoothed bank strobes.
    const k = 1 - Math.exp(-dt / WAKE_HUNTER_VIEW.bankLagSec);
    this._yawRate += (raw - this._yawRate) * k;

    // Bank into the turn. Positive heading rate is a turn to the animal's left
    // (local +X), and banking into it puts that side down, hence the negation.
    const bank = clamp(
      -this._yawRate * WAKE_HUNTER_VIEW.bankPerYawRate,
      -WAKE_HUNTER_VIEW.maxBank, WAKE_HUNTER_VIEW.maxBank);
    this._roll += (bank - this._roll) * k;

    // The base class wrote `rotation.y` from `heading`; pitch and roll are ours.
    // Negated because a positive `pitch` climbs and a rotation about local +X
    // pushes local +Z down.
    this.object3D.rotation.x = -(c.pitch || 0);
    this.object3D.rotation.z = this._roll;

    const lod = this.lodLevel;
    if (lod !== this._lastLod) { this._applyLod(lod); this._lastLod = lod; }

    // The tell updates every frame it is allowed, *before* the deform throttle
    // below and outside it. It has to: `uPrevFwd` and its three companions are
    // the camera basis the cloud buffer was marched with, and running them at
    // half rate at `mid` LOD would leave every other frame reconstructing the
    // background through a basis two frames stale — which is a smear across the
    // whole sleeve exactly when the player is turning to look at the pack.
    if (this._tellAllowed) {
      this._updateTell(dt, clamp01((c.speed || 0) / 120), ctx);
    }

    // Deform rate by LOD. At `far` the body is a couple of dozen pixels across
    // and the wave is sub-pixel, so it is frozen entirely — which is most of the
    // point of having a far LOD for something there are seven of.
    this._deformTick++;
    if (lod === 'far') return;
    if (lod === 'mid' && (this._deformTick & 1)) return;
    this._deform(dt);
  }

  _applyLod(lod) {
    const near = lod === 'near';
    // Filaments are the last indices in the buffer, so dropping them is a range
    // change rather than a second mesh or a second draw call.
    this._geo.setDrawRange(0, near ? Infinity : this._coreIndexCount);
    this._eyes.visible = near;
    // LOD says whether the tell is *allowed*; `_updateTell` says whether there is
    // one. Both writing `visible` would let a slow frame latch it off for good.
    this._tellAllowed = lod !== 'far';
    if (!this._tellAllowed) this._tell.visible = false;
  }

  _deform(dt) {
    const c = this.creature;
    const L = this.L;
    const speed = c.speed || 0;

    // Beat frequency from speed, not from time: see `strideBodies`.
    const hz = Math.max(
      WAKE_HUNTER_VIEW.minBeatHz,
      (speed / (WAKE_HUNTER_VIEW.strideBodies * L)) * this._beatScale);
    this._phase += hz * TAU * dt;
    if (this._phase > TAU * 1024) this._phase -= TAU * 1024;  // stay in f32 range

    // Amplitude rises with speed but never to nothing: a hanging animal still
    // sculls. Ranges from a third of `tailAmpFrac` at a drift to all of it at
    // the committed speed.
    const drive = clamp01(speed / 120);
    const amp = L * WAKE_HUNTER_VIEW.tailAmpFrac * (0.34 + 0.66 * drive);

    // The spine curves into the turn as well as banking. `s * s` rather than a
    // constant so the head stays on the line of flight and the tail is what
    // swings — a body that bends uniformly reads as a banana being towed.
    const bendTarget = clamp(
      -this._yawRate * WAKE_HUNTER_VIEW.bendPerYawRate * L * 0.02, -L * 0.10, L * 0.10);
    this._bend += (bendTarget - this._bend) * clamp01(dt * 6);

    this._solveSpine(amp);
    this._deformBody(dt);
    if (this._eyes.visible) {
      const [lo, hi] = WAKE_HUNTER_VIEW.eyeOpacity;
      // Brighter with attention. Not with the chirp: the chirp is a sound and
      // §10.3 makes it a readout of trail strength, and lighting it would be the
      // render inventing a second channel the simulation does not emit on.
      this._eyeMat.opacity = lerp(lo, hi, clamp01(c.attention || 0));
    }
  }

  /**
   * Resolve the spine: lateral offset per ring, and the orthonormal frame each
   * cross-section is carried in.
   *
   * The frame is what keeps the body from shearing. Offsetting rings laterally
   * without rotating their cross-sections leaves the surface parallel to the
   * original axis, so a hard-swimming animal looks like a stack of coins pushed
   * over rather than like a body bending.
   */
  _solveSpine(amp) {
    const k = TAU * WAKE_HUNTER_VIEW.waveCount;
    const dz = -this.L / (RINGS - 1);      // negative: rings run head to tail
    for (let i = 0; i < RINGS; i++) {
      const s = i / (RINGS - 1);
      // s^1.9 — the carangiform envelope. The head is held still and the wave
      // grows aft; a linear envelope swings the nose and looks like an eel.
      const env = Math.pow(s, 1.9);
      this._spX[i] = amp * env * Math.sin(this._phase - k * s) + this._bend * s * s;
      this._spZ[i] = this._spineZ(i);
    }
    for (let i = 0; i < RINGS; i++) {
      const a = Math.max(0, i - 1), b = Math.min(RINGS - 1, i + 1);
      const dLat = (this._spX[b] - this._spX[a]) / (b - a);
      const n = Math.hypot(dLat, dz) || 1;
      // Headward tangent and the side vector. At rest: forward (0,0,1), side
      // (1,0,0).
      this._sFx[i] = -dLat / n; this._sFz[i] = -dz / n;
      this._sSx[i] = -dz / n;   this._sSz[i] = dLat / n;
    }
  }

  _deformBody(dt) {
    const m = this._meta;
    const arr = this._pos.array;
    const c = this.creature;

    // Pectoral beat: same clock as the body, a quarter cycle behind, so the fins
    // look driven by the same animal rather than by a second timer. Amplitude
    // falls off with speed — a fish at full sprint pins its pectorals flat
    // against the body, and that pinning is itself a speed cue.
    const finBeat = Math.sin(this._phase * 0.5 - Math.PI * 0.5)
      * (0.30 - 0.20 * clamp01((c.speed || 0) / 120)) - 0.10;
    const cf = Math.cos(finBeat), sf = Math.sin(finBeat);

    // Filament sweep: rate and amplitude both rise with the scent. §10.3 makes
    // `trailExcess` the readout the audio already uses; this is the same number
    // shown rather than heard, so the two cannot disagree.
    const scent = clamp01(c.trailExcess || 0);
    this._barbelPhase += dt * TAU * (0.5 + 2.6 * scent);
    const bAmp = this.L * (0.010 + 0.030 * scent);

    for (let v = 0; v < m.count; v++) {
      const r = m.ring[v];
      let lx = m.lx[v], ly = m.ly[v], lz = m.lz[v];
      const kind = m.kind[v];

      if (kind === 1) {
        // Pectoral: rotate the blade about the body axis by ±the beat angle.
        // Mirrored by side, so both fins rise and fall together — rotating both
        // the same way would roll the animal instead of flapping it.
        const sa = m.side[v] > 0 ? sf : -sf;   // cos is even, sin is odd
        const nx = lx * cf - ly * sa;
        const ny = lx * sa + ly * cf;
        lx = nx; ly = ny;
      } else if (kind === 2) {
        // Caudal: it is attached at the tail tip, which the wave has already
        // moved, and it lags the tip by about a fifth of a cycle. That lag is
        // the whole reason a fish tail looks like it is pushing water rather
        // than waving; without it the tail is a rigid flag on the end.
        const lag = Math.sin(this._phase - TAU * WAKE_HUNTER_VIEW.waveCount - 1.1);
        const sweep = lag * this.L * 0.045 * m.span[v];
        lx += sweep;
      } else if (kind === 3) {
        const s = Math.sin(this._barbelPhase + m.side[v] * 0.9 - m.span[v] * 3.4);
        lx += s * bAmp * m.span[v];
        ly -= Math.abs(s) * bAmp * 0.35 * m.span[v];
      }

      // Place the local point in the ring's frame. `ly` is world-up in the
      // creature's own space: these animals bend sideways, never vertically, so
      // the frame has no roll term and does not need one.
      const o = v * 3;
      arr[o]     = this._spX[r] + lx * this._sSx[r] + lz * this._sFx[r];
      arr[o + 1] = ly;
      arr[o + 2] = this._spZ[r] + lx * this._sSz[r] + lz * this._sFz[r];
    }
    this._pos.needsUpdate = true;
  }

  /**
   * The tell, per frame: eleven uniforms and no geometry work at all.
   *
   * Everything that used to be a vertex write is now `uScroll`. The sleeve is
   * static and the disturbance moves through it, which is the right way round —
   * the medium is not carried along by the animal, it is left behind by it.
   */
  _updateTell(dt, drive, ctx) {
    const [s0, s1] = WAKE_HUNTER_VIEW.tellSpeedRange;
    const strength = clamp01(((this.creature.speed || 0) - s0) / Math.max(s1 - s0, 1))
      * WAKE_HUNTER_VIEW.tellAmplitude;

    // Aft-streaming rate, in feature-lengths per second. Fast: a slow scroll
    // makes the disturbance look attached to the animal instead of passed
    // through by it. Wrapped well inside float32's exact-integer range, because
    // this feeds a noise lookup and a coordinate that has grown past about 2^22
    // quantises into visible stair-steps after twenty minutes of flying.
    this._tellScroll += dt * (0.25 + 1.15 * drive);
    if (this._tellScroll > 4096) this._tellScroll -= 4096;

    const clouds = ctx && ctx.clouds;
    const rt = clouds && clouds.cloudRT;
    const cu = clouds && clouds.compositeUniforms;
    const sky = clouds && clouds.sky;
    // No march buffer, no reconstruction, no tell. Drawing one anyway would mean
    // inventing a background, and inventing a background is the entire defect
    // this rewrite removed.
    this._tell.visible = strength > 0.004 && !!(rt && cu && sky);
    if (!this._tell.visible) return;

    const u = this._tellMat.uniforms;
    u.uStrength.value = strength;
    u.uScroll.value = this._tellScroll;
    u.uCloud.value = rt.texture;
    u.uCloudTexel.value.set(1 / rt.width, 1 / rt.height);
    // The camera basis that produced the buffer, which is *last* frame's: the
    // scene pass runs before the march, so `compositeUniforms` still holds the
    // values written after the previous scene render. Taking this frame's camera
    // instead would look correct while standing still and smear the whole
    // reconstruction sideways the moment the player turned.
    u.uPrevFwd.value.copy(cu.uCamFwd.value);
    u.uPrevRight.value.copy(cu.uCamRight.value);
    u.uPrevUp.value.copy(cu.uCamUp.value);
    u.uPrevTanHalf.value.copy(cu.uTanHalf.value);
    u.uAerialK.value = cu.uAerialK.value;
    // Everything the fragment needs to work out where the march would have
    // stopped, taken from the march's own uniforms rather than restated. If the
    // slab or the range ever move, this moves with them; a copy of the numbers
    // here would be a second opinion about where the weather is.
    const mu = clouds.marchUniforms;
    u.uSlab.value.set(mu.uLayer.value.x, mu.uLayer.value.y, mu.uMaxDist.value);
    u.uClipNF.value.copy(cu.uClip.value);
    // The sky the composite would have drawn here. Read from the luminaries
    // rather than authored, for the same reason the old tint was: a colour
    // written down in this file is a second opinion about the light, and
    // `sky.js` exists to end second opinions.
    u.uSkyZenith.value.copy(sky.skyZenith);
    u.uSkyHorizon.value.copy(sky.skyHorizon);
    u.uSkyGround.value.copy(sky.skyGround);
    u.uHaze.value.copy(sky.haze);
  }

  /**
   * Free what this view owns and nothing else.
   *
   * The base class disposes every material it finds, which would take the shared
   * body material with it and leave every other Wake Hunter on screen drawing
   * with a disposed program the moment one of them is culled. Only materials
   * this view made are marked `owned`.
   */
  dispose() {
    this.object3D.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const mm of mats) if (mm.userData && mm.userData.owned) mm.dispose();
    });
  }
}

/** Factory, in the shape `CreatureRenderer.register` wants. */
export function createWakeHunterView(creature, opts) {
  return new WakeHunterView(creature, opts);
}

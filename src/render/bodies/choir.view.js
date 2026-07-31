// The Choir, made visible.
//
//   import { ChoirView } from './render/bodies/choir.view.js';
//   views.register('Choir', (c, o) => new ChoirView(c, o));
//
// --- the problem this file solves -------------------------------------------
//
// §10.4 gives the Choir two numbers that cannot both be drawn: the shoal spans
// 2–6 km and an element is 0.4 m. A 0.4 m animal at 3 km subtends 1.3e-4 rad —
// about a five-thousandth of a pixel — and there are tens of thousands of them.
// One mesh per element is a hundred thousand draw calls to produce a smudge; one
// mesh for the whole shoal is a bubble in the sky.
//
// So the shoal is drawn as an *unresolvable point cloud plus the few animals
// close enough to resolve*, which is what it physically is:
//
//   GRAIN     a few thousand points at a fixed size in PIXELS, not metres,
//             clumped into knots so the field has schools and gaps, and drawn in
//             two polarities at once — most of them near-black, a third of them
//             lifted — so that there is no background the field can match and
//             disappear into. One draw call per size-and-tone class, no
//             triangles, no per-frame CPU. See `grainClasses`.
//   ELEMENTS  0.4 m, true scale, lit, aligned into a school with a heading of
//             its own, and only for the handful of knots close enough that a
//             0.4 m body is more than a pixel. They grow in as you approach so a
//             knot *dissolves into animals* rather than popping.
//   DRIFT     a periodic lattice of elements snapped to a 100 m grid around the
//             camera, so that inside the shoal there is always something
//             passing even between knots. Being periodic and snapped it is
//             static in world space and costs one vector write per frame however
//             far you fly.
//   RIPPLE    what an echo looks like. See below.
//
// --- two hard facts about this renderer, learned by capture ------------------
//
// **1. Anything that does not write depth is thrown away.** The cloud composite
// (`cloud.glsl.js`, `myDist > 9.0e5`) substitutes the procedural sky for every
// pixel with no geometry behind it, so the scene buffer's colour at that pixel
// is discarded. A translucent shell with `depthWrite: false` is therefore
// *completely invisible against sky* — an earlier version of this file drew 26
// soft ellipsoids the size of the shoal and not one pixel of them survived. Both
// visible layers here write depth.
//
// **2. Depth-writing geometry stops the cloud march.** Which is exactly the
// occlusion we want from a 20 m knot and would be a catastrophe from a 3 km
// shell: the shoal is a thing you hide *inside*, and a shell would carve every
// cloud out of its own interior. That is the second reason there is no shell —
// the volume is carried by many small depth-writing specks instead, each of
// which correctly hides the cloud directly behind it and nothing else.
//
// --- what you are supposed to be able to see --------------------------------
//
// §10.4's tell — a real contact appears on two or more channels, an echo on
// exactly one — is only learnable if the player can attach a sound to a place.
// So an echo *fires visibly*: RIPPLE is a shell of elements catching the light
// as they turn, expanding for ~2.3 s at the exact point `_emitEcho` chose. That
// point is uniform in the ball, so echoes come from everywhere in the volume,
// which is what "the echoes come from every direction at once" has to look like
// from the inside.
//
// The ripple is deliberately **the same colour whatever channel it is**.
// Tinting it per channel would hand the player, for free, the information §10.4
// makes them earn by cross-referencing instruments. The shoal is not
// bioluminescent and has no voice (`voiceState().silent` is `true` and must stay
// true): what you see is a hundred thousand bodies turning at once and catching
// whatever luminary is up, so the colour is read from the sky rather than
// authored here.
//
// --- posture is visible -----------------------------------------------------
//
// `density01` drives the grain count and the elements per knot, so DISPERSED →
// DENSE is a thing you can watch happen. That matters: §10.4's gathering posture
// is "instruments getting busier for no reason", and a player who can see the
// shoal thickening around them has been given the reason.
//
// --- performance, measured --------------------------------------------------
//
// At range: **6 draw calls, 3 072 triangles**, and a grain count that is at most
// `grain` (4 000) and thins with the shoal's angular size. Inside a shoal with
// six knots resolving: **8 draw calls, 16 152 triangles**. Against
// PERFORMANCE_BUDGET §4's 120 calls and 400 000 triangles that is 7% and 4% of
// the frame's allowance for the largest object in the game.
//
// `sync()` costs **0.114 ms** in its worst case — inside the shoal, six knots
// resolved, 546 element matrices rewritten every frame — measured over 600 calls
// with a JS timer, which is a real number because no GPU work is involved. That
// is 3.8% of the 3 ms `update` budget.
//
// GPU: `benchRender` at 1920x1080 medians 0.35 ms with the shoal against 0.22 ms
// without. **[headless, non-compositing — optimistic]**, per §3, and quoted only
// as a regression tripwire; it is not comparable to the 11 ms render budget.
//
// The grain IS thinned with range, and this file used to argue the opposite —
// that thinning would read as the shoal evaporating as you fly away. That
// argument was wrong because it thought in counts instead of in coverage: the
// points are a fixed size in pixels, so a shoal at twice the range packs the
// same count into a quarter of the disc and gets *denser*, not thinner.
// Measured, it went from 50% coverage at 2.6 km to 87% at 6 km, which is a solid
// ball. Scaling the count with the square of the angular size holds the coverage
// where it was tuned, so the shoal looks the same at every range — which is what
// the paragraph above was actually asking for — and the count falls out of it.
// See `grainAngleRef`. What LOD switches off is the two true-scale layers, which
// are meaningless beyond a few hundred metres.
//
// The count is now `grain` = 4 000 at most, which is PERFORMANCE_BUDGET §4's
// "particles alive" line exactly. The previous 24 000–34 000 was defended on the
// grounds that the budget line is scoped to "wake and discharge only" and these
// are a body rather than an effect. That reading is fair and it is no longer
// needed: the coverage measurement asks for the same number the budget does.

import * as THREE from 'three';
import { CreatureView, FLESH } from '../creatures.js';
import { CHOIR, POSTURE } from '../../game/creatures/choir.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHOIR_ART = {
  /**
   * Points in the grain field at `density01 = 1`, at the reference angular size.
   *
   * Not a count of animals — §10.4's "tens of thousands" are 0.4 m and none of
   * them is individually visible past a few hundred metres. A point is a knot of
   * some thousands of them, and the number is set by screen coverage rather than
   * by biology: a shoal at its design range covers a disc of a few hundred
   * thousand pixels, and the field has to put roughly 5–10% of that disc in
   * shadow. Five per cent is a wrongness; twenty is a solid ball and the shoal
   * stops being a place you can fly into.
   *
   * This was 26 000, and 26 000 was wrong on both counts it was justified by.
   * **Measured**, at 1400x900, a 1300 m shoal at 2600 m: 32 794 points changed
   * 106 515 pixels inside a projected disc of about 213 000 px². That is **50%
   * coverage**, five to ten times what the paragraph above asks for, which is
   * why the shoal read as a solid olive ball rather than as a region of sky that
   * is subtly wrong. At 6 km it measured **87%** — very nearly opaque.
   *
   * 4 000 is PERFORMANCE_BUDGET §4's "particles alive" line, exactly, and it is
   * also the count that produces the coverage this file always claimed: 4 000
   * points at a mean of 5.5 px² each is about 22 000 px, or **10%** of the same
   * disc. The budget argument and the picture argument land on the same number,
   * so there is no longer anything to trade off and no caveat to file.
   */
  grain: 4000,

  /**
   * Grain size classes: pixel size at the reference height below, the fraction
   * of the field in each, and the ABSOLUTE tone it is drawn at, in linear
   * radiance before the luminary tints it and before tone mapping.
   *
   * Specified in pixels because that is what the eye actually reads: a shoal of
   * unresolvable animals looks the same size at every range and only its
   * *density on screen* changes.
   *
   * Several classes rather than one, and this is not decoration. A field of
   * identical two-pixel dots does not read as animals, it reads as **dirt on the
   * lens** — the first capture of this layer looked like a dead-pixel map,
   * because uniform size is the one property real specks at real distances never
   * have.
   *
   * Below about two pixels a dark speck does not survive the composite's dither
   * and the 8-bit write; above about five it stops being grain and starts being
   * gravel. Those are the bounds the classes sit inside.
   *
   * --- why the tones come in two polarities ---------------------------------
   *
   * This used to be a single tone, 0.034 linear, chosen to sit *between* the two
   * backgrounds the game has — darker than lit cloud, lighter than the zenith.
   * Something that sits between two values necessarily crosses each of them
   * somewhere, and a background it exactly matches is a background it is
   * invisible against. That is not a hypothetical: an adversarial pass reported
   * an on/off diff of **exactly zero changed pixels** at 2.6 km, and a sweep here
   * across the sky (pitch 0.30 to 1.30 above the deck, one luminary phase) found
   * the field's mean per-pixel difference bottoming out at **13.9 of 255** where
   * the background sat near 15 — a shoal three kilometres across reduced to a
   * faint stain. A single absolute tone cannot avoid this. It is not a tuning
   * error, it is the shape of the idea.
   *
   * So the field is drawn in two populations at once:
   *
   *   DARK  (~0.002 linear) renders at about 1/255. It vanishes against the
   *         zenith, which is correct — it *is* the dark — and it is a hard,
   *         near-black speck against anything lit. This is the population that
   *         makes the shoal a hole in a bright sky.
   *   LIGHT (~0.05 linear) renders near 50/255: a bright fleck against the
   *         zenith, and still a clearly *dark* fleck against lit cloud at 99.
   *
   * Whatever the background is, at least one of the two is far from it. The
   * worst case is a background that matches the light population exactly, and
   * there the dark population is still fifty levels away. There is no longer a
   * sky this animal can hide in.
   *
   * It is also what a shoal looks like. A hundred thousand bodies do not all
   * present the same face: some are edge-on and black, some catch the luminary
   * and flash. A murmuration is not a uniform grey cloud, it is salt and pepper,
   * and that mixture is the reason it reads as *many things* rather than as one
   * smudged object.
   */
  grainClasses: [
    { px: 2.2, share: 0.36, tone: 0.0015 },
    { px: 3.4, share: 0.16, tone: 0.0022 },
    { px: 4.6, share: 0.10, tone: 0.0035 },
    { px: 2.2, share: 0.26, tone: 0.042 },
    { px: 3.4, share: 0.12, tone: 0.062 },
  ],
  /**
   * Point sizes do not scale with the render target, so the grain would get
   * finer on a bigger screen and the shoal would look further away at 4K than at
   * 1080p. The drawing-buffer height is measured against this reference.
   */
  grainRefH: 900,

  /**
   * Angular radius (shoal radius / distance) at which the full grain count is
   * drawn, and the floor the count is allowed to thin to.
   *
   * The grain is at a fixed size in PIXELS, so a shoal that halves its angular
   * size packs the same number of specks into a quarter of the area and its
   * coverage quadruples. Measured, that is exactly what happened: 50% coverage
   * at 2.6 km became 87% at 6 km, so the further away the shoal was the more
   * solid it looked — an object, at the range where §10.4 most needs it to be a
   * region. Scaling the count with the square of the angular size holds the
   * coverage where it was set and costs nothing but a `setDrawRange`.
   *
   * 0.50 is the shoal seen from two radii out, which is the range the coverage
   * above was measured and tuned at. The floor stops it from thinning away
   * entirely: past about eight kilometres a shoal genuinely should start to look
   * solid, and a field that kept thinning would read as the one thing a 6 km
   * animal must never appear to do, which is evaporate as you fly away from it.
   */
  grainAngleRef: 0.50,
  grainThinFloor: 0.34,

  /**
   * Beyond this a knot is only grain; inside it, its elements are drawn too.
   *
   * 260 m is where a 0.4 m element crosses about two pixels at 1400 px wide.
   * Nearer and the shoal has to be made of animals or it is a lie; further and
   * the elements are sub-pixel dots that cost instances to produce aliasing.
   */
  resolveM: 260,
  /** Knots resolved at once. Six is what fits inside `resolveM` in a dense shoal. */
  resolveMax: 6,
  /**
   * Elements drawn per resolved knot, at density01 = 0 and 1.
   *
   * Raised from [18, 64] after a capture from inside a school: forty-eight
   * animals spread through a 35 m ball, seen from 26 m, is half a dozen specks
   * in frame and reads as debris rather than as a shoal. A school is *locally*
   * dense — that is what schooling means — and only globally sparse, so the
   * number that matters is how many are in frame when you are inside one.
   */
  elementsPerKnot: [36, 120],
  /** Aspect of one element: 0.4 m long, and much narrower than that. */
  elementAspect: 0.34,

  /**
   * Grain points per knot, and how far they spread.
   *
   * A knot is a school. Twelve points is enough that a knot is a *blob* at
   * kilometre range — a dozen specks inside twenty pixels — rather than a lone
   * dot, and the per-knot count is jittered by 3x on top so the texture has
   * structure at more than one scale.
   *
   * 35 m is the school itself and it is also the radius the elements fill when
   * the knot resolves, so the animals appear exactly where the specks were.
   * Larger and a knot stops being a knot; smaller and it is a hard pellet.
   */
  grainPerKnot: 12,
  knotSpreadM: 35,

  /**
   * The drift lattice: a 3x3x3 tiling of one cell, snapped to the cell grid.
   *
   * Because the pattern is periodic with exactly this period, snapping the group
   * to the grid makes the field appear *static in world space* while costing one
   * position write per frame. The seam is at 1.5 cells — 150 m — where an
   * element is well under a pixel, so the wrap is invisible. Shrink the cell and
   * the seam walks into view; that is the failure mode.
   */
  driftCellM: 100,
  driftSlots: 12,
  /**
   * How many elements the shoal is taken to contain at `density01 = 1`, for the
   * purpose of deciding how thick the drift lattice is.
   *
   * §10.4 says "tens of thousands", which is a range and not a number, so this
   * is the top of it. It is a *population*, not a draw count — the lattice draws
   * at most `driftSlots * 27` = 324 of them, being the ones within a cell or two
   * of the camera — and it exists so that the density of what passes the canopy
   * inside the shoal is derived from what the simulation claims is there rather
   * than from whatever the renderer happened to be budgeted.
   *
   * At a 1300 m radius this works out to about ten of the twelve slots live,
   * which is where it sat before the grain count moved.
   */
  driftPopulation: 90000,

  /** Echo ripples alive at once. §10.4's DENSE posture is one echo every 2.5 s. */
  rippleSlots: 8,
  /**
   * Elements in a ripple shell.
   *
   * Ninety-six rather than forty-eight, measured: at two kilometres a 90 m shell
   * is about a hundred pixels across, and forty-eight specks inside that read as
   * a smattering rather than as a wave. Ninety-six is where it becomes a thing
   * that happened.
   */
  rippleMotes: 96,
  /**
   * Ripple life. Not the echo's life — §10.4 gives an echo 60 s of being
   * *audible*; this is the moment the shoal turns, which is what the player has
   * to be able to associate with the sound.
   *
   * The decay crosses `rippleFloor` at about 71% of this, so the ripple is
   * actually on screen for roughly 2.3 s of the 3.2.
   */
  rippleSec: 3.2,
  /** Ripple radius as a fraction of shoal radius, clamped, in metres. */
  rippleFrac: 0.06,
  rippleMinM: 55,
  rippleMaxM: 200,
  /**
   * Angular floor on a ripple mote, in radians.
   *
   * A ripple has to be locatable from outside the shoal or it teaches nothing,
   * and a true-scale element at 4 km is invisible. 0.0022 rad is about three
   * pixels at 1400 px wide: enough to see, small enough that the flare never
   * reads as a light rather than as a lot of small things.
   */
  rippleMinRad: 0.0030,
  /**
   * How bright a turning shoal is, as a multiple of the dominant luminary's
   * colour after that colour has been normalised to a peak of one.
   *
   * Additive, so this is a lift and not a lamp. It has to clear the sky it is
   * drawn against — a ripple mote writes depth, so at its pixel the sky is
   * *replaced* rather than added to, and a mote dimmer than the sky would read
   * as a dark dot. `_stepRipples` cuts a mote's scale to zero once its fade
   * drops below `rippleFloor` for exactly that reason.
   *
   * Two, and it took a capture to get there. The first value, 0.42, is a
   * perfectly reasonable "faint lift" and it was invisible: the frame it has to
   * beat is lit cloud, which lands around 0.5–0.9 linear before tone mapping, so
   * anything under about 1.5 reads as a slightly-off patch of the same cloud.
   * The ripple has to be *unmistakable* or §10.4's tell cannot be learned — the
   * player has to be able to say "that sound came from there".
   */
  rippleGain: 2.0,
  rippleFloor: 0.14,
};

const TAU = Math.PI * 2;

/** Deterministic per-shoal noise. Captures have to be repeatable. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id) {
  const s = String(id ?? 'choir');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Shared GPU resources
//
// Geometry is shared across every ChoirView because THREE.InstancedMesh keeps
// its per-instance matrices on the mesh and not on the geometry, so one
// tetrahedron serves every shoal in the world. Materials are *templates* that
// each view clones: a clone keeps the same program key, so it costs no shader
// compile (PERFORMANCE_BUDGET §7 makes a post-startup compile a hard failure)
// while letting each shoal carry its own tone from its own density01.
// ---------------------------------------------------------------------------

let SHARED = null;

/**
 * A round speck.
 *
 * `THREE.Points` are square, and at four pixels a square is unmistakably a
 * square: the first capture of the size classes read as blocky digital noise
 * over the lit cloud, which is worse than the uniform-dot version it replaced.
 *
 * The edge is a hard `alphaTest` rather than blended transparency, and that is
 * forced rather than chosen. A partly-transparent fragment still writes depth,
 * and at a pixel with depth the cloud composite uses the scene buffer instead of
 * the sky — so a soft-edged point would ring itself with dark fringes wherever
 * it is drawn against open sky. Binary coverage has no such edge.
 *
 * The solid core runs to 0.42 of the sprite so that a two-pixel point, which
 * only gets a couple of texture samples, cannot fall below the threshold and
 * blink out.
 */
function discTexture() {
  const S = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g2 = cv.getContext('2d');
  const img = g2.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = r <= 0.42 ? 1 : Math.max(0, 1 - (r - 0.42) / 0.08);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g2.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shared() {
  if (SHARED) return SHARED;
  // Twenty triangles, not four. A tetrahedron is the obvious minimum and a
  // capture killed it: at 26 m a 0.4 m body is twenty screen pixels, which is
  // more than enough to see that it is a *triangle*, and a school of hard black
  // triangles reads as debris. An icosahedron at the same size reads as a body.
  // Scaled non-uniformly per instance into something longer than it is wide, so
  // a school has a direction — which is the single strongest signal that these
  // are animals and not particles.
  const mote = new THREE.IcosahedronGeometry(0.5, 0);
  // Ripple motes are never more than a few pixels — an angular floor keeps them
  // that way on purpose — so they get the cheap shape. Four triangles times 384
  // instead of twenty saves six thousand triangles nobody could ever resolve.
  const dot = new THREE.TetrahedronGeometry(0.5, 0);

  const disc = discTexture();
  const grainMat = new THREE.PointsMaterial({
    size: CHOIR_ART.grainClasses[0].px,
    map: disc,
    alphaTest: 0.5,
    // Metres would be the obvious choice and it is wrong: a 20 m knot is 60 px
    // at 200 m and a third of a pixel at 12 km, so the same shoal reads as
    // confetti near and as nothing far. A measured pass with world-sized knots
    // came back looking like black paper triangles thrown at the camera.
    sizeAttenuation: false,
    // Depth is written, which is what makes the grain exist at all — see fact 1
    // in the header — and which gives every speck honest occlusion against the
    // cloud behind it.
    depthWrite: true,
    transparent: false,
    fog: false,
    toneMapped: true,
  });

  // The only lit material here, and it is on the only geometry big enough on
  // screen for lighting to say anything. ART_DIRECTION's rule that a body shifts
  // with whatever luminary is up is carried by the scene lights for these and by
  // an explicit tint for the grain, which cannot be lit because points have no
  // normal.
  const elemMat = new THREE.MeshStandardMaterial({
    color: FLESH.hull,
    roughness: FLESH.roughness,
    metalness: 0,
    emissive: FLESH.rim,
    emissiveIntensity: 0.16,
  });

  const rippleMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,          // multiplied by per-instance colour; the sky supplies the hue
    blending: THREE.AdditiveBlending,
    transparent: true,
    // True, unlike every other additive effect in this project, and for the
    // reason in the header: without depth the composite replaces the pixel with
    // sky and the ripple never happens.
    depthWrite: true,
    toneMapped: true,
  });

  SHARED = { mote, dot, disc, grainMat, elemMat, rippleMat };
  return SHARED;
}

/**
 * Compile this body's three programs before the clock starts.
 *
 * PERFORMANCE_BUDGET §7 makes a post-startup shader compile a hard failure — it
 * is a several-hundred-millisecond stall against a 45 ms hitch budget, and it
 * always lands the first time a creature comes into range, which is always a
 * dramatic moment. A body built lazily on first sync cannot avoid that by
 * itself, so the host is expected to call this once during warm-up:
 *
 *   ChoirView.prewarm(renderer, scene, camera);
 *
 * It adds a one-instance proxy of each material off in the far distance,
 * compiles, and removes it again. Skipping it is not fatal; it moves the compile
 * to the worst possible moment.
 */
function prewarmChoir(renderer, scene, camera) {
  const g = shared();
  const holder = new THREE.Group();
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
  holder.add(new THREE.Points(pg, g.grainMat));
  const im = new THREE.InstancedMesh(g.mote, g.elemMat, 1);
  const rm = new THREE.InstancedMesh(g.dot, g.rippleMat, 1);
  // instanceColor has to exist before the compile or the ripple's real material
  // is a different program from the one warmed here.
  rm.setColorAt(0, new THREE.Color(1, 1, 1));
  holder.add(im); holder.add(rm);
  holder.visible = true;
  holder.position.set(0, -1e6, 0);
  scene.add(holder);
  renderer.compile(scene, camera);
  scene.remove(holder);
  pg.dispose();
}

/**
 * Free the shared geometry and material templates.
 *
 * Only for a full teardown — `dispose()` on a view deliberately does not touch
 * these, or the second shoal in the world would lose its geometry when the first
 * one despawned.
 */
export function disposeChoirShared() {
  if (!SHARED) return;
  for (const v of Object.values(SHARED)) v.dispose();
  SHARED = null;
}

// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * A shoal.
 *
 * Reads `radiusM`, `density01`, `posture`, `heading` and the live echo bus off
 * the simulation and never writes to any of them.
 */
export class ChoirView extends CreatureView {
  constructor(creature, opts = {}) {
    super(creature, opts);
    this._camPos = new THREE.Vector3();
    this._camLocal = new THREE.Vector3();
    this._t = 0;

    /** Knot (school) centres in shoal-local space. The grain clumps around these. */
    this._knotPos = null;
    this._knotCount = 0;
    this._activeKnots = 0;

    /** Ripple pool. Slot order is arbitrary; inactive slots are scaled to zero. */
    this._ripples = [];
    this._lastEchoId = 0;

    this._heading = 0;
    this._density = -1;
  }

  // The base class hands `camPos` to sync() but not to step(), and almost
  // everything this body does is camera-relative — which knots resolve, where
  // the drift lattice sits, how big a ripple mote has to be. Capturing it here
  // is cheaper and less fragile than reaching for the camera through ctx.
  sync(dt, camPos, ctx) {
    this._camPos.copy(camPos);
    return super.sync(dt, camPos, ctx);
  }

  build() {
    this._built = true;
    const g = shared();
    const rng = mulberry32(hashId(this.creature.id));
    const R = this.creature.radiusM || 1500;
    this.R = R;

    // A perfect sphere reads as a bubble, and a bubble is an object. Three low
    // harmonics of direction are enough to make the boundary lumpy — the shape
    // stops being nameable, which is the whole intent of "a region of sky that
    // is subtly wrong".
    const lump = [];
    for (let i = 0; i < 3; i++) {
      lump.push({
        ax: rng() * 2 - 1, ay: rng() * 2 - 1, az: rng() * 2 - 1,
        k: 1 + i * 1.7, ph: rng() * TAU, amp: 0.16 / (i + 1),
      });
    }
    const boundary = (x, y, z) => {
      let f = 0.80;
      for (const l of lump) f += l.amp * Math.sin((x * l.ax + y * l.ay + z * l.az) * l.k + l.ph);
      return f;
    };

    // --- knots -------------------------------------------------------------
    //
    // The grain is clumped, and this is the difference between a shoal and film
    // grain. A first pass scattered the points uniformly through the ball; from
    // inside, the result was an even speckle over the whole frame that read as
    // dirt on the sensor, because *even* is the one thing a shoal is never. Real
    // schooling puts everything in knots with gaps between them, and gaps are
    // what let the eye see that there is a volume here rather than a filter.
    const K = Math.max(1, Math.round(CHOIR_ART.grain / CHOIR_ART.grainPerKnot));
    this._knotPos = new Float32Array(K * 3);
    this._knotCount = K;
    for (let k = 0; k < K; k++) {
      const ct = rng() * 2 - 1;
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const phi = rng() * TAU;
      const dx = st * Math.cos(phi), dy = ct, dz = st * Math.sin(phi);

      // A third of the knots go into a shell band. §10.4's shoal is a place you
      // enter, and a boundary you can watch yourself cross is what makes it one;
      // a purely uniform ball fades out with no edge and reads as fog.
      const shell = rng() < 0.34;
      const u = rng();
      const rr = shell ? (0.82 + 0.18 * u) : Math.cbrt(u) * 0.88;
      const r = R * rr * boundary(dx, dy, dz);
      this._knotPos[k * 3] = dx * r;
      this._knotPos[k * 3 + 1] = dy * r;
      this._knotPos[k * 3 + 2] = dz * r;
    }

    // --- grain -------------------------------------------------------------
    //
    // One buffer per size class, each filled knot by knot in the same order, so
    // that truncating all three by the same fraction removes whole knots from
    // the tail rather than thinning every knot into a haze. Fewer schools is
    // what a thinner shoal is; the same schools with fewer animals each is not.
    const classes = CHOIR_ART.grainClasses;
    const cap = classes.map((c) => Math.ceil(CHOIR_ART.grain * c.share * 1.3) + 8);
    const buf = cap.map((n) => new Float32Array(n * 3));
    const used = classes.map(() => 0);
    const spread = CHOIR_ART.knotSpreadM;

    for (let k = 0; k < K; k++) {
      const kx = this._knotPos[k * 3], ky = this._knotPos[k * 3 + 1], kz = this._knotPos[k * 3 + 2];
      // Knots vary in size by a factor of four, so the texture has structure at
      // more than one scale and never falls into a regular stipple.
      //
      // The jitter is centred on 1.0, which it was not: it read `0.5 + 1.5 x`,
      // whose mean is 1.25, so the field always came out a quarter larger than
      // `grain` asked for — 26 000 measured as 32 794 drawn. That did not matter
      // while the count was a soft target and it matters now that it is a budget
      // line, so the spread is the same shape and the mean is one.
      const per = Math.round(CHOIR_ART.grainPerKnot * (0.4 + rng() * 1.2));
      // Loose knots read as a shoal; tight ones read as gravel thrown at the
      // lens. The spread varies for the same reason the counts do.
      const rad = spread * (0.6 + rng() * 0.9);
      for (let j = 0; j < per; j++) {
        // Class by lottery per point, so one knot contains a mix of sizes —
        // assigning a class per knot made every school internally uniform and
        // put the stipple straight back.
        let u = rng(), ci = 0;
        for (; ci < classes.length - 1; ci++) { if (u < classes[ci].share) break; u -= classes[ci].share; }
        if (used[ci] >= cap[ci]) continue;
        const ct = rng() * 2 - 1;
        const st = Math.sqrt(Math.max(0, 1 - ct * ct));
        const phi = rng() * TAU;
        const rr = Math.cbrt(rng()) * rad;
        const w = used[ci]++;
        buf[ci][w * 3] = kx + st * Math.cos(phi) * rr;
        buf[ci][w * 3 + 1] = ky + ct * rr;
        buf[ci][w * 3 + 2] = kz + st * Math.sin(phi) * rr;
      }
    }

    this.grainLayers = [];
    for (let ci = 0; ci < classes.length; ci++) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf[ci], 3));
      geom.computeBoundingSphere();
      const mat = g.grainMat.clone();
      mat.size = classes[ci].px;
      const pts = new THREE.Points(geom, mat);
      this.object3D.add(pts);
      this.grainLayers.push({ cls: classes[ci], geom, mat, points: pts, capacity: used[ci] });
    }

    // --- elements (resolved knots) -----------------------------------------
    const E = CHOIR_ART.resolveMax * CHOIR_ART.elementsPerKnot[1];
    this.elemMat = g.elemMat.clone();
    this.elements = new THREE.InstancedMesh(g.mote, this.elemMat, E);
    this.elements.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Its instances move every frame, so a cached bounding sphere would be a lie
    // and recomputing one each frame costs more than never culling 384 motes.
    this.elements.frustumCulled = false;
    this.elements.count = 0;
    // Offsets inside a knot, reused for every knot. Nobody can see that two
    // knots 300 m apart share an arrangement, and generating them per knot would
    // mean 26 000 x 64 floats resident for something never looked at twice.
    this._elemOff = new Float32Array(CHOIR_ART.elementsPerKnot[1] * 3);
    this._elemPhase = new Float32Array(CHOIR_ART.elementsPerKnot[1]);
    for (let i = 0; i < CHOIR_ART.elementsPerKnot[1]; i++) {
      const ct = rng() * 2 - 1;
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const phi = rng() * TAU;
      const r = Math.cbrt(rng());
      this._elemOff[i * 3] = st * Math.cos(phi) * r;
      this._elemOff[i * 3 + 1] = ct * r;
      this._elemOff[i * 3 + 2] = st * Math.sin(phi) * r;
      this._elemPhase[i] = rng() * TAU;
    }
    this.object3D.add(this.elements);

    // --- drift lattice ------------------------------------------------------
    const L = CHOIR_ART.driftCellM;
    const D = CHOIR_ART.driftSlots * 27;
    this.drift = new THREE.InstancedMesh(g.mote, this.elemMat, D);
    this.drift.frustumCulled = false;
    this.drift.count = 0;
    // Interleaved: slot-major, so truncating `count` thins every cell evenly
    // instead of emptying the cells with the highest indices. Without this,
    // lowering density would open a hole on one side of the camera.
    let w = 0;
    for (let slot = 0; slot < CHOIR_ART.driftSlots; slot++) {
      for (let cx = -1; cx <= 1; cx++) {
        for (let cy = -1; cy <= 1; cy++) {
          for (let cz = -1; cz <= 1; cz++) {
            _p.set(cx * L + (rng() - 0.5) * L, cy * L + (rng() - 0.5) * L, cz * L + (rng() - 0.5) * L);
            _q.setFromEuler(_e.set(0, rng() * TAU, (rng() - 0.5) * 1.2));
            _s.set(CHOIR.elementM, CHOIR.elementM * CHOIR_ART.elementAspect,
              CHOIR.elementM * CHOIR_ART.elementAspect);
            this.drift.setMatrixAt(w++, _m.compose(_p, _q, _s));
          }
        }
      }
    }
    this.drift.instanceMatrix.needsUpdate = true;
    this.driftGroup = new THREE.Group();
    this.driftGroup.add(this.drift);
    this.object3D.add(this.driftGroup);

    // --- ripples ------------------------------------------------------------
    const RP = CHOIR_ART.rippleSlots * CHOIR_ART.rippleMotes;
    this.rippleMat = g.rippleMat.clone();
    this.ripple = new THREE.InstancedMesh(g.dot, this.rippleMat, RP);
    this.ripple.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ripple.frustumCulled = false;
    // Every instance starts collapsed; a slot is "off" by being scale zero,
    // which is a degenerate triangle the rasteriser throws away. Cheaper and far
    // simpler than keeping the active slots as a contiguous prefix of `count`.
    _s.setScalar(0); _q.identity(); _p.set(0, 0, 0);
    for (let i = 0; i < RP; i++) this.ripple.setMatrixAt(i, _m.compose(_p, _q, _s));
    this.ripple.instanceMatrix.needsUpdate = true;
    _c.setRGB(0, 0, 0);
    for (let i = 0; i < RP; i++) this.ripple.setColorAt(i, _c);
    this.ripple.instanceColor.needsUpdate = true;
    this.object3D.add(this.ripple);

    // Directions for one ripple shell, shared by all slots for the same reason
    // the knot element offsets are shared.
    this._rippleDir = new Float32Array(CHOIR_ART.rippleMotes * 3);
    for (let i = 0; i < CHOIR_ART.rippleMotes; i++) {
      const ct = rng() * 2 - 1;
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const phi = rng() * TAU;
      // Not exactly on the shell: a mathematically perfect sphere of dots reads
      // as a wireframe prop. +/-18% of the radius makes it a thickening wave.
      const j = 0.82 + rng() * 0.36;
      this._rippleDir[i * 3] = st * Math.cos(phi) * j;
      this._rippleDir[i * 3 + 1] = ct * j;
      this._rippleDir[i * 3 + 2] = st * Math.sin(phi) * j;
    }
    for (let i = 0; i < CHOIR_ART.rippleSlots; i++) {
      this._ripples.push({ age: -1, x: 0, y: 0, z: 0, rMax: 0 });
    }

    // Echoes already in flight when the body appears are not new events, and
    // flaring all of them at once on the first frame a shoal comes into range
    // would be a firework where §10.4 wants a whisper.
    const bus = this.creature.echoes;
    if (bus && bus.live) for (const e of bus.live()) if (e.id > this._lastEchoId) this._lastEchoId = e.id;

    this._applyDensity();
  }

  /**
   * Push `density01` into the two things it is allowed to change.
   *
   * Called on a change of a hundredth rather than every frame — `setDrawRange`
   * is cheap but this is also where the elements-per-knot decision lives, and
   * that invalidates the resolved set.
   */
  _applyDensity() {
    const d = Math.max(0, Math.min(1, this.creature.density01 ?? 0));
    if (Math.abs(d - this._density) < 0.01) return;
    this._density = d;

    // The floor is not zero: DISPERSED is "thin, scattered", not absent, and a
    // shoal that can vanish entirely can be flown through without the player
    // ever learning it was there.
    const f = 0.28 + 0.72 * d;
    this._densityF = f;
    this._applyGrainCount(true);
    this._activeKnots = Math.round(this._knotCount * f);

    this._perKnot = Math.round(CHOIR_ART.elementsPerKnot[0]
      + (CHOIR_ART.elementsPerKnot[1] - CHOIR_ART.elementsPerKnot[0]) * d);

    // Drift count from §10.4's own element budget rather than a number picked to
    // look nice: the field you fly through has the density the shoal claims.
    //
    // This used to read `CHOIR_ART.grain * 3.5`, which quietly tied the density
    // of the field you fly through to the *rendering* budget of the field you
    // look at. They were the same number by coincidence and stopped being so the
    // moment the grain count was set by screen coverage: dropping the grain from
    // 26 000 to 4 000 would have emptied the inside of the shoal by a factor of
    // six, which is the one place §10.4 most needs something to be passing.
    const R = this.R;
    const perM3 = (CHOIR_ART.driftPopulation * d) / Math.max((4 / 3) * Math.PI * R * R * R, 1);
    const perCell = perM3 * Math.pow(CHOIR_ART.driftCellM, 3);
    this._driftSlots = Math.max(0, Math.min(CHOIR_ART.driftSlots, Math.round(perCell)));
  }

  /**
   * Push `density01 x range` into the grain's draw ranges.
   *
   * Both factors change slowly — density on a 30 s time constant, range with the
   * ship — so this is gated on a hundredth of a change rather than run every
   * frame. `setDrawRange` is cheap, but it is not free and there is nothing to
   * see for a difference of one point in four thousand.
   *
   * Truncation removes whole knots from the tail rather than thinning every knot
   * into a haze, because the buffers were filled knot by knot. Fewer schools is
   * what a thinner shoal is; the same schools with fewer animals each is not —
   * that is a dissolve, and it is visible as one.
   */
  _applyGrainCount(force) {
    const f = (this._densityF ?? 1) * (this._rangeF ?? 1);
    if (!force && Math.abs(f - (this._grainF ?? -1)) < 0.01) return;
    this._grainF = f;
    this._grainCount = 0;
    for (const L of this.grainLayers) {
      const n = Math.round(L.capacity * f);
      L.geom.setDrawRange(0, n);
      this._grainCount += n;
    }
  }

  /**
   * How much of the field to draw for the shoal's current angular size.
   *
   * See `grainAngleRef`. `d` is to the centre; inside the shoal the ratio goes
   * above one and clamps, which is right — from inside, the field is the sky.
   */
  _stepGrainRange(d) {
    const ang = this.R / Math.max(d, 1);
    const k = ang / CHOIR_ART.grainAngleRef;
    this._rangeF = Math.max(CHOIR_ART.grainThinFloor, Math.min(1, k * k));
    this._applyGrainCount(false);
  }

  step(dt, d, ctx) {
    this._t += dt;
    this._applyDensity();
    this._stepGrainRange(d);
    this._heading = typeof this.creature.heading === 'number' ? this.creature.heading : 0;

    // Camera in shoal-local space. Done by hand rather than through
    // worldToLocal, which would need an updateMatrixWorld on a node with four
    // children to be correct at this point in the frame.
    const cp = this.creature.position;
    const dx = this._camPos.x - cp.x, dy = this._camPos.y - cp.y, dz = this._camPos.z - cp.z;
    const ch = Math.cos(this._heading), sh = Math.sin(this._heading);
    this._camLocal.set(dx * ch - dz * sh, dy, dx * sh + dz * ch);

    this._tintGrain(ctx);

    // `d` is the distance to the shoal's CENTRE, and the base class's LOD bands
    // are computed from it — which for a body with a 1.5 km radius means the
    // camera can be deep inside the shoal while the LOD says `mid`. Everything
    // near-field is therefore gated on the distance to the *surface*, and
    // lodLevel is used only where a whole-body decision is the right one.
    const dSurf = Math.max(0, d - this.R);
    const canResolve = dSurf < CHOIR_ART.resolveM;
    const inside = d < this.R;

    this._stepDrift(inside);
    this._stepResolve(canResolve);
    this._stepRipples(dt, d, ctx);
  }

  /**
   * The grain takes the colour of whatever luminary is up.
   *
   * Points have no normal, so this material cannot be lit. That is the price of
   * a field this size costing one draw call, and the tint buys back the part
   * that matters: ART_DIRECTION's requirement that a body under the ember is a
   * different-looking animal from the same body under the veil. The tone is kept
   * where it was set — only the hue moves — so the grain's contrast against sky
   * and cloud, which is the whole reason it is visible, does not drift with the
   * time of day.
   */
  _tintGrain(ctx) {
    const sky = ctx && ctx.clouds && ctx.clouds.sky;
    let hr = 0.72, hg = 1, hb = 0.94;
    if (sky && sky.dominant) {
      const c = sky.dominant.color;
      const m = Math.max(c.x, c.y, c.z) || 1;
      hr = c.x / m; hg = c.y / m; hb = c.z / m;
    }
    // Point size is in device pixels and does not scale with the render target,
    // so without this the shoal is coarse at 720p and invisibly fine at 4K.
    //
    // The height is taken from the cloud system's own scene buffer, which is
    // allocated at the drawing-buffer size, rather than from `ctx.renderer`.
    // That is not a preference: main.js calls `views.sync(..., { simTime })`, so
    // `ctx.renderer` is undefined in the actual game and this correction had
    // never once run outside a test harness. `ctx.renderer` is still honoured
    // first for the harnesses that do pass one.
    const r = ctx && ctx.renderer;
    const rt = ctx && ctx.clouds && ctx.clouds.sceneRT;
    let h = 0;
    if (r && r.getSize) h = r.getSize(_p).y;
    else if (rt) h = rt.height;
    const k = (h || CHOIR_ART.grainRefH) / CHOIR_ART.grainRefH;
    for (const L of this.grainLayers) {
      const t = L.cls.tone;
      L.mat.color.setRGB(hr * t, hg * t, hb * t);
      L.mat.size = L.cls.px * k;
    }
  }

  /** The lattice, snapped so it is static in the world and free to maintain. */
  _stepDrift(inside) {
    // Outside the shoal every drift element is at least a shoal radius away and
    // therefore far under a pixel. Drawing them is pure cost.
    const on = inside && this._driftSlots > 0;
    this.drift.visible = on;
    if (!on) { this.drift.count = 0; return; }
    this.drift.count = this._driftSlots * 27;
    const L = CHOIR_ART.driftCellM;
    this.driftGroup.position.set(
      Math.round(this._camLocal.x / L) * L,
      Math.round(this._camLocal.y / L) * L,
      Math.round(this._camLocal.z / L) * L,
    );
  }

  /**
   * Draw the animals in the nearest few knots.
   *
   * The knot's own grain points are left exactly where they are: at two to four
   * pixels they disappear among the ninety animals that have grown around them,
   * and hiding them would mean a per-point size attribute, a custom shader and a
   * runtime program compile — which PERFORMANCE_BUDGET §7 forbids outright.
   */
  _stepResolve(canResolve) {
    if (!canResolve) {
      if (this.elements.count) this.elements.count = 0;
      return;
    }

    const near = [];
    const lim = CHOIR_ART.resolveM;
    const lim2 = lim * lim;
    // Over the knots, not the points: about two thousand distance tests, which
    // is under 20 microseconds, and it is the knots that resolve. The count is
    // the density-thinned one so a knot whose specks are not drawn does not
    // sprout sixty animals.
    const n = this._activeKnots;
    for (let i = 0; i < n; i++) {
      const ex = this._knotPos[i * 3] - this._camLocal.x;
      const ey = this._knotPos[i * 3 + 1] - this._camLocal.y;
      const ez = this._knotPos[i * 3 + 2] - this._camLocal.z;
      const dd = ex * ex + ey * ey + ez * ez;
      if (dd > lim2) continue;
      near.push({ i, dd });
    }
    near.sort((a, b) => a.dd - b.dd);
    if (near.length > CHOIR_ART.resolveMax) near.length = CHOIR_ART.resolveMax;
    let w = 0;
    const per = this._perKnot;
    const t = this._t;
    const rad = CHOIR_ART.knotSpreadM;
    for (const k of near) {
      const dist = Math.sqrt(k.dd);
      // Elements grow in over the outer 60 m of the band, which at cruise is
      // most of a second: slow enough not to read as a pop, fast enough not to
      // read as animals inexplicably inflating.
      const grow = Math.max(0, Math.min(1, (lim - dist) / 60));
      if (grow <= 0.001) continue;
      const kx = this._knotPos[k.i * 3], ky = this._knotPos[k.i * 3 + 1], kz = this._knotPos[k.i * 3 + 2];
      // One heading for the whole school, turning slowly. Aligned bodies are
      // what makes a cluster read as a shoal rather than as a cloud of debris,
      // and it is free: the knot index is the seed, so the same school always
      // swims the same way and a capture is repeatable.
      const seed = Math.sin(k.i * 12.9898) * 43758.5453;
      const kSeed = seed - Math.floor(seed);
      const yaw = kSeed * TAU + Math.sin(t * 0.11 + kSeed * 9.0) * 0.5;
      const pitch = (kSeed - 0.5) * 0.9 + Math.sin(t * 0.09 + kSeed * 4.0) * 0.2;
      const len = CHOIR.elementM * grow;
      const wide = len * CHOIR_ART.elementAspect;
      for (let e = 0; e < per; e++) {
        const ph = this._elemPhase[e];
        // The school breathes. Cheap — one sine per axis, on matrices already
        // being written. A shoal of motionless dots is a dot pattern.
        const wob = 0.22 * rad;
        _p.set(
          kx + this._elemOff[e * 3] * rad + Math.sin(t * 0.7 + ph) * wob,
          ky + this._elemOff[e * 3 + 1] * rad + Math.sin(t * 0.9 + ph * 1.7) * wob,
          kz + this._elemOff[e * 3 + 2] * rad + Math.sin(t * 0.6 + ph * 2.3) * wob,
        );
        // Aligned, but not identically: perfect alignment is a formation, and a
        // formation is a machine. The jitter is what makes it alive.
        _q.setFromEuler(_e.set(0,
          yaw + Math.sin(ph * 3.1 + t * 0.8) * 0.28,
          pitch + Math.sin(ph * 2.3 + t * 0.7) * 0.22));
        _s.set(len, wide, wide);
        this.elements.setMatrixAt(w++, _m.compose(_p, _q, _s));
      }
    }
    this.elements.count = w;
    if (w) this.elements.instanceMatrix.needsUpdate = true;
  }

  /**
   * Echoes, as ripples.
   *
   * New echoes are found by id rather than by time, because `ctx.t` is not
   * guaranteed to be plumbed through the renderer and `GAME.seek()` only ever
   * moves forward — an id high-water mark is correct under both, and under a
   * capture that steps the loop by hand.
   */
  _stepRipples(dt, d, ctx) {
    const bus = this.creature.echoes;
    if (bus && bus.live) {
      const live = bus.live();
      for (let i = 0; i < live.length; i++) {
        const e = live[i];
        if (e.id <= this._lastEchoId) continue;
        this._lastEchoId = e.id;
        if (e.choirId !== this.creature.id) continue;
        this._fire(e);
      }
    }

    const gain = this._rippleColor(ctx);
    const motes = CHOIR_ART.rippleMotes;
    let touched = false;

    for (let s = 0; s < this._ripples.length; s++) {
      const rp = this._ripples[s];
      if (rp.age < 0) continue;
      rp.age += dt;
      const u = rp.age / CHOIR_ART.rippleSec;
      const base = s * motes;

      // Radius eases out and brightness decays monotonically from full: a wave
      // that slows as it spreads and fades from the middle. Linear on both reads
      // as an expanding sphere prop rather than as something propagating through
      // a medium.
      //
      // There is deliberately **no fade-in**. A shoal turning is instantaneous —
      // and an earlier version that ramped brightness over the first eighth of a
      // second killed every ripple on the frame it was born, because the ramp put
      // the first frame's brightness below `rippleFloor` and the floor collapses
      // the slot. Every echo in the game fired and none of them was ever drawn.
      const fade = u >= 1 ? 0 : Math.pow(1 - u, 1.6);
      if (fade < CHOIR_ART.rippleFloor) {
        // Collapsed rather than dimmed. A dim additive mote still writes depth,
        // and at a pixel with depth the composite uses the scene buffer instead
        // of the sky — so a mote faded to nothing would leave a black dot in the
        // sky rather than nothing at all.
        rp.age = -1;
        _s.setScalar(0); _q.identity(); _p.set(0, 0, 0);
        _c.setRGB(0, 0, 0);
        for (let i = 0; i < motes; i++) {
          this.ripple.setMatrixAt(base + i, _m.compose(_p, _q, _s));
          this.ripple.setColorAt(base + i, _c);
        }
        touched = true;
        continue;
      }

      const r = rp.rMax * (1 - Math.pow(1 - u, 2.2));
      // Angular floor, so a ripple 4 km away is still a few pixels. `d` is the
      // distance to the shoal centre, which is within a shoal radius of the
      // ripple; using it rather than the true per-ripple distance costs a factor
      // of at most two in size and saves a square root per mote.
      const size = Math.max(CHOIR.elementM, d * CHOIR_ART.rippleMinRad);
      _c.setRGB(gain.x * fade, gain.y * fade, gain.z * fade);
      for (let i = 0; i < motes; i++) {
        _p.set(
          rp.x + this._rippleDir[i * 3] * r,
          rp.y + this._rippleDir[i * 3 + 1] * r,
          rp.z + this._rippleDir[i * 3 + 2] * r,
        );
        _q.setFromEuler(_e.set(i + rp.age, i * 2.1 + rp.age * 1.3, i * 0.7));
        _s.setScalar(size);
        this.ripple.setMatrixAt(base + i, _m.compose(_p, _q, _s));
        this.ripple.setColorAt(base + i, _c);
      }
      touched = true;
    }

    if (touched) {
      this.ripple.instanceMatrix.needsUpdate = true;
      if (this.ripple.instanceColor) this.ripple.instanceColor.needsUpdate = true;
    }
  }

  _fire(echo) {
    // Oldest slot wins. Dropping a ripple silently would break the association
    // §10.4 needs the player to make, so a slot is always found.
    let slot = this._ripples[0];
    for (let i = 0; i < this._ripples.length; i++) {
      if (this._ripples[i].age < 0) { slot = this._ripples[i]; break; }
      if (this._ripples[i].age > slot.age) slot = this._ripples[i];
    }
    const cp = this.creature.position;
    const wx = echo.x - cp.x, wy = echo.y - cp.y, wz = echo.z - cp.z;
    const ch = Math.cos(this._heading), sh = Math.sin(this._heading);
    slot.x = wx * ch - wz * sh;
    slot.y = wy;
    slot.z = wx * sh + wz * ch;
    slot.age = 0;
    // A denser shoal turns over a wider volume; RESONANT is a whole large voice
    // rather than a fragment, so it is the widest. Size is the only thing an
    // echo is allowed to vary by — see the header on why channel must not tint.
    const wide = this.creature.posture === POSTURE.RESONANT ? 1.35 : 1.0;
    slot.rMax = Math.min(CHOIR_ART.rippleMaxM, Math.max(CHOIR_ART.rippleMinM,
      this.R * CHOIR_ART.rippleFrac)) * wide * (0.75 + 0.5 * Math.max(this._density, 0));
    return slot;
  }

  /**
   * The colour a turning shoal reflects.
   *
   * Read from whichever luminary is dominant, so it is green-cyan under the veil
   * and copper under the ember with nothing here choosing. A shoal that flared
   * the same colour under every sky would be the one object in frame announcing
   * that it is lit by something the world does not have.
   */
  _rippleColor(ctx) {
    const sky = ctx && ctx.clouds && ctx.clouds.sky;
    const out = this._rc || (this._rc = new THREE.Vector3());
    if (sky && sky.dominant) {
      out.copy(sky.dominant.color);
      const m = Math.max(out.x, out.y, out.z) || 1;
      out.multiplyScalar(CHOIR_ART.rippleGain / m);
    } else {
      // Only reached if the shoal is rendered without a sky, which happens in
      // isolation tests. Cold and dim, matching the veil.
      out.set(0.30, 0.42, 0.39);
    }
    return out;
  }

  /** Counts a capture or a budget check can quote without guessing. */
  stats() {
    // 20 triangles per element (icosahedron), 4 per ripple mote (tetrahedron).
    const tri = (m) => (m && m.visible ? m.count * 20 : 0);
    return {
      lod: this.lodLevel,
      posture: this.creature.posture,
      density01: +Math.max(this._density, 0).toFixed(3),
      radiusM: Math.round(this.R),
      points: this._grainCount,
      elements: this.elements.count,
      drift: this.drift.count,
      ripples: this._ripples.filter((r) => r.age >= 0).length,
      drawCalls: this.grainLayers.length + 1
        + (this.drift.count ? 1 : 0) + (this.elements.count ? 1 : 0),
      triangles: tri(this.elements) + tri(this.drift) + this.ripple.count * 4,
    };
  }

  /**
   * Only what this view owns. The mote geometry and the material templates are
   * shared with every other shoal, so the base class's traverse-and-dispose
   * would take the second Choir's body away with the first one's.
   */
  dispose() {
    this.object3D.clear();
    for (const L of this.grainLayers) { L.geom.dispose(); L.mat.dispose(); }
    this.elemMat.dispose();
    this.rippleMat.dispose();
  }
}

/** See `prewarmChoir`. Static so the host needs no second import. */
ChoirView.prewarm = prewarmChoir;

export { prewarmChoir };
export default ChoirView;

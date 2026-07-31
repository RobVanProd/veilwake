// The Listener's body. Contract §10.1.
//
//   import { ListenerView } from './render/bodies/listener.view.js';
//   views.register('Listener', (c, o) => new ListenerView(c, o));
//
// Two hundred and forty metres of blind animal. Everything below follows from
// three sentences in §10.1 and one in ART_DIRECTION, and where it does not, the
// number says so.
//
// --- what it is allowed to be ----------------------------------------------
//
// **It is blind.** So it has no eyes, nothing that reads as an eye, and — the
// harder rule — no light of any kind. Every other body in the roster gets to
// solve "how do I read at 2 km" with emission. This one cannot. What carries it
// is silhouette, the sheen off a wet flank, and the fact that cloud eats most of
// it. The one thing here that adds light is `RIM_*`, a grazing-angle term that
// exists because a measurement demanded it: with only albedo, a 240 m animal
// against clear dark sky differed from the empty frame by **three levels out of
// 255**. It is not on the photic channel and no creature can see it.
//
// **It hunts by sound, omnidirectionally.** §10.1's sense table says
// omnidirectional, which rules out the obvious design — a dish on the front. So
// the receiver is distributed: twenty-four membranous panels folded flat around
// the thorax, four rows to a flank. They are the ears, and they are the only
// thing on the animal that ever changes shape for a reason the player can learn.
//
// **It goes silent and still to listen.** This is the best mechanic the creature
// has and it was, until this file, audible only. §10.1: *"the rule the player
// learns is one sentence — when it goes quiet, you go quiet."* A rule you can
// only hear is a rule you can miss. So when `listening` goes true the panels
// open from flush to radial and the flex stops dead. Measured broadside at
// 620 m, that takes the silhouette from 38 px deep to 62 px — **+63%** — with
// the body itself unchanged (`ab4_cruise` / `ab4_listen` against `ab4_empty`).
// Fold-at-speed falls out of the same mechanism for free: something closing at
// 20 m/s has its ears down, so "hunting" and "listening" are different outlines.
//
// **It calls.** §10.1 wants the call to be the player's warning and warns that
// audio-only leaves a player looking the wrong way with nothing. The melon is
// the resonator — that is what the enormous blunt head is for — so the head and
// the throat pleats inflate over the call, and "swell rather than start" is the
// envelope, not a switch.
//
// --- how it moves ------------------------------------------------------------
//
// A travelling flex, dorsoventral, wavelength slightly SHORTER than the body so
// the wave visibly travels down it instead of the whole animal wagging. A wag is
// what you get when the wavelength exceeds the body, and at this scale a wag
// reads as a sprite being rotated. There is a small lateral component in
// quadrature so the motion still reads when the animal is seen from directly
// above or directly below, where a purely vertical flex is invisible.
//
// The flex, the panel fan and the throat swell are all vertex-shader work
// sharing one uniform block, so `step()` writes about eight floats a frame and
// the cost at range is a uniform upload. That matters: these are visible from
// kilometres away and there can be several. Measured: 4116 triangles and two
// draw calls at LOD.near and LOD.mid, 672 triangles and one at LOD.far, nothing
// at all past `LOD.cull`.
//
// --- what this file does not do ---------------------------------------------
//
// The 300 m corridor of cleared air and the pressure wave that arrives before
// COMMITTED does are both properties of the medium, and the medium is not mine.
// §10.1 leans on both. They belong in the cloud system.

import * as THREE from 'three';
import { CreatureView, LOD, FLESH, fleshMaterial } from '../creatures.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../../core/math.js';

// ---------------------------------------------------------------------------
// Proportions. All lengths are fractions of `bodyLength` so the same builder
// produces a correct animal if §10.1 ever changes the 240.
// ---------------------------------------------------------------------------

/**
 * Maximum body radius as a fraction of length.
 *
 * 0.088 puts the head 42 m across on a 240 m body — 17.5% of length, against a
 * sperm whale's 25%. Slimmer than the reference on purpose: the silhouette has
 * to stay unambiguously *long* when only a section of it is out of cloud, and a
 * stubbier body reads as a fish at the same distance.
 */
const MAX_RADIUS_FRAC = 0.088;

/**
 * Radius down the body, `[u, r/maxR]`, u = 0 at the tail tip and 1 at the nose.
 *
 * The widest point is at u = 0.88 — inside the head, not the chest. That is the
 * whole read: an enormous blunt melon trailing a long tapering body, so the
 * thing that arrives first is the biggest part of it. It also gives the voice
 * somewhere to live; §10.1's 24 Hz fundamental needs a resonator and a head this
 * size is the only structure on the animal that could be one.
 *
 * It does not come to a point at the nose — the drop happens in the last 3% of
 * the length, which is a blunt face with a heavy fillet rather than a taper. A
 * pointed nose is a torpedo and a torpedo is a machine.
 *
 * It does have to close to nearly nothing, though, and that is not a shape
 * choice, it is a lighting one. Ending at 0.42 left a disc 18 m across whose
 * normals all pointed the same way; under a low key it lit as one flat bright
 * ellipse on the front of the head, and during a call it grew — which is how the
 * blind animal ended up with what is unmistakably an eye (evidence/call3_swell
 * before this change). Closing to 0.13 makes that disc 5 m wide and the rounding
 * around it takes the light instead.
 */
const HULL_PROFILE = [
  [0.000, 0.000], [0.025, 0.070], [0.070, 0.120], [0.140, 0.200],
  [0.230, 0.330], [0.330, 0.480], [0.430, 0.620], [0.520, 0.730],
  [0.600, 0.790], [0.660, 0.775], [0.720, 0.860], [0.800, 0.960],
  [0.880, 1.000], [0.940, 0.965], [0.968, 0.885], [0.988, 0.680],
  // The nose closes to a rounded point rather than a face.
  //
  // This ended at 0.130 — a 5 m disc — and an adversarial pass found it still
  // reading as a hard-edged, perfectly round, pale spot on the side of the head:
  // AN EYE, on a creature whose defining trait is that it is acoustically blind.
  // Size was never the problem. A flat cap gets one forward normal from
  // computeVertexNormals and behaves like a mirror aimed at the key, so it is
  // brighter than anything else on the animal at any size the eye can resolve.
  // Closing to 0.02 makes the terminating fan degenerate — sub-pixel at every
  // distance the player will ever be at — so there is no facet left to catch a
  // highlight, and the last three entries carry the curvature that used to be
  // faked by the cap.
  [0.994, 0.400], [0.998, 0.170], [1.000, 0.020],
];

/**
 * Lateral scale, `[u, k]`. Multiplies the section's width.
 *
 * The tail stock is squeezed to 0.42 and the head widened to 1.06. Both are
 * doing the same job: a laterally compressed peduncle with horizontal flukes on
 * the end is the unmistakable signature of an animal that beats up and down
 * rather than side to side, and that one cue separates it from every fish shape
 * a player has ever seen.
 */
const LATERAL_PROFILE = [
  [0.000, 0.420], [0.100, 0.480], [0.250, 0.720], [0.450, 0.950],
  [0.650, 1.000], [0.850, 1.060], [1.000, 1.000],
];

/**
 * Vertical scale, `[u, k]`.
 *
 * The head is flattened to 0.72 — 45 m wide and 30 m tall. A broad wedge, which
 * is what something that displaces 300 m of vapour should look like from in
 * front, and which keeps the head reading as a *shape* rather than a ball from
 * every angle. Round heads photograph as circles and circles have no direction.
 */
const VERTICAL_PROFILE = [
  [0.000, 1.250], [0.100, 1.180], [0.250, 1.020], [0.450, 0.960],
  [0.650, 0.920], [0.820, 0.800], [0.940, 0.740], [1.000, 0.720],
];

/**
 * Dorsal crest height, as a fraction of the local radius.
 *
 * A ridge, not a fin. Its job is to break the top edge so the back is not a
 * clean arc — a clean arc at 3 km is a submarine.
 */
const CREST_PROFILE = [
  [0.000, 0.00], [0.120, 0.05], [0.350, 0.16], [0.550, 0.20],
  [0.720, 0.12], [0.880, 0.04], [1.000, 0.00],
];

/** Belly flattening. Cetacean-flat underside; a fully round body reads inflated. */
const BELLY_FLATTEN = 0.84;

/**
 * Circumferential muscle banding: how many bands along the body, and how deep.
 *
 * This is the single change that made the animal read as *big* rather than as a
 * small smooth object at an unknown distance. A perfectly smooth surface carries
 * no scale information at all — the first captures produced a 240 m creature that
 * looked like a 6 m one, because there was nothing on it whose size the eye
 * already knows. Fifteen bands over 240 m puts a feature every 16 m: far too
 * fine to count, coarse enough to shade, and the eye reads "many small things,
 * therefore large".
 *
 * The amplitude is 2.2% of the local radius — about 40 cm. That is below a pixel
 * at every distance the player sees one from; what is visible is the *normal*
 * tilting by ~9 degrees each way, which is a soft banding in the shading and
 * nothing in the outline. Deeper and it becomes corrugated pipe.
 *
 * There are 5.9 hull rings per band. Fewer than about four and the bands alias
 * into a moire that crawls as the animal flexes.
 */
const BAND_COUNT = 15;
const BAND_AMP = 0.014;

// --- the vanes (the ears) --------------------------------------------------

/**
 * Where the vane rows sit on the section, as an angle from the dorsal midline,
 * mirrored onto both flanks. Four rows in all.
 *
 * Two things were learned by capture here and both are worth keeping written
 * down, because both are the kind of mistake that looks fine in the code.
 *
 * *One:* a single row on each flank at the equator does not work. The fan opens
 * the blades **radially**, so an equatorial row opens horizontally, and
 * horizontal blades seen from broadside — which is how a level-swimming animal
 * is almost always seen — are edge-on and contribute nothing. The listening tell
 * was invisible from the one angle it most needed to work at. Rows spread around
 * the section fix that with no special casing, because a rotation about the body
 * axis carries a tangential blade to a radial one at *every* azimuth.
 *
 * *Two:* sixty-six thin blades in six rows read as a centipede. `lv_k_abovelisten`
 * is the animal from above with that arrangement fanned, and it is an arthropod
 * — regular, spiky, segmented, and completely wrong for something whose entire
 * job is to be a whale in the dark. Fewer and much larger is the fix: sixteen
 * membranous panels, folded flat enough to vanish at rest, that open into big
 * soft shapes. Panels read as tissue. Spikes read as chitin.
 */
/**
 * *Three:* two mid-flank rows are still not enough. `lv_m_listen` is the fanned
 * animal from broadside with rows at 0.85 and 1.85 rad, and it is *smoother*
 * than the cruising one — the panels went radial, radial at those azimuths is
 * sideways, and sideways is edge-on to a broadside camera. A row near the dorsal
 * midline and one near the ventral are what put panels above the back and below
 * the belly, which is the pair a level camera actually sees.
 */
const VANE_ROWS = [0.32, 1.05, 1.85, 2.60];
/** Per-row length scale. */
const VANE_ROW_SCALE = [0.85, 1.00, 0.95, 0.80];
/**
 * Which way each row folds: +1 lays the panel down away from the dorsal
 * midline, -1 lays it up toward it.
 *
 * The ventral row has to fold the other way or it wraps across the midline and
 * out onto the far flank, which produces a panel that is inside the animal.
 */
const VANE_ROW_FOLD = [1, 1, -1, -1];
/**
 * How far round the section a folded panel is allowed to wrap, in radians.
 *
 * 1.25 is 72°, so a panel folded flat covers a fifth of the circumference. The
 * cap matters twice: past about 1.5 a panel folding away from the dorsal midline
 * runs past the ventral one and comes up inside the far flank, and the wider the
 * arc the further the open angle has to swing to get the tip clear of the hull.
 */
const VANE_ARC_MAX = 1.25;
/** How many panels in each row. Eight rows of three is twenty-four. */
const VANE_COUNT = 3;
/** Where they start and stop along the body. Thorax only — not on the head. */
const VANE_SPAN_U = [0.28, 0.74];
/**
 * Panel reach outboard, fraction of body length.
 *
 * 0.095 is 23 m against a body about 40 m across, which measures as +63% on the
 * silhouette's depth when the panels open. That is the change §10.1 needs a
 * player to catch from the corner of their eye, and it is the only warning the
 * game gives that its hearing just tripled in range.
 */
const VANE_SPAN_FRAC = 0.095;
/** Root chord along the body, fraction of body length. */
const VANE_CHORD_FRAC = 0.085;
/**
 * Chord as a fraction of the root, along the span.
 *
 * A leaf, not a triangle: widest just off the root and rounded rather than
 * pointed at the tip. A straight taper to a point is a fin, and a fin on the
 * flank of a whale is a flipper, which is the wrong organ entirely.
 */
const VANE_CHORD_SHAPE = [1.00, 1.08, 0.96, 0.64, 0.20];
/**
 * How far a folded panel is held off the hull, in metres, per row.
 *
 * Different per row because the rows overlap when folded — that overlap is what
 * makes the closed animal read as covered in tissue rather than as a smooth
 * tube — and two coplanar surfaces at the same radius z-fight into a crawling
 * moire that is far more visible than either surface.
 */
const VANE_LIFT_M = [0.5, 1.1, 1.7, 2.3];

/**
 * How far open the panels are held while cruising, as a fraction of fully open.
 *
 * Not zero: flat-folded panels contribute nothing to the outline and the flank
 * goes smooth. 0.10 lifts them just proud of the hull so there is always a
 * broken edge to catch the key — the difference between "a whale" and "a whale
 * that is covered in something".
 *
 * The open angle itself is **per panel**, baked into the geometry, not a shared
 * number. It has to be: a panel folded along an arc of `arc` radians opens about
 * its own mid-arc tangent, not about the tangent at its hinge, so the rotation
 * that stands it up radially is `π/2 + arc/2` and every panel has a different
 * `arc`. Using one angle for all of them was measurably wrong — 1.45 rad for
 * everything opened the dorsal row *sideways*, and the whole listening tell
 * measured as a 14% change in silhouette depth (`ab3_cruise` vs `ab3_listen`)
 * when the geometry should have given far more than that.
 */
const VANE_OPEN_REST = 0.10;

// --- the flukes ------------------------------------------------------------

/** Fluke half-span, fraction of body length. 0.135 each side = 27% tip to tip. */
const FLUKE_SPAN_FRAC = 0.135;
/** Root chord, fraction of body length. */
const FLUKE_CHORD_FRAC = 0.085;
/** How far back the tips trail the root. Sweep is what stops it reading as a T. */
const FLUKE_SWEEP_FRAC = 0.055;

// --- the flex --------------------------------------------------------------

/**
 * Flex wavelength, as a multiple of body length.
 *
 * 0.85 — deliberately less than one. At wavelength >= body length every point on
 * the animal moves the same way at the same time and you have a wag, which at
 * 240 m is indistinguishable from the whole object being rotated. Below ~0.6 it
 * becomes an eel and loses the mass.
 */
const FLEX_WAVELENGTH_BODIES = 0.85;

/**
 * Peak flex amplitude at the tail, fraction of body length, vertical.
 *
 * 0.05 gives a 24 m peak-to-peak sweep at the fluke on a 240 m body — 10% of
 * length, which is the low end of the real cetacean range. Higher looks
 * energetic, and this animal is never energetic; even COMMITTED is 20 m/s, which
 * is 13% of the ship's cruise.
 */
const FLEX_AMP_FRAC = 0.05;
/** The quadrature lateral component, as a fraction of the vertical one. */
const FLEX_LATERAL_RATIO = 0.35;

/**
 * Tail-beat rate, Hz, at rest and the extra at COMMITTED speed.
 *
 * At UNAWARE (5 m/s) this is ~0.08 Hz — one beat every 12 seconds. That is not a
 * placeholder, it is what a 240 m body does: the animal covers roughly half its
 * own length per beat at every speed, which is the ratio real cetaceans hold.
 * Anything faster and the mass evaporates.
 */
const FLEX_HZ_BASE = 0.050;
const FLEX_HZ_PER_SPEED = 0.12;
/** The speed the "per speed" term is normalised against — §10.1 COMMITTED. */
const FLEX_SPEED_REF = 20;

/**
 * Bank, radians per rad/s of turn rate, and the cap.
 *
 * §10.1's turn radius is 3 body lengths, so the fastest it can ever turn is
 * 20 / 720 = 0.028 rad/s; the gain puts that at the 0.30 rad (17°) cap. The bank
 * is the only cue the player has that a 240 m animal is turning at all — the
 * heading change itself is far too slow to see.
 */
const BANK_GAIN = 10.0;
const BANK_MAX = 0.30;
/** Seconds for the bank to reach a new target. It has enormous rotational inertia. */
const BANK_TAU = 4.0;

// --- materials -------------------------------------------------------------

/**
 * Flat self-colour, far below the framework default of 0.22.
 *
 * The framework's `emissive` term exists so a silhouette is not pure black, and
 * it is uniform over the whole surface — which fills the shadow side in and
 * flattens the animal into a decal. Almost all of that job is done better below
 * by `RIM_*`, which puts the same light only where it is actually needed. What
 * is left here is a floor, so the darkest facet is not identically zero.
 */
const RIM_INTENSITY = 0.05;

/**
 * The grazing-angle rim: colour, strength, and falloff exponent.
 *
 * This is the answer to the one measurement that mattered. `ab_empty.png` /
 * `ab_cruise.png` are the same frame with and without a 240 m animal in the
 * middle of it, against clear dark sky with no cloud behind: **the largest
 * difference any pixel showed was 3 out of 255.** Not "hard to see" — not there.
 *
 * Nothing about albedo can fix that, because the problem is a dark object in
 * front of an equally dark background: raising it far enough to separate would
 * blow the lit flank out. What separates them is an *edge*, and an edge is what
 * a wet dark body actually produces — at grazing angles a surface reflects
 * almost everything, so a whale's outline in poor light is a thin bright line
 * while its middle stays black. There is no environment map here to reflect, so
 * the term is faked: cold, weak, and raised to a high power so it lives in the
 * last few degrees before the silhouette and nowhere else.
 *
 * The colour is the framework's `FLESH.rim`, unchanged. The exponent is what
 * keeps this honest — drop it below about 2.5 and the rim creeps inward across
 * the flank and the animal starts to glow, which is the one thing this creature
 * may never do.
 */
const RIM_COLOR = FLESH.rim;
const RIM_STRENGTH = 0.55;
const RIM_POWER = 3.0;

/**
 * Hull albedo, lifted from FLESH.hull (0x0b0d10).
 *
 * This is the one place this body knowingly departs from the framework palette
 * and it is a measurement, not a preference. At FLESH.hull the lit flank of the
 * animal rendered at a mean luminance of 25/255 against a background of 24.5 —
 * three quarters of one percent of contrast. `evidence/lv_b_broadside.png` is a
 * 240 m creature dead centre of frame and completely invisible; the shape only
 * appeared once there was bright cloud directly behind it.
 *
 * "Dark, matte, low contrast" is the rule and this still is all three: 0x1a2029
 * is a 10% grey and reads unambiguously as a black animal. What it is not is
 * *zero*, and the brief asks for "an edge, a flank, a sense of continuation" —
 * none of which exist on a body with no albedo, because a silhouette with no
 * interior cannot continue past anything.
 */
const HULL_COLOR = 0x1a2029;

/**
 * Roughness, below FLESH.roughness (0.94).
 *
 * A fully matte body against dark cloud is a flat cutout: nothing tells you
 * where its back is. 0.78 is still matte, but it is wet-matte — the luminaries
 * lay a broad soft sheen along the top of the flank, which is the only thing in
 * frame that says the surface is curved. It is the same cue that makes a whale
 * surfacing at night legible, and there is no cheaper one available to something
 * that is not allowed to glow.
 */
const HULL_ROUGHNESS = 0.78;

// --- level of detail --------------------------------------------------------

/** Rings x radials for the detailed hull, and for the silhouette hull. */
const NEAR_RINGS = 88, NEAR_RADIALS = 22;
const FAR_RINGS = 28, FAR_RADIALS = 12;

/**
 * At LOD.far the animal subtends about 3 degrees. The flex there is subpixel, so
 * the uniform block stops being written every frame. Uniform uploads are cheap
 * but they are not free and there is no picture to pay for.
 */
const FAR_UNIFORM_EVERY = 6;

// ---------------------------------------------------------------------------
// Shared shader source.
//
// Both meshes run the identical deformation. It lives in one string precisely so
// the hull and the vanes cannot drift apart — a vane flexing on a slightly
// different curve to the flank it is attached to detaches visibly, and that is
// the failure mode of doing this twice.
//
// `aFlesh` packs everything per-vertex the deformation needs:
//   .xy  the hinge point of the panel this vertex belongs to, in section space
//   .z   this panel's fully-open angle in radians, signed; 0 = not a panel
//   .w   how much this vertex participates in the call swell, 0..1
// ---------------------------------------------------------------------------

const FLEX_PARS = /* glsl */`
attribute vec4 aFlesh;
uniform vec2  uFlexAmp;    // (lateral, vertical) metres at the tail
uniform float uFlexK;      // radians per metre along the body
uniform float uFlexPhase;
uniform float uHalfLen;
uniform float uOpen;       // panel fan, 0 = folded flat, 1 = fully out
uniform float uCall;       // 0..1 swell envelope

// Lateral+vertical offset of the body axis at body-space z.
vec2 vwFlex(float z) {
  // 0 at the tail, 1 at the nose.
  float u = clamp((z + uHalfLen) / (2.0 * uHalfLen), 0.0, 1.0);
  // The head barely moves and the tail moves most. The 0.04 floor is not
  // decoration: with a hard zero at the nose the animal pivots about its own
  // face, which looks like it is bolted to something.
  float a = 0.04 + 0.96 * pow(1.0 - u, 1.7);
  float ph = uFlexK * z + uFlexPhase;
  return vec2(uFlexAmp.x * a * cos(ph), uFlexAmp.y * a * sin(ph));
}

// Rotate a vertex about the vane hinge, then swell, then flex.
vec3 vwDeform(vec3 p, vec4 f) {
  if (f.z != 0.0) {
    float a = uOpen * f.z;
    vec2 r = p.xy - f.xy;
    float c = cos(a), s = sin(a);
    p.xy = f.xy + vec2(c * r.x - s * r.y, s * r.x + c * r.y);
  }
  if (f.w > 0.0) {
    // A dilation of the section, not a push along a direction.
    //
    // The first version added a fixed number of metres along normalize(p.xy),
    // and it turned the animal's face inside out (evidence/call2_swell.png):
    // near the axis that direction is undefined, so the fallback fired for
    // every vertex on the nose cap, and a 10 m push on a rim only 9 m from the
    // axis inverted the
    // blunt head into a cup. Scaling cannot invert anything, and it is also what
    // an inflating organ actually does — the whole section grows.
    p.xy *= 1.0 + uCall * f.w * 0.45;
  }
  p.xy += vwFlex(p.z);
  return p;
}

// The matching normal transform.
//
// The flex is a shear x,y = f(z), whose Jacobian inverse-transpose leaves x and y
// alone and adds -f'.n to z. Doing this analytically rather than recomputing
// normals on the CPU is the whole reason the animation is free at range.
vec3 vwDeformNormal(vec3 n, vec3 p, vec4 f) {
  if (f.z != 0.0) {
    float a = uOpen * f.z;
    float c = cos(a), s = sin(a);
    n.xy = vec2(c * n.x - s * n.y, s * n.x + c * n.y);
  }
  float h = 2.0;
  vec2 d = (vwFlex(p.z + h) - vwFlex(p.z - h)) / (2.0 * h);
  n.z -= d.x * n.x + d.y * n.y;
  return normalize(n);
}
`;

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

/** Linear lookup into a `[u, value]` keypoint table. */
function sampleProfile(table, u) {
  if (u <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (u >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [u1, v1] = table[i];
    if (u > u1) continue;
    const [u0, v0] = table[i - 1];
    const t = (u - u0) / (u1 - u0);
    // Smoothstep between keypoints, not linear: a linear profile leaves a
    // visible crease at every keypoint once the specular sheen is on it.
    return lerp(v0, v1, t * t * (3 - 2 * t));
  }
  return last[1];
}

/** How much of the call swell a point at (u, theta) takes. */
function callWeight(u, cosT) {
  // The throat pleats: ventral, behind the jaw.
  const throat = smoothstep(0.66, 0.76, u) * (1 - smoothstep(0.93, 0.99, u))
    * Math.pow(Math.max(0, -cosT), 1.2);
  // The melon itself: the whole front of the head, all round. Faded out again
  // over the last 4% so the cap does not grow faster than the rings behind it
  // and open the face into a trumpet.
  const melon = 0.7 * smoothstep(0.83, 0.93, u) * (1 - smoothstep(0.96, 1.0, u));
  return clamp01(throat + melon);
}

/**
 * One point on the body surface.
 * @param {number} u 0 tail .. 1 nose
 * @param {number} theta 0 dorsal, PI ventral
 * @param {number} maxR
 */
function surfacePoint(u, theta, maxR, out) {
  const r = sampleProfile(HULL_PROFILE, u) * maxR;
  const lat = sampleProfile(LATERAL_PROFILE, u);
  const vert = sampleProfile(VERTICAL_PROFILE, u);
  const crest = sampleProfile(CREST_PROFILE, u);
  const s = Math.sin(theta), c = Math.cos(theta);

  // Pleats. Shallow longitudinal grooves over the throat only, so the call swell
  // has something to open rather than just scaling a smooth surface up.
  const pleat = 1 + 0.035 * Math.sin(9 * theta)
    * smoothstep(0.62, 0.72, u) * (1 - smoothstep(0.93, 1.0, u))
    * Math.max(0, -c);

  // Muscle banding. Faded off the head and the tail tip, where the profile is
  // already doing the work and a band would read as a joint.
  //
  // Two incommensurate frequencies and an azimuthal skew, not one clean ring.
  // With a single sine at 2.2% the bands lined up into a row of identical bright
  // rectangles down the flank and the animal read as a hull with portholes in it
  // (`lv_o_close.png`) — periodic, planar and manufactured, which is the exact
  // opposite of what a scale cue is for. The golden ratio between the two
  // frequencies means the pattern never repeats along the body, and the sin(θ)
  // term makes each band wander around the section instead of sitting in a
  // plane, so no two of them are the same shape.
  const bandPhase = u * BAND_COUNT * TAU;
  const band = 1 + BAND_AMP * (
      0.65 * Math.sin(bandPhase + 0.55 * s)
    + 0.35 * Math.sin(bandPhase * 1.618 + 2.1))
    * smoothstep(0.06, 0.20, u) * (1 - smoothstep(0.70, 0.86, u));

  out.x = s * r * lat * pleat * band;
  out.y = c * r * vert * pleat * band * (c < 0 ? BELLY_FLATTEN : 1);
  out.y += crest * r * Math.pow(Math.max(0, c), 6);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The hull: a closed tube from the tail tip to the blunt face.
 *
 * Built as an open cylinder plus two centre fans. Rings are distributed with a
 * slight bias toward the head, where the profile changes fastest — an even
 * distribution spends most of its rings on the near-conical tail, which does not
 * need them, and facets the melon, which does.
 */
function buildHull(L, rings, radials) {
  const maxR = L * MAX_RADIUS_FRAC;
  const half = L / 2;
  const pos = [], nrm = [], fle = [], idx = [];
  const p = { x: 0, y: 0 };

  const us = new Array(rings);
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    us[i] = Math.pow(t, 0.86);
  }

  for (let i = 0; i < rings; i++) {
    const u = us[i];
    const z = -half + u * L;
    for (let j = 0; j < radials; j++) {
      const th = (j / radials) * TAU;
      surfacePoint(u, th, maxR, p);
      pos.push(p.x, p.y, z);
      nrm.push(0, 0, 0);
      fle.push(0, 0, 0, callWeight(u, Math.cos(th)));
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radials; j++) {
      const a = i * radials + j;
      const b = i * radials + ((j + 1) % radials);
      idx.push(a, b, a + radials, b, b + radials, a + radials);
    }
  }

  // Caps. The nose one is domed forward, but barely: the first version domed it
  // by 3% of length over a face 24 m across and the result was a pale disc on
  // the front of the animal, brighter than anything else in frame
  // (`lv_i_close.png`), and then an eye once the call swell grew it. A near-flat
  // cap aimed at the key is a mirror. The fix is mostly in HULL_PROFILE — the
  // face is 5 m across now, not 24 — and this is just the last bit of rounding.
  const capNose = pos.length / 3;
  pos.push(0, 0, half + L * 0.006); nrm.push(0, 0, 0); fle.push(0, 0, 0, callWeight(1, 0));
  for (let j = 0; j < radials; j++) {
    const a = (rings - 1) * radials + j;
    const b = (rings - 1) * radials + ((j + 1) % radials);
    idx.push(a, capNose, b);
  }
  const capTail = pos.length / 3;
  pos.push(0, 0, -half); nrm.push(0, 0, 0); fle.push(0, 0, 0, 0);
  for (let j = 0; j < radials; j++) {
    idx.push(j, capTail, (j + 1) % radials);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFlesh', new THREE.Float32BufferAttribute(fle, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The appendages: flank vanes, dorsal keel and flukes, in one buffer.
 *
 * Flat, and drawn double-sided. Giving each vane a thickness would triple the
 * vertex count and buy nothing: at every distance the player will ever see one,
 * a 13 m blade is at most a few pixels thick.
 */
function buildAppendages(L) {
  const maxR = L * MAX_RADIUS_FRAC;
  const half = L / 2;
  const pos = [], nrm = [], fle = [], idx = [];
  const p = { x: 0, y: 0 };

  const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };

  // --- flank vanes ---------------------------------------------------------
  //
  // Built in the FOLDED pose — lying along the hull, tangential to the section —
  // because that is the rest state, and because the shader's fan is then a
  // single positive rotation about the hinge for every row on both flanks.
  // Building them spread and folding with a negative angle produces the same
  // picture but reads backwards in every debug print, and this is the part most
  // likely to be revisited.
  //
  // A blade tangential to a circle becomes radial after a quarter turn about the
  // centre, so one uniform opens all six rows correctly with no per-row terms.
  for (let row = 0; row < VANE_ROWS.length; row++) {
    const rowScale = VANE_ROW_SCALE[row];
    const foldDir = VANE_ROW_FOLD[row];
    const lift = VANE_LIFT_M[row];
    for (const side of [1, -1]) {
      const thetaS = side * VANE_ROWS[row];
      for (let k = 0; k < VANE_COUNT; k++) {
        const t = VANE_COUNT === 1 ? 0.5 : k / (VANE_COUNT - 1);
        // Rows are staggered along the body rather than aligned into columns.
        // Aligned, sixty-six blades read as a grid, and a grid reads as
        // manufactured; staggered they read as a covering.
        const stagger = (row / VANE_ROWS.length) / Math.max(VANE_COUNT - 1, 1);
        const u = clamp(lerp(VANE_SPAN_U[0], VANE_SPAN_U[1], t + stagger),
          VANE_SPAN_U[0], VANE_SPAN_U[1]);
        const z = -half + u * L;
        // Longest at mid-thorax, tapering fore and aft, so a row has a shape of
        // its own instead of reading as a comb.
        const span = L * VANE_SPAN_FRAC * rowScale * (0.62 + 0.38 * Math.sin(Math.PI * t));
        const chordRoot = L * VANE_CHORD_FRAC * (0.7 + 0.3 * Math.sin(Math.PI * t));

        surfacePoint(u, thetaS, maxR, p);
        const hx = p.x, hy = p.y;
        const rHinge = Math.max(Math.hypot(hx, hy), 1);
        // The folded panel is laid along the section arc, not along a straight
        // tangent. A straight 22 m panel off a 19 m radius stands 10 m clear of
        // the hull at the tip, which is why the closed animal was lumpy instead
        // of smooth. Following the arc makes "folded" mean flush, so the fan is
        // the whole of the change and not half of it.
        // Never wrap past the midline the panel is folding towards, or the tip
        // comes up inside the opposite flank.
        const room = (foldDir > 0 ? Math.PI - VANE_ROWS[row] : VANE_ROWS[row]) * 0.95;
        const arc = Math.min(span / rHinge, VANE_ARC_MAX, room);
        // The open angle, baked per panel. A folded panel is a chord of its own
        // arc, so its long axis lies along the tangent at the *mid* of the arc,
        // not at the hinge; standing it up radially therefore takes a quarter
        // turn plus half the arc. Getting this wrong does not look broken, it
        // just looks weak, which is why it survived a whole revision.
        const openAngle = side * foldDir * (Math.PI / 2 + arc / 2);
        const base = pos.length / 3;
        const SPAN_SEGS = VANE_CHORD_SHAPE.length - 1;
        for (let s = 0; s <= SPAN_SEGS; s++) {
          const f = s / SPAN_SEGS;
          surfacePoint(u, thetaS + side * foldDir * arc * f, maxR, p);
          const rp = Math.max(Math.hypot(p.x, p.y), 1e-3);
          const ox = p.x * (1 + lift / rp), oy = p.y * (1 + lift / rp);
          const chord = chordRoot * VANE_CHORD_SHAPE[s];
          // Swept back along the body as it goes out — a panel square to the
          // body reads as a fin, and these are not for swimming.
          const zc = z - span * f * 0.22;
          pos.push(ox, oy, zc - chord * 0.5); nrm.push(ox, oy, 0); fle.push(hx, hy, openAngle, 0);
          pos.push(ox, oy, zc + chord * 0.5); nrm.push(ox, oy, 0); fle.push(hx, hy, openAngle, 0);
        }
        for (let s = 0; s < SPAN_SEGS; s++) {
          const a = base + s * 2;
          quad(a, a + 1, a + 3, a + 2);
        }
      }
    }
  }

  // --- dorsal keel ---------------------------------------------------------
  //
  // Low and long, not a dorsal fin. It exists so the top edge of the silhouette
  // has a length to it: at 3 km the back is one or two pixels of variation and
  // this is what those pixels are.
  {
    const base = pos.length / 3;
    const SEGS = 18;
    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS;
      const u = lerp(0.24, 0.74, t);
      const z = -half + u * L;
      surfacePoint(u, 0, maxR, p);
      const h = L * 0.030 * Math.sin(Math.PI * Math.pow(t, 0.8));
      pos.push(0, p.y - 0.5, z); nrm.push(0, 0, 1); fle.push(0, 0, 0, 0);
      pos.push(0, p.y + h, z);   nrm.push(0, 0, 1); fle.push(0, 0, 0, 0);
    }
    for (let s = 0; s < SEGS; s++) {
      const a = base + s * 2;
      quad(a, a + 1, a + 3, a + 2);
    }
  }

  // --- flukes --------------------------------------------------------------
  //
  // Horizontal, swept, and thin at the tip. They are inside the flex like
  // everything else, and because their leading and trailing edges sit at
  // different z they pick up a pitch angle from the wave automatically — which
  // is exactly how a real fluke generates thrust, and it costs nothing here.
  {
    const uRoot = 0.075;
    const zRoot = -half + uRoot * L;
    const span = L * FLUKE_SPAN_FRAC;
    const chordRoot = L * FLUKE_CHORD_FRAC;
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const SEGS = 4;
      for (let s = 0; s <= SEGS; s++) {
        const f = s / SEGS;
        const x = side * span * f;
        // A little upward curl at the tips. Flat flukes read as a plank.
        const y = L * 0.012 * f * f;
        const zc = zRoot - L * FLUKE_SWEEP_FRAC * f;
        const chord = chordRoot * (1 - 0.78 * f);
        pos.push(x, y, zc - chord * 0.55); nrm.push(0, 1, 0); fle.push(0, 0, 0, 0);
        pos.push(x, y, zc + chord * 0.45); nrm.push(0, 1, 0); fle.push(0, 0, 0, 0);
      }
      for (let s = 0; s < SEGS; s++) {
        const a = base + s * 2;
        quad(a, a + 1, a + 3, a + 2);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFlesh', new THREE.Float32BufferAttribute(fle, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export class ListenerView extends CreatureView {
  constructor(creature, opts = {}) {
    super(creature, opts);
    this.object3D.name = 'listener';

    /** Roll lives on a child so the base class can own `object3D.rotation.y`. */
    this.body = new THREE.Group();
    this.object3D.add(this.body);

    this._uniforms = {
      uRimColor: { value: new THREE.Color(RIM_COLOR) },
      uRimStrength: { value: RIM_STRENGTH },
      uRimPower: { value: RIM_POWER },
      uFlexAmp: { value: new THREE.Vector2(0, 0) },
      uFlexK: { value: 0 },
      uFlexPhase: { value: 0 },
      uHalfLen: { value: 1 },
      uOpen: { value: VANE_OPEN_REST },
      uCall: { value: 0 },
    };

    this._phase = 0;
    this._t = 0;
    this._bank = 0;
    this._prevHeading = null;
    this._call = 0;      // swell envelope, 0..1
    this._listen = 0;    // fan envelope, 0..1
    this._frame = 0;
    this._skipped = 0;   // dt banked while throttled at LOD.far
  }

  build() {
    const L = this.creature.bodyLength || 240;
    this._uniforms.uHalfLen.value = L / 2;
    this._uniforms.uFlexK.value = TAU / (L * FLEX_WAVELENGTH_BODIES);

    const hook = (m) => {
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this._uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${FLEX_PARS}`)
          .replace('#include <beginnormal_vertex>',
            '#include <beginnormal_vertex>\nobjectNormal = vwDeformNormal(objectNormal, position, aFlesh);')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\ntransformed = vwDeform(transformed, aFlesh);');
        // `normal` and `vViewPosition` are both live by the time
        // <emissivemap_fragment> runs; injecting any earlier gets the geometric
        // normal instead of the shaded one and the rim detaches from the
        // silhouette on the banded flank.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
uniform vec3 uRimColor; uniform float uRimStrength; uniform float uRimPower;`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float f = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
  totalEmissiveRadiance += uRimColor * (pow(f, uRimPower) * uRimStrength);
}`);
      };
      // Every Listener runs the identical program and differs only in uniforms.
      // Without this each view compiles its own copy of a standard shader.
      m.customProgramCacheKey = () => 'veilwake/listener-flex';
      return m;
    };

    this.matHull = hook(fleshMaterial({
      color: HULL_COLOR,
      roughness: HULL_ROUGHNESS,
      emissiveIntensity: RIM_INTENSITY,
    }));
    this.matFin = hook(fleshMaterial({
      color: HULL_COLOR,
      roughness: HULL_ROUGHNESS,
      emissiveIntensity: RIM_INTENSITY,
      side: THREE.DoubleSide,
    }));

    this.gNear = buildHull(L, NEAR_RINGS, NEAR_RADIALS);
    this.gFar = buildHull(L, FAR_RINGS, FAR_RADIALS);
    this.gFin = buildAppendages(L);
    // The rest pose does not include the flex, the fan or the swell, all of
    // which move vertices outward. Without the pad the animal pops out of
    // existence at the frame the fan opens near the edge of the screen.
    for (const g of [this.gNear, this.gFar, this.gFin]) {
      g.computeBoundingSphere();
      g.boundingSphere.radius *= 1.25;
    }

    this.meshNear = new THREE.Mesh(this.gNear, this.matHull);
    this.meshFar = new THREE.Mesh(this.gFar, this.matHull);
    this.meshFin = new THREE.Mesh(this.gFin, this.matFin);
    this.meshFar.visible = false;
    this.body.add(this.meshNear, this.meshFar, this.meshFin);

    this._built = true;
  }

  /**
   * @param {number} dt
   * @param {number} d distance to camera
   * @param {object} ctx
   */
  step(dt, d, ctx) {
    const c = this.creature;
    const L = c.bodyLength || 240;
    const u = this._uniforms;
    this._frame++;

    // --- LOD -----------------------------------------------------------------
    const far = this.lodLevel === 'far';
    if (this.meshFar.visible !== far) {
      this.meshFar.visible = far;
      this.meshNear.visible = !far;
      this.meshFin.visible = !far;
    }

    // At range the picture does not change; stop paying for it. Everything below
    // is a handful of floats, but "a handful" times however many of these are
    // alive times 120 Hz is a real number and there is nothing on screen to show
    // for it — at LOD.far a 240 m body subtends about 3 degrees and the flex is
    // subpixel. The skipped dt is carried rather than dropped, so the envelopes
    // and the flex phase stay on the same clock as the simulation; dropping it
    // would make a distant animal beat its tail six times too slowly, which is
    // visible precisely when it crosses back into LOD.mid.
    this._skipped += dt;
    if (far && (this._frame % FAR_UNIFORM_EVERY) !== 0) return;
    dt = this._skipped;
    this._skipped = 0;
    this._t += dt;

    // --- the envelopes -------------------------------------------------------
    //
    // §10.1: calls "swell rather than start", 6–11 s long. A 2.6 s rise reaches
    // 90% about a third of the way into the shortest call, so the swell is still
    // arriving when the sound is; a switch here would make the head snap.
    const wantCall = c.callActive ? 1 : 0;
    this._call += clamp(wantCall - this._call, -dt / 1.8, dt / 2.6);
    // The fan is slower still. It is a 240 m animal moving thirty structures the
    // size of a house; snapping them open is the one thing that would make the
    // most important tell in the game look like a UI element.
    const wantListen = c.listening ? 1 : 0;
    this._listen += clamp(wantListen - this._listen, -dt / 2.5, dt / 3.5);

    // Smoothstepped, then throbbed.
    //
    // The throb is what makes the call *readable*. A static swell measured as a
    // 7% change in the head's projected area (`call_quiet` vs `call_swell`) and
    // a player has no before-picture to compare it against — nobody notices that
    // something they have been looking at for ten seconds is slightly larger.
    // Motion they notice. 0.6 Hz is not the 24 Hz fundamental, which is far too
    // fast to see and would strobe; it is the animal working, at a rate a body
    // that size could plausibly work at.
    const env = this._call * this._call * (3 - 2 * this._call);
    u.uCall.value = env * (0.82 + 0.18 * Math.sin(this._t * TAU * 0.6));

    // Speed folds the vanes independently of listening: something closing at
    // 20 m/s has its ears down, and the player can read the difference between
    // "it is hunting" and "it is listening" from the outline alone.
    const speed = c.speed ?? 0;
    const streamline = clamp01(speed / FLEX_SPEED_REF);
    const rest = lerp(VANE_OPEN_REST, 0.0, streamline);
    u.uOpen.value = lerp(rest, 1.0, this._listen);

    // --- the flex ------------------------------------------------------------
    //
    // Amplitude follows speed, not time, so §10.1's "it does not move" during a
    // listening window is literally true on screen: the sim brings speed to zero
    // over `stopSeconds`, and the body stops flexing on exactly that curve
    // without this file knowing anything about the schedule.
    const moving = clamp01(speed / 2);
    const amp = L * FLEX_AMP_FRAC * moving;
    u.uFlexAmp.value.set(amp * FLEX_LATERAL_RATIO, amp);

    const hz = (FLEX_HZ_BASE + FLEX_HZ_PER_SPEED * (speed / FLEX_SPEED_REF)) * moving;
    this._phase = (this._phase + TAU * hz * dt) % TAU;
    u.uFlexPhase.value = this._phase;

    // --- the bank ------------------------------------------------------------
    if (typeof c.heading === 'number') {
      if (this._prevHeading === null) this._prevHeading = c.heading;
      let dh = c.heading - this._prevHeading;
      if (dh > Math.PI) dh -= TAU; else if (dh < -Math.PI) dh += TAU;
      this._prevHeading = c.heading;
      const omega = dt > 1e-5 ? dh / dt : 0;
      // Heading increases toward +X, which is the animal's left; banking into a
      // left turn drops the +X side, which is a negative rotation about +Z.
      const want = clamp(-BANK_GAIN * omega, -BANK_MAX, BANK_MAX);
      this._bank += (want - this._bank) * clamp01(dt / BANK_TAU);
      this.body.rotation.z = this._bank;
    }
  }

  dispose() {
    super.dispose();
    for (const g of [this.gNear, this.gFar, this.gFin]) if (g) g.dispose();
    for (const m of [this.matHull, this.matFin]) if (m) m.dispose();
  }
}

/** Everything a capture or a test might want to assert against. */
export const LISTENER_BODY = {
  MAX_RADIUS_FRAC,
  VANE_COUNT,
  VANE_ROWS,
  VANE_OPEN_REST,
  VANE_ARC_MAX,
  FLEX_WAVELENGTH_BODIES,
  FLEX_AMP_FRAC,
  RIM_INTENSITY,
  RIM_STRENGTH,
  RIM_POWER,
  HULL_COLOR,
  HULL_ROUGHNESS,
  BAND_COUNT,
  NEAR_RINGS, NEAR_RADIALS, FAR_RINGS, FAR_RADIALS,
  LOD,
  FLESH,
};

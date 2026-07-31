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
// the tell here is rendered rather than simulated: faint streaks of sheared
// vapour streaming past the animal along its flight axis, reaching further ahead
// of the nose than the body is long.
//
// It is driven by speed, which is the honest coupling — speed is what writes the
// trail in §3.3 and speed is what stirs the air — so a drifting pack has almost
// no tell and a committed one arrives inside a disturbance the player can see
// first. That is §10.3's escalation table's last row, "turbulence arriving
// before they do", drawn instead of described.
//
// **The streaks write depth, and they have to.** This was measured, not assumed.
// The cloud march is bounded by the scene depth buffer, so geometry that writes
// no depth lets the ray run to the far plane, accumulate a full column of cloud,
// and composite over the top of it: an additive mesh with `depthWrite: false` is
// invisible in any direction that has cloud in it, which is every direction. A
// capture at seven times the intended opacity showed nothing at all, and the same
// mesh made opaque showed up immediately — see `evidence/wh_c_tellboost` against
// `evidence/wh_d_telldebug`.
//
// Writing depth costs one artefact, stated rather than hidden: the march stops at
// a streak, so the cloud *behind* it is not accumulated and the streak's pixels
// lose whatever the background was contributing. That is why the ribbons are
// filaments a metre or two across rather than sheets — the artefact is then a
// few pixels wide and reads as shear, which is what it is meant to look like —
// and why `alphaTest` is set: without it the faded-out ends of every ribbon
// would still write depth and cut invisible slots in the cloud.
//
// The honest fix is for the disturbance to be density in the volume rather than
// geometry in front of it, and that belongs to `clouds.js`, not here.
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
   * How far the streaks reach ahead of and behind the nose, in body lengths.
   *
   * §10.3's turbulence field is 200 m in radius. 1.9 L ahead is 105 m, so the
   * disturbance genuinely arrives before the animal at roughly the scale the
   * contract states, and it sits inside the field rather than pretending to be
   * all of it. Reaching much further ahead than this starts to look like the
   * streaks are a separate object flying in formation with the creature.
   */
  tellAheadBodies: 1.9,
  tellBehindBodies: 2.6,
  /** Radius of the sheared tube at the nose and at its tail, in body lengths. */
  tellRadiusBodies: [0.20, 0.44],

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
   * Distances between which the tell fades out entirely, metres.
   *
   * This exists to undo a cheat rather than to save time. Because the streaks
   * write depth they are *not* subject to the atmospheric perspective that
   * buries everything else: the march stops at them, so a filament two
   * kilometres away arrives with almost none of the haze that should have eaten
   * it, and against a lit mass it reads as a hard dark dash — see
   * `evidence/wh_t_mid_zoom`, where the animals themselves are correctly reduced
   * to silhouettes and their streaks are still crisp. Fading them by range is
   * the shortest honest way to put back the falloff the depth write removed.
   *
   * The numbers are the archetype's own scale: §10.3's turbulence field is 200 m
   * in radius, so a disturbance that has stopped being legible by fourteen of
   * those is not losing the player anything they were meant to have.
   */
  tellFadeRangeM: [500, 1400],
  /**
   * Peak alpha of one streak, and how wide one is in metres.
   *
   * The alpha lives in the vertex colours rather than in `material.opacity`
   * because the material has an `alphaTest` and the test has to see the strength:
   * fading a ribbon out through the material would leave every vertex above the
   * test threshold and keep cutting depth long after the streak stopped being
   * visible.
   *
   * 0.11 additive of a colour around 0.5 is a brightening of about 0.06 in
   * linear light. The first pass ran three times that and the streaks read as
   * lit structure rather than as air; the background here is 0.003–0.02, so a
   * little goes a very long way. 0.55 m across, on a 55 m animal, is a filament —
   * the whole reason it is not a sheet is in the header.
   */
  tellAlpha: 0.20,
  tellWidthM: 1.6,
  /**
   * Fallback linear RGB for the streaks, used only when there is no sky to ask.
   *
   * Normally the tint is *derived*, from `clouds.sky.haze` — the colour the far
   * field of the medium already is. Authoring it here instead would be authoring
   * the light twice, which is the failure `sky.js` was written to end: a fixed
   * cold tint measured khaki against an indigo-only sky in `evidence/wh_g_hero4`
   * because it was additive light of a colour nothing in the world was emitting.
   * Disturbed vapour is lit by whatever is up, the same as undisturbed vapour.
   */
  tellTint: [0.50, 0.64, 1.00],

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
 * The tell: how many filaments, how many stations along one, and how many
 * vertices across it.
 *
 * Five across, and both earlier answers were wrong in a way worth recording.
 * Two across rasterised as a bar with hard parallel edges of uniform brightness
 * — `evidence/wh_e_hero2` looks like scaffolding. Three across, at half a metre
 * wide, became a hard one-pixel line: `evidence/wh_f_hero3` looks like hairs on
 * the lens. Vapour needs *width with a soft edge*, which is five vertices
 * carrying a bell of alpha across a filament wide enough to cover several
 * pixels at the range it matters.
 *
 * Everything about this shape is forced by the depth problem in the header: a
 * broad soft shape would be the obvious way to draw disturbed air and it is
 * unavailable, because a broad shape that writes depth deletes a broad patch of
 * the cloud behind it. Narrow and soft is the only thing left.
 */
const TELL_RIBBONS = 16;
const TELL_STATIONS = 7;
const TELL_ACROSS = 5;
/** Where the five sit across the filament, and how much alpha each carries. */
const TELL_SPAN = [-1, -0.44, 0, 0.44, 1];
const TELL_FALLOFF = [0, 0.55, 1, 0.55, 0];

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

/**
 * One Wake Hunter, drawn.
 *
 * Three meshes at most, and only one of them at range:
 *   body   — spine, fins, caudal and filaments in a single buffer, one draw call
 *   tell   — the sheared vapour; gone past `tellFadeRangeM`, so in practice near
 *            and the first couple of hundred metres of mid
 *   eyes   — two quads, near only
 *
 * Measured, seven members: 23 draw calls and 7,732 triangles with every one of
 * them inside 1,200 m, against budgets of 120 and 400,000. At 2.3 km the same
 * pack is 9 calls and 1,992 triangles.
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
    this._tellScroll = 0;
    this._deformTick = 0;
    this._lastLod = null;
    this._tellAllowed = false;
    this._camDist = 0;
    this._tintAt = 0;
    this._tint = Float32Array.from(WAKE_HUNTER_VIEW.tellTint);

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
   * The tell: streaks of sheared vapour on the flight axis.
   *
   * Nine ribbons on a cone around the axis, each covering a fraction of the
   * span and sliding aft. Tangential rather than radial width, so the ones at
   * the top and bottom of the tube present their faces to a camera watching from
   * the flank — which is the angle this creature is supposed to be seen from.
   */
  _buildTell() {
    const idx = [];
    const verts = TELL_RIBBONS * TELL_STATIONS * TELL_ACROSS;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 4);   // RGBA: the alpha is the fade
    for (let k = 0; k < TELL_RIBBONS; k++) {
      const base = k * TELL_STATIONS * TELL_ACROSS;
      for (let n = 0; n < TELL_STATIONS - 1; n++) {
        const a = base + n * TELL_ACROSS, b = base + (n + 1) * TELL_ACROSS;
        for (let e = 0; e < TELL_ACROSS - 1; e++) {
          idx.push(a + e, b + e, a + e + 1);
          idx.push(a + e + 1, b + e, b + e + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    const p = new THREE.BufferAttribute(pos, 3); p.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.BufferAttribute(col, 4); c.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', p);
    g.setAttribute('color', c);
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, -this.L * 0.4), this.L * 3.0);

    // Additive, so this brightens the vapour rather than being a surface in it,
    // and depth-writing, because the cloud march is bounded by the depth buffer
    // and anything that does not write depth is composited away. See the header.
    // `alphaTest` keeps the faded ends from writing depth they cannot pay for.
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff,             // the tint lives in the vertex colours
      vertexColors: true,
      transparent: true,
      opacity: 1,                  // strength is in the vertex alpha, not here
      alphaTest: 0.02,
      blending: THREE.AdditiveBlending,
      depthWrite: true,
      side: THREE.DoubleSide,
      // Three draws a transparent double-sided material twice — back faces then
      // front — so that it sorts correctly. Measured: a pack of seven cost 37
      // draw calls instead of 23 and reported double the triangles. Additive
      // blending is order-independent by construction, so the second pass buys
      // nothing and costs a draw call per animal.
      forceSinglePass: true,
      toneMapped: true,
    });
    m.userData.owned = true;       // per-view, so `dispose()` may free it

    this._tellGeo = g;
    this._tellPos = p;
    this._tellCol = c;
    this._tell = new THREE.Mesh(g, m);
    this._tell.renderOrder = 1;    // after the body, so it never sorts in front
    this._tell.frustumCulled = true;
    // Off until something has decided how strong it is. The buffers are still
    // zeroed at this point and a zeroed ribbon is a degenerate quad at the nose.
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

    // Ask the sky what colour the medium is, twice a second. Cheap, and it means
    // the tell shifts when the luminaries do, exactly like the vapour it is
    // supposed to be part of.
    this._tintAt -= dt;
    if (this._tintAt <= 0) { this._tintAt = 0.5; this._readTint(ctx); }

    // Deform rate by LOD. At `far` the body is a couple of dozen pixels across
    // and the wave is sub-pixel, so it is frozen entirely — which is most of the
    // point of having a far LOD for something there are seven of.
    this._deformTick++;
    if (lod === 'far') return;
    if (lod === 'mid' && (this._deformTick & 1)) return;
    this._deform(dt);
  }

  /**
   * The colour of the tell, taken from the medium rather than authored.
   *
   * `sky.haze` is the far-field colour of the vapour under the luminaries that
   * are currently up. Normalised to a peak of one, because the *hue* is what is
   * wanted here — how bright a streak gets is `tellAlpha`'s decision, and the
   * haze is a hundredth of unity so using it directly would draw nothing.
   */
  _readTint(ctx) {
    const sky = ctx && ctx.clouds && ctx.clouds.sky;
    const h = sky && sky.haze;
    if (!h) return;
    const peak = Math.max(h.x, h.y, h.z);
    if (!(peak > 0)) return;
    this._tint[0] = h.x / peak; this._tint[1] = h.y / peak; this._tint[2] = h.z / peak;
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
    if (this._tellAllowed) this._updateTell(dt, drive);
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
   * The streaks. Positions and alphas both, because a ribbon that only changes
   * opacity does not read as something moving past.
   */
  _updateTell(dt, drive) {
    const L = this.L;
    const [s0, s1] = WAKE_HUNTER_VIEW.tellSpeedRange;
    const [f0, f1] = WAKE_HUNTER_VIEW.tellFadeRangeM;
    const strength = clamp01(((this.creature.speed || 0) - s0) / Math.max(s1 - s0, 1))
      * (1 - clamp01((this._camDist - f0) / Math.max(f1 - f0, 1)));
    // Below the alpha test nothing survives rasterisation, so there is no point
    // moving 180 vertices to produce a mesh that discards every fragment.
    this._tell.visible = strength * WAKE_HUNTER_VIEW.tellAlpha > 0.02;
    if (!this._tell.visible) return;

    const zA = L * WAKE_HUNTER_VIEW.tellAheadBodies;
    const zB = -L * WAKE_HUNTER_VIEW.tellBehindBodies;
    const [r0, r1] = WAKE_HUNTER_VIEW.tellRadiusBodies;
    // Aft-streaming rate. Fast: the medium is not being pushed along with the
    // animal, it is being left behind by it, and a slow scroll makes the streaks
    // look attached instead of passed through.
    this._tellScroll += dt * (0.20 + 0.85 * drive);

    const p = this._tellPos.array;
    const col = this._tellCol.array;
    const tint = this._tint;
    for (let k = 0; k < TELL_RIBBONS; k++) {
      const hk = memberHash(k + this.creature.packIndex * 31);
      // Golden-ratio spacing around the axis so twelve filaments never line up
      // into a visible fan, plus a slow drift so the whole sleeve churns.
      const th0 = k * 2.39996 + this._tellScroll * (0.5 + hk);
      // Every filament sits at its own radius and is its own length. Uniform
      // ones produced a cylinder, and a cylinder seen from the flank is two
      // parallel arcs — which is exactly what the first capture showed.
      // Radius and length per filament. Both hug the animal much more closely
      // than the first pass did: filaments scattered out to two-thirds of a body
      // length read as unrelated debris in the sky rather than as this thing's
      // wake, and the sheath has to be legibly *attached* to what is inside it.
      const rf = 0.35 + hk * 1.10;
      const rib = 0.07 + hk * 0.09;
      let start = (k / TELL_RIBBONS + this._tellScroll * (0.8 + hk * 0.5)) % 1;
      if (start < 0) start += 1;
      start = start * (1 + rib) - rib;   // enters ahead, leaves behind
      for (let n = 0; n < TELL_STATIONS; n++) {
        const local = n / (TELL_STATIONS - 1);
        const u = clamp01(start + local * rib);
        const z = lerp(zA, zB, u);
        // Radius wobbles along the filament, so it snakes rather than lying on
        // a cone. Turbulence that runs in straight lines is not turbulence.
        const wob = 1 + 0.22 * Math.sin(u * 9.0 + hk * 12.0)
                      + 0.11 * Math.sin(u * 21.0 - hk * 7.0);
        const rad = L * lerp(r0, r1, u) * rf * wob;
        const th = th0 + u * (1.1 + hk * 1.6);
        // Width in metres, not radians. Angular width made the far end of every
        // filament a thirty-metre sheet, and a sheet that writes depth cuts a
        // sheet-sized hole in the cloud behind it. See the header.
        const dth = WAKE_HUNTER_VIEW.tellWidthM / Math.max(rad, 1);
        // Fades to nothing at both its own ends and both ends of the span, so a
        // filament that wraps round to the front does it while invisible.
        //
        // Cubed, not squared. The exponent decides how much of a filament sits
        // above the alpha test and therefore how much of it writes depth, and
        // depth is what cuts the cloud behind it: `evidence/wh_l_turn` has one
        // filament crossing a lit mass and it reads there as a hard dark bar,
        // because it deleted a bright background and replaced it with a dim
        // additive line. A sharper fade shortens that bar to something that
        // reads as a tatter instead of as an artefact. It cannot remove it.
        const a = Math.sin(Math.PI * local) * Math.sin(Math.PI * u);
        const alpha = a * a * a * strength * WAKE_HUNTER_VIEW.tellAlpha;
        const i = (k * TELL_STATIONS + n) * TELL_ACROSS;
        for (let e = 0; e < TELL_ACROSS; e++) {
          const t = th + TELL_SPAN[e] * dth;
          const o = (i + e) * 3;
          p[o] = Math.cos(t) * rad;
          p[o + 1] = Math.sin(t) * rad;
          p[o + 2] = z;
          const q = (i + e) * 4;
          // Cold, and barely coloured: this is vapour catching whatever is up,
          // not a light of the creature's own. The outer pair carry no alpha at
          // all — that soft edge is what makes a filament instead of a bar.
          col[q] = tint[0]; col[q + 1] = tint[1]; col[q + 2] = tint[2];
          col[q + 3] = alpha * TELL_FALLOFF[e];
        }
      }
    }
    this._tellPos.needsUpdate = true;
    this._tellCol.needsUpdate = true;
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

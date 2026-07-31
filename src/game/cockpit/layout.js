// The cockpit's dimensions, in ship space, in metres.
//
// One table, because every other file in this folder is derived from it — the
// shell geometry, the frame ribs, the instrument placement AND the analytic
// shadow the frame casts on the interior all read the same numbers. The last of
// those is the reason this file exists separately: a shadow computed from
// constants pasted into a shader is a shadow that stops matching the geometry
// the first time anyone moves a rib, and this project has already been bitten
// four times by a constant that was copied instead of derived.
//
// --- the frame of reference -------------------------------------------------
//
// Ship space. +X right, +Y up, -Z forward. The camera eye sits at
// CAMERA_DEFAULTS.eye = [0, 0.55, 1.9] and is *spring* attached; this geometry
// is *rigidly* attached. That difference is the whole point. When the ship
// snaps, the frame snaps and the eye arrives late, and the frame moving against
// a still world is what a heavy machine looks like from inside.
//
// Everything is expressed against `d`, the distance ahead of the eye:
//
//     d = EYE[2] - z
//
// so d = 0 is the eye's own plane and d grows toward the nose. The interior is a
// flared octagonal tube: snug at the eye, opening toward the canopy mouth.
//
// --- why the profile is a line, and why its slope is what it is -------------
//
// At the base 62 degree vertical FOV and 16:9, half the frame subtends
// tan(31 deg) = 0.6009 vertically and 1.0683 horizontally per metre of d. A tube
// whose radius grows at exactly that rate is a cone with its apex at the eye,
// and a cone with its apex at the eye projects to a *single fixed outline* — the
// whole interior collapses edge-on into a hard border with no visible surface
// and no depth. That is the trap, and it is not obvious until it is drawn.
//
// So the slopes below are deliberately shallower than the frustum. The wall
// starts outside the view, crosses into it around d = 0.95 and eats 15% of the
// frame by the mouth: a surface that recedes, catches light along its length and
// gives the darkness a near-field to be dark against.

/** The camera eye in ship space. Must match CAMERA_DEFAULTS.eye in camera.js. */
export const EYE = [0, 0.55, 1.9];

/** Frustum half-extent per metre of depth, at the base FOV. Layout maths only. */
export const TAN_Y = 0.6009;   // tan(62/2 deg)
export const TAN_X = 1.0683;   // tan_y * 16/9

export const LAYOUT = {
  /**
   * Interior half-extents as `a + b * d`.
   *
   * `a` is the size at the pilot's own plane — shoulder, head and knee room, and
   * it is small on purpose. `b` is the flare. Compare each `b` against the
   * frustum slope above to read off how much of the frame that surface takes:
   * b / TAN is the fraction of the half-frame it occupies once it is in view.
   */
  //
  // The third coefficient is a quadratic, and it is not cosmetic. With a purely
  // linear profile every lengthwise segment of a facet has the *same* slope, so
  // all five are coplanar, so they share one normal and the sun paints the whole
  // wall a single flat value — measured, an unbroken band at 95 to 100 running
  // the length of the frame. A gentle curve gives each segment its own normal
  // and the wall gets a gradient along it, which is the difference between a
  // formed surface and a painted strip. Kept small: the envelope at the mouth is
  // within 2 cm of the straight version, so nothing about the occlusion changes.
  wall: [0.640, 0.360, 0.045],   // outer 11.5% each side at the mouth
  roof: [0.400, 0.190, 0.030],   // top 7%
  deck: [0.380, 0.145, 0.026],   // bottom 18%

  /**
   * Octagon corner cut. The cross-section is eight facets rather than four so
   * that *some* facet always faces the sun: as the ship rolls, the bright one
   * walks around the ring instead of the whole interior switching on and off.
   *
   * These are also the single largest lever on how much of the frame the
   * cockpit eats, and the one it is easiest to be wrong about. Measured against
   * a bare frame at the reference poses, the first pass covered 53% of the
   * image while the arithmetic in openFraction() — which treated the aperture
   * as a rectangle — claimed 27%. The chamfers were removing a quarter of the
   * frame that nobody had counted. Opened from 0.60/0.30, which is why the
   * corners now read as chamfers rather than as a porthole.
   */
  cornerX: 0.74,
  cornerY: 0.20,

  /** Ring positions along d. The tail two are behind the pilot. */
  sections: [-0.70, -0.28, 0.00, 0.42, 0.84, 1.20],

  /** The mouth, and the lip that flares out past it. The lip's inner face turns
   *  to look forward, so it is the one part of the frame that catches light
   *  coming straight in — a bright ring around a dark aperture. */
  mouth: 1.20,
  lip: { d: 1.36, scale: 1.10 },

  /**
   * Hull thickness: how far a second, backing shell sits outside the first.
   *
   * This is the fix for the see-through corners, and the reason it is a
   * *thickness* rather than a bigger octagon needs stating, because "scale the
   * shell up until the gap closes" is the obvious wrong answer and it does not
   * work here.
   *
   * The shell is a single-sided surface of zero thickness, and the camera's near
   * plane is 0.5 m (`camera.near`, set in main.js and not ours to move). The
   * interior comes closer than that: `deckAt(0)` is 0.380 and `roofAt(0)` is
   * 0.400, both measured from the eye. Any facet nearer than 0.5 m is clipped
   * away by the near plane, and because the tube is convex there is exactly one
   * surface along any ray out of the eye — so when that one is clipped, nothing
   * is left and the ray reaches the sky. Measured with a raycast that models the
   * near plane: **1423 of 6000 directions on the sphere from the eye (24%) are
   * unsealed**, and they enter an 80 degree frustum as soon as the eye displaces
   * about 0.25 m laterally or 0.20 m vertically.
   *
   * That displacement is reachable. Instrumented over 30 s of hard flight with
   * real turbulence, boost and braking, the eye travels up to 0.172 m laterally,
   * 0.104 m vertically and 1.006 m forward of its design position, and the view
   * rotates up to 7 degrees against the hull.
   *
   * A backing shell removes the whole class: whatever the near plane cuts away,
   * there is a second opaque surface behind it. The number is then a clearance
   * budget rather than a taste:
   *
   *     nearest interior (0.380) + thickness - worst eye excursion (0.18)
   *         >= near plane (0.5) + margin
   *
   * At 0.38 the backing deck sits 0.760 m from the design eye and 0.580 m from
   * the worst measured one, clearing the near plane by 0.08 m. Making it smaller
   * eats that margin; making it larger costs nothing visually — the backing
   * shell is outside the inner one in every direction, so it is occluded by it
   * except in the sliver where the near plane has removed the inner one — but it
   * is triangles, so it does not grow for free.
   */
  hullThickness: 0.38,

  /**
   * Ring frames standing proud of the shell.
   *
   * These are what make the light do something. A bare aperture casts one soft
   * edge; ribs cut it into bands that sweep down the interior as the ship turns,
   * which is the difference between "the cockpit is lit" and "something outside
   * is moving past the window".
   */
  // Three, not two. With two, a sun raking in at 50 degrees put an unbroken pale
  // band down the whole visible length of the wall — measured at 92 to 101 in
  // display units against a p50 of 6 for the rest of the frame, which reads as a
  // strip of plastic rather than as light coming in. A third ring cuts it into
  // bands whose spacing changes with the angle, and structure crossing a lit
  // surface is what tells the eye the light is arriving through something.
  ribs: [
    { d: 0.96, depth: 0.080, halfWidth: 0.045 },
    { d: 0.60, depth: 0.070, halfWidth: 0.040 },
    { d: 0.30, depth: 0.055, halfWidth: 0.036 },
  ],

  /**
   * Instrument pods, split left and right with a low well between them.
   *
   * One centred binnacle would be the obvious build and it puts the tallest
   * object in the frame directly under the horizon. Two pods keep the centre at
   * the deck line and push the only bright things in the cockpit into the lower
   * corners, where the eye finds them without them being in the way.
   */
  pod: {
    faceFwdY: 0.158, faceFwdZ: 0.96,   // upper, further edge
    faceAftY: 0.045, faceAftZ: 1.12,   // lower, nearer edge
    baseY: -0.02,
    inner: 0.135, outer: 0.615,
  },
  /**
   * The low centre well between the pods.
   *
   * It used to be "two lamps and nothing else", which wasted the one piece of
   * panel that is directly under the pilot's line of sight and never in front of
   * anything. It now carries the signature cluster — the six channels the whole
   * game is actually played on — because that readout has to be glanceable
   * continuously and must never be somewhere the eye has to leave the window to
   * find. Widened from 0.125 to fit six columns at a legible pitch; still below
   * the deck line, so nothing about the occlusion changes.
   */
  well: { halfWidth: 0.215, topY: 0.105, fwdZ: 0.965, aftZ: 1.15, baseY: -0.02 },

  /**
   * Fasteners on the ring frames.
   *
   * Two per facet per rib, on the aft face — the one the pilot sees. They are
   * flat quads rather than modelled heads: at this distance a bolt is four
   * pixels, and four pixels of geometry costs 12 triangles to say exactly what
   * four pixels of a slightly brighter, much shinier quad says for two. What
   * they are for is scale — a surface with a repeating small feature on it reads
   * as fabricated and as a known size, and the same surface without one reads as
   * an untextured plane at an unknown distance.
   */
  fastener: { size: 0.017, inset: 0.055, lift: 0.0035 },

  /**
   * Cable runs along the two upper chamfer seams.
   *
   * A real small aircraft routes its looms along a structural corner, because
   * that is where there is room behind the trim. Putting them anywhere else
   * reads as decoration; putting them here reads as the reason the corner is
   * shaped like that. They also give the eye a line to follow from the pilot out
   * to the mouth, which is the depth cue the interior was missing.
   */
  conduit: { radius: 0.024, offset: 0.030, dFrom: -0.62, dTo: 1.16 },

  /** Where the instrument glow is treated as coming from, for the light it
   *  throws back onto the panel. Between the two pods, just above the deck. */
  glow: [0, 0.10, 1.05],
};

// ---------------------------------------------------------------------------
// Derived profile
// ---------------------------------------------------------------------------

const prof = (p, d) => p[0] + p[1] * d + (p[2] || 0) * d * d;

/** Interior half-width at depth d. Floored so the tail does not pinch shut. */
export function wallAt(d) { return Math.max(0.30, prof(LAYOUT.wall, d)); }
/** Interior height above the eye at depth d. */
export function roofAt(d) { return Math.max(0.22, prof(LAYOUT.roof, d)); }
/** Interior depth below the eye at depth d. */
export function deckAt(d) { return Math.max(0.22, prof(LAYOUT.deck, d)); }

/**
 * The eight cross-section points at depth d, as [x, y] in ship space.
 *
 * Counter-clockwise seen from behind (from the pilot, looking forward), which is
 * the winding buildShell relies on to get inward-facing normals.
 */
export function section(d, shrink = 0, scale = 1) {
  const W = wallAt(d) * scale - shrink;
  const T = roofAt(d) * scale - shrink;
  const B = deckAt(d) * scale - shrink;
  const cx = LAYOUT.cornerX, cy = LAYOUT.cornerY;
  const ey = EYE[1];
  return [
    [ W,      ey + T * cy],
    [ W * cx, ey + T],
    [-W * cx, ey + T],
    [-W,      ey + T * cy],
    [-W,      ey - B * cy],
    [-W * cx, ey - B],
    [ W * cx, ey - B],
    [ W,      ey - B * cy],
  ];
}

/** Ship-space z for a depth d. */
export const zAt = (d) => EYE[2] - d;

/**
 * The backing shell's cross-section at depth d.
 *
 * A negative shrink, which is to say the interior grown outward by the hull
 * thickness. Derived here rather than written out at the call site so that the
 * seal and the surface it backs cannot drift apart — the same discipline
 * apertures() uses for the shadow.
 */
export function outerSection(d, scale = 1) {
  return section(d, -LAYOUT.hullThickness, scale);
}

/**
 * How close the shell comes to a given eye, inner surface and backing shell.
 *
 * This is the seal's acceptance test in one number, and it is here rather than
 * in the test file because it is derived from the same table the geometry is.
 * `backing` must stay above `camera.near` (0.5) for every eye the camera can
 * reach, or the near plane will cut a hole in the cockpit. See `hullThickness`.
 *
 * Sampled rather than solved: the profile is quadratic and the cross-section is
 * an octagon, so the true minimum is a piecewise thing with no closed form worth
 * the risk of getting subtly wrong.
 *
 * It measures to the octagon's *edges*, not its vertices. The first version used
 * vertices and reported the inner surface at 0.583 m when the deck facet is
 * directly under the eye at 0.380 — the closest point on a facet is almost never
 * a corner of it, and for a clearance an over-report is the dangerous direction
 * to be wrong in, because it says "sealed" about a hole.
 */
export function clearance(eye = EYE) {
  // Distance from (px, py) to the segment (ax, ay)-(bx, by).
  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  };
  let inner = Infinity, backing = Infinity;
  for (let d = LAYOUT.sections[0]; d <= LAYOUT.mouth + 1e-6; d += 0.01) {
    const dz = zAt(d) - eye[2];
    const a = section(d), b = outerSection(d);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) & 7;
      inner = Math.min(inner, Math.hypot(
        segDist(eye[0], eye[1], a[i][0], a[i][1], a[j][0], a[j][1]), dz));
      backing = Math.min(backing, Math.hypot(
        segDist(eye[0], eye[1], b[i][0], b[i][1], b[j][0], b[j][1]), dz));
    }
  }
  return { inner: +inner.toFixed(4), backing: +backing.toFixed(4) };
}

// ---------------------------------------------------------------------------
// The apertures light has to pass through
// ---------------------------------------------------------------------------

/**
 * The frame, reduced to what a shadow needs to know: a stack of rectangular
 * holes at fixed z, ordered from the pilot outward.
 *
 * A point inside the tube is lit by the sun only if the ray from it to the sun
 * clears *every* one of these that lies ahead of it. That is exactly true for a
 * convex tube and near enough for this one; the approximation is the corner cut,
 * where a rectangle is used for an octagon and the shadow is a few centimetres
 * generous at four corners.
 *
 * Derived, never typed: change a rib and the shadow moves with it.
 */
export function apertures() {
  const list = [];
  const rect = (d, shrink) => {
    const W = wallAt(d) - shrink;
    const T = roofAt(d) - shrink;
    const B = deckAt(d) - shrink;
    return { z: zAt(d), w: W, yb: EYE[1] - B, yt: EYE[1] + T };
  };
  // Mouth first — it is the furthest forward and the widest.
  list.push(rect(LAYOUT.mouth, 0));
  for (const r of LAYOUT.ribs) list.push(rect(r.d, r.depth));
  // Nearest-first, so the cheap early-out (`is this ring ahead of me at all`)
  // rejects in the order the ray meets them.
  list.sort((a, b) => b.z - a.z);
  return list;
}

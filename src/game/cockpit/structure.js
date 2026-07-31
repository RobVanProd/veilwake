// The cockpit's structure, built once.
//
// A flared octagonal tube with the pilot at the narrow end, two ring frames
// standing proud of its inner surface, a flared lip at the mouth, and two
// instrument pods flanking a low centre well.
//
// Two things here are load-bearing and neither is obvious from a screenshot.
//
// **Eight facets, not four.** A box interior has four normals, so the sun either
// lights a wall or it does not, and the interior switches state as the ship
// rolls. Eight facets means the lit one *walks* around the ring — the light
// crawls across the inside of the canopy as the machine turns, which is the
// single strongest thing a cockpit can do for both awe and claustrophobia, and
// it costs sixteen triangles.
//
// **The centre stays open.** Everything that occludes is pushed to an edge: the
// wall takes the outer 15%, the roof 8%, the deck 11%, and the only thing that
// rises above the deck line is a pair of pods in the lower corners. Roughly 63%
// of the frame is clear glass, and none of what is not is in front of the
// horizon.

import { Surf } from './builder.js';
import { LAYOUT, EYE, section, outerSection, zAt, wallAt, roofAt, deckAt } from './layout.js';

/**
 * Albedos, linear.
 *
 * Dark, cold, and close together — all the contrast in here is supposed to come
 * from the light, not from the paint. The absolute level is set by one measured
 * constraint rather than by taste:
 *
 * The palette's sun is [2.55, 2.20, 1.55] and the composite runs at exposure
 * 0.78 through ACES. A Lambert facet turned fully into it reads at roughly
 * `sRGB(ACES(0.78 * albedo * 2.55))` — so albedo 0.12 lands near 200/255 and
 * albedo 0.045 near 110. Measured, the first pass used 0.082–0.118 and the four
 * corner facets came back as a bone-white X across the frame corners, brighter
 * than most of the cloud behind them. That is the failure the art direction
 * names: the frame has to be the dark thing the world is bright against, so the
 * ceiling on a fully lit facet is around 110 and these numbers are what puts it
 * there.
 *
 * The consequence is deliberate and worth stating: lit only by this world's
 * ambient, an interior this dark is *black*. The palette's sky is nearly black
 * and a painted surface has none of a cloud's albedo or multiple scattering to
 * make up the difference. What gives the cockpit shape when the sun is gone is
 * therefore the instruments, which is exactly where that light is supposed to
 * come from.
 */
/*
 * Every one of these is cold — blue above red — including the surfaces the
 * instruments light. That is not a preference, it is a measured requirement.
 *
 * The first pass painted the deck, the lower corner facets and the pods warm
 * "because the panel lights them", and tools/mood.js caught it: at the away
 * pose, coldShadowSep went from +13.2 without the cockpit to **-4.3** with it.
 * The metric's rule is that light is warmer than shadow, and the cockpit had
 * inverted it — because the cockpit *is* the darkest quartile of a frame it
 * covers a third of, and warm paint plus a warm panel glow made the shadows of
 * the whole image read amber. That is the exact failure the palette pass spent
 * itself removing, re-introduced from the near field.
 *
 * The warmth the panel is supposed to own comes from the glow term and from the
 * instruments themselves, which is where warmth is allowed to be information.
 * The paint stays cold and lets them be the event.
 */
const C = {
  hull:  [0.046, 0.052, 0.062],   // the flat side walls, a cold slate
  roof:  [0.032, 0.037, 0.047],   // overhead: nothing up there to see by
  deck:  [0.052, 0.056, 0.064],   // underfoot, and where the glow lands
  diagT: [0.034, 0.039, 0.049],   // upper corner facets — the ones that blew out
  diagB: [0.046, 0.050, 0.058],   // lower corner facets catch the panel glow
  frame: [0.058, 0.063, 0.072],   // ribs — machined, and the only sheen in here
  lip:   [0.032, 0.037, 0.047],   // the mouth: read as silhouette, not as surface
  pod:   [0.042, 0.046, 0.054],
  tail:  [0.020, 0.023, 0.030],
  /**
   * The backing shell.
   *
   * Darker than anything else in here, and that is a decision rather than an
   * oversight. This surface is only ever seen through a gap the near plane has
   * just cut in the surface in front of it — a sliver a few pixels wide at the
   * edge of the frame. If it were painted the same value as the hull it would
   * read as a lit edge appearing out of nowhere as the ship manoeuvres, which is
   * a worse artefact than the hole it is replacing. Near black, it reads as more
   * hull, which is what it is.
   */
  back:  [0.014, 0.016, 0.021],
  /** Fastener heads: the one place bare metal is allowed to show. */
  bolt:  [0.086, 0.091, 0.101],
  /** Cable looms. Rubberised, so darker than the frame and with no sheen. */
  cable: [0.028, 0.030, 0.035],
};

/**
 * Facet-indexed albedo for the shell.
 *
 * The octagon's segments, counted the way section() emits them: 1 is the flat
 * roof, 5 the flat deck, 3 and 7 the side walls, 0 and 2 the upper diagonals,
 * 4 and 6 the lower. Getting this mapping wrong is invisible in a wireframe and
 * obvious in a capture — the first version painted segment 2 as roof, which put
 * the roof's albedo on the upper-left corner and left the upper-right bright.
 */
function shellColor(i) {
  switch (i) {
    case 1: return C.roof;
    case 5: return C.deck;
    case 3: case 7: return C.hull;
    case 0: case 2: return C.diagT;
    default: return C.diagB;
  }
}

export function buildStructure() {
  const s = new Surf();
  const S = LAYOUT.sections;

  // --- the tube ------------------------------------------------------------
  for (let i = 0; i < S.length - 1; i++) {
    const dA = S[i], dB = S[i + 1];
    s.ring(section(dA), zAt(dA), section(dB), zAt(dB), shellColor, 1, 0.03);
  }

  // --- the backing shell ---------------------------------------------------
  //
  // The seal. See LAYOUT.hullThickness for the measurement that sets its size;
  // what matters here is the winding, which is the part that is easy to get
  // wrong and impossible to see in a wireframe.
  //
  // It is wound *inward*, exactly like the surface it backs — not outward as a
  // real hull's outer skin would be. That is deliberate. An outward-wound skin
  // is back-facing from inside the cockpit, so FrontSide culls it and it seals
  // nothing; the one and only job of this surface is to be visible from the
  // pilot's seat in the sliver where the near plane has removed the inner
  // surface, and for that it has to face the pilot. It is a backing, not a hull.
  //
  // Depth does the rest: it is farther away than the surface it backs in every
  // direction, so whenever that surface survives the near plane it occludes this
  // one completely and this costs nothing but the fill it never wins.
  for (let i = 0; i < S.length - 1; i++) {
    const dA = S[i], dB = S[i + 1];
    s.ring(outerSection(dA), zAt(dA), outerSection(dB), zAt(dB), C.back, 1, 0);
  }

  // Close the sandwich at both ends, so there is no ray that can enter the gap
  // between the two shells from behind and come out the other side. Neither of
  // these is ever visible in a normal frame; they exist so that "watertight" is
  // a property of the mesh rather than a claim about which way people look.
  {
    const dT = S[0], dM = LAYOUT.mouth;
    // Aft: an annulus from the backing shell in to the inner tail cap.
    s.annulus(outerSection(dT), section(dT), zAt(dT), -1, C.back, 1, 0);
    // Forward: the mouth rim, the visible thickness of the canopy frame.
    s.annulus(outerSection(dM), section(dM), zAt(dM), +1, C.back, 1, 0.10);
  }

  // --- the mouth lip -------------------------------------------------------
  // Flares outward rather than inward. A lip that turns in is the obvious build
  // and it is wrong twice: it becomes the narrowest cross-section, so it and not
  // the mouth decides how much of the frame is blocked, and its inner face ends
  // up looking back at the pilot where no light can reach it. Flared, it is the
  // one surface in the cockpit whose normal has a forward component, so it is
  // the one that lights up when the ship turns into something.
  {
    const dM = LAYOUT.mouth, dL = LAYOUT.lip.d;
    s.ring(section(dM), zAt(dM), section(dL, 0, LAYOUT.lip.scale), zAt(dL), C.lip, 1, 0.40);
  }

  // --- ring frames ---------------------------------------------------------
  // Each is an aft-facing annulus (the face the pilot sees), a short inner tube,
  // and a forward-facing annulus (the face the light hits). The aft face is what
  // catches the panel glow; the forward face is what interrupts the sun.
  for (const r of LAYOUT.ribs) {
    const dA = r.d - r.halfWidth, dF = r.d + r.halfWidth;
    s.annulus(section(dA), section(dA, r.depth), zAt(dA), +1, C.frame, 1, 0.24);
    s.ring(section(dA, r.depth), zAt(dA), section(dF, r.depth), zAt(dF), C.frame, 1, 0.30);
    s.annulus(section(dF), section(dF, r.depth), zAt(dF), -1, C.frame, 1, 0.24);
  }

  // --- fasteners -----------------------------------------------------------
  //
  // Two per facet on each rib's aft face — the face turned back toward the
  // pilot, which is the one the panel glow actually reaches and therefore the
  // only one where a small bright mark will ever be seen.
  //
  // They are lifted off the face along +z rather than modelled proud of it. A
  // modelled head is twelve triangles to produce a silhouette that is under a
  // pixel across at this distance; a lifted quad with the frame's sheen turned
  // up is two triangles and is indistinguishable in every capture taken of it.
  // The lift has to be there — coplanar with the annulus it z-fights, and a
  // z-fighting bolt flickers, which draws far more attention than the bolt is
  // worth.
  {
    const F = LAYOUT.fastener;
    for (const r of LAYOUT.ribs) {
      const dA = r.d - r.halfWidth;
      const z = zAt(dA) + F.lift;
      const outer = section(dA), inner = section(dA, r.depth);
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) & 7;
        for (const t of [0.28, 0.72]) {
          // Midway across the annulus, so the head sits on metal rather than
          // hanging over either edge of it.
          const ox = outer[i][0] + (outer[j][0] - outer[i][0]) * t;
          const oy = outer[i][1] + (outer[j][1] - outer[i][1]) * t;
          const ix = inner[i][0] + (inner[j][0] - inner[i][0]) * t;
          const iy = inner[i][1] + (inner[j][1] - inner[i][1]) * t;
          const cx = ox + (ix - ox) * 0.5, cy = oy + (iy - oy) * 0.5;
          const h = F.size * 0.5;
          s.quad([cx - h, cy - h, z], [cx + h, cy - h, z],
                 [cx + h, cy + h, z], [cx - h, cy + h, z], C.bolt, 1, 0.85);
        }
      }
    }
  }

  // --- cable runs ----------------------------------------------------------
  //
  // Along the two upper chamfer seams, from behind the pilot out to the mouth.
  // Built as a square section rather than a round one: four sides give four
  // distinct normals, so the loom picks up the sweeping canopy light along its
  // length the same way the shell does, and a round tube of this diameter would
  // need eight sides to do it and would still read as square at four pixels.
  {
    const K = LAYOUT.conduit;
    const ey = EYE[1];
    // Section indices 1 and 2 are the two upper roof-to-chamfer seams — the
    // structural corners, which is where a real loom is routed because it is the
    // only place with room behind the trim.
    for (const idx of [1, 2]) {
      const at = (d) => {
        const p = section(d)[idx];
        // Push in toward the tube's axis so the loom stands proud of the seam
        // instead of being buried in it.
        const vx = 0 - p[0], vy = ey - p[1];
        const len = Math.hypot(vx, vy) || 1;
        return [p[0] + (vx / len) * K.offset, p[1] + (vy / len) * K.offset, zAt(d)];
      };
      const steps = 5;
      for (let k = 0; k < steps; k++) {
        const dA = K.dFrom + (K.dTo - K.dFrom) * (k / steps);
        const dB = K.dFrom + (K.dTo - K.dFrom) * ((k + 1) / steps);
        const a = at(dA), b = at(dB), r = K.radius;
        s.hexa([
          [b[0] - r, b[1] - r, b[2]], [b[0] + r, b[1] - r, b[2]],
          [b[0] + r, b[1] + r, b[2]], [b[0] - r, b[1] + r, b[2]],
          [a[0] - r, a[1] - r, a[2]], [a[0] + r, a[1] - r, a[2]],
          [a[0] + r, a[1] + r, a[2]], [a[0] - r, a[1] + r, a[2]],
        ], C.cable, 1, 0.06);
      }
    }
  }

  // --- the tail ------------------------------------------------------------
  // Behind the pilot and never in shot at rest. It exists so that a camera which
  // has lagged behind a hard stop is looking at a bulkhead rather than at the
  // sky through the back of the ship.
  {
    const dT = LAYOUT.sections[0];
    s.cap(section(dT), zAt(dT), -1, C.tail, 1, 0);
  }

  // --- instrument pods -----------------------------------------------------
  const p = LAYOUT.pod;
  for (const sign of [-1, 1]) {
    const a = sign * p.inner, b = sign * p.outer;
    const x0 = Math.min(a, b), x1 = Math.max(a, b);
    s.hexa([
      [x0, p.baseY, p.faceFwdZ], [x1, p.baseY, p.faceFwdZ],
      [x1, p.faceFwdY, p.faceFwdZ], [x0, p.faceFwdY, p.faceFwdZ],
      [x0, p.baseY, p.faceAftZ], [x1, p.baseY, p.faceAftZ],
      [x1, p.faceAftY, p.faceAftZ], [x0, p.faceAftY, p.faceAftZ],
    ], C.pod, 1, 0.16);
  }

  // --- the centre well -----------------------------------------------------
  // Low on purpose. Whatever sits between the pods is directly under the
  // horizon, so it holds two lamps and nothing that needs reading.
  {
    const w = LAYOUT.well;
    s.hexa([
      [-w.halfWidth, w.baseY, w.fwdZ], [w.halfWidth, w.baseY, w.fwdZ],
      [w.halfWidth, w.topY, w.fwdZ], [-w.halfWidth, w.topY, w.fwdZ],
      [-w.halfWidth, w.baseY, w.aftZ], [w.halfWidth, w.baseY, w.aftZ],
      [w.halfWidth, w.topY * 0.35, w.aftZ], [-w.halfWidth, w.topY * 0.35, w.aftZ],
    ], C.pod, 1, 0.14);
  }

  // --- coaming rail --------------------------------------------------------
  // A thin beam running along the top of the deck facet on each side, from the
  // pods out to the mouth. It is the closest hard edge to the eye and the only
  // thing in here with a length the eye can follow into the distance, which is
  // what gives the near field a scale.
  //
  // Honest limitation: it does **not** cast. The shadow model in materials.js is
  // a stack of rectangular apertures at fixed z (see layout.js apertures()), and
  // this rail is neither at a fixed z nor an aperture. It was built expecting to
  // throw a bar up the deck as the ship pitches and it does not, and the deck's
  // moving shadow edge comes entirely from the mouth and the ring frames. Adding
  // it would mean a second caster form — an oblique slab — in the generated
  // GLSL, which is a real change rather than a constant.
  for (const sign of [-1, 1]) {
    const dA = 0.86, dB = LAYOUT.mouth;
    const rail = (d) => {
      const w = wallAt(d) * LAYOUT.cornerX;
      const y = EYE[1] - deckAt(d);
      return { x: sign * w * 0.98, y, z: zAt(d) };
    };
    const a = rail(dA), b = rail(dB);
    const t = 0.032, h = 0.036;
    s.hexa([
      [b.x - t, b.y, b.z], [b.x + t, b.y, b.z], [b.x + t, b.y + h, b.z], [b.x - t, b.y + h, b.z],
      [a.x - t, a.y, a.z], [a.x + t, a.y, a.z], [a.x + t, a.y + h, a.z], [a.x - t, a.y + h, a.z],
    ], C.frame, 1, 0.28);
  }

  return s;
}

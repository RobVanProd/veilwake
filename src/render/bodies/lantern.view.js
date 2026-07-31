// The Lantern's body. Contract §10.2.
//
//   import { LanternView } from './render/bodies/lantern.view.js';
//   views.register('Lantern', (c, o) => new LanternView(c, o));
//
// Ninety metres of animal behind a ring of nine to twenty lights spread over as
// much as four hundred. The body is not the thing you see and this file treats
// it that way: the hull is a dark spindle that exists to be a silhouette, and
// almost all of the pixels are spent on the array.
//
// --- what this view is actually for ------------------------------------------
//
// §10.2's whole design is the dimming, and until there was a body the dimming
// happened entirely inside `lantern.js` where nobody could see it. The player is
// supposed to learn one sentence — **the lights went out, so it knows where I
// am** — and that sentence is only learnable if the going-out is *countable*.
// The simulation already guarantees the cascade (`_dim()` puts the elements out
// one at a time, `level = clamp01(lureOutput * n - i)`, so at any instant every
// element is either full, dark, or the single one in transit). This file's job
// is to not throw that away:
//
//   - Every drawn size is capped against the *arc spacing between neighbouring
//     elements*, so two elements can never merge into one blob. If they merge,
//     one going out reads as the ring getting slightly dimmer, which is exactly
//     the smooth global fade §10.2 says must not be what happens.
//   - Brightness runs through `glowMaterial()`'s `setLumens()`, which is
//     perceptual on purpose because the array spans three orders of magnitude
//     between advertising and dark.
//   - Nothing here decides *when* an element goes out. That is read from
//     `lights()` — the simulation's own list of what is emitting — so the picture
//     and the signature cannot drift apart.
//
// --- the wave, which is the one thing the view invents ------------------------
//
// §10.2's UNAWARE row is *"lights pulse in slow, attractive patterns"* and ALERT
// is *"The pattern becomes regular, then insistent"*. The simulation owns the
// tremolo's *amplitude* (`pulse`, in every `lights()` entry already) but has no
// per-element phase, because a phase is a picture and not a behaviour. So the
// view adds one: at attention 0 the pulse runs around the ring as a travelling
// wave, and the wave's depth falls to zero as attention rises, which lands the
// array in unison exactly when §10.2 wants "insistent". The wave rate is the
// creature's own `voiceState().tremoloHz`, so the light and the sound stay the
// same event the way §10.2 requires, and one lap of the ring is one breath.
//
// The wave is a *redistribution of appearance*, not of output: it multiplies
// after the perceptual transfer, never touches `lights()`, and the number any
// other system reads for how much light this creature is making is still
// `emittedLumens()`. A view that changed that would be a second opinion about
// how bright the creature is, and then §4.2 and the screen would disagree.
//
// --- why the glow is three layers, which was learned the hard way -------------
//
// There is no bloom pass in this renderer and adding one is not this file's
// call, so the glare is camera-facing quads with a radial falloff baked into
// 128² data textures. It is not a cheat: the light registry in `lights.js` gives
// each element a 140 m scattering radius, and what a 4 m emitter looks like from
// a kilometre away *is* its scattering halo rather than its 4 m of tissue.
//
// The depth rule here is not obvious and it cost three rounds of captures, so
// it is written down. **The cloud march terminates at scene depth.** A fragment
// that writes no depth is therefore treated as sitting at the far plane and gets
// the transmittance of the *entire* column applied to it, including all the
// vapour behind the creature. A fragment that does write depth clips the march —
// and everywhere its own light is too faint to replace the cloud it just
// deleted, the scene's clear colour shows through. Measured: an alpha-tested
// glare quad at 600 m drew every element inside a dark navy ring, and an
// un-tested one drew every element inside a dark navy *square*.
//
// A measurement said the depth write bought nothing at 300 m, 600 m and 1200 m.
// It was wrong, and the way it was wrong is worth recording: it sampled the
// brightest pixel in a small window around each element, and that pixel was the
// solid core — which writes depth in every variant — so the reading was blind to
// the thing it was supposed to be comparing. The capture that followed showed
// the truth immediately: with the glare's depth write removed every element went
// milky and flat.
//
// What resolves it is the shape of the depth writer, not whether there is one.
// A **solid** core cannot leave a ring, because the disc of cloud it clips is
// exactly its own silhouette and its own silhouette is uniformly lit. So the
// core is grown to the size of the glare's bright region and does all the depth
// writing, and the soft layers are left alone:
//
//   core     the element as an emitting surface. Solid, opaque to the march,
//            sized to the bright part of the glare and floored at about two and
//            a half pixels so it can never be erased. §10.2's 4 m is its lower
//            bound rather than its size: the contract measures the animal's
//            tissue, this measures how much of the sky that tissue lights up.
//   glare    the glow around it, no depth write. Free to be soft, because
//            nothing about it has to survive an alpha test.
//   aureole  wide, very faint, no depth write. The communal haze an array of
//            lights makes in clear air, and the layer that is *supposed* to be
//            erased by intervening vapour — when the Lantern is inside a mass
//            what the player should see is the mass glowing, which is
//            `bioluminescence()`'s job in the light registry and not this
//            file's.

import * as THREE from 'three';
import { CreatureView, fleshMaterial, glowMaterial } from '../creatures.js';
import { clamp01, smoothstep, TAU } from '../../core/math.js';
// Read-only, and the archetype's own constants table. The view needs one number
// the simulation will not hand it per-element — what a *full* element is worth in
// lumens — and guessing it (a running maximum, say) would mean the first seconds
// of every encounter are rendered at the wrong brightness while the guess
// converges. `lantern.js` imports nothing from the renderer, so this direction
// is the only one and there is no cycle.
import { LANTERN } from '../../game/creatures/lantern.js';

export const LANTERN_VIEW = {
  /**
   * Instance capacity for the array. [contract §10.2]: *"between nine and twenty
   * of them"*, so twenty is the ceiling and a Lantern that rolled twenty never
   * reallocates a buffer mid-encounter.
   */
  maxElements: 20,

  /**
   * Radius of one element's glare at `glareRefM`, metres. Away from that range
   * it goes as the square root of distance. It also sets the solid core's size
   * through `coreGlareFraction`, so this one number decides how big a Lantern's
   * lights are at every range.
   *
   * Fixed in metres is wrong at both ends and the captures showed both. At three
   * kilometres a 20 m glare is four pixels and the array is a scatter of specks;
   * at sixty metres the same 20 m glare is a forty-metre ball wrapped round a
   * four-metre light and every element reads as a flat teal lozenge. What is
   * actually being drawn is *glare*, and glare is an artefact of how bright a
   * source appears rather than of how big it is. Apparent brightness falls as
   * 1/d², so a square root in distance keeps the drawn angle falling — the light
   * still recedes — at half the rate the object does. Both ends were measured:
   * 35 m at three kilometres (nine pixels, legible), 5 m at sixty (a glow around
   * the element rather than instead of it).
   */
  glareRadiusM: 20,
  glareRefM: 1000,

  /**
   * Smallest angular radius the solid core is drawn at, radians.
   *
   * The core is the only thing here that writes depth, which makes it the only
   * thing guaranteed not to be erased by the column behind the creature — so it
   * must never fall below a pixel. 0.0018 rad is about 1.3 px at the ~0.0014
   * rad/px this game runs at, giving a 2.5 px dot: small enough that the cloud
   * it clips is invisible, large enough that the element cannot flicker out of
   * existence between frames as the ring turns.
   */
  coreMinRad: 0.0018,

  /**
   * Core radius as a fraction of the glare's, when that is larger than the
   * element itself.
   *
   * This is the number that decides how big a Lantern's lights actually look,
   * because in this renderer the solid core is very nearly the only part of them
   * that survives. Measured at 600 m and 1200 m: the soft glare, which writes no
   * depth and is therefore multiplied by the transmittance of the whole column,
   * contributes almost nothing at either range — the medium here is thick enough
   * that a non-occluding emitter is gone by half a kilometre. So the core has to
   * be the light and the glare has to be a bonus for when the air happens to be
   * clear.
   *
   * 0.45 is as large as it can be while the elements stay countable: at three
   * kilometres it puts an eight-pixel dot every seventeen pixels around the ring,
   * and §10.2's cascade is only legible while the player can still tell one light
   * from the next. Larger reads better in a still frame and destroys the
   * mechanic.
   */
  coreGlareFraction: 0.45,

  /**
   * Hard ceiling on the glare, as a fraction of the arc between neighbours.
   *
   * The cascade is only legible if the player can count what is left, and two
   * glares that touch are one light. Half the spacing is the point of contact;
   * the ceiling never actually binds at §10.2's geometry (the tightest case,
   * twenty elements on a ring drawn in to 90 m, gives 14.1 m against a 14 m
   * glare) and exists so that it cannot start binding silently if the contract's
   * numbers move.
   */
  glareSpacingCap: 0.5,

  /**
   * Aureole radius as a fraction of the arc between neighbours — the wide, faint,
   * non-depth-writing layer. At 0.85 neighbouring aureoles just reach each other,
   * which is intended: overlapping haze is what an array of lights in vapour
   * actually looks like, and it is the difference between nineteen specks and one
   * luminous ring at the distance §10.2 asks the player to approach from.
   */
  aureoleSpacingFraction: 0.85,

  /**
   * Range over which the aureole fades in, metres.
   *
   * The aureole is scattered light picked up along the line of sight, so there
   * has to be a line of sight for it to be picked up along. Drawn at close range
   * it stopped being haze and became a balloon: the capture at 250 m had a 4 m
   * element wearing a flat 112 m lozenge, brighter than the light inside it and
   * with a visible edge. Gone by 350 m, full by 1200 m — which is also `LOD.near`,
   * so the layer that only exists to carry the array at distance switches on
   * exactly where the detailed near view stops.
   */
  aureoleNearM: 350,
  aureoleFullM: 1200,

  /**
   * Fraction of the glare's radius occupied by its white-hot centre.
   *
   * 0.16 of 20 m is 3.2 m against the contract's 4 m element, so the part that
   * blows out to white is about the size of the thing that is actually glowing.
   * Much below this and the glare is a soft blob with no source in it; at 0.30,
   * where this started, the core and the bloom together made a broad bright
   * plateau with an edge on it and every element read as a glass bead.
   */
  glareCoreFraction: 0.16,

  /** Texture edge, px. 128 is the smallest power of two at which the soft radial
   *  falloff has no visible banding after tone mapping. */
  glowTexSize: 128,

  /**
   * Smallest angular radius the glare is allowed, radians.
   *
   * A sub-pixel emitter aliases: it appears and disappears between frames as the
   * ring turns, and a Lantern that flickers is signalling something it is not.
   * 0.0045 rad is about 3 px at the ~0.0014 rad/px this game runs at. With the
   * square-root distance law above it only binds past nine kilometres, well
   * outside anything §10.2 asks the player to read, and exists so the array does
   * not start scintillating at the edge of `LOD.cull`.
   */
  glareMinRad: 0.0045,

  /**
   * Glare radius floor as a fraction of full, so a dying element *shrinks* as
   * well as dims. At two kilometres a glare is a few pixels across and a change
   * in brightness alone is nearly unreadable; a change in size is not. 0.55 is as
   * low as this can go before a half-lit element reads as a further-away one.
   */
  glareSizeFloor: 0.55,

  /**
   * HDR multipliers. The scene renders to a linear float target with no tone
   * mapping (see `clouds.renderFrame`), so values above 1 survive to the
   * composite and ACES desaturates them towards white — which is how the
   * elements get a white-hot centre inside a cyan glow without a second colour
   * being authored anywhere. The composite runs at an exposure of 0.66, which is
   * why these are higher than a first reading with the cloud pass disabled
   * suggested — that path uses the renderer's own exposure of 1.0 and made 1.7
   * look like a blown white disc when in the real frame it was a pale one. At
   * 1.9 the crest of the tremolo wave clears 1.0 after exposure, so the centres
   * sparkle, and everything outside the hot core stays in the cyan.
   */
  coreHot: 2.20,
  glareHot: 1.90,
  aureoleHot: 1.30,

  /**
   * The body's own running lights, as a fraction of an array element. Small on
   * purpose: they exist so that "fully dark" is a thing the player can *watch*
   * happen to the animal and not only to the ring, and if they were bright they
   * would give the body away at ranges §10.2 wants it hidden at.
   */
  beadHot: 0.30,

  /**
   * Depth of the travelling wave at attention 0, and how many laps of the ring
   * one breath makes.
   *
   * 0.55 puts the crest at 1.55 and the trough at 0.45 of an element's nominal
   * brightness — deep enough to read as a wave running round the ring at three
   * kilometres, shallow enough that a trough is never as dark as an element that
   * has actually gone out. The player is being asked to tell those two apart and
   * §10.2's entire mechanic depends on it, which is the same reason the
   * simulation caps `tremoloDepth` at 0.45.
   *
   * One turn: two or more and the ring reads as noise rather than a pattern; less
   * than one and it reads as a single blink at one bearing.
   */
  waveDepthCalm: 0.55,
  waveTurns: 1,

  /** Body detail. Five tendrils and eight beads are the fewest that still read as
   *  a fringe and as a row rather than as a scatter. */
  crownCount: 5,
  beadCount: 8,
};

/**
 * The hull profile, as (t, radius) with t running tail(0) → head(1) and radius in
 * fractions of body length.
 *
 * Widest at 0.10 of its length — a swimmer, not a balloon: 18 m across a 90 m
 * body. The tail closes to a point and the head to a blunt 1 m cap, so the
 * silhouette has a direction even when there is not enough light to see a face,
 * which ART_DIRECTION's "strong silhouettes" is asking for.
 */
const HULL_PROFILE = [
  [0.00, 0.000], [0.08, 0.018], [0.20, 0.048], [0.34, 0.078], [0.50, 0.098],
  [0.66, 0.092], [0.80, 0.070], [0.92, 0.042], [1.00, 0.012],
];

/**
 * The radial falloff of one element's glare, as a data texture.
 *
 * Built rather than loaded: an asset would be one more thing to keep in step with
 * `glareCoreFraction`, and the profile is three lines of arithmetic. RGB is white
 * and every bit of the shape lives in alpha, because the colour comes from the
 * material (the simulation's `LANTERN.color`) and the per-instance brightness.
 *
 * `profile(r)` returns alpha at radius r in 0..1. Two are used:
 *
 *   glare    core + bloom + corona. The core is the white-hot centre, one
 *            element's worth of tissue; the bloom is the glare around it; the
 *            corona is a faint annulus and the only decorative term in the file,
 *            and it is what makes an element read as glowing *tissue* rather
 *            than as a point source. That is the reason the Lantern survives
 *            being looked at directly, which §10.2 requires of it and of
 *            nothing else in the roster.
 *   aureole  one soft term with no centre at all — the middle is left to the
 *            glare quad sitting on top of it, and a peak here would only stack
 *            into a blown-out core.
 */
function radialTexture(size, profile) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = r >= 1 ? 0 : Math.round(Math.min(1, Math.max(0, profile(r))) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// The first cut of this had a wide core and a strong corona, and the telephoto
// capture showed the result honestly: nineteen glass beads. A light does not
// have a rim. So the core is narrow, the bloom carries almost everything and
// falls smoothly, and the corona is left as a hint rather than a shell.
const glareProfile = (coreFrac) => (r) => {
  const k = r / coreFrac;
  const core = Math.exp(-k * k);
  const bloom = 0.50 * Math.pow(1 - r, 3.2);
  const corona = 0.055 * Math.exp(-Math.pow((r - 0.45) / 0.12, 2));
  return core + bloom + corona;
};

// Flat-topped rather than peaked, and gone by the rim so neighbouring aureoles
// cross-fade instead of ending on a visible circle.
const aureoleProfile = (r) => 0.30 * Math.pow(1 - r, 1.4);

/**
 * Give a geometry a white `color` attribute.
 *
 * Three only applies `instanceColor` when `USE_COLOR` is defined, and `USE_COLOR`
 * comes from `material.vertexColors` and nothing else (`color_fragment` in
 * r169). So per-instance brightness — the entire cascade — requires
 * `vertexColors: true`, which in turn requires a `color` attribute that would
 * otherwise default to black and draw the whole array as nothing at all. This is
 * that attribute. It cost an hour to find; do not remove it.
 */
function whiteVertexColors(geo) {
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

export class LanternView extends CreatureView {
  constructor(creature, opts = {}) {
    super(creature, opts);
    this._camPos = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._col = new THREE.Color();
    this._wavePhase = 0;
    /** Lumens one element makes at full advertisement — the reference the
     *  perceptual transfer is measured against. Set in build(), when the element
     *  count is known. */
    this._perElementLm = LANTERN.arrayLumens / LANTERN_VIEW.maxElements;
  }

  build() {
    const L = LANTERN.bodyLength;
    const n = (this.creature.lures && this.creature.lures.length) || LANTERN_VIEW.maxElements;
    this._count = n;
    this._perElementLm = LANTERN.arrayLumens / n;

    const flesh = fleshMaterial();
    this._materials = [flesh];

    // --- hull ---------------------------------------------------------------
    // A lathe rather than a squashed sphere so the profile above is literally the
    // shape, and 14 radial segments because at 4.5 km a 90 m body is about
    // 25 px wide and nothing past 14 is ever resolvable.
    const pts = HULL_PROFILE.map(([t, r]) => new THREE.Vector2(Math.max(r * L, 1e-3), (t - 0.5) * L));
    const hullGeo = new THREE.LatheGeometry(pts, 14);
    // The base class puts heading on rotation.y, which maps local +Z to the
    // creature's forward vector (`azimuthDir` = (sin h, 0, cos h)). The lathe is
    // built around +Y, so it turns once, here, and never again.
    hullGeo.rotateX(Math.PI / 2);
    this._hull = new THREE.Mesh(hullGeo, flesh);
    this.object3D.add(this._hull);

    // --- dorsal sail --------------------------------------------------------
    // Two triangles, and they carry more of the silhouette than the hull does:
    // a smooth spindle at the edge of visibility is ambiguous with a cloud, and a
    // spindle with a fin is not.
    const sail = new THREE.Shape();
    sail.moveTo(-0.34 * L, 0.030 * L);
    sail.lineTo(-0.12 * L, 0.300 * L);
    sail.lineTo(0.10 * L, 0.240 * L);
    sail.lineTo(0.30 * L, 0.075 * L);
    sail.closePath();
    const finGeo = new THREE.ShapeGeometry(sail);
    // Shape x → world +Z, shape y stays up.
    finGeo.rotateY(-Math.PI / 2);
    this._finMat = fleshMaterial({ side: THREE.DoubleSide });
    this._materials.push(this._finMat);
    this._fin = new THREE.Mesh(finGeo, this._finMat);
    this.object3D.add(this._fin);

    // --- trailing tendrils --------------------------------------------------
    // The stalks the elements were released from. §10.2 says released and drifting
    // on the flow, so nothing is tethered — but at close range the array has to be
    // legible as *this animal's* array and not as unrelated lights.
    //
    // These used to radiate forward from the nose, and the capture at 250 m
    // showed exactly what that reads as: a black tick with seven legs. The
    // Lantern almost always faces the player — §10.2's ALERT tell is that its
    // array orients on the estimate — so the head-on silhouette is the one that
    // matters, and radial spokes are the worst possible thing to put in it. They
    // now leave the body at mid-length and sweep *aft*, staying inside a radius
    // barely wider than the hull, so head-on the animal is a dark lens with a
    // fringe and in profile it has something trailing behind it.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.07 * L, 0, 0.10 * L),
      new THREE.Vector3(0.11 * L, -0.01 * L, -0.14 * L),
      new THREE.Vector3(0.12 * L, -0.03 * L, -0.38 * L),
      new THREE.Vector3(0.10 * L, -0.06 * L, -0.60 * L),
    ]);
    const stalkGeo = new THREE.TubeGeometry(curve, 6, 0.014 * L, 5, false);
    this._crown = new THREE.InstancedMesh(stalkGeo, flesh, LANTERN_VIEW.crownCount);
    this._crown.frustumCulled = false;
    for (let i = 0; i < LANTERN_VIEW.crownCount; i++) {
      // Rotation about the forward axis (+Z) splays them round the head.
      const a = (i / LANTERN_VIEW.crownCount) * TAU;
      const s = 0.85 + 0.30 * ((i * 7) % 5) / 4;
      this._m.makeRotationZ(a).scale(new THREE.Vector3(s, s, 1));
      this._crown.setMatrixAt(i, this._m);
    }
    this._crown.instanceMatrix.needsUpdate = true;
    this.object3D.add(this._crown);

    // --- the array ----------------------------------------------------------
    // `lights()` reports world positions, and the parent group is already carrying
    // both the body's position and its heading. Undoing the heading on a child is
    // exact and costs one Euler write; converting each element by hand would be a
    // second place for the trig to be wrong.
    this._array = new THREE.Group();
    this.object3D.add(this._array);

    const glowColor = new THREE.Color().fromArray(LANTERN.color);

    // Cores. Additive rather than alpha-blended because these are emitters: an
    // element at a tenth of its output should vanish into the background, not
    // become a dark disc hanging in front of the cloud. They are the one layer
    // that writes depth — they are 4 m of real object — so the cloud march
    // terminates on them, an element is never wholly erased by the column behind
    // it, and because the geometry is opaque and its own size the clipped disc is
    // exactly the silhouette of the thing that is glowing.
    this._glow = glowMaterial(glowColor, this._perElementLm, {
      blending: THREE.AdditiveBlending,
      depthWrite: true,
      vertexColors: true,
    });
    this._materials.push(this._glow);
    // Detail 2 rather than 1: the core is drawn as a disc up to a hundred pixels
    // across when the player is inside the ring, and at detail 1 its silhouette
    // is a visible polygon. 320 triangles times twenty elements is nothing here.
    const coreGeo = whiteVertexColors(new THREE.IcosahedronGeometry(1, 2));
    this._cores = new THREE.InstancedMesh(coreGeo, this._glow, LANTERN_VIEW.maxElements);
    this._cores.frustumCulled = false;   // instances reach 400 m from the group origin
    this._cores.renderOrder = 2;
    this._array.add(this._cores);

    // Glare. No depth write and no alpha test, so it is free to fade smoothly to
    // nothing at its rim. See the header for the two artefacts that came of
    // asking it to do anything else.
    this._glareTex = radialTexture(LANTERN_VIEW.glowTexSize,
      glareProfile(LANTERN_VIEW.glareCoreFraction));
    this._glareMat = glowMaterial(glowColor, this._perElementLm, {
      map: this._glareTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });
    this._materials.push(this._glareMat);
    this._glare = new THREE.InstancedMesh(
      whiteVertexColors(new THREE.PlaneGeometry(2, 2)), this._glareMat, LANTERN_VIEW.maxElements);
    this._glare.frustumCulled = false;   // instances reach 400 m from the group origin
    this._glare.renderOrder = 3;
    this._array.add(this._glare);

    // Aureole. Writes no depth, and is therefore correctly erased by any vapour
    // between the camera and the far plane — which is what should happen to the
    // haze around a creature buried in a mass.
    this._aureoleTex = radialTexture(LANTERN_VIEW.glowTexSize, aureoleProfile);
    this._aureoleMat = glowMaterial(glowColor, this._perElementLm, {
      map: this._aureoleTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });
    this._materials.push(this._aureoleMat);
    this._aureole = new THREE.InstancedMesh(
      whiteVertexColors(new THREE.PlaneGeometry(2, 2)), this._aureoleMat, LANTERN_VIEW.maxElements);
    this._aureole.frustumCulled = false;
    this._aureole.renderOrder = 4;
    this._array.add(this._aureole);

    // --- body beads ---------------------------------------------------------
    // On the hull, so they turn with it. They share the cores' material, which
    // means they share its draw state and dim on exactly the same curve.
    const beadGeo = whiteVertexColors(new THREE.IcosahedronGeometry(1.4, 0));
    this._beads = new THREE.InstancedMesh(beadGeo, this._glow, LANTERN_VIEW.beadCount);
    this._beads.frustumCulled = false;
    this._beads.renderOrder = 2;
    for (let i = 0; i < LANTERN_VIEW.beadCount; i++) {
      const t = 0.18 + (i / (LANTERN_VIEW.beadCount - 1)) * 0.63;
      const r = hullRadiusAt(t) * L;
      const side = i % 2 === 0 ? 1 : -1;
      this._m.makeTranslation(side * r * 0.85, r * 0.55, (t - 0.5) * L);
      this._beads.setMatrixAt(i, this._m);
    }
    this._beads.instanceMatrix.needsUpdate = true;
    this.object3D.add(this._beads);        // on the hull, so they turn with it

    // Allocate the instanceColor buffers now. `setColorAt` creates them lazily,
    // and a first frame that sets matrices but no colours draws twenty black
    // elements — which looks exactly like a Lantern at COMMITTED and is not.
    this._col.setRGB(1, 1, 1);
    for (let i = 0; i < LANTERN_VIEW.maxElements; i++) {
      this._cores.setColorAt(i, this._col);
      this._glare.setColorAt(i, this._col);
      this._aureole.setColorAt(i, this._col);
    }
    for (let i = 0; i < LANTERN_VIEW.beadCount; i++) this._beads.setColorAt(i, this._col);

    this._built = true;
  }

  /** The base class hands `camPos` to `sync` and not to `step`, and the glow
   *  layers are billboards that need it per element. */
  sync(dt, camPos, ctx) {
    this._camPos.copy(camPos);
    return super.sync(dt, camPos, ctx);
  }

  step(dt, d, ctx) {
    const c = this.creature;
    const far = this.lodLevel === 'far';
    const near = this.lodLevel === 'near';

    // LOD. At `far` the body is about 25 px and every piece of detail on it is
    // sub-pixel, so what survives is the hull silhouette and the array — which is
    // also all the player is meant to see from kilometres away, so the cheap
    // version and the intended version are the same picture. Seven draw calls at
    // `near`, six at `mid`, four at `far`.
    this._fin.visible = !far;
    this._crown.visible = near;
    this._beads.visible = !far;
    // The cores stay at every level: they are the depth anchor and the pinpoint
    // that survives a hazy ray, and at `far` they are the array.

    // Undo the heading the base class put on the parent: `lights()` is world space.
    this._array.rotation.y = -this.object3D.rotation.y;

    const lights = c.lights ? c.lights() : null;
    const n = lights ? lights.length : 0;
    this._cores.count = n;
    this._glare.count = n;
    this._aureole.count = n;

    // The wave. Rate from the creature's own voice so the light and the sound are
    // one event; depth falls to zero as it becomes certain, which is §10.2's
    // "regular, then insistent".
    const att = clamp01(c.attention || 0);
    // Through the creature's own accessor rather than recomputed from
    // `tremoloHz` and `attention` here: the rate is §9.4's threat cue and having
    // two copies of it is how the light and the sound end up disagreeing. It
    // allocates one small object per frame per Lantern, which is the price.
    const hz = c.voiceState ? c.voiceState().tremoloHz : LANTERN.tremoloHz;
    this._wavePhase = (this._wavePhase + hz * TAU * dt) % TAU;
    const waveDepth = LANTERN_VIEW.waveDepthCalm * (1 - att);

    const total = this._count || LANTERN_VIEW.maxElements;
    const p = c.position;
    const camX = this._camPos.x - p.x;
    const camY = this._camPos.y - p.y;
    const camZ = this._camPos.z - p.z;

    // The aureole is measured against the gap between neighbours at the ring's
    // *current* radius, so the haze follows the array as it opens to 400 m on
    // SEARCHING and closes to a body length on TRACKING. The glare is not — it
    // follows distance instead, per element — but it is capped against the same
    // spacing, because two glares that touch are one light and the cascade stops
    // being countable.
    const ringR = c.ringRadius || LANTERN.ringRadiusM;
    const spacing = TAU * ringR / total;
    const glareCap = spacing * LANTERN_VIEW.glareSpacingCap;
    const aureoleBase = spacing * LANTERN_VIEW.aureoleSpacingFraction;
    const coreR = LANTERN.lureDiameterM / 2;

    for (let i = 0; i < n; i++) {
      const lt = lights[i];
      const lx = lt.x - p.x, ly = lt.y - p.y, lz = lt.z - p.z;

      // Perceptual brightness of this element, from the framework's own curve.
      // `setLumens` writes the material's opacity; reading it back is how the
      // transfer stays defined in exactly one place. Opacity is restored to 1
      // below — with additive blending the brightness lives in the colour.
      this._glow.userData.setLumens(lt.lumens);
      const base = this._glow.opacity;
      // Wave applied after the transfer, so a crest can exceed 1 and blow out in
      // the HDR buffer rather than clipping inside `setLumens`.
      const phase = this._wavePhase - (i / total) * TAU * LANTERN_VIEW.waveTurns;
      const b = base * (1 + waveDepth * Math.cos(phase));

      // Billboard basis: face the element at the camera, not at the screen. For a
      // radially symmetric glare the two are indistinguishable, and this one
      // needs no camera orientation — only its position, which `sync` has.
      const tx = camX - lx, ty = camY - ly, tz = camZ - lz;
      const dist = Math.hypot(tx, ty, tz) || 1;
      const fx = tx / dist, fy = ty / dist, fz = tz / dist;
      let rx = fz, rz = -fx;                       // cross((0,1,0), f)
      const rl = Math.hypot(rx, rz);
      if (rl < 1e-4) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
      const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;   // cross(f, right)

      // A dying element shrinks as well as dims: at two kilometres a glare is a
      // few pixels across and a change in value is nearly unreadable, while a
      // change in size is not.
      const dim = LANTERN_VIEW.glareSizeFloor + (1 - LANTERN_VIEW.glareSizeFloor) * clamp01(b);
      const glareBase = Math.min(
        LANTERN_VIEW.glareRadiusM * Math.sqrt(dist / LANTERN_VIEW.glareRefM), glareCap);
      const gs = Math.max(
        glareBase * dim, dist * LANTERN_VIEW.glareMinRad, coreR * 1.2);
      const au = smoothstep(LANTERN_VIEW.aureoleNearM, LANTERN_VIEW.aureoleFullM, dist);
      // Scale, not just colour: an aureole faded to nothing is still a hundred
      // metres of transparent quad being blended per element, and at close range
      // that is the largest overdraw this body can produce.
      const as = au > 0.004 ? aureoleBase * dim : 0;
      // Pushed towards the camera by more than the core's radius, so the quads
      // are never clipped by the sphere they are wrapped around. The aureole is
      // pushed a further glare-width in front: the two layers are parallel
      // camera-facing planes at the same range, and left coplanar they z-fight
      // into a diagonal hatch across every element — which is exactly what the
      // 600 m capture showed before this line existed.
      const off = coreR * 1.6;
      const aoff = off + glareBase * 1.5;
      const e = this._m.elements;
      e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
      e[1] = 0;   // the right vector of a Y-up billboard is horizontal by construction
      for (let pass = 0; pass < 2; pass++) {
        const s = pass === 0 ? gs : as;
        const o = pass === 0 ? off : aoff;
        e[0] = rx * s; e[2] = rz * s;
        e[4] = ux * s; e[5] = uy * s; e[6] = uz * s;
        e[8] = fx * s; e[9] = fy * s; e[10] = fz * s;
        e[12] = lx + fx * o; e[13] = ly + fy * o; e[14] = lz + fz * o;
        (pass === 0 ? this._glare : this._aureole).setMatrixAt(i, this._m);
      }
      const gb = b * LANTERN_VIEW.glareHot;
      this._col.setRGB(gb, gb, gb);
      this._glare.setColorAt(i, this._col);
      const ab = b * LANTERN_VIEW.aureoleHot * au;
      this._col.setRGB(ab, ab, ab);
      this._aureole.setColorAt(i, this._col);

      // The core shrinks a little as it dims for the same reason the glare does:
      // at range, size is readable when a change in value is not. The angular
      // floor is the survival clause — this is the only layer the composite
      // cannot erase, so it is never allowed to be sub-pixel.
      const cs = Math.max(
        coreR, glareBase * LANTERN_VIEW.coreGlareFraction, dist * LANTERN_VIEW.coreMinRad,
      ) * (0.6 + 0.4 * clamp01(b));
      this._m.makeScale(cs, cs, cs);
      this._m.setPosition(lx, ly, lz);
      this._cores.setMatrixAt(i, this._m);
      const cb = b * LANTERN_VIEW.coreHot;
      this._col.setRGB(cb, cb, cb);
      this._cores.setColorAt(i, this._col);
    }

    this._glare.instanceMatrix.needsUpdate = true;
    if (this._glare.instanceColor) this._glare.instanceColor.needsUpdate = true;
    this._aureole.instanceMatrix.needsUpdate = true;
    if (this._aureole.instanceColor) this._aureole.instanceColor.needsUpdate = true;
    this._cores.instanceMatrix.needsUpdate = true;
    if (this._cores.instanceColor) this._cores.instanceColor.needsUpdate = true;

    // The body's own lights, on the same output as the array. §10.2's COMMITTED
    // row is "Fully dark" without qualification, and that has to include the
    // animal: a hull still wearing running lights would let the player keep
    // tracking the thing whose entire threat is that they cannot.
    if (!far) {
      const bodyLm = this._perElementLm * clamp01((c.lureOutput ?? 1) * (c.pulse ?? 1));
      this._glow.userData.setLumens(bodyLm);
      const bb = this._glow.opacity * LANTERN_VIEW.beadHot;
      this._col.setRGB(bb, bb, bb);
      for (let i = 0; i < LANTERN_VIEW.beadCount; i++) this._beads.setColorAt(i, this._col);
      if (this._beads.instanceColor) this._beads.instanceColor.needsUpdate = true;
    }

    this._glow.opacity = 1;
  }

  dispose() {
    super.dispose();
    // The base class disposes geometries and materials; a material does not
    // dispose its map, and these are the view's own.
    if (this._glareTex) this._glareTex.dispose();
    if (this._aureoleTex) this._aureoleTex.dispose();
  }
}

/** Hull radius at t along the body, in fractions of body length. Linear between
 *  profile points — the beads only need to sit on the surface, not define it. */
function hullRadiusAt(t) {
  for (let i = 1; i < HULL_PROFILE.length; i++) {
    const [t1, r1] = HULL_PROFILE[i];
    if (t <= t1) {
      const [t0, r0] = HULL_PROFILE[i - 1];
      const k = (t - t0) / (t1 - t0 || 1);
      return r0 + (r1 - r0) * k;
    }
  }
  return HULL_PROFILE[HULL_PROFILE.length - 1][1];
}

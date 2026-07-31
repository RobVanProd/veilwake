// Local light sources for the volumetric march.
//
// Interface:
//
//   const lights = new LightRegistry();
//   const lamp = lights.add(shipLamp({ key: 'lamp/port' }));
//   lights.set(lamp, { position: [x, y, z], direction: [dx, dy, dz], on: true });
//   lights.remove(lamp);
//
//   lights.setViewFromCamera(camera, maxDist); // once, and again on a fov change
//   lights.prepare(camPos, viewDir);           // choose this frame's bounded set
//   lights.writeUniforms(uniforms, origin);    // pack it for the shader
//   lights.signatureLumens();                  // how loudly the ship broadcasts
//
//   const rig = attachShip(lights);            // the ship's own lights, as content
//   rig.update(pos, forward, { throttle, boost, lampOn });
//
// The cloud march asks this registry a question at every step it takes, so the
// interesting problem here is not what a light looks like but how many of them
// the march can afford.
//
// ---------------------------------------------------------------------------
// What a light costs, measured rather than assumed
// ---------------------------------------------------------------------------
//
// An earlier version of this header claimed the opposite of the truth on both
// counts — that the count was free and that the occlusion march was the part
// that cost. Measured 2026-07-30 with clouds.benchPass, which uses
// EXT_disjoint_timer_query_webgl2 (gl.finish does not fence on this D3D11/ANGLE
// backend and reports every configuration as fast), 1920x1080, quality high,
// camera inside cloud at densityAt 0.589, median of 32 frames:
//
//   lights in set        0      1      2      3      4      6      8
//   volumetric ms      1.68   2.55   3.55   4.61   5.68   7.63   9.66
//
// against a 7 ms volumetric budget. That is roughly +1.0 ms per light and the
// budget is gone at five. Two follow-ups pin down where the cost lives:
//
//   * It is mostly a fixed per-light cost, not a coverage cost. Four lights whose
//     range is only 383 m each — 3 km of ray covered between them — still cost
//     1.97 ms over the no-light baseline. Stretching the same four to 10.7 km of
//     range each, 86 km of ray covered, only reached 5.41 ms over baseline. So
//     the right guard is a cap on the count, which is what MAX_MARCH_LIGHTS is,
//     and not a budget on how much volume the set covers. That was worth checking
//     before assuming, because the opposite would have called for a different
//     mechanism entirely.
//
//   * The occlusion march is very nearly free. Eight lights with the shadow march
//     denied to all of them cost 9.62 ms; the same eight with it granted to all
//     of them cost 9.68 ms. Across 0, 1, 2, 3, 4, 6 and 8 granted marches the
//     spread was 9.59 to 9.78 ms, inside the run-to-run noise. It is free because
//     the shader gates it on the light's unoccluded contribution clearing
//     uLightCutoff, which confines it to the few hundred metres around a lamp
//     where a viewer could identify a shadow anyway.
//
// So the shadow budget was rationing something free while the count went
// unguarded. MAX_SHADOWED_LIGHTS is now equal to MAX_MARCH_LIGHTS and
// MAX_MARCH_LIGHTS carries the whole guard. Occlusion is what makes a beam read
// as volume rather than as a painted cone — measured, it removes 51% of the ship
// lamp's contribution to the frame — and there is no reason to spend any of it.
//
// ---------------------------------------------------------------------------
// Why this exists at all, beyond looking good
// ---------------------------------------------------------------------------
//
// The ship's lights are a detectable signature. The shafts the player casts are
// the visible evidence that they are broadcasting, so the beam has to be
// something the player can see themselves making. That is why the ship's lamp and
// plume are pinned into the set (see `pin`): a player who cannot see the beam
// they are casting cannot read their own signature, and that feedback loop
// matters more than a correct sort.
//
// ---------------------------------------------------------------------------
// Two scales, deliberately not one
// ---------------------------------------------------------------------------
//
// `intensity` is radiance in the same arbitrary scale as CLOUD_PALETTE.sun, which
// is 3.20 in red. `photicLm` is lumens, the unit signature.js and the creature
// contract speak. They are not convertible, and inventing a constant to convert
// them would be the fourth normalisation constant this project guessed instead of
// measuring. The contract's anchor table (§3.2) puts the search lamp at 9000 lm
// and the thruster plume under a lumen — a ratio above 10000:1 — while on screen
// the plume has to be about a third of the lamp's brightness or it does not read
// at all. One number cannot be both. So a light carries both, each authored
// against its own reference, and `signatureLumens()` returns the photometric one
// because that is the one signature.js consumes.
//
// `radius` is the distance at which the inverse-square falloff has dropped to one
// half, not a hard cut-off.

import { clamp01 } from '../core/math.js';

/**
 * How many lights the march program is compiled to read, and the runtime cap on
 * the set. Must match the MAX_LIGHTS define in clouds.js — clouds.js imports this
 * rather than restating it, so there is one number.
 *
 * Four, because four is the largest count that fits the 7 ms volumetric budget in
 * the measured worst case: see the table above, where four costs 5.68 ms and six
 * costs 7.63 ms. Content measurements for context, same camera and settings:
 *
 *   ship lamp alone                            1.66 ms  (baseline 1.68 — free)
 *   ship lamp + thruster plume                 1.85 ms
 *   ship lamp + plume + 2 creature lanterns    4.13 ms
 *   ship lamp + plume + 4 creature lanterns    4.78 ms
 *
 * One case does exceed the budget at four and is recorded rather than designed
 * around: four lightning cells discharging at once, each of which reaches 36 km
 * and so covers the entire ray, costs 8.06 ms. Three cost 6.25 ms, two cost
 * 4.65 ms. Because the ship's two lights are pinned, the set holds at most two
 * storms whenever the ship is lit — so the 8 ms case needs a blacked-out ship and
 * four simultaneous strokes, and a stroke lasts 0.2 s.
 */
export const MAX_MARCH_LIGHTS = 4;

/**
 * How many of those may carry a shadow march. Equal to MAX_MARCH_LIGHTS: the
 * measurement in the header found the occlusion march costs 0.06 ms across eight
 * lights, so there is nothing to ration and every reason not to — the occlusion
 * is what distinguishes a light shaft from a painted cone.
 */
export const MAX_SHADOWED_LIGHTS = MAX_MARCH_LIGHTS;

export const LIGHT_KIND = { OMNI: 'omni', SPOT: 'spot' };

// An omni light is a spot whose cone contains every direction. Encoding it that
// way rather than with a kind flag removes a branch from the innermost loop in
// the whole renderer, and the loop runs a few hundred times per pixel.
const OMNI_COS_OUTER = -2.0;
const OMNI_COS_INNER = -1.2;

/**
 * Default half-angle of the volume the march samples, as a tangent.
 *
 * Not a guess: main.js builds `new THREE.PerspectiveCamera(62, ...)` and captures
 * at 16:9, so tan(31 deg) = 0.6009 vertically, 0.6009 * 16/9 = 1.0682
 * horizontally, and the frustum diagonal is hypot(0.6009, 1.0682) = 1.2254. The
 * default carries 6% of margin on top because being too wide only costs a light
 * that would have scored its way out of the set anyway, while being too narrow
 * drops a light the player can see. setViewFromCamera() replaces it with the
 * camera's actual number.
 */
const DEFAULT_VIEW_SPREAD = 1.30;

/**
 * Default length of the marched volume, in metres. clouds.js QUALITY.ultra sets
 * maxDist 30000, the longest ray any quality level casts, so a light further than
 * this along the view axis cannot be reached at any setting.
 */
const DEFAULT_MARCH_FAR = 30000;

const DEFAULTS = {
  kind: LIGHT_KIND.OMNI,
  color: [1, 1, 1],
  intensity: 1,
  radius: 60,
  /** Half-angles in radians. `outer` is where the cone reaches zero. */
  cone: { inner: 0.20, outer: 0.42 },
  /** 0 disables the occlusion march for this light; 1 is fully occluded by
   *  cloud. Between the two is a cheat with a use: a thruster plume is its own
   *  emitter as well as a light, so it should not go completely dark when the
   *  ship is inside a cloud. */
  shadow: 1,
  /** Longest occlusion march, in metres. Past this the light is treated as
   *  unoccluded, because the taps get too far apart to mean anything. */
  shadowRange: 700,
  /**
   * Hard end of the light in metres, or 0 to derive it from `radius` and
   * `intensity` the way range() always has.
   *
   * This exists so that a beam's *throw* and its *reach* can be authored
   * separately, and they have to be, because in this shader one number was
   * doing both jobs and they pull in opposite directions.
   *
   * `radius` is the scale of the inverse-square falloff, so it is what decides
   * how far a beam stays bright — a searchlight is a reflector, not a bare
   * bulb, and its irradiance is nearly flat across the throw where the mirror
   * is still collimating it. Making it bright at three hundred metres means a
   * radius in the hundreds. But range() derives the cull distance from radius,
   * multiplying it by 22 at the ship lamp's intensity, so a radius of 300 asks
   * the march to carry the lamp for six and a half kilometres — measured in the
   * header's own table, that is the difference between a light costing 0.5 ms
   * and costing 1.35. The far end of it is invisible anyway: the shader windows
   * the falloff to zero at range, and out there the window is doing all the
   * work while inverse-square has already taken the light to a thousandth.
   *
   * So `reach` cuts it where the beam actually ends. The shader's window
   * (1 - r^2/range^2)^2 then shapes the last third of the beam into a taper
   * instead of a fade that never quite finishes, which is what a searchlight in
   * a scattering medium looks like: it does not dim to nothing, it is eaten.
   */
  reach: 0,
  /** Multiplies the importance score. */
  priority: 1,
  /** Guaranteed a slot if it survives the cull, ahead of anything scored. The
   *  ship's own lights set this; see the header on the feedback loop. Pins are
   *  capped at max - 1 so they can never starve the scene. */
  pin: false,
  /** Counted by signature() and signatureLumens(). False for lights that are not
   *  the ship's — a creature's glow gives away the creature, not the player. */
  signature: false,
  /** Luminous output in lumens, for the signature system. Authored against the
   *  anchor table in CREATURE_BEHAVIOR_CONTRACT.md §3.2, never derived from
   *  `intensity`; see the header on why the two scales stay apart. */
  photicLm: 0,
  on: true,
  key: '',
};

let nextId = 1;

class Light {
  constructor(spec) {
    this.id = nextId++;
    this.slot = -1;
    this.position = [0, 0, 0];
    this.direction = [0, -1, 0];
    this.color = [1, 1, 1];
    this._shadowThisFrame = 0;
    Object.assign(this, {
      kind: DEFAULTS.kind,
      intensity: DEFAULTS.intensity,
      radius: DEFAULTS.radius,
      cone: { ...DEFAULTS.cone },
      shadow: DEFAULTS.shadow,
      shadowRange: DEFAULTS.shadowRange,
      reach: DEFAULTS.reach,
      priority: DEFAULTS.priority,
      pin: DEFAULTS.pin,
      signature: DEFAULTS.signature,
      photicLm: DEFAULTS.photicLm,
      on: DEFAULTS.on,
      key: DEFAULTS.key,
    });
    this.apply(spec);
  }

  apply(p) {
    if (!p) return this;
    if (p.position) setVec(this.position, p.position);
    if (p.direction) setDir(this.direction, p.direction);
    if (p.color) setVec(this.color, p.color);
    if (p.cone) this.cone = { inner: p.cone.inner ?? this.cone.inner, outer: p.cone.outer ?? this.cone.outer };
    for (const k of ['kind', 'intensity', 'radius', 'shadow', 'shadowRange', 'reach',
                     'priority', 'pin', 'signature', 'photicLm', 'on', 'key']) {
      if (p[k] !== undefined) this[k] = p[k];
    }
    return this;
  }

  /** Radiance in the CLOUD_PALETTE scale, brightest channel. */
  luminance() {
    return this.intensity * Math.max(this.color[0], this.color[1], this.color[2]);
  }

  /** Distance past which this light contributes nothing anywhere, in metres.
   *
   *  Derived rather than authored, because the number that matters is where the
   *  light stops being visible and that depends on both its radius and how bright
   *  it is. The shader windows its falloff to zero exactly here, so a march sample
   *  this far from the light receives exactly nothing — which is what makes it
   *  safe for prepare() to use as a hard cull, provided the distance measured is
   *  the one the shader measures. See _distanceToView() for the version of that
   *  sentence this module previously got wrong. */
  range() {
    // An authored reach wins, because for a beam it is the shape of the thing
    // and not a safety margin. See DEFAULTS.reach.
    if (this.reach > 0) return this.reach;
    // att(r) = 1 / (1 + (r/radius)^2); solve for att * lum = CUT.
    const CUT = 0.01;
    const k = Math.max(this.luminance() / CUT - 1, 0);
    return this.radius * Math.min(Math.sqrt(k), 40);
  }
}

function setVec(dst, src) {
  if (Array.isArray(src)) { dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; }
  else { dst[0] = src.x; dst[1] = src.y; dst[2] = src.z; }
  return dst;
}

/**
 * Normalise into `dst`, and leave `dst` alone if the input has no direction in it.
 *
 * The old version divided by `hypot(...) || 1`, which protects the arithmetic and
 * nothing else: a zero vector survived as a zero vector, and a spot pointing
 * nowhere emits nothing in any direction while still consuming a march slot and
 * still counting toward the signature. That is exactly the feedback loop this
 * module exists to keep intact, broken — the ship broadcasts and the player sees
 * no beam. It is reachable by accident, because `new THREE.Vector3()` is the
 * natural thing to pass on frame zero and it is truthy with all components zero.
 */
function setDir(dst, src) {
  const x = Array.isArray(src) ? src[0] : src.x;
  const y = Array.isArray(src) ? src[1] : src.y;
  const z = Array.isArray(src) ? src[2] : src.z;
  const n = Math.hypot(x, y, z);
  if (!(n > 1e-6)) return dst;   // the negation also catches NaN
  dst[0] = x / n; dst[1] = y / n; dst[2] = z / n;
  return dst;
}

export class LightRegistry {
  constructor({ max = MAX_MARCH_LIGHTS, maxShadowed = MAX_SHADOWED_LIGHTS } = {}) {
    this.max = Math.max(1, Math.min(max, MAX_MARCH_LIGHTS));
    // Clamped against MAX_SHADOWED_LIGHTS as well as against `max`. The old
    // version clamped only against `max`, so an exported constant documenting a
    // hard limit was enforced nowhere and a caller could quietly grant four times
    // it.
    this.maxShadowed = Math.max(0, Math.min(maxShadowed, MAX_SHADOWED_LIGHTS, this.max));
    this.lights = new Map();
    /** The bounded set chosen by the last prepare(), in the order the shader will
     *  read them. Public because a capture that cannot say which lights were live
     *  is not evidence of anything. */
    this.active = [];
    /** Shape of the volume the march samples; see the two DEFAULT_ constants. */
    this.viewSpread = DEFAULT_VIEW_SPREAD;
    this.marchFar = DEFAULT_MARCH_FAR;
    /** How many lights the last prepare() rejected outright, for debugSummary. */
    this.lastCulled = 0;
    this._scored = [];
    this._pinned = [];
  }

  /** Take the marched volume's shape from the real camera rather than the
   *  default. `far` is clouds.js's QUALITY[quality].maxDist. */
  setViewFromCamera(camera, far = this.marchFar) {
    const tanV = Math.tan((camera.fov * Math.PI / 180) * 0.5);
    // The frustum diagonal, so a light at the corner of the screen is not culled,
    // and 6% on top for the same reason the default carries it.
    this.viewSpread = tanV * Math.hypot(1, camera.aspect || 1) * 1.06;
    this.marchFar = far;
    return this;
  }

  add(spec) {
    const l = new Light(spec);
    this.lights.set(l.id, l);
    return l.id;
  }

  /** Patch a light in place. Called every frame for anything that moves, so it
   *  allocates nothing. */
  set(id, patch) {
    const l = this.lights.get(id);
    if (l) l.apply(patch);
    return this;
  }

  get(id) { return this.lights.get(id); }

  /** Remove a light, including from the set the next writeUniforms() would pack.
   *
   *  The active list used to survive a remove(), so a light deleted between
   *  prepare() and writeUniforms() was still drawn for that frame. Harmless on the
   *  call order clouds.js uses today — the two run back to back — but the moment
   *  creatures despawn on their own schedule, a dead creature's lantern flashes
   *  for one frame at its last position, which is a false "something is there" in
   *  a game whose whole dread mechanic is inference from partial light. */
  remove(id) {
    const l = this.lights.get(id);
    if (!l) return false;
    const i = this.active.indexOf(l);
    if (i >= 0) this.active.splice(i, 1);
    return this.lights.delete(id);
  }

  clear() { this.lights.clear(); this.active.length = 0; return this; }

  /**
   * Distance from a light to the nearest point the march can sample, in metres.
   *
   * This is the whole of the range-cull fix, and it is the one bug in this module
   * a player would have noticed. The cull used to measure the light's distance to
   * the *camera*, but the shader applies the matching window per *march sample*,
   * and those are different points: a light 1.7 km ahead and just past its own
   * range still has samples passing through its core, where the attenuation is 1
   * and the window is 1 and it is drawn at full strength.
   *
   * Measured before the fix, at 320x180 with a default bioluminescence (range
   * 1692.8 m) on the view axis inside dense cloud: at 0.99 x range it changed
   * 44.9% of the frame's subpixels, and at 1.01 x range it changed 0.00% — a
   * byte-identical frame. Forcing that same light past the cull at that same
   * 1.01 x range brought back 42.5%. Thirty-four metres of camera movement, 2% of
   * the light's range, switched a glow covering nearly half the frame fully on and
   * fully off. In game that is a bioluminescent creature materialising its entire
   * glow in one frame as it drifts toward the player.
   *
   * The volume is approximated as the view cone capped at `marchFar`, and it is
   * conservative in both places it is inexact: a light behind the camera measures
   * to the apex, which is exact for any cone narrower than 90 degrees, and a light
   * past the cap ignores the axial gap, which under-states its distance and so
   * keeps it. Culling one light too many is a visible pop; keeping one too many
   * costs a sort comparison on the CPU.
   */
  _distanceToView(dx, dy, dz, viewDir) {
    if (!viewDir) return Math.hypot(dx, dy, dz);
    const fx = viewDir.x ?? viewDir[0], fy = viewDir.y ?? viewDir[1], fz = viewDir.z ?? viewDir[2];
    const s = dx * fx + dy * fy + dz * fz;
    if (s <= 0) return Math.hypot(dx, dy, dz);
    const sc = s < this.marchFar ? s : this.marchFar;
    const perp = Math.hypot(dx - fx * sc, dy - fy * sc, dz - fz * sc);
    const wide = sc * this.viewSpread;
    return perp > wide ? perp - wide : 0;
  }

  /**
   * Choose this frame's set.
   *
   * Pinned lights first, then the rest by score. The score approximates how much
   * of the frame a light can affect: its luminous output attenuated over the
   * distance to the camera, on a curve three times wider than its own falloff,
   * because a light 200 m ahead lights the air the player is about to fly through
   * even when the point the camera sits at is outside its radius. Lights behind
   * the camera are penalised but not excluded — the volume beside the ship is on
   * screen at the frame edges.
   *
   * Ties break on insertion id, and nothing here reads the previous frame's
   * result, so the set is a pure function of the scene and two captures of the
   * same simulation time agree byte for byte. That rules out the obvious cure for
   * a light flickering in and out at the boundary of the set — a hysteresis bonus
   * for whatever was active last frame — and the trade is deliberate: this
   * project's only way of seeing its own output is a deterministic capture, and a
   * capture that depends on which frames preceded it is not evidence of anything.
   */
  prepare(camPos, viewDir = null) {
    const cx = camPos.x ?? camPos[0], cy = camPos.y ?? camPos[1], cz = camPos.z ?? camPos[2];
    const scored = this._scored;
    const pinned = this._pinned;
    scored.length = 0;
    pinned.length = 0;
    this.lastCulled = 0;

    for (const l of this.lights.values()) {
      if (!l.on || l.intensity <= 0) continue;
      const dx = l.position[0] - cx, dy = l.position[1] - cy, dz = l.position[2] - cz;
      if (this._distanceToView(dx, dy, dz, viewDir) >= l.range()) { this.lastCulled++; continue; }

      const d2 = dx * dx + dy * dy + dz * dz;
      const soft = l.radius * 3;
      let score = (l.luminance() * l.priority) / (1 + d2 / (soft * soft));
      if (viewDir) {
        const n = Math.sqrt(d2) || 1;
        const facing = (dx * (viewDir.x ?? viewDir[0]) + dy * (viewDir.y ?? viewDir[1]) + dz * (viewDir.z ?? viewDir[2])) / n;
        score *= 0.45 + 0.55 * clamp01(facing * 0.5 + 0.75);
      }
      (l.pin ? pinned : scored).push({ l, score });
    }

    const byScore = (a, b) => (b.score - a.score) || (a.l.id - b.l.id);
    pinned.sort(byScore);
    scored.sort(byScore);

    this.active.length = 0;
    // A pin can take every slot but one, so a ship covered in lamps still leaves
    // room for whatever is actually happening in front of the player.
    const pinCap = Math.max(1, this.max - 1);
    for (let i = 0; i < pinned.length && i < pinCap; i++) this.active.push(pinned[i].l);
    for (let i = 0; i < scored.length && this.active.length < this.max; i++) this.active.push(scored[i].l);

    let shadowed = 0;
    for (const l of this.active) {
      l._shadowThisFrame = (l.shadow > 0 && shadowed < this.maxShadowed) ? l.shadow : 0;
      if (l._shadowThisFrame > 0) shadowed++;
    }
    return this.active;
  }

  /**
   * Pack the active set into the march's uniform arrays.
   *
   * `origin` is the cloud system's recentred origin: everything the shader sees is
   * in cloud space, and a light left in world space would slide by a whole quantum
   * the moment the player crosses one.
   */
  writeUniforms(u, origin = { x: 0, y: 0, z: 0 }) {
    // Bounded by the uniform arrays as well as by the set, so a registry and a
    // shader compiled against different constants under-fill rather than throw.
    const n = Math.min(this.active.length, u.uLightPos.value.length);
    u.uLightCount.value = n;
    for (let i = 0; i < n; i++) {
      const l = this.active[i];
      const spot = l.kind === LIGHT_KIND.SPOT;
      const cosOuter = spot ? Math.cos(l.cone.outer) : OMNI_COS_OUTER;
      const cosInner = spot ? Math.cos(Math.min(l.cone.inner, l.cone.outer - 1e-3)) : OMNI_COS_INNER;
      const range = l.range();

      u.uLightPos.value[i].set(
        l.position[0] - origin.x, l.position[1] - origin.y, l.position[2] - origin.z,
        1 / Math.max(l.radius, 0.01));
      u.uLightCol.value[i].set(
        l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity,
        l._shadowThisFrame || 0);
      u.uLightDir.value[i].set(l.direction[0], l.direction[1], l.direction[2], cosOuter);
      u.uLightPar.value[i].set(cosInner, range * range, Math.max(l.shadowRange, 1), 0);
    }
    return n;
  }

  /**
   * The ship's photic signature in lumens, before any occlusion.
   *
   * This is the number signature.js wants: its `_photic()` sums `photicLm` off the
   * system bus in lumens against SIG.caps.photic = 60000, and the contract's
   * anchor table is quoted in lumens too. Occlusion is deliberately not applied:
   * hiding a lamp inside a cloud reduces what reaches a given observer, which is
   * that observer's line-of-sight problem — CloudSystem.transmittance() — not a
   * property of the ship.
   *
   * The plume contributes 0 here on purpose. signature.js already computes it from
   * throttle and boost (SIG.plumeThrottleLm 0.05, SIG.plumeBoostLm 0.25), so
   * counting it here as well would double it, and the contract holds photic flat
   * at 3 lm from idle through boost, which a plume worth thousands of lumens would
   * not be.
   */
  signatureLumens() {
    let sum = 0;
    for (const l of this.lights.values()) {
      if (!l.on || !l.signature) continue;
      sum += l.photicLm;
    }
    return sum;
  }

  /**
   * Total radiance of the lights flagged as the player's, in the render scale.
   *
   * Not lumens and not convertible to them — see the header. This is the number to
   * print beside a beam in a debug overlay, and the number to check when asking
   * whether turning a lamp up made the frame brighter. Feed signatureLumens() to
   * the signature system, never this.
   */
  signature() {
    let sum = 0;
    for (const l of this.lights.values()) {
      if (!l.on || !l.signature) continue;
      sum += l.luminance();
    }
    return sum;
  }

  /** What the march is actually reading, for a report or an overlay. */
  debugSummary() {
    return {
      registered: this.lights.size,
      active: this.active.length,
      budget: this.max,
      culled: this.lastCulled,
      shadowed: this.active.filter((l) => l._shadowThisFrame > 0).length,
      pinned: this.active.filter((l) => l.pin).length,
      signature: +this.signature().toFixed(3),
      lumens: +this.signatureLumens().toFixed(1),
      keys: this.active.map((l) => l.key || `#${l.id}`),
    };
  }
}

// ---------------------------------------------------------------------------
// Presets
//
// The required consumers from the art direction, as parameter sets rather than as
// prose, so that the ship and the creatures do not each invent their own idea of
// how bright a lamp is. Every one of them is a spec object for add().
//
// On colour. The ship's lamp is warm and everything else is cold, and that is the
// art direction rather than an oversight: "the palette should be cold and deep by
// default ... so that any warm light reads as an event", with the ship's own lamps
// named among the few saturated things allowed in frame. Measured on the current
// cloud palette at 320x180 from inside cloud, the base frame runs 44.8 units bluer
// than red on 0-255, and switching the lamp on moves that to 43.4 — a 3% warm
// nudge inside a frame that is emphatically not grey. An audit of an earlier build
// read the palette as neutral (0.97 blue over red) and concluded the lamp should
// go cold; that reading was taken before the cloud palette was retuned and no
// longer holds. A cold lamp in a cold frame leaves the image with no warm event in
// it at all.
// ---------------------------------------------------------------------------

/**
 * The ship's forward exterior lamp — the "search lamp" of the contract's anchor
 * table, at its 9000 lm.
 *
 * What this costs, and what the occlusion buys, measured 2026-07-31 with
 * clouds.benchPass at 1920x1080, quality high, both hull lamps lit, camera
 * side-on to a beam crossing a cloud bank at 400 m, median of 32 frames:
 *
 *   lamps off                                     3.278 ms   (p99 3.313)
 *   both lamps, this preset                       4.242 ms   (p99 4.275)
 *
 * against the 7 ms volumetric budget — 0.48 ms per lamp. Looking straight down
 * the beam, which marches the whole length of it, the same pair costs 3.658 ms
 * (p99 3.901) against 3.983 ms (p99 4.829) for the old radius-45 preset. The new
 * lamp is *cheaper* than the one it replaces despite reaching four times further,
 * because reach cuts the cull at 800 m where the old preset derived 1005 m from
 * its intensity, and what a light costs is mostly its slot and its volume, not
 * its brightness.
 *
 * The occlusion march is what makes it a beam rather than a painted cone, and it
 * is worth the whole of its cost: rendering the same frame with the march denied,
 * the lamp's mean contribution to the image is 14.22 luminance levels against
 * 8.88 with it granted, so cloud removes 37.6% of the light the lamp would
 * otherwise put on screen. The clearer number is area: the lamp changes 21.1% of
 * the frame unoccluded and 13.7% occluded — a third of the beam is standing
 * behind cloud, and it took widening the shadow gate in vw_localLights to see it.
 * Before that change the same pair of frames read 20.6% and 19.7%, which is a
 * beam being drawn straight through a cloud bank. The widening cost nothing
 * measurable, which agrees with the header's finding that the march is free.
 */
export function shipLamp(over = {}) {
  return {
    kind: LIGHT_KIND.SPOT,
    color: [1.00, 0.94, 0.82],
    intensity: 5.0,
    // Throw, not brightness. See DEFAULTS.reach for why these are two numbers.
    //
    // Measured, in clear air with nothing along the beam to occlude it, as the
    // luminance the lamp adds to the frame on its own axis: two captures of one
    // fixed side-on pose with the lamp switched on and off, differenced, sampled
    // every 40 px along the centre row at 1280x720, both hull lamps lit. 0-255.
    //
    //   metres along beam      54   93  133  172  212  291  371  450  530  610  690
    //   radius  45 (was)       50   36   25   18   12    8    6    6    5    5    4
    //   radius  90, reach  600 56   49   41   32   24   16    9    5    1    0    0
    //   radius 150, reach  800 58   56   51   45   39   33   27   26   26   17    7
    //   radius 300, reach 1100 59   59   57   54   50   50   52   62   82   90   82
    //
    // The first row is the lamp this replaces, and it is the shape of the problem
    // rather than its size: it is not dim, it *collapses*. Half its brightness is
    // gone by ninety metres and by two hundred it is a five-level haze that runs
    // on faintly for another six hundred, because its radius of 45 put the whole
    // inverse-square knee inside the first fifty metres while the range derived
    // from its intensity kept it in the march to a kilometre. A bright spot near
    // the ship and a wash beyond it is a bare bulb in fog, not a searchlight.
    //
    // The last row is the failure at the other end, and it is worth naming because
    // every number in it looks like an improvement: a beam that gets *brighter*
    // with distance, peaking at 610 m. Inverse-square falls as 1/r^2 while the
    // cone's cross-section grows as r^2, so with the falloff scale set long enough
    // the two cancel, and what gets drawn is a bar of even brightness with hard
    // sides — a solid of revolution rather than light, a paper cutout laid over
    // the sky. Brightness cannot fix it because brightness is what caused it, and
    // the metrics all say it is the best of the four. It is the one to look at.
    //
    // 150 with a reach of 800 is the row that decays the whole way and still
    // arrives: half brightness at ~170 m, useful to four hundred, tapering out by
    // six-fifty. Reach is what does the tapering — the
    // shader's window is (1 - r^2/reach^2)^2, so the last third of the beam fades
    // on a curve rather than ending, and the number the CPU culls on is the same
    // number, so nothing is drawn past where it was told the beam stops.
    // Radius went 150 -> 35 after seeing this from the cockpit rather than from
    // a side-on test pose.
    //
    // The table above is correct and its conclusion did not survive contact with
    // the actual camera. Radius 150 puts the inverse-square knee at 150 m, so
    // everything within that distance is lit above half — and the player sits at
    // the source. In the finished dark palette that rendered as two blown white
    // spheres of glowing fog filling the middle of the canopy, measured at 12.7%
    // of the frame above the blazing threshold with the beam contributing no
    // structure at all. At 35 m with a tighter cone it is 4.6%, and what is lit
    // is *cloud* rather than the air in front of the glass.
    //
    // The honest limitation, recorded so nobody re-derives it: a cone viewed
    // from its own apex is a disc, always. The ship's forward lamps cannot read
    // as beams from inside the ship. They read as beams only from outside, which
    // this game never does — so the lamp's job here is to light the mass you are
    // about to fly into, and it is tuned for that instead.
    radius: 35,
    reach: 800,
    // Inner far inside outer, which is the whole of "soft edges". The shader's
    // cone term is smoothstep(cosOuter, cosInner, ...) squared, and smoothstep
    // saturates at the inner angle — so with inner at 0.13 and outer at 0.30
    // everything within 43% of the cone's half-angle was at full strength and the
    // entire falloff was crammed into the outer 57%. That is a torch: flat, with
    // an edge. Dropping inner to 0.03 spreads the ramp across the whole cone.
    //
    // Measured, this preset, across the beam at ~310 m from the lamp: a column of
    // on-minus-off luminance every 20 px at 1280x720 reads
    //   3, 21, 60, 102, 127, 142, 165, 182, 190, 191, 186, 168, 126, 56, 7
    // — a peak of 191 on the axis with a skirt that takes seven samples, over half
    // the beam's visible width, to climb there. No plateau and no rim.
    //
    // 0.30 rad is a 17 degree half-angle. Wider than a real searchlight, and
    // deliberately: at ten degrees the beam is a line on the screen from anywhere
    // except directly behind it, and the player is directly behind it only while
    // flying straight.
    cone: { inner: 0.04, outer: 0.20 },
    shadow: 1,
    // Matched to reach. Shorter and the far end of the beam stops being occluded
    // while it is still visible, which is the same failure as the shadow gate in
    // vw_localLights and looks identical: the beam passing through a cloud.
    shadowRange: 800,
    priority: 8,
    pin: true,
    signature: true,
    photicLm: 9000,
    key: 'ship/lamp',
    ...over,
  };
}

/** Hull nav lights: the anchor table's 1200 lm, and a glow rather than a beam.
 *  Not pinned — worth a slot only when nothing else wants one. */
export function navLight(over = {}) {
  return {
    kind: LIGHT_KIND.OMNI,
    color: [0.86, 0.90, 1.00],
    intensity: 0.9,
    radius: 30,
    shadow: 1,
    shadowRange: 180,
    priority: 4,
    signature: true,
    photicLm: 1200,
    key: 'ship/nav',
    ...over,
  };
}

/** The thruster plume. Wide, short, and only partly shadowed, because the plume is
 *  an emitter in its own right and should not vanish inside cloud.
 *
 *  photicLm is 0 by design; signature.js owns the plume's lumens. See
 *  signatureLumens(). */
export function thrusterPlume(over = {}) {
  return {
    kind: LIGHT_KIND.SPOT,
    color: [0.55, 0.72, 1.00],
    intensity: 1.5,
    radius: 26,
    cone: { inner: 0.10, outer: 0.95 },
    shadow: 0.45,
    shadowRange: 220,
    priority: 5,
    pin: true,
    signature: true,
    photicLm: 0,
    key: 'ship/thruster',
    ...over,
  };
}

/** A discharge inside the cloud body. Omni, very bright, very short-lived — the
 *  intensity is expected to be driven by the storm's stroke envelope. */
export function lightningCell(over = {}) {
  return {
    kind: LIGHT_KIND.OMNI,
    color: [0.66, 0.78, 1.00],
    intensity: 0,
    radius: 900,
    shadow: 1,
    shadowRange: 1400,
    priority: 3,
    signature: false,
    key: 'storm',
    ...over,
  };
}

/** Creature bioluminescence. Cold, dim, and wide: it should light the vapour
 *  around the creature and reveal where it is without ever showing what it is. */
export function bioluminescence(over = {}) {
  return {
    kind: LIGHT_KIND.OMNI,
    color: [0.28, 0.86, 0.92],
    intensity: 1.6,
    radius: 140,
    shadow: 1,
    shadowRange: 900,
    priority: 2,
    signature: false,
    key: 'creature/lantern',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The ship's lights, as content
// ---------------------------------------------------------------------------

/**
 * Register the ship's own lights and return the handle that drives them.
 *
 * This exists because the presets above shipped with no callers anywhere: the
 * registry held four lightning cells, all switched off, `signature()` returned
 * zero, and every god-ray source the art direction names as required was absent at
 * runtime. A correct engine with no fuel in it. Putting the wiring here rather than
 * leaving it as fifteen lines of instructions for main.js keeps the lamp offsets
 * and the plume's response curve next to the numbers they have to agree with.
 *
 * Offsets are along the ship's own forward axis, in metres, and are placeholders
 * until there is a hull to measure against: the lamp sits ahead of the nose so its
 * cone is not clipped by the ship, the plume behind the tail.
 *
 *   const rig = attachShip(clouds.lights);
 *   rig.update(ship.position, ship.forward, {
 *     throttle: ship.throttleSmoothed, boost: ship.boostSmoothed, lampOn: true,
 *   });
 */
export function attachShip(registry, {
  lamp = true, plume = true, nav = true,
  lampAhead = 6, plumeAft = 8, navAhead = 0,
  lampSpec = null, plumeSpec = null, navSpec = null,
} = {}) {
  const ids = {
    lamp: lamp ? registry.add(shipLamp(lampSpec || {})) : null,
    plume: plume ? registry.add(thrusterPlume(plumeSpec || {})) : null,
    nav: nav ? registry.add(navLight(navSpec || {})) : null,
  };

  // The plume's brightness follows the same shape as its signature. signature.js
  // weights boost five times throttle (SIG.plumeBoostLm 0.25 over
  // SIG.plumeThrottleLm 0.05), so the beam the player sees and the number a
  // creature reads move together, which is the point of routing both through here.
  // PLUME_BASE is thrusterPlume's own intensity, reached at full throttle.
  const PLUME_BASE = 1.5;
  const BOOST_OVER_THROTTLE = 5;
  const PLUME_MAX = 1.6;   // boost is allowed to overdrive it by 60%, not by 500%

  const p = [0, 0, 0];
  const back = [0, 0, 0];
  const rig = {
    ids,
    /** Move and drive the ship's lights. Allocates nothing. */
    update(position, forward, { throttle = 0, boost = 0, lampOn = true, navOn = true } = {}) {
      const px = position.x ?? position[0], py = position.y ?? position[1], pz = position.z ?? position[2];
      const fx = forward.x ?? forward[0], fy = forward.y ?? forward[1], fz = forward.z ?? forward[2];

      if (ids.lamp !== null) {
        p[0] = px + fx * lampAhead; p[1] = py + fy * lampAhead; p[2] = pz + fz * lampAhead;
        registry.set(ids.lamp, { position: p, direction: forward, on: !!lampOn });
      }
      if (ids.nav !== null) {
        p[0] = px + fx * navAhead; p[1] = py + fy * navAhead; p[2] = pz + fz * navAhead;
        registry.set(ids.nav, { position: p, on: !!navOn });
      }
      if (ids.plume !== null) {
        p[0] = px - fx * plumeAft; p[1] = py - fy * plumeAft; p[2] = pz - fz * plumeAft;
        back[0] = -fx; back[1] = -fy; back[2] = -fz;
        const power = Math.min(clamp01(throttle) + BOOST_OVER_THROTTLE * clamp01(boost), PLUME_MAX);
        registry.set(ids.plume, {
          position: p,
          direction: back,
          intensity: PLUME_BASE * power,
          // An unlit thruster is not a dim thruster. Off, so it neither costs a
          // march slot nor reports a signature.
          on: power > 0.01,
        });
      }
      return rig;
    },
    /** Kill the lamp without touching anything else — the thing a player does the
     *  moment they think something heard them. */
    setLamp(on) { if (ids.lamp !== null) registry.set(ids.lamp, { on: !!on }); return rig; },
    /** Lumens the ship is radiating right now, for the signature bus. */
    lumens() { return registry.signatureLumens(); },
    dispose() { for (const id of Object.values(ids)) if (id !== null) registry.remove(id); },
  };
  return rig;
}

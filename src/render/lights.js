// Local light sources for the volumetric march.
//
// Interface:
//
//   const lights = new LightRegistry();
//   const lamp = lights.add(shipLamp({ key: 'lamp/port' }));
//   lights.set(lamp, { position: [x, y, z], direction: [dx, dy, dz], on: true });
//   lights.remove(lamp);
//
//   lights.prepare(camPos, viewDir);        // choose this frame's bounded set
//   lights.writeUniforms(uniforms, origin); // pack it for the shader
//   lights.signature();                     // how loudly the ship is broadcasting
//
// The cloud march asks this registry a question at every step it takes, so the
// interesting problem here is not what a light looks like but how many of them
// the march can afford. Three decisions carry that:
//
//   * The set handed to the GPU is bounded at MAX_MARCH_LIGHTS and chosen per
//     frame by importance. A scene may hold any number of lights and the shader
//     cost does not move.
//   * Occlusion — the only part that costs texture fetches — is marched for at
//     most MAX_SHADOWED_LIGHTS of them, and the shader skips even that wherever
//     the light's unoccluded contribution is below a cutoff. In practice that
//     confines the shadow march to the few hundred metres around a lamp, which
//     is the only place a viewer could identify its shadow anyway.
//   * Everything else is analytic. A distant creature's glow is a falloff and a
//     phase function, and it is wrong in a way nobody can point at from inside a
//     cloud.
//
// Why this exists at all, beyond looking good: the ship's lights are a
// detectable signature. The shafts the player casts are the visible evidence
// that they are broadcasting, so the beam has to be something the player can see
// themselves making. That is why `intensity` is not a free parameter — it is the
// same number the signature system reads out of `signature()`, and turning the
// lamps up to fix a dark frame is the same act as making the ship easier to find.
//
// Units. Intensity is radiance in the same arbitrary scale as CLOUD_PALETTE.sun,
// which is 3.20 in red. A ship lamp at 5 is comfortably the brightest thing in
// frame without being the only thing. `radius` is the distance at which the
// inverse-square falloff has dropped to one half, not a hard cut-off.

import { clamp01 } from '../core/math.js';

/** How many lights the march program is compiled to read. Must match the
 *  MAX_LIGHTS define in clouds.js — clouds.js imports this rather than
 *  restating it, so there is one number. */
export const MAX_MARCH_LIGHTS = 8;

/** How many of those may carry a shadow march. Each one costs
 *  LIGHT_SHADOW_TAPS density samples at every march step that is close enough to
 *  it to matter, which is affordable two at a time and not four. */
export const MAX_SHADOWED_LIGHTS = 2;

export const LIGHT_KIND = { OMNI: 'omni', SPOT: 'spot' };

// An omni light is a spot whose cone contains every direction. Encoding it that
// way rather than with a kind flag removes a branch from the innermost loop in
// the whole renderer, and the loop runs a few hundred times per pixel.
const OMNI_COS_OUTER = -2.0;
const OMNI_COS_INNER = -1.2;

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
  /** Multiplies the importance score. The ship's own lamps set this high: a
   *  player who cannot see the beam they are casting cannot read their own
   *  signature, and that feedback loop matters more than a correct sort. */
  priority: 1,
  /** Counted by signature(). False for lights that are not the ship's — a
   *  creature's glow gives away the creature, not the player. */
  signature: false,
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
    Object.assign(this, {
      kind: DEFAULTS.kind,
      intensity: DEFAULTS.intensity,
      radius: DEFAULTS.radius,
      cone: { ...DEFAULTS.cone },
      shadow: DEFAULTS.shadow,
      shadowRange: DEFAULTS.shadowRange,
      priority: DEFAULTS.priority,
      signature: DEFAULTS.signature,
      on: DEFAULTS.on,
      key: DEFAULTS.key,
    });
    this.apply(spec);
  }

  apply(p) {
    if (!p) return this;
    if (p.position) setVec(this.position, p.position);
    if (p.direction) setVec(this.direction, p.direction, true);
    if (p.color) setVec(this.color, p.color);
    if (p.cone) this.cone = { inner: p.cone.inner ?? this.cone.inner, outer: p.cone.outer ?? this.cone.outer };
    for (const k of ['kind', 'intensity', 'radius', 'shadow', 'shadowRange', 'priority', 'signature', 'on', 'key']) {
      if (p[k] !== undefined) this[k] = p[k];
    }
    return this;
  }

  /** Distance past which this light is skipped outright, in metres.
   *
   *  Derived rather than authored, because the number that matters is where the
   *  light stops being visible and that depends on both its radius and how
   *  bright it is. The march squares this and compares, so a light 900 m away
   *  costs one subtract and one dot product. */
  range() {
    const lum = this.intensity * Math.max(this.color[0], this.color[1], this.color[2]);
    // att(r) = 1 / (1 + (r/radius)^2); solve for att * lum = CUT. The shader
    // windows the falloff to zero exactly here, so this is not a visible edge —
    // it is only how much volume the march has to consider, and every metre of
    // it is a per-step distance test in the innermost loop of the renderer.
    const CUT = 0.01;
    const k = Math.max(lum / CUT - 1, 0);
    return this.radius * Math.min(Math.sqrt(k), 40);
  }
}

function setVec(dst, src, normalise = false) {
  if (Array.isArray(src)) { dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; }
  else { dst[0] = src.x; dst[1] = src.y; dst[2] = src.z; }
  if (normalise) {
    const n = Math.hypot(dst[0], dst[1], dst[2]) || 1;
    dst[0] /= n; dst[1] /= n; dst[2] /= n;
  }
  return dst;
}

export class LightRegistry {
  constructor({ max = MAX_MARCH_LIGHTS, maxShadowed = MAX_SHADOWED_LIGHTS } = {}) {
    this.max = Math.min(max, MAX_MARCH_LIGHTS);
    this.maxShadowed = Math.min(maxShadowed, this.max);
    this.lights = new Map();
    /** The bounded set chosen by the last prepare(), in the order the shader
     *  will read them. Public because a capture that cannot say which lights
     *  were live is not evidence of anything. */
    this.active = [];
    this._scored = [];
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
  remove(id) { return this.lights.delete(id); }
  clear() { this.lights.clear(); this.active.length = 0; return this; }

  /**
   * Choose this frame's set.
   *
   * The score approximates how much of the frame a light can affect: its
   * luminous output attenuated over the distance to the camera, on a curve
   * three times wider than its own falloff, because a light 200 m ahead lights
   * the air the player is about to fly through even when the point the camera
   * sits at is outside its radius. Lights behind the camera are penalised but
   * not excluded — the volume beside the ship is on screen at the frame edges,
   * and a lamp popping out of the set as the player turns is worse than a lamp
   * that costs a little when it is not needed.
   *
   * Ties break on insertion id, so the set is a pure function of the scene and
   * two captures of the same simulation time agree.
   */
  prepare(camPos, viewDir = null) {
    const cx = camPos.x ?? camPos[0], cy = camPos.y ?? camPos[1], cz = camPos.z ?? camPos[2];
    const scored = this._scored;
    scored.length = 0;

    for (const l of this.lights.values()) {
      if (!l.on || l.intensity <= 0) continue;
      const dx = l.position[0] - cx, dy = l.position[1] - cy, dz = l.position[2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const range = l.range();
      if (d2 > range * range) continue;

      const lum = l.intensity * Math.max(l.color[0], l.color[1], l.color[2]);
      const soft = l.radius * 3;
      let score = (lum * l.priority) / (1 + d2 / (soft * soft));
      if (viewDir) {
        const n = Math.sqrt(d2) || 1;
        const facing = (dx * (viewDir.x ?? viewDir[0]) + dy * (viewDir.y ?? viewDir[1]) + dz * (viewDir.z ?? viewDir[2])) / n;
        score *= 0.45 + 0.55 * clamp01(facing * 0.5 + 0.75);
      }
      scored.push({ l, score });
    }

    scored.sort((a, b) => (b.score - a.score) || (a.l.id - b.l.id));

    this.active.length = 0;
    let shadowed = 0;
    for (let i = 0; i < scored.length && this.active.length < this.max; i++) {
      const l = scored[i].l;
      // Shadowing is spent on the loudest few. A lamp whose beam the player is
      // looking down needs its occlusion; the fourth-brightest glow two
      // kilometres away does not, and paying for it there is how a shader that
      // fits the budget stops fitting it when the scene gets busy.
      l._shadowThisFrame = (l.shadow > 0 && shadowed < this.maxShadowed) ? l.shadow : 0;
      if (l._shadowThisFrame > 0) shadowed++;
      this.active.push(l);
    }
    return this.active;
  }

  /**
   * Pack the active set into the march's uniform arrays.
   *
   * `origin` is the cloud system's recentred origin: everything the shader sees
   * is in cloud space, and a light left in world space would slide by a whole
   * quantum the moment the player crosses one.
   */
  writeUniforms(u, origin = { x: 0, y: 0, z: 0 }) {
    const n = this.active.length;
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
   * Total luminous output of the lights flagged as the player's, before any
   * occlusion.
   *
   * The signature system needs one number for "how loudly is the ship
   * broadcasting", and it has to be the same number the renderer is drawing
   * with or the player will learn to distrust it. Occlusion is deliberately not
   * applied: hiding a lamp inside a cloud reduces what reaches a given observer,
   * which is that observer's line-of-sight problem — CloudSystem.transmittance()
   * — not a property of the ship.
   */
  signature() {
    let sum = 0;
    for (const l of this.lights.values()) {
      if (!l.on || !l.signature) continue;
      sum += l.intensity * Math.max(l.color[0], l.color[1], l.color[2]);
    }
    return sum;
  }

  /** What the march is actually reading, for a report or an overlay. */
  debugSummary() {
    return {
      registered: this.lights.size,
      active: this.active.length,
      shadowed: this.active.filter((l) => l._shadowThisFrame > 0).length,
      signature: +this.signature().toFixed(3),
      keys: this.active.map((l) => l.key || `#${l.id}`),
    };
  }
}

// ---------------------------------------------------------------------------
// Presets
//
// The required consumers from the art direction, as parameter sets rather than
// as prose, so that the ship and the creatures do not each invent their own idea
// of how bright a lamp is. Every one of them is a spec object for add().
// ---------------------------------------------------------------------------

/** The ship's forward exterior lamp. Narrow enough to read as a beam and bright
 *  enough to be the thing that gives the player away. */
export function shipLamp(over = {}) {
  return {
    kind: LIGHT_KIND.SPOT,
    color: [1.00, 0.94, 0.82],
    intensity: 5.0,
    radius: 55,
    cone: { inner: 0.13, outer: 0.30 },
    shadow: 1,
    shadowRange: 600,
    priority: 8,
    signature: true,
    key: 'ship/lamp',
    ...over,
  };
}

/** The thruster plume. Wide, short, and only partly shadowed, because the plume
 *  is an emitter in its own right and should not vanish inside cloud. */
export function thrusterPlume(over = {}) {
  return {
    kind: LIGHT_KIND.SPOT,
    color: [0.55, 0.72, 1.00],
    intensity: 2.2,
    radius: 26,
    cone: { inner: 0.35, outer: 0.95 },
    shadow: 0.45,
    shadowRange: 220,
    priority: 5,
    signature: true,
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

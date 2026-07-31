// Making the creatures visible.
//
//   import { CreatureRenderer } from './render/creatures.js';
//   const views = new CreatureRenderer({ scene, clouds });
//   views.sync(creatures);           // once per frame, after creatures.update
//
// Until now nothing in this game had a body. The Listener is 240 m long, the
// Lantern's entire design is a light that goes out, the Choir is a shoal
// kilometres across — and none of them existed anywhere except in the
// simulation. A creature you cannot see is not frightening, it is a number, and
// the Lantern's dimming in particular is the best mechanic in the roster and was
// completely unobservable.
//
// --- how a body survives a volumetric renderer -------------------------------
//
// These are ordinary meshes in the ordinary scene. That is not a compromise: the
// cloud pass composites against the scene buffer using real depth, so solid
// geometry is occluded by cloud correctly and for free — the cockpit already
// relies on this. A creature half inside a mass is half hidden, with no work
// here at all, and that is exactly the relationship the game wants between the
// weather and the things living in it.
//
// --- the rule every body obeys ----------------------------------------------
//
// **You should almost never see one clearly.** GAME_VISION asks for partial
// visibility as a default state rather than an effect, and ART_DIRECTION asks
// for silhouettes that read unambiguously even when the shape does not. So the
// bodies here are dark, matte and low in contrast against the medium: what
// carries them is outline, occlusion and the light they make themselves. A
// creature rendered bright enough to admire is a creature that has stopped being
// a threat.
//
// The one exception is deliberate. The Lantern advertises. It is *supposed* to be
// beautiful at distance, because §10.2 is built on you approaching it.

import * as THREE from 'three';
import { clamp01 } from '../core/math.js';

/**
 * Distances at which a body stops being worth its triangles.
 *
 * The creatures are enormous, so these are much further out than they would be
 * for anything human-sized: a 240 m body still subtends a usable angle at four
 * kilometres, which is roughly where the Listener starts to matter.
 */
export const LOD = {
  /** Beyond this a body is not drawn at all. */
  cull: 14000,
  /** Beyond this it is a silhouette with no detail. */
  far: 4500,
  /** Inside this it gets whatever detail it has. */
  near: 1200,
};

/**
 * The palette a body is allowed.
 *
 * Deliberately narrow, and deliberately dark. These are multiplied by the
 * luminaries through ordinary scene lighting, so a creature is lit by whatever
 * is currently in the sky and shifts with it — a Listener under the ember is a
 * different-looking animal from the same Listener under the veil, without a
 * single line arranging it.
 */
export const FLESH = {
  /** Almost black, very slightly warm — organic rather than mineral. */
  hull: 0x0b0d10,
  /** What little light does bounce off it. */
  roughness: 0.94,
  /** A faint rim, so an edge reads against dark cloud without a light on it. */
  rim: 0x1c2a33,
};

/** Base class: an Object3D that tracks one creature. */
export class CreatureView {
  /**
   * @param {object} creature the simulation object; never mutated from here
   * @param {object} opts
   */
  constructor(creature, opts = {}) {
    this.creature = creature;
    this.object3D = new THREE.Group();
    this.object3D.matrixAutoUpdate = true;
    this.visible = true;
    this.lodLevel = 'near';
    this._v = new THREE.Vector3();
    this._built = false;
    this.opts = opts;
  }

  /** Subclasses build geometry here, once, on first sync. */
  build() { this._built = true; }

  /** Subclasses override to animate. `d` is distance to camera. */
  step(dt, d, ctx) {}

  /**
   * @param {number} dt
   * @param {THREE.Vector3} camPos
   * @param {object} ctx anything the archetype needs (clouds, time, lights)
   */
  sync(dt, camPos, ctx) {
    if (!this._built) this.build(ctx);
    const p = this.creature.position;
    this.object3D.position.set(p.x, p.y, p.z);

    const d = this._v.set(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z).length();
    const dormant = !!this.creature.dormant;
    const show = !dormant && d < LOD.cull;
    if (this.object3D.visible !== show) this.object3D.visible = show;
    this.visible = show;
    if (!show) return this;

    this.lodLevel = d > LOD.far ? 'far' : d > LOD.near ? 'mid' : 'near';

    // Heading, so a body points where it is going. Creatures carry a heading in
    // radians rather than a quaternion — they are animals, not aircraft, and
    // nothing in the contract ever rolls one.
    if (typeof this.creature.heading === 'number') {
      this.object3D.rotation.y = this.creature.heading;
    }

    this.step(dt, d, ctx);
    return this;
  }

  dispose() {
    this.object3D.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }
}

/**
 * Manages one view per creature.
 *
 * The registry is keyed on the creature object itself rather than an id, so a
 * creature that is replaced rather than mutated cannot leave a body behind.
 */
export class CreatureRenderer {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {object} [opts.clouds] for density queries and the light registry
   * @param {Map<string,Function>} [opts.factories] archetype -> view constructor
   */
  constructor({ scene, clouds = null, factories = new Map() } = {}) {
    this.scene = scene;
    this.clouds = clouds;
    this.factories = factories;
    this.views = new Map();
    this._camPos = new THREE.Vector3();
    /** Archetypes seen with no factory registered, so the gap is reportable. */
    this.unrendered = new Set();
  }

  register(archetype, factory) { this.factories.set(archetype, factory); return this; }

  /**
   * @param {object} manager a CreatureManager
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {object} [ctx]
   */
  sync(manager, dt, camera, ctx = {}) {
    if (!manager || !camera) return this;
    camera.getWorldPosition(this._camPos);
    const live = manager.creatures || [];

    for (const c of live) {
      let v = this.views.get(c);
      if (!v) {
        const make = this.factories.get(c.archetype);
        if (!make) { this.unrendered.add(c.archetype); continue; }
        v = make(c, { clouds: this.clouds });
        this.views.set(c, v);
        this.scene.add(v.object3D);
      }
      v.sync(dt, this._camPos, { ...ctx, clouds: this.clouds });
    }

    // Anything whose creature is gone loses its body the same frame.
    if (this.views.size > live.length) {
      const alive = new Set(live);
      for (const [c, v] of this.views) {
        if (alive.has(c)) continue;
        this.scene.remove(v.object3D);
        v.dispose();
        this.views.delete(c);
      }
    }
    return this;
  }

  snapshot() {
    const byLod = { near: 0, mid: 0, far: 0, hidden: 0 };
    for (const v of this.views.values()) {
      if (!v.visible) byLod.hidden++; else byLod[v.lodLevel]++;
    }
    return {
      bodies: this.views.size,
      ...byLod,
      unrendered: [...this.unrendered],
    };
  }
}

/**
 * A dark, matte material for flesh.
 *
 * Shared rather than per-body: these creatures are the same substance, and one
 * material means one draw-call state for however many of them are on screen.
 */
export function fleshMaterial(overrides = {}) {
  return new THREE.MeshStandardMaterial({
    color: FLESH.hull,
    roughness: FLESH.roughness,
    metalness: 0.0,
    // A faint self-colour so an edge is not pure black against a dark sky. This
    // is not emission in the game's sense — it costs nothing on the photic
    // channel and no creature can see it; it exists so a silhouette reads.
    emissive: FLESH.rim,
    emissiveIntensity: 0.22,
    flatShading: false,
    ...overrides,
  });
}

/**
 * An emissive material for the things that genuinely glow.
 *
 * `lumens` is the simulation's number, so what you see and what the signature
 * system says a creature is emitting cannot drift apart.
 */
export function glowMaterial(color, lumens = 1000, overrides = {}) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 1,
    depthWrite: true,
    ...overrides,
  });
  m.userData.setLumens = (lm) => {
    // Perceptual rather than linear: a lamp at a tenth of its lumens does not
    // look a tenth as bright, and the Lantern's dimming has to be legible across
    // three orders of magnitude.
    m.opacity = clamp01(Math.pow(clamp01(lm / Math.max(lumens, 1e-3)), 0.42));
  };
  return m;
}

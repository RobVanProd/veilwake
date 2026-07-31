// VEILWAKE — bootstrap.
//
// Phase 0: prove the whole pipeline before any game exists. Three.js on a
// preserved drawing buffer, a fixed-step loop, deterministic capture to disk,
// and diagnostics that can be read without seeing the screen.
//
// The load-bearing constraint, learned the expensive way on a previous project:
// requestAnimationFrame does not run while the browser pane is hidden, which is
// how this is developed. A normal screenshot times out and the simulation never
// advances. So the render path must be callable explicitly, the drawing buffer
// must be preserved, and the result has to be POSTed somewhere a file reader can
// reach it. Every visual claim about this game is checked that way.

import * as THREE from 'three';
import { Loop } from './core/loop.js';
import { Rng, seedFrom } from './core/rng.js';
import { BUDGET } from './core/perf.js';
import { CloudSystem } from './render/clouds.js';
import { shipLamp, thrusterPlume } from './render/lights.js';
import { Flight } from './game/flight.js';
import { ShipCamera } from './game/camera.js';
import { Controls } from './game/controls.js';
import { Input } from './core/input.js';
import { Pointer } from './core/pointer.js';
import { Gamepad } from './core/gamepad.js';
import { Signature } from './game/signature.js';
import { ShipSystems } from './game/systems.js';
import { Listener } from './game/creatures/listener.js';
import {
  createMedium, countingMedium, createSignatureView, formatEvent,
  promoteByDistance, enforceSingleCommitted, RNG_TAG,
} from './game/creatures/creature.js';

const canvas = document.getElementById('gl');
const diagEl = document.getElementById('diag');
const bootEl = document.getElementById('boot');

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,        // resolved in post; MSAA costs more than it returns
                           // on an image that is mostly volumetric
  alpha: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  // Captures must be able to read the buffer back after the draw has completed.
  preserveDrawingBuffer: true,
});

renderer.setClearColor(0x05070b, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Device pixel ratio is capped. An uncapped ratio on a 4K display quadruples the
// cost of a full-screen ray march for a difference nobody can see, and it is the
// most common reason a browser game is inexplicably slow on good hardware.
const MAX_DPR = 1.5;

const scene = new THREE.Scene();
// No scene fog: the cloud composite applies its own aerial perspective to
// geometry, and the two stack into a grey wash.

const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 12000);
camera.position.set(0, 0, 0);

const rng = new Rng(seedFrom('veilwake:phase0'));
const clouds = new CloudSystem({ renderer, seed: 'veilwake', quality: 'high' });

const input = new Input(canvas);
const pointer = new Pointer(canvas);
const ship = new Flight({ rng });
const pad = new Gamepad();
const controls = new Controls(input, pointer, pad);
const shipCam = new ShipCamera(camera);

// Start inside the cloud layer rather than above it. Where the camera sits is
// art direction here, not scene setup: the same renderer looks like a flight sim
// from above the layer and like this game from inside it.
ship.position.set(0, 140, 0);

// ---------------------------------------------------------------------------
// Signature, systems, creatures
//
// **UNVERIFIED.** Everything from here to the end of this block was written
// without a GPU, a browser or a display, so it has never been loaded. Every
// module it wires has been measured headless — 114 cases in tests/index.html
// pass in node — but the wiring itself has not, and a broken module graph has
// taken this page down before. The first browser pass should check, in order:
// that the page boots at all, that GAME.sig() returns six channels that move
// with the throttle, that GAME.creatureStates() shows a Listener promoted to
// 'full' when it is close, and that the frame time survives the plume light.
//
// On that last point, from the audit and NOT re-measurable here: the volumetric
// pass costs about +1.57 ms per active light and blows its 7 ms budget at three.
// MAX_MARCH_LIGHTS is still 8. It is left alone because those timings were taken
// against a shader that was being rewritten during the audit and the audit says
// so; re-measure with clouds.benchPass before trusting either number. The search
// lamp is off by default, so the steady state here is one extra light (the
// plume, and only above idle throttle).
// ---------------------------------------------------------------------------

const lampId = clouds.lights.add(shipLamp({ on: false }));
const plumeId = clouds.lights.add(thrusterPlume({ on: false }));

const signature = new Signature({ medium: clouds });
const systems = new ShipSystems({ lights: clouds.lights, lampId });

// createSignatureView must be given the RECORDER, not the Signature. Signature
// has no sampleAt/at/historyAt, so the adapter would report hasHistory:false and
// silently degrade to reading the present as though it were the past — which
// destroys the propagation delay that the whole acoustic sense is built on.
const sigView = createSignatureView(signature.recorder);
const creatureMedium = countingMedium(createMedium(clouds));

// One Listener, off to the side of the start point and patrolling its own
// territory. Nothing spawns creatures yet; this exists so the layer is reachable
// and so a capture can show a real detection log.
const creatures = [
  new Listener({
    id: 0,
    rng: rng.fork(RNG_TAG.LISTENER),
    position: { x: 4200, y: 140, z: -3000 },
    territory: { x: 4200, z: -3000 },
    senseOffset: 0,
  }),
];

/** Reused every step. Allocating one of these per creature per step is 120 Hz
 *  of garbage in a game whose worst enemy is a collector pause mid-encounter. */
const creatureCtx = {
  tick: 0, t: 0, medium: creatureMedium, signature: sigView,
  shipPos: ship.position, shipVel: ship.velocity,
};

// Promotion and the one-COMMITTED rule both live in creature.js, above the
// Creature class, because a creature cannot see its peers — and because in here
// they could not be tested, which is how both of them were wrong the first time.
const PROMOTE_MAX = 6;
/** Steps between promotion passes. A creature that crosses `promotionRadius`
 *  (16.8 km for a FAR_PLANE sensor) at 20 m/s takes four minutes to cover the
 *  4.8 km of margin the radius exists to provide, so 4 Hz is generous. */
const PROMOTE_PERIOD = 30;
const _promotionOrder = [];

const LAMP_FWD = new THREE.Vector3();
const LAMP_POS = new THREE.Vector3();

// ---------------------------------------------------------------------------
// A placeholder scene, purely to prove the pipeline.
//
// Nothing here survives into the game. It exists so that a capture has something
// unambiguous in it: if the horizon is level, the scale markers recede correctly
// and the light falls off, then the camera, the projection, the depth buffer and
// the tone mapping are all doing what they should.
// ---------------------------------------------------------------------------
const key = new THREE.DirectionalLight(0xbcd4ef, 2.2);
// The placeholder light follows the clouds' sun, so geometry and volume agree
// about where the light is coming from.
key.position.copy(clouds.sun);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9db6d6, 0x0a0f16, 0.55));

const markers = new THREE.Group();
scene.add(markers);
{
  // Scale references at known distances, so a capture reports whether the world
  // is the size the numbers say it is.
  const geo = new THREE.BoxGeometry(30, 30, 30);
  for (let i = 1; i <= 12; i++) {
    const d = i * 220;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.58, 0.25, 0.18 + i * 0.03),
      roughness: 0.85, metalness: 0.0,
    }));
    m.position.set(Math.sin(i * 1.7) * d * 0.22, Math.cos(i * 2.3) * d * 0.10 - 40, -d);
    m.rotation.set(rng.float(), rng.float(), rng.float());
    markers.add(m);
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20000, 20000, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x0b1420, roughness: 1.0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -400;
  scene.add(floor);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const state = { heading: 0 };

function update(dt, tick) {
  pad.update();
  controls.update(dt).applyTo(ship);

  // The medium pushes back. Turbulence is an acceleration on the body, not
  // screen shake: the player has to fly against it, and the camera shakes only
  // because the ship did.
  const flow = clouds.flowAt ? clouds.flowAt(ship.position.x, ship.position.y, ship.position.z) : null;
  const density = clouds.densityAt
    ? clouds.densityAt(ship.position.x, ship.position.y, ship.position.z) : 0;
  if (flow) {
    TURB.set(flow.x, flow.y, flow.z).multiplyScalar(2.4 * (0.25 + density));
    // A little chop that scales with density and speed, so thick cloud is
    // physically harder to fly through and the player can feel where they are.
    const chop = density * Math.min(ship.speed / 120, 1.5) * 3.2;
    TURB.x += Math.sin(loop.simTime * 3.1 + 1.7) * chop;
    TURB.y += Math.sin(loop.simTime * 2.3) * chop * 0.7;
    TURB.z += Math.sin(loop.simTime * 2.9 + 4.1) * chop * 0.5;
    ship.setTurbulence(TURB, Math.min(density * 1.6, 1));
  }

  ship.step(dt);

  // AFTER ship.step and before anything reads the signature. _kinematics reads
  // ship.velocity, gLoad and slipAngle, and flight.js only writes the last two
  // at the end of step() — calling before it reads last frame's manoeuvre.
  signature.update(dt, ship, systems);

  // The ship's own lights. Position and direction belong here because this is
  // what knows where the ship is pointing; whether they are ON belongs to
  // ShipSystems, which publishes their lumens. A zero direction vector survives
  // normalisation and turns a spot silently black while it still counts toward
  // the signature, so these are seeded from the ship's forward axis and never
  // from an unpopulated vector.
  LAMP_FWD.copy(ship.forward);
  LAMP_POS.copy(ship.position).addScaledVector(LAMP_FWD, 2.0);
  clouds.lights.set(lampId, {
    position: [LAMP_POS.x, LAMP_POS.y, LAMP_POS.z],
    direction: [LAMP_FWD.x, LAMP_FWD.y, LAMP_FWD.z],
  });
  LAMP_POS.copy(ship.position).addScaledVector(LAMP_FWD, -3.0);
  clouds.lights.set(plumeId, {
    position: [LAMP_POS.x, LAMP_POS.y, LAMP_POS.z],
    direction: [-LAMP_FWD.x, -LAMP_FWD.y, -LAMP_FWD.z],
    intensity: 1.5 * (0.15 + 0.85 * ship.throttleSmoothed),
    on: ship.throttleSmoothed > 0.01,
  });

  // Note the clock. `loop.simTime` is the time at the START of this step and
  // `Signature` keeps its own, incremented at the top of its update, so
  // signature.time runs exactly one step (8.3 ms) ahead of creatureCtx.t. That
  // is a fortieth of the recorder's 0.5 s bucket and it is stated here rather
  // than left for someone to find; if the two ever need to agree exactly, pass
  // loop.simTime into signature.update rather than adjusting here.
  loop.perf.begin('ai');
  creatureCtx.tick = tick;
  creatureCtx.t = loop.simTime;
  if (tick % PROMOTE_PERIOD === 0) {
    promoteByDistance(creatures, ship.position, creatureCtx, PROMOTE_MAX, _promotionOrder);
  }
  for (const c of creatures) c.update(dt, tick, creatureCtx);
  enforceSingleCommitted(creatures, creatureCtx);
  loop.perf.end('ai');

  controls.updateRumble(ship, { electrical: 0, damage: 0 });
  shipCam.update(ship, dt, loop.simTime);

  markers.rotation.y = (state.heading += dt * 0.06) * 0.15;
  clouds.update(dt, camera);
  input.endFrame();
  pointer.endFrame();
}

const TURB = new THREE.Vector3();

/** When set, render() uses this size instead of the element's. Capture only. */
let forcedSize = null;

function sizeTo(w, h) {
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
    renderer.setSize(w, h, false);
  }
  const aspect = w / Math.max(h, 1);
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
}

function render() {
  if (forcedSize) {
    sizeTo(forcedSize[0], forcedSize[1]);
  } else {
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    sizeTo(Math.max(1, Math.round(canvas.clientWidth * dpr)),
           Math.max(1, Math.round(canvas.clientHeight * dpr)));
  }
  clouds.renderFrame(renderer, scene, camera);
}

const loop = new Loop({ hz: 120, update, render });

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
let diagTimer = 0;
const baseRender = loop.render;
loop.render = (alpha, frameMs) => {
  baseRender(alpha, frameMs);
  diagTimer += frameMs;
  if (diagTimer < 250) return;
  diagTimer = 0;
  const s = loop.perf.stats();
  const v = loop.perf.violations();
  const info = renderer.info;
  diagEl.innerHTML =
    `<b>VEILWAKE</b>  phase 0\n` +
    `${renderer.domElement.width}x${renderer.domElement.height}\n` +
    `fps ${s.fps.toFixed(0)}  med ${s.median.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)}\n` +
    `worst ${s.worst.toFixed(1)}  hitches ${s.hitches}\n` +
    `draws ${info.render.calls}  tris ${info.render.triangles}\n` +
    `t ${loop.simTime.toFixed(1)}s  ai ${(loop.perf.marks.get('ai') ?? 0).toFixed(3)}ms\n` +
    // A capture that cannot say which lights were live is not evidence of
    // anything, and neither is one that cannot say what the ship was emitting.
    `lights ${JSON.stringify(clouds.lights.debugSummary().keys)}\n` +
    `sig ac ${signature.acoustic.toFixed(1)} th ${signature.thermal.toFixed(1)} ` +
    `ph ${signature.photic.toFixed(0)} em ${signature.em.toFixed(2)} wk ${signature.wake.toFixed(2)}\n` +
    creatures.map((c) => `${c.archetype}#${c.id} ${c.state} ${c.attention.toFixed(2)} ` +
      `${c.simLevel}${c.silent ? ' LISTENING' : ''}`).join('\n') + '\n' +
    (v.length ? `<span class="bad">${v.join('; ')}</span>` : 'budget ok');
};

globalThis.GAME = {
  THREE, renderer, scene, camera, loop, rng, BUDGET, clouds,
  ship, controls, shipCam, input, pointer, pad,
  lights: clouds.lights,
  signature, systems, creatures,
  stats: () => loop.perf.stats(),
  violations: () => loop.perf.violations(),

  // --- the signature, as the player would read it -------------------------
  // report() and breakdown() both allocate, so call them at 10 Hz or slower.
  // signature.values() is safe per-frame; it returns a reused object.
  sig: () => signature.report(),
  sigBreakdown: (channel) => signature.breakdown(channel),
  exposure: () => signature.exposure(),
  trails: () => signature.trailStats(),

  // --- §7 requires this by name -------------------------------------------
  detectionLog: () => creatures
    .flatMap((c) => c.detectionLog())
    .sort((a, b) => a.simTime - b.simTime)
    .slice(-64),
  detectionLines: () => GAME.detectionLog().map(formatEvent),
  creatureStates: () => creatures.map((c) => c.snapshot()),

  /** Advance the simulation to an exact time by whole fixed steps. */
  seek(seconds) {
    const steps = Math.round(seconds / loop.stepSec) - loop.tick;
    if (steps > 0) loop.stepHeadless(steps);
    return loop.simTime;
  },

  diag(on) { diagEl.classList.toggle('hidden', !on); },

  /**
   * Deterministic screenshot, written to evidence/ on the server.
   *
   * The project's eyes. Explicit render into a preserved buffer, so it works
   * whether or not the page is compositing, and POSTed back so it can be read as
   * a file rather than looked at.
   */
  async capture({ name = 'capture.png', width = 1600, height = 900, at = null, ui = false } = {}) {
    const wasRunning = loop.running;
    loop.stop();
    if (at !== null) this.seek(at);
    if (!ui) diagEl.classList.add('hidden');
    forcedSize = [width, height];
    render();
    // The draw is queued, not finished. Reading back without a flush races the
    // GPU and returns the previous frame.
    renderer.getContext().finish();
    const dataUrl = canvas.toDataURL('image/png');
    forcedSize = null;
    if (!ui) diagEl.classList.remove('hidden');
    const res = await fetch(`/__evidence/${encodeURIComponent(name)}`, { method: 'POST', body: dataUrl });
    const out = await res.json();
    if (wasRunning) loop.start();
    return out;
  },

  /**
   * Time the render path at a real resolution.
   *
   * Separate from the frame statistics because those depend on rAF, which does
   * not run when the pane is hidden. This drives the renderer directly, so it
   * produces a number under any circumstances — with the caveat, recorded
   * honestly, that a non-compositing pane may let the driver discard work.
   */
  benchRender({ width = 1920, height = 1080, frames = 60 } = {}) {
    const wasRunning = loop.running;
    loop.stop();
    forcedSize = [width, height];
    const gl = renderer.getContext();
    render(); gl.finish();
    const ts = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      update(loop.stepSec);
      render();
      gl.finish();
      ts.push(performance.now() - t0);
    }
    forcedSize = null;
    if (wasRunning) loop.start();
    ts.sort((a, b) => a - b);
    const at = (p) => ts[Math.min(ts.length - 1, Math.round((p / 100) * (ts.length - 1)))];
    return {
      resolution: [width, height], frames,
      median: +at(50).toFixed(3), p95: +at(95).toFixed(3), p99: +at(99).toFixed(3),
      worst: +ts[ts.length - 1].toFixed(3),
      budgetRender: BUDGET.render,
      withinBudget: at(99) < BUDGET.render,
    };
  },

  ready: true,
};

loop.start();
bootEl.classList.add('gone');
setTimeout(() => bootEl.remove(), 800);

console.log('[veilwake] phase 0 running', {
  three: THREE.REVISION,
  renderer: renderer.getContext().getParameter(renderer.getContext().VERSION),
  maxTexture: renderer.capabilities.maxTextureSize,
  float: renderer.capabilities.isWebGL2,
});

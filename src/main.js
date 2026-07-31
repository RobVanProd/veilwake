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

// The ship's own lights.
//
// Registering these is the point at which the renderer's local-light path stops
// being dead code: nothing else in the project ever called shipLamp(), so the
// registry held four switched-off storm slots and signature() returned 0.
//
// It also fixes the half of the frame the palette pass could not. Facing into
// the sun the world now reads at 15.8% blazing; facing away it read 0.18% —
// correctly dark, with nothing in it to look at. These are what goes in it. In a
// world this dark the lamp is not a convenience, it is the only thing the player
// owns that pushes back on it, and it is also the loudest thing they can do on
// the photic channel. Beauty is the bait.
const lampL = clouds.lights.add(shipLamp({ key: 'ship/lamp/port' }));
const lampR = clouds.lights.add(shipLamp({ key: 'ship/lamp/stbd' }));
const plume = clouds.lights.add(thrusterPlume({ key: 'ship/thruster' }));

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

function update(dt) {
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
  controls.updateRumble(ship, { electrical: 0, damage: 0 });
  shipCam.update(ship, dt, loop.simTime);

  markers.rotation.y = (state.heading += dt * 0.06) * 0.15;

  // Drive the ship's lights from where the ship actually is, before clouds.update
  // so the registry's per-frame importance sort sees this frame's positions
  // rather than last frame's. The lamps sit off the hull centreline so the two
  // beams diverge slightly — a single centred lamp reads as a torch taped to a
  // camera, two read as a vehicle.
  const p = ship.position, f = ship.forward, r = ship.right;
  const on = controls.lightsOn;
  clouds.lights.set(lampL, { on, position: [p.x - r.x * 1.4, p.y, p.z - r.z * 1.4], direction: [f.x, f.y, f.z] });
  clouds.lights.set(lampR, { on, position: [p.x + r.x * 1.4, p.y, p.z + r.z * 1.4], direction: [f.x, f.y, f.z] });
  // The plume is never off — an engine under power glows whether the pilot likes
  // it or not, which is what makes throttle a signature decision rather than a
  // free one.
  clouds.lights.set(plume, {
    on: true,
    intensity: 1.5 * (ship.input.throttle || 0),
    position: [p.x - f.x * 3.5, p.y - f.y * 3.5, p.z - f.z * 3.5],
    direction: [-f.x, -f.y, -f.z],
  });

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
    `t ${loop.simTime.toFixed(1)}s\n` +
    (v.length ? `<span class="bad">${v.join('; ')}</span>` : 'budget ok');
};

globalThis.GAME = {
  THREE, renderer, scene, camera, loop, rng, BUDGET, clouds,
  ship, controls, shipCam, input, pointer, pad,
  /** The light registry, so a capture can inspect what was actually lit. */
  lights: clouds.lights,
  stats: () => loop.perf.stats(),
  violations: () => loop.perf.violations(),

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

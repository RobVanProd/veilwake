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
import { CloudSystem, CLOUD_PALETTE } from './render/clouds.js';
import { shipLamp, thrusterPlume } from './render/lights.js';
import { Cockpit } from './game/cockpit.js';
import { Signature } from './game/signature.js';
import { ShipSystems } from './game/systems.js';
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

// The cockpit. Real geometry welded to the ship, drawn into the same linear HDR
// buffer and tone mapped with everything else, so it cannot drift out of the
// palette the way an overlay eventually does.
//
// It matters more here than it would in a brighter game: darkness on its own
// does not read as dread, it reads as empty, because nothing in frame is dark in
// relation to anything. This is the only near field the game has, and the only
// thing on screen that says continuously how small the machine is.
const cockpit = new Cockpit({ clouds });
cockpit.syncPalette(CLOUD_PALETTE);
scene.add(cockpit.object3D);

// What the ship emits, and the equipment that emits it.
//
// `systems` is passed the light registry so photic is read from what the
// renderer actually drew rather than from a parallel constant — two sources of
// truth for "how bright is the ship" is precisely how a signature system starts
// lying to the player about the thing they are trying to manage.
const systems = new ShipSystems({ lights: clouds.lights });
const signature = new Signature();

const input = new Input(canvas);
const pointer = new Pointer(canvas);
const ship = new Flight({ rng });
const pad = new Gamepad();
const controls = new Controls(input, pointer, pad);
const shipCam = new ShipCamera(camera);

// Start inside the cloud layer rather than above it. Where the camera sits is
// art direction here, not scene setup: the same renderer looks like a flight sim
// from above the layer and like this game from inside it.
// Spawn among the weather, not underneath it.
//
// This was y=140, which is below the deck: the player began under a ceiling,
// looking up at the flat underside of everything, in the one part of the layer
// with no form in it. A stress sweep measured the mood across altitudes and
// found y≈900 is the best in the world and that it degrades sharply below ~600 —
// so the opening shot was being taken in the worst band available.
ship.position.set(0, 700, 0);

// ---------------------------------------------------------------------------
// Scene lighting for solid geometry.
//
// The Phase-0 placeholder scene that used to live here — twelve scale-reference
// cubes and a 20 km floor plane, marked "nothing here survives into the game" —
// is gone. It had survived into the game: a review sweep found the cubes landing
// in the single best-scoring frame out of 96 poses, and a floor at y=-400 put a
// hard horizon under a world that is supposed to have no bottom.
// ---------------------------------------------------------------------------
const key = new THREE.DirectionalLight(0xbcd4ef, 2.2);
// The key follows the clouds' sun, so solid geometry and the volume agree about
// where the light is coming from. This matters now that the cockpit is real
// geometry sitting in front of a volumetric sky.
key.position.copy(clouds.sun);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9db6d6, 0x0a0f16, 0.55));

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
    // Vertical coupling is deliberately weaker than horizontal. Convection in a
    // towering cloud is genuinely one-directional — `dHere * towering` in
    // flowAt is positive everywhere by construction, because that is what a
    // rising column does — so a ship that answers it fully is carried upward
    // every time it crosses one and never comes back down. Measured at full
    // coupling it drifted 700 m to 1250 m in nine minutes with no input, out of
    // the band the palette is tuned for. The updraught is still felt, and
    // pointedly so when threading a tower; it just no longer accumulates into a
    // one-way trip out of the weather.
    TURB.y *= 0.35;
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
  // After the camera, so the interior is lit for the eye position actually used
  // this frame rather than the previous one.
  cockpit.update(dt, ship, camera, controls.lightsOn);

  // The player's switches drive the equipment; the equipment drives the
  // emissions. Routed through `systems` rather than read separately by the
  // signature, so there is exactly one answer to "is the lamp on".
  const edges = controls.consumeEdges();
  systems.lampOn = controls.lightsOn;
  if (edges.scan) systems.requestScan();

  // Signature updates AFTER the ship has moved and the equipment has been set,
  // and BEFORE anything senses it — a creature reacting to last frame's
  // emissions is a creature reacting to a position the player has already left.
  signature.update(dt, ship, systems, loop.simTime);


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
  cockpit, systems, signature,
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

// Compile the cockpit's shaders before the clock starts. A first-frame compile
// is a hitch the perf budget would report as a real one, and it would land on
// the opening shot.
cockpit.warmup(renderer, scene, camera);

loop.start();
bootEl.classList.add('gone');
setTimeout(() => bootEl.remove(), 800);

console.log('[veilwake] phase 0 running', {
  three: THREE.REVISION,
  renderer: renderer.getContext().getParameter(renderer.getContext().VERSION),
  maxTexture: renderer.capabilities.maxTextureSize,
  float: renderer.capabilities.isWebGL2,
});

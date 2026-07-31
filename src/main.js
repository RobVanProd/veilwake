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
import { shipLamp, thrusterPlume, bioluminescence } from './render/lights.js';
import { Cockpit } from './game/cockpit.js';
import { Signature } from './game/signature.js';
import { ShipSystems } from './game/systems.js';
import { CreatureManager, Listener, createMedium, createSignatureView } from './game/creatures/index.js';
import { Director, OUTCOME } from './game/director.js';
import { Captions } from './ui/caption.js';
import { CreatureRenderer } from './render/creatures.js';
import { ListenerView } from './render/bodies/listener.view.js';
import { LanternView } from './render/bodies/lantern.view.js';
import { WakeHunterView } from './render/bodies/wakehunter.view.js';
import { ChoirView } from './render/bodies/choir.view.js';
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

// Where the ship was, keyed by how long ago.
//
// Sound takes three seconds to cross a kilometre, so a creature hearing you is
// hearing a place you have already left — and at 100 m/s that place is 300 m
// behind. The recorder stores six channels and a timestamp but no position, and
// without this the sense path has to assume the sound came from wherever the
// ship is *now*, which quietly converts every acoustic detection into a slightly
// wrong one. A 20 s ring at 20 Hz is 400 entries and covers the full 6 km the
// Listener can hear across.
const TRAIL_HZ = 20, TRAIL_SEC = 20;
const shipTrail = { buf: new Float32Array(TRAIL_HZ * TRAIL_SEC * 3), head: 0, n: 0, acc: 0 };
function recordTrail(dt) {
  shipTrail.acc += dt;
  const step = 1 / TRAIL_HZ;
  while (shipTrail.acc >= step) {
    shipTrail.acc -= step;
    const i = (shipTrail.head % (TRAIL_HZ * TRAIL_SEC)) * 3;
    shipTrail.buf[i] = ship.position.x;
    shipTrail.buf[i + 1] = ship.position.y;
    shipTrail.buf[i + 2] = ship.position.z;
    shipTrail.head++;
    if (shipTrail.n < TRAIL_HZ * TRAIL_SEC) shipTrail.n++;
  }
}
/** @param {number} ageSec seconds ago. Null when the trail does not reach back that far. */
function shipPositionAt(ageSec) {
  const back = Math.round(ageSec * TRAIL_HZ);
  if (!(back >= 0) || back >= shipTrail.n) return null;
  const i = ((shipTrail.head - 1 - back + TRAIL_HZ * TRAIL_SEC * 2) % (TRAIL_HZ * TRAIL_SEC)) * 3;
  return { x: shipTrail.buf[i], y: shipTrail.buf[i + 1], z: shipTrail.buf[i + 2] };
}

// The creatures, and the two views they see the world through.
const creatures = new CreatureManager({ maxFull: 6 });
const creatureMedium = createMedium(clouds);
const creatureSignature = createSignatureView(signature, { positions: { at: shipPositionAt } });

// One Listener, placed far enough away to be found rather than met. It is blind
// and 240 m long; at cruise the ship is audible to it from about 3.2 km, so this
// is comfortably outside its hearing until the player does something loud.
creatures.add(new Listener({
  position: { x: 900, y: 760, z: -5200 },
  seed: seedFrom('listener/first'),
}));

// shipPos is filled in per frame rather than captured here: `ship` is declared
// further down and reading it now is a temporal dead zone, which fails at import
// with "Cannot access 'ship' before initialization" and takes the page with it.
// shipPos is filled in per frame rather than captured here: `ship` is declared
// further down and reading it now is a temporal dead zone, which fails at import
// with "Cannot access 'ship' before initialization" and takes the page with it.
const creatureCtx = {
  t: 0, tick: 0, shipPos: null,
  medium: creatureMedium, signature: creatureSignature,
  rng: () => rng.float(),
};

// Bodies. Until this line the creatures existed only in the simulation — a 240 m
// Listener, a Lantern whose entire design is a light that goes out, and nothing
// ever drawn. They are ordinary meshes in the ordinary scene, so the cloud pass
// occludes them for free, and they are lit by the luminaries above.
const views = new CreatureRenderer({ scene, clouds });
views.register('Listener', (c, o) => new ListenerView(c, o));
views.register('Lantern', (c, o) => new LanternView(c, o));
views.register('WakeHunter', (c, o) => new WakeHunterView(c, o));
views.register('Choir', (c, o) => new ChoirView(c, o));

// Creatures that glow must light the vapour they are glowing in.
//
// Without this a Lantern renders as a line of bright specks: geometry that is
// emissive to the camera and invisible to the medium. It is the difference
// between a light and a picture of one, and for this creature it is the whole
// point — §10.2 is built on the player choosing to approach something beautiful
// at distance, and a light that does not touch the cloud around it is not
// beautiful, it is a sprite.
//
// ONE registered light per creature rather than one per element. The march
// affords four lights in total (MAX_MARCH_LIGHTS) and a Lantern alone has up to
// twenty elements, so per-element registration would blow the budget on the
// first animal. The aggregate sits at the ring's centre carrying the creature's
// whole output, which is what the surrounding vapour would see anyway from any
// distance at which the ring is not resolved into separate points.
const creatureLights = new Map();
function syncCreatureLights() {
  for (const c of creatures.creatures) {
    if (typeof c.emittedLumens !== 'function') continue;
    let id = creatureLights.get(c);
    if (id === undefined) {
      id = clouds.lights.add(bioluminescence({ key: `creature/${c.id ?? c.archetype}` }));
      creatureLights.set(c, id);
    }
    const lm = c.emittedLumens();
    clouds.lights.set(id, {
      on: !c.dormant && lm > 1,
      // Back to the registry's radiance scale from lumens.
      //
      // NOT the ship lamp's 1800 lm-per-unit, and the difference is the cone.
      // The lamp puts 9000 lm through a 17-degree spot, so its radiance along
      // the axis is high; a bioluminescent creature radiates the same order of
      // lumens over the whole sphere, and handing that number to an omni light
      // at the lamp's ratio floods everything. Measured at 40000 lm through the
      // lamp's constant, the clamp pinned it at 9 and the frame's blown fraction
      // went from 7.3 to 20.9 percent — the whole canopy washed cyan.
      intensity: Math.min(lm / 22000, 1.5),
      position: [c.position.x, c.position.y, c.position.z],
    });
  }
}

const input = new Input(canvas);
const pointer = new Pointer(canvas);
const ship = new Flight({ rng });
const pad = new Gamepad();
const controls = new Controls(input, pointer, pad);
const shipCam = new ShipCamera(camera);

// The slice: what happens, and what makes it happen. Constructed after the ship
// and controls it reads, and updated last each frame so a beat can advance on
// the same step the player earned it.
const captions = new Captions();
const director = new Director({
  clouds, creatures, signature, systems, ship, controls, rng: () => rng.float(),
});
director.onCaption = (t) => captions.say(t);
let endingShown = false;
captions.onRetry = () => {
  endingShown = false;
  captions.hideEnding();
  director.restart();
};

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
// Scene lighting for solid geometry — driven by the luminaries.
//
// The Phase-0 placeholder scene that used to live here — twelve scale-reference
// cubes and a 20 km floor plane, marked "nothing here survives into the game" —
// is gone. It had survived into the game: a review sweep found the cubes landing
// in the single best-scoring frame out of 96 poses, and a floor at y=-400 put a
// hard horizon under a world that is supposed to have no bottom.
//
// One directional light per luminary, updated every frame from sky.js. This
// replaces a single static key that pointed at `clouds.sun`, and the difference
// is the whole point of having luminaries: solid geometry — the cockpit, and now
// the creatures — is lit by whatever is actually up, so a Listener under the
// ember is a different-looking animal from the same Listener under the veil, and
// nothing about that is arranged by hand. A static key would have left every
// body lit from a direction the sky disagreed with, which is the single most
// reliable way to make a rendered world look fake.
// ---------------------------------------------------------------------------
const skyLights = clouds.sky.lights.map(() => {
  const d = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(d);
  return d;
});
const ambient = new THREE.HemisphereLight(0x9db6d6, 0x0a0f16, 0.55);
scene.add(ambient);

/**
 * Radiance-to-light gain for solid geometry.
 *
 * The luminaries' intensities are in CLOUD_PALETTE's arbitrary radiance scale,
 * which the volumetric march interprets through its own scattering integral.
 * Three's lights are not that integral, so handing them the raw number leaves
 * every solid surface at a few percent of where it should be — measured, a
 * 240 m Listener came out at a mean of 28 against a background of 94 with barely
 * any internal tone, which is the flat black cut-out an adversarial pass
 * correctly complained about.
 *
 * At 5 the body has real shading (internal range 131 -> 155) and is still
 * unmistakably darker than the cloud behind it, which is the relationship the
 * art direction wants: carried by silhouette, but not a hole in the frame.
 */
const SCENE_LIGHT_GAIN = 5.0;

/** Push the current luminaries into the scene's own lights. */
function syncSceneLights() {
  const ls = clouds.sky.lights;
  for (let i = 0; i < skyLights.length; i++) {
    const L = ls[i], d = skyLights[i];
    // Three's DirectionalLight shines from `position` toward `target`, and the
    // luminary's `dir` points TOWARD the light, so the position is simply that
    // direction pushed far out.
    d.position.set(L.dir.x * 1000, L.dir.y * 1000, L.dir.z * 1000);
    d.color.setRGB(L.color.x, L.color.y, L.color.z);
    d.intensity = L.intensity * SCENE_LIGHT_GAIN;
  }
  // Ambient follows the sky it is standing in for.
  const a = clouds.sky.ambientTop, b = clouds.sky.ambientBottom;
  ambient.color.setRGB(a.x, a.y, a.z);
  ambient.groundColor.setRGB(b.x, b.y, b.z);
  ambient.intensity = 3.2;
}
syncSceneLights();

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
  recordTrail(dt);

  // Creatures last: they sense a signature that is already this frame's, from a
  // ship that has already moved. Sensing before either would have them reacting
  // to a position the player has left and a noise they have not made yet.
  creatureCtx.t = loop.simTime;
  creatureCtx.tick = loop.tick;
  creatureCtx.shipPos = ship.position;
  creatures.update(dt, loop.tick, creatureCtx);
  // Bodies follow the simulation, and the scene's lights follow the sky, so a
  // creature is lit by whatever luminary is actually up this frame.
  syncSceneLights();
  views.sync(creatures, dt, camera, { simTime: loop.simTime });
  syncCreatureLights();

  // The director reads the frame everything else just produced, so a beat can
  // advance on the same step the player earned it rather than one behind.
  director.update(dt, loop.simTime);
  captions.update(dt);
  if (director.outcome !== OUTCOME.RUNNING && !endingShown) {
    endingShown = true;
    captions.showEnding(director.outcome, { attempts: director.attempts });
  }


  // Drive the ship's lights from where the ship actually is, before clouds.update
  // so the registry's per-frame importance sort sees this frame's positions
  // rather than last frame's. The lamps sit off the hull centreline so the two
  // beams diverge slightly — a single centred lamp reads as a torch taped to a
  // camera, two read as a vehicle.
  const p = ship.position, f = ship.forward, r = ship.right, u = ship.up;
  const on = controls.lightsOn;
  // The lamps splay outward and slightly down rather than pointing along the
  // view axis. Aimed straight ahead they sit exactly on the axis the camera
  // looks down, and a cone seen end-on integrates to a featureless white disc —
  // measured photic 19488 lm and it read as a blown ball of fog, not a beam.
  // Splayed, the player sees the beams from the side, raking across whatever is
  // out there, which is the only angle at which a shaft reads as a shaft. Down a
  // little too, because the interesting thing to light in an ocean of cloud is
  // the mass you are about to fly into, not the empty sky above it.
  const SPLAY = 0.34, DROOP = 0.14;
  const aimL = [f.x - r.x * SPLAY - u.x * DROOP, f.y - r.y * SPLAY - u.y * DROOP, f.z - r.z * SPLAY - u.z * DROOP];
  const aimR = [f.x + r.x * SPLAY - u.x * DROOP, f.y + r.y * SPLAY - u.y * DROOP, f.z + r.z * SPLAY - u.z * DROOP];
  // The mount offset carries all three components of `right`, including y.
  //
  // It used to read `[p.x - r.x*1.4, p.y, p.z - r.z*1.4]` — the y term dropped —
  // so the lamps stayed in the world's horizontal plane no matter how the ship
  // rolled. Measured at 35 degrees of bank, the ship's right vector had a world
  // y of -0.569 while both lamps still reported a world y offset of exactly 0:
  // the hull banked and the lights did not go with it. That is the "I bank right
  // and the lights say left" the owner reported, and it is the same shape of
  // mistake as the roll input sign — one component quietly missing from an
  // otherwise correct expression.
  const offL = [p.x - r.x * 1.4, p.y - r.y * 1.4, p.z - r.z * 1.4];
  const offR = [p.x + r.x * 1.4, p.y + r.y * 1.4, p.z + r.z * 1.4];
  clouds.lights.set(lampL, { on, position: offL, direction: aimL });
  clouds.lights.set(lampR, { on, position: offR, direction: aimR });
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
  cockpit, systems, signature, creatures, director, captions, views,
  /** Where the ship was `ageSec` ago — the sound source, not the ship. */
  shipPositionAt,
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

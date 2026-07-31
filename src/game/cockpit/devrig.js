// Development rig for the cockpit. Not part of the game; nothing imports it.
//
//   const rig = await (await import('/src/game/cockpit/devrig.js')).attach();
//   await rig.shot('cock_level', { yaw: 0 });
//
// It exists because the cockpit's whole job is visual and the only way this
// project looks at itself is a deterministic capture. Posing the ship by hand in
// the console is three lines that are easy to get subtly wrong, and two of the
// three ways to get them wrong produce a *plausible* wrong picture.
//
// --- one of those, recorded, because it cost a capture round ---------------
//
// Teleporting an attitude freezes ShipCamera's rotation. Its rate limiter reads
//
//     const before = this._prevQuat.copy(this.orientation);
//     this.orientation.slerp(this._q, ...);
//     if (step > maxStep) this.orientation.copy(before).slerp(this.orientation, k);
//
// and the last line slerps `orientation` toward itself, because it has just been
// overwritten with `before`. So any step whose slerp exceeds maxSelfTurnRate
// (210 deg/s, 1.75 deg per fixed step) leaves the orientation exactly where it
// was, forever, instead of advancing by the cap. Real flight never trips it —
// the steady-state lag at maxYawRate is 3.7 degrees, a 0.33 degree step — but a
// posed capture trips it every time, and the picture that comes back is the
// cockpit viewed from outside the hull, which reads as a broken cockpit rather
// than as a broken rig. `snapCamera` below sidesteps it; the bug is in
// camera.js and is not this folder's to fix.
//
// --- and a second one, which invalidated every capture taken through this rig -
//
// `pose()` used to pin the ship at a fixed position while giving it a nonzero
// velocity, and then settle the camera against that. Those two states cannot
// both be true, and ShipCamera's feed-forward term is where they collide:
//
//     this.position.addScaledVector(ship.velocity, dt);   // camera.js:176
//     this.position.lerp(this._target, 1 - Math.exp(-positionLag * dt));
//
// The feed-forward exists so that constant-velocity flight has no steady-state
// lag, and it is correct — for a ship that is actually moving. Against a ship
// held still it is a constant push toward the nose that the lerp then has to
// fight, and the fixed point is not the eye:
//
//     error = v * dt * (1 - k) / k,   k = 1 - exp(-positionLag * dt)
//
// At the default spd of 90 m/s that is 0.75 * 0.8051 / 0.1949 = **3.10 m**, and
// measured it was 3.1001 m. The eye sits 1.9 m inside the hull and the canopy
// mouth is 1.2 m ahead of it, so the camera settled 1.74 m *in front of the
// ship*, outside the cockpit, looking back at nothing. Every capture this rig
// has ever produced was taken from out there.
//
// The fix is not to zero the velocity — lean, FOV and shake all read it, so a
// stationary ship poses a different cockpit. `pose()` now flies the ship in at
// constant velocity and arrives at the requested point, which is a state the
// feed-forward is correct for. `camLocal` in the returned info is the assertion:
// it must read [0, 0.55, 1.9], and if it does not, nothing the capture shows
// about the cockpit means anything.

import * as THREE from 'three';
import { Cockpit } from '../cockpit.js';
import { CLOUD_PALETTE } from '../../render/clouds.js';

/**
 * Build a cockpit, add it to the running game, and hook it into the fixed step.
 * Safe to call twice — the previous one is removed.
 */
export async function attach(G = globalThis.GAME) {
  if (!G || !G.ready) throw new Error('GAME is not up');
  if (G._cockpitRig) G._cockpitRig.detach();

  const cockpit = new Cockpit({ clouds: G.clouds, signature: G.signature });
  cockpit.syncPalette(CLOUD_PALETTE);
  G.scene.add(cockpit.object3D);
  cockpit.warmup(G.renderer, G.scene, G.camera);

  const baseUpdate = G.loop.update;
  G.loop.update = (dt, tick) => {
    baseUpdate(dt, tick);
    cockpit.update(dt, G.ship, G.camera, G.controls.lightsOn);
  };

  const eul = new THREE.Euler();
  const invQ = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const start = new THREE.Vector3();
  const camLocal = new THREE.Vector3();

  /**
   * Fly the ship in to an exact attitude and position, and settle the camera.
   *
   * Not "freeze": see the second note at the top of this file. The ship is
   * advanced along its own forward vector at `spd` for the whole settle and
   * arrives at (x, y, z) on the last step, which is a state ShipCamera's
   * velocity feed-forward is correct for. Holding it still instead puts the
   * camera 3.1 m outside the hull.
   */
  function pose(o = {}) {
    const {
      yaw = 0, pitch = 0, roll = 0, spd = 90, thr = 0.55, boost = 0,
      lights = false, x = 0, y = 700, z = 0, t = 30, turb = 0,
      energy = 74, stalled = false, steps = 140,
    } = o;

    G.loop.stop();
    G.seek(t);

    const s = G.ship;
    const dt = 1 / 120;

    // Attitude first, because the run-in direction is the ship's own forward.
    s.orientation.setFromEuler(eul.set(pitch, yaw, roll, 'YXZ'));
    s.angularVelocity.set(0, 0, 0);
    s._axes();
    // Start far enough back that `steps` of flight lands exactly on the target.
    start.set(x, y, z).addScaledVector(s.forward, -spd * dt * steps);

    const hold = (i) => {
      s.position.copy(start).addScaledVector(s.forward, spd * dt * i);
      s.orientation.setFromEuler(eul.set(pitch, yaw, roll, 'YXZ'));
      s.angularVelocity.set(0, 0, 0);
      s._axes();
      s.velocity.copy(s.forward).multiplyScalar(spd);
      s.throttleSmoothed = thr;
      s.boostSmoothed = boost;
      s.turbulenceLevel = turb;
      s.energy = energy;
      s.stalled = stalled;
    };

    hold(0);
    G.controls.lightsOn = lights;
    // See the first note at the top of this file.
    G.shipCam._initialised = false;
    // The medium is probed at 10 Hz and smoothed on arrival; let it converge
    // rather than capturing it mid-ramp.
    cockpit._probe = 0;

    for (let i = 0; i <= steps; i++) {
      hold(i);
      G.shipCam.update(s, dt, G.loop.simTime + i * dt);
      cockpit.update(dt, s, G.camera, lights);
      cockpit._probe = 0;
    }
    G.clouds.update(dt, G.camera);
    // The camera is not in the scene graph, so scene.updateMatrixWorld() does
    // not touch it. Anything that raycasts against this pose reads a stale
    // matrix unless this is here — that mistake cost four wrong leak reports.
    G.camera.updateMatrixWorld(true);

    invQ.copy(s.orientation).invert();
    fwd.set(0, 0, -1).applyQuaternion(G.camera.quaternion).applyQuaternion(invQ);
    camLocal.copy(G.camera.position).sub(s.position).applyQuaternion(invQ);

    return {
      sunVis: +cockpit.sunVis.toFixed(3),
      lightVis: Array.from(cockpit.lightVis).map((v) => +v.toFixed(3)),
      density: +cockpit.density.toFixed(3),
      /** Must be very close to [0,0,-1]. If it is not, the rig is wrong and
       *  nothing the capture shows about the cockpit means anything. */
      camFwdInShip: fwd.toArray().map((v) => +v.toFixed(3)),
      /** Must be very close to EYE, [0, 0.55, 1.9]. Same warning, and this is
       *  the one that was silently wrong for the whole life of this file. */
      camLocal: camLocal.toArray().map((v) => +v.toFixed(3)),
      fov: +G.camera.fov.toFixed(1),
      gauges: Array.from(cockpit.gauges).map((v) => +v.toFixed(2)),
    };
  }

  async function shot(name, o = {}) {
    const info = pose(o);
    const r = await G.capture({ name, width: o.width || 1600, height: o.height || 900 });
    return { name, ...info, ok: r.ok };
  }

  /** Mood of whatever is currently in the drawing buffer, cockpit on and off. */
  async function moodAB(o = {}) {
    const { measureMood, verdict } = await import('/tools/mood.js');
    const read = async (vis) => {
      cockpit.object3D.visible = vis;
      pose(o);
      G.loop.stop();
      await G.capture({ name: `ab_${vis ? 'on' : 'off'}`, width: 1600, height: 900 });
      return measureMood(G.renderer, 4);
    };
    const off = await read(false);
    const on = await read(true);
    return { off, on, verdictOff: verdict(off), verdictOn: verdict(on) };
  }

  const rig = {
    cockpit, pose, shot, moodAB,
    detach() {
      G.loop.update = baseUpdate;
      G.scene.remove(cockpit.object3D);
      cockpit.dispose();
      G._cockpitRig = null;
    },
  };
  G._cockpitRig = rig;
  globalThis.RIG = rig;
  globalThis.CK = cockpit;
  return rig;
}

# VEILWAKE

You pilot a small, fragile ship through an endless ocean of living cloud, and
the things in it are enormous.

There is no combat. You survive by managing what you emit — sound, heat, light,
EM, the wake you leave — and everything that helps you survive makes you easier
to find. Speed writes a trail. Sight costs light, and light is what the Lantern
eats. Knowing where you are means telling everything else where you are.

**[Gallery — what it looks like](docs/gallery/README.md)**
· **[What is built and what is not](docs/STATUS.md)**

---

## Running it

No build step, no npm, no bundler. Serve the folder and open it.

```bash
python -m http.server 8182
```

Then `http://127.0.0.1:8182`. Tests are at `/tests/`.

Three.js is vendored in `vendor/`. The game must run from a folder, offline,
forever — that constraint is why there is no toolchain.

---

## Controls

| | |
|---|---|
| **W / S** | pitch down / up (flight-stick sense) |
| **A / D** | yaw left / right |
| **Q / E** | roll |
| **Shift / Ctrl** | throttle |
| **Space** | boost — loud, hot, and the decision you regret |
| **Z** | cut engines |
| **L** | lamps |
| **F** | scan — charges visibly before it fires |

A gamepad works: left stick flies, right stick rolls, RT is throttle as an
absolute position, and the rumble is a readout of your own signature rather than
an effect.

---

## How it is built

Six systems, each of which can be read on its own.

- **`src/render/clouds.js`** — a GPU ray-marched volumetric field. The CPU and
  the GPU sample the *same* function, and `verifyAgreement()` proves it to within
  0.0015, because navigation, concealment and every creature sense ask where the
  cloud is and the game would be lying if their answer differed from the picture.
- **`src/render/sky.js`** — the luminaries. There is no sun; three coloured
  sources rise and set on long cycles and the entire palette is derived from
  whichever are up.
- **`src/game/flight.js`** — forces, not velocities. Control authority falls away
  below stall speed.
- **`src/game/signature.js`** + **`systems.js`** — six emission channels with
  deliberately different clocks. Fields die the frame you switch them off,
  acoustic decays over about fifteen seconds, thermal is a ninety-second
  integrator. A boost is still warm minutes later.
- **`src/game/creatures/`** — four archetypes against a written behaviour
  contract. They sense the real signature through real propagation delay: a
  creature hearing you is hearing a place you have already left.
- **`src/game/director.js`** — the vertical slice. Beats advance on measurements
  of the simulation, never on timers.

The design documents are not decoration. `CREATURE_BEHAVIOR_CONTRACT.md`
publishes anchor values that the implementation reproduces within 1%, and
`docs/ART_DIRECTION.md` is asserted by a regression suite — the frame is checked
for not being grey, and for the light actually changing over a run.

---

## The discipline

Everything visual in this project is measured before it is believed.

`tools/mood.js` reports luminance percentiles, the p99/p50 ratio, how much of the
frame is genuinely blazing, and how much colour is in it. It exists because
"looks too bright" is a checkable claim, and because this project has repeatedly
found that the thing that looked wrong was not the thing that was wrong:

- The frame that read as "too perky" was already **cold**. The fault was that
  65% of pixels were blazing with the bright end a *plateau*.
- The god rays were absent because the medium was too thin to cast a shadow —
  you could see straight through a cloud into the light.
- A regression suite reported 21/21 green while the game failed its own art
  direction at 10 of 14 sampled moments, because it pinned one camera at one
  instant.

`GAME.capture()` seeks the fixed-step simulation to an exact tick and renders
explicitly, so any image in the gallery reproduces byte-for-byte.

---

## Status

158 tests passing. The volumetric pass runs at 2.1 ms against a 7 ms budget.

The music is written, measured and **silent** — 56 authored tracks and a director
that chooses between them, connected to nothing. There is no title screen and no
pause. [`docs/STATUS.md`](docs/STATUS.md) is the honest inventory, including the
measured defects.

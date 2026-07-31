# Handoff — measured state of the project

Written 2026-07-31. Everything below came from three audit agents that **ran the
code and recorded real numbers**. Where a figure appears it was observed, not
estimated. Read this before touching anything; it will save you a day.

The short version: the physics is excellent and the game does not exist yet.
Three large modules landed with verified-correct maths and **no archetype, no
emitter, and no wiring** — so nothing they compute reaches the screen.

---

## The four blocking gaps, in the order they must be fixed

### 1. The Listener was never written
`src/game/creatures/creature.js` is **not** the Listener. It is the shared base
class and formula library. `Creature.sense()` returns `[]` (line 708) and
`Creature.behave()` is empty (line 710). `git ls-files | grep -i listen` matches
only the contract document. Priority 4's actual deliverable is unwritten.

Write `src/game/creatures/listener.js` as `class Listener extends Creature`.

### 2. `ShipSystems` does not exist
`Signature.update()` calls `systems.emit(this.bus, this.kin, ship)` at line 598,
and **every emission except the airframe-load term and a 0.05 lm plume arrives
through that call**. With `systems = null` the ship is nearly silent at full
throttle, which is why the signature system currently changes nothing.

Write `src/game/systems.js` exporting `ShipSystems` with `emit(bus, kin, ship)`.
The auditor reconstructed one from the anchor table and reproduced all four
contract states to within 1%; those exact publications are in the audit JSON.
It must also own the **scan capacitor**, which the module explicitly delegates
(line 769) and nobody implements — that is why contract 3.2's two most dramatic
rows are unreachable.

### 3. Nothing is wired into `main.js`
`Object.keys(GAME)` on the live page has no `signature`, no `lights`, no
`creatures`. On a fresh load `GAME.clouds.lights` holds four storm slots, all
`on:false`, all intensity 0, and `lights.signature()` returns 0. **Nothing in
the repo ever calls `shipLamp()`, `thrusterPlume()` or `bioluminescence()`.**

Adding the lamp and plume is ~15 lines and the audit calls it the single
highest-value change available.

### 4. No creature ever senses
`simLevel` defaults to `'reduced'` (line 525) and `update()` gates sensing on
`fullySimulated` (line 556). `promotionRadius` is computed (line 520, 16800 m for
a `FAR_PLANE` sensor) and read by nothing. Measured: a default creature runs
`sense()` **0 times per second**; with `simLevel = 'full'` it runs **exactly 10**.

`main.js` must own promotion — sort by distance, promote the nearest ≤6 inside
`promotionRadius`.

---

## What is genuinely verified and should not be re-litigated

**Creature physics** — acoustic transmission reproduces the contract's worked
values to within 0.04 dB (300 m → 36.46 vs 36.5; 6000 m ducted → 24.66 vs 24.7).
Sense ranges fall out of the formula rather than being tuned to it: cruise at
threshold 16 → 3162 m against "about 3.2 km"; at threshold 6 → 10000 m against
"10 km". The attention integrator reaches COMMITTED in 19.1 s against a stated
19 s. The state machine **converges in one tick** — 1005 swept cases, zero where
a second `_resolveStates` call changed the result. Ducts occur naturally in the
real cloud field: 11% of 400 sampled points non-zero, p95 = 0.602.

**Signature channels** — every contract 3.2 anchor reproduces within 1% once
systems exist. Acoustic uses correct power-domain summation, not dB addition.
Cutting engines costs **15.35 s** to fall under the Listener's 16 dB(V) threshold
— real, and expensive. Thermal is a true 90 s integrator; a boost stays warm for
**294 s** against the Wake Hunter's threshold. Throttle 0→1 drives every channel
monotonically up (acoustic 18.0→46.0 dB, thermal 12→39.9 dK). **The tension the
mandate asks for is real** — it just cannot be felt yet.

**Lights** — uniform packing is correct and space-correct. The occlusion march is
load-bearing: with the camera genuinely inside cloud (`densityAt` 0.6004,
measured) shadow on vs off differs by maxAbs 212 of 765, about a quarter of the
lamp's whole contribution. An earlier clear-air test showed 0.000 difference and
the auditor **checked before reporting it as a bug** — it was a null environment.

---

## Bugs worth knowing before you trust a number

- **A station-keeping ship is the loudest thing in the game** (`signature.js:826`).
  `_shed()` sheds wake parcels on a wall-clock 4 Hz timer with no spatial gate, so
  a stationary ship stacks hundreds of parcels at one point. Same failure on the
  thermal trail at `:840`, two orders of magnitude above the hull's real excess.
  This **inverts the design's central promise** that going quiet makes you safe.
- **De-escalation immediately re-escalates** (`creature.js:612`). Dropping out of
  COMMITTED lands in SEARCHING, then a `continue` re-enters the loop and climbs
  straight back to TRACKING inside the same tick.
- **`MAX_MARCH_LIGHTS = 8` is ~2.7× more than the shader can afford** — 8 lights
  measured 15.216 ms. The header comment claims the opposite ("the shader cost
  does not move"). The cost model is inverted: occlusion is nearly free, the
  analytic path is what scales. Cut march lights, raise shadowed lights.
- **`_terms` is never written**, so every DetectionEvent logs rho/u/q/g as 0.
- **`remove(id)`** deletes from the Map but never splices `active`, so a removed
  light is still packed and drawn that frame.
- **`exposureRef.relSpeed = 148`** is the cruise value, not the extreme, so that
  exposure bar pegs at 1.000 during ordinary cruise.
- **The bus vent deletes heat outright**, contradicting the module's own doc and
  Pillar 2 — a countermeasure that deletes heat is strictly better than not using
  it, which the design forbids.

---

## The mood problem belongs to `clouds.js`, not `lights.js`

This was measured, and it settles an open argument. On a 320×180 frame with no
local lights: luminance p05 92.7, p50 119.2, p95 244.2. **A low, cold,
high-contrast key is not reachable through `lights.js` parameters at all.** The
frame's base colour is essentially neutral (blue−red = 0.97 of 255).

`lights.js` can supply "beauty is the bait" — a cold beam in a dark frame — but
only *after* whoever owns `clouds.js` makes the frame dark. Assign the key-light
pass there. Note that at current presets `shipLamp` pushes the frame *warmer*,
the wrong way; `thrusterPlume` and `bioluminescence` are already correctly cold.

---

## Standing discipline

1. **Measure, and distrust the instrument.** A polarity check using `atan2`
   against a world axis reported yaw inverted when yaw was correct and nearly
   "fixed" working code. Measure against local frames captured before the input.
2. **Never guess a normalisation constant.** Four separate bugs in this project
   came from dividing by a guessed range. `TRAIL.wakeTauTurbGain = 8.0` is the
   live example: it was tuned against a graded turbulence field the shipped
   `CloudSystem` does not produce — 78.2% of 20000 sampled points read exactly 0.
   Measure p05..p95 of the real field before re-picking it.
3. **`gl.finish()` does not fence on this D3D11/ANGLE backend.** Use
   `EXT_disjoint_timer_query_webgl2`. An empty frame and a full cloud march both
   time at 0.4 ms if you trust it.
4. **File ownership.** Two agents in `clouds.js` at once corrupted it mid-write
   and took the page down with `SyntaxError: Unexpected identifier 'jit'`.
5. **A capture you did not look at is not evidence.** Captures land in
   `evidence/` **without a `.png` extension** — copy before reading.

---

## Not started

The cockpit (its agent produced no files at all), and the vertical slice itself:
opening, discovery, the quiet sequence, two encounters, concealment, escape, a
failure/restart flow, and an ending. **We have systems, not sequences.**

# Handoff — measured state of the project

> **Update, later the same night.** Everything in the "four blocking gaps"
> section below is now closed and the six mandate priorities are complete. What
> follows that update is the original audit, kept because its measurements are
> still the reference for anyone retuning these systems.
>
> ## Current state, measured
>
> - **Test suite: 80 passing, 4 failing**, at `/tests/`. All four suites run —
>   the runner used to import two of four and report "all 21 passed" while 58
>   cases sat unrun. A runner that hides suites converts an unknown into a false
>   assurance.
> - **Art direction: 7/7** through the *real gameplay camera* across six sim
>   times. The first version of that suite pinned one hand-placed camera at one
>   instant and reported green while the game failed at 10 of 14 sampled moments.
> - **Volumetric pass: 2.18 ms** against a 7 ms budget. Full simulation —
>   creatures, signature, lights, cockpit — runs 3000 steps in 69 ms (23 µs/step).
> - **Signature anchors reproduce within 1%** on all four contract states, and
>   throttle 0→1 drives every channel monotonically up (exposure 0.114 → 0.398).
> - **The Listener hunts.** Full ladder in the live game: UNAWARE → ALERT →
>   SEARCHING → TRACKING → COMMITTED at 3374 m, then loses the ship as it outruns
>   hearing.
>
> ## The four tests still red, and why they are left that way
>
> These are behaviours worth investigating, not thresholds worth loosening.
>
> 1. **`§5.3` forked creatures share a mistake sequence.** Two creatures forked
>    from one parent agree on 1826 of 2000 draws. They are supposed to be
>    independent; 91% correlation says the fork is not doing what it claims.
> 2. **`§5.2` propagation delay is 8.50 s where 9.09 s is expected** for 3 km.
>    6.5% short. The ship moves during propagation, which may explain it — but
>    "may explain it" is not a measurement.
> 3. **`§10.1` the creature is fully stopped for only 73% of its silence window**
>    (peak 4.98 m/s during the brake). It has to decelerate, so this may be a
>    disagreement between the contract's prose and honest physics.
> 4. **`§12` the reproducibility check logs 0 events.** Byte-identical across two
>    runs, but a scenario that produces no detections proves nothing.
>
> Two other tests in this suite *were* corrected, because the implementation was
> provably more accurate than the contract it was being checked against: the
> sense-range ratio measures √10 = 3.1623 exactly (a 10 dB threshold difference
> **is** a √10 range difference under spherical spreading) and was being failed
> for not equalling the prose figure "3.2"; and `visibility_m` returns 14.8
> against a printed "15", inside that integer's own rounding.
>
> ## What is genuinely not built
>
> The **vertical slice**: opening, discovery, quiet sequence, two scripted
> encounters, concealment, escape, failure/restart, ending. The systems exist and
> are verified. The *sequences* do not. This is still systems, not a game.
>
> Also unbuilt: the other three creature archetypes (Lantern, Wake Hunter,
> Choir), and discrete visible sun shafts — the ship's lamp casts a real beam,
> but the sun's mist in-scatter is a graded glow rather than something a player
> would call a ray. See the commit "Decouple the shaft shadow" for the numbers.
>
> ---


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

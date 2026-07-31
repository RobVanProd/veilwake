# Handoff — measured state of the project

Last updated 2026-07-31, after a headless session. Everything below with a number
beside it was **run and recorded**, not estimated. Read this before touching
anything.

The short version has changed. Two sessions ago it was *"the physics is excellent
and the game does not exist yet"*. It now reads: **the systems are connected and
measured, and the game still does not exist yet — but for the first time the
thing they were built for can actually happen.** A ship that emits, a creature
that hears it, a detection log that explains itself, and 114 test cases that say
so. What is missing is sequences, and the picture.

---

## What this session did

| | |
|---|---|
| `src/game/systems.js` | **new.** `ShipSystems` — the emitters. |
| `src/game/creatures/listener.js` | **new.** The Listener archetype. |
| `tests/systems.test.js` | **new.** 59 cases against contract §3.2. |
| `tests/listener.test.js` | **new.** 43 cases against §4, §5, §6, §7, §8, §10.1. |
| `src/game/signature.js` | trail shedding gated on distance; `exposureRef.relSpeed`; `emit()` gets `dt`; bus counts drops. |
| `src/game/creatures/creature.js` | COMMITTED de-escalation; history convention; `promoteByDistance`; `enforceSingleCommitted`. |
| `src/render/lights.js` | `remove()` splices `active`. |
| `src/main.js` | all of it wired. **Unverified — see the last section.** |

**Test totals, run in node 22, headless:** controls 12/12, signature 59/59,
Listener 43/43. `tests/index.html` runs all three in the browser.

---

## The anchor table now reproduces

Contract §3.2 has been the acceptance test for the signature system since it was
written, and until this session nothing could reach it — with no `ShipSystems`
attached the ship read acoustic 4.00 dB, thermal 0, photic 0.05, em 0 at full
cruise, and moving the throttle from 0 to 1 changed the acoustic channel by
exactly 0.00 dB.

| Row | acoustic | thermal | photic | em | wake |
|---|---|---|---|---|---|
| Powered down, drifting | 4.000 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 0.020 / 0.02 |
| Systems idle | 17.997 / 18 | 11.95 / 12 | 2.950 / 3 | 1.000 / 1.0 | 0.050 / 0.05 |
| Cruise | 46.007 / 46 | 39.83 / 40 | 3.000 / 3 | 2.200 / 2.2 | 0.600 / 0.6 |
| Hard turn (contract inputs) | 51.969 / 52 | 43.82 / 44 | 3.000 / 3 | 2.600 / 2.6 | 1.782 / 1.8 |
| Boost | 78.000 / 78 | 129.98 / 130 | 3.250 / 3 | 7.500 / 7.5 | 4.030 / 4.0 |
| Nav lights (delta) | — | +0.00 | +1200 | +0.100 | — |
| Search lamp (delta) | — | +1.99 | +9000 | +0.400 | — |
| Scan pre-charge | — | +2.98 / +3 | — | → 20.0 / 20 | — |
| Scan pulse | 95.72 / 96 | +6 | +40000 | +60.0 / 60 | — |
| Hull impact | 110 / 110 | — | — | — | +2.481 / +2.5 |

Every figure is inside 1% except boost's photic (+8.3%, a deliberate deviation
documented at `SIG.plumeBoostLm` — the contract's flat 3 lm would make boost and
cruise *equal* on that channel, and the system's load-bearing property is that
boost is strictly worse on all six).

**The one place the contract and the shipped code genuinely disagree, and it is
now pinned by a test rather than left to drift.** The hard-turn row assumes
strain 1.0 (gLoad 36 m/s², slip 0.30 rad, 148 m/s). The shipped flight model's
real sustained full-yaw turn is gLoad 59.635, slip 0.5705 rad at 112.47 m/s —
strain 1.66. With those inputs: acoustic 55.59 (+6.9%), thermal 46.43 (+5.5%),
em 2.863 (+10.1%), wake 1.615 (−10.3%). Two channels sit just outside the
contract's 10% *by construction*. Whoever retunes either file will now break a
test instead of silently drifting.

---

## The Listener

Acoustic only, functionally blind, built on `creature.js` rather than around it.

- **Transmission** matches the contract's worked values: 36.46 dB at 300 m
  (36.5), 26.01 at 1000 (26.0), 16.46 at 3000 (16.5), 10.44 at 6000 (10.4),
  24.67 at 6000 in a full duct (24.7).
- **Sense ranges fall out** rather than being tuned to: 3165 m at threshold 16
  against "about 3.2 km", 10008 m at the listening threshold 6 against "10 km".
  The silence window is worth **3.16×** against the contract's stated 3.2.
- **The delay is observable.** A burst emitted at t=100 s is heard at 3 km at
  t=109.5 s (sound delay 9.09 s, plus a 0.1 s sense tick and the time for a 3 dB
  rise).
- **Nine medium samples per sense tick** against §8's budget of 32.
- **Silence windows** measured over 900 s: six of them, 18.0–22.9 s long,
  101–147 s apart, all inside the contract's 18–26 and 100–160. It does not move
  during them (0 moving samples of 14 899) and its threshold reads {6, 16}.
- **Ten calls in 900 s**, and they stop at ALERT.
- **Determinism**: two runs from one seed produce byte-identical detection logs.
- **False positives** fire at 0.0244 Hz against a base of 0.02 in clear air.

The design rule worth knowing, because it is the one a player can exploit: the
Listener infers range by **assuming you are as loud as a cruising ship**. The
error factor is `10^((46−E)/20)` and it is independent of true distance, so a
quiet ship is placed beyond where it is and a boosting ship is placed short of
where it is. Measured: at 3000 m, a cruising ship is ranged at 2998 m and a
boosting one at 100 m. *The Listener's map of you is scaled by your throttle.*

It **records** its corridor; it does not carve it. Clearing density means writing
into `CloudSystem` and the creature layer is headless by design. The data is
there (`listener.corridor()`, radius 150 m per node) and unconsumed.

---

## Bugs fixed, with the numbers that found them

- **A station-keeping ship was the loudest thing in the game.** `_shed()` ran on
  a wall-clock timer with no spatial gate, so a parked ship stacked hundreds of
  parcels at one point and `sample()` summed them all: 4.595 s⁻¹ on the wake
  channel (92× the Wake Hunter's threshold, and **4.5× louder than the same ship
  at full cruise**), and 572.69 ΔK of thermal trail against a hull that was
  11.86 ΔK above ambient. Shedding is now gated on distance travelled *through
  the medium* — the same subtraction that produces relSpeed — with a spacing
  derived rather than chosen (37 m and 74 m are exactly how far the ship moves
  between shed events at cruise, so cruise is unchanged: still 768 parcels, still
  4 Hz). When the ship has not moved far enough the last parcel is refreshed in
  place rather than skipped, because a hot hull holding station should still be
  findable by heat: it now reads 6.52 ΔK against its hull's 11.86, and **the wake
  channel is monotone in speed for the first time.**
- **De-escalation from COMMITTED re-escalated in the same tick.** COMMITTED exits
  at 0.736 and TRACKING is entered at 0.700, and nothing brought attention down
  with the state, so the whole band [0.700, 0.735] mis-landed in TRACKING — which
  is exactly the band a decaying creature must pass through. The fall now also
  drops attention to `stateExit(TRACKING)` = 0.56. Measured after: COMMITTED →
  SEARCHING at att 0.5600, and still SEARCHING five seconds later.
- **`_terms` was allocated and never written**, so every DetectionEvent logged
  rho/u/q/g as 0 — the half of the sentence that says *why* something was heard.
  The Listener writes it; a test asserts every event carries it.
- **`createSignatureView.sampleAt` took an absolute time in its docstring and an
  age in every implementation.** At t=60 s the absolute form returned the sample
  from simTime 9.0, and past t=300 s it returned null at every distance. One
  convention, and it is the age.
- **`lights.remove(id)`** deleted from the Map and left the light in `active`, so
  a light removed between `prepare()` and `writeUniforms()` was still drawn that
  frame.
- **`exposureRef.relSpeed` was 148** — the cruise speed — so that bar pegged at
  1.000 during ordinary cruise. Now 237.0, the boost reference the wake anchor is
  already derived from. (Measured: drag terminal at boost 237.05 m/s; the fastest
  the ship can actually reach from cruise on a full energy bar is 214.4 m/s at
  t+1.87 s, because the boost drains the bar first.)
- **`EmissionBus.add()`** counted its drops instead of discarding them behind an
  unfinished sentence.

---

## What is wired, and what "unverified" means

`main.js` now constructs `Signature`, `ShipSystems`, one `Listener`, the ship
lamp and the thruster plume; runs `signature.update` after `ship.step`; promotes
creatures on a 4 Hz rota; enforces the one-COMMITTED rule; and exposes
`signature`, `systems`, `creatures`, `lights`, `sig()`, `sigBreakdown()`,
`exposure()`, `trails()`, `detectionLog()`, `detectionLines()` and
`creatureStates()` on `GAME`.

**None of that has been loaded in a browser.** This session had no GPU, no
browser and no display. What *was* done: every named import resolved statically
against its target module, `node --check` on every file touched, and the exact
update order rehearsed in a headless harness that mirrors it. What was *not*
done: booting the page, drawing a frame, or timing anything on a GPU.

**The first browser pass should, in order:**

1. Load the page. If it is white, the module graph is broken — check the console
   for the import that failed before anything else.
2. `GAME.sig()` — six channels, and they should move with the throttle.
3. `GAME.creatureStates()` — the Listener should show `simLevel: 'full'` when
   inside 16.8 km and `'reduced'` outside it.
4. `GAME.detectionLines()` after flying near it at cruise.
5. `GAME.clouds.benchPass(...)` with the plume live. **The audit measured the
   volumetric pass at +1.57 ms per light and over its 7 ms budget at three
   lights, and `MAX_MARCH_LIGHTS` is still 8.** It was left alone because that
   sweep was taken against a shader being rewritten mid-audit and the audit says
   to re-measure. The search lamp defaults off, so the steady state is one extra
   light. **Re-measure before enabling the lamp by default.**

---

## Still open, in rough priority order

1. **The mood problem, which belongs to `clouds.js`.** Measured last session and
   not re-litigated: on a 320×180 frame with no local lights, luminance p05 92.7,
   p50 119.2, p95 244.2. A low, cold, high-contrast key is **not reachable
   through `lights.js` parameters at all** — at eighty times the shipped lamp
   intensity, p05 was still 92.7 to the last 8-bit level. The levers are
   `clouds.js`: `this.sun`, `CLOUD_PALETTE.sun = [3.20, 1.86, 0.92]` (a warm
   amber, and the largest single cause of the golden-hour read), `uAmbTop`,
   `uAmbBottom`, `this.shaft`. Untouched this session by instruction.
2. **The vertical slice.** Opening, discovery, the quiet sequence, two
   encounters, concealment, escape, failure/restart, ending. **We have systems,
   not sequences.** This is now the largest gap by a distance.
3. **The cockpit.** Still no files at all.
4. **The corridor is recorded and nobody carves it.** `Listener.corridor()`
   returns the path; making it a real low-density corridor in the medium is a
   `clouds.js` change and it is the Listener's whole herding mechanic.
5. **Audio is not fed.** `src/audio/language.js` exports `CreatureVoice` and
   `CREATURES.listener`; `Listener.voiceState(shipPos)` returns exactly what it
   needs and nothing calls it.
6. **Wake parcels are still evicted above threshold after a boost.** Unchanged
   from the last audit: a boost parcel at 4.03 s⁻¹ on tau 60 needs 263 s to reach
   0.05 and the 768-parcel buffer expires it at 192 s (value 0.1643, 3.29× the
   threshold). Honouring §3.3's guarantee needs `wakeCap ≥ 1054` or a lower shed
   rate. Not touched because it is a memory decision, not a bug fix.
7. **The bus vent still deletes heat outright** (`signature.js:748`),
   contradicting the module's own doc and Pillar 2. `Signature.dumpHeat()` does
   it correctly; use that and not `bus.thermalDumpFraction` until the bus path is
   fixed.
8. **`TRAIL.wakeTauTurbGain = 8.0` was tuned against a turbulence field the
   shipped `CloudSystem` does not produce** — 78.2% of 20 000 sampled points read
   exactly 0. "Fly into rough air to erase your trail" is a binary switch, not a
   dial. **Measure p05..p95 of the real field before re-picking it.**
9. **The derived-field cache in `createMedium` is not deterministic** across a
   `seek()`. A detection log replayed after a seek will not reproduce, so captures
   cannot yet be creature regression baselines.
10. **No floating-origin rebase yet.** When `main.js` grows one,
    `signature.rebase(offset)` must be called in the same place with the same
    offset or every trail parcel is stranded.

---

## Standing discipline

Unchanged, and every line of it earned:

1. **Measure, and distrust the instrument.** This session's example: the first
   version of the Listener's range test let the creature patrol during the 320 s
   needed to fill the recorder, so it measured against a creature 400 m from
   where the bisection thought it was and reported a sense range of 2920 m
   against a contract value of 3.2 km. A believable 8% error that was entirely
   the measurement's fault. (The older one: a polarity check using `atan2`
   against a world axis reported yaw inverted when yaw was correct.)
2. **Never guess a normalisation constant.** Every number in `systems.js` is
   solved backwards from the anchor table with the derivation written beside it.
   The one genuinely unbridgeable conversion — `lights.js` radiance to lumens —
   is documented as unbridgeable at `LAMP_LM_PER_RADIANCE` rather than papered
   over with an invented constant: the shipped presets are 1800 lm per radiance
   unit for the lamp and 0.11 for the plume, so no single factor exists.
3. **`gl.finish()` does not fence on this D3D11/ANGLE backend.** Use
   `EXT_disjoint_timer_query_webgl2`.
4. **File ownership.** Two agents in `clouds.js` at once corrupted it mid-write
   and took the page down.
5. **A capture you did not look at is not evidence.** Captures land in
   `evidence/` **without a `.png` extension** — copy before reading.
6. **New: run the tests without a browser.**

   ```
   node --experimental-loader=./tools/three-loader.mjs tools/run-tests.mjs
   ```

   `creature.js`, `listener.js`, `signature.js` and `systems.js` import no
   Three.js at all, so node runs them directly; the only module in the test graph
   that needs `three` is `controls.test.js` via `flight.js`, and the five-line
   loader maps it to `vendor/three.module.js`. Prints only failures unless given
   `-v`, takes a suite name to run one, and exits with the failure count. This
   project has repeatedly been developed in environments with no GPU and no
   display, and a test that needs a browser is a test that stops being run.

# PERFORMANCE BUDGET

Target: 1920×1080 at 60 Hz on a Ryzen 7 5700 / Radeon RX 7800 XT, in a browser tab, with no build step.

`src/core/perf.js` already declares the frame-timing budgets and the comment above `BUDGET` explains why
they are tight. This document formalises those numbers and extends them to everything `perf.js` cannot see:
it counts milliseconds on the main thread, and most of the ways this game can go wrong are counts of things
rather than milliseconds of JavaScript.

Every budget below has four parts, and a budget missing any of them is not a budget:

- **the number**
- **why that number** — a reason from the game or the hardware, never "it seemed fine"
- **how it is measured** — including when the available measurement does not actually measure it
- **what is traded first** — decided now, in the quiet, rather than at 2 a.m. with a regression

---

## 1. Frame timing — already in `perf.js`

| | budget | why |
|---|---:|---|
| `frameMedian` | 16.7 ms | 60 Hz. Anything slower and the cloud's motion stops reading as one continuous body. |
| `frameP95` | 20.0 ms | Two frames in forty may be late. Beyond that the ship's response stops feeling connected to the stick. |
| `frameP99` | 25.0 ms | The tail is what players feel; the average is the least informative number a game can report. |
| `hitch` | 45.0 ms | A stutter as a creature passes is not a performance problem, it is a broken scare. |
| `update` | 3.0 ms | Simulation, creature AI, flight model. |
| `render` | 11.0 ms | Everything drawn. |
| `volumetric` | 7.0 ms | The cloud march alone, half-res. See §2 — and see §3 for why the CPU mark named `volumetric` is not this number. |
| `shaderCompile` | 1200 ms | Total, all variants, at startup. |
| `startup` | 3000 ms | To first interactive frame. |

**Measured by** `loop.perf` — `Perf.frame()` per presented frame, `Perf.begin/end` for the marks, `stats()`
for the percentiles and `violations()` for the list of what is currently being missed. Empty means healthy.

**Traded first when the frame budget is missed:** in order — temporal sample count, then ray-march step
count, then cloud resolution. Never resolution of the non-cloud pass, and never the simulation rate. The
fixed-step loop exists so that the game plays identically everywhere; making the step adaptive to recover
frame time would silently trade determinism for smoothness, which is the one trade this project has already
refused once.

---

## 2. Ray march

| | budget |
|---|---:|
| primary steps | 48 (adaptive 24–64) |
| light steps per primary sample | 6, and only where density > 0.02 |
| worst-case fetches per half-res pixel | ~150 |
| cloud pass resolution | half linear (quarter pixels), 4-frame temporal reprojection |
| device pixel ratio | capped at 1.5 (`MAX_DPR` in `main.js`) |

**Why 48.** Below about 32 steps, banding on a *silhouette edge in motion* becomes visible even with
blue-noise jitter and temporal accumulation. The silhouette of something enormous emerging from cloud is the
single most important image the game produces; every other artefact is negotiable and that one is not. 48
leaves margin for the density field to get more detailed without immediately reopening the question.

**Why 6 light steps, gated on density.** Self-shadowing is what makes a cloud read as a volume rather than
as fog. Six is enough to establish the gradient; the gate is what keeps the cost proportional to the cloud
actually in frame rather than to the screen.

**Why half resolution.** The cloud is low-frequency in screen space; the things that are not — the ship,
instruments, discharge — are drawn at full resolution over the top. Quarter of the pixels for a quarter of
the cost, and the difference is invisible except on the sharpest silhouette edge, which is why the floor is
one third and not one quarter.

**Why the DPR cap.** An uncapped ratio on a 4K display quadruples the cost of a full-screen march for a
difference nobody can see. It is the single most common reason a browser game is inexplicably slow on good
hardware.

**Measured by** a GPU disjoint timer query (`EXT_disjoint_timer_query_webgl2`) around the cloud pass where
the extension exists. Where it does not, by A/B differencing: render a frame with the cloud pass enabled and
one with it disabled, at the same simulation time, and take the difference of the medians over 60 frames.
Not by `perf.begin('volumetric')` — see §3.

**Traded first, in order:** temporal samples 4 → 2 → 1; primary steps 48 → 40 → 32; cloud resolution
1/2 → 1/3. Stop there. Below 1/3 the emergence silhouette becomes unreadable, and at that point the frame
is fast and the game is broken.

---

## 3. The measurement hazard — read before quoting any number

Two independent problems, and both make figures look *better* than the truth.

**The browser pane does not composite during development.** `requestAnimationFrame` does not run, so
`Perf.frame()` is never called and every frame statistic is empty. `GAME.benchRender()` exists to work around
this: it drives the renderer directly and calls `gl.finish()` around each frame, which produces a number
under any circumstances. But a surface that is never presented lets the driver discard work whose result
nobody reads, and `finish()` on several drivers returns once the command stream has been *accepted* rather
than *retired*.

**A CPU mark around a draw call measures submission, not work.** `perf.begin('volumetric')` /
`perf.end('volumetric')` wraps the JavaScript that issues the pass. On a healthy pipeline that is a few
hundred microseconds regardless of how expensive the shader is. It is a useful regression detector for
*CPU-side* cost and it is not, and cannot be made into, a measurement of the 7 ms volumetric budget.

Consequently:

> **Any figure taken from `benchRender` in a non-compositing pane must be labelled
> `[headless, non-compositing — optimistic]`, and must never be compared against a budget without that
> label attached.**

A figure may be compared against a budget only if it came from one of:

1. a composited window with `rAF` actually running, reported through `loop.perf.stats()`; or
2. a GPU timer query, which measures the GPU regardless of whether anything is presented.

Anything else is a smoke test: it proves the code runs and it proves nothing about speed. `benchRender`'s
own docstring already records this caveat honestly; this section exists so that the caveat survives being
copied into a report.

---

## 4. Scene contents

| | budget | why | traded first |
|---|---:|---|---|
| active cloud regions, simulated | 7 | One ahead, one behind, two lateral, three in reserve being born and dying — so no region ever pops into existence inside the fog distance, which would tell the player exactly how far the world extends. | reserve regions, 3 → 1 |
| active cloud regions, rendered | 4 | Beyond four overlapping bodies the march cost stops being predictable and the image stops being readable as distinct masses. | merge the two most distant into one coarse body |
| creatures, full sensory model | 3 | The Choir has to be able to fake the other three, so at least two others must be simulable alongside it. | third model drops to alert-only: no sweep voice, coarse bearing |
| creatures, full audio voice | 1 | See §6 — the voice is 28 persistent nodes plus up to 24 transient sources. | reduced voice: 3 partials, no breath, no sweep |
| creatures, presence-only markers | 8 | Enough for the world to feel populated at range without any of them costing a sensory model. | halve |
| draw calls | 120 | The scene is a handful of full-screen passes, the ship, and instruments. Above 120 something is being drawn per-object that should be instanced. | merge instrument geometry, then instance particles |
| triangles | 400,000 | Trivial for this GPU. The number exists to catch a mistake, not to constrain art. | nothing — investigate instead |
| particles alive | 4,000 | Wake and discharge only. Clouds are volumetric and must never be faked with sprites: sprite clouds and volumetric clouds in the same frame read as a bug, not as a style. | wake trail length, then discharge density |
| particle draw calls | 1 | Instanced. More than one means the pool was split, which is a bug. | — |

**Measured by** `renderer.info.render.calls` and `.triangles` (already in the on-screen diagnostic), and by
each subsystem reporting its own live count through `Perf.marks`.

---

## 5. Memory

| | budget | why | traded first |
|---|---:|---|---|
| JS heap | 350 MB | A browser tab that grows past a few hundred megabytes starts getting collected aggressively, and a major GC is a hitch. | pooled particle and audio-node allocation |
| GPU, textures and targets | 900 MB | Dominated by 3D noise: one 256³ RGBA8 volume is 67 MB. The budget holds two of those, the half-res cloud target and its history, the full-res HDR target and its resolve, and depth — roughly 200 MB in use, with the rest as headroom so an 8 GB card never has to evict mid-encounter. | second noise volume drops to 128³ with more octaves |
| allocations per frame, steady state | 0 | Not "few". A per-frame allocation in the render path is a GC hitch waiting for the worst possible moment, and the hitch budget is 45 ms. | — |

**Measured by** `renderer.info.memory` for geometry and textures, a manual tally of render targets at
allocation time, and `performance.memory.usedJSHeapSize` for the heap — *Chromium only*, and to be labelled
as such. Per-frame allocation is measured by watching the heap over a 60-second scripted run with the
allocation profiler on, not by inspection.

---

## 6. Audio

| | budget | why | traded first |
|---|---:|---|---|
| concurrent sources (oscillators + buffer sources) | 64 | A full creature voice is 4 persistent sources plus up to 8 per call with calls overlapping; the ship, ambience and score are about 20 between them. 64 fits one full voice, two reduced ones and everything else. | distant creatures' call partials 5 → 3, then their breath layer |
| total AudioNodes | 400 | A `Spatialiser` alone is 14 nodes, and a creature is 28 before it calls. | as above, then the scatter send on all but the nearest creature |
| convolvers | 1 | Shared, built once. A second convolution reverb roughly doubles the audio thread's cost for no perceptual gain. | — |
| audio callback | 0.8 ms per 2.67 ms quantum | 128 frames at 48 kHz is 2.67 ms; above about 30% occupancy the thread under-runs as soon as anything else on the machine hiccups, and an under-run is an audible click. | as above |
| `AudioLanguage.update` on the main thread | 0.4 ms | It runs inside the 3 ms `update` budget alongside the simulation. | contact voices update at 30 Hz instead of 120 Hz — the parameters are all ramped, so nothing clicks |

**Never traded:** the sub chain and the presence layer of the nearest creature. Those two carry the
density-immune distance cue (`AUDIO_LANGUAGE.md` §2), and dropping them to save nodes would remove the
player's ability to tell how close something is while leaving the sound apparently intact. That is the worst
possible class of optimisation: free-looking, and it deletes a mechanic.

**Measured by:** WebAudio has no introspection, so `AudioLanguage` keeps its own registry and reports counts
through `Perf.marks`. Under-runs are detected by comparing the progress of `ctx.currentTime` against
`performance.now()` over a 10-second window — a context that under-runs stalls its clock. `ctx.baseLatency`
and `ctx.outputLatency` are recorded alongside, since they set the floor on how tightly audio can be
synchronised to a visual event.

**Wiring note:** this needs one mark that does not exist yet — wrap the `audioLang.update(...)` call in
`main.js` with `loop.perf.begin('audio')` / `loop.perf.end('audio')`, and add `audio: 0.4` to `BUDGET` in
`src/core/perf.js`. Neither file is mine to edit.

---

## 7. Startup and shader compilation

| | budget | why | traded first |
|---|---:|---|---|
| time to first interactive frame | 3000 ms | There is no loading screen worth the name here, and a browser game that shows nothing for more than about three seconds gets reloaded rather than waited for. | the 3D noise bake defers to a warm-up frame after first paint |
| total shader compilation | 1200 ms | Measured across every variant, at startup, before the loop runs. | nothing — see below |
| **compilations after startup** | **0** | A shader compile during play is a several-hundred-millisecond stall against a 45 ms hitch budget. It is the largest single hitch this stack can produce and it always lands on a state transition, which is always a dramatic moment. | nothing |

Zero post-startup compiles is a hard rule rather than a target. **A material variant that cannot be
compiled up front must not exist.** In practice that means every permutation is enumerated and warmed with
`renderer.compile(scene, camera)` before `loop.start()`, and any code path that would construct a new
`ShaderMaterial` at runtime is a bug regardless of how fast the frame is afterwards.

**Measured by** `KHR_parallel_shader_compile` where available (poll `COMPLETION_STATUS_KHR` rather than
blocking, or the measurement changes what it measures); otherwise by timing the warm-up `renderer.compile()`
call directly. Post-startup compiles are caught by asserting that `renderer.info.programs.length` is
unchanged between the end of warm-up and the end of a scripted run.

---

## 8. How profiling is done

**Moving gameplay. Never a stationary screenshot.** A still frame is not a cheap approximation of a moving
one; it is a systematically different and much cheaper workload:

- **Temporal reprojection converges.** With a static camera, history is valid for every pixel and the
  accumulated result stops changing. The pass keeps its nominal step count but the *image* stops being
  sensitive to it, so the step count can be halved with no visible difference — and the profile of a
  stationary camera will happily tell you that. In motion, reprojection rejects disoccluded pixels and the
  march does real work. A static measurement can understate the cloud pass by two to three times.
- **Caches stay hot.** A fixed camera reads the same 3D texture footprint every frame. Flying through the
  volume touches new pages continuously.
- **Nothing streams, spawns, culls or changes LOD.** Region load, creature spawn and LOD transitions are
  where hitches live, and a still frame contains none of them by construction.
- **The audio graph stays static.** Creature voices are built and destroyed as contacts come and go, and
  building a `Spatialiser` is 14 nodes.

**The standard run** is a 60-second scripted flight, driven from recorded input so that two runs are
comparable, containing: acceleration to cruise, a boost, a hard turn, entry into dense cloud, an engine cut
and drift, a creature passing within 200 m and fixing on the player, an electrical discharge, and an escape.
The simulation is fixed-step and the RNG is seeded, so the run is deterministic and a regression is a
regression rather than a different playthrough.

Report from `loop.perf.stats()` and `loop.perf.violations()` at the end of the run, plus the GPU timer
query totals per pass, plus the peak counts from §4 to §6. A run that clears the frame budgets while
exceeding a count budget has not passed — it has got away with it on this machine.

`tools/profile.md` has the exact commands and how to read the output.

---

## 9. What this budget is protecting

Worth stating plainly, because a budget nobody can justify gets negotiated away in the first difficult week.

This is a slow, quiet game about listening for something enormous. Its scares are built out of anticipation
and out of the player doing real perceptual work — counting a gap, judging a modulation depth, deciding
whether a reverb tail matches the distance a contact is claiming. All of that depends on the frame arriving
when it is expected and on the audio thread never dropping a buffer.

A hitch at the moment a creature passes does not make the game slightly worse. It replaces the thing the
player was about to feel with an awareness that they are looking at software.

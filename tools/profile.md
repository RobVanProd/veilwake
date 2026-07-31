# Profiling VEILWAKE

How to get a number, and how to know whether the number means anything.

Budgets and their justifications are in `PERFORMANCE_BUDGET.md`. This file is the procedure.

Some of what follows describes tools that exist today and some describes tools that have to be built. The
two are marked, because a runbook that quietly mixes them wastes an afternoon.

---

## 0. Before anything

The dev server is already running at <http://127.0.0.1:8182/>. If it is not:

```
py tools/serve.py --port 8182
```

It writes anything POSTed to `/__evidence/<name>` into `evidence/`. That is how every measurement gets out
of the browser and into a file that can be read, which matters because the pane this is developed in does
not composite and cannot be looked at.

---

## 1. The one rule

There are two ways to time this game, and only one of them produces a figure that may be compared against a
budget.

| | what it measures | may be compared to a budget? |
|---|---|---|
| `loop.perf` via `GAME.stats()` | real presented frames, driven by `requestAnimationFrame` | **yes**, if the window is genuinely compositing |
| `GAME.benchRender()` | the render path, driven directly, `gl.finish()` between frames | **no**, unless corroborated by a GPU timer query |

`benchRender` exists because `rAF` does not run in a hidden pane, so `GAME.stats()` returns zeros there and
there would otherwise be no number at all. What it gives up is fidelity in the optimistic direction: a
surface that is never presented lets the driver discard work nobody will read, and `gl.finish()` on several
drivers returns once the command stream has been accepted rather than retired.

> Every figure from `benchRender` in a non-compositing pane carries the label
> **`[headless, non-compositing — optimistic]`**. Paste the label with the number, every time. A number that
> travels without its label will eventually be compared against a budget by someone who was not there.

The same applies in a different way to the CPU marks: `perf.begin('volumetric')` wraps the JavaScript that
*issues* the cloud pass, not the pass itself. On a healthy pipeline it reads a few hundred microseconds no
matter how expensive the shader is. It is a good CPU-side regression detector and it is not a measurement of
the 7 ms volumetric budget. Do not quote it as one.

---

## 2. Smoke test — does it run, and roughly how fast

Works today. Anywhere, including a hidden pane.

```js
// paste into the console on http://127.0.0.1:8182/
GAME.benchRender({ width: 1920, height: 1080, frames: 90 })
```

```json
{ "resolution": [1920,1080], "frames": 90,
  "median": 2.140, "p95": 2.610, "p99": 3.980, "worst": 5.12,
  "budgetRender": 11, "withinBudget": true }
```

Read it as: the code runs, the render path completes, and nothing has become catastrophically slow.
`withinBudget` is a tripwire, not a pass. Record it as

```
render 2.14 ms median / 3.98 p99 @1080p  [headless, non-compositing — optimistic]
```

Sweep resolution to find out whether you are pixel-bound or not — that much *is* trustworthy headless,
because it is a ratio between two figures taken the same optimistic way:

```js
[720, 1080, 1440].map(h => {
  const r = GAME.benchRender({ width: Math.round(h * 16 / 9), height: h, frames: 60 });
  return { h, median: r.median };
})
```

Cost roughly proportional to pixels means fragment-bound: the cloud march dominates, and §2 of
`PERFORMANCE_BUDGET.md` lists what to trade. Cost flat in resolution means CPU- or draw-call-bound, and the
resolution levers will do nothing.

---

## 3. The real measurement

Needs a composited window. Open <http://127.0.0.1:8182/> in an ordinary browser window, visible, not
minimised, not in a background tab.

```js
loop.perf.reset();
// fly for sixty seconds — see §4
GAME.stats()        // { median, p95, p99, worst, fps, hitches, frames }
GAME.violations()   // [] means every frame budget is being met
```

`violations()` returning `[]` is the only statement in this project that counts as "performance is fine",
and it counts only when it was collected over moving gameplay with the counts from §5 checked alongside.

### GPU timer queries — *to be built*

The only way to attribute GPU time to a pass, and the only way to measure the volumetric budget at all.

```js
const gl  = GAME.renderer.getContext();
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
```

Wrap the cloud pass in `ext.beginQuery(ext.TIME_ELAPSED_EXT, q)` / `ext.endQuery(...)`, then poll
`gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)` on a *later* frame — never block on it, or the
measurement changes the thing being measured. Check `gl.getParameter(ext.GPU_DISJOINT_EXT)` before trusting
any result and discard the sample if it is set.

Where the extension is unavailable, fall back to A/B differencing: run the standard flight twice at the same
seed, once with the cloud pass enabled and once with it stubbed to a constant, and difference the medians.
That attributes the pass correctly but cannot separate it from whatever else changed in the pipeline as a
result of stubbing it, so it is a coarser tool.

---

## 4. The standard run — *to be built*

Sixty seconds, driven from recorded input so two runs are comparable. The simulation is fixed-step and the
RNG is seeded, so it is deterministic: a difference between two runs is a regression, not a different
playthrough.

It has to contain, in order:

1. acceleration to cruise
2. a boost — peak thermal and acoustic signature
3. a hard turn — wake particles, reprojection disocclusion
4. entry into dense cloud — worst-case march, region streaming
5. engine cut and drift — the quietest mix, and the moment the ambience is revealed
6. a creature passing within 200 m and fixing on the player — voice construction, score subtraction
7. an electrical discharge — particle peak
8. an escape — region unload, `Score.relieve()`

Every hitch this stack can produce lives in one of those eight beats. **Profiling a still frame profiles
none of them**, and it also profiles a converged temporal reprojection and a hot texture cache, which is
why a static camera can understate the cloud pass by two to three times. `PERFORMANCE_BUDGET.md` §8 has the
full argument.

Until the scripted run exists, drive it by hand and say so in the report.

---

## 5. Counts, not milliseconds

A run that clears every frame budget while exceeding a count budget has not passed. It has got away with it
on this machine, and it will not on the next one.

```js
const i = GAME.renderer.info;
({ calls: i.render.calls, tris: i.render.triangles,
   geometries: i.memory.geometries, textures: i.memory.textures,
   programs: i.programs.length })
```

Against `PERFORMANCE_BUDGET.md` §4: 120 draw calls, 400k triangles.

`programs.length` is the important one and it is not about speed directly. Record it immediately after
warm-up and again at the end of the run. **If it has changed, a shader compiled during play**, and that is a
several-hundred-millisecond stall against a 45 ms hitch budget. It is the largest single hitch available to
this stack and it always lands on a state transition, which is always a dramatic moment.

JS heap, Chromium only, and label it as such:

```js
performance.memory && (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB [chromium only]'
```

---

## 6. Audio

WebAudio offers no introspection, so the counts come from `AudioLanguage`'s own registry rather than from
the API.

```js
const L = GAME.audioLang;
({ voices: L.voices.size, ctxTime: L.ctx.currentTime,
   base: L.ctx.baseLatency, out: L.ctx.outputLatency, state: L.ctx.state })
```

Under-runs do not throw and do not appear in any counter. Detect them by watching the audio clock drift
against the wall clock — a context that under-runs stalls `currentTime`:

```js
const t0 = performance.now(), a0 = GAME.audio.ctx.currentTime;
setTimeout(() => {
  const dw = (performance.now() - t0) / 1000;
  const da = GAME.audio.ctx.currentTime - a0;
  console.log('audio clock drift', ((da - dw) * 1000).toFixed(1), 'ms over', dw.toFixed(1), 's');
}, 10000);
```

More than about 5 ms of drift over ten seconds means the audio thread is missing quanta. `PERFORMANCE_BUDGET.md`
§6 has the trade order — and note the one thing that is never traded, which is the sub chain of the nearest
creature, because it carries the distance cue and dropping it is an optimisation that looks free and deletes
a mechanic.

### Audio discriminability

Separate from performance, but it runs the same way and lands in the same place:

```js
const L = await import('/src/audio/language.js');
const r = await L.discriminationTest({ trials: 120 });
await fetch('/__evidence/audio_discrimination.json', { method: 'POST', body: JSON.stringify(r) });
r.pass
```

About a second per trial. Read `evidence/audio_discrimination.json`. `AUDIO_LANGUAGE.md` §9 explains the
bars and which of them is currently unverified.

---

## 7. Evidence

Everything that will be quoted later goes through the same POST endpoint that captures use, for the same
reason: a file can be read, and a claim in a chat message cannot be checked.

```js
// a picture
await GAME.capture({ name: 'profile_dense_cloud.png', width: 1920, height: 1080, at: 42.0 });

// the numbers next to it
await fetch('/__evidence/profile_run.json', { method: 'POST', body: JSON.stringify({
  when: new Date().toISOString(),
  label: 'headless, non-compositing — optimistic',   // or 'composited, rAF'
  stats: GAME.stats(), violations: GAME.violations(),
  bench: GAME.benchRender({ width: 1920, height: 1080, frames: 90 }),
  info: GAME.renderer.info.render,
}) });
```

`at` seeks the simulation to an exact time by whole fixed steps, so two captures at the same `at` are
byte-identical. That makes a before/after pair a real comparison rather than two different moments.

---

## 8. Triage

| symptom | likely cause | first thing to check |
|---|---|---|
| median fine, p99 bad, hitches non-zero | GC, shader compile, or region streaming | `programs.length` before and after; then heap growth over the run |
| cost scales with pixels | fragment-bound, the cloud march | step count and cloud resolution, in that order |
| cost flat in resolution | CPU- or draw-call-bound | `info.render.calls`, then the `update` mark |
| `update` over 3 ms | simulation or creature AI | per-subsystem marks via `Perf.begin/end` |
| `render` over 11 ms but `volumetric` mark tiny | expected — the CPU mark measures submission | use a GPU timer query, §3 |
| headless numbers good, composited numbers bad | the optimistic-measurement hazard, §1 | stop quoting headless figures for this pass |
| audio clicks, no error, no counter moves | audio thread under-run | clock drift, §6 |
| first encounter hitches, later ones do not | a shader or a buffer built on first use | `programs.length`; then warm the path at startup |

---

## 9. Reporting

A performance claim in this project is three things, and it is not a claim without all three:

1. **the number**
2. **the label** — `[composited, rAF]` or `[headless, non-compositing — optimistic]`
3. **what produced it** — the standard run, or hand-flown, or a still frame, and at what resolution

"It runs at 60" is not a report. "median 15.2 ms / p99 22.1 ms, 0 hitches, 60 s standard run @1080p
`[composited, rAF]`, 84 draw calls, programs unchanged" is.

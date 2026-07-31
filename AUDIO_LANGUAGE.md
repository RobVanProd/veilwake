# AUDIO LANGUAGE

Audio in VEILWAKE is not atmosphere laid over the game. It is one of the two channels the game has for
telling the player what is happening, and in bad cloud it is the only one. A player who cannot see three
hundred metres has to be able to hear where something is, how far away it is, and whether it has noticed
them — and has to be able to do that while the medium is actively degrading the signal.

This document specifies that language. Every number in it is exported from `src/audio/language.js`; if the
two disagree, the code is right and this file is stale.

---

## 1. The constraint that determines everything else

Cloud density attenuates and low-passes by an amount the player has no way of knowing. That single fact
rules out most of the obvious design.

If distance is encoded as loudness, then a close creature behind dense cloud and a distant one in clear air
produce the same quiet sound, and the player cannot tell them apart — not because they are inattentive, but
because the information is genuinely not there. The same applies to brightness, to the ratio of high band
to low band, to anything that survives only as an absolute level.

> **A cue that must survive the medium has to be a ratio taken inside one narrow band, or an interval in
> time.** Both are invariant under an unknown gain and an unknown low-pass. Everything discriminative in
> this language is one of those two things.

Loudness and brightness are still used. They are just not trusted, and the player is meant to learn that
they are not trusted. That is a design goal rather than a compromise: the medium lying to you about how
close something is, while a second channel quietly tells you the truth, is most of the tension the game has.

### The medium model

`MEDIUM` in `language.js`. Sound travels through the air at 330 m/s; a pressure wave travels through the
body of the cloud at 1100 m/s. Absorption is `18000 · exp(-(0.0016 + 0.0075·d)·r)` Hz, floored at 140 Hz.
Below 120 Hz — `MEDIUM.SUB_HINGE` — the medium is transparent: a 60 Hz wavelength is five and a half metres
and does not see a droplet. The sub chain therefore bypasses the absorption filter entirely, and every
density-immune cue in the language lives underneath that hinge.

Computed from the shipped constants:

| range | stroke depth | shove→call gap | cutoff, clear | cutoff, d=0.5 | cutoff, d=1.0 | D/R at d=1.0 |
|------:|-------------:|---------------:|--------------:|--------------:|--------------:|-------------:|
|  40 m |        0.883 |         0.08 s |     16.9 kHz  |     14.5 kHz  |     12.5 kHz  |    +12.4 dB  |
| 120 m |        0.457 |         0.25 s |     14.9 kHz  |      9.5 kHz  |      6.0 kHz  |     +8.9 dB  |
| 250 m |        0.162 |         0.53 s |     12.1 kHz  |      4.7 kHz  |      1.9 kHz  |     +5.2 dB  |
| 500 m |        0.046 |         1.06 s |      8.1 kHz  |      1.2 kHz  |      190 Hz   |     +1.7 dB  |
|1000 m |        0.012 |         2.12 s |      3.6 kHz  |      140 Hz   |      140 Hz   |     -1.9 dB  |
|1500 m |        0.005 |         3.18 s |      1.6 kHz  |      140 Hz   |      140 Hz   |     -3.9 dB  |

Two things to read out of that table. First, close-and-dense is still bright (6 kHz at 120 m in the worst
cloud in the game) while far is never bright — so brightness is an honest *near* cue and a useless far one,
and it saturates at the floor exactly where the time and ratio cues take over. Second, the direct-to-scatter
ratio falls monotonically with range at every density: 16 dB of span at d = 1.0, 16 dB at d = 0.3. It is
offset by density but not reordered by it.

---

## 2. Distance

Two cues, overlapping between roughly 120 and 500 metres.

### Near cue — stroke modulation depth

A creature large enough to matter displaces the medium as it moves. That displacement is near-field: it
falls as 1/r² rather than 1/r, and it appears as an amplitude modulation of the sub band at the creature's
stroke rate (0.28 Hz for the Listener, 1.6 Hz for the Lantern).

    depth(r) = 1 / (1 + (r / 110)²)

Depth is a ratio of two levels *inside one narrow band*, so a uniform gain and any high-frequency low-pass
both cancel out of it. It is completely immune to cloud density. It is measurable down to about 0.02, which
is roughly 500 metres.

The carrier is a fundamental and its octave — never two close voices, because two close voices beat, and a
beat is a slow amplitude modulation in exactly the band the stroke occupies. It would be measured as depth,
and depth is inverted straight into metres.

All four creatures carry this layer in the same register (`bodyHz`, 27–58 Hz), whatever their call pitch.
Near-field displacement is set by how big the animal is, not by what noises it makes — and keeping every
presence layer under the hinge is what keeps the cue density-immune for all of them.

What the player hears: at 40 m the creature's presence swells and sinks almost to nothing, once every three
and a half seconds. At 500 m it is a flat, unchanging pressure. The *rate* tells you what it is; the *depth*
tells you how close.

### Far cue — the shove-to-call gap

Every call is two events. The pressure wave arrives first, through the body of the cloud, and is felt more
than heard: a 14 Hz half-cycle with a 55 Hz thump under it, so that it registers on hardware with no bottom
octave. The airborne sound arrives later, at 330 m/s.

    gap = r · (1/330 − 1/1100) = r · 2.12 ms

**One second of gap is 470 metres.** That is the single most important number in the audio design, and it is
meant to be learnable to the point of being automatic. It is a pure time interval, so no amount of
attenuation can forge it, shorten it or stretch it.

At close range the two events collapse into one, which is itself the reading: no gap means it is on top of
you.

### Where they hand over

The onset detector resolves gaps down to 0.25 s, which is 118 m. At 118 m the modulation depth is 0.47 —
enormous. The overlap is deliberately wide, so there is no range at which both cues are weak.

Measured: the near cue is within 1% of truth out to 300 m and degrades past 500 m; the far cue is within 5%
from 300 m out. They overlap across 120–500 m, which is exactly the band in which most encounters are
decided.

### Where distance is genuinely unavailable

An unaware creature's call is a 900 ms swell with no edge on it. It cannot be time-stamped, so the gap
cannot be counted, so beyond about 500 m an unaware creature cannot be ranged at all — you know it is there
and roughly where, and that is all.

This is a design property, not a defect of the detector. **You can only range a creature that has started
paying attention to you.** The moment it becomes dangerous is the moment it becomes legible.

---

## 3. Bearing

The important sounds in this game are between 30 and 120 Hz, where the head casts no acoustic shadow.
Interaural level difference at 40 Hz is essentially zero. An amplitude pan on a 34 Hz tone is inaudible as
direction, which would leave the Listener — the creature that hunts by sound — with no bearing at all.

So `Spatialiser` is built by hand rather than with a `PannerNode`:

- Split at 500 Hz. The low band is panned by only `0.12·sin(az)`, because that is roughly what physics
  gives it. The high band is panned fully.
- Both bands are delayed per ear, ±0.63 ms of interaural time difference. **Below 500 Hz the delay is the
  only cue that exists**, and it is also the only cue dense cloud cannot remove.
- Front and back are separated by pinna cues, which live above 2 kHz: a rear source gets −9 dB at 4 kHz
  and a −2.5 dB shelf above 3 kHz; a front source gets +4 dB at 3.2 kHz.
- Elevation slides the notch from 6.2 kHz (below) to 9.4 kHz (above).

### The dense-cloud fallback, stated rather than hidden

Front/back and elevation are carried entirely above 2 kHz, and above 2 kHz is the first thing the cloud
takes. **In dense cloud beyond a few hundred metres, front/back discrimination degrades to chance.** Lateral
bearing survives, because it is carried by time.

The fallback is not a fix in the mix. It is motion parallax: turn the ship, and a contact ahead swings one
way while a contact behind swings the other. That resolves it in about two seconds — and turning generates
a wake, which the Wake Hunter reads, and costs speed, which everything else reads. Information has a price,
and this is the clearest place in the game where the price is legible.

---

## 4. Awareness

The player must never confuse *near* with *noticed*. So awareness is carried by parameters chosen to be
orthogonal to distance and immune to the medium — regularity, rise time, and harmonicity. A low-passed
regular pulse train is still regular. A low-passed sharp attack is still sharp: at the medium's 140 Hz floor
the smearing is about 7 ms, against attacks of 60 to 900 ms.

| | 0 — unaware | 1 — searching | 2 — fixed |
|---|---|---|---|
| call interval | 14 s | 5.5 s | 2.0 s |
| jitter | ±45% | ±16% | ±4% |
| attack | 900 ms | 350 ms | 60 ms |
| decay | 3.4 s | 2.1 s | 1.3 s |
| partial stretch β | 0.085 | 0.034 | 0.004 |
| pitch drift | ±7 semitones | ±2 | none |
| **sweep voice** | absent | **present** | **absent** |

Partial stretch uses the piano inharmonicity formula, `fₙ = f₀·n·√(1 + β(n²−1))`. At β = 0.085 the fourth
partial is 8% sharp and the stack refuses to fuse into a pitch: it is heard as a phenomenon, weather with
teeth in it. At β = 0.004 it fuses, and a fused harmonic stack in that register is unmistakably a *voice*.
The creature does not get louder when it notices you. It becomes a voice.

### The sweep, and the silence that matters most

A searching creature emits a slow narrow-band sweep across its register — the sound of it looking. When it
finds you, **the sweep stops**, because it no longer needs to look. Simultaneously the call interval
collapses to 2 s and locks, the drift stops, and the pitch centres.

The transition into the most dangerous state in the game is marked by a sound *ending*. That is the design
principle of the whole soundtrack in one gesture, and everything in section 8 follows from it.

---

## 5. The four creatures

Separated by register and material rather than by melody, because through four hundred metres of cloud
melody is the first thing to go and register is the last.

**The Listener** — hunts engine vibration. `f₀ = 34 Hz`, three partials, stroke 0.28 Hz. Lives almost
entirely under the medium's hinge, so distance and density barely change its timbre: you always hear it, you
simply cannot tell how far away it is without counting. It carries a small 240 Hz breath layer for one
reason — every call needs *some* content above the hinge so that it can be time-stamped separately from its
own shove while the medium still passes any.

**The Lantern** — hunts light and electrical activity. `f₀ = 210 Hz`, five partials, heavy 3.2 kHz breath,
a 9 Hz crackle, stroke 1.6 Hz. Its entire signature sits where absorption is strongest, so it is the
creature the cloud hides best. Running dark is not only about not being seen; it is about not needing to
find something you cannot hear.

**The Wake Hunter** — hunts turbulence and directional change. No tonal content at all: a band-passed noise
whose centre frequency tracks its speed. It is audible only as a change in the *shape of the noise floor*,
which means a player running a loud engine cannot hear it at all. Its counter is silence, and silence is
also what stops it noticing you — the two are the same action.

**The Choir** — interferes with perception. It emits imitations of the other three at wrong ranges and wrong
bearings. Its tell is that the fakes are *too clean*: `scatterScale = 0.12`, so it synthesises the direct
sound and cannot synthesise four hundred metres of scattering. Its direct-to-scatter ratio is roughly 18 dB
too high for the distance it is claiming.

A false contact is therefore not random noise the player must simply endure. It is a **falsifiable claim**,
and the tail is the evidence against it. Learning to hear "that reverb is wrong for that distance" is the
skill the Choir exists to teach, and it is the only creature whose counter is entirely perceptual.

---

## 6. The ship

**Engine.** Fundamental sweeps 46 → 132 Hz across the throttle range, with partials at 1, 2, 3 and 4.5 and
a load-dependent low-pass from 420 Hz to 2.6 kHz. Turbulence puts a 1.2% wobble at 7.3 Hz into the intake,
so rough air is audible in the engine before it is visible on any instrument.

The engine's real job in the design is that **it masks 200 Hz to 2 kHz — exactly where the Wake Hunter and
the searching sweep live.** Running hot is not only emitting signature, it is deafening you. Cutting the
engine does not add a sound; it removes one, and the cloud is revealed underneath. That reveal is the reward
for the most vulnerable thing the player can do.

**Hull.** Creak interval is exponential in stress: 9 s at rest, 0.35 s at maximum. Each creak is a filtered
noise burst plus a ringing tone on one of four structural modes (63, 108, 171, 268 Hz). Above 0.60 stress a
groan drone fades in; below full integrity the groan's mode drops by up to 14%, so a damaged ship is audibly
a *different structure*, not the same one played louder. Above 0.85 a sparse 2.6–3.5 kHz tick appears, which
has no other meaning in the language: it is the one pure warning in the game.

**Airflow.** Band centre tracks speed 220 → 1600 Hz; Q opens with turbulence, so shear is heard as the wind
losing its pitch. Low-frequency buffeting rides underneath at 70–118 Hz, well below the engine, so it stays
readable at full throttle.

---

## 7. The medium, risk, concealment and instruments

**Cloud density** is read from the *shape of the reverberation*, not its level: clear air is a long, thin,
dry tail (wet 0.10, tilt 9 kHz), dense cloud is a short, close, wet one (wet 0.42, tilt 800 Hz). Density
therefore gets its own perceptual dimension and cannot be confused with distance, which is carried by the
direct-to-scatter *ratio*.

**Electrical activity** is a crackle whose rate is exponential in charge, plus a rising hiss. Before a
discharge the crackle stops for 400 ms. Again: the warning is a silence.

**Detection risk** removes a band rather than adding a sound — an 18 dB notch at 1 kHz, faded in over about
three seconds. A hole in an otherwise continuous ambience reads as *something listening*, and it costs no
headroom at the moment the mix is busiest.

**Concealment** is the only comfort in the language: a soft 5.2 kHz veil that fades in when the ship is
quiet inside dense cloud. It is the sound of the blanket being over you.

**Instrument reliability** degrades in three ways at once, because a reading that is silently false teaches
the player nothing. At reliability *r*: onset jitter of `(1−r)·90 ms`, a detuned second copy at
`(1−r)·45 cents` panned opposite, and a phantom-contact probability of `(1−r)·0.35`. Doubt becomes
information rather than noise — the ping *sounds* untrustworthy before the player works out that it is.

---

## 8. Music as a threat model

Seven layers, each gated by a continuous quantity. No calm cue, no combat cue, no transition.

| layer | Hz | driven by |
|---|---:|---|
| bed | 38.9 | always present |
| depth | 58.3 | distance from safety |
| unease | 622.3 | certainty a creature is near |
| uneaseB | 625.9 | same — beats against `unease` at 3.6 Hz |
| pressure | 77.8 | having been detected |
| wound | 29.1 | accumulated damage |
| flight | 155.6 | escaping |

Visibility closes every layer's filter. Remaining energy scales the whole bus. Damage pulls the entire score
flat by up to 90 cents — nothing announces it; the world simply stops being in tune with itself.

### The subtraction rule

    terror  = certainty · detected · smoothstep(600 m, 180 m, nearest)
    music  *= 1 − 0.85 · terror

**At full terror the score is at 15%.** The most dangerous moment in the game is the quietest one.

This is not restraint for its own sake. At that moment the player is being asked to do real perceptual work
— count a gap, judge a modulation depth, decide whether a tail matches a distance — and a score competing
for the same frequencies would be actively taking information away from them. Music is removed because the
player needs the bandwidth.

Note also that terror requires all three terms. Being hunted at range keeps its score; being *found at close
range* loses it. Two out of three is drama. Three out of three is data.

### The silences, named

1. **A creature fixes on you inside 300 m.** The score falls to 15% over about 1.2 s and stays. The sweep
   stops at the same moment. Two channels go quiet together, and nothing is added.
2. **400 ms before an electrical discharge.** The crackle stops.
3. **The engine is cut.** The engine bed vanishes and nothing replaces it for about two seconds, until the
   ambience that was underneath it becomes audible.
4. **After an escape.** `Score.relieve()` holds every layer at zero for 6 s. The first thing the player hears
   is the reverb tail of the last event being allowed to finish, which has not happened since the encounter
   started.
5. **The Choir arrives.** The ambience becomes *too clean*. Nothing is added; the scatter is subtracted.

---

## 9. How this is tested

Asserting that a sound is discriminative is worth nothing. The claim here is falsifiable and there is code
to falsify it.

Every creature voice is constructed against a bare `AudioContext` and a destination node, never against the
live mixer. That is deliberate and it is the whole verification story: the same class runs inside an
`OfflineAudioContext`, renders to a `Float32Array`, and gets measured. It is the audio equivalent of
`preserveDrawingBuffer` in `main.js` — the system has to be able to hand back what it produced, because
nobody developing this can hear it.

`describe(left, right, sr)` measures the rendered buffer: band energies, sub-band modulation depth (gated to
exclude call transients), onsets in two registers, direct-to-scatter ratio, 10–90% rise time, autocorrelation
periodicity, ITD and ILD. `estimate(d, {shoveAt})` decodes it back into distance, bearing and awareness.

The estimator is deliberately crude — two closed-form inversions and a nearest-centroid on three features.
**That is the argument.** If something this simple can read the state out of the rendered audio at every
cloud density, the encoding is genuinely present in the waveform and a trained listener can learn it. A
cleverer estimator would prove less, not more.

### The bars

Declared in `BARS`, written down before any numbers came back.

| | claim | bar |
|---|---|---|
| **B1** | near cue works | 40–450 m, any density: median relative error < 20%, p90 < 35% |
| **B2** | far cue works | 250–1500 m, awareness ≥ 1: median < 15%, p90 < 28% |
| **B3** | distance is not loudness | ¦Spearman ρ(estimated distance, true density)¦ < 0.20 at fixed range |
| **B4** | bearing works | lateral 20°–160°: median absolute error < 20° |
| **B5** | awareness is not distance | 3-class accuracy ≥ 95% overall, ≥ 90% at density > 0.8, and ¦r(awareness score, true distance)¦ < 0.15 |

**B3 is the important one.** It is the negative control. If the distance estimate tracks density, then what
is being measured is loudness wearing distance's clothes, and every other number is meaningless.

Front/back is scored separately from lateral bearing and is *expected* to approach chance at density > 0.8.
That is section 3's stated limitation, and a test that hid it would be worse than no test.

### Running it

```js
const L = await import('/src/audio/language.js');
const r = await L.discriminationTest({ trials: 120 });
await fetch('/__evidence/audio_discrimination.json', { method: 'POST', body: JSON.stringify(r) });
console.log(r.pass, r.allPass);
```

Then read `evidence/audio_discrimination.json`. About a second per trial.

`near` is the hinted decode and `nearBlind` the unhinted one. Both are reported because they fail
differently: the hinted path is how the game will work — a contact is identified by register long before
ranging it matters, and identification supplies the stroke rate — while the unhinted path has to find the
rate itself and can collide with the call train. Conflating them would hide which one is broken.

### What has actually been verified, and what has not

The analysis chain was reimplemented against synthetic presence layers and call trains and run, because
several parts of it were wrong in ways that reading the code would not have revealed. The findings are worth
recording, since each one is a trap the next person to touch this will otherwise fall into.

**Confirmed:**

- **The near cue inverts correctly.** With the calibration constant applied, recovered distance is within
  1% of truth from 60 to 300 m, 6% at 400 m, 14% at 500 m, and useless beyond about 650 m. That is the
  designed range.
- **The near cue is density-invariant**, which is B3 and the whole argument. Measured depth at r = 120 m
  across medium cutoffs of 12 kHz, 2 kHz, 300 Hz and 145 Hz: 0.414, 0.414, 0.414, 0.411. At r = 300 m:
  0.104 across all four. The cue does not move when the cloud does.
- **The far cue is accurate**: 1–5% relative error from 300 to 1400 m, unchanged between clear air and a
  200 Hz medium cutoff.
- **Call period separates the awareness states**: 16.5 s / 5.3 s / 2.0 s measured against 14 / 5.5 / 2.0
  synthesised.

**Found and fixed, all three silent failures:**

- A 60 Hz-attack envelope follower on the sub band tracks the 27 Hz *carrier*, not its envelope. It produced
  127 onsets a minute from a signal containing five calls. Sub-band followers are now two-pole at 12 Hz.
- Periodicity taken from the sub-band envelope locks onto the stroke modulation rather than the call train —
  and that frequency was then excluded from the stroke search, deleting the cue it was meant to find.
  Periodicity is now computed from onset times, which contain events only.
- Rise time measured against zero rather than against the pedestal the presence layer holds returns the
  width of the search window for every call. It is now pedestal-relative *and* upper-band only.

**Not verified:**

- `AWARENESS_CENTROIDS` comes from the synthetic reconstruction, not from the renderer. Right shape, roughly
  right place. `discriminationTest` returns `awareness.featureMeans` so refitting is copying three rows.
- `ONSET.THRESHOLD = 2.2` was tuned against the synthetic and is the first thing to adjust if the test
  misbehaves. Tuning order: threshold, then `ONSET.SUB.fastHz`, then `MIN_GAP_S`. Never `AM_CALIBRATION` —
  that one is measured and changing it to make a bar pass is fitting the ruler to the object.
- **B5 is therefore unverified — neither passing nor failing.** B1 to B4 do not depend on it.

### A limitation the design has to own

Rise time exists only in the upper band, because the presence layer's swell dominates the sub band. When the
medium closes the upper band — dense cloud beyond a few hundred metres — that feature is gone, and awareness
must be read from call period and regularity alone. `estimate` handles this by dropping the dimension's
weight rather than defaulting its value, since a default would place the contact at a coordinate no class
occupies and let the nearest centroid pick arbitrarily.

The consequence in play: in the worst cloud you can still hear *that* something is there, roughly where, and
how often it calls. What you lose is the texture of the call — and with it, the quickest read on whether it
is searching or merely present. That is the correct thing to lose, and it is the same trade as the front/back
one in §3: thick cloud costs information, and the information it costs first is the fine detail.

### The listening test the code cannot replace

Machine discriminability is necessary, not sufficient. Before the audio ships:

- 2AFC, "which of these two is closer", 40 trials, after a three-minute tutorial. Bar: ≥ 85% overall and
  ≥ 80% at density > 0.7. Chance is 50%.
- Awareness, forced three-way choice, 30 trials, distance randomised so it cannot be used as a proxy.
  Bar: ≥ 90%.
- Bearing, pointing task, 30 trials. Bar: median error < 30° lateral. Front/back is recorded but not scored,
  since the design says it should fail in thick cloud.

If the machine bars pass and the listening bars do not, the encoding is present but not *perceptible*, and
the fix is contrast in the parameter — larger stroke depth range, longer gaps — not a louder mix.

---

## 10. Wiring

`src/audio/language.js` imports only `src/core/math.js`. It does not touch `main.js`. To connect it:

After line 16 of `src/main.js` (`import { BUDGET } from './core/perf.js';`):

```js
import { Audio } from './core/audio.js';
import { AudioLanguage } from './audio/language.js';
```

After line 54 (`const rng = new Rng(seedFrom('veilwake:phase0'));`):

```js
// Audio cannot start without a gesture, so the language attaches on the first
// frame after the context actually comes up rather than at construction.
const audio = new Audio();
const audioLang = new AudioLanguage();
```

At the end of `update(dt)`, after line 100 (`markers.rotation.y = state.heading * 0.15;`):

```js
if (!audioLang.attached) audioLang.attach(audio);
audioLang.update(dt, GAME.audioState ? GAME.audioState() : AudioLanguage.idleState());
```

And in the `globalThis.GAME` literal:

```js
audio, audioLang,
audioState: null,   // set by whoever owns game state; see STATE_SHAPE in language.js
```

`STATE_SHAPE` in `language.js` documents the object `update()` consumes. `AudioLanguage.idleState()` returns
a valid silent one, and `update()` returns early on a malformed state rather than throwing — a silent game
is a bug, but a game that stops rendering because the mixer disagreed about a field name is a catastrophe.

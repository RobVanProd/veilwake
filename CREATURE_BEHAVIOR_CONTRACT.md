# VEILWAKE — creature behaviour contract

This is the specification that the signature system, the medium, the creature AI, the audio system
and the instruments are all written against. It exists so those five things can be built by
different people at the same time and still agree when they meet.

Nothing here is a suggestion. Where a number appears, it is the number, and changing it is a
deliberate act that requires updating this file first. Where a formula appears, both sides of the
interface use that formula and not an equivalent one, because "equivalent" is how two systems
end up disagreeing by 3% in a way nobody can find.

(The filename uses the American spelling because it is fixed by the project layout. The prose does
not. Do not rename the file.)

Read `GAME_VISION.md` for why any of this is shaped the way it is.

---

## 0. How to use this document

**If you are building the ship's systems**, you owe section 3: a `Signature` object, correct in the
stated units, sampled every simulation step, plus the trail shedding in 3.3 and the recorder in
3.4. You do not need to read the archetypes.

**If you are building the medium**, you owe section 2: one sampling function, and the derived
quantities in 2.2. Section 4 tells you what the creatures will ask of it.

**If you are building a creature**, you owe sections 5 through 8 in full, and then your archetype.

**If you are building audio**, section 9 is yours, and each archetype's audio subsection.

**If you are building instruments**, note carefully that the ship's own contacts are formed by the
same machinery in sections 4 and 5 as a creature's percepts. The ship is a sensor with thresholds,
latency, bearing error and false positives, and it is wrong in the same ways. Do not build a
second, cleaner detection path for the player.

---

## 1. Canonical constants

These appear in more than one system. They live here.

| Name | Value | Unit | Note |
|---|---|---|---|
| `UNIT` | 1 | metre per world unit | Three.js units are metres. Nothing rescales. |
| `STEP` | 1/120 | s | `Loop` runs at 120 Hz fixed. See `src/core/loop.js`. |
| `SENSE_PERIOD` | 12 | steps | Senses evaluate at 10 Hz, staggered by creature index. |
| `SOUND_SPEED` | 330 | m/s | Applied to every creature vocalisation. |
| `ACOUSTIC_REF` | 100 | m | Reference distance for the dB spreading term. |
| `FAR_PLANE` | 12000 | m | From `src/main.js`. Nothing detects beyond it. |
| `VIS_CLEAR` | 4000 | m | Visibility at density 0. |
| `VIS_K` | 5.6 | — | Visibility falloff exponent. |
| `AMBIENT_K` | 244 | K | Nominal medium temperature. Thermal signature is ΔK above local. |
| `SHIP_LENGTH` | 14 | m | The scale reference for everything else. |

Two derived quantities used everywhere:

```
visibility_m(ρ)  = VIS_CLEAR * exp(-VIS_K * ρ)          // ρ = density, 0..1
soundDelay_s(d)  = d / SOUND_SPEED
```

`visibility_m` is the single definition of "how far can anything see here". The cloud shader, the
creature senses and the ship's optical contact system all use it. A creature that sees further than
`visibility_m` in the volume between it and the player is a bug — the specific bug being prevented
is a player who hides in cloud they can verify is opaque and is found anyway, which destroys their
ability to reason and breaks the whole premise.

Sanity values: ρ=0 → 4000 m. ρ=0.25 → 987 m. ρ=0.5 → 244 m. ρ=0.75 → 60 m. ρ=1 → 15 m.

---

## 2. The medium interface

### 2.1 The sample

Everything the AI is allowed to ask the world about is here. There is no second query.

```
MediumSample {
  density      ρ      0..1        dimensionless; 1 is an opaque core
  temperature  T      K           absolute, around AMBIENT_K
  charge       q      0..1        electrical activity of the local cell
  flow         v      vec3 m/s    bulk motion of the medium
  turbulence   u      0..1        small-scale disorder; erases trails, adds bearing error
  duct         g      0..1        strength of local acoustic ducting (see 2.3)
}

Medium.sample(x, y, z, t) -> MediumSample
```

`t` is `loop.simTime`. The function must be pure and deterministic for a given seed — the capture
harness depends on two calls at the same sim time producing identical results, and so does every
replay of a detection.

### 2.2 The one-field rule

**`Medium.sample()` must evaluate the same density field the cloud shader marches.** Not a similar
one, not a cheaper one, not a smoothed one. If a performance-driven approximation becomes
unavoidable, it must be *conservative in the player's favour* — it may make the creature see less
than the picture suggests, never more — and its error bound must be written into this section.

The test, which is also the test defending the thesis in `GENRE_THESIS.md`:

> Sample 200 pseudo-random points across the view frustum. Compare `Medium.sample().density` on
> the CPU with the shader's density at the same points via GPU readback. Assert
> `max |Δρ| < 0.05`.

### 2.3 Ducting

A duct is a region where sound is trapped between density gradients and spreads cylindrically
rather than spherically instead of dissipating. Two things create them: shear layers between air
masses of different density, and corridors carved by large bodies moving through the vapour.

`duct` is not authored. It is derived from the field:

```
g = smoothstep(0.15, 0.55, |grad ρ| * 300) * (1 - smoothstep(0.6, 0.9, ρ))
```

That is: strong local gradient, and not inside a dense core. Corridors carved by the Listener
satisfy it automatically, which is the point — the road that looks easiest is the one that carries
your engine noise furthest, and nothing had to be scripted for that to be true.

---

## 3. The signature interface

### 3.1 The channels

Six. Each has a unit with a stated anchor, because "0 to 1" is how two systems silently disagree.

| Channel | Symbol | Unit | Class | 0 means |
|---|---|---|---|---|
| Acoustic | `acoustic` | dB(V) | field | powered-down hull adrift |
| Thermal | `thermal` | ΔK above local | trail | hull at ambient |
| Photic | `photic` | lm | field | fully dark, instruments shuttered |
| Electromagnetic | `em` | EMU | field | reactor cold |
| Wake | `wake` | s⁻¹ (vorticity) | trail | not moving relative to the flow |
| Relative motion | `relSpeed` | m/s | contact | moving exactly with the local flow |

dB(V) is decibels on the VEILWAKE acoustic scale: 0 dB(V) is the noise floor of an unpowered hull.
EMU is the VEILWAKE electromagnetic unit, defined so that reactor idle is exactly 1.0.

**The three classes are the core of the design and must be honoured:**

- **Field channels** propagate from the ship and stop the instant the ship stops emitting.
- **Trail channels** are shed into the medium, advect with the flow and decay on their own
  schedule. They cannot be recalled. Cutting power silences the field channels immediately and
  does nothing whatsoever about the last three minutes.
- **Contact channels** are only sensed within a body length or two, and exist so that a creature
  that has closed to contact does not need a detection at all.

### 3.2 Anchors

The signature system must produce these values, to within about 10%, in these states. Numbers in
between are its business.

| Ship state | acoustic dB(V) | thermal ΔK | photic lm | em EMU | wake s⁻¹ |
|---|---|---|---|---|---|
| Powered down, drifting | 4 | 0 (decaying) | 0 | 0 | 0.02 |
| Systems idle, station keeping | 18 | 12 | 3 | 1.0 | 0.05 |
| Cruise | 46 | 40 | 3 | 2.2 | 0.6 |
| Hard turn at cruise | 52 | 44 | 3 | 2.6 | 1.8 |
| Boost | 78 | 130 | 3 | 7.5 | 4.0 |
| Nav lights on | +0 | +0 | 1200 | +0.1 | +0 |
| Search lamp on | +0 | +2 | 9000 | +0.4 | +0 |
| Scan pre-charge (1.5 s ramp) | +0 | +3 | +0 | → 20 | +0 |
| Scan pulse (0.2 s) | 96 | +6 | 40000 | 60 | +0 |
| Hull impact | 110 | +0 | +0 | +0 | +2.5 |

Thermal decays towards ambient with a time constant of 90 s once the source stops, so a boost is
warm for several minutes. That is deliberate.

Note the scan pre-charge. The capacitor ramps to 20 EMU over 1.5 s *before* the pulse fires, which
means an electromagnetic sense sees the intention to scan from about 6 km away and the pulse itself
from 10 km. Scanning announces itself twice.

### 3.3 Trail shedding

Trails are parcels in a ring buffer, advected each simulation step.

```
WakeParcel    { pos vec3, strength s⁻¹, born tick }     shed at 4 Hz,  cap 768
ThermalParcel { pos vec3, deltaK, radius m, born tick } shed at 2 Hz,  cap 512
```

Advection and decay, per step:

```
// both classes ride the flow
pos += Medium.sample(pos).flow * STEP

// wake decays faster where the medium is disordered; this is the player's main lever
tauWake  = 60 / (1 + 8 * u)                      seconds
strength = strength0 * exp(-age / tauWake)

// heat rises, because it is warmer than what surrounds it
pos.y   += 0.8 * STEP
tauTherm = 55                                    seconds
deltaK   = deltaK0 * exp(-age / tauTherm)
radius   = 8 + 1.5 * age                         metres
```

The buffer caps are chosen so that a parcel is only ever dropped after it has already decayed below
every creature's threshold: 768 wake parcels at 4 Hz is 192 s, and the longest usable wake trail —
from a boost, in still air — is about 188 s. 512 thermal parcels at 2 Hz is 256 s against a longest
usable thermal trail of about 245 s. If either shedding rate changes, recompute the cap; a
truncated trail is a detection that silently stops working.

Consequences worth stating explicitly, because they are the game:

- Drifting sheds wake at 0.02 s⁻¹, below every threshold. Drifting genuinely leaves no wake trail.
- Cruising in still air (u≈0.05) leaves a followable wake for about 106 s. In turbulence (u≈0.8)
  it is about 20 s. Flying into rough air erases your trail five times faster.
- Boosting in still air writes a followable trail for about three minutes. That is the price.
- The thermal trail climbs at 0.8 m/s, so after three minutes it sits ~145 m above the path you
  actually flew. Anything following heat searches above you.

### 3.4 The signature recorder

The signature system must keep a rolling history and expose it:

```
SignatureRecorder — 300 s at 2 Hz, all six channels, ring buffer (~14 KB)
```

This is a player-facing instrument, not a debug tool. When the player is found and asks why, the
honest answer available to them is their own emissions log: *you ran the search lamp for forty
seconds at 09:41 and something with eyes was within 1.5 km.* It satisfies Pillar 3 without
exposing creature internals, and it is the only way a player can conduct a post-mortem in a game
where they never see what found them.

---

## 4. Transmission

How a signature becomes a stimulus at a receiver. One formula per channel. Both the creatures and
the ship's instruments use these.

Let `d` be the distance from source to receiver, and let the path integral

```
Rho = integral of ρ along the ray, in kilometre-units
```

be evaluated at **8 evenly spaced samples**, not marched. The error is a few per cent and the cost
matters more (section 8).

### 4.1 Acoustic — field channel

```
n         = 20 - 8 * g_mean                  // spreading exponent; ducts spread cylindrically
spread_dB = n * log10(max(d, ACOUSTIC_REF) / ACOUSTIC_REF)
absorb_dB = 12 * Rho                         // 12 dB per km through density 1.0
received  = emitted - spread_dB - absorb_dB
```

`g_mean` is the mean `duct` along the path. In open air (g=0) the exponent is 20; inside a strong
duct it is 12, which is worth about 14 dB at 6 km — the difference between inaudible and obvious.

Worked values, cruise at 46 dB(V), open air, clear: 300 m → 36.5. 1000 m → 26.0. 3000 m → 16.5.
6000 m → 10.4. The same cruise inside a full duct at 6000 m → 24.7.

**Bearing error.** `bearingSigma = 0.03 + 0.9 * u_mean + 0.5 * g_mean` radians. Ducts carry sound
a long way and destroy its bearing, so a ducted contact is loud and badly located. That is the
single most useful ambiguity in the game and it should not be tuned away.

### 4.2 Photic — field channel

Two terms, and the split is the mechanic.

```
vis     = visibility_m(rho_mean)
E_direct  = I / max(d, 10)^2 * exp(-d / vis)
E_scatter = I / max(d, 10)^2 * (1 - exp(-d / vis)) * 0.6
E_total   = E_direct + E_scatter                       // lux-equivalent
quality   = E_direct / max(E_total, 1e-9)              // 0..1
bearingSigma = 0.02 + 1.2 * (1 - quality)              radians
```

In clear air, `quality` → 1 and a light is a point with a sharp bearing. Beyond a few visibility
lengths in dense cloud, `quality` → 0, `E_total` is barely reduced, and `bearingSigma` reaches
about 1.2 rad (69°). **Fog does not make your lights dimmer. It makes them a glow that fills the
sky, no less visible and no longer locatable.** Turning the lamps up in cloud does not hide you and
does not help whoever is looking; it makes you a large vague presence. Both sides have to live with
that.

Worked values against a 0.004 threshold: nav lights (1200 lm) seen to ~550 m; search lamp
(9000 lm) to ~1500 m; scan flash (40000 lm) to ~3160 m.

### 4.3 Electromagnetic — field channel

```
received = emitted * (300 / max(d, 300))^2 * (1 + 1.5 * q_mean)
bearingSigma = 0.04 + 1.6 * q_mean
```

Vapour barely attenuates it; charged cells amplify it and wreck its bearing. A charged cell is
therefore a place where you are loud on EM and hard to locate, which is a hiding place with a
specific cost.

Worked values against a 0.05 threshold: idle (1.0) to ~1340 m; cruise (2.2) to ~1990 m; boost
(7.5) to ~3670 m; scan pre-charge (20) to ~6000 m; scan pulse (60) to ~10390 m.

### 4.4 Thermal and wake — trail channels

Not transmitted. Sampled where the creature is.

```
stimulus = sum over parcels within senseRadius of (parcel value * falloff)
falloff  = 1 - clamp01(dist / senseRadius)
```

A creature only detects a trail by flying into it. This is what makes trail-followers *delayed* and
what makes their pursuit breakable: they are not tracking you, they are tracking something you did.

### 4.5 Relative motion — contact channel

```
relSpeed = |shipVelocity - Medium.sample(shipPos).flow|
```

Sensed within `2 * bodyLength`. Moving with the flow at any speed is quiet on this channel; holding
station against a fast flow is loud. Drifting is not merely passive, it is actively concealing, and
that is the reward for giving up control of your line.

---

## 5. Percepts and attention

### 5.1 The percept

What a sense produces. Never a position — always an estimate with error attached.

```
Percept {
  channel      'acoustic' | 'photic' | 'em' | 'thermal' | 'wake' | 'contact'
  strength     in the channel's own units, after transmission
  bearing      rad, world frame, already corrupted by bearingSigma
  bearingSigma rad
  range        m, or null — most channels do not give range at all
  ageSec       how old the underlying evidence is (delay + trail age)
  confidence   0..1, derived: excess over threshold, reduced by bearingSigma
  real         boolean — true source, or a false positive. Never exposed to the player.
}
```

Three channels do not give range. Acoustic gives none (only bearing and loudness, which are
confounded). Photic gives none. Trail channels give a position but it is where you *were*. Only
`contact` gives a true current position, and by then it is too late for that to be information.

### 5.2 Latency

Latency is not simulated separately; it falls out of the architecture. Senses evaluate every
`SENSE_PERIOD` steps (10 Hz), staggered per creature:

```
if ((tick + creature.senseOffset) % SENSE_PERIOD === 0) creature.sense();
```

That gives 0–100 ms of sensing latency for free, spreads the cost across frames, and is
deterministic under replay. Acoustic percepts carry an additional `soundDelay_s(d)`: what a
creature "hears" at time `t` is what the ship was emitting at `t - d/330`. **The signature history
in 3.4 is what makes that implementable** — the acoustic sense reads the past, not the present.

Per-channel additional latency, on top of the tick:

| Channel | Extra latency |
|---|---|
| acoustic | `d / 330` s |
| photic | 0 |
| em | 0 |
| thermal | parcel age (seconds to minutes) |
| wake | parcel age |
| contact | 0 |

### 5.3 False positives

Every sense has a false-positive rate, scaled by the local medium, and every false percept is
indistinguishable from a real one inside the creature's own reasoning.

```
rate_hz = base * (1 + mediumFactor)

acoustic: mediumFactor = 2.0 * g_local          // reverberation in ducts
photic:   mediumFactor = 1.5 * rho_local        // scattering in cloud
em:       mediumFactor = 4.0 * q_local          // charged cells
wake:     mediumFactor = 3.0 * u_local          // turbulence looks like a trail
thermal:  mediumFactor = 0                      // heat is rarely ambiguous
```

**False positives must be drawn from the creature's own forked RNG stream** —
`rng.fork(CREATURE_TAG)` per `src/core/rng.js` — evaluated on the sense tick, never from a global.
The reason is in that file's header: a system reaching for a shared stream means the order systems
happen to update in silently changes the world, and a replay stops reproducing after an unrelated
edit. A false positive that cannot be reproduced cannot be debugged, and an encounter that cannot
be replayed cannot be shown to be fair.

A false percept's bearing is drawn from a plausible direction, not a uniform one — creatures
investigating nothing at all in a random direction read as broken rather than as mistaken.

### 5.4 The attention integrator

Detection is never instantaneous. Each creature holds one `attention` value in 0..1.

```
excess = clamp01((stimulus - threshold) / (saturation - threshold))

if (any percept above threshold)  attention += fillRate  * excess * dt
else                              attention -= decayRate * dt

attention = clamp01(attention)
```

`stimulus` is the strongest current percept in any channel the creature has. Multiple channels do
not add; the strongest wins, and cross-channel agreement affects confidence rather than magnitude.

| Creature | fillRate /s | decayRate /s | memory s | 0 → COMMITTED at excess 0.4 |
|---|---|---|---|---|
| Listener | 0.12 | 0.012 | 240 | 19 s |
| Lantern | 0.08 | 0.008 | 400 | 29 s |
| Wake Hunter | 0.55 | 0.050 | 90 | 4.2 s |
| Choir | — | — | 600 | does not hunt; see 10.4 |

The Wake Hunter commits in four seconds because getting a percept at all requires it to already be
flying through your trail. The Lantern takes half a minute because it is not in a hurry and never
has been.

`memory` is how long the last percept's position estimate is retained after attention decays.

---

## 6. Encounter states

One state machine, shared by all creatures, so the escalation is legible across the roster.

```
UNAWARE → ALERT → SEARCHING → TRACKING → COMMITTED
```

| Transition | Attention | De-escalates below |
|---|---|---|
| UNAWARE → ALERT | 0.25 | 0.20 |
| ALERT → SEARCHING | 0.45 | 0.36 |
| SEARCHING → TRACKING | 0.70 | 0.56 |
| TRACKING → COMMITTED | 0.92 | 0.736 |

Hysteresis is 0.8× the entry threshold, so a creature does not oscillate at a boundary.
De-escalation from COMMITTED goes to SEARCHING, not TRACKING: something that has committed and lost
you does not politely resume tracking, it starts hunting the area.

What the states mean, in general — each archetype specifies what the *player* perceives:

- **UNAWARE** — living its life. It is doing something, and what it is doing is worth watching
  because that is where the player learns its rules at no cost.
- **ALERT** — something registered. Posture changes, motion slows, the voice changes character. It
  has not moved towards the player and may not.
- **SEARCHING** — actively investigating an estimate that is probably wrong by hundreds of metres.
  This is the state the player will spend most time in, and it is the one that must be most
  readable.
- **TRACKING** — it has a usable estimate and is closing. Its estimate is still noisy and still
  behind, and the player's job is to widen that error.
- **COMMITTED** — it has the player. Escape now requires the medium, not manoeuvring.

**Rule: at most one creature may be COMMITTED at any time.** Two simultaneous committed pursuers
produce a situation with no readable solution, which reads as unfair regardless of whether it is.
The Choir is exempt because it never enters COMMITTED. Whether this is permanent is open question 4
in `GAME_VISION.md`.

---

## 7. Explicability — the hard requirement

**Every state transition writes a `DetectionEvent`. A transition without one is a bug of the
highest severity in this project.**

```
DetectionEvent {
  tick, simTime
  creature      id and archetype
  from, to      state names
  channel
  emitted       value at the source, in channel units
  transmitted   value at the receiver, in channel units
  threshold
  distance      m
  medium        { rho_mean, u_mean, q_mean, g_mean }   the path terms
  real          boolean
  attention     value after the update
}
```

Exposed as `GAME.detectionLog()`, returning the last 64. Every event should render as one readable
sentence:

> `t=412.3  Listener  SEARCHING→TRACKING  acoustic  emitted 46.0 dB(V), transmitted 20.5 at
> 5980 m through rho 0.02 / duct 0.81, threshold 16.0`

That line contains the whole explanation, including the interesting part: it was heard at six
kilometres because it was inside a duct.

Three rules follow, and they are not negotiable:

1. **A creature may not turn towards the player without a percept.** Not on a timer, not on a
   director's hint, not to make an encounter more exciting.
2. **A director may act only before contact** — on placement, timing, weather and approach vector.
   It may not touch a threshold, a sense or a position while any creature is above UNAWARE.
3. **False positives are real events and get real records.** `real: false` in the log is how a
   developer distinguishes a bug from the game working. The player never sees the flag.

---

## 8. Performance contract

The update budget is 3.0 ms total for simulation, creature AI and flight model
(`src/core/perf.js`). Creature AI gets **1.0 ms**.

| Constraint | Value | Why |
|---|---|---|
| Sense tick rate | 10 Hz, staggered by `senseOffset` | Cost spread, and it *is* the latency |
| Fully simulated creatures | ≤ 6 | Beyond that, reduced model |
| Medium samples per creature per sense tick | ≤ 32 | 6 × 32 × 10 = 1920 samples/s |
| Path integral samples | 8 | Not a march; a few per cent error is acceptable |
| Wake parcels | 768 | ~24 KB; see 3.3 for why this number |
| Thermal parcels | 512 | ~16 KB |

**The reduced model may never produce a detection.** A distant creature outside the six runs
position, flow response and audio only, with no senses and no attention. A creature can only find
the player if it is being fully simulated. This is a correctness rule, not an optimisation: the
alternative is being detected by something that was not running the detection code properly, which
is unexplainable by construction and therefore violates section 7.

Promotion into the fully-simulated set happens on distance and must happen far enough out that a
creature is never promoted already inside its own detection range. Promote at 1.4× the creature's
longest sense range, and record the promotion in the detection log.

---

## 9. Audio contract

All audio is synthesised — there are no audio files in this project and there will not be, for the
reasons in `src/core/audio.js`. That constraint is an advantage here: a creature's distance, mood
and threat can be continuous functions of state rather than a switch between clips.

Four things must be conveyed, and each has its own parameters. **Loudness is not one of them** —
loudness alone is the cue every game uses and it is the one the player cannot calibrate.

### 9.1 Distance

Three simultaneous cues, all continuous:

```
cutoff_hz = 120 + 5600 * exp(-d / 1800) * exp(-1.4 * Rho)   // lowpass, via drone.setFilter
wet       = 0.12 + 0.50 * (1 - exp(-d / 2500)) + 0.25 * rho_mean
attack_s  = 0.004 + 0.90 * (1 - exp(-d / 3000))
delay_s   = d / SOUND_SPEED
```

The onset term is the one that is usually missed and it does most of the work: a call from 200 m
cracks into existence in 4 ms; a call from 6 km swells over most of a second. A near sound and a far
sound are different sounds, not the same sound at different volumes.

`delay_s` is mandatory. A call from 3 km arrives 9.1 s after the event that produced it, so a
creature the player can see and a creature they can hear are in different places in time. That is a
scale cue, a threat cue and a puzzle at once.

### 9.2 Direction

Pan by relative bearing, plus the delay above. Bearing accuracy degrades with `bearingSigma` from
section 4 — the *sound the player hears* is panned to the corrupted bearing, not the true one, so
the player's confusion and the creature's confusion come from the same medium terms. In a duct,
everything sounds like it is beside you.

### 9.3 Mood

Harmonic content, not volume. Each creature has a fixed fundamental. Calm is few partials at
near-integer ratios; agitated is more partials at stretched ratios, plus amplitude modulation.
Inharmonicity is a single scalar the AI drives from `attention`:

```
partialRatio(n) = n * (1 + 0.045 * attention * n)
```

At attention 0 the voice is harmonic and settled. At attention 1 the upper partials are noticeably
sharp and the voice sounds strained. The player will not be able to name what changed, which is
correct.

### 9.4 Threat

Interval between vocalisations, and only that:

```
interval_s = calmInterval * (1 - 0.85 * attention)
```

Plus `duck('music', 0.45)` on any COMMITTED vocalisation, so the cue that matters is readable in a
dense mix.

### 9.5 The ship

The relief valve. Single-player audio dread has nowhere to go without a companion, and the ship is
the companion: hull noise that varies with the medium, instruments that tick, a reactor whose note
rises with load. When the creatures are quiet the ship must not be, or beat 1 of the session is
silence rather than isolation.

---

## 10. The archetypes

Each specifies: signature, senses, behaviour, avoidance, escalation with what the player perceives,
the mysterious behaviour, scale, and audio.

Two rules from the design mandate that constrain all four:

- **Not every creature is a chase.** Exactly one of these is a pursuer.
- **Detection must always be explicable.** Every entry below is reachable from section 7.

---

### 10.1 The Listener

**Scale.** 240 m long. Ship-to-creature ratio 1:17. It cannot be framed. At 400 m it fills the
view; at 2 km it is still unmistakably enormous. It is never fully visible in one shot, and staging
that manages to fit it inside the frame is wrong (Pillar 4).

**Environmental signature.** It displaces vapour on a scale that changes the map. Moving, it carves
a corridor of cleared, low-density air 300 m across that persists for several minutes and slowly
refills. Its own acoustic emission is 40 dB(V) of very low-frequency sound, continuous, except when
it is not.

**Senses.** Acoustic only. It is functionally blind.

| Property | Value |
|---|---|
| Threshold | 16 dB(V) normally, **6 dB(V) while listening** |
| Saturation | 60 dB(V) |
| Angular coverage | omnidirectional |
| Bearing sigma | per section 4.1 |
| False positive base | 0.02 Hz |
| Sense range | to `FAR_PLANE` in a duct; ~3 km in open air at cruise |

**Behaviour.** Territorial patrol along slow circuits, carving as it goes. It does not hunt so much
as *occupy*, and it herds by construction: the corridors it makes are faster, calmer and more
inviting than the surrounding vapour, so players route into them without being pushed. A corridor
is also a duct, so it is where the Listener hears best. It built the trap by existing.

**Avoidance.** Readable but genuinely awkward. The rule is *stay out of the corridors*, and the
corridors are where you want to fly: they are quicker, they are visible, and outside them the
medium is dense and slow. Once inside, the options are to reduce acoustic output below 16 dB(V) —
which means idle at best, and idle is slow — or to leave laterally through the corridor wall, which
costs time and puts you in dense air. Both are correct, and both are expensive, which is Pillar 2.

**Escalation.**

| State | Behaviour | What the player perceives |
|---|---|---|
| UNAWARE | Patrolling, carving, calling every 40–90 s | A slow drone from a bearing; corridors in the vapour |
| ALERT | Stops carving; calls stop; the corridor begins to refill | The vapour ahead stops being clear; the drone changes |
| SEARCHING | Sweeps the bearing estimate, 500 m/min, carving a new corridor towards it | A corridor opening in a direction it was not going |
| TRACKING | Turns onto the estimate, closes at 900 m/min | Displaced vapour pushing ahead of something unseen |
| COMMITTED | Full speed onto the estimate; body pressure wave arrives before it does | The medium itself moving towards you |

**The mysterious behaviour.** Every 100–160 s the Listener goes completely silent and completely
still for 18–26 s. It emits nothing and it does not move. Initially this reads as ominous
randomness, or as the creature having lost interest.

It is listening. Its own noise is 40 dB(V) and it is masking itself, so it stops. During those
windows its threshold drops from 16 to 6 dB(V), which is a factor of 3.2 on every range it has: a
ship at idle goes from detectable at 125 m to detectable at 400 m, and a ship at cruise from
3.2 km to 10 km. In open air the silence turns a creature that could not hear you into one that
can hear you from most of the map.

The rule the player learns is one sentence — **when it goes quiet, you go quiet** — and executing
it is a different problem: twenty seconds of powered-down drift, on a line chosen before the
silence began, in a corridor whose flow you have to have already read. This is the clearest example
in the game of a rule that is trivial to know and hard to perform, which is the answer to reduction
R6 in `GENRE_THESIS.md`.

**Audio.** Fundamental 24 Hz, felt more than heard, with audible partials at 48, 72 and 96 Hz.
Calls last 6–11 s and swell rather than start. Distance is carried almost entirely by the onset
term and by the delay — a Listener at 5 km is heard 15 s after it called, which the player
eventually learns to convert into distance without ever being told the number. The silence is the
loudest thing it does.

---

### 10.2 The Lantern

**Scale.** 90 m body; a lure array spanning up to 400 m. The body is rarely the thing you see. The
lights are 4 m across each and there are between nine and twenty of them.

**Environmental signature.** Light, obviously, but also a rising electrical charge in the
surrounding cells: `q` climbs by up to 0.5 within 600 m of it. That is a detectable tell in a
channel the player has an instrument for, and it is the honest early warning.

**Senses.** Photic and electromagnetic.

| Property | Photic | EM |
|---|---|---|
| Threshold | 0.004 lux-eq | 0.05 EMU |
| Saturation | 0.20 lux-eq | 4.0 EMU |
| Angular coverage | 360°, distributed across the lure array | omnidirectional |
| Bearing sigma | per 4.2 | per 4.3 |
| False positive base | 0.05 Hz | 0.03 Hz |

Detection ranges follow directly from the worked values in 4.2 and 4.3: nav lights at 550 m, search
lamp at 1500 m, scan flash at 3160 m; idle EM at 1340 m, cruise at 1990 m, boost at 3670 m, and the
scan *pre-charge* at 6000 m.

**Behaviour.** It does not chase and it is not fast. It surrounds. On SEARCHING it releases lure
elements that drift outward on the flow and encircle the estimate; on TRACKING it draws the ring
inward. The ring's closing speed is 40 m/min, which sounds slow until you notice how long you have
been deciding.

**Avoidance.** Going dark is necessary and not sufficient, because idle EM is still readable at
1.3 km. The real avoidance is *early*: leave through the ring while it is still thin, which means
committing to a direction before you are certain, on an incomplete picture. Waiting for certainty is
the trap, and it is a trap made of exactly the instinct the rest of the game rewards. A dense cloud
core reduces `quality` to near zero and buys ambiguity, but not distance — it will still know you
are near, just not where. The player then has to decide whether being an unlocatable presence
inside a closing ring is better than being a located one outside it.

**Escalation.**

| State | Behaviour | What the player perceives |
|---|---|---|
| UNAWARE | Drifting; lights pulse in slow, attractive patterns | A beautiful thing at distance. Worth approaching. This is beat 2 of the session |
| ALERT | Pulse rate rises; lights orient | The pattern becomes regular, then insistent |
| SEARCHING | Lure elements released and drifting outward | Individual lights separating and moving apart |
| TRACKING | **Lights dim towards nothing**; ring contracts | It appears to be losing interest and leaving |
| COMMITTED | Fully dark; body closes at 300 m/min | Nothing at all, then charge rising on the instrument |

**The mysterious behaviour.** The dimming. As the player gets closer, or as the Lantern gets more
certain, its lights fade — which reads unmistakably as loss of interest, and is the opposite. The
lights are a lure. A lure is only useful while it still needs to attract something, and once the
Lantern has a good enough estimate it stops advertising and starts closing. It goes dark because it
has *finished*.

The rule: **brightness is safety and darkness is commitment.** It is discoverable in one encounter
and it inverts the instinct every other game has trained, which is why it works. The
counter-behaviour it teaches — the moment to run is when things get calmer — generalises usefully
to the rest of the game.

**Audio.** Fundamental 320 Hz, glassy, near-pure partials at low inharmonicity, with a slow 0.3 Hz
tremolo while calm. Every change in the lights is accompanied by a short high electrical crackle —
`noise({ filter: 'highpass', freq: 4200, decay: 0.08 })` — so the dimming has a sound even when it
has no light. That crackle is the player's only cue during COMMITTED and it must be audible in a
dense mix; duck the music bus for it.

---

### 10.3 The Wake Hunter

**Scale.** 55 m, in packs of three to seven. Individually comprehensible, which makes them the only
creature the player can look at properly, and the pack is what makes them dangerous.

**Environmental signature.** Sharp local turbulence — they raise `u` to about 0.6 within 200 m,
which is visible in the vapour before they are.

**Senses.** Wake primary, thermal secondary. **Both are trail channels**, which is the whole point:
they never sense the ship, only what it did.

| Property | Wake | Thermal |
|---|---|---|
| Threshold | 0.05 s⁻¹ | 1.5 ΔK |
| Saturation | 2.0 s⁻¹ | 40 ΔK |
| Sense radius | 165 m (3 × body) | 220 m |
| False positive base | 0.12 Hz | 0.01 Hz |

The high wake false-positive rate, multiplied by `3.0 * u` in turbulence, means a pack in rough air
spends a lot of its time chasing eddies. That is correct and it is also the player's escape.

**Behaviour.** The only true pursuer. The pack spreads across a 600 m front and sweeps for trail;
when one finds a parcel above threshold, the others converge on it. They follow the trail
*forwards*, from older parcels to newer, which means they arrive at the player's position last and
by a route the player flew. Pursuit is therefore always behind and always along your own line.

**Avoidance.** Three levers, all derived from 3.3 and all learnable:

1. **Turbulence erases.** Wake decay is `60 / (1 + 8u)` seconds. Flying into rough air cuts your
   trail life from 106 s to 20 s, at the cost of control and of a much harder ride.
2. **Cross-flow separates.** The trail advects with the medium. Fly across the flow and the trail
   is carried away from your actual path at the flow speed; after 90 s in a 12 m/s crosswind it sits
   a kilometre to one side. Fly with the flow and the trail stays on top of you.
3. **Fly under your heat.** The thermal trail rises at 0.8 m/s. Anything following heat searches
   above the path you flew, so descending is safety and climbing puts you into your own history.

Boost is the wrong answer and must always be the wrong answer here: it writes a three-minute trail
at four times the strength. Against the Wake Hunter, running is what gets you caught, which is the
inversion that makes them interesting.

**Escalation.**

| State | Behaviour | What the player perceives |
|---|---|---|
| UNAWARE | Loose formation, drifting with the flow, occasional chirps | Distant clicks with long gaps. Small disturbances in the vapour |
| ALERT | Formation tightens; sweep pattern begins | Chirp rate rises; the pack becomes audibly a group |
| SEARCHING | 600 m sweep front, following older parcels | Chirps from several bearings at once, converging |
| TRACKING | Single file along the trail, closing | Rapid overlapping chirps from one bearing, behind |
| COMMITTED | Spread to cut off, direct intercept | Continuous chirping; turbulence arriving before they do |

**The mysterious behaviour.** They frequently break off and swing wide in a direction the player
never flew, apparently losing the scent, and then re-acquire from somewhere strange.

They are not going where the player went. They are going where the *trail* is now — and the trail
has been advecting on the flow for the whole time it has existed, and the thermal component has
been climbing at 0.8 m/s the entire time. In a 12 m/s flow, a two-minute-old trail sits 1.4 km
downwind of where it was made, and 100 m above it. The pack is tracking accurately; the target has
moved.

Once understood, this converts from confusing to controllable, because it makes the flow a tool:
the player can now *choose* where their trail will be by choosing their heading relative to the
flow. That is the transition from a mystery to a lever, and it is the single best example in the
roster of understanding becoming capability.

**Audio.** 900 Hz chirps, 40–90 ms, in overlapping pack sequences, panned individually so the pack
has width. **Chirp rate is a readout of trail strength**, not of proximity: a fast-chirping pack far
away means your trail is strong, and a slow-chirping pack nearby means it is nearly cold. The
player is being told, continuously and honestly, how well the hunt is going, and the information is
actionable. Nothing on the HUD needs to duplicate it.

---

### 10.4 The Choir

**Scale.** Individual elements 0.4 m. The shoal spans 2–6 km and there are tens of thousands. There
is no body and nothing to look at, and it is the largest thing in the game.

**Environmental signature.** A dense shoal absorbs sound — add `+6 dB` of acoustic absorption per
kilometre of shoal traversed — and scatters EM, raising `bearingSigma` by up to 0.8 rad. It is
therefore genuine cover, at a price.

**Senses.** All five, weakly, with no thresholds worth listing, because it is not hunting. It has no
attention integrator and it never enters TRACKING or COMMITTED. It is not a threat; it is an
information hazard.

**Behaviour.** It records and re-emits. Any signature it is exposed to — the player's, another
creature's — is stored with a timestamp and reproduced later, elsewhere in the shoal, at 0.7–1.3×
pitch. It has a capacity of some hundreds of recordings and it forgets the oldest.

The consequences are large and mostly indirect:

- **The player's instruments fill with contacts that are not there.** They are not noise; they are
  well-formed, plausible contacts that behave correctly for about a minute.
- **It can imitate the player**, and the imitation draws other creatures. A Wake Hunter pack that
  commits to a Choir echo of an engine note is committed to somewhere the player is not. **The
  worst thing for your instruments is the best thing for your survival**, and the choice between
  those is a real decision rather than a trade-off on a slider.
- **It responds to being scanned.** An active scan is loud, distinctive and immediately memorised,
  and it will be repeated for as long as the shoal remembers it. Scanning inside a Choir poisons
  your own instruments for the next several minutes.

**Avoidance.** You do not avoid it, you avoid trusting it, and the tell is precise:

> A real contact appears on **two or more channels with consistent bearings**. A Choir echo appears
> on **exactly one channel**, and its bearing is **the Choir's own bearing, not the bearing of the
> thing it is imitating**.

That is learnable, checkable, and it makes cross-referencing channels a skill rather than a chore.
The counter is that inside the shoal the echoes come from every direction at once, so the tell
degrades exactly where the cover is best. Cover and clarity are the same resource, spent opposite
ways.

**Escalation.** Not the standard machine. Four postures:

| Posture | Behaviour | What the player perceives |
|---|---|---|
| DISPERSED | Thin, scattered; occasional echoes | Rare single-channel contacts that vanish |
| GATHERING | Density rising; echo rate rising | Instruments getting busier for no reason |
| DENSE | Heavy absorption and scatter; constant echoes | Instruments unusable; sound muffled; genuine cover |
| RESONANT | Re-emitting a large creature's full voice | A Listener call, from the wrong place, slightly wrong pitch |

**The mysterious behaviour.** The false contacts are true.

The Choir does not invent. Every echo is a recording of something that was genuinely present, so a
phantom Listener contact means a real Listener passed through this volume — recently enough for the
shoal to still hold it. The lies are accurate historical records with the timestamps stripped off.

This turns the game's most frustrating system into its most valuable one. An experienced player
stops trying to filter out the Choir and starts *reading* it: a shoal thick with Wake Hunter chirps
is a shoal a pack has been sweeping, and that is worth knowing before you fly in. The information
was always there; only its interpretation was missing. This is the roster's deepest
mystery-to-understanding turn, and it should be the last one the player gets.

**Audio.** No voice of its own. It re-synthesises what it has heard, at 0.7–1.3× pitch with a
faint inharmonic ring from a comb-like partial that no real creature produces. The pitch offset and
the ring are a second, subtler tell available to a player who has learned the voices well enough to
notice that this one is slightly wrong. When dense, it also applies its absorption to everything
else, so the whole mix goes muffled and close — the sound of being inside something.

---

## 11. Cross-creature rules

1. **One COMMITTED at a time** (section 6).
2. **Creatures detect each other through the same model.** A Wake Hunter pack crossing a Listener's
   corridor is heard by it. Their interaction is not scripted; it falls out.
3. **The Choir records other creatures**, which is what makes its echoes informative.
4. **The Listener's corridors are the Lantern's ambush sites.** A duct is quiet, clear and
   inviting, and a Lantern parked at the end of one is a legitimate emergent situation. Do not
   author it; do not prevent it.
5. **Two known rules in conflict is the renewable content of this design.** Fleeing a Wake Hunter
   into turbulence to erase the trail is correct; if the turbulence is inside a Listener's duct, it
   is correct and fatal. Situations neither rule covers are where the depth lives, per reduction R6
   in `GENRE_THESIS.md`.

---

## 12. The test list

What must exist before any creature can be called finished.

**Medium**
- CPU/GPU density agreement, `max |Δρ| < 0.05` over 200 frustum points.
- `visibility_m` used by shader, senses and instruments — one call site each, verified by search.
- `duct` is non-zero inside a Listener corridor and near zero in uniform air.

**Signature**
- All eleven anchor states in 3.2 within 10% of the stated values.
- Trail parcel counts stay within cap over a 900 s run.
- A parcel is never dropped while still above any creature's threshold.
- The recorder holds 300 s and survives a `GAME.seek()`.

**Transmission**
- Worked values in 4.1, 4.2 and 4.3 reproduced within 5%.
- Bearing sigma reaches ≥ 1.2 rad for a light at 3 visibility lengths.

**Detection**
- Every state transition in a 900 s recorded session has a matching `DetectionEvent`. Zero
  exceptions is the pass condition.
- Replaying the same seed and the same input recording produces an identical detection log,
  including false positives.
- No creature outside the fully-simulated set ever appears in the log except as a promotion.

**Performance**
- Creature AI ≤ 1.0 ms with six creatures fully simulated, measured with `perf.begin/end('ai')`.
- No hitch above 45 ms during a COMMITTED encounter. A stutter at the moment something passes is
  not a performance problem, it is a broken encounter.

**Behaviour**
- Each archetype's mysterious behaviour is reproducible from a fixed seed, so it can be captured
  and looked at.
- For each pair of creatures, an action that is strongly correct against one and strongly wrong
  against the other, written down. An empty row means two creatures are the same creature.

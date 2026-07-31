# Additional score requests

Five prompts, in priority order, each filling a gap that was **measured** rather
than guessed. Numbers come from `evidence/music_segments.json` — 1158 eight-second
windows across the existing 26 tracks.

| role | windows scoring > 0.65 | verdict |
|---|---|---|
| unease | 1142 (98.6%) | over-served |
| pursuit | 473 (40.8%) | well served |
| conceal | 53 (4.6%) | thin |
| drift | 12 (1.0%) | nearly absent, and it is the **default** state |
| awe | **0** (0.0%), ceiling 0.59 | **unserved** |

The cause is visible in the features: `highRatio` has a median of 0.065 and never
exceeds 0.209 anywhere in the score. The existing material is uniformly dark and
low, which is right for dread and is exactly why awe cannot be reached — awe in
this system needs air, height, width and dynamic range.

**Every prompt below must keep the shared DNA**: 44–52 BPM, the same harmonic
language, the same instrument palette, and the three-note VEILWAKE motif. That
shared DNA is what lets the director crossfade between arbitrary windows of
arbitrary tracks without clashing. A track that breaks it becomes unusable no
matter how good it sounds on its own.

Two or three variants of each is ideal — the director selects windows, so more
variants means more usable windows.

---

## 1. AWE — highest priority, zero current coverage

> Instrumental cue for **VEILWAKE**, a survival-horror game about piloting a
> small ship through an endless ocean of living clouds. Same world, same
> harmonic language and the same fragile three-note VEILWAKE motif as the rest of
> the score. Slow pulse, 44–52 BPM.
>
> This cue is **the moment of awe**, not dread: the clouds open and reveal
> something enormous, ancient and beautiful — a cathedral of vapour lit from
> within, a structure the size of a mountain range, a vista that stops the pilot
> from flying. The fear is still there underneath, but it is the fear of scale
> rather than of a predator. Sublime, not threatening.
>
> **Open the top end and widen the stereo field**, which the rest of the score
> deliberately does not do: high sustained strings, glass harmonics, bowed
> crotales, distant wordless choir used as light rather than voice, shimmering
> upper partials, slow-blooming brass swells that resolve rather than threaten.
> Keep the sub-bass present but as a floor, not a threat.
>
> Wide dynamic range. Let it be genuinely quiet before it is genuinely vast, so
> the arrival lands. The motif should appear complete here for the only time —
> whole and clear, before the game takes it apart again.
>
> Avoid: percussion, ostinato, rhythmic drive, heroic fanfare, trailer braams,
> sentimentality, resolution into a major-key triumph. It should feel like
> witnessing something indifferent and enormous, and being moved by it anyway.

## 2. DRIFT — 1% coverage, and it is what plays most of the time

> Instrumental cue for **VEILWAKE**. Same world, same harmonic language, same
> three-note motif, 44–52 BPM.
>
> This is the **default state**: hours of quiet travel through empty cloud with
> nothing hunting you. It must be able to play for a long time without becoming
> tiring or building tension it does not intend. Not a threat cue with the
> volume down — genuinely calm, but never comfortable.
>
> Very slow-moving. Long sustained low woodwind and bowed metal, faint engine
> heartbeat, distant hull resonance, granular wind, occasional single notes of
> the motif appearing and not resolving. Air and space between events. The
> feeling is solitude and endless distance, with the environment breathing around
> a machine that is very small.
>
> Sparse. Long gaps. Nothing should arrive on a schedule the listener can
> anticipate. Static harmony that shifts only every 40–60 seconds.
>
> Avoid: build-ups, rising layers, ostinato, anything that promises an event.
> This cue must never imply that something is about to happen, because the game
> uses other music to say that and this one has to stay trustworthy.

## 3. CONCEAL — 4.6% coverage, and it carries a core mechanic

> Instrumental cue for **VEILWAKE**. Same world, same harmonic language, 44–52 BPM.
>
> The ship has cut its engines and is drifting, powerless and silent, while
> something enormous searches nearby. This is **held breath**. The player is
> straining to hear where it is.
>
> **Almost nothing.** Long stretches of near-silence that are not empty but
> *listening*. Isolated hull ticks as metal cools, filtered breathing, a single
> sustained harmonic barely above the noise floor, distant creature calls
> heavily filtered by intervening cloud, the faintest electromagnetic crackle.
> Sub-bass pressure that is felt rather than heard.
>
> The silence is the content. Leave five, ten seconds with almost nothing in
> them. When something does sound it should be small, close, and mechanical —
> the ship, not the score.
>
> **Critical: leave the entire midrange open.** Creature calls and cockpit
> warnings play over this, and the player must be able to locate a sound in space
> while it does. Nothing sustained between roughly 200 Hz and 2 kHz.
>
> Avoid: any pulse, any rhythm, swells, risers, stingers, and anything that
> resolves. It should be able to loop indefinitely without ever suggesting the
> danger has passed.

## 4. PSEUDO-STEMS — the highest-value structural request

The original brief asked for stems. Generated audio returns finished mixes, so
the score cannot currently be *layered* — only crossfaded. Deliberately thin,
single-element tracks recover most of that, because the director can stack them
over any window and they will agree harmonically.

Three separate prompts. Each should be **one element and almost nothing else**,
running the full length with no arc — no build, no resolution, no arrival.

> **(a) Pressure floor.** Instrumental bed for **VEILWAKE**, 44–52 BPM, same
> harmonic language. Sub-bass and low drone only: contrabass clarinet, bass
> trombone pedal tones, low strings, slow pressure waves felt more than heard.
> Nothing above 200 Hz. No melody, no rhythm, no development. A continuous floor
> intended to sit underneath other music. Static, patient, enormous.

> **(b) Machine layer.** Instrumental bed for **VEILWAKE**, 44–52 BPM. Ship
> mechanics only: hull resonance, cooling ticks, cable groans, bowed metal,
> distant machinery, an asymmetric mechanical pulse that never becomes a beat.
> Dry, close, small — the foreground machine against a world that is elsewhere.
> Midrange-focused, no sub-bass, no melody, no strings. Intended to layer over
> other cues.

> **(c) Air layer.** Instrumental bed for **VEILWAKE**, 44–52 BPM. High and wide
> only: glass harmonics, faint high strings, granular wind, filtered static,
> fragmented wordless choir used as texture, electromagnetic shimmer. Nothing
> below 500 Hz. Weightless, airy, spacious. No rhythm, no melody, no arc.
> Intended to layer over other cues to add height and scale.

## 5. TITLE AND ENDING — structural, one of each

> **(a) Opening.** Instrumental cue for the title and first moments of
> **VEILWAKE**. Same world, 44–52 BPM. Begins in near-total silence — one
> distant, enormous sound with no explanation. The three-note motif emerges
> fragile and incomplete on a solo low woodwind, and does not finish. Slowly
> introduce the engine heartbeat, as if the ship is waking. Ends unresolved, on a
> held note that asks a question. Under two minutes. It must make the player feel
> alone before they have done anything.

> **(b) Ending.** Instrumental cue for the end of a journey in **VEILWAKE**.
> Same world, 44–52 BPM. The pressure releases. The motif returns **altered and
> damaged** — recognisably the same three notes, but degraded, detuned, missing a
> voice, as though it survived something. Widen into the awe palette: high
> strings, distant choir, air. Do not resolve into comfort or triumph. End on
> uncertainty and enormous distance, suggesting the journey continues and that
> what was seen was never understood.

---

## After the files arrive

Drop them anywhere; they will be renamed and measured the same way. The pipeline
is:

1. Extract to `assets/music/` with sequential names (case collisions in the
   original filenames make this mandatory, not tidiness).
2. `tools/classify_music.js` → `segmentAll()` in the page, which re-measures
   every track in 8-second windows and rewrites `assets/music_index.json`.
3. Re-check the coverage table at the top of this file. The success condition for
   this round is **awe above 0.65 in at least 20 windows, and drift in at least
   60** — the director cannot select material that does not exist.

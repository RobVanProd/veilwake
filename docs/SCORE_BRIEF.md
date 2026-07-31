# The score

26 instrumental tracks, authored by the project owner. Original work; no
licensing question. Files are `assets/music/vw_01.mp3` … `vw_26.mp3`, with the
original filenames preserved in `assets/music/_original_names.json`.

They were renamed because the originals were not merely untidy — several differed
**only by case** (`VEILWAKE.mp3` against `Veilwake.mp3`, and three more pairs),
which cannot coexist in one directory on Windows and cannot be checked out
reliably from git on a case-insensitive filesystem.

---

## The authoring brief

All 26 are variants of a single prompt. It is reproduced here in full because it
is the authoritative statement of what the audio is *for*, and every decision in
`src/audio/music.js` answers to it.

> Create an instrumental adaptive score for **VEILWAKE**, a survival-horror game
> about piloting a ship through an endless ocean of living clouds inhabited by
> impossibly large creatures.
>
> **Style:** abyssal electroacoustic horror, organic industrial ambient, dark
> cinematic minimalism, alien environmental music, sci-fi dread.
>
> Express two scales at once: a fragile machine in the foreground and a planetary
> organism breathing around it. The clouds should feel alive — folding, charging,
> illuminating, and reacting to the ship.
>
> Use a slow pulse around **44–52 BPM**. Build tension through density, silence,
> timbral mutation, unstable harmonics, and pressure rather than speed.
>
> Use controlled sub-bass pressure waves; contrabass clarinet, bass flute, bass
> trombone, and low strings; bowed metal, cables, hull resonance, and distant
> machinery; granular wind, filtered static, electromagnetic crackle, and storm
> discharge; glass harmonics, faint high strings, fragmented wordless choir; and
> rare creature calls too vast to identify. Include a restrained three-note
> **VEILWAKE motif**, fragile and incomplete.
>
> Shape the cue as one continuous journey:
>
> **Isolation:** Near silence, vast air, distant cloud movement, faint engine
> heartbeat, cockpit vibrations.
> **Curiosity:** Shimmering internal light and fragments of the motif. Beautiful,
> ancient, almost welcoming.
> **Warning:** Irregular pressure shifts, detuned harmonics, reversed breaths,
> electrical disturbances. Something immense moves beyond visibility.
> **Recognition:** Imply a colossal silhouette through displaced low frequencies,
> brass glissandi, and vapor-like harmonic motion. Never reveal it fully.
> **Concealment:** Strip away most rhythm. Leave hull ticks, filtered breathing,
> distant calls, and barely audible harmony. Silence should feel active, as
> though the environment is listening.
> **Detection and pursuit:** Add an asymmetric mechanical ostinato, turbulent low
> strings, rising layers, and violent pressure waves without heroic action music.
> The player is surviving, not fighting.
> **Temporary safety:** Release pressure gradually. Return the motif altered and
> damaged. End in awe and uncertainty.
>
> Compose seamless adaptive stems for cloud life, ship motion, uncertainty,
> creature proximity, detection, pursuit, damage, system failure, shelter,
> discovery, and temporary safety.
>
> Layers must enter and leave cleanly, share compatible harmony, and loop
> naturally. Increase tension through information and pressure, not only volume.
> Preserve room for cockpit warnings, spatial creature calls, and gameplay audio.
>
> Avoid jump-scare stingers, trailer drums, heroic brass, blockbuster braams, EDM
> drops, nautical clichés, sentimental piano, choir lyrics, and conventional
> combat music.
>
> The result should feel beautiful, intelligent, and terrifying: an ancient cloud
> ecosystem communicating through breath, electricity, vibration, and impossible
> distance. Every player-made sound should feel audible to something unimaginably
> large.

## What the material actually is, measured

The brief asked for *stems*. Generated audio does not produce stems: what arrived
is 26 complete mixes, each containing the whole arc. That distinction decided the
entire director design, and it was established by measurement rather than assumed.

**Whole-track analysis produced a null result.** Every one of the 26 scored
`unease` between 0.79 and 0.89. Spectral centroid varied only 1.96× across the
complete set; crest factor 1.26×; low-band ratio 1.48×. In aggregate they are the
same piece of music. There is no "pursuit track" to select, and a director built
on per-track selection would have been choosing at random while appearing to work.

**Windowed at 8 seconds, the same material separates cleanly.** 1158 segments:

| role | range across segments |
|---|---|
| conceal | 0.10 – 0.72 |
| pursuit | 0.27 – 0.86 |
| unease | 0.53 – 0.96 |
| drift | 0.27 – 0.78 |
| awe | 0.24 – 0.59 |

The arc is *inside* each track. Averaging destroyed precisely the information the
director needed. So the unit of selection is a window, not a file.

This is also what makes crossfading between arbitrary points in arbitrary tracks
musically safe rather than a gamble: every variant shares tempo, harmonic
language and the three-note motif, so any window sits against any other.

Analysis is reproducible — `tools/classify_music.js`, run in the page, decoding
through WebAudio so there is no external tool. Full output in
`evidence/music_segments.json`; the compact runtime index is
`assets/music_index.json` (50 KB).

## How the director uses it

`src/audio/music.js`. A threat model — certainty, detected, hiding, escaping,
safety, damage, wonder — is mapped to a **weight per role**, and the best-matching
segment across all 1158 is selected and crossfaded to. Two situations that are
70% similar produce 70% similar music, which a cue-switching state machine
cannot do.

Verified selection:

| situation | picks | role blend |
|---|---|---|
| empty drift | vw_21 @ 8s | drift 0.86 |
| something is near | vw_16 @ 156s | unease 0.88 |
| hiding, engines off | vw_21 @ 8s | conceal 1.00 |
| detected, fleeing | vw_25 @ 140s | pursuit 1.00 |
| vista / discovery | vw_21 @ 12s | awe 0.55 |

**Loudness is a separate question from material**, and it is where the brief's
instruction about active silence is honoured. Measured gain: 0.98 drifting, 0.78
suspicious, **0.11 hiding**. The score gets quieter as the danger increases —
inverted from the obvious mapping, on purpose. A brief hollow is also opened at
the moment of recognition, where a lesser score would place a sting.

Streamed through `HTMLAudioElement`, not decoded to buffers: 109 MB of source
would be well over a gigabyte of float PCM resident, and the director only ever
needs two playheads.

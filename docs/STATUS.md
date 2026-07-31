# What is built, and what is not

The honest inventory. Written because "is that done?" was becoming hard to answer
from the commit log, and because several things in this repo are *written,
tested, and connected to nothing* — which is the worst state to lose track of.

**The test of "built" used here is: can a player reach it by playing?** A module
that exists, exports cleanly, and is imported by nothing is listed as NOT BUILT,
however good it is. That distinction has already cost this project real time
twice — the cockpit and all four creature bodies were each reported finished
while being unreachable from the running game.

Last updated: after the creature bodies landed.

---

## Reachable by a player

| Thing | State | Notes |
|---|---|---|
| **Volumetric clouds** | ✅ | The best thing in the project. GPU ray-march, multi-scatter, aerial perspective, 2.1 ms of a 7 ms budget. CPU and GPU sample the same field, proven to 0.0015. |
| **Luminaries** | ✅ | Three coloured sources rise and set on long cycles. No sun. The whole palette derives from whichever are up. |
| **Flight model** | ✅ | Forces not velocities, anisotropic drag, commanded-bank servo, stall. 12 control-polarity tests. |
| **Ship camera** | ✅ | Spring-mounted with velocity feed-forward, hard self-turn cap, seven comfort options — **none of which are adjustable in-game**. |
| **Xbox controller** | ✅ | Radial deadzone, response curve, absolute-position trigger throttle, dual-rumble driven from hull state. |
| **Cockpit** | ✅ | Real geometry, lit by the luminaries, occludes the view. Corner seams leak slightly. |
| **Ship lamps + plume** | ✅ | Registered with the cloud light registry, so they light the vapour. Cast real beams. |
| **Signature system** | ✅ | Six channels with different clocks. Every action that helps you survive makes you louder. Anchors reproduce within 1%. |
| **ShipSystems** | ✅ | Reactor, engine, lights, and the scan — charge tell then pulse. |
| **The Listener** | ✅ | Hunts by sound with real propagation delay. Has a body. |
| **Creature bodies** | ✅ | All four render, lit by the luminaries, occluded by cloud. |
| **The vertical slice** | ✅ | Nine beats, three playstyles verified end to end: competent → ESCAPED 3.8 min, stealthy → ESCAPED 5.2 min, reckless → TAKEN 2.4 min. |
| **Captions** | ✅ | Two registers. The game's only text. |
| **Test suite** | ✅ | 158 passing at `/tests/`, including the art direction as a regression. |

---

## NOT reachable by a player

Everything here exists in the repo and is unreachable from the running game.

| Thing | State | What is missing |
|---|---|---|
| **Music** | ❌ **56 authored tracks, silent** | `assets/music/` holds 56 mp3s and `music_index.json` has per-segment feature analysis. `src/audio/music.js` has a MusicDirector that picks 8-second windows by threat model — including deliberate silence at 0.11 gain while hiding. **Nothing imports it. The game makes no sound at all.** |
| **Creature voices** | ❌ | `src/audio/language.js` — synthesis for creature calls, the Listener's 24 Hz fundamental, the Lantern's tremolo. Never imported. |
| **Audio engine** | ❌ | `src/core/audio.js` exists and is imported by nothing. There is no WebAudio graph, no gesture-gate, no buses. |
| **Title screen** | ❌ | The game boots straight into flight. |
| **Pause** | ❌ | No way to stop. |
| **Options** | ❌ | The seven comfort settings, gamepad sensitivity and pitch-invert are all implemented and all unreachable. |
| **Death / restart UI** | ⚠️ | `director.restart()` works and `caption.js` shows a bare overlay. Not a screen. |
| **The other three archetypes in play** | ⚠️ | Lantern, Wake Hunter and Choir are fully simulated, tested and have bodies — but the director's beats only ever spawn a Listener. |
| **Corridor carving** | ⚠️ | `corridor.js` models the Listener's 300 m cleared corridor and the creature uses it, but the renderer does not carve, so it is invisible. |

---

## Known defects

Measured, not suspected.

1. **The Wake Hunter's turbulence tell renders as hard geometric dashes** across
   the whole 150–1200 m band a pack is actually fought at. Called blocking by an
   adversarial review.
2. **The Choir is invisible against dark sky** — an on/off pixel diff at 2.6 km
   with 26,619 points returned *exactly zero* changed pixels.
3. **Bodies flatten to hard-edged cut-outs against bright cloud** — no internal
   tone, no rim.
4. **Dither stipple is visible in dark regions** and the stronger in-scatter made
   it worse. The cause is in the density march's running transmittance, not the
   lighting.
5. **The Choir draws 26k–34k points** against a budget line of 4,000.
6. **Cockpit corner seams leak** slightly at some attitudes.

---

## Deliberate non-goals

Recorded so they are not mistaken for gaps.

- **No combat.** Survival is signature management, hiding and fleeing.
- **No minimap, no objective marker, no red warning icon.** `GAME_VISION` beat 3
  says the moment a warning is a UI event, beats 3–5 collapse into one.
- **No numeric HUD of the signature channels.** The instruments and the sound of
  the ship carry it; putting numbers on the glass replaces a thing the player
  feels with a thing they read.
- **Discrete sun shafts** are not achievable from inside the cloud deck — you
  look *along* the light there, so shadow reads as dark bands in bright air. The
  poster image needs a camera below and outside the layer.

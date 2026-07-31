# What is built, and what is not

The honest inventory. Written because "is that done?" was becoming hard to answer
from the commit log, and because several things in this repo are *written,
tested, and connected to nothing* — which is the worst state to lose track of.

**The test of "built" used here is: can a player reach it by playing?** A module
that exists, exports cleanly, and is imported by nothing is listed as NOT BUILT,
however good it is. That distinction has already cost this project real time
twice — the cockpit and all four creature bodies were each reported finished
while being unreachable from the running game.

Last updated: after corridor carving landed and the NOT-reachable list emptied.

---

## Reachable by a player

| Thing | State | Notes |
|---|---|---|
| **Volumetric clouds** | ✅ | The best thing in the project. GPU ray-march, multi-scatter, aerial perspective, 2.1 ms of a 7 ms budget. CPU and GPU sample the same field, proven to 0.0015. |
| **Luminaries** | ✅ | Three coloured sources rise and set on long cycles. No sun. The whole palette derives from whichever are up. |
| **Flight model** | ✅ | Forces not velocities, anisotropic drag, commanded-bank servo, stall. 12 control-polarity tests. |
| **Ship camera** | ✅ | Spring-mounted with velocity feed-forward, hard self-turn cap, seven comfort options, all adjustable from Options. |
| **Xbox controller** | ✅ | Radial deadzone, response curve, absolute-position trigger throttle, dual-rumble driven from hull state. |
| **Cockpit** | ✅ | Real geometry, lit by the luminaries, occludes the view. Sealed — zero uncovered corner pixels at eleven attitudes and four aspect ratios. |
| **Ship lamps + plume** | ✅ | Registered with the cloud light registry, so they light the vapour. Cast real beams. |
| **Signature system** | ✅ | Six channels with different clocks. Every action that helps you survive makes you louder. Anchors reproduce within 1%. |
| **ShipSystems** | ✅ | Reactor, engine, lights, and the scan — charge tell then pulse. |
| **The Listener** | ✅ | Hunts by sound with real propagation delay. Has a body. |
| **Creature bodies** | ✅ | All four render, lit by the luminaries, occluded by cloud. |
| **The vertical slice** | ✅ | Nine beats, three playstyles verified end to end: competent → ESCAPED 3.8 min, stealthy → ESCAPED 5.2 min, reckless → TAKEN 2.4 min. |
| **Captions** | ✅ | Two registers. The game's only text. |
| **Music** | ✅ | 46 authored tracks. A director picks 8-second windows by threat model, including deliberate near-silence while hiding. Bed layers, creature voices, ducking. |
| **Title / pause / options** | ✅ | The seven comfort settings, gamepad sensitivity and pitch-invert are adjustable now. Keyboard and pad navigable. |
| **HUD** | ✅ | Control legend that fades, and swaps for the active device. |
| **Signature instruments** | ✅ | Six live columns in the centre of the console, reading the real channels. |
| **All four creatures in the slice** | ✅ | Lantern at TRACE, Listener through the middle, a Wake Hunter pack at HUNTED, a Choir on the way out. |
| **Corridor carving** | ✅ | The Listener's 300 m corridor is cut out of the volume the player is looking at. On the axis 92% of the density is gone, softening to nothing by the wall; segments refill over 240 s. The shader's `vw_carve` and the CPU's `_carve` read the same packed segments, so `clearance()` and the picture are one number — CPU/GPU agreement holds at 0.0012 with corridors live. |
| **Test suite** | ✅ | 170 passing across 9 suites, including the art direction, corridor carving and the whole vertical slice as regressions. |

---

## NOT reachable by a player

Everything here exists in the repo and is unreachable from the running game.

*Empty.* Corridor carving was the last entry and shipped; see the note below for
why it sat here so long.

> **Worth remembering.** Corridor carving was complete on the simulation side for
> weeks — the field aged, refilled and served `clearance()`, the Listener carried
> one, and §2.3's duct test already routed sound down it. What was missing was two
> things at once: the renderer never carved, and `carving` defaults to `false` so
> that a creature under test does not reshape the medium it is measured in.
> Nothing in the game overrode that default. So the field stayed permanently
> empty, no test went red, and the TRACE beat said SOMETHING CAME THROUGH HERE
> over undisturbed cloud. The lesson for this table: "module exists and is
> imported" was not a strong enough test of *built*. `tests/corridor.test.js` now
> asserts the whole chain — field carves → renderer is told → density drops →
> CPU and GPU still agree.

---

## Known defects

Measured, not suspected.

1. **The Wake Hunter's tell is imperceptible.** The hard dashes are gone — that
   part is fixed and independently confirmed — but what replaced them measures
   1.5–2.5 levels against an instrument noise floor of 1.12. Artefact-free and
   invisible is progress, not the feature. Two causes were identified: the
   disturbance is drawn behind the whole cloud column and multiplied by its
   transmittance (measured 0.002–0.08), so most of the amplitude is spent before
   it reaches the eye.
2. **Dither stipple is visible in dark regions** and the stronger in-scatter made
   it worse. The cause is in the density march's running transmittance, not the
   lighting.
3. **The Choir's interior is thin.** Bringing the point count inside budget cost
   density from the inside of the shoal — 0.25% of frame at 4,033 points.
4. **The Listener's flank vanes read as pale lobes** stuck on the body rather
   than tissue continuous with it.
5. **The first ~90 seconds of a run are near-black** (mean luminance 32/255 at
   t=45 s) before the weather opens up.
6. **`wonder` is never derived**, so the score's "awe" role is unreachable in
   normal play. It needs a real vista signal from the director.

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

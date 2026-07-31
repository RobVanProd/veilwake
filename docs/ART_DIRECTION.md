# Art direction

Standing requirements. These come from the project owner and are not open for an
implementer to quietly trade away for frame time. Where something here conflicts
with a budget, raise it rather than silently dropping it.

---

## The feeling, which is the actual specification

**Fear, dread, and majestic awe** — held together, at the same time.

That combination is the whole point and it is harder than any one of them alone.
Fear on its own becomes a haunted house. Awe on its own becomes a screensaver.
The target is the feeling of being very small inside something enormous that is
alive, indifferent, and occasionally attentive — the sublime in the old sense:
beauty that is frightening *because* of its scale, not despite it.

Practical consequences, each of which can be checked in a capture:

- **The player must feel small.** Every shot should contain something whose
  extent leaves the frame. If the whole of a cloud form fits on screen, it is not
  big enough. Scale is established by things being *cut off*, not by things being
  centred.
- **Beauty is the bait.** The most dangerous places should be the most beautiful:
  the light shaft you want to fly into is the one that silhouettes you. If the
  player is never tempted into a bad decision by how something looks, the awe is
  decorative.
- **Dread is anticipation, not shock.** The game earns fear by making the player
  suspect before it confirms. A silhouette at the edge of visibility, vapour
  bending around something unseen, a shaft of light interrupted by a shape that
  is gone when it clears. Jump scares are explicitly out.
- **Restraint.** Whatever is fully shown stops being frightening. Creatures are
  glimpsed, partial, occluded, or inferred. The imagination finishes them and it
  will always do a better job than the renderer.
- **Silence and stillness are tools.** The quietest, emptiest moments should be
  the most tense. See `AUDIO_LANGUAGE.md` on deliberate silence.

## Light, and god rays

**Every light source in the game produces volumetric light shafts.** This is a
standing requirement, not an effect to be enabled on high settings.

It matters for three separate reasons and all three are load-bearing:

1. **Scale.** Shafts are the cheapest honest way to show that the air is thick
   and that the distance is enormous. A beam that visibly loses itself in vapour
   tells the player how far they can see without a single number.
2. **Volume.** Ray-marched cloud without in-scattering reads as a flat matte
   painting. The shafts are what make the medium look like it has an interior.
3. **Gameplay.** The ship's own lights are a **detectable signature**. The shafts
   the player casts are the visual evidence that they are broadcasting — so the
   most useful navigation aid is also the thing that gives them away, and the
   player can *see* that trade rather than being told it.

Required behaviour:

- Shafts are produced by **in-scattering accumulated during the cloud ray march**,
  so they are occluded by real density, self-shadow correctly, and bend around
  what is actually in the volume. A screen-space radial blur alone is not
  acceptable as the primary method — it does not respect occlusion and it is
  immediately obvious.
- A screen-space pass may *supplement* it for very bright point sources, composited
  depth-aware.
- Sources that must cast them: the ship's exterior lights and thrusters,
  lightning inside the cloud body, creature bioluminescence (the Lantern in
  particular), beacons, derelict wrecks, and whatever the sky above the cloud
  layer is.
- Shafts must move. A static shaft reads as geometry; the medium is breathing, so
  the light through it breathes too.

## Light: there is no sun

**The world is lit by luminaries, not by a star.** `src/render/sky.js` owns three
coloured sources that rise and set on long, mutually prime cycles, and the entire
palette — key direction and colour, sky gradient, haze, ambient, deep multiple
scattering — is *derived* from whichever are currently up. Nothing about the
light is authored twice, so the sky can never disagree with what is supposedly
lighting it.

This section exists because the renderer spent a long time quietly assuming
Earth, and the assumption was invisible until it was measured. The key was
`[2.30, 2.24, 2.02]` — white in all but name — over a medium with a neutral
albedo, and the frames measured a **chroma of 0.055**: grey, the failure named
below as the most likely one. You cannot tint your way out of that, because a
white source through a white medium gives white and anything applied afterwards
reads as a filter over a photograph.

- **Veil** — cold green-cyan. Most of the game happens under it.
- **Ember** — copper, dim, up about a third of the time. Warm and *wrong*.
- **Drown** — indigo, always present, never dominant. It exists so shadow has a
  hue instead of being an absence.

**The medium is not water.** `MEDIUM_ALBEDO` gives the vapour a slight cast of
its own, which matters more than the tint of the key: it means the lit and
shadowed faces of one mass differ in **hue** and not only in value, and that is
what stops a cloud reading as a grey shape with a bright edge.

**Two properties are asserted by `tests/mood.test.js` and are not negotiable
without a decision:** the frame is never grey (`chroma >= 0.12` at every sampled
moment), and **the light changes across a run** (warmth spans at least 25; it
currently spans 61.7). The second is unwritable against a sun, and
`GAME_VISION`'s third beat — *"a light that was there is not"* — depends on it.

## Colour

Restrained but striking. **Not generic grey fog** — that is the named failure
mode and the most likely one, because grey is what an untuned ray march produces
by default.

The palette should be cold and deep by default — blues, slates, the green-black
of deep water — so that any warm light reads as an event. Electrical activity,
creature light and the ship's own lamps should be the only saturated things in
frame most of the time. When the palette does shift, it should mean something:
a region with a different character, or something enormous arriving.

## Composition

- Strong silhouettes. The reading of a shape at the edge of visibility must be
  unambiguous even when the shape is not.
- Deep atmospheric perspective, with several distinct depth layers, so distance
  is legible.
- The cockpit is a major visual surface, not a frame. Small, sharp, detailed
  instruments against enormous soft external forms is the contrast the whole look
  rests on — condensation, glass reflections, warning lights, shadows thrown
  across the interior by whatever is outside.
- Partial visibility as a default state, not an effect.

## What to check in every capture

1. Does something in frame exceed the frame?
2. Is there a light shaft, and is it occluded by real density?
3. Is there a clear near / mid / far separation?
4. Would a still from this be frightening *and* beautiful, or only one?
5. Is anything grey that should be blue?

---

## Status after the first cloud pass (2026-07-30)

The renderer is built and verified. The **look is not there yet**, and the gap is
worth stating precisely rather than as a feeling.

**What is right.** Density, self-shadowing, light transmission, wisps, layered
structure at several scales, honest atmospheric perspective, and in-scattering
computed properly — Henyey-Greenstein phase, multiple-scattering octaves, Beer's
law, a powder term, and a light march for shadowing. Performance is 1.86 ms
against a 7 ms budget, so there is room to spend on the look.

**What is wrong, and why the first captures misled.** The showcase images were
taken from *above* the cloud layer in high daylight, which is a flight-sim shot,
not this game. Seen from *inside* the layer with the sun near the horizon — where
the game actually lives — the same renderer produces the intended mood.
Compare `evidence/baseline/clouds.png` (wrong) with
`evidence/baseline/mood_inside_layer.png` (right). The palette constants were
correct all along; the camera was not.

**Consequence:** the default camera and the region's sun elevation are art
direction, not scene setup. A region whose sun sits high enough to light the tops
of the clouds evenly has no dread in it, whatever the palette says.

**God rays: partial.** In-scattering is real and visible — the bloom through a
gap in `evidence/baseline/inscatter_toward_sun.png` is genuinely occluded by
density. But it reads as diffuse glow rather than as discrete shafts. Distinct
beams need two things this pass does not yet do:

1. **Sharper shadow contrast along the view ray.** Shafts are spatial *variation*
   in in-scattered light, so the light march needs enough steps to resolve
   hard-edged occluders rather than averaging them into a soft falloff.
2. **Local light sources.** Every shaft in the game so far comes from the sun.
   The ones that matter dramatically — the ship's own lamps, lightning inside the
   cloud body, creature bioluminescence — do not exist yet, and those are the
   ones tied to the signature system, where the shafts the player casts are the
   evidence that they are broadcasting.

Neither is a missing capability; both are a tuning-and-content pass on machinery
that is already correct.

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

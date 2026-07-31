# VEILWAKE — genre thesis

The purpose of this document is to answer, honestly, the only question that matters before the
work is done: **is there anything here that has not already been made better by someone else?**

A thesis that only engages with weak comparisons is worthless, so the reductions below are stated
in their strongest form, the way a hostile and well-informed person would put them. Where the
reduction is substantially correct, it is conceded, and the concession is followed by the thing
that must therefore be excellent for the project to be worth finishing. A conceded point is not a
defeat; it is a requirement with a name.

---

## 1. The claim, stated so it can be wrong

> VEILWAKE's distinctive structure is that a single continuously simulated volumetric field is
> simultaneously the terrain the player navigates, the concealment both sides use, and the medium
> through which all detection happens — and that the creatures' senses read that same field, at the
> same fidelity, as the renderer.

Everything else about the game — the ship, the four creatures, the signature economy — is a
consequence of that, or it is borrowed.

**What would falsify it.** If the field driving the creatures' perception can be replaced with a
coarse, separate approximation and nothing about how the game plays changes, the claim is false
and VEILWAKE is a fog-shaded stalker game with good weather. That is a real risk, because the
cheap version is much easier to build and it is what almost every game in this space actually
does.

**The test that defends it** is the one in `GAME_VISION.md` Pillar 1: `Medium.sample()` on the CPU
and the density the cloud shader evaluates agree to within 0.05 at 200 random points, verified by
GPU readback. If that test is deleted, quietly weakened, or never written, this document should be
read as having conceded everything below.

**Why the claim is not merely a rendering claim.** A shared field only matters if the sharing has
consequences the player can act on. There are four, and they are specified with numbers in
`CREATURE_BEHAVIOR_CONTRACT.md`:

1. **The medium has acoustic geography.** Sound loses roughly 12 dB per kilometre through density
   1.0, and separately, where the field has a strong gradient — a shear layer, or a corridor carved
   by a large body — it is trapped and spreads cylindrically rather than spherically. That duct is
   worth about 14 dB at six kilometres, which is the difference between inaudible and obvious. So
   there are routes that are quiet and routes that carry, and the easiest-looking route through the
   vapour — the cleared corridor — is the one that carries an engine note furthest. It is cleared
   because something enormous made it, and the thing that made it is listening down the length of
   it. None of that was authored; it falls out of the field having a gradient.
2. **Concealment inverts by channel.** Dense cloud hides your hull and muffles your engine, and at
   the same time it takes your lamp and turns it into a wide directionless glow that is no dimmer,
   only unlocatable. Light does not become safer in fog; it becomes ambiguous. The player has to
   decide which of those they need.
3. **The trail is a physical object in the field.** Heat and wake are shed into the medium and then
   advected by its flow, decaying at rates set by local turbulence. Cutting the engines silences
   the field channels immediately and does nothing at all about the three minutes of trail already
   written into the sky. That asymmetry is the game's central tension and it only exists because
   the medium is simulated rather than sampled.
4. **The same flow that hides you moves you.** Drifting is concealment and loss of control at the
   same time, in exactly the proportion the local flow decides.

None of those four is available to a game whose fog is a post-process.

---

## 2. The reductions

### R1 — "This is Subnautica in clouds."

**The strong version.** Subnautica already did the whole thing: an unarmed player in a fragile
vehicle, in a three-dimensional medium that limits sight, with enormous creatures that produce
genuine dread, and a sound design that makes the unseen worse than the seen. It did it with a
better sense of place than a procedural cloud ocean is likely to manage, and its Cyclops — a large
slow vehicle with a noise level, a heat signature, a silent-running mode and creatures that
respond to all three — is *already* a signature-management game inside a fluid medium. VEILWAKE is
that subsystem, extracted and given a fog shader.

**Conceded, substantially.** The Cyclops is the closest existing implementation of this game's
core loop, and the small-vehicle-in-vast-medium fantasy is Subnautica's. Anyone claiming otherwise
has not played it.

**What is actually different.** Subnautica's ocean is authored and static. Its biomes are fixed
geometry, its concealment is level design — kelp, caves, wrecks — and its creature detection is a
radius with a leash. The water is a beautiful constant, not a variable; it never has a direction
that matters, it does not carry your heat somewhere, and it does not have regions that transmit
sound better than others. Subnautica's medium is a *place*. VEILWAKE's medium is a *system*. In
Subnautica you hide behind something; in VEILWAKE you hide *in* something, and the something is
moving, and it will not be there in ninety seconds.

Subnautica is also a survival and base-building game with crafting, resource loops and a
progression tree. VEILWAKE has none of that, by explicit non-goal.

**What must therefore be excellent.** The medium must be as legible as Subnautica's biomes. This
is the hard part and it is where the project most plausibly fails: Subnautica's Grand Reef is
memorable because a person drew it. A procedural field has to earn the same memorability from
structure alone — flow features, density fronts, charged cells, carved corridors — and if a
capture of a VEILWAKE region cannot be told apart from a capture of a different VEILWAKE region,
this reduction wins outright.

### R2 — "This is Alien: Isolation with a bigger map and worse AI."

**The strong version.** Isolation is the definitive intelligent-stalker game and it solved
signature management properly: noise, sightlines, the motion tracker that gives you information at
the price of making you audible and taking your eyes off the room. Its creature is genuinely
unscripted at the tactical level and famously convincing. A four-creature roster in an open sky
cannot be tuned to that standard, and open space is a much harder place to build tension than a
corridor. VEILWAKE will produce a diluted version of a better game.

**Partly conceded, and this is the most dangerous comparison.** Isolation's signature management is
better than anything VEILWAKE currently specifies, and its central lesson — that a *tool which
gives you information at a cost* is the best generator of tension available — is one this project
is copying directly with active scanning.

**What is actually different, and it is structural.** Isolation has one sensory model. The
xenomorph hears and sees; the correct play is therefore always some combination of quiet and
hidden, and the game's variety comes from the geometry rather than from the threat. VEILWAKE has
four mutually incompatible sensory models. Going dark defeats the Lantern and does nothing to the
Wake Hunter, which is reading a trail you shed four minutes ago. Going quiet defeats the Listener
and leaves you slow, hot and lit, which is the Lantern's ideal target. There is no configuration
that is correct against two of them at once, so the decision in beat 6 of the session is a genuine
choice rather than an execution test. That is a different game, not a smaller one.

Isolation is also a level; VEILWAKE is a medium. The xenomorph moves through vents which are
authored topology. The Listener moves through vapour and *changes the topology by moving*, which is
the one thing Isolation's creature can never do.

**The honest problem: the director.** Isolation's alien is famously two systems — a senses layer
that plays fair, and a director that knows where you are and shapes the search. VEILWAKE will
almost certainly need something similar; encounters that are entirely emergent are mostly boring.
The comparison therefore produces a hard constraint rather than a rebuttal: **any director in this
project may act only before contact** — on placement, timing, weather and approach — **and may
never modify a sense, a threshold or a position during an encounter.** If it wants a creature
nearer, it puts one nearer before the player knows it exists. Every state transition still has to
be explained by a real stimulus through a real medium. That is Pillar 3, and it is written down
precisely because this reduction makes the temptation to cheat legible.

**What must therefore be excellent.** The creatures' tactical behaviour at close range, where
Isolation is at its best and where an open sky offers the fewest natural affordances.

### R3 — "The volumetric medium is a rendering achievement being sold as a design claim."

**The strong version.** Real-time volumetrics are hard and impressive, and impressed developers
routinely mistake a technical accomplishment for a design one. Players do not experience "one
shared density field"; they experience fog. The gameplay described could be delivered by a coarse
grid with a nice shader on top, at a fraction of the cost, and the player would never know.

**This is the strongest reduction in the list, and it is only answerable with the four consequences
in section 1.** They are the answer because each of them changes a decision the player makes:
choosing the corridor or the open vapour; running lamps or running dark; boosting or drifting;
flying with the flow or across it. If, in playtesting, those decisions turn out to be made on
instinct rather than on medium state, the reduction is correct.

**Conceded in part.** A coarse grid *could* deliver most of it. What it could not deliver is the
guarantee that the picture and the simulation agree — and the failure that guarantee prevents is
specific and very common: a creature that detects you through cloud you were visually hiding
inside, which destroys the player's ability to reason and therefore breaks Pillar 3 and the whole
"you can always work it out" proposition. So the shared field is not primarily a fidelity choice.
It is the thing that makes the game's promise of explicability keepable.

**What must therefore be excellent.** The medium's readability at a glance. If a player cannot
look at a region and estimate its density, its flow direction and whether it is charged, the
simulation is invisible and the reduction stands regardless of how correct the code is.

### R4 — "This is Iron Lung with more frames."

**The strong version.** Iron Lung already demonstrated that you never need to show the creature,
that a handful of readings and a photograph can generate more dread than any model, and that the
whole thing works better when it is thirty minutes long and entirely authored. VEILWAKE is trying
to build a simulation to produce something Iron Lung produced with a spreadsheet.

**Conceded on the point of proof.** Iron Lung is proof that inference beats depiction, and
VEILWAKE takes that directly.

**What is actually different.** Iron Lung's readings are authored, so the fear is authored, so the
game is a single fixed experience that cannot survive a second playthrough — which is a legitimate
design choice for a game of that length and is not available to a game built around learning
behavioural rules. VEILWAKE's readings are generated, which means they can be *wrong in
structured ways the player can learn to recognise*: a Choir echo appears on exactly one channel and
always carries the Choir's own bearing rather than the bearing of the thing it imitates. That is a
rule which cannot exist in an authored reading, and it is the difference between atmosphere and a
system.

**What must therefore be excellent.** The instruments. Iron Lung's are perfect and they are almost
the entire game. VEILWAKE's have to be as good while also being honest about a simulation
underneath them.

### R5 — "Endless procedural space is a known failure mode — see No Man's Sky, Elite Dangerous."

**The strong version.** Elite and No Man's Sky both discovered that vast procedural volume produces
sameness, that travel through an empty medium is dead time, and that the interesting parts end up
at authored destinations. A cloud ocean will be a prettier version of the same emptiness.

**Conceded as a risk, and it is already a stated non-goal.** The answer is structural rather than
promissory: VEILWAKE is not open-ended. The unit of design is a bounded ten-to-fifteen-minute
crossing. There is no galaxy and no travel between content, because in VEILWAKE the travel *is* the
content — the medium is where everything happens, so there is no empty part to skip.

The instructive difference is what the medium does for the player. In Elite, space is a distance
between things and its only property is how long it takes. In VEILWAKE, the medium has five local
properties that all matter to the current decision, and the player is reading them continuously.
Flight in Elite is about the ship; flight here is about the air.

**What must therefore be excellent.** Local distinctiveness. See R1 — this is the same requirement
arriving from a different direction, which is a good sign that it is the real risk.

### R6 — "Knowledge-as-progression saturates. This is Outer Wilds' idea applied to something that
runs out."

**The strong version.** Outer Wilds works because its knowledge is about a specific, authored,
enormous secret, and discovering it is a one-way door. VEILWAKE's knowledge is four behavioural
rules. A player learns them in two hours, and after that there is no progression at all, only
execution — at which point the game is a stealth game with an unusually good sky and it will be
judged as one.

**Conceded, and this is the most likely long-term failure.** Four rules is not a lot of knowledge.
The comparison to Outer Wilds flatters the project and should be dropped: Outer Wilds' knowledge is
*content*, and VEILWAKE's is *skill*.

**The honest reframing.** The right comparison is not Outer Wilds but a game where knowledge
becomes execution under pressure. Knowing that the Listener's silence means maximum sensitivity is
one sentence; performing thirty seconds of powered-down drift while it is quiet, on a line you
chose before it went quiet, is a skill that does not saturate. The rules are the *entry fee*, not
the content. That means the encounters have to remain hard after they are understood, which is a
much steeper design requirement than "make discoverable rules" and it should be treated as the
project's central long-term problem.

**What must therefore be excellent.** Execution depth under a known rule, and the interaction of
creatures — because two known rules that conflict produce a situation neither rule covers, and
that is the only renewable source of new problems this design has.

### R7 — "Audio-driven threat is Lethal Company's, and it needs other people to work."

**The strong version.** Lethal Company demonstrated that audio is the strongest threat channel
available to a game, and it also demonstrated why: because there were other players to say "did
you hear that" to. Audio dread in single-player has no relief valve and it collapses into either
tension fatigue or players turning the sound down.

**Conceded on the mechanism.** The social loop is doing a lot of work in Lethal Company and it is
not available here.

**What is actually different, and it is technical.** Every sound in VEILWAKE is synthesised — there
are no audio files in the project and there will not be, for the reasons in `src/core/audio.js`.
That is not an asset-pipeline convenience. A sample can be triggered and pitched; a synthesised
voice is a continuous function of game state. It means distance can be carried by filter cutoff,
reverb wetness *and onset softness* simultaneously and continuously, so a call at 2 km and a call
at 2.3 km are genuinely different sounds rather than the same sound quieter. It means a creature's
agitation can be a smooth change in the inharmonicity of its partials rather than a switch between
"calm loop" and "angry loop". And it means the Choir can literally re-synthesise a voice it heard,
detuned, which is not something a sample library can do.

VEILWAKE also applies the propagation delay honestly — `d / 330` seconds — so hearing a thing and
seeing it are separated in time by an amount that encodes distance. That is a scale cue, a threat
cue and a puzzle simultaneously, and almost nothing ships with it.

**What must therefore be excellent.** The relief valve. Without a co-op partner, the ship itself
has to be the company: its noises, its instruments, its small failures. If the ship is not a
presence, the tension has nowhere to go.

### R8 — "Acting on degraded information is Duskers, and Duskers did it better."

**The strong version.** Duskers made incomplete information the entire game, and it did it with a
command line and a schematic display — an interface so committed that the fiction and the UI were
the same object. Any first-person game gives the player their eyes back, and eyes destroy
ambiguity.

**Conceded on interface.** Duskers' interface-as-fiction is stronger than anything a first-person
game can do, and the project should resist the temptation to imitate its aesthetic — scanlines and
a monospace font — without the systemic commitment underneath. Borrowing the look of degraded
information while giving the player a clear view is the worst of both.

**What is actually different.** Duskers' information is discrete: a room either has a contact or
it does not. VEILWAKE's is *spatially continuous and partially correct* — a shape at 800 m through
density 0.6 is genuinely half-seen, and the player's uncertainty is about identity and distance
rather than presence. That is a different kind of not-knowing, and it supports a different
mistake: acting confidently on a real contact that you have misjudged the range of. Duskers cannot
produce that error.

**What must therefore be excellent.** The half-seen. Silhouette, displacement, partial occlusion —
the specific visual language of something large that is 40% resolved. If creatures read either as
"clearly visible" or "not there", this reduction wins.

### R9 — "Barotrauma already has sonar contacts, unseen threats and a hostile medium."

**The strong version.** Barotrauma has an unknown-contact loop, creatures that come out of the
dark, a vessel that must be managed, and a genuinely hostile medium — plus far more systemic depth
in the vessel itself.

**What is actually different.** Barotrauma's medium is essentially uniform: water is water, and the
interest is in the submarine and the crew. Its sonar is a game system layered onto the world rather
than a consequence of it. And it is fundamentally a crew game whose best material is the comedy and
catastrophe of people failing together.

VEILWAKE inverts the weighting: a simple vessel in a complex medium, alone. The complexity budget
is spent outside the hull rather than inside it. That is a deliberate choice and it has a cost —
Barotrauma's ship systems are more interesting than VEILWAKE's will be — which is acceptable only
if the medium justifies the spend.

**What must therefore be excellent.** The medium, again. Four reductions now converge on the same
requirement.

### R10 — "FAR: Lone Sails and Signalis show this is an atmosphere piece, and atmosphere pieces are
short."

**The strong version.** The vehicle-as-companion and the lonely-machine mood are well-trodden, and
games built on them are correctly short, because mood does not sustain mechanical interest. If
VEILWAKE is really an atmosphere piece, it should be ninety minutes long and should stop
pretending to be a systems game.

**Partly conceded.** FAR's central insight — that a vehicle you physically tend becomes a
character — is one this project wants, and its brevity is a design virtue rather than a
limitation.

**What is actually different.** FAR has no antagonist with a model of you. The tending is
uncontested; nothing is reading the smoke. In VEILWAKE every act of tending has a signature cost,
so maintenance is a tactical decision rather than a rhythm. That is the difference between a mood
and a loop.

**What must therefore be excellent.** Not becoming a chore simulator. Ship management has to stay
under a threshold where it reads as intimacy rather than upkeep, and the moment a system needs
attention on a fixed timer for its own sake it should be cut.

---

## 3. Where this game is derivative, plainly

Listed so that nobody has to discover it in a review.

| Element | Taken from | Consequence |
|---|---|---|
| Small vehicle, vast hostile medium, unarmed | Subnautica (Seamoth, Cyclops) | The medium must be a system, not a place |
| Information tool that costs safety | Alien: Isolation (motion tracker) | Scan cost must be tuned hard; 1–3 uses per session |
| Never showing the threat in full | Iron Lung, Isolation | The half-seen must be visually excellent |
| Audio as primary threat channel | Lethal Company, Barotrauma | Needs a single-player relief valve: the ship |
| Knowledge as the only progression | Outer Wilds | Rules are the entry fee; execution must carry the depth |
| The vehicle as companion | FAR: Lone Sails | Must not become upkeep |
| Contacts that may be false | Duskers, submarine games | Falseness must be structured and learnable |

Seven rows. That is most of the game. The originality budget is spent in one place, and if the
medium does not deliver, there is no second argument.

---

## 4. What is actually new, stated conservatively

Not "nobody has ever" — that claim is almost always wrong. What can be said:

1. **One field for image, flight and perception, at the same fidelity, verified by a test.** Games
   with volumetric clouds generally give the AI a cheaper parallel model. Making them the same
   thing is a modest technical claim with a large design consequence: it is what makes the promise
   of explicability keepable.

2. **Field, trail and contact channels as distinct classes with different temporal behaviour.**
   Most stealth games have one class of emission that stops when you stop. Splitting emissions into
   things you can recall instantly and things already written into a moving medium is the source of
   this game's central decision, and it is a direct consequence of simulating the medium.

3. **Four sensory models that cannot be satisfied simultaneously.** Not four creatures with
   different speeds — four creatures for which the correct response is mutually exclusive.

4. **Propagation delay as a first-class cue.** Sound at 330 m/s, applied properly, so lateness
   means distance and the player learns to read it.

5. **False information that is structurally true.** The Choir's echoes are historical records of
   real signatures, so a lie is a fact about the past. That is a much better idea than random false
   positives and it is the one piece of the design that no reduction above accounts for.

Item 5 is small and it may be the most distinctive thing in the game.

---

## 5. The verdict, and the condition on it

VEILWAKE is worth building **if and only if the medium is both simulated and legible**. Every
reduction above converges on that: R1, R3, R5 and R9 all resolve to it directly, and R2, R6 and R8
resolve to it once you follow them one step further.

If the medium is simulated but illegible, the game is a beautiful grey nothing with hidden systems
nobody perceives, and the correct response is to cut the simulation and ship a mood piece.

If the medium is legible but not simulated, the game is a competent stealth game in fog, and it
will be compared to Alien: Isolation and lose.

Both together is a game that does not currently exist. Nothing else in the design is worth
defending at the cost of that, and any decision that trades away either half should be refused
with a reference to this section.

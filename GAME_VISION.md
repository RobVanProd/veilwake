# VEILWAKE — game vision

This is a control document. It exists to settle arguments, not to sell anything. When two
reasonable implementations of a feature are on the table, the one that better serves the pillars
below wins, and the losing option is recorded as a rejected alternative rather than left to drift
back in later.

Read this with `GENRE_THESIS.md` (why the game is worth building at all) and
`CREATURE_BEHAVIOR_CONTRACT.md` (the numbers everything must agree on). Where this document and
the contract disagree about a quantity, the contract is right — it is the one the code is written
against.

---

## 1. The player fantasy

You are the pilot of a small, ordinary machine crossing something enormous and alive.

Every part of that sentence is load-bearing.

**Small.** The ship is roughly 14 m long. It is never the most impressive thing on screen. It has
no weapons, no shields and no special status. The player's relationship with it is the
relationship a person has with a car in bad weather: it is the only thing between them and the
outside, it makes noises they learn to interpret, and it can let them down.

**Ordinary.** The ship is not alien technology and it is not a marvel. Its instruments are
limited, honest and slightly behind reality. It does what a working machine does, which is enough
until it isn't.

**Crossing.** The player is going somewhere. They are not exploring for its own sake and they are
not clearing a space. A crossing has a direction, a cost and an end, and that is what stops the
game becoming an aimless void — the first non-goal below.

**Something enormous and alive.** The cloud ocean is not weather and not scenery. It moves with
intent at scales the player cannot perceive in one sitting. The creatures in it are part of the
same organism as the medium, not monsters placed inside it. The player's understanding is always
partial, and the game never resolves it fully. There is no lore terminal that explains what the
Choir is.

The fantasy is **competence without power**. By the end of a session the player should feel that
they were good at something — reading vapour, staying quiet, choosing a line — and that they were
never once strong.

---

## 2. The emotional sequence

The loop exists to produce this sequence, repeatedly, without the player noticing that it is a
sequence. Each beat has a duration, a required player state, a failure mode, and a way to detect
the failure that does not require asking the player how they felt.

| # | Beat | Target duration | The player is |
|---|------|-----------------|---------------|
| 1 | Isolation | 60–90 s | alone, occupied, slightly bored in a productive way |
| 2 | Curiosity | 60–90 s | drawn towards something specific |
| 3 | Subtle warning | 30–60 s | uneasy without being able to say why |
| 4 | Growing uncertainty | 90–150 s | actively trying to work out what is happening |
| 5 | Recognition | 20–60 s | certain, and behind |
| 6 | The decision | 15–45 s | choosing between two bad options under time pressure |
| 7 | Pursuit or concealment | 120–210 s | executing, adapting, running out of margin |
| 8 | Temporary safety | 45–90 s | alive, depleted, aware nothing is resolved |
| 9 | Awe | 30–60 s | shown something enormous that they only partly understand |

### 1. Isolation

The player has a heading, a machine that needs small continuous attention, and nothing else. The
medium is visually rich but behaviourally quiet.

*Failure:* dead air. If there is nothing to do, the player reaches for the boost out of boredom
and the session skips to beat 7 with no build.
*Detection:* time-to-first-boost under 45 s in a recorded session. If players boost early, beat 1
is under-supplied, not over-long.

### 2. Curiosity

Something in the medium is legible and interesting at range: a structure, a light, a corridor of
cleared vapour, a flow that is going somewhere. It is worth a deviation.

*Failure:* the interesting thing is decoration and rewards nothing, so players stop deviating and
the game becomes a straight line.
*Detection:* deviation rate. If the ratio of path length to great-circle distance drops towards
1.0 across a play session, curiosity is not paying.

### 3. Subtle warning

One channel changes in a way that is real but ambiguous: the flow bends, the acoustic floor drops,
a light that was there is not, instruments disagree by a small margin. Nothing is confirmed.

*Failure:* the warning is a UI event. The moment a warning is a red icon, beats 3–5 collapse into
one.
*Detection:* the warning must be describable in a sentence that contains no interface noun. If the
only way to describe it is "the contact indicator flickered", it is wrong.

### 4. Growing uncertainty

The player starts investigating: slowing down, listening, deciding whether to spend a scan. The
information they gather is genuinely incomplete and mildly contradictory. This is the longest
beat and it is where the game actually lives.

*Failure:* the player has a reliable action that resolves the ambiguity cheaply. If one scan
always answers the question, this beat is 4 s long.
*Detection:* scan usage. If active scanning is used at every ambiguity, its cost is too low; if it
is never used, its cost is too high. Target is roughly one to three scans per session.

### 5. Recognition

The player understands what they are dealing with and realises they are already inside its
process. Recognition arrives through the world — the shape of the corridor, the direction of the
chirps, the fact that the lights went out — not through a name appearing on screen.

*Failure:* recognition arrives too early and the whole middle of the session is spent knowing.
*Detection:* if players can name the creature before beat 4 ends, the tells are too explicit.

### 6. The decision

A choice between two options that are both bad in different currencies, made under time pressure,
with incomplete information. For example: boost clear now and write a four-minute trail across the
sky, or cut engines and drift into a region whose flow you have not read.

*Failure:* one option dominates. This is the single most likely way the game breaks, and it is
what Pillar 2 exists to prevent.
*Detection:* option distribution across recorded sessions. If any option is chosen more than 70%
of the time in comparable situations, it is dominant and must be repriced.

### 7. Pursuit or concealment

Sustained, several minutes, with the player's plan degrading. The creature is not scripted to lose
or to win; it is running the same rules it was running in beat 1. The player's job is to manage
signature, read the medium and buy distance.

*Failure:* it resolves in fifteen seconds either way. A pursuit that ends immediately is a jump
scare with extra steps; a concealment that works instantly is a stealth toggle.
*Detection:* encounter duration histogram. Target median 150 s, with the 10th percentile above
60 s.

### 8. Temporary safety

Not safety. The threat is still in the world, it still knows something, and the player's ship is
in a worse state than it was. The relief is real but it is a comma.

*Failure:* the game says "you escaped". Nothing may declare the encounter over. The encounter
ends when the creature's state machine returns to UNAWARE, and the player learns that from the
world going quiet.

### 9. Awe

Something enormous, visible, partly comprehensible, and not currently trying to kill the player.
This is where the scale of the world is established or lost. It should raise a question rather
than answer one.

*Failure:* awe is delivered by a cutscene, or by a creature that fits neatly on screen.
*Detection:* if the awe moment can be captured in a single 1600×900 frame with the whole subject
inside it, the subject is too small.

### Ordering

The sequence is a target, not a rail. Beats may compress, overlap, or repeat, and beats 3–5 may
resolve into nothing at all — a warning that turns out to be a Choir echo is a legitimate outcome
and one of the better ones. What must not happen is a session that reaches beat 7 without passing
through 3–5, because that is a jump scare, which is non-goal 2.

---

## 3. Pillars

Four. Each is stated so that a specific implementation can be shown to violate it. A pillar that
cannot be violated is a slogan.

### Pillar 1 — The medium is terrain, concealment and sensor channel at once, and it is one field

Cloud density, temperature, charge, flow and turbulence are simulated continuously, and the *same
field* that the renderer marches is the field the creatures sense through and the field the flight
model flies through. Not a parallel approximation. The same function.

**What it arbitrates.** Any proposal to give the AI its own cheaper occlusion model, or to place
hand-authored "hiding spots", or to make density a post-process. It also arbitrates the reverse:
a visual feature that has no effect on absorption, flow or lift does not go in.

**How it is violated.**
- A creature sees the player through cloud the player cannot see through, or fails to see them in
  air that is visually clear.
- Concealment is a volume with a boolean inside it.
- Density affects the image but not the acoustic absorption term.
- Two different noise functions exist for "the clouds you see" and "the clouds you fly through".

**The test.** `Medium.sample()` on the CPU and the density the shader evaluates must agree to
within 0.05 at 200 random points across the frustum, checked by GPU readback. If that test cannot
be written, the pillar is not being kept. This is also the test that defends the central claim in
`GENRE_THESIS.md`, so it is not optional.

### Pillar 2 — Every capability is paid for in signature, and no payment is universal

Speed, sight, information and warmth are all bought with emissions, and the four creatures punish
different emissions. There is no quiet-and-safe configuration, because quiet costs sight, and
sight costs light, and light is what the Lantern eats.

**What it arbitrates.** Every new system. The first question about any proposed ship feature is
"what does it emit, in which channel, and which creature does that help". A feature with no
signature cost is either trivial or it is a dominant strategy.

**How it is violated.**
- A single loadout or behaviour is correct against every creature.
- An upgrade reduces a signature without increasing another.
- Boost is affordable. Boost must always feel like spending capital.
- A creature is dangerous in a channel the player cannot control at all.

**The test.** For each pair of creatures, there is at least one action that is strongly correct
against one and strongly wrong against the other. Write that table down; if a row is empty, two
creatures are the same creature.

### Pillar 3 — You are never told, and you can always work it out afterwards

The game does not narrate. It also does not cheat. Every detection has a cause expressible in one
sentence with a number in it, and that sentence is recoverable — first by the developer through
the detection log, and eventually by the player through the world.

**What it arbitrates.** Any AI director that "helps" an encounter along; any tuning that nudges a
creature towards the player without a stimulus; any UI that states a fact the world does not
support. A director may bias spawn placement, weather and timing, all of which happen before
contact. It may not adjust senses during contact.

**How it is violated.**
- A creature turns towards the player with no `DetectionEvent` behind it.
- A detection's explanation is "difficulty scaling".
- The HUD names a creature the player has not identified.
- The player's post-mortem answer to "why did it find me?" is "it just did".

**The test.** `GAME.detectionLog()` returns the last 64 detection events, each with channel,
emitted value, transmitted value, threshold, distance and the medium terms in between. Every
state transition in every encounter has one. A transition with no event is a bug of the highest
severity in this project, higher than a crash, because a crash is visible.

### Pillar 4 — Scale is established by relation, never by assertion

The size of things is communicated by the ship's relationship to them: how long a shadow takes to
pass, how far a call is behind its source, how much of the sky something occupies while still
being distant. Never by a number on screen, and never by a shot composed to fit the subject.

**What it arbitrates.** Camera work, creature staging, draw distance, fog tuning, and the constant
temptation to move a creature closer so it reads better. If it does not read at its real distance,
the answer is to make it larger or louder, not nearer.

**How it is violated.**
- The largest creature fits entirely inside a 62° field of view at the moment of greatest threat.
- Sound arrives at the same instant as the sight of its source. At 330 m/s, a call from 3 km
  arrives 9.1 s late, and that delay is one of the strongest scale cues available.
- The horizon reads as a backdrop rather than as more of the same medium.
- A distance readout is used to convey size.

**The test.** Take a capture at the peak of an encounter. If the subject's silhouette is bounded
on all four sides by the frame, the staging is wrong.

---

## 4. The session

Ten to fifteen minutes, self-contained, with a beginning and an end. The player starts a crossing,
crosses, and arrives somewhere or does not. A session is the unit of design; it is what gets
tuned, recorded and argued about.

A representative fourteen-minute session:

- **0:00** Launch into a legible medium with a heading and a stated distance. Instruments settle.
  The ship makes its small noises. Nothing is wrong.
- **1:20** A structure resolves ahead — a corridor of cleared vapour running roughly the way the
  player wants to go. It is faster, calmer and quieter to fly. Taking it is obviously correct.
- **2:40** The corridor is too straight and too clean. Acoustic absorption inside it is very low,
  which the player has no way to know yet. They cruise.
- **3:30** A call arrives, low, long, from behind and above, and it is *late* — the player does
  not yet understand that lateness means distance.
- **4:00** Instruments show a contact at a bearing that does not match where the sound came from.
  Uncertainty starts. Investigating costs either speed or a scan.
- **6:00** Flow direction shifts. The corridor is closing behind them; it was carved, and the
  thing that carved it is still in it.
- **6:40** Recognition. The player is inside a listening duct with a Listener at one end.
- **7:00** The decision: boost out of the corridor into unread turbulence, and be heard by
  everything for the next minute while writing a three-minute wake trail; or cut engines, drift,
  lose control of their line, and hope the duct's flow carries them clear before the Listener's
  next silent-listening window.
- **7:20–10:30** Whichever they chose, executed under pressure. Margins narrow. The medium is now
  a resource being spent rather than a view.
- **10:45** Quiet. Instruments recover. The ship is warm, the trail is still out there, and the
  Listener has not left the world.
- **12:30** Ahead, the medium opens. Something the size of a weather system moves through the gap
  and is gone, and it was never interested in them. The player has no idea what it was.
- **13:40** Arrival, or the honest failure of it.

**Failure ends a session; it does not end a run.** Death is not the point of pressure — being
found is. What death costs is the crossing, which is a real cost because the crossing had a
purpose.

---

## 5. Non-goals

Each is a real temptation. Each has a note on what we do instead, because a non-goal without an
alternative gets quietly re-introduced under a different name.

**No conventional shooting as the central solution.** The player has no weapon that resolves an
encounter. *Instead:* tools that shape the medium or the player's own signature — things that
change the terms of a problem rather than deleting it. If something ever fires, its effect is on
the vapour, not on flesh, and it is loud.

**No jump scares.** No sudden loud thing at close range as the primary fear delivery. *Instead:*
anticipation and consequence. If a creature appears close and suddenly, that must be the outcome
of a mistake the player can reconstruct — see Pillar 3. The rule of thumb: a scare that would work
identically with the sound muted and the creature replaced by a cardboard cutout is a jump scare.

**No power fantasy.** The player never becomes the dangerous thing. There is no moment of turning
the tables. *Instead:* the arc is from incompetence to competence, which is a different and more
durable satisfaction. The world does not get weaker; the player gets better at it.

**No upgrade tree.** No experience, no currency, no unlock grid, no permanent stat increases.
*Instead:* knowledge is the progression, and configuration is the choice — the same finite set of
systems, traded against each other per crossing. A returning player is faster because they know
what the dimming means, not because their hull is rated higher.

**No tutorial wall.** No sequence of gates that must be walked through before the game starts.
*Instead:* the first crossing is a real crossing with a benign medium and one creature at low
pressure. Everything is taught by consequence. The only text is on the instruments, and it is text
the instruments would have anyway.

**No infinite repetitive void.** Procedural extent is not a feature and is not advertised. A world
that goes on forever and is the same everywhere is worse than a small one. *Instead:* a bounded
crossing with local structure that is distinct, memorable and describable — the player should be
able to say "the place where the flow went vertical", and mean somewhere.

**No generic grey fog.** Nothing in the medium may be undifferentiated. Every region has a
density, a temperature, a charge, a flow and a turbulence, and those are readable in the image.
*Instead:* fog is always doing something — hiding, revealing, carrying, glowing, or moving. If a
capture shows a grey field with no structure and no direction, it is a bug and it is filed as one.

**No dialogue, no companion voice, no radio friend.** The isolation is the point. *Instead:* the
ship's own systems and the creatures' voices carry everything. If information needs to reach the
player, an instrument reports it or the world shows it.

---

## 6. Terms this project uses precisely

These words are not interchangeable. Using them loosely in code or in discussion is how two
systems end up disagreeing.

- **Signature** — what the ship emits, per channel, right now. See the contract.
- **Trail** — what the ship has already emitted and cannot recall: thermal parcels and wake
  vorticity, sitting in the world, advecting.
- **Field channel** — acoustic, photic, electromagnetic. Propagates from the source and stops when
  the source stops.
- **Trail channel** — thermal, wake. Persists in space after the source has gone.
- **Contact channel** — relative motion, pressure. Sensed only at very close range.
- **Percept** — one creature's noisy, delayed, possibly false estimate derived from a stimulus.
- **Contact** — what the player's instruments show. A contact is a percept the *ship* formed, and
  it is wrong in the same ways a creature's is.
- **Detection event** — the auditable record that explains a state transition.
- **Encounter** — the span from a creature leaving UNAWARE to it returning there.
- **Crossing** — one session.

---

## 7. Open questions

Recorded so they are decided deliberately rather than by whoever implements first.

1. **Does the crossing have a destination the player chose, or one they were given?** Chosen makes
   the decision in beat 6 heavier, because the player owns the route. Given is easier to tune.
   Leaning chosen, with a small set of legible options.
2. **What is the ship's failure state?** Instant loss is cheap; a limping, degraded ship that has
   to finish the crossing is far better and much harder to make readable. Leaning degraded, with
   a hard cap so it cannot become a slow death.
3. **How much does the player carry between crossings?** Knowledge, certainly. Anything else risks
   becoming the upgrade tree by the back door.
4. **Can two creatures be in an encounter at once?** The contract currently forbids two creatures
   in COMMITTED simultaneously. Whether that is a permanent rule or a first-pass simplification is
   undecided.

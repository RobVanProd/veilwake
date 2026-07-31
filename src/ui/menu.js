// Title, pause, options, and the end of a run.
//
// The whole of this game's interface, and it is deliberately small. Four screens
// and one rule that decides every layout question in the file: **the game is the
// background, not a thing behind a dialog.** There is no panel, no card, no
// border box and no rounded rectangle anywhere below. Text sits directly on the
// frame with a gradient under it, the way a film title does, because the clouds
// are the best thing on screen and a modal would be an admission that the
// interface does not think so.
//
// Three consequences, each of which is a real constraint rather than a
// preference:
//
//   1. **Legibility has to come from the type, not from a background.** The
//      frame behind any of this can be near-black (a night crossing under the
//      drown luminary) or close to white (a sunlit mass through a gap), often
//      within the same second. Every text layer here therefore carries a heavy
//      shadow and sits over a *directional* gradient — anchored to the block, not
//      a full-screen wash — so the picture stays visible where the words are not.
//
//   2. **Nothing pops.** Selection moves by colour, by a hairline that grows, and
//      by letter-spacing opening slightly. No scale bounce, no glow pulse, no
//      background fill on hover. The caption layer fades over 900 ms and the
//      ending over 2 s; an interface that moves faster than the fiction it sits
//      on tears the surface.
//
//   3. **Both hands.** Keyboard, mouse and gamepad drive the same selection
//      model, and the gamepad is not an afterthought: `core/gamepad.js` exists
//      and works, and a game flown with a stick that has to be paused with a
//      keyboard is a game with a hole in it.
//
// This file owns no game state. It reads and writes settings that already exist
// in `game/camera.js` and `game/controls.js`, calls out for audio and restarts,
// and otherwise only knows how to draw.

import { installStyles, installTokens, FADE } from './hud.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Defaults are the full experience, matching the modules they drive.
 *
 * The comfort values are `COMFORT_DEFAULTS` from `game/camera.js` and the audio
 * values are `Audio.volumes` from `core/audio.js`, copied rather than imported.
 * Copied because this object is also the *shape* of what gets written to
 * localStorage, and importing a live default would silently change the meaning
 * of a stored settings blob the day somebody retunes the camera. A player who
 * has never opened the options screen should get the new tuning; a player who
 * has should keep their choice. That only works if the stored file is compared
 * against a fixed schema, which is this.
 */
export const SETTINGS_DEFAULTS = {
  // Camera comfort — every one of these is already implemented in
  // ShipCamera.comfort and was, until this file existed, unreachable.
  shake: 1.0,
  roll: 1.0,
  fovShift: 1.0,
  lean: 1.0,
  threatCamera: 1.0,
  motionBlur: 1.0,
  horizonLine: 0.0,
  // Controls
  mouseSteer: true,
  mouseSensitivity: 1.0,
  padSensitivity: 1.0,
  invertPadPitch: false,
  // Audio buses. `core/audio.js` starts at exactly these numbers.
  master: 0.8,
  music: 0.7,
  sfx: 1.0,
};

/**
 * Versioned key.
 *
 * If the schema changes incompatibly the version goes up and every stored blob
 * is ignored rather than half-read. A settings file that loads *partially* is
 * worse than one that does not load at all, because the failure is invisible:
 * the player's comfort setting quietly reverts and nothing says so.
 */
const SETTINGS_KEY = 'veilwake.settings.v1';

function loadSettings() {
  const out = { ...SETTINGS_DEFAULTS };
  let raw = null;
  // localStorage throws outright — not returns null — when the page is opened
  // from file:// in some browsers and under strict privacy modes. This game is
  // required to run from a folder, offline, forever, so that is a supported
  // configuration and it must not take the menu down with it.
  try { raw = localStorage.getItem(SETTINGS_KEY); } catch { return out; }
  if (!raw) return out;
  try {
    const got = JSON.parse(raw);
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      if (!(k in got)) continue;
      const want = typeof SETTINGS_DEFAULTS[k];
      if (typeof got[k] === want) out[k] = got[k];
    }
  } catch { /* corrupt blob: the defaults above are already correct */ }
  return out;
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const CSS = `
.vw-menu { z-index: 70; }

/* The frost.
   Pausing blurs the world rather than covering it, and the difference matters:
   a black overlay says the game has stopped, a blurred one says the game is
   still there and you have stepped back from it. It also solves legibility for
   free — a blurred frame has no high-frequency detail left to fight small type.
   Not applied to the title, where the picture is the point. */
.vw-frost {
  position: fixed; inset: 0; z-index: 68; pointer-events: none;
  opacity: 0; transition: opacity var(--vw-slow) ease;
  backdrop-filter: blur(14px) saturate(.82) brightness(.46);
  -webkit-backdrop-filter: blur(14px) saturate(.82) brightness(.46);
  background: rgba(3,5,10,.28);
}
.vw-frost.on { opacity: 1; }

.vw-screen {
  position: fixed; inset: 0; z-index: 70;
  opacity: 0; pointer-events: none;
  transition: opacity var(--vw-slow) ease;
}
.vw-screen.on { opacity: 1; pointer-events: auto; }

/* Anchored gradients, not a full-screen wash.
   A flat scrim over everything mutes the clouds evenly and the result looks like
   a photograph with the brightness turned down. These darken only the band the
   words occupy and release the rest of the frame completely. */
.vw-screen::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
}
.vw-title::before {
  background:
    linear-gradient(to top, rgba(3,5,10,.94) 0%, rgba(3,5,10,.74) 20%, rgba(3,5,10,.22) 46%, rgba(3,5,10,0) 66%),
    linear-gradient(to right, rgba(3,5,10,.62) 0%, rgba(3,5,10,.16) 42%, rgba(3,5,10,0) 62%);
}
.vw-pause::before, .vw-options::before {
  background: radial-gradient(ellipse 70% 62% at 50% 50%, rgba(3,5,10,.62) 0%, rgba(3,5,10,.30) 55%, rgba(3,5,10,.10) 100%);
}
.vw-ending::before { background: rgba(2,4,7,.80); }

/* --- shared type ------------------------------------------------------- */
.vw-eyebrow {
  font: 500 clamp(9px, .8vw, 11.5px)/1 var(--vw-face);
  letter-spacing: .62em; text-transform: uppercase; color: var(--vw-amber);
  opacity: .85; text-shadow: 0 0 16px rgba(0,0,0,.9);
}
.vw-rule {
  height: 1px; background: linear-gradient(to right, var(--vw-amber-dim), rgba(232,180,106,0));
  width: 0; transition: width 1400ms cubic-bezier(.16,.7,.3,1) 260ms;
}
.vw-screen.on .vw-rule { width: clamp(120px, 15vw, 260px); }
.vw-voice {
  font: 400 clamp(12px, 1.22vw, 17px)/1.75 var(--vw-voice);
  font-style: italic; color: var(--vw-blue); letter-spacing: .015em;
  text-shadow: 0 0 20px rgba(0,0,0,.95), 0 1px 3px rgba(0,0,0,.9);
  max-width: 34rem; margin: 0;
}

/* --- the list ---------------------------------------------------------- */
.vw-list { display: flex; flex-direction: column; }
.vw-row {
  position: relative; display: flex; align-items: center; gap: 1.4em;
  padding: .62em 0 .62em 2.2em; cursor: pointer;
  font: 500 clamp(10px, .95vw, 13.5px)/1.25 var(--vw-face);
  letter-spacing: .3em; text-transform: uppercase;
  color: var(--vw-blue-dim);
  text-shadow: 0 0 16px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.9);
  transition: color var(--vw-quick) ease, letter-spacing var(--vw-quick) ease;
}
/* The selection mark: a hairline that grows out of the left margin. This is the
   entire selected state, plus a colour change. A filled bar or a box would be
   the loudest thing on a screen whose subject is a cloud. */
.vw-row::before {
  content: ''; position: absolute; left: 0; top: 50%;
  width: 0; height: 1px; background: var(--vw-amber);
  transition: width var(--vw-quick) cubic-bezier(.2,.7,.3,1), opacity var(--vw-quick) ease;
  opacity: 0;
}
.vw-row.sel { color: var(--vw-amber); letter-spacing: .36em; }
.vw-row.sel::before { width: 1.5em; opacity: 1; }
.vw-row.hdr {
  cursor: default; padding-top: 1.9em; padding-bottom: .5em; padding-left: 2.2em;
  color: rgba(147,169,194,.42); letter-spacing: .5em;
  font-size: clamp(8.5px, .74vw, 10.5px);
}
.vw-row.hdr:first-child { padding-top: 0; }
.vw-row-label { flex: 1 1 auto; }
.vw-row-val {
  flex: 0 0 auto; display: flex; align-items: center; gap: 1.1em;
  color: var(--vw-blue);
}
.vw-row.sel .vw-row-val { color: var(--vw-amber); }
.vw-num { min-width: 4.2em; text-align: right; letter-spacing: .2em; font-variant-numeric: tabular-nums; }

/* Slider drawn as an instrument scale rather than a UI control: a hairline
   baseline, a filled portion, and a short vertical bar at the value. */
.vw-track {
  position: relative; width: clamp(84px, 11vw, 148px); height: 12px;
}
.vw-track::before {
  content: ''; position: absolute; left: 0; right: 0; top: 50%;
  height: 1px; background: rgba(147,169,194,.30);
}
.vw-fill {
  position: absolute; left: 0; top: 50%; height: 1px;
  background: currentColor; transition: width var(--vw-quick) ease;
}
.vw-knob {
  position: absolute; top: 1px; width: 1px; height: 10px;
  background: currentColor; transition: left var(--vw-quick) ease;
}

/* --- title ------------------------------------------------------------- */
.vw-title-block {
  position: absolute; left: clamp(24px, 7vw, 130px); bottom: clamp(48px, 13vh, 160px);
  display: flex; flex-direction: column; gap: 1.15rem; align-items: flex-start;
}
.vw-wordmark {
  margin: 0; display: flex; white-space: pre;
  font: 300 clamp(40px, 8.2vw, 118px)/1 var(--vw-face);
  letter-spacing: .26em; text-transform: uppercase; color: var(--vw-ice);
  /* The glow is nearly invisible and is doing real work: it detaches the letters
     from a bright cloud edge without a shadow heavy enough to read as a drop
     shadow, which would make the type look pasted on. */
  text-shadow: 0 0 60px rgba(120,170,220,.28), 0 0 22px rgba(0,0,0,.85), 0 2px 5px rgba(0,0,0,.9);
}
.vw-wordmark span {
  opacity: 0; transform: translateY(10px);
  transition: opacity 1500ms ease, transform 1500ms cubic-bezier(.16,.8,.3,1);
}
.vw-title.on .vw-wordmark span { opacity: 1; transform: none; }
.vw-title .vw-list { margin-top: .5rem; margin-left: -2.2em; }
.vw-title .vw-row { padding-left: 2.2em; }

/* Everything below the wordmark waits for it. The title is the shot; the menu is
   what you do after you have looked at it. */
.vw-title-late {
  opacity: 0; transition: opacity 1200ms ease 1500ms;
}
.vw-title.on .vw-title-late { opacity: 1; }

.vw-hint {
  position: absolute; right: clamp(20px, 3.4vw, 54px); bottom: clamp(18px, 3.2vh, 44px);
  font: 500 clamp(8.5px, .72vw, 10.5px)/1.7 var(--vw-face);
  letter-spacing: .28em; text-transform: uppercase; color: rgba(147,169,194,.45);
  text-align: right; text-shadow: 0 0 14px rgba(0,0,0,.95);
  pointer-events: none;
}

/* --- pause / options --------------------------------------------------- */
.vw-panel {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  padding: 6vh clamp(24px, 6vw, 90px);
}
/* One column, left aligned, holding the heading, the rows and the note.
   Centring the heading independently of the list is the obvious way to build
   this and it is wrong: the heading then floats somewhere to the right of the
   column it belongs to, because a left-aligned list of short labels is nowhere
   near as wide as the panel. Everything shares one left edge and the COLUMN is
   what gets centred. */
.vw-panel-col {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1.1rem;
  width: min(30rem, 74vw);
}
.vw-options .vw-panel-col { width: min(38rem, 84vw); }
.vw-panel-col .vw-list { width: 100%; }
.vw-options .vw-list {
  max-height: 58vh; overflow-y: auto; overscroll-behavior: contain;
  /* The scrollbar is suppressed on purpose: the list is navigated by selection,
     not by dragging, and a chrome scrollbar is the one piece of the operating
     system that no amount of art direction can style into this world.

     Suppressing it removes the only signal that there is more list, so the edges
     fade instead — and only on the side that actually has more, which is why
     these are two classes and not one permanent mask. A list that fades at the
     top when it is already at the top is telling the player something untrue.
     Twenty-one rows do not fit a 720p window; measured there, the list is 623px
     of content in 418px of panel. */
  scrollbar-width: none;
  --vw-fade-top: #000; --vw-fade-bot: #000;
  -webkit-mask-image: linear-gradient(to bottom, var(--vw-fade-top) 0, #000 26px, #000 calc(100% - 30px), var(--vw-fade-bot) 100%);
  mask-image: linear-gradient(to bottom, var(--vw-fade-top) 0, #000 26px, #000 calc(100% - 30px), var(--vw-fade-bot) 100%);
}
.vw-options .vw-list.more-above { --vw-fade-top: transparent; }
.vw-options .vw-list.more-below { --vw-fade-bot: transparent; }
.vw-options .vw-list::-webkit-scrollbar { display: none; }
/* The same 2.2em indent the rows use, so the heading lines up with the LABELS
   and the selection hairline hangs out into the margin the way a printed mark
   does, rather than pushing the text it marks sideways. */
.vw-panel-head {
  display: flex; flex-direction: column; align-items: flex-start; gap: .8rem;
  padding-left: 2.2em;
}
.vw-note {
  min-height: 3.4em; padding-left: 2.2em; text-align: left;
  font: 400 clamp(11px, 1.05vw, 14px)/1.7 var(--vw-voice); font-style: italic;
  color: rgba(147,169,194,.62); text-shadow: 0 0 18px rgba(0,0,0,.95);
  transition: opacity var(--vw-quick) ease;
}

/* --- ending ------------------------------------------------------------ */
.vw-ending { transition-duration: ${FADE.glacial}ms; }
/* The ending is the one screen that is not a list of choices with a heading —
   it is a full stop. Centred, and wide enough for the sentence. */
.vw-ending .vw-panel-col {
  align-items: center; text-align: center; gap: 1.5rem; width: min(42rem, 86vw);
}
.vw-ending .vw-list { align-items: center; }
.vw-ending .vw-row { padding-left: 2.2em; padding-right: 2.2em; }
.vw-outcome {
  margin: 0; display: flex; white-space: pre;
  font: 400 clamp(26px, 4.4vw, 62px)/1 var(--vw-face);
  letter-spacing: .52em; text-indent: .52em; text-transform: uppercase;
  color: var(--vw-ice); text-shadow: 0 0 40px rgba(0,0,0,.9), 0 0 90px rgba(120,170,220,.2);
}
.vw-outcome span {
  opacity: 0; transition: opacity 1800ms ease;
}
.vw-ending.on .vw-outcome span { opacity: 1; }
.vw-attempt {
  font: 500 clamp(9px, .78vw, 11px)/1 var(--vw-face);
  letter-spacing: .5em; text-transform: uppercase; color: var(--vw-amber);
  opacity: .0; transition: opacity 1200ms ease 900ms;
}
.vw-ending.on .vw-attempt { opacity: .8; }
/* The choices are withheld for a moment. A player who mashes a key on death
   should not be able to skip the beat before it has landed — the run ending is
   the loudest thing the game says and it is entitled to two seconds. */
.vw-ending .vw-list { opacity: 0; transition: opacity 1400ms ease; pointer-events: none; }
.vw-ending.armed .vw-list { opacity: 1; pointer-events: auto; }

/* Reduced motion still fades — a hard cut between screens is more disorienting
   than a fade, not less. What goes is the movement: the stagger, the letters
   rising, the rule drawing itself. */
@media (prefers-reduced-motion: reduce) {
  .vw-wordmark span, .vw-outcome span, .vw-title-late, .vw-attempt { transition-duration: 200ms; }
  .vw-wordmark span { transform: none; }
  .vw-rule { transition-duration: 200ms; }
  .vw-screen, .vw-frost { transition-duration: 260ms; }
  .vw-ending { transition-duration: 400ms; }
  .vw-row, .vw-row::before, .vw-fill, .vw-knob { transition-duration: 90ms; }
}
`;

// ---------------------------------------------------------------------------
// Gamepad button indices.
//
// Duplicated from `core/gamepad.js` rather than imported so this module has no
// dependency on the game at all — it is handed instances, it does not reach for
// them. Three constants is a cheaper price than that coupling.
// ---------------------------------------------------------------------------
const BTN = { A: 0, B: 1, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** Stick and d-pad repeat, milliseconds. */
const REPEAT_FIRST = 400;  // long enough that one nudge moves exactly one row
const REPEAT_NEXT = 110;   // fast enough to cross the options list without effort

const pct = (v) => `${Math.round(v * 100)}%`;
const times = (v) => `${v.toFixed(2)}x`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Menus {
  /**
   * @param {object} opts
   * @param {HTMLElement} [opts.parent]
   * @param {import('../core/loop.js').Loop} [opts.loop]
   *   Paused and resumed by this module. Also read for `tick`, which is how the
   *   menu knows whether anybody else is polling the gamepad this frame.
   * @param {import('../core/gamepad.js').Gamepad} [opts.pad]
   * @param {import('../core/input.js').Input} [opts.input]
   *   Flushed on resume. See `_flushInput`.
   * @param {import('../game/camera.js').ShipCamera} [opts.shipCam]
   * @param {import('../game/controls.js').Controls} [opts.controls]
   * @param {import('./hud.js').Hud} [opts.hud]
   * @param {(bus:'master'|'music'|'sfx', value:number)=>void} [opts.onAudio]
   *   Called whenever a bus slider moves and once per bus on construction, so a
   *   mixer built later needs one line: `onAudio: (b, v) => audio.setVolume(b, v)`.
   * @param {()=>void} [opts.onStart]    the title was dismissed
   * @param {()=>void} [opts.onRestart]  the player asked to go again
   * @param {()=>void} [opts.onTitle]    back to the title mid-run; row is hidden if absent
   * @param {boolean} [opts.livingTitle] see below
   * @param {boolean} [opts.showTitle]   show the title immediately on construction
   */
  constructor({
    parent = document.body,
    loop = null, pad = null, input = null,
    shipCam = null, controls = null, hud = null,
    onAudio = null, onStart = null, onRestart = null, onTitle = null,
    livingTitle = true, showTitle = true,
  } = {}) {
    installTokens();
    installStyles('vw-menu-css', CSS);

    this.loop = loop; this.pad = pad; this.input = input;
    this.shipCam = shipCam; this.controls = controls; this.hud = hud;
    this.onAudio = onAudio; this.onStart = onStart;
    this.onRestart = onRestart; this.onTitle = onTitle;

    /**
     * Whether the world keeps moving under the title.
     *
     * True by default, and it is the right default: a frozen cloud behind a
     * title card is instantly readable as a screenshot, and this game's first
     * impression is the one thing it cannot afford to spend. The cost is honest
     * and worth stating — the simulation is genuinely running, so the director's
     * first beat (isolation, 60–90 s of being alone) starts ticking while the
     * title is up, and the ship drifts forward at its idle throttle.
     *
     * Neither hurts: beat one is *supposed* to be an empty crossing, and the ship
     * begins in open air. Set false and the loop is paused under the title
     * instead, which is exact but dead.
     */
    this.livingTitle = livingTitle;

    this.settings = loadSettings();

    /** Screen stack. Options is entered from two places and has to return to
     *  the right one, which a single `current` cannot express. */
    this.stack = [];

    this.el = document.createElement('div');
    this.el.className = 'vw-layer vw-menu';
    this.frost = document.createElement('div');
    this.frost.className = 'vw-frost';
    this.el.appendChild(this.frost);
    parent.appendChild(this.el);

    this.screens = {
      title: this._buildTitle(),
      pause: this._buildPause(),
      options: this._buildOptions(),
      ending: this._buildEnding(),
    };
    for (const s of Object.values(this.screens)) this.el.appendChild(s.el);

    this._padPrevTick = null;
    this._repeatAt = 0;
    this._repeatDir = 0;
    this._repeatAxis = '';
    this._endingArmTimer = 0;
    this._alive = true;

    this._onKey = this._onKey.bind(this);
    // Capture phase, and the handler stops propagation while a screen is open.
    // `core/input.js` binds keydown on window in the bubble phase and latches
    // every code it sees, so without this the arrow keys that move the selection
    // are ALSO pitch and yaw commands, and they stay latched in `input.pressed`
    // until something calls endFrame() — which, while the loop is paused, nothing
    // does. The player would resume and immediately pitch up.
    addEventListener('keydown', this._onKey, true);

    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);

    this.apply();
    if (showTitle) this.showTitle();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** True when any screen is open. */
  get active() { return this.stack.length > 0; }

  /** The screen on top, or null. */
  get screen() { return this.stack.length ? this.stack[this.stack.length - 1] : null; }

  /**
   * True when flight input should be ignored.
   *
   * Keyboard and mouse are already handled — key events are swallowed in the
   * capture phase and the overlay takes the pointer — so this exists for the one
   * case that is not: a gamepad stick under the living title, which the game
   * loop is still polling. Gate `controls.update(...).applyTo(ship)` on it if
   * that matters; ignoring it costs a slow drift and nothing else.
   */
  get blocksFlight() { return this.active; }

  /**
   * Should the simulation be stopped for the current stack?
   *
   * Decided from the BOTTOM of the stack, not the top, and that is the whole
   * reason this is a function rather than an argument at each call site. Options
   * is reachable from the title, from the pause menu and from the ending, and
   * "should the world be running behind options" has three different answers
   * that depend entirely on what options was opened over. Reading the top screen
   * instead is the bug that resumes a dead run: back out of options over the
   * ending screen and the loop restarts under a player who has already been
   * taken.
   */
  _wantsPause() {
    const base = this.stack[0];
    if (!base) return false;
    if (base === 'title') return !this.livingTitle;
    return true;
  }

  /** Apply the stack's pause state and redraw. Every transition ends here. */
  _enter(stack) {
    this.stack = stack;
    this._setPaused(this._wantsPause());
    this._sync();
    return this;
  }

  showTitle() { return this._enter(['title']); }

  /** Dismiss the title and fly. There is no way back in unless `onTitle` exists. */
  start() {
    this._enter([]);
    if (this.onStart) this.onStart();
    return this;
  }

  pause() {
    if (this.active) return this;
    return this._enter(['pause']);
  }

  resume() {
    if (this.screen === 'ending' || this.screen === 'title') return this;
    return this._enter([]);
  }

  togglePause() { return this.active ? this.back() : this.pause(); }

  showOptions() {
    if (this.screen === 'options' || !this.active) return this;
    this._sel.options = this._firstSelectable('options');
    return this._enter([...this.stack, 'options']);
  }

  /**
   * Back out of the top screen.
   *
   * The title and the ending are terminal: there is nothing behind them and Esc
   * must not dump the player into a paused game that has already ended.
   */
  back() {
    const s = this.screen;
    if (s === 'title' || s === 'ending') return this;
    if (s === 'options') return this._enter(this.stack.slice(0, -1));
    return this.resume();
  }

  /**
   * @param {'taken'|'escaped'} outcome from `game/director.js` OUTCOME
   * @param {{attempts?:number}} info
   */
  showEnding(outcome, info = {}) {
    const taken = outcome !== 'escaped';
    this._endingRows = [
      { kind: 'action', label: taken ? 'again' : 'cross again', run: () => this._restart() },
      { kind: 'action', label: 'options', run: () => this.showOptions() },
    ];
    // Rebuilt rather than reused: the labels differ by outcome and a stale list
    // would offer "cross again" to a player who was just eaten.
    this.screens.ending.rows = null;
    const e = this.screens.ending;
    this._setLetters(e.word, taken ? 'TAKEN' : 'THROUGH', 170);
    e.voice.textContent = taken
      ? 'It had your bearing for four seconds. That was enough.'
      : 'The cloud thins and does not close again. Nothing followed you out.';
    const n = info.attempts || 0;
    e.attempt.textContent = n ? `attempt ${n + 1}` : '';

    // Choices withheld until the word has landed. Cleared first: a second death
    // arriving before the first timer fired would leave the list armed early.
    e.el.classList.remove('armed');
    clearTimeout(this._endingArmTimer);
    this._endingArmTimer = setTimeout(() => {
      if (this._alive && this.screen === 'ending') e.el.classList.add('armed');
    }, 1900);

    this._sel.ending = 0;
    return this._enter(['ending']);
  }

  hideEnding() {
    if (this.screen !== 'ending') return this;
    return this._enter([]);
  }

  _restart() {
    this._enter([]);
    if (this.onRestart) this.onRestart();
  }

  _setPaused(paused) {
    if (this.loop) this.loop.paused = paused;
    // Coming back, drop everything the keyboard latched while the simulation was
    // not consuming it. Input.endFrame() is normally called once per update();
    // paused, it is never called, so every key touched behind the menu is still
    // sitting in `pressed` and fires on the first step after the resume.
    if (!paused) this._flushInput();
  }

  _flushInput() {
    const i = this.input;
    if (!i) return;
    i.pressed.clear(); i.released.clear();
    if (i.buttonsPressed) i.buttonsPressed.clear();
    if (i.buttonsReleased) i.buttonsReleased.clear();
    // `down` is deliberately NOT cleared. It holds physical state, and a player
    // resuming with the throttle key held should still be holding it.
  }

  // -------------------------------------------------------------------------
  // Applying settings
  // -------------------------------------------------------------------------

  /** Push every setting into the systems that own it. Safe to call at any time. */
  apply() {
    const s = this.settings;
    if (this.shipCam && this.shipCam.setComfort) {
      this.shipCam.setComfort({
        shake: s.shake, roll: s.roll, fovShift: s.fovShift, lean: s.lean,
        threatCamera: s.threatCamera, motionBlur: s.motionBlur, horizonLine: s.horizonLine,
      });
    }
    if (this.controls) {
      this.controls.useMouse = s.mouseSteer;
      this.controls.mouseSensitivity = s.mouseSensitivity;
      this.controls.padSensitivity = s.padSensitivity;
      this.controls.invertPadPitch = s.invertPadPitch;
    }
    if (this.onAudio) {
      this.onAudio('master', s.master);
      this.onAudio('music', s.music);
      this.onAudio('sfx', s.sfx);
    }
    return this;
  }

  _changed(key) {
    const s = this.settings;
    if (this.shipCam && this.shipCam.setComfort && key in SETTINGS_DEFAULTS && key in this.shipCam.comfort) {
      this.shipCam.setComfort({ [key]: s[key] });
    }
    if (this.controls) {
      if (key === 'mouseSteer') this.controls.useMouse = s.mouseSteer;
      if (key === 'mouseSensitivity') this.controls.mouseSensitivity = s.mouseSensitivity;
      if (key === 'padSensitivity') this.controls.padSensitivity = s.padSensitivity;
      if (key === 'invertPadPitch') this.controls.invertPadPitch = s.invertPadPitch;
    }
    if (this.onAudio && (key === 'master' || key === 'music' || key === 'sfx')) {
      this.onAudio(key, s[key]);
    }
    saveSettings(this.settings);
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  _titleRows() {
    return [
      { kind: 'action', label: 'begin', run: () => this.start() },
      { kind: 'action', label: 'options', run: () => this.showOptions() },
    ];
  }

  _pauseRows() {
    const rows = [
      { kind: 'action', label: 'resume', run: () => this.resume() },
      { kind: 'action', label: 'options', run: () => this.showOptions() },
      { kind: 'action', label: 'restart crossing', run: () => this._restart() },
    ];
    // Only offered when the host actually implements it. A menu row that does
    // nothing is worse than a missing one — it teaches the player the interface
    // is decorative.
    if (this.onTitle) {
      rows.push({ kind: 'action', label: 'abandon', run: () => { this.showTitle(); this.onTitle(); } });
    }
    return rows;
  }

  /**
   * The options list.
   *
   * Everything here already existed and was unreachable. The `note` on each row
   * says what it is *for* rather than what it does — a player opening a comfort
   * menu is usually already uncomfortable and is not in the mood to work out
   * what "fovShift" means.
   */
  _optionRows() {
    const slider = (key, label, note, opt = {}) => ({
      kind: 'slider', key, label, note,
      min: opt.min ?? 0, max: opt.max ?? 1, step: opt.step ?? 0.05,
      format: opt.format || pct,
    });
    const toggle = (key, label, note, on = 'on', off = 'off') =>
      ({ kind: 'toggle', key, label, note, on, off });

    const rows = [
      { kind: 'header', label: 'camera' },
      slider('shake', 'hull shake', 'The ship vibrating. It carries how hard the air is; lower it if motion makes you unwell.'),
      slider('roll', 'horizon roll', 'How far the view banks with the ship. At zero the horizon stays level and the ship rolls under it.'),
      slider('fovShift', 'speed field', 'The view widening as you accelerate. Most of the sensation of speed lives here.'),
      slider('lean', 'inertia lean', 'The camera settling against real forces — turns, turbulence, the medium pushing back.'),
      slider('threatCamera', 'threat drift', 'A slow pull of the view toward something enormous nearby. It is never a snap.'),
      slider('motionBlur', 'motion blur', 'Smear along the direction of travel.'),
      toggle('horizonLine', 'artificial horizon', 'An instrument horizon drawn over the world. Off by default: the game means for you to be lost.'),

      { kind: 'header', label: 'controls' },
      toggle('mouseSteer', 'mouse steering', 'Steer by pointing. Off leaves the ship on the keyboard and the stick alone.'),
      slider('mouseSensitivity', 'mouse sensitivity', 'How far the ship answers a given movement of the mouse.',
        { min: 0.3, max: 2.5, step: 0.1, format: times }),
      slider('padSensitivity', 'stick sensitivity', 'How far the ship answers a given deflection of the stick.',
        { min: 0.3, max: 2.5, step: 0.1, format: times }),
      toggle('invertPadPitch', 'invert stick pitch', 'Pull back to climb, as in an aircraft.', 'inverted', 'normal'),

      { kind: 'header', label: 'audio' },
      slider('master', 'master', 'Everything.'),
      slider('music', 'score', 'The score only. The game is written to be played with it low.'),
      slider('sfx', 'effects', 'The ship, the medium, and whatever is out there.'),

      { kind: 'header', label: '' },
      {
        kind: 'action', label: 'show controls', note: 'Bring the control legend back for a while.',
        run: () => { if (this.hud) this.hud.showControls(); this.back(); },
      },
      {
        kind: 'action', label: 'restore defaults', note: 'Every setting on this screen back to how the game ships.',
        run: () => {
          Object.assign(this.settings, SETTINGS_DEFAULTS);
          this.apply(); saveSettings(this.settings); this._refresh('options');
        },
      },
      { kind: 'action', label: 'back', note: '', run: () => this.back() },
    ];
    return rows;
  }

  _endingRowsFor() { return this._endingRows || []; }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  /** Selected index per screen. Options remembers where you were; the rest reset. */
  _sel = { title: 0, pause: 0, options: 0, ending: 0 };

  /**
   * Split a word into per-letter spans with a stagger.
   *
   * A single element cannot do this, and it is the whole difference between a
   * title that appears and a title that *arrives*: the letters resolve one after
   * another, like something coming up out of the vapour. The spaces are rendered
   * too (white-space: pre) so the delay is even across the word.
   */
  _setLetters(host, text, stepMs) {
    host.replaceChildren();
    [...text].forEach((ch, i) => {
      const sp = document.createElement('span');
      sp.textContent = ch;
      sp.style.transitionDelay = `${i * stepMs}ms`;
      host.appendChild(sp);
    });
  }

  _buildTitle() {
    const el = document.createElement('div');
    el.className = 'vw-screen vw-title';
    const block = document.createElement('div');
    block.className = 'vw-title-block';

    const word = document.createElement('h1');
    word.className = 'vw-wordmark';
    block.appendChild(word);

    const late = document.createElement('div');
    late.className = 'vw-title-late';
    late.style.display = 'flex';
    late.style.flexDirection = 'column';
    late.style.gap = '1.1rem';
    late.style.alignItems = 'flex-start';

    const rule = document.createElement('div');
    rule.className = 'vw-rule';
    const voice = document.createElement('p');
    voice.className = 'vw-voice';
    // Lower case, unpunctuated: the caption layer's `voice` register, which is
    // the pilot thinking rather than the ship reporting. The title is the one
    // place the game gets to set that expectation before anything happens.
    voice.textContent = 'something out here has already heard you';
    const list = document.createElement('div');
    list.className = 'vw-list';
    late.append(rule, voice, list);
    block.appendChild(late);

    const hint = document.createElement('div');
    hint.className = 'vw-hint';
    el.append(block, hint);
    return { el, word, list, hint, rows: null };
  }

  _panel(titleText) {
    const el = document.createElement('div');
    el.className = 'vw-screen';
    const panel = document.createElement('div');
    panel.className = 'vw-panel';
    const col = document.createElement('div');
    col.className = 'vw-panel-col';
    const head = document.createElement('div');
    head.className = 'vw-panel-head';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'vw-eyebrow';
    eyebrow.textContent = titleText;
    const rule = document.createElement('div');
    rule.className = 'vw-rule';
    head.append(eyebrow, rule);
    const list = document.createElement('div');
    list.className = 'vw-list';
    col.append(head, list);
    panel.appendChild(col);
    el.appendChild(panel);
    const hint = document.createElement('div');
    hint.className = 'vw-hint';
    el.appendChild(hint);
    return { el, panel, col, head, list, hint };
  }

  _buildPause() {
    const p = this._panel('paused');
    p.el.classList.add('vw-pause');
    return { ...p, rows: null };
  }

  _buildOptions() {
    const p = this._panel('options');
    p.el.classList.add('vw-options');
    const note = document.createElement('div');
    note.className = 'vw-note';
    p.col.appendChild(note);
    return { ...p, note, rows: null };
  }

  _buildEnding() {
    const p = this._panel('');
    p.el.classList.add('vw-ending');
    const word = document.createElement('h1');
    word.className = 'vw-outcome';
    const voice = document.createElement('p');
    voice.className = 'vw-voice';
    const attempt = document.createElement('div');
    attempt.className = 'vw-attempt';
    // No heading: the outcome word IS the heading.
    p.head.remove();
    p.col.insertBefore(word, p.list);
    p.col.insertBefore(voice, p.list);
    p.col.insertBefore(attempt, p.list);
    return { ...p, word, voice, attempt, rows: null };
  }

  _rowsFor(name) {
    if (name === 'title') return this._titleRows();
    if (name === 'pause') return this._pauseRows();
    if (name === 'options') return this._optionRows();
    if (name === 'ending') return this._endingRowsFor();
    return [];
  }

  /** Rebuild a screen's list. Cheap, and only happens when a screen opens. */
  _build(name) {
    const s = this.screens[name];
    const rows = this._rowsFor(name);
    s.rows = rows;
    s.list.replaceChildren();
    rows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'vw-row' + (r.kind === 'header' ? ' hdr' : '');
      const label = document.createElement('div');
      label.className = 'vw-row-label';
      label.textContent = r.label;
      el.appendChild(label);

      if (r.kind === 'slider' || r.kind === 'toggle') {
        const val = document.createElement('div');
        val.className = 'vw-row-val';
        if (r.kind === 'slider') {
          const track = document.createElement('div');
          track.className = 'vw-track';
          const fill = document.createElement('div');
          fill.className = 'vw-fill';
          const knob = document.createElement('div');
          knob.className = 'vw-knob';
          track.append(fill, knob);
          val.appendChild(track);
          r._track = track; r._fill = fill; r._knob = knob;
          // Dragging and clicking the track. Pointer events rather than mouse
          // events so a touch drag works identically, and capture so a drag that
          // leaves the track keeps steering it instead of stopping dead.
          const setFromEvent = (ev) => {
            const b = track.getBoundingClientRect();
            const t = clamp01((ev.clientX - b.left) / Math.max(b.width, 1));
            this._setSlider(r, r.min + t * (r.max - r.min), name);
          };
          track.addEventListener('pointerdown', (ev) => {
            this._select(name, i);
            track.setPointerCapture(ev.pointerId);
            setFromEvent(ev);
            ev.stopPropagation();
          });
          track.addEventListener('pointermove', (ev) => {
            if (track.hasPointerCapture(ev.pointerId)) setFromEvent(ev);
          });
        }
        const num = document.createElement('div');
        num.className = 'vw-num';
        val.appendChild(num);
        r._num = num;
        el.appendChild(val);
      }

      if (r.kind !== 'header') {
        el.addEventListener('pointerenter', () => this._select(name, i));
        el.addEventListener('click', () => { this._select(name, i); this._activate(name); });
      }
      r._el = el;
      s.list.appendChild(el);
    });

    // The remembered index can point past the end or at a header: options keeps
    // its selection across openings, and the pause list grows a row when
    // `onTitle` is wired. A selection nobody can see is a menu that ignores the
    // first key press.
    const sel = this._sel[name];
    if (sel === undefined || sel >= rows.length || rows[sel].kind === 'header') {
      this._sel[name] = this._firstSelectable(name, rows);
    }
    this._refresh(name);
  }

  _firstSelectable(name, rows = this._rowsFor(name)) {
    for (let i = 0; i < rows.length; i++) if (rows[i].kind !== 'header') return i;
    return 0;
  }

  /** Repaint values and selection without rebuilding the DOM. */
  _refresh(name) {
    const s = this.screens[name];
    if (!s || !s.rows) return;
    const sel = this._sel[name];
    s.rows.forEach((r, i) => {
      r._el.classList.toggle('sel', i === sel);
      if (r.kind === 'slider') {
        const v = this.settings[r.key];
        const t = clamp01((v - r.min) / (r.max - r.min));
        r._fill.style.width = `${t * 100}%`;
        r._knob.style.left = `calc(${t * 100}% - ${t}px)`;
        r._num.textContent = r.format(v);
      } else if (r.kind === 'toggle') {
        r._num.textContent = this.settings[r.key] ? r.on : r.off;
      }
    });
    if (s.note) {
      const r = s.rows[sel];
      s.note.textContent = r ? (r.note || '') : '';
    }
    if (s.hint) s.hint.textContent = this._hintText(name);
    const el = s.rows[sel]?._el;
    // Keep the selection on screen when the options list is taller than the
    // panel. 'nearest' rather than 'center' so ordinary movement does not shove
    // the whole list around under the player.
    const scrolls = s.list.scrollHeight > s.list.clientHeight + 1;
    if (el && scrolls) el.scrollIntoView({ block: 'nearest' });
    // Which edges have more list behind them. Read after the scroll, so the
    // fades describe where the list actually ended up rather than where it was.
    const top = s.list.scrollTop;
    const max = s.list.scrollHeight - s.list.clientHeight;
    s.list.classList.toggle('more-above', scrolls && top > 2);
    s.list.classList.toggle('more-below', scrolls && top < max - 2);
  }

  /**
   * The footer legend, written for whichever device is plugged in.
   *
   * Plain letters in brackets rather than the circled-glyph characters a console
   * would use. The instrument face is a monospace stack — Cascadia Mono, SF Mono,
   * Menlo, Consolas — and coverage of U+24B6 and friends across those is not
   * reliable; a missing glyph renders as a tofu box, which is the single most
   * obviously broken thing a menu can show.
   *
   * Groups are separated by a middot rather than by runs of spaces. Consecutive
   * spaces collapse to one in HTML, so a legend written with them renders as a
   * single unbroken sentence — measured in a capture, `↑ ↓ select   enter
   * confirm` came out as one run and read as nonsense.
   */
  _hintText(name) {
    const padOn = !!(this.pad && this.pad.connected);
    const sep = ' · ';
    const move = padOn ? 'stick select' : '↑↓ select';
    const ok = padOn ? '[A] confirm' : 'enter confirm';
    if (name === 'options') {
      const adj = padOn ? 'pad ←→ adjust' : '←→ adjust';
      return [move, adj, ok, padOn ? '[B] back' : 'esc back'].join(sep);
    }
    if (name === 'ending') return ok;
    if (name === 'pause') return [move, ok, padOn ? '[B] resume' : 'esc resume'].join(sep);
    return [move, ok].join(sep);
  }

  // -------------------------------------------------------------------------
  // Showing
  // -------------------------------------------------------------------------

  _sync() {
    const cur = this.screen;
    for (const [name, s] of Object.entries(this.screens)) {
      const on = name === cur;
      if (on && !s.rows) this._build(name);
      if (on) this._refresh(name);
      s.el.classList.toggle('on', on);
    }
    // A screen that closes is rebuilt next time it opens, so a pause menu whose
    // rows depend on state (the `abandon` row) cannot go stale.
    for (const [name, s] of Object.entries(this.screens)) {
      if (name !== cur && name !== 'options') s.rows = null;
    }
    if (cur === 'title') {
      const t = this.screens.title;
      this._setLetters(t.word, 'VEILWAKE', 90);
      // Restart the entrance.
      //
      // A CSS transition only plays if the browser has computed the START state
      // before the end state is applied; adding `.on` in the same task as the
      // letters are created collapses both into one style recalculation and the
      // stagger is skipped entirely.
      //
      // The flush is a forced reflow (`offsetWidth`), NOT requestAnimationFrame.
      // rAF does not run while the page is not compositing — a hidden tab, and
      // also the entire way this project is developed — and a title screen whose
      // visibility depends on a frame callback is a title screen that is missing
      // whenever anyone tries to look at it. This is synchronous and always runs.
      t.el.classList.remove('on');
      void t.el.offsetWidth;
      t.el.classList.add('on');
    }
    this.frost.classList.toggle('on', !!cur && cur !== 'title');
    if (this.hud) this.hud.setVisible(!cur);
    this.el.style.pointerEvents = cur ? 'auto' : 'none';
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  _select(name, i) {
    const rows = this.screens[name].rows;
    if (!rows || !rows[i] || rows[i].kind === 'header') return;
    this._sel[name] = i;
    this._refresh(name);
  }

  _move(delta) {
    const name = this.screen;
    if (!name) return;
    const rows = this.screens[name].rows;
    if (!rows || !rows.length) return;
    let i = this._sel[name];
    for (let n = 0; n < rows.length; n++) {
      i = (i + delta + rows.length) % rows.length;
      if (rows[i].kind !== 'header') break;
    }
    this._sel[name] = i;
    this._refresh(name);
  }

  _adjust(delta) {
    const name = this.screen;
    if (!name) return;
    const rows = this.screens[name].rows;
    const r = rows && rows[this._sel[name]];
    if (!r) return;
    if (r.kind === 'slider') {
      this._setSlider(r, this.settings[r.key] + delta * r.step, name);
    } else if (r.kind === 'toggle') {
      this._toggle(r, name);
    }
  }

  _setSlider(r, value, name) {
    // Quantise to the step so the number displayed is a number the player can
    // return to. Without this a dragged slider lands on 0.6349999 and the two
    // ways of setting the same option disagree.
    const steps = Math.round((value - r.min) / r.step);
    let v = r.min + steps * r.step;
    v = Math.min(r.max, Math.max(r.min, v));
    // Floating point: 0.1 * 7 is 0.7000000000000001 and the label would show it.
    v = Math.round(v * 1000) / 1000;
    if (v === this.settings[r.key]) return;
    this.settings[r.key] = v;
    this._changed(r.key);
    this._refresh(name);
  }

  _toggle(r, name) {
    const cur = this.settings[r.key];
    // horizonLine is a 0/1 number in COMFORT_DEFAULTS, not a boolean, and
    // ShipCamera multiplies by it. Preserve the stored type or the camera gets a
    // boolean where it expects a scalar.
    this.settings[r.key] = typeof cur === 'boolean' ? !cur : (cur ? 0 : 1);
    this._changed(r.key);
    this._refresh(name);
  }

  _activate() {
    const name = this.screen;
    if (!name) return;
    const rows = this.screens[name].rows;
    const r = rows && rows[this._sel[name]];
    if (!r) return;
    if (r.kind === 'action') r.run();
    else if (r.kind === 'toggle') this._toggle(r, name);
    // A slider does nothing on confirm. Enter on a slider most often means "I am
    // done here", and having it jump to the next row or close the screen is the
    // kind of guess that loses somebody's setting.
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  _onKey(e) {
    if (!this.active) {
      if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.pause(); }
      return;
    }
    // The ending withholds its choices for the first moments; swallow everything
    // until then so a mashed key does not skip the beat AND count as the choice.
    const armed = this.screen !== 'ending' || this.screens.ending.el.classList.contains('armed');
    let handled = true;
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': if (armed) this._move(-1); break;
      case 'ArrowDown': case 'KeyS': if (armed) this._move(1); break;
      case 'ArrowLeft': case 'KeyA': if (armed) this._adjust(-1); break;
      case 'ArrowRight': case 'KeyD': if (armed) this._adjust(1); break;
      case 'Enter': case 'NumpadEnter': case 'Space': if (armed) this._activate(); break;
      case 'Escape': case 'Backspace': if (armed) this.back(); break;
      case 'Tab': break; // swallowed: focus must not walk out of the game
      default: handled = false;
    }
    if (handled || armed === false) {
      e.preventDefault();
      // Stops core/input.js latching menu navigation as flight commands.
      e.stopPropagation();
    }
  }

  _tick(now) {
    if (!this._alive) return;
    this._raf = requestAnimationFrame(this._tick);
    const pad = this.pad;
    if (!pad) return;

    // Who is polling the pad.
    //
    // Gamepad.update() rebuilds `pressed`/`released` by diffing against the
    // previous call, so calling it twice in one frame reports every button as
    // released and none as pressed — the menu would simply stop answering the
    // controller, intermittently, depending on whether the game happened to be
    // paused. The simulation pumps it when it is running; the menu pumps it only
    // on frames where the simulation did not.
    const tick = this.loop ? this.loop.tick : -1;
    if (tick === this._padPrevTick) pad.update();
    this._padPrevTick = tick;

    if (!pad.connected) return;

    if (pad.wasPressed(BTN.START)) { this.togglePause(); return; }
    if (!this.active) return;

    const armed = this.screen !== 'ending' || this.screens.ending.el.classList.contains('armed');
    if (armed) {
      if (pad.wasPressed(BTN.A)) { this._activate(); return; }
      if (pad.wasPressed(BTN.B)) { this.back(); return; }
      if (pad.wasPressed(BTN.UP)) this._move(-1);
      if (pad.wasPressed(BTN.DOWN)) this._move(1);
      if (pad.wasPressed(BTN.LEFT)) this._adjust(-1);
      if (pad.wasPressed(BTN.RIGHT)) this._adjust(1);
      this._stickRepeat(pad, now);
    }
  }

  /**
   * Stick navigation with repeat.
   *
   * A stick has no edges, so without an explicit repeat model it either moves
   * the selection once per push (which feels broken on a long list) or once per
   * frame (which crosses the whole list instantly). The threshold is high — the
   * pad's own deadzone is 0.14 and this is 0.55 — so resting a thumb on the
   * stick does not walk the menu.
   */
  _stickRepeat(pad, now) {
    const y = pad.axes.ly, x = pad.axes.lx;
    const T = 0.55;
    let axis = '', dir = 0;
    if (Math.abs(y) > T && Math.abs(y) >= Math.abs(x)) { axis = 'y'; dir = y > 0 ? 1 : -1; }
    else if (Math.abs(x) > T) { axis = 'x'; dir = x > 0 ? 1 : -1; }

    if (!axis) { this._repeatAxis = ''; this._repeatDir = 0; return; }
    if (axis !== this._repeatAxis || dir !== this._repeatDir) {
      this._repeatAxis = axis; this._repeatDir = dir;
      this._repeatAt = now + REPEAT_FIRST;
      if (axis === 'y') this._move(dir); else this._adjust(dir);
      return;
    }
    if (now >= this._repeatAt) {
      this._repeatAt = now + REPEAT_NEXT;
      if (axis === 'y') this._move(dir); else this._adjust(dir);
    }
  }

  destroy() {
    this._alive = false;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._endingArmTimer);
    removeEventListener('keydown', this._onKey, true);
    this.el.remove();
  }
}

// The in-flight overlay — and, more importantly, the one it is not.
//
// `caption.js` states the rule this file obeys: the signature system is readable
// from the cockpit instruments and from the sound of the ship, and putting
// numbers on the glass replaces a thing the player feels with a thing they read.
// So there is no health bar, no signature meter, no minimap and no compass here,
// and adding one later is a design decision, not a UI decision.
//
// What is left is the one thing an overlay is genuinely better at than a cockpit:
// telling a player who has never flown this ship which key does what, and then
// getting out of the way permanently. It fades on its own and does not come back
// unless it is asked for from the options screen.
//
// This file also owns the **shared visual language** — the palette tokens, the
// type ramp and the fade timings that `menu.js` imports. One definition, so the
// pause screen cannot drift away from the caption layer it sits on top of.

/**
 * The overlay palette.
 *
 * Derived from `docs/ART_DIRECTION.md` and from the values already committed in
 * `caption.js`, which is the only UI the game had — AMBER and ICE are that file's
 * `#e8b46a` and `#e6f0fb` unchanged, because two amber-ish oranges on screen at
 * once is exactly how an interface starts looking assembled rather than designed.
 *
 * The split is load-bearing and mirrors the caption registers: **amber is the
 * machine** (labels the ship would print, current values, the selection) and
 * **cold blue is everything else** (prose, inactive rows, chrome). Nothing else
 * is coloured. The art direction reserves saturation for events in the world —
 * creature light, lightning, the ship's own lamps — so an interface that spends
 * a second hue is spending one the world needed.
 */
export const PALETTE = {
  amber:    '#e8b46a',
  amberDim: 'rgba(232,180,106,.42)',
  ice:      '#e6f0fb',
  blue:     '#93a9c2',
  blueDim:  '#5f7488',
  void:     '#03050a',
};

/**
 * Fade durations, in milliseconds.
 *
 * "Everything fades; nothing pops." These are slow by interface standards on
 * purpose — 180 ms is the number a web UI reaches for and it reads as a click.
 * The game's own caption layer fades over 900 ms and its ending over 2 s, and an
 * interface that moves faster than the fiction it sits on breaks the surface.
 */
export const FADE = {
  quick: 240,   // selection moving between rows: fast enough to feel answered
  slow: 900,    // a screen arriving or leaving
  glacial: 2200 // the end of a run, which should be slow to arrive and to leave
};

/**
 * Inject a stylesheet exactly once, keyed by id.
 *
 * Both UI modules call this. Without the id check a second instance — which a
 * restart or a hot reload will produce — appends a duplicate sheet every time,
 * and the duplicates are only ever *equal*, never conflicting, so nothing looks
 * wrong until the head has forty of them.
 */
export function installStyles(id, css) {
  if (document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id;
  st.textContent = css;
  document.head.appendChild(st);
}

/**
 * Shared CSS custom properties and the two type faces.
 *
 * `--vw-face` is the instrument face: monospace, upper case, heavily
 * letter-spaced. Letter-spacing is what makes small monospace text read as
 * *stamped on a panel* rather than as terminal output, and it is the single
 * cheapest thing in this file. `--vw-voice` is the caption layer's serif, used
 * only for the sentences that are the pilot thinking rather than the ship
 * reporting.
 */
export const TOKENS = `
:root {
  --vw-amber: ${PALETTE.amber};
  --vw-amber-dim: ${PALETTE.amberDim};
  --vw-ice: ${PALETTE.ice};
  --vw-blue: ${PALETTE.blue};
  --vw-blue-dim: ${PALETTE.blueDim};
  --vw-void: ${PALETTE.void};
  --vw-face: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
  --vw-voice: ui-serif, Georgia, "Times New Roman", serif;
  --vw-quick: ${FADE.quick}ms;
  --vw-slow: ${FADE.slow}ms;
}
/* Every layer this file and menu.js create is a sibling of the canvas, so each
   one must opt back in to being invisible to the mouse. A full-screen overlay
   that forgets this eats every click meant for the game and the only symptom is
   that flying stops working. */
.vw-layer { position: fixed; inset: 0; pointer-events: none; }
`;

/**
 * Install the shared tokens.
 *
 * Exported because `menu.js` can be constructed without a Hud — the pause screen
 * has to work in a build that has no legend — and its stylesheet is written
 * entirely in these custom properties. Without this every colour in the menu
 * resolves to nothing and the screens render as invisible text on nothing, which
 * is a five-minute mystery every time.
 */
export function installTokens() { installStyles('vw-ui-tokens', TOKENS); }

const HUD_CSS = `
.vw-hud {
  z-index: 30;
  opacity: 0; transition: opacity var(--vw-slow) ease;
}
.vw-hud.show { opacity: 1; }

/* Bottom LEFT, deliberately. #diag holds the top right, the caption layer holds
   the bottom centre at 12.5%, and the cockpit's own instruments hold the lower
   middle of the frame. This is the only quiet corner left. */
.vw-hud-keys {
  position: absolute; left: clamp(18px, 3.2vw, 52px); bottom: clamp(18px, 3.4vh, 46px);
  display: grid; grid-template-columns: auto auto; gap: .34em 1.1em;
  font: 500 clamp(9px, .78vw, 11.5px)/1.5 var(--vw-face);
  letter-spacing: .2em; text-transform: uppercase;
  /* The frame behind this is volumetric cloud and it is sometimes very bright
     (measured: a sunlit mass tone-maps to near white) and sometimes near black.
     A shadow this heavy is the only thing that makes 10px type survive both. */
  text-shadow: 0 0 14px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.9);
}
.vw-hud-keys b { color: var(--vw-amber); font-weight: 500; text-align: right; letter-spacing: .16em; }
/* --vw-blue, not --vw-blue-dim. Measured against a sunlit cloud mass — the
   brightest backdrop this game produces — the dim ramp step held but only just,
   and the legend has to survive the worst frame rather than the average one. */
.vw-hud-keys span { color: var(--vw-blue); }

@media (prefers-reduced-motion: reduce) {
  .vw-hud { transition-duration: 1ms; }
}
`;

/**
 * The control legend, keyed to the device actually in the player's hands.
 *
 * These mirror `BINDINGS` in `src/game/controls.js` and the PAD constants in
 * `src/core/gamepad.js` rather than importing them, because a binding is a key
 * *code* — 'ShiftLeft', 'KeyZ' — and every one would need a display name here
 * anyway. If a binding changes and this does not, the legend lies; that is the
 * cost, and it is smaller than the cost of a code-to-glyph table nobody
 * maintains either.
 *
 * Seven rows, not seventeen. The list is not a manual: it is attitude, throttle,
 * and the three switches that change what the ship is broadcasting — which is
 * the whole game — plus the way out. Strafe, lift and brake are discoverable and
 * do not change whether you are heard.
 */
const LEGEND = {
  keyboard: [
    ['W A S D', 'attitude'],
    ['Q E', 'roll'],
    ['shift ctrl', 'throttle'],
    ['L', 'lamps'],
    ['F', 'scan'],
    ['Z', 'cut engines'],
    ['esc', 'pause'],
  ],
  gamepad: [
    ['L stick', 'attitude'],
    ['R stick', 'roll'],
    ['triggers', 'throttle'],
    ['Y', 'lamps'],
    ['X', 'scan'],
    ['L3', 'cut engines'],
    ['start', 'pause'],
  ],
};

export class Hud {
  /**
   * @param {object} opts
   * @param {HTMLElement} [opts.parent]
   * @param {import('../game/controls.js').Controls} [opts.controls]
   *        Read only, for `lastDevice` — the legend follows what the player is
   *        actually holding without anyone having to tell it.
   * @param {import('../core/loop.js').Loop} [opts.loop]
   *        Read only, for `paused`. The reveal timer must not run down behind a
   *        pause menu: a player who opens options to check the controls and then
   *        resumes should not find the legend already gone.
   * @param {number} [opts.holdSeconds] how long the legend stays on a fresh run.
   */
  constructor({ parent = document.body, controls = null, loop = null, holdSeconds = 22 } = {}) {
    installTokens();
    installStyles('vw-hud-css', HUD_CSS);

    this.controls = controls;
    this.loop = loop;
    this.holdSeconds = holdSeconds;

    this.el = document.createElement('div');
    this.el.className = 'vw-layer vw-hud';
    this.keys = document.createElement('div');
    this.keys.className = 'vw-hud-keys';
    this.el.appendChild(this.keys);
    parent.appendChild(this.el);

    this._device = null;
    this._remaining = holdSeconds;
    this._hidden = false;
    this._alive = true;

    this._setDevice('keyboard');
    // Flush the start state so the fade has something to animate *from*. Adding
    // .show in the same task as the element's insertion collapses both into one
    // style recalculation and the legend snaps in, which is the one thing this
    // interface is not allowed to do.
    //
    // A forced reflow rather than requestAnimationFrame: rAF does not run while
    // the page is not compositing, and a legend that only appears once the tab
    // has been looked at is a legend that is missing on the frame it matters.
    void this.el.offsetWidth;
    this.el.classList.add('show');

    this._last = performance.now();
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  /**
   * Self-driven, so main.js needs no per-frame line for this.
   *
   * It cannot borrow the simulation's clock anyway: the legend has to keep
   * fading while the game is paused behind a menu, and `Loop.update` does not
   * run then.
   */
  _tick(now) {
    if (!this._alive) return;
    this._raf = requestAnimationFrame(this._tick);
    // Clamped at both ends. The ceiling stops a backgrounded tab returning with
    // a ten-second delta and retiring the legend in one frame. The floor is for
    // a clock that goes backwards — rAF timestamps are monotonic so it should
    // not happen, but a negative dt here does not merely stall the countdown, it
    // runs it BACKWARDS and the legend becomes permanent.
    const dt = Math.min(Math.max((now - this._last) / 1000, 0), 0.25);
    this._last = now;

    if (this.controls && this.controls.lastDevice !== this._device) {
      this._setDevice(this.controls.lastDevice);
    }
    if (this.loop && this.loop.paused) return;
    if (this._remaining <= 0) return;
    this._remaining -= dt;
    if (this._remaining <= 0 && !this._hidden) this.el.classList.remove('show');
  }

  _setDevice(device) {
    const rows = LEGEND[device] || LEGEND.keyboard;
    this._device = device;
    this.keys.replaceChildren();
    for (const [key, label] of rows) {
      const b = document.createElement('b');
      b.textContent = key;
      const s = document.createElement('span');
      s.textContent = label;
      this.keys.append(b, s);
    }
  }

  /** Bring the legend back — the options screen's "SHOW CONTROLS" row. */
  showControls(seconds = this.holdSeconds) {
    this._remaining = seconds;
    if (!this._hidden) this.el.classList.add('show');
    return this;
  }

  /**
   * Hidden while a menu is open.
   *
   * Separate from the reveal timer rather than folded into it: a menu closing
   * must restore whatever the legend was doing before the menu opened, and a
   * single piece of state cannot remember that.
   */
  setVisible(visible) {
    this._hidden = !visible;
    const wants = visible && this._remaining > 0;
    this.el.classList.toggle('show', wants);
    return this;
  }

  destroy() {
    this._alive = false;
    cancelAnimationFrame(this._raf);
    this.el.remove();
  }
}

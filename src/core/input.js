// Input.
//
// Two properties matter and neither is free.
//
// First, edges must survive a frame. A key pressed and released between two
// simulation steps still happened, and a game that polls raw key state will drop
// it. Presses and releases are latched here and consumed by the simulation.
//
// Second, input must be recordable and replayable. Every scripted test, every
// deterministic capture and every "what exactly did the player do before it went
// wrong" depends on being able to feed a recorded stream in place of the device.

export class Input {
  /** @param {HTMLElement} target */
  constructor(target) {
    this.target = target;

    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();

    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0 };
    this.buttons = new Set();
    this.buttonsPressed = new Set();
    this.buttonsReleased = new Set();

    /** When set, device events are ignored and this supplies input instead. */
    this.replay = null;
    this.recording = null;

    this._bind();
  }

  _bind() {
    const t = this.target;

    addEventListener('keydown', (e) => {
      if (this.replay) return;
      // Let the browser keep its own shortcuts; swallow the game's.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
    });

    addEventListener('keyup', (e) => {
      if (this.replay) return;
      this.down.delete(e.code);
      this.released.add(e.code);
    });

    t.addEventListener('mousemove', (e) => {
      if (this.replay) return;
      const r = t.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = 1 - ((e.clientY - r.top) / r.height) * 2;
      this.mouse.dx += x - this.mouse.x;
      this.mouse.dy += y - this.mouse.y;
      this.mouse.x = x;
      this.mouse.y = y;
    });

    t.addEventListener('mousedown', (e) => {
      if (this.replay) return;
      e.preventDefault();
      this.buttons.add(e.button);
      this.buttonsPressed.add(e.button);
    });

    addEventListener('mouseup', (e) => {
      if (this.replay) return;
      this.buttons.delete(e.button);
      this.buttonsReleased.add(e.button);
    });

    t.addEventListener('wheel', (e) => {
      if (this.replay) return;
      e.preventDefault();
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: false });

    t.addEventListener('contextmenu', (e) => e.preventDefault());

    // A window that loses focus mid-key would otherwise hold that key forever.
    addEventListener('blur', () => {
      for (const c of this.down) this.released.add(c);
      this.down.clear();
      this.buttons.clear();
    });
  }

  held(code) { return this.down.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  wasReleased(code) { return this.released.has(code); }
  mouseHeld(b = 0) { return this.buttons.has(b); }
  mouseWasPressed(b = 0) { return this.buttonsPressed.has(b); }
  mouseWasReleased(b = 0) { return this.buttonsReleased.has(b); }

  /** An axis from a pair of keys, so bindings stay in one place. */
  axis(negative, positive) {
    return (this.held(positive) ? 1 : 0) - (this.held(negative) ? 1 : 0);
  }

  /** Call once per frame, after the simulation has read everything. */
  endFrame() {
    if (this.recording) {
      this.recording.push({
        t: this.recording.length,
        down: Array.from(this.down),
        mx: this.mouse.x, my: this.mouse.y,
        b: Array.from(this.buttons),
      });
    }
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }

  startRecording() { this.recording = []; return this.recording; }
  stopRecording() { const r = this.recording; this.recording = null; return r; }

  /**
   * Feed a recorded stream instead of the device. Returns a function that
   * advances it one frame and reports whether anything is left.
   */
  playback(frames) {
    this.replay = frames;
    let i = 0;
    return () => {
      if (i >= frames.length) { this.replay = null; return false; }
      const f = frames[i++];
      const wanted = new Set(f.down);
      for (const c of wanted) if (!this.down.has(c)) this.pressed.add(c);
      for (const c of this.down) if (!wanted.has(c)) this.released.add(c);
      this.down = wanted;
      this.mouse.x = f.mx; this.mouse.y = f.my;
      this.buttons = new Set(f.b);
      return true;
    };
  }
}

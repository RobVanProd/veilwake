// What the game says, and how little of it there is.
//
// A caption layer rather than a HUD. The signature system is already readable
// from the cockpit instruments and from the sound of the ship; putting numbers
// on the glass would replace a thing the player feels with a thing they read,
// and the whole design rests on the first.
//
// Two registers, and the difference carries meaning:
//
//   `system`  — the ship talking. Upper case, letter-spaced, amber. It states
//               facts about the machine: ENGINE ONLINE, CONTACT — CLOSING.
//   `voice`   — lower case, dimmer, unpunctuated. It is not the ship and not a
//               narrator; it is closer to the thought the pilot is having.
//               "something answered."
//
// The register is chosen from the text itself rather than passed in, so the
// beats in director.js read as prose and nobody has to remember a flag.
//
// Captions fade rather than cut, and never queue: a new one replaces whatever is
// there. A queue would mean the game is still telling you about the last thing
// while the next one is happening to you.

const CSS = `
.vw-caption {
  position: fixed; left: 0; right: 0; bottom: 12.5%;
  display: flex; justify-content: center; pointer-events: none;
  z-index: 40; padding: 0 8vw;
}
.vw-caption > span {
  opacity: 0; transition: opacity 900ms ease;
  text-align: center; max-width: 46rem;
  text-shadow: 0 0 18px rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.95);
}
.vw-caption.show > span { opacity: 1; }
.vw-caption.system > span {
  font: 500 clamp(11px, 1.15vw, 15px)/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: .34em; color: #e8b46a; text-transform: uppercase;
}
.vw-caption.voice > span {
  font: 400 clamp(13px, 1.35vw, 19px)/1.7 ui-serif, Georgia, "Times New Roman", serif;
  letter-spacing: .02em; color: #b8c6d8; font-style: italic;
}
/* The run's end. Deliberately slow to arrive and slow to leave. */
.vw-ending {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1.4rem;
  background: rgba(2,4,7,.86); opacity: 0; transition: opacity 2s ease;
  pointer-events: none; z-index: 60;
}
.vw-ending.show { opacity: 1; pointer-events: auto; }
.vw-ending h1 {
  margin: 0; font: 500 clamp(18px, 2.6vw, 34px)/1.3 ui-monospace, Consolas, monospace;
  letter-spacing: .5em; color: #e6f0fb; text-indent: .5em;
}
.vw-ending p {
  margin: 0; max-width: 34rem; text-align: center;
  font: 400 clamp(12px, 1.3vw, 16px)/1.9 ui-serif, Georgia, serif;
  color: #7e93ab; font-style: italic;
}
.vw-ending button {
  margin-top: .6rem; background: #101b27; color: #cfe2f5;
  border: 1px solid #2c4056; border-radius: 4px; padding: .7rem 1.4rem;
  font: 500 12px/1 ui-monospace, Consolas, monospace; letter-spacing: .22em;
  text-transform: uppercase; cursor: pointer;
}
.vw-ending button:hover { background: #18293a; }
`;

/** Upper-case text with no lower-case letters in it is the ship talking. */
function registerFor(text) {
  return /[a-z]/.test(text) ? 'voice' : 'system';
}

export class Captions {
  constructor({ parent = document.body, holdSeconds = 5.5 } = {}) {
    if (!document.getElementById('vw-caption-css')) {
      const st = document.createElement('style');
      st.id = 'vw-caption-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'vw-caption';
    this.span = document.createElement('span');
    this.el.appendChild(this.span);
    parent.appendChild(this.el);

    this.ending = document.createElement('div');
    this.ending.className = 'vw-ending';
    this.ending.innerHTML = '<h1></h1><p></p>';
    this.retry = document.createElement('button');
    this.ending.appendChild(this.retry);
    parent.appendChild(this.ending);

    this.holdSeconds = holdSeconds;
    this._age = 1e9;
    this.onRetry = null;
    this.retry.addEventListener('click', () => { if (this.onRetry) this.onRetry(); });
  }

  say(text) {
    if (!text) return;
    this.span.textContent = text;
    this.el.classList.remove('system', 'voice');
    this.el.classList.add(registerFor(text), 'show');
    this._age = 0;
  }

  /** @param {number} dt seconds */
  update(dt) {
    this._age += dt;
    if (this._age > this.holdSeconds) this.el.classList.remove('show');
  }

  /**
   * @param {'taken'|'escaped'} outcome
   * @param {{attempts:number}} info
   */
  showEnding(outcome, info = {}) {
    const h = this.ending.querySelector('h1');
    const p = this.ending.querySelector('p');
    if (outcome === 'escaped') {
      h.textContent = 'THROUGH';
      p.textContent = info.attempts
        ? `The cloud thins and does not close again. It took you ${info.attempts + 1} attempts to stop being worth following.`
        : 'The cloud thins and does not close again. Nothing followed you out.';
      this.retry.textContent = 'again';
    } else {
      h.textContent = 'TAKEN';
      p.textContent = 'It had your bearing for four seconds. That was enough.';
      this.retry.textContent = 'continue';
    }
    this.ending.classList.add('show');
    this.el.classList.remove('show');
  }

  hideEnding() { this.ending.classList.remove('show'); }
}

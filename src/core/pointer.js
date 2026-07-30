// Unified pointer input: mouse, touch and pen through one path.
//
// Written because the game has to be playable on a phone, and the two obvious
// approaches are both wrong. Handling touch events alongside mouse events
// duplicates every interaction and then diverges; translating touches into
// synthetic mouse events throws away the thing that makes touch different, which
// is that there can be more than one of them.
//
// Pointer Events give both for free, and the multi-touch that survives is
// exactly what this game needs: one finger acts, two fingers size the brush.
//
// The design constraint that shaped everything here: on a phone the finger is
// *on* the thing it is changing, so a brush drawn under the fingertip is
// invisible at the moment it matters most. The contact point is therefore
// offset above the finger, and the offset is reported so the renderer can draw
// the cursor where the tool will actually land.

import { clamp } from './math.js';

/** Distance in normalised units to lift the contact point above a finger. */
const TOUCH_LIFT = 0.09;

export class Pointer {
  /** @param {HTMLElement} target */
  constructor(target) {
    this.target = target;

    /** Live pointers by id. */
    this.active = new Map();

    /** The one driving the tool. */
    this.primaryId = null;

    // Normalised device coords, -1..1, y up.
    this.x = 0;
    this.y = 0;
    this.dx = 0;
    this.dy = 0;

    this.down = false;
    this.pressed = false;
    this.released = false;

    /** True while the gesture is a two-finger pinch rather than a stroke. */
    this.pinching = false;
    this.pinchDelta = 0;
    this._pinchStart = 0;

    /** Set for touch, so the caller can lift the cursor clear of the finger. */
    this.isTouch = false;

    /** Long press, for confirm-style interactions on touch. */
    this.heldFor = 0;
    this.longPressed = false;
    this._longFired = false;

    this._bind();
  }

  _toNdc(clientX, clientY) {
    const r = this.target.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * 2 - 1,
      y: 1 - ((clientY - r.top) / r.height) * 2,
    };
  }

  _bind() {
    const t = this.target;

    t.addEventListener('pointerdown', (e) => {
      t.setPointerCapture?.(e.pointerId);
      const p = this._toNdc(e.clientX, e.clientY);
      this.isTouch = e.pointerType !== 'mouse';
      if (this.isTouch) p.y += TOUCH_LIFT;

      this.active.set(e.pointerId, { ...p, type: e.pointerType });

      if (this.active.size === 1) {
        this.primaryId = e.pointerId;
        this.x = p.x; this.y = p.y;
        this.down = true;
        this.pressed = true;
        this.heldFor = 0;
        this._longFired = false;
      } else if (this.active.size === 2) {
        // A second finger converts the gesture rather than adding to it. Letting
        // the first finger keep painting while the second one pinches produces a
        // stripe of tool application across the dish every time the player
        // resizes, which is destructive in a game where every action costs.
        this.pinching = true;
        this.down = false;
        this._pinchStart = this._spread();
      }
      e.preventDefault();
    }, { passive: false });

    t.addEventListener('pointermove', (e) => {
      const rec = this.active.get(e.pointerId);
      const p = this._toNdc(e.clientX, e.clientY);
      if (e.pointerType !== 'mouse') p.y += TOUCH_LIFT;

      if (rec) { rec.x = p.x; rec.y = p.y; }

      if (this.pinching && this.active.size >= 2) {
        const s = this._spread();
        this.pinchDelta += s - this._pinchStart;
        this._pinchStart = s;
      } else if (e.pointerId === this.primaryId) {
        this.dx += p.x - this.x;
        this.dy += p.y - this.y;
        this.x = p.x;
        this.y = p.y;
      } else if (!rec && e.pointerType === 'mouse') {
        // Hover with no button held, so the cursor still tracks.
        this.x = p.x;
        this.y = p.y;
      }
      e.preventDefault();
    }, { passive: false });

    const end = (e) => {
      this.active.delete(e.pointerId);
      if (e.pointerId === this.primaryId) {
        this.down = false;
        this.released = true;
        this.primaryId = null;
      }
      if (this.active.size < 2) this.pinching = false;
      // Promote a surviving finger, so lifting the first of two does not
      // silently end the stroke.
      if (this.active.size === 1 && this.primaryId === null) {
        const [id, rec] = [...this.active.entries()][0];
        this.primaryId = id;
        this.x = rec.x; this.y = rec.y;
        this.down = true;
        this.heldFor = 0;
      }
    };

    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
    t.addEventListener('lostpointercapture', end);
    t.addEventListener('contextmenu', (e) => e.preventDefault());

    t.addEventListener('wheel', (e) => {
      this.pinchDelta -= Math.sign(e.deltaY) * 0.08;
      e.preventDefault();
    }, { passive: false });
  }

  _spread() {
    const pts = [...this.active.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** Midpoint of a pinch, so the brush resizes around what the player is looking at. */
  pinchCentre() {
    const pts = [...this.active.values()];
    if (pts.length < 2) return { x: this.x, y: this.y };
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  update(dt, longPressSeconds = 0.45) {
    if (this.down && !this.pinching) {
      this.heldFor += dt;
      if (!this._longFired && this.heldFor >= longPressSeconds) {
        this._longFired = true;
        this.longPressed = true;
      }
    } else {
      this.heldFor = 0;
    }
  }

  /** Call after the simulation has read everything. */
  endFrame() {
    this.pressed = false;
    this.released = false;
    this.longPressed = false;
    this.dx = 0;
    this.dy = 0;
    this.pinchDelta = 0;
  }
}

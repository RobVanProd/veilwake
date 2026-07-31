// Measuring mood.
//
// "Too perky, not dark and doomy" is a real, checkable statement about an image,
// and this project has been burned four times by tuning a constant against a
// guess instead of a measurement. So before touching the palette: a metric.
//
// What these numbers mean, and why these and not others:
//
// - **p50 luminance** is how dark the frame actually is. A doomy frame is dark
//   in the middle, not merely dark in the corners.
// - **p99 / p50** is the thing people actually mean by "god rays". A bright
//   frame with bright rays has a low ratio and reads as weather; a dark frame
//   with the same bright rays has a high one and reads as revelation. This is
//   the single number this pass exists to move.
// - **litFrac** guards the obvious cheat. You can win every contrast number by
//   turning the lights off, so this reports how much of the frame is genuinely
//   bright. Dread needs darkness AND something blazing in it — if litFrac goes
//   to zero the image is not doomy, it is off.
// - **warmth** is mean(R) - mean(B) in display units. Positive is amber, which
//   is the specific quality being complained about. The intended direction is a
//   cold frame with warmth reserved for danger, so this should go negative
//   overall while the *peak* stays warm where a light source is.
// - **coldShadowSep** checks the palette's own stated intent: that shadow is
//   cold and light is warm. It measures warmth in the darkest quartile against
//   warmth in the brightest. Hue doing the work saturation would do badly.

/** Luminance in display space. Rec. 709, matching what the eye weights. */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function percentile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const i = (sortedArr.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sortedArr[lo] : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (i - lo);
}

/**
 * Read the current framebuffer and describe its mood.
 * Call immediately after an explicit render — the drawing buffer is only
 * guaranteed to hold the frame until the next composite.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} sample downscale factor; 1 reads every pixel
 */
export function measureMood(renderer, sample = 4) {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const L = [], R = [], G = [], B = [];
  for (let y = 0; y < h; y += sample) {
    for (let x = 0; x < w; x += sample) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      R.push(r); G.push(g); B.push(b); L.push(lum(r, g, b));
    }
  }
  const n = L.length;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

  // Sort a copy: the index-aligned arrays are still needed for the shadow/light
  // hue separation below.
  const Ls = L.slice().sort((a, b) => a - b);
  const p01 = percentile(Ls, 0.01), p05 = percentile(Ls, 0.05);
  const p50 = percentile(Ls, 0.50), p95 = percentile(Ls, 0.95);
  const p99 = percentile(Ls, 0.99), p999 = percentile(Ls, 0.999);

  // Hue of shadow vs hue of light, using this frame's own quartiles rather than
  // a fixed threshold — a fixed one stops meaning anything the moment the frame
  // gets darker, which is the entire point of this pass.
  const q25 = percentile(Ls, 0.25), q75 = percentile(Ls, 0.75);
  let darkR = 0, darkB = 0, darkN = 0, litR = 0, litB = 0, litN = 0, blown = 0, litFrac = 0;
  for (let i = 0; i < n; i++) {
    if (L[i] <= q25) { darkR += R[i]; darkB += B[i]; darkN++; }
    else if (L[i] >= q75) { litR += R[i]; litB += B[i]; litN++; }
    if (L[i] > 250) blown++;
    if (L[i] > 160) litFrac++;
  }

  const warmth = mean(R) - mean(B);
  const shadowWarm = darkN ? (darkR - darkB) / darkN : 0;
  const litWarm = litN ? (litR - litB) / litN : 0;

  return {
    p01: +p01.toFixed(1), p05: +p05.toFixed(1), p50: +p50.toFixed(1),
    p95: +p95.toFixed(1), p99: +p99.toFixed(1), p999: +p999.toFixed(1),
    mean: +mean(L).toFixed(1),
    /** The headline. Higher is more "shafts in a dark room". */
    dynamic: +(p99 / Math.max(p50, 1)).toFixed(2),
    contrast: +(p95 - p05).toFixed(1),
    /** Fraction of frame that is genuinely bright — the anti-cheat. */
    litFrac: +(litFrac / n * 100).toFixed(2),
    blownFrac: +(blown / n * 100).toFixed(2),
    warmth: +warmth.toFixed(1),
    shadowWarm: +shadowWarm.toFixed(1),
    litWarm: +litWarm.toFixed(1),
    /** Positive means light is warmer than shadow, which is the palette's intent. */
    coldShadowSep: +(litWarm - shadowWarm).toFixed(1),
    pixels: n,
  };
}

/**
 * A one-line verdict, so an iteration can be judged without re-reading the
 * numbers every time. These thresholds are the target of this pass, not
 * measurements of it — they encode "dark, with something blazing in it".
 */
export function verdict(m) {
  const notes = [];
  if (m.p50 > 70) notes.push(`too bright (p50 ${m.p50}, want <70)`);
  if (m.dynamic < 3.0) notes.push(`flat (p99/p50 ${m.dynamic}, want >3)`);
  if (m.litFrac < 0.8) notes.push(`nothing blazing (litFrac ${m.litFrac}%, want >0.8)`);
  if (m.warmth > 2) notes.push(`too warm overall (${m.warmth}, want <=2)`);
  if (m.coldShadowSep < 4) notes.push(`shadow not cold vs light (${m.coldShadowSep}, want >4)`);
  return notes.length ? notes.join('; ') : 'dark, cold, and blazing where it should be';
}

// Small maths.
//
// Nothing here is clever. It exists so that the same easing, the same
// framerate-independent smoothing and the same noise are used everywhere,
// because three subtly different lerps in three files is how a game ends up
// feeling inconsistent for reasons nobody can point at.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(inverseLerp(a, b, v)));
export const sign = Math.sign;

/**
 * Framerate-independent approach.
 *
 * `x += (target - x) * 0.1` is the most common bug in game code that nobody
 * reports as a bug: it is a different speed at 60 and 144 fps, so the game feels
 * different on different machines and the difference is blamed on "feel". The
 * exponential form is correct at any step.
 *
 * `rate` is roughly "how many e-foldings per second" — 10 is snappy, 3 is soft.
 */
export const approach = (current, target, rate, dt) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Same, for angles, taking the short way round. */
export function approachAngle(current, target, rate, dt) {
  return current + shortestAngle(current, target) * (1 - Math.exp(-rate * dt));
}

/** Signed smallest rotation from a to b, in radians. */
export function shortestAngle(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Hermite. The workhorse for anything that should ease in and out. */
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
};

/** Zero second derivative at both ends — for camera and anything the eye tracks. */
export const smootherstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t, k = 1.70158) => 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2);
export const easeOutElastic = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;

/** Decaying oscillation. For impacts that should ring rather than stop dead. */
export const spring = (t, freq = 8, damp = 6) => Math.exp(-damp * t) * Math.cos(freq * TAU * t);

// --------------------------------------------------------------------- vec2

export const v2 = (x = 0, y = 0) => ({ x, y });
export const v2set = (o, x, y) => { o.x = x; o.y = y; return o; };
export const v2copy = (o, a) => { o.x = a.x; o.y = a.y; return o; };
export const v2add = (o, a, b) => { o.x = a.x + b.x; o.y = a.y + b.y; return o; };
export const v2sub = (o, a, b) => { o.x = a.x - b.x; o.y = a.y - b.y; return o; };
export const v2scale = (o, a, s) => { o.x = a.x * s; o.y = a.y * s; return o; };
export const v2addScaled = (o, a, b, s) => { o.x = a.x + b.x * s; o.y = a.y + b.y * s; return o; };
export const v2dot = (a, b) => a.x * b.x + a.y * b.y;
export const v2cross = (a, b) => a.x * b.y - a.y * b.x;
export const v2lenSq = (a) => a.x * a.x + a.y * a.y;
export const v2len = (a) => Math.hypot(a.x, a.y);
export const v2distSq = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
export const v2dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function v2norm(o, a) {
  const l = Math.hypot(a.x, a.y);
  if (l < 1e-9) { o.x = 0; o.y = 0; return o; }
  o.x = a.x / l; o.y = a.y / l;
  return o;
}

export function v2rot(o, a, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const x = a.x * c - a.y * s;
  o.y = a.x * s + a.y * c;
  o.x = x;
  return o;
}

export const v2perp = (o, a) => { const x = -a.y; o.y = a.x; o.x = x; return o; };
export const v2lerp = (o, a, b, t) => { o.x = lerp(a.x, b.x, t); o.y = lerp(a.y, b.y, t); return o; };

export function v2clampLen(o, a, max) {
  const l = Math.hypot(a.x, a.y);
  if (l <= max || l < 1e-9) { o.x = a.x; o.y = a.y; return o; }
  const s = max / l;
  o.x = a.x * s; o.y = a.y * s;
  return o;
}

// --------------------------------------------------------------------- noise

/**
 * Value noise with smootherstep interpolation, seeded by an integer.
 *
 * Not gradient noise: value noise is a little blobbier, which is usually what is
 * wanted for a field that should look organic rather than technical, and it is
 * cheaper. Where directional structure matters, layer it.
 */
export function makeNoise2D(seed = 1) {
  const hash = (x, y) => {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };

  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
  };
}

/** Layered noise. Returns roughly [-1, 1]. */
export function fbm2D(noise, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Deterministic 1D hash, for per-index jitter that must not consume an RNG. */
export function hash1(i) {
  let h = Math.imul(i | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Weighted pick from [{weight}]. Returns an index, or -1 if all weights are 0. */
export function weightedPick(items, roll01, weightOf = (i) => i.weight) {
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total <= 0) return -1;
  let r = roll01 * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weightOf(items[i]));
    if (r <= 0) return i;
  }
  return items.length - 1;
}

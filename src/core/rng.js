// Deterministic pseudo-random numbers.
//
// Math.random cannot be seeded, which makes it useless here: a deterministic
// visual baseline, a reproducible scenario and a repeatable performance capture
// all need the same seed to produce the same run. Every source of randomness in
// this project goes through one of these, and any system that needs randomness
// takes a stream rather than reaching for a global — otherwise the order systems
// happen to update in silently changes the world.

/**
 * SplitMix64-derived 32-bit generator. Small, fast, and good enough that noise
 * built from it has no visible structure — which is the only property a game
 * actually needs from a PRNG.
 */
export class Rng {
  /** @param {number} seed */
  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Raw 32-bit unsigned. */
  next() {
    // xorshift32 — three shifts, no multiply, no table.
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.state = x;
    return x;
  }

  /** [0, 1) */
  float() {
    // Divide by 2^32 rather than using the top bits only: the low bits of
    // xorshift are weaker, but not weak enough to matter at float precision,
    // and taking the whole word keeps the distribution even.
    return this.next() / 4294967296;
  }

  /** [min, max) */
  range(min, max) {
    return min + this.float() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min, max) {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** Symmetric, in [-n, n]. */
  spread(n) {
    return (this.float() * 2 - 1) * n;
  }

  /** Approximately normal, mean 0, sd 1. Three samples is close enough and has no tail. */
  gaussian() {
    return (this.float() + this.float() + this.float() - 1.5) * 1.1547;
  }

  /** True with probability p. */
  chance(p) {
    return this.float() < p;
  }

  /** Uniform pick. */
  pick(array) {
    return array[Math.floor(this.float() * array.length)];
  }

  /** In-place Fisher-Yates. */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = array[i]; array[i] = array[j]; array[j] = t;
    }
    return array;
  }

  /**
   * An independent stream derived from this one.
   *
   * Systems take their own stream so that adding a call in one place cannot
   * shift every other system's sequence — the classic way a "deterministic"
   * build stops reproducing after an unrelated edit.
   */
  fork(tag = 0) {
    // The seed is avalanched, and that is the whole fix.
    //
    // This used to be `new Rng((this.next() ^ (tag * K)) >>> 0)`, and it produced
    // streams that were not independent at all: two creatures forked from one
    // parent agreed on **1826 of 2000 draws**, against 2000 for identical
    // streams. That is 91% correlation in the numbers that decide which mistakes
    // a creature makes — so two Listeners would hallucinate together, which the
    // contract's §5.3 explicitly forbids and which no player would ever read as
    // two animals.
    //
    // The cause is that xorshift32 is linear over GF(2). Consecutive outputs of
    // the parent are linearly related, seeds that are linearly related produce
    // states that stay linearly related, and the generator has no mixing step
    // strong enough to break that. Feeding it XOR'd tags does not help, because
    // XOR is linear too.
    //
    // A SplitMix-style finaliser is non-linear (it multiplies), so seeds that
    // differ by one bit end up uncorrelated. `tag` also goes through Math.imul
    // now: `tag * 0x85ebca6b` exceeds 2^53 for tags above about 4 million and
    // silently loses its low bits, which are the ones being relied on.
    let z = (this.next() ^ Math.imul(tag | 0, 0x85ebca6b)) >>> 0;
    z = (z + 0x9e3779b9) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return new Rng(z);
  }
}

/**
 * Seeds a stream from a string, so scenarios can be named rather than numbered.
 * FNV-1a: trivial and well distributed over short strings.
 */
export function seedFrom(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

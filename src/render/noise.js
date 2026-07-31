// Procedural noise volumes for the cloud field.
//
// Interface — deliberately free of any Three.js dependency, because the same
// bytes have to be readable two ways: uploaded to the GPU as a 3D texture, and
// sampled on the CPU by navigation, concealment and creature code. If those two
// paths ever read different data the game is lying to the player about where the
// clouds are, so they read one array.
//
//   makeShapeVolume({ size, seed })   -> Volume   RGBA8, R = Perlin-Worley, GBA = Worley
//   makeDetailVolume({ size, seed })  -> Volume   RGBA8, RGB = Worley, A = fine Perlin
//   makeWeatherMap({ size, seed })    -> Map2D    RGBA8, see below
//   makeBlueNoiseTile({ size, seed }) -> Map2D    RGBA8, greyscale dither mask
//   sample3D(volume, u, v, w, out4)   -> trilinear, wrapping, channels in [0,1]
//   sample2D(map, u, v, out4)
//
// Coordinates are normalised: one unit is one tile, and the tile repeats. That
// is exactly what the GPU does with REPEAT + LINEAR, and sample3D reproduces the
// same arithmetic (half-texel offset, x then y then z interpolation order) so a
// CPU query and a shader fetch return the same number.
//
// Everything tiles. It has to: the player travels forever, so the world is a
// small periodic field viewed through a recentring origin rather than an
// ever-growing coordinate. Non-tiling noise would force world coordinates to
// grow until float32 gives up somewhere over the horizon.
//
// Generation runs at load rather than from a baked file, and a Python baker in
// tools/ was the alternative. It was rejected: two implementations of the same
// noise is two chances for them to diverge, and the agreement guarantee above is
// worth more than the ~750 ms this costs (shape 480, weather 110, detail 85,
// blue noise 70, measured at 1080p on the development machine). The volumes are
// small for the same reason — detail comes from layering a 32 cubed tile at
// 256 m over a 64 cubed tile at 4096 m, not from one enormous texture.

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** 32-bit integer hash of a lattice point. Avalanches well enough that adjacent
 *  cells produce uncorrelated feature positions, which is the only property the
 *  Worley pass needs. */
function hash3i(x, y, z, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^
          Math.imul(z | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  // Masked to 31 bits rather than made unsigned. A uint32 above 2^31 stops being
  // a small integer in JavaScript and every arithmetic use of it afterwards runs
  // on the slow path; over the million-odd lattice lookups this volume needs,
  // that alone is a couple of hundred milliseconds of startup.
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

/** Integer modulo that is correct for negative inputs, unlike `%`. */
function imod(a, n) {
  const m = a % n;
  return m < 0 ? m + n : m;
}

// ---------------------------------------------------------------------------
// Perlin (gradient) noise, tileable on an integer lattice period
// ---------------------------------------------------------------------------

// The twelve cube-edge vectors, padded to sixteen with four repeats. Fixed
// vectors rather than random ones remove the directional bias a naive gradient
// table produces at low octave counts; padding to a power of two turns the
// selection into a mask instead of a modulo, which matters because this is the
// innermost line of the whole generator.
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

function gdot(h, x, y, z) {
  const i = (h & 15) * 3;
  return GRAD3[i] * x + GRAD3[i + 1] * y + GRAD3[i + 2] * z;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;

/**
 * Gradient noise in [-1, 1], periodic with `period` lattice cells on every axis.
 * The period is what makes the finished texture tile; without it the seam
 * between the last and first texel is a visible straight line across the sky.
 */
function perlin3(x, y, z, period, seed) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fade(fx), v = fade(fy), w = fade(fz);

  const x0 = imod(X, period), x1 = imod(X + 1, period);
  const y0 = imod(Y, period), y1 = imod(Y + 1, period);
  const z0 = imod(Z, period), z1 = imod(Z + 1, period);

  const n000 = gdot(hash3i(x0, y0, z0, seed), fx, fy, fz);
  const n100 = gdot(hash3i(x1, y0, z0, seed), fx - 1, fy, fz);
  const n010 = gdot(hash3i(x0, y1, z0, seed), fx, fy - 1, fz);
  const n110 = gdot(hash3i(x1, y1, z0, seed), fx - 1, fy - 1, fz);
  const n001 = gdot(hash3i(x0, y0, z1, seed), fx, fy, fz - 1);
  const n101 = gdot(hash3i(x1, y0, z1, seed), fx - 1, fy, fz - 1);
  const n011 = gdot(hash3i(x0, y1, z1, seed), fx, fy - 1, fz - 1);
  const n111 = gdot(hash3i(x1, y1, z1, seed), fx - 1, fy - 1, fz - 1);

  return mix(
    mix(mix(n000, n100, u), mix(n010, n110, u), v),
    mix(mix(n001, n101, u), mix(n011, n111, u), v), w);
}

/** Layered Perlin, in [-1, 1]. Base period doubles with each octave so the whole
 *  stack keeps tiling. */
function perlinFbm3(x, y, z, basePeriod, octaves, seed) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin3(x * freq, y * freq, z * freq, basePeriod * freq, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Worley (cellular) noise volume
// ---------------------------------------------------------------------------

/**
 * One octave of inverted Worley over the whole volume, returned as [0, 1] with 1
 * at the feature points — the billowy form that reads as cloud rather than as
 * the cratered look of raw distance.
 *
 * Written as a splat rather than the usual per-voxel gather over 27 neighbouring
 * cells. Because the distance is clamped at one cell, a feature point cannot
 * affect anything outside a sphere of that radius, so scattering each point into
 * its own sphere produces bit-identical output while touching roughly a third as
 * many voxels. On a 64 cubed volume that is three octaves in about 90 ms rather
 * than 300.
 */
function worleyVolume(size, freq, seed) {
  const n = size * size * size;
  const best = new Float32Array(n).fill(Infinity);   // squared voxel distance

  // Voxels per cell. The result is clamped at one cell of distance, so a feature
  // point can only affect voxels inside a sphere of that radius — which is what
  // makes the splat below exact rather than an approximation.
  const cellVox = size / freq;
  const r2 = cellVox * cellVox;

  for (let cz = 0; cz < freq; cz++) {
    for (let cy = 0; cy < freq; cy++) {
      for (let cx = 0; cx < freq; cx++) {
        const h = hash3i(cx, cy, cz, seed);
        // Jitter kept inside the cell so the point stays where its cell says it
        // is, which is what keeps the field's frequency honest.
        const fx = cx + 0.05 + ((h & 1023) / 1023) * 0.9;
        const fy = cy + 0.05 + (((h >>> 10) & 1023) / 1023) * 0.9;
        const fz = cz + 0.05 + (((h >>> 20) & 1023) / 1023) * 0.9;

        // Cell units to voxel units. Voxel i sits at cell coordinate
        // (i + 0.5) / cellVox, so the inverse carries the same half offset.
        const vx = fx * cellVox - 0.5;
        const vy = fy * cellVox - 0.5;
        const vz = fz * cellVox - 0.5;

        const x0 = Math.ceil(vx - cellVox), x1 = Math.floor(vx + cellVox);
        const y0 = Math.ceil(vy - cellVox), y1 = Math.floor(vy + cellVox);
        const z0 = Math.ceil(vz - cellVox), z1 = Math.floor(vz + cellVox);

        for (let z = z0; z <= z1; z++) {
          const dz = z - vz, dz2 = dz * dz;
          if (dz2 >= r2) continue;
          const wz = imod(z, size) * size * size;
          for (let y = y0; y <= y1; y++) {
            const dy = y - vy, dzy = dz2 + dy * dy;
            if (dzy >= r2) continue;
            const wy = wz + imod(y, size) * size;
            for (let x = x0; x <= x1; x++) {
              const dx = x - vx;
              const d2 = dzy + dx * dx;
              if (d2 >= r2) continue;
              // Wrapping the voxel index is all the seam handling this needs:
              // the influence sphere wraps with the tile because the tile is the
              // whole world as far as this texture is concerned.
              const i = wy + imod(x, size);
              if (d2 < best[i]) best[i] = d2;
            }
          }
        }
      }
    }
  }

  const out = new Float32Array(n);
  const invCell = 1 / cellVox;
  for (let i = 0; i < n; i++) {
    const b = best[i];
    out[i] = b === Infinity ? 0 : 1 - Math.min(Math.sqrt(b) * invCell, 1);
  }
  return out;
}

/**
 * Stretch a channel so it actually uses [0, 1].
 *
 * Layered Perlin is a sum of independent terms and therefore lands close to
 * normal: mean 0.5, almost nothing outside 0.2..0.8. Feeding that into a
 * coverage threshold produces a sky that is either solid or empty depending on
 * where the threshold falls, with nothing in between and no way to tune it. The
 * percentile clip rather than min/max is because a single outlier voxel would
 * otherwise decide the scale for the whole volume.
 */
function stretch(values, lowPct = 0.01, highPct = 0.99) {
  const bins = 1024;
  const hist = new Int32Array(bins);
  for (let i = 0; i < values.length; i++) {
    let b = (values[i] * bins) | 0;
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const loTarget = values.length * lowPct, hiTarget = values.length * highPct;
  let acc = 0, lo = 0, hi = bins - 1;
  for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= loTarget) { lo = b; break; } }
  acc = 0;
  for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= hiTarget) { hi = b; break; } }
  const a = lo / bins, c = Math.max(hi / bins, a + 1e-3);
  const inv = 1 / (c - a);
  for (let i = 0; i < values.length; i++) values[i] = clamp01((values[i] - a) * inv);
  return values;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toByte = (v) => {
  const b = Math.round(clamp01(v) * 255);
  return b;
};

/**
 * Remap that both sides of the CPU/GPU boundary use. Written once here and once
 * in GLSL; they must stay identical, and the agreement probe in clouds.js is
 * what catches it when they do not.
 */
const remap01 = (v, lo, hi) => clamp01((v - lo) / (hi - lo || 1e-5));

/**
 * The shape volume: the body of the cloud.
 *
 *   R  Perlin-Worley — Perlin eroded by its own Worley stack, which gives round
 *      billows with connective tissue between them rather than isolated blobs
 *   G  Worley, 4 cells per tile   (~1000 m features at a 4096 m tile)
 *   B  Worley, 8 cells per tile   (~500 m)
 *   A  Worley, 16 cells per tile  (~250 m)
 *
 * The three Worley channels are reused twice: once to build R, and again in the
 * shader as the erosion stack. One generation pass, two jobs.
 */
export function makeShapeVolume({ size = 64, seed = 1 } = {}) {
  const n = size * size * size;
  const w4 = worleyVolume(size, 4, seed + 11);
  const w8 = worleyVolume(size, 8, seed + 23);
  const w16 = worleyVolume(size, 16, seed + 37);

  const pw = new Float32Array(n);
  const inv = 1 / size;

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      let i = (z * size + y) * size;
      for (let x = 0; x < size; x++, i++) {
        const u = (x + 0.5) * inv, v = (y + 0.5) * inv, t = (z + 0.5) * inv;
        // Base period 4 matches the lowest Worley frequency, so the Perlin
        // billows and the Worley cells are the same size and interlock instead
        // of fighting each other.
        // Three octaves, not four: at a 64 texel volume the fourth has a two
        // texel wavelength, which is below what an 8-bit trilinear fetch can
        // carry. It costs a quarter of the generation time and returns noise.
        const p = perlinFbm3(u * 4, v * 4, t * 4, 4, 3, seed + 101) * 0.5 + 0.5;
        const wf = w4[i] * 0.625 + w8[i] * 0.25 + w16[i] * 0.125;
        pw[i] = remap01(p, wf * 0.45 - 0.05, 1.0);
      }
    }
  }
  stretch(pw);

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    data[o] = toByte(pw[i]);
    data[o + 1] = toByte(w4[i]);
    data[o + 2] = toByte(w8[i]);
    data[o + 3] = toByte(w16[i]);
  }
  return { size, data, channels: 4 };
}

/**
 * The detail volume: the turbulent edge.
 *
 *   RGB  Worley at 4 / 8 / 16 cells per tile (at a 256 m tile: 64 / 32 / 16 m)
 *   A    fine Perlin, used to break the Worley cells into filaments rather than
 *        leaving the erosion pattern visibly cellular on a silhouette
 */
export function makeDetailVolume({ size = 32, seed = 2 } = {}) {
  const n = size * size * size;
  const w4 = worleyVolume(size, 4, seed + 5);
  const w8 = worleyVolume(size, 8, seed + 17);
  const w16 = worleyVolume(size, 16, seed + 29);

  const data = new Uint8Array(n * 4);
  const inv = 1 / size;

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      let i = (z * size + y) * size;
      for (let x = 0; x < size; x++, i++) {
        const u = (x + 0.5) * inv, v = (y + 0.5) * inv, t = (z + 0.5) * inv;
        const p = perlinFbm3(u * 8, v * 8, t * 8, 8, 3, seed + 211) * 0.5 + 0.5;
        const o = i * 4;
        data[o] = toByte(w4[i]);
        data[o + 1] = toByte(w8[i]);
        data[o + 2] = toByte(w16[i]);
        data[o + 3] = toByte(p);
      }
    }
  }
  return { size, data, channels: 4 };
}

/**
 * The weather map: what the sky is doing, per square kilometre.
 *
 *   R  coverage      0 clear, 1 solid. Drives how much of the shape survives.
 *   G  form          0 flat deck, 0.5 rolling, 1 towering. Picks the height
 *                    profile, and so decides whether there is anything to fly
 *                    between or just a ceiling.
 *   B  charge        electrical activity. Storm cells are placed where this is
 *                    high, so a player reading the sky can predict them.
 *   A  current       large-scale flow phase, used by the CPU flow query.
 *
 * Two spatial scales, not one: a continental band structure at the tile period
 * and a ridged octave eight times finer. A single octave of coverage gives an
 * evenly-spotted sky, which is the fastest way to make an endless world feel
 * small.
 */
// 128 texels over a 65 km tile is 512 m each. That looks absurdly coarse until
// you notice the finest octave in it has 2.7 km features: the weather map is a
// broad control, and everything below a kilometre comes from the shape volume.
// Doubling it costs 400 ms of startup and changes nothing on screen.
export function makeWeatherMap({ size = 128, seed = 3 } = {}) {
  const n = size * size;
  const cov = new Float32Array(n);
  const form = new Float32Array(n);
  const charge = new Float32Array(n);
  const current = new Float32Array(n);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) * inv, v = (y + 0.5) * inv;

      // z is held at a constant, non-integer slice so the 2D field is a cut
      // through the 3D noise rather than a plane through the lattice, which
      // would be flat along the grid lines.
      // At a 65 km tile these are 32 km, 8 km and 3.3 km features. The middle
      // one carries most of the weight on purpose: it sets the size of a single
      // cloud mass, and therefore how far apart they sit. Let the 32 km octave
      // lead instead and the sky becomes half continent and half nothing, which
      // looks enormous in a top-down plot and, from inside, is either a wall or
      // an empty room.
      const big = perlinFbm3(u * 2, 0.37, v * 2, 2, 2, seed + 7) * 0.5 + 0.5;
      const mid = perlinFbm3(u * 8, 1.61, v * 8, 8, 2, seed + 19) * 0.5 + 0.5;
      const fine = perlinFbm3(u * 20, 2.71, v * 20, 20, 2, seed + 43) * 0.5 + 0.5;

      // Ridged: the absolute value of a signed octave, which produces long
      // fronts and lanes rather than round patches. The lanes are the navigable
      // gaps, so this channel is level design.
      const ridge = 1 - Math.abs(perlinFbm3(u * 6, 4.13, v * 6, 6, 2, seed + 61));

      cov[i] = (big * 0.26 + mid * 0.46 + fine * 0.28) * (remap01(ridge, 0.05, 0.78) * 0.78 + 0.22);
      // Towers where the broad weather peaks: big weather sits inside big
      // weather, and clear air stays genuinely clear.
      form[i] = big * 0.62 + mid * 0.38;
      // Charge follows the towers but not exactly, so the dangerous cell is not
      // always the obvious one.
      charge[i] = form[i] * 0.65 + fine * 0.35;
      current[i] = perlinFbm3(u * 3, 5.5, v * 3, 3, 2, seed + 83) * 0.5 + 0.5;
    }
  }

  // Stretched rather than hand-thresholded. Hand-picked constants here silently
  // depend on the octave count, so changing the noise elsewhere would empty the
  // sky without anything obviously breaking.
  stretch(cov, 0.02, 0.98);
  stretch(form, 0.10, 0.95);
  stretch(charge, 0.30, 0.99);

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    data[o] = toByte(cov[i]);
    data[o + 1] = toByte(form[i]);
    data[o + 2] = toByte(charge[i]);
    data[o + 3] = toByte(current[i]);
  }
  return { size, data, channels: 4 };
}

// ---------------------------------------------------------------------------
// Blue noise
// ---------------------------------------------------------------------------

/**
 * A tiling blue-noise mask, by void-and-cluster (Ulichney).
 *
 * This started as an interleaved gradient noise function — one multiply-add, no
 * texture, and the usual choice. It was wrong here, and the captures said so:
 * IGN has real energy at middle spatial frequencies, and middle frequencies are
 * exactly what a reconstruction filter cannot remove. The lit face of every
 * cloud came out with a fine diagonal weave across it. IGN is the right choice
 * when frames are accumulated over time, because the pattern is designed to
 * cancel against its own temporal offsets; this renderer deliberately keeps no
 * history, so it never gets that cancellation.
 *
 * Blue noise puts its energy where the 3x3 upsample throws it away. The result
 * is grain rather than pattern, and grain at a quarter of the amplitude.
 *
 * 64 squared costs about seventy milliseconds to build. The size is the knob if
 * that ever needs to come down; the algorithm is quadratic in the pixel count,
 * so 32 squared is sixteen times cheaper and tiles visibly on a smooth gradient.
 */
export function makeBlueNoiseTile({ size = 64, seed = 5 } = {}) {
  const n = size * size;
  const energy = new Float32Array(n);
  const on = new Uint8Array(n);

  // Gaussian energy kernel, precomputed. sigma 1.5 is Ulichney's; the radius is
  // where the term stops mattering at float precision.
  const R = 6;
  const K = 2 * R + 1;
  const kern = new Float32Array(K * K);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kern[(dy + R) * K + (dx + R)] = Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5));
    }
  }

  const splat = (idx, sign) => {
    const x0 = idx % size, y0 = (idx / size) | 0;
    for (let dy = -R; dy <= R; dy++) {
      const row = imod(y0 + dy, size) * size;
      const krow = (dy + R) * K + R;
      for (let dx = -R; dx <= R; dx++) {
        energy[row + imod(x0 + dx, size)] += sign * kern[krow + dx];
      }
    }
  };

  const tightestCluster = () => {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < n; i++) if (on[i] && energy[i] > bestE) { bestE = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < n; i++) if (!on[i] && energy[i] < bestE) { bestE = energy[i]; best = i; }
    return best;
  };

  // Initial pattern: a tenth of the pixels, placed by hash.
  let ones = 0;
  const target = Math.max(1, Math.round(n * 0.1));
  for (let i = 0; ones < target && i < n * 4; i++) {
    const p = hash3i(i, 7, 13, seed) % n;
    if (!on[p]) { on[p] = 1; splat(p, 1); ones++; }
  }

  // Phase 0: relax it until moving the tightest cluster into the largest void
  // stops changing anything. Bounded, because the classic formulation can
  // oscillate between two equally good arrangements.
  for (let iter = 0; iter < n * 2; iter++) {
    const c = tightestCluster();
    on[c] = 0; splat(c, -1);
    const v = largestVoid();
    if (v === c) { on[c] = 1; splat(c, 1); break; }
    on[v] = 1; splat(v, 1);
  }

  const rank = new Int32Array(n).fill(-1);
  const state = on.slice();
  const stateEnergy = energy.slice();

  // Phase 1: take the initial pattern apart, tightest cluster first. Those get
  // the lowest ranks, so the darkest pixels are the most spread out.
  for (let r = ones - 1; r >= 0; r--) {
    const c = tightestCluster();
    rank[c] = r;
    on[c] = 0; splat(c, -1);
  }

  // Phase 2: put it back together and keep going, filling the largest void each
  // time, to the end of the range.
  on.set(state); energy.set(stateEnergy);
  for (let r = ones; r < n; r++) {
    const v = largestVoid();
    rank[v] = r;
    on[v] = 1; splat(v, 1);
  }

  const data = new Uint8Array(n * 4);
  const inv = 255 / (n - 1);
  for (let i = 0; i < n; i++) {
    const b = Math.round(rank[i] * inv);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { size, data, channels: 4 };
}

// ---------------------------------------------------------------------------
// CPU sampling — the half of the agreement guarantee that runs on this side
// ---------------------------------------------------------------------------

/**
 * Trilinear fetch with REPEAT wrapping, matching a GPU sampler set to LINEAR.
 *
 * The half-texel offset and the x-then-y-then-z interpolation order are not
 * decoration: get either wrong and the CPU density is a fraction of a texel out
 * from the shader's, which shows up as creatures clipping cloud edges the player
 * can see them miss. Results land in `out` as four floats in [0, 1].
 */
export function sample3D(vol, u, v, w, out) {
  const s = vol.size, d = vol.data;
  const fx = u * s - 0.5, fy = v * s - 0.5, fz = w * s - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;

  const x0 = imod(ix, s), x1 = imod(ix + 1, s);
  const y0 = imod(iy, s) * s, y1 = imod(iy + 1, s) * s;
  const z0 = imod(iz, s) * s * s, z1 = imod(iz + 1, s) * s * s;

  const i000 = (z0 + y0 + x0) * 4, i100 = (z0 + y0 + x1) * 4;
  const i010 = (z0 + y1 + x0) * 4, i110 = (z0 + y1 + x1) * 4;
  const i001 = (z1 + y0 + x0) * 4, i101 = (z1 + y0 + x1) * 4;
  const i011 = (z1 + y1 + x0) * 4, i111 = (z1 + y1 + x1) * 4;

  for (let c = 0; c < 4; c++) {
    const a = mix(d[i000 + c], d[i100 + c], tx);
    const b = mix(d[i010 + c], d[i110 + c], tx);
    const e = mix(d[i001 + c], d[i101 + c], tx);
    const f = mix(d[i011 + c], d[i111 + c], tx);
    out[c] = mix(mix(a, b, ty), mix(e, f, ty), tz) * (1 / 255);
  }
  return out;
}

/** Same contract, two dimensions. */
export function sample2D(map, u, v, out) {
  const s = map.size, d = map.data;
  const fx = u * s - 0.5, fy = v * s - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;

  const x0 = imod(ix, s), x1 = imod(ix + 1, s);
  const y0 = imod(iy, s) * s, y1 = imod(iy + 1, s) * s;

  const i00 = (y0 + x0) * 4, i10 = (y0 + x1) * 4;
  const i01 = (y1 + x0) * 4, i11 = (y1 + x1) * 4;

  for (let c = 0; c < 4; c++) {
    const a = mix(d[i00 + c], d[i10 + c], tx);
    const b = mix(d[i01 + c], d[i11 + c], tx);
    out[c] = mix(a, b, ty) * (1 / 255);
  }
  return out;
}


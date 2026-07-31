// Measure the soundtrack, rather than guessing what each track is for.
//
// Run in the page console:
//   const m = await import('/tools/classify_music.js'); await m.classifyAll();
//
// 26 tracks arrived as generated audio with no useful names. A music director
// that responds to a threat model needs to know each track's character, and the
// two ways to get that are to listen to all of them by hand or to measure them.
// Measuring is reproducible, survives the tracks being replaced, and produces
// numbers a director can interpolate between rather than labels it can only
// switch on.
//
// Everything here decodes through WebAudio, which is already present, so there
// is no external tool and no build step. The cost is that it has to run in the
// page — which is fine, because the result is written to disk through the same
// evidence endpoint the captures use, and is then committed.

const FEATURES = [
  'duration', 'rmsDb', 'peakDb', 'crest',
  'centroidHz', 'rolloffHz', 'lowRatio', 'midRatio', 'highRatio',
  'flux', 'onsetRate', 'quietFrac', 'stereoWidth',
];

/** Decode one file to an AudioBuffer, offline so it does not need playback. */
async function decode(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  return await ctx.decodeAudioData(bytes);
}

/**
 * Features chosen because a director can act on them, not because they are easy.
 *
 * centroid and the band ratios describe *timbre* — whether a track is a low
 * drone or a bright shimmer — which is what decides whether it belongs under a
 * quiet drift or a pursuit. flux and onsetRate describe *motion*: how much the
 * track is doing per second, which is the closest single number to intensity.
 * quietFrac finds tracks with real silence in them, which are the ones usable
 * for the moments the design wants to feel empty. crest separates dynamic
 * material from something mastered flat.
 */
function analyse(buf) {
  const sr = buf.sampleRate;
  const n = buf.length;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;

  // Mono sum for spectral work; keep the pair for width.
  const mono = new Float32Array(n);
  let sumSq = 0, peak = 0, sideSq = 0, midSq = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    const m = (l + r) * 0.5;
    mono[i] = m;
    sumSq += m * m;
    const a = Math.abs(m);
    if (a > peak) peak = a;
    const s = (l - r) * 0.5;
    sideSq += s * s; midSq += m * m;
  }
  const rms = Math.sqrt(sumSq / n);

  // Short-time analysis. 2048 at ~44.1k is about 46ms — long enough for a
  // stable spectrum, short enough that an onset is not smeared away.
  const N = 2048, HOP = 1024;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const frames = Math.max(1, Math.floor((n - N) / HOP));
  const re = new Float32Array(N), im = new Float32Array(N);
  let prevMag = null;
  let centroidAcc = 0, rolloffAcc = 0, lowAcc = 0, midAcc = 0, highAcc = 0;
  let fluxAcc = 0, onsets = 0, quietFrames = 0, counted = 0;

  const frameRms = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let fr = 0;
    for (let i = 0; i < N; i++) {
      const v = mono[off + i] * win[i];
      re[i] = v; im[i] = 0;
      fr += v * v;
    }
    frameRms[f] = Math.sqrt(fr / N);
    fft(re, im);

    let mag = new Float32Array(N / 2);
    let total = 0, weighted = 0, low = 0, mid = 0, high = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      const hz = (k * sr) / N;
      total += m;
      weighted += m * hz;
      if (hz < 250) low += m;
      else if (hz < 2500) mid += m;
      else high += m;
    }
    if (total > 1e-7) {
      counted++;
      centroidAcc += weighted / total;
      lowAcc += low / total; midAcc += mid / total; highAcc += high / total;

      // 85% rolloff: the frequency below which most of the energy sits. A good
      // proxy for "is this dark or bright" that is less fragile than centroid
      // alone when a track has a single loud low tone.
      let acc = 0; const target = total * 0.85;
      for (let k = 1; k < N / 2; k++) { acc += mag[k]; if (acc >= target) { rolloffAcc += (k * sr) / N; break; } }

      if (prevMag) {
        let d = 0;
        for (let k = 1; k < N / 2; k++) { const diff = mag[k] - prevMag[k]; if (diff > 0) d += diff; }
        const norm = d / total;
        fluxAcc += norm;
        if (norm > 0.22) onsets++;
      }
      prevMag = mag;
    }
  }

  // Quiet is relative to the track's own level: a track with genuine silence in
  // it is one whose quietest passages are far below its own average, not one
  // that happens to be mastered low.
  const refRms = rms > 1e-6 ? rms : 1e-6;
  for (let f = 0; f < frames; f++) if (frameRms[f] < refRms * 0.18) quietFrames++;

  const db = (x) => 20 * Math.log10(Math.max(x, 1e-7));
  const c = Math.max(counted, 1);

  return {
    duration: +(n / sr).toFixed(2),
    rmsDb: +db(rms).toFixed(2),
    peakDb: +db(peak).toFixed(2),
    crest: +(db(peak) - db(rms)).toFixed(2),
    centroidHz: +(centroidAcc / c).toFixed(1),
    rolloffHz: +(rolloffAcc / c).toFixed(1),
    lowRatio: +(lowAcc / c).toFixed(4),
    midRatio: +(midAcc / c).toFixed(4),
    highRatio: +(highAcc / c).toFixed(4),
    flux: +(fluxAcc / c).toFixed(4),
    onsetRate: +(onsets / Math.max(frames * HOP / sr, 1)).toFixed(3),
    quietFrac: +(quietFrames / Math.max(frames, 1)).toFixed(4),
    stereoWidth: +Math.sqrt(sideSq / Math.max(midSq, 1e-9)).toFixed(4),
  };
}

/** In-place radix-2 FFT. Small and adequate; N is a power of two by construction. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * Turn measurements into the roles the director actually asks for.
 *
 * Deliberately derived rather than hand-assigned. Hand labels drift from what
 * the audio does the moment a track is replaced, and they cannot be interpolated
 * — a director choosing "the calmest track that still has motion" needs numbers.
 */
/**
 * Normalisation ranges, taken from the corpus rather than guessed.
 *
 * The first version divided each feature by a hand-picked constant, and one of
 * them was catastrophically wrong: onsetRate was divided by 1.6 when the actual
 * median across 2091 segments is 11.06 and the maximum is 27.5. **99.3% of
 * segments saturated it**, which pinned `motion` at 1.0 everywhere and silently
 * deleted the (1 - motion) term from drift, conceal and awe while maxing it in
 * pursuit. Four of the five roles were being computed with a dead term, and the
 * symptom was a "missing music" gap that was really a measurement bug — drift
 * went from 24 usable windows to 388 on the same audio once this was fixed.
 *
 * p05..p95 rather than min..max so a single outlying window cannot compress the
 * scale for everything else.
 */
export const NORM = {
  onsetRate:   [0.88, 18.22],
  flux:        [0.086, 0.223],
  centroidHz:  [321.0, 1555.5],
  lowRatio:    [0.183, 0.780],
  highRatio:   [0.012, 0.182],
  crest:       [7.99, 15.20],
  quietFrac:   [0.0, 0.351],
  stereoWidth: [0.184, 0.745],
};

const nz = (k, v) => {
  const [lo, hi] = NORM[k];
  return hi - lo < 1e-9 ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
};

export function scoreRoles(f) {
  const dark = 1 - nz('centroidHz', f.centroidHz);
  const motion = nz('onsetRate', f.onsetRate) * 0.6 + nz('flux', f.flux) * 0.4;
  const weight = nz('lowRatio', f.lowRatio);
  const air = nz('highRatio', f.highRatio);
  const dynamic = nz('crest', f.crest);
  const emptiness = nz('quietFrac', f.quietFrac);
  const width = nz('stereoWidth', f.stereoWidth);
  const still = 1 - motion;

  return {
    // Long, dark, still, and with room in it.
    drift: +(dark * 0.30 + still * 0.40 + emptiness * 0.15 + weight * 0.15).toFixed(3),
    // Something is out there. Dark and heavy but with movement underneath.
    unease: +(dark * 0.28 + motion * 0.32 + weight * 0.25 + (1 - air) * 0.15).toFixed(3),
    // It knows. Moving, bright enough to cut through, and never empty.
    pursuit: +(motion * 0.45 + air * 0.18 + (1 - emptiness) * 0.22 + (1 - dark) * 0.15).toFixed(3),
    // Held breath. The quietest material, used where most games get louder.
    conceal: +(emptiness * 0.45 + still * 0.35 + dark * 0.20).toFixed(3),
    // Scale. Wide, airy, dynamic — the moments the game exists for.
    awe: +(air * 0.30 + dynamic * 0.22 + width * 0.26 + still * 0.22).toFixed(3),
  };
}

/**
 * Window one track and score every window.
 *
 * This exists because the whole-track analysis produced a null result, and the
 * null result was informative: all 26 tracks scored 'unease' between 0.79 and
 * 0.89, with centroid varying only 1.96x across the entire set. They are
 * variants of a single prompt, so they are near-identical in aggregate — there
 * is no "pursuit track" to select, because each track is the same journey from
 * isolation through concealment to pursuit and back.
 *
 * Averaging a journey destroys exactly the information a director needs. So the
 * unit of selection is a window inside a track, not a track, and the director
 * crossfades between *positions* — which is also what the score was written for:
 * the prompt asked for one continuous arc with layers that enter and leave
 * cleanly, and every variant shares harmony and tempo, so any window will sit
 * against any other without clashing.
 */
export async function segmentTrack(ctx, url, { window = 8, hop = 4 } = {}) {
  const buf = await decode(ctx, url);
  const sr = buf.sampleRate;
  const wN = Math.floor(window * sr);
  const hN = Math.floor(hop * sr);
  const segs = [];
  for (let start = 0; start + wN <= buf.length; start += hN) {
    const slice = ctx.createBuffer(buf.numberOfChannels, wN, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      slice.copyToChannel(buf.getChannelData(ch).subarray(start, start + wN), ch);
    }
    const f = analyse(slice);
    segs.push({ t: +(start / sr).toFixed(1), ...f, roles: scoreRoles(f) });
  }
  return { duration: buf.duration, segments: segs };
}

export async function segmentAll({ count = 26, dir = '/assets/music', window = 8, hop = 4 } = {}) {
  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  const out = [];
  for (let i = 1; i <= count; i++) {
    const name = `vw_${String(i).padStart(2, '0')}.mp3`;
    try {
      const r = await segmentTrack(ctx, `${dir}/${name}`, { window, hop });
      out.push({ track: name, duration: r.duration, segments: r.segments });
    } catch (err) {
      out.push({ track: name, error: String(err && err.message || err) });
    }
  }
  await ctx.close();
  const payload = { window, hop, tracks: out };
  await fetch('/__evidence/music_segments.json', {
    method: 'POST', body: JSON.stringify(payload),
  });
  return { tracks: out.length, segments: out.reduce((s, t) => s + (t.segments ? t.segments.length : 0), 0) };
}

export async function classifyAll({ count = 26, dir = '/assets/music' } = {}) {
  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  const out = [];
  for (let i = 1; i <= count; i++) {
    const name = `vw_${String(i).padStart(2, '0')}.mp3`;
    try {
      const buf = await decode(ctx, `${dir}/${name}`);
      const f = analyse(buf);
      out.push({ track: name, ...f, roles: scoreRoles(f) });
    } catch (err) {
      out.push({ track: name, error: String(err && err.message || err) });
    }
  }
  await ctx.close();

  const payload = { generated: 'measured in-browser via WebAudio', features: FEATURES, tracks: out };
  await fetch('/__evidence/music_analysis.json', {
    method: 'POST', body: JSON.stringify(payload, null, 1),
  });
  return payload;
}

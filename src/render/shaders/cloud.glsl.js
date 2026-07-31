// Cloud shaders, as source strings.
//
// Three programs share one density function:
//
//   FULLSCREEN_VERT   trivial, used by all passes
//   MARCH_FRAG        the ray march, run at half resolution
//   COMPOSITE_FRAG    depth-aware upsample, sky, tone map, dither  (full res)
//   PROBE_FRAG        evaluates density at arbitrary points and writes them to a
//                     float target, so the CPU query can be checked against the
//                     shader instead of assumed to match it
//
// FIELD_GLSL is the density function itself and is pasted into MARCH_FRAG and
// PROBE_FRAG unchanged. Its counterpart lives in clouds.js as _densityCloud.
// Those two must agree; CloudSystem.verifyAgreement() is what proves they still
// do, and every constant they both need is a uniform rather than a literal so
// there is only one number to change.
//
// Everything the shader needs to know about time arrives pre-wrapped from the
// CPU. Nothing in here accumulates a growing coordinate — a shader that adds
// `wind * elapsedSeconds` to a position looks correct for twenty minutes and
// then starts crawling with float32 quantisation, which is the kind of bug that
// only reproduces in a long session.

export const FULLSCREEN_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

export const FIELD_GLSL = /* glsl */`
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform sampler2D uWeather;

uniform vec4  uLayer;        // base, top, thickness, 1/thickness  (metres)
uniform vec3  uPeriodInv;    // 1/shapePeriod, 1/detailPeriod, 1/weatherPeriod
uniform vec3  uShapeAdvect;  // wrapped to the shape period on the CPU
uniform vec3  uDetailAdvect;
uniform vec3  uWeatherAdvect;
uniform vec4  uBreath;       // two travelling-wave phases, two amplitudes
uniform vec2  uCoverage;     // gain, bias
uniform vec2  uErosion;      // detail strength, unused second slot
uniform float uDensityScale;

const float VW_TAU = 6.28318530718;

float vw_remap(float v, float lo, float hi) {
  return clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
}

vec4 vw_weather(vec3 p) {
  return texture(uWeather, (p.xz + uWeatherAdvect.xz) * uPeriodInv.z);
}

float vw_heightFraction(vec3 p) {
  return clamp((p.y - uLayer.x) * uLayer.w, 0.0, 1.0);
}

// Three vertical profiles, chosen by the weather map's form channel. The profile
// is what decides whether the sky has anything to fly between: a deck has no
// gaps, a tower is mostly gap. Blending them continuously means the transition
// from open air to a wall of cloud happens over kilometres rather than at a line.
float vw_heightGradient(float h, float form) {
  float deck  = vw_remap(h, 0.00, 0.05) * (1.0 - vw_remap(h, 0.08, 0.20));
  float roll  = vw_remap(h, 0.01, 0.13) * (1.0 - vw_remap(h, 0.34, 0.70));
  float tower = vw_remap(h, 0.00, 0.06) * (1.0 - vw_remap(h, 0.60, 1.00));
  float a = mix(deck, roll, clamp(form * 2.0, 0.0, 1.0));
  return mix(a, tower, clamp(form * 2.0 - 1.0, 0.0, 1.0));
}

// Density at a point in cloud space, in [0, uDensityScale].
//
// detailLod is 0 (skip the fine texture entirely) to 1 (full erosion). The
// shadow march and the empty-space search both pass 0, which is safe in one
// direction only: erosion can only remove density, so a zero-detail test never
// reports empty where the full evaluation would report cloud.
//
// soft widens the remap windows, which lowers the contrast of the field. It is a
// rendering approximation and nothing else: a step three hundred metres long
// through a two hundred metre deck either hits or misses, and jittering which
// one it does turns the deck into a field of dots. Lowering contrast with range
// makes a single sample representative of the volume it stands for, which is
// what a properly prefiltered field would give and is roughly a hundred times
// cheaper. Gameplay queries always pass 0, so the CPU field is the sharp one.
float vw_density(vec3 p, float detailLod, float soft, out float h, out vec4 w) {
  h = vw_heightFraction(p);
  w = vw_weather(p);

  vec4 s = texture(uShape, (p + uShapeAdvect) * uPeriodInv.x);

  // The breathing. Two travelling waves whose phase is a pure number that wraps
  // at 1.0 and never grows, riding on two noise channels so the field swells and
  // subsides in patches. A single global sine would make the whole sky pulse as
  // one object, which reads as a shader rather than as weather.
  float breath = sin(VW_TAU * (s.a * 1.7 + uBreath.x)) * uBreath.z
               + sin(VW_TAU * (s.b * 2.3 - uBreath.y)) * uBreath.w;

  float coverage = clamp(w.r * uCoverage.x + uCoverage.y + breath, 0.0, 1.0);
  if (coverage <= 0.001) return 0.0;

  float wfbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  // Fold the erosion stack down to its coarsest octave as the sample gets
  // coarse. The finest Worley channel has 256 m cells; sampled once every 250 m
  // its cell walls survive into the image as flat polygons, and a tessellated
  // cloud is worse than a soft one.
  wfbm = mix(wfbm, s.g, clamp(soft * 1.8, 0.0, 1.0));
  float base = vw_remap(s.r, wfbm * 0.52 - 0.10 - soft, 1.0 + soft);
  float grad = vw_heightGradient(h, w.g);

  float d = vw_remap(base * grad, 1.0 - coverage - soft * 0.5, 1.0 + soft * 0.35);
  if (d <= 0.0) return 0.0;
  d *= coverage;

  if (detailLod > 0.0) {
    vec4 dt = texture(uDetail, (p + uDetailAdvect) * uPeriodInv.y);
    float dfbm = dt.r * 0.625 + dt.g * 0.25 + dt.b * 0.125;
    dfbm = mix(dfbm, dt.a, 0.30);
    // Inverting the erosion pattern with height gets two silhouettes from one
    // texture: wisps and filaments trailing from the base, cauliflower at the
    // top where the cloud is still building.
    float e = mix(1.0 - dfbm, dfbm, clamp(h * 3.0, 0.0, 1.0));
    // Erode the edges, not the core. Erosion is a hard threshold on a 16 m
    // pattern; applied evenly it turns the body of a distant cloud into salt,
    // because the ray is stepping tens of metres and each sample lands on a
    // different side of the threshold. Restricted to where the cloud is already
    // thinning it produces the filaments it is there for and nothing else.
    float k = uErosion.x * detailLod * (1.0 - smoothstep(0.30, 0.85, d)) * (1.0 - soft * 1.5);
    d = vw_remap(d, e * max(k, 0.0), 1.0);
  }

  return d * uDensityScale;
}
`;

// ---------------------------------------------------------------------------
// The march
// ---------------------------------------------------------------------------

export const MARCH_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uDepth;

uniform vec3  uCamPos;       // cloud space: world minus the recentred origin
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uTanHalf;      // tan(fovX/2), tan(fovY/2)
uniform vec2  uClip;         // near, far
uniform vec2  uDepthStride;  // full-res pixels per march pixel
uniform float uJitter;       // in [0,1), a function of simulation time only
uniform float uMaxDist;
uniform vec4  uStepRange;    // fine minimum, growth per metre, maximum, coarse minimum
uniform vec2  uDetailFade;   // range where the fine texture fades out
uniform float uSoftK;        // how fast field contrast falls off with step size
uniform float uTauCap;       // most optical depth one step may cover

uniform vec3  uSunDir;       // toward the sun
uniform vec3  uSunColor;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform vec3  uDeepTint;     // colour of light that has scattered several times
uniform vec3  uHazeColor;
uniform vec2  uPhase;        // forward g, backward g
uniform float uSigmaT;
uniform float uPowder;
uniform float uAerialK;
uniform float uLightStep;
uniform float uLightFar;
uniform vec4  uStormPos[4];  // xyz cloud space, w = 1/radius
uniform vec4  uStormCol[4];  // rgb colour, a intensity

${FIELD_GLSL}

// Henyey-Greenstein, normalised so isotropic scattering returns 1 rather than
// 1/4pi. Keeping the phase function around unity means the light colours below
// are readable as colours instead of as an arbitrary scale factor. This is the
// whole reason a cloud has a silver edge when the light is behind it and a flat
// face when it is not.
float vw_hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5);
}

// Interleaved gradient noise. A blue-noise tile would dither marginally better,
// but it costs a texture fetch per pixel and a load-time generation pass, and
// after the bilateral upsample the difference is not measurable. This is one
// multiply-add.
float vw_ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

const vec3 VW_CONE[8] = vec3[8](
  vec3( 0.20, 0.55,-0.16), vec3(-0.42, 0.11, 0.38),
  vec3( 0.33,-0.28, 0.51), vec3(-0.19,-0.47,-0.30),
  vec3( 0.58, 0.24, 0.20), vec3(-0.06, 0.36,-0.62),
  vec3(-0.51,-0.13, 0.29), vec3( 0.12, 0.62, 0.41));

// Optical depth between a sample and the sun.
float vw_lightMarch(vec3 p, float soft) {
  float depth = 0.0;
  float t = uLightStep * 0.5;
  float step = uLightStep;
  float h; vec4 w;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    // The cone widens with distance so the shadow softens instead of resolving
    // into six hard streaks.
    vec3 q = p + uSunDir * t + VW_CONE[i] * (t * 0.35);
    depth += vw_density(q, 0.0, soft, h, w) * step;
    t += step;
    step *= 1.6;
  }
  // One long sample outside the cone. Without it every cloud is lit as if it
  // were the only cloud in the sky, and a tower standing between the sample and
  // the sun casts nothing — which is exactly the cue the eye uses to judge how
  // far apart two clouds are.
  depth += vw_density(p + uSunDir * uLightFar, 0.0, soft, h, w) * uLightFar * 0.35;
  return depth;
}

vec3 vw_scatterEnergy(float lightDepth, float dens, float cosT) {
  vec3 e = vec3(0.0);
  float a = 1.0, b = 1.0, c = 1.0;
  for (int i = 0; i < MS_OCTAVES; i++) {
    float beer = exp(-lightDepth * uSigmaT * b);
    float ph = mix(vw_hg(cosT, uPhase.x * c), vw_hg(cosT, uPhase.y * c), 0.35);
    // Later octaves stand in for light that has bounced several times. It has
    // lost the sun's warmth to the surrounding blue, which is why the interior
    // of a real cloud is cool while its rim is not.
    e += a * beer * ph * mix(vec3(1.0), uDeepTint, float(i) * (1.0 / float(MS_OCTAVES)));
    a *= 0.36; b *= 0.42; c *= 0.62;
  }
  // The powder term: the dark band on the lit face, where light entering the
  // surface has not yet scattered back out. Only applied looking down-sun,
  // because that is the only direction it is visible from.
  float powder = 1.0 - exp(-dens * 14.0);
  return e * mix(1.0, powder, uPowder * clamp(0.5 - cosT * 0.5, 0.0, 1.0));
}

vec3 vw_storms(vec3 p) {
  vec3 e = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 sc = uStormCol[i];
    if (sc.a <= 0.0) continue;
    vec4 sp = uStormPos[i];
    float r = length(p - sp.xyz);
    // An exponential falloff stands in for a second march out to the discharge.
    // The error is a slightly too-even glow; the cost of being right is another
    // full light march per storm per step.
    e += sc.rgb * sc.a * exp(-r * sp.w);
  }
  return e;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uTanHalf.x) + uCamUp * (ndc.y * uTanHalf.y));

  // Scene depth, point sampled. The composite recomputes this same expression
  // for this same pixel when it weights the sample, so the two passes can never
  // disagree about which surface a cloud sample sits in front of. Averaging the
  // 2x2 instead would be smoother and wrong: there is no surface at the average
  // depth of a silhouette edge.
  float dz = texelFetch(uDepth, ivec2(floor(gl_FragCoord.xy * uDepthStride)), 0).x;
  float tScene = uMaxDist;
  if (dz < 1.0) {
    float ndcZ = dz * 2.0 - 1.0;
    float viewZ = (2.0 * uClip.x * uClip.y) / (uClip.y + uClip.x - ndcZ * (uClip.y - uClip.x));
    tScene = min(uMaxDist, viewZ / max(dot(rd, uCamFwd), 1e-4));
  }

  // The field is a slab. Marching only the part of the ray inside it is worth
  // more than any other optimisation here: looking up out of the layer costs a
  // few hundred metres of march instead of twenty kilometres.
  float t0 = 0.0;
  float t1 = tScene;
  if (abs(rd.y) > 1e-5) {
    float a = (uLayer.x - uCamPos.y) / rd.y;
    float b = (uLayer.y - uCamPos.y) / rd.y;
    t0 = max(t0, min(a, b));
    t1 = min(t1, max(a, b));
  } else if (uCamPos.y < uLayer.x || uCamPos.y > uLayer.y) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  t0 = max(t0, 0.0);
  if (t1 <= t0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float cosT = dot(rd, uSunDir);
  vec3 scatter = vec3(0.0);
  float trans = 1.0;

  // Offset every sample position by up to one step, per pixel. Without this the
  // march produces concentric shells centred on the camera — the single most
  // recognisable artefact of a cheap volumetric, and the one that survives a
  // screenshot. It has to be reapplied after the empty-space search too, or the
  // refined march starts on a quantised grid and the cloud gains flat faces.
  float jit = fract(vw_ign(gl_FragCoord.xy) + uJitter);
  float t = t0 + max(uStepRange.w, t0 * uStepRange.y * 2.5) * jit;

  bool coarse = true;
  int miss = 0;

  for (int i = 0; i < MARCH_STEPS; i++) {
    if (t >= t1 || trans < 0.005) break;

    // A step subtends roughly the same angle wherever it is taken, so a 24 km
    // ray costs about what a 2 km one does and the near field still gets the
    // resolution the eye is actually looking at. The cap stops a very long ray
    // from striding clean over a cloud deck.
    float ds = clamp(t * uStepRange.y, uStepRange.x, uStepRange.z);
    // Contrast falls off with the step length, not with distance as such: it is
    // the ratio of step to feature size that decides whether a sample is
    // representative or a coin toss.
    float soft = clamp((ds - uStepRange.x) * uSoftK, 0.0, 0.55);
    vec3 p = uCamPos + rd * t;
    float h; vec4 w;

    if (coarse) {
      // Empty-space search: long strides on the cheap version of the field,
      // then back up one stride and refine the moment anything is found, so the
      // leading edge of a cloud is never sampled coarsely.
      // The search gets its own, much longer minimum stride. Sharing the fine
      // step's floor meant crossing the first kilometre of empty air cost fifty
      // of the loop's steps, and the ray then ran out of budget somewhere inside
      // the first cloud — which is not a subtle failure: transmittance stops
      // wherever the counter did, and since the start offset is dithered per
      // pixel, the cloud fills with dots.
      float dc = max(uStepRange.w, t * uStepRange.y * 2.5);
      float d = vw_density(p, 0.0, soft, h, w);
      if (d > 0.0) { coarse = false; miss = 0; t = max(t0, t - dc * (1.0 - jit * 0.9)); }
      else t += dc;
      continue;
    }

    float lod = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, t);
    float d = vw_density(p, lod, soft, h, w);

    if (d <= 0.0) {
      // Do not go back to coarse immediately: the inside of a cloud is full of
      // small holes, and bouncing between modes costs more than walking through.
      if (++miss > 4) coarse = true;
      t += ds;
      continue;
    }
    miss = 0;

    // Cap how much optical depth one step is allowed to cover. Left uncapped, a
    // 260 m step through dense cloud goes from clear to opaque in a single
    // sample, and the surface where that happens is a flat polygon whose edges
    // follow the step grid rather than the cloud.
    //
    // The cap relaxes as transmittance falls, and so does the step itself. The
    // leading edge of a cloud is where the eye reads its shape and is worth every
    // sample it takes; two hundred metres further in, nothing is visible and
    // marching it at the same resolution is how a ray runs out of budget before
    // it reaches the far side. Exhausting the loop is not a graceful failure —
    // the march stops at whatever transmittance the counter reached, and because
    // the start offset is dithered per pixel, the cloud fills with stipple.
    float grow = 1.0 + (1.0 - trans) * 2.5;
    ds = min(ds * grow, uTauCap * grow / (uSigmaT * d));

    float lightDepth = vw_lightMarch(p, soft);
    vec3 energy = vw_scatterEnergy(lightDepth, d, cosT);

    // Ambient falls off with depth into the layer, which is what makes the base
    // of a cloud dark and its top bright without any extra sampling.
    vec3 amb = mix(uAmbBottom, uAmbTop, h) * (0.30 + 0.70 * exp(-(1.0 - h) * 1.7));

    vec3 radiance = uSunColor * energy + amb + vw_storms(p);

    float tr = exp(-uSigmaT * d * ds);
    // Analytic integration of the in-scatter across the step, for a medium whose
    // scattering and extinction coefficients are equal. Accumulating
    // radiance*density*ds*trans assumes transmittance is constant over a
    // step where it is not, and bands visibly below a few hundred steps — which
    // is exactly the regime a real-time march lives in.
    vec3 integ = radiance * (1.0 - tr);

    // Air in front of the sample: some of its light is lost on the way here, and
    // some of the air's own scattered light replaces it. This is the term that
    // proves the tower is four kilometres away rather than small and close.
    float aer = 1.0 - exp(-t * uAerialK);
    integ = integ * (1.0 - aer) + uHazeColor * (aer * (1.0 - tr));

    scatter += trans * integ;
    trans *= tr;

    t += ds;
  }

  fragColor = vec4(scatter, clamp(trans, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uCloud;
uniform sampler2D uDepth;

uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uTanHalf;
uniform vec2  uClip;
uniform vec2  uDepthStride;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyGround;
uniform vec3  uHazeColor;
uniform float uAerialK;
uniform float uExposure;
uniform float uDitherPhase;

float vw_ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float vw_linearDist(ivec2 px, float cosA) {
  float dz = texelFetch(uDepth, px, 0).x;
  if (dz >= 1.0) return 1.0e6;
  float ndcZ = dz * 2.0 - 1.0;
  float viewZ = (2.0 * uClip.x * uClip.y) / (uClip.y + uClip.x - ndcZ * (uClip.y - uClip.x));
  return viewZ / max(cosA, 1e-4);
}

vec3 vw_sky(vec3 rd) {
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uSkyGround, uSkyHorizon, smoothstep(0.10, 0.50, t));
  col = mix(col, uSkyZenith, smoothstep(0.50, 0.98, t));
  float mu = max(dot(rd, uSunDir), 0.0);
  // A halo, not a disc. The sun is never seen in this game; what is seen is the
  // part of the sky it happens to be behind. Kept tight on purpose — a wide
  // bloom washes the hue straight back out of the sky it is sitting in.
  col += uSunColor * (pow(mu, 16.0) * 0.045 + pow(mu, 220.0) * 0.30)
       * smoothstep(-0.25, 0.05, rd.y);
  return col;
}

// Narkowicz ACES fit. Applied here rather than by the renderer because the
// clouds are composited in linear HDR against a linear scene buffer, and tone
// mapping has to happen after that blend or the bright rim of a cloud clips
// before it has been mixed with anything.
vec3 vw_aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 vw_srgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uTanHalf.x) + uCamUp * (ndc.y * uTanHalf.y));
  float cosA = max(dot(rd, uCamFwd), 1e-4);

  ivec2 px = ivec2(gl_FragCoord.xy);
  float myDist = vw_linearDist(px, cosA);

  // Depth-aware reconstruction. Nine half-resolution taps on a Gaussian centred
  // at this pixel's exact position in the half-res grid, each weighted by how
  // well the surface it was marched against matches the surface under this
  // pixel.
  //
  // Two failures are being avoided at once. Plain bilinear leaks cloud across
  // the silhouette of anything in front of it, because the half-res pixel
  // genuinely did march past the hull — hence the depth term. And a four-tap
  // filter is too narrow to reconstruct a signal carrying one dithered sample
  // per pixel: it leaves the ray-offset dither visible as a stipple across every
  // soft cloud edge. Nine taps average enough different offsets to put it below
  // the noise floor of the dither at the end of this shader.
  vec2 hf = (vec2(px) + 0.5) / uDepthStride - 0.5;
  ivec2 hc = ivec2(round(hf));
  ivec2 hmax = textureSize(uCloud, 0) - ivec2(1);

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 hp = clamp(hc + ivec2(i, j), ivec2(0), hmax);
      vec2 off = vec2(hp) - hf;
      float sw = exp(-dot(off, off) * 0.9);
      // The exact texel that half-res pixel read, reproduced from the march's
      // own expression rather than assumed to be a factor of two away.
      float d = vw_linearDist(ivec2(floor((vec2(hp) + 0.5) * uDepthStride)), cosA);
      // Tolerance scales with distance: a 5 m disagreement matters at 20 m and
      // is meaningless at 5 km.
      float wgt = sw * exp(-abs(d - myDist) / (0.06 * myDist + 1.0)) + 1e-5;
      sum += texelFetch(uCloud, hp, 0) * wgt;
      wsum += wgt;
    }
  }
  vec4 cloud = sum / wsum;

  vec3 bg;
  if (myDist > 9.0e5) {
    bg = vw_sky(rd);
  } else {
    // Geometry gets the same aerial perspective the clouds get, or the ship and
    // the sky it is against belong to two different worlds.
    float aer = 1.0 - exp(-myDist * uAerialK);
    bg = mix(texture(uScene, vUv).rgb, uHazeColor, aer);
  }

  vec3 col = bg * cloud.a + cloud.rgb;
  col = vw_aces(col * uExposure);
  col = vw_srgb(col);

  // Dither before the 8-bit write. A sky this smooth bands into visible steps
  // otherwise, and the banding is worse than the noise it replaces by a wide
  // margin.
  col += (vw_ign(gl_FragCoord.xy + uDitherPhase) - 0.5) * (1.0 / 255.0);

  fragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Agreement probe
// ---------------------------------------------------------------------------

export const PROBE_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uProbe;   // N x 1 float texture of sample positions

${FIELD_GLSL}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 p = texelFetch(uProbe, px, 0).xyz;
  float h; vec4 w;
  float dDetail = vw_density(p, 1.0, 0.0, h, w);
  float dBase = vw_density(p, 0.0, 0.0, h, w);
  fragColor = vec4(dDetail, dBase, h, w.r);
}
`;

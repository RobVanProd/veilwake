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

// Conservative emptiness test for the empty-space search.
//
// Substitutes the maximum possible value for the shape term and the maximum
// possible swing of the breathing, so it can only ever over-report cloud, never
// miss it. One texture fetch and no shape sample, and — the point of the whole
// thing — it reads a field that varies over hundreds of metres rather than tens,
// which is what makes a long stride safe.
//
// The previous version simply evaluated the full density at a point and strode
// on. It stepped over anything smaller than its stride, and since the stride is
// offset per pixel by the dither, the misses were different in each pixel and
// came out as speckle across the body of every cloud. That failure is invisible
// in a wireframe and obvious in a capture.
bool vw_possible(vec3 p, float soft) {
  vec4 w = vw_weather(p);
  float cov = clamp(w.r * uCoverage.x + uCoverage.y + uBreath.z + uBreath.w, 0.0, 1.0);
  float grad = vw_heightGradient(vw_heightFraction(p), w.g);
  return grad > 1.0 - cov - soft * 0.5;
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
uniform float uCoarseMax;    // longest stride the empty-space search may take

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
uniform vec2  uLightShape;   // shadow march growth per step, cone spread per metre

// God rays. See vw_mist below for what these do and why the pass had none.
uniform vec4  uShaft;        // ambient mist gain, sun shaft gain, phase g, local light gain
uniform vec4  uShaftStep;    // first shadow step, growth, sample stride, stride growth per metre
uniform vec3  uShaftRange;   // fade start, fade end, shadow assumed beyond it

uniform int   uLightCount;
uniform vec4  uLightPos[MAX_LIGHTS];   // xyz cloud space, w = 1/radius
uniform vec4  uLightCol[MAX_LIGHTS];   // rgb premultiplied by intensity, a = shadow strength
uniform vec4  uLightDir[MAX_LIGHTS];   // xyz cone axis, w = cos(outer half-angle)
uniform vec4  uLightPar[MAX_LIGHTS];   // cos(inner), range squared, shadow march reach, spare
uniform float uLightCutoff;            // below this a light is not worth shadowing

uniform sampler2D uBlueNoise;

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

// Per-pixel dither value from the tiling blue-noise mask. See noise.js for why
// this is a texture fetch rather than the usual one-line interleaved gradient
// noise: without temporal accumulation, IGN's mid-frequency structure survives
// the upsample as a visible weave and blue noise does not.
float vw_blue(vec2 p) {
  ivec2 sz = textureSize(uBlueNoise, 0);
  return texelFetch(uBlueNoise, ivec2(p) % sz, 0).r;
}

const vec3 VW_CONE[8] = vec3[8](
  vec3( 0.20, 0.55,-0.16), vec3(-0.42, 0.11, 0.38),
  vec3( 0.33,-0.28, 0.51), vec3(-0.19,-0.47,-0.30),
  vec3( 0.58, 0.24, 0.20), vec3(-0.06, 0.36,-0.62),
  vec3(-0.51,-0.13, 0.29), vec3( 0.12, 0.62, 0.41));

// Optical depth between a sample and the sun.
//
// The cone spread and the growth factor are uniforms rather than literals
// because they are the two numbers that decide whether this pass produces beams
// or a wash, and both wanted finding by eye rather than by argument. A cone of
// 0.35 per metre — what this used to have — is a blur radius of six hundred
// metres at the far end of the march, which is wider than most of the gaps the
// shafts were meant to come through.
float vw_lightMarch(vec3 p, float soft, float jit) {
  float depth = 0.0;
  float step = uLightStep;
  // Dither the start. With the cone narrowed the shadow keeps its edges, and a
  // fixed start puts those edges on a shell at a fixed distance from every
  // sample, which reads as contour lines across the lit face of a cloud.
  float t = step * (0.25 + 0.75 * jit);
  float h; vec4 w;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    // The cone still widens with distance, so a shadow softens with range
    // instead of resolving into a handful of hard streaks — just not so fast
    // that it erases the occluder that cast it.
    vec3 q = p + uSunDir * t + VW_CONE[i & 7] * (t * uLightShape.y);
    depth += vw_density(q, 0.0, soft, h, w) * step;
    t += step;
    step *= uLightShape.x;
  }
  // One long sample outside the cone. Without it every cloud is lit as if it
  // were the only cloud in the sky, and a tower standing between the sample and
  // the sun casts nothing — which is exactly the cue the eye uses to judge how
  // far apart two clouds are.
  depth += vw_density(p + uSunDir * uLightFar, 0.0, soft, h, w) * uLightFar * 0.35;
  return depth;
}

// Optical depth from a point in the clear air toward the sun.
//
// Separate from vw_lightMarch on purpose, and the difference between them is the
// whole reason this pass has shafts and the previous one did not. That march is
// shading the inside of a cloud, where the honest answer is a soft average and
// the cone is there to produce one. This march is shading the gap between
// clouds, where the answer is nearly binary — the sun either reaches this cubic
// metre of vapour or a cloud four kilometres away is standing in the way — and
// the edge between those two states *is* the beam. So: no cone, a start offset
// dithered per pixel instead, and an exponential schedule that spends its first
// samples on the near occluders that carry the edge and still reaches far enough
// to find a tower on the horizon.
float vw_shaftDepth(vec3 p, float jit) {
  float depth = 0.0;
  float step = uShaftStep.x;
  // Only part of the first step is dithered. A full-width offset resolves the
  // near occluder better but puts the whole variance of the first sample into
  // the image as per-pixel noise, and the mist is a smooth surface across which
  // that reads as stipple rather than as grain. The other half of the fix is a
  // short first step: what is not sampled cannot be noisy.
  float t = step * (0.30 + 0.70 * jit);
  float h; vec4 w;
  for (int i = 0; i < SHAFT_STEPS; i++) {
    // Much less contrast rolloff than the view march uses at the same step
    // length. Softening exists to stop a long step from aliasing, and it buys
    // that by blurring the field — which here means blurring the edge of the
    // occluder, and the edge of the occluder is the edge of the beam. The
    // aliasing it would have prevented is dealt with instead by the dithered
    // start above, which turns it into noise at a frequency the half-resolution
    // reconstruction already removes.
    float soft = clamp((step - uStepRange.x) * uSoftK * 0.25, 0.0, 0.26);
    // Later samples stand for hundreds of metres, and a interval of sky that
    // averages to a tenth of a density is not that interval at a tenth density —
    // it is mostly gap with something solid in it. Transmittance is convex, so
    // the mean transmittance of a patchy interval is higher than the
    // transmittance of its mean, and taking a long sample at face value would
    // put the whole sky in shadow. The correction has to be mild, though: it
    // also flattens the difference between a lane and a tube, and that
    // difference is the only thing in this function anyone will see.
    depth += vw_density(p + uSunDir * t, 0.0, soft, h, w) * step / (1.0 + float(i) * 0.28);
    t += step;
    step *= uShaftStep.y;
  }
  return depth;
}

// Phase function for the thin medium, with a floor.
//
// A pure Henyey-Greenstein lobe at the anisotropy that makes a shaft blaze when
// you look toward the light leaves almost nothing at ninety degrees, and a beam
// that cannot be seen from the side is useless as a signature: the player has to
// be able to watch their own lamp throw light into the vapour beside them.
float vw_shaftPhase(float c) {
  return mix(vw_hg(c, uShaft.z), 1.0, 0.28);
}

// Optical depth between a march sample and a local light.
//
// Short and uniformly spaced, unlike the sun's. A lamp is tens to a few hundred
// metres away, so the interval is known and bounded and a handful of even taps
// resolves it; the exponential schedule the sun uses would put most of its
// samples past the light itself.
float vw_localDepth(vec3 p, vec3 dir, float dist, float soft, float jit) {
  float step = dist / float(LIGHT_SHADOW_TAPS);
  float t = step * (0.2 + 0.6 * jit);
  float depth = 0.0;
  float h; vec4 w;
  for (int i = 0; i < LIGHT_SHADOW_TAPS; i++) {
    depth += vw_density(p + dir * t, 0.0, soft, h, w) * step;
    t += step;
  }
  return depth;
}

// In-scattered radiance at a point from the bounded set of local lights.
//
// Everything expensive is gated. A light outside its own range is skipped before
// the square root; a sample outside the cone is skipped before the shadow march;
// and the shadow march only happens where the light's unoccluded contribution is
// above uLightCutoff, which in practice confines it to a few hundred metres
// around each lamp. Along a twenty-kilometre ray that is a handful of the
// hundred-odd sample points, which is the difference between this being
// affordable and not.
vec3 vw_localLights(vec3 p, vec3 rd, float soft, float jit) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    vec4 par = uLightPar[i];
    vec3 dv = lp.xyz - p;
    float r2 = dot(dv, dv);
    if (r2 > par.y) continue;

    float r = sqrt(r2);
    vec3 L = dv * (1.0 / max(r, 1e-4));

    // Inverse square with a soft core. Plain 1/r^2 goes to infinity at the
    // source, and a lamp mounted on the ship is a source the camera can end up
    // inside — one frame of a white screen every time the view clips through the
    // hull.
    float x = r * lp.w;
    float att = 1.0 / (1.0 + x * x);

    // Window it to zero at the range the CPU culled on. Inverse square never
    // reaches zero, so cutting it off at a distance leaves a step, and a step in
    // a medium that is being integrated along the view ray is not a faint edge —
    // it is a hard-edged sphere drawn across the sky, several kilometres wide for
    // a light that was only meant to be a glow. Squared so the slope goes to zero
    // there as well and the seam cannot be found by looking for it.
    float win = clamp(1.0 - r2 / par.y, 0.0, 1.0);
    att *= win * win;

    vec4 dir = uLightDir[i];
    // Omni lights arrive with a cosine below -1 for the outer edge, so this
    // saturates to 1 without needing a branch on the light's kind.
    float cone = smoothstep(dir.w, par.x, dot(-L, dir.xyz));
    if (cone <= 0.0) continue;

    vec4 col = uLightCol[i];
    vec3 e = col.rgb * (att * cone * vw_shaftPhase(dot(L, rd)));

    if (col.a > 0.0 && max(max(e.r, e.g), e.b) > uLightCutoff) {
      float d = vw_localDepth(p, L, min(r, par.z), soft, jit);
      e *= mix(1.0, exp(-uSigmaT * d), col.a);
    }
    sum += e;
  }
  return sum;
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

// In-scatter from the thin medium between the clouds, over the span [a, b] of
// the view ray.
//
// This is the term that makes god rays, and its absence is the whole reason the
// previous pass had none. The density march contributes nothing where density is
// zero — it strides over empty space by design, which is what makes it fast — so
// every shaft the sun casts through a gap fell in a part of the ray that was
// never being integrated. What was left read as a glow, because the surface of a
// cloud was the only place anything was being lit.
//
// The extinction coefficient is uAerialK, the same aerial-perspective constant
// the cloud samples were already using. With a constant radiance this integral
// reproduces the old per-sample distance blend exactly, term for term; the
// shafts are entirely what the radiance *varying along the ray* adds on top of
// it. That equivalence is deliberate — it is what makes it safe to move aerial
// perspective from a blend to an integral without relighting the whole sky.
//
// The shadow is cached and refreshed on its own schedule rather than at every
// step, because the beam structure varies over the size of the gaps that make
// it, which is hundreds of metres, while the density march near a cloud is
// taking steps of thirteen. Refreshing per step would multiply the cost of this
// by an order of magnitude and change nothing anyone could see.
vec3 vw_mist(vec3 rd, float a, float b, float cosT, float jit,
             inout float tau, inout float tNext) {
  float mid = (a + b) * 0.5;
  vec3 p = uCamPos + rd * mid;

  // Shafts are a near and middle distance event, and they have to be, for two
  // separate reasons that happen to want the same thing.
  //
  // The cheap one: past uShaftRange the shadow march's reach is shorter than the
  // error it would be correcting, so it stops being worth taking.
  //
  // The one that decides whether the image is any good: the mist integral over
  // twenty kilometres accumulates roughly nine tenths of whatever radiance it is
  // given, against four hundredths over the five hundred metres a beam beside
  // the ship occupies. Left running to the horizon, direct sunlight in the mist
  // does not make shafts — it makes an even amber sky twenty times brighter than
  // any beam in front of it, which is a dust storm, and the palette this game is
  // supposed to have is cold with warm light as an event. So the sun's
  // contribution fades out with distance and the haze colour carries the far
  // field, which is also what light that has scattered a hundred times actually
  // does: it forgets where it came from.
  float far = smoothstep(uShaftRange.x, uShaftRange.y, mid);
  if (mid >= tNext && far < 1.0) {
    tau = vw_shaftDepth(p, jit);
    tNext = mid + clamp(mid * uShaftStep.w, uShaftStep.z, uShaftStep.z * 9.0);
  }
  float shadow = mix(exp(-uSigmaT * tau), uShaftRange.z, far) * (1.0 - far);

  vec3 rad = uHazeColor * uShaft.x
           + uSunColor * (vw_shaftPhase(cosT) * uShaft.y * shadow);
  // Local lights get their own gain. The mist is thin — uAerialK is a mean free
  // path of eleven kilometres — so the fraction of a lamp's light that scatters
  // toward the camera over the length of its own beam is tiny, and the honest
  // number leaves the beam invisible. The gain says the air between the clouds
  // is a thin extension of the cloud field rather than clean air, which is what
  // it is; the cloud samples below do not get it, because the cloud already has
  // a real scattering coefficient of its own.
  if (uLightCount > 0) rad += vw_localLights(p, rd, 0.0, jit) * uShaft.w;

  return rad * (1.0 - exp(-uAerialK * (b - a)));
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
  float jit = fract(vw_blue(gl_FragCoord.xy) + uJitter);
  // A second offset, decorrelated from the first. Reusing the same one for the
  // shadow marches would tie where a shadow ray starts to where the sample it
  // belongs to sits, which lays a stationary ripple *along* every beam instead
  // of noise across it, and the reconstruction filter cannot remove that.
  float jit2 = fract(jit * 1.61803399 + uJitter * 0.7548776662 + 0.5);

  float t = t0 + clamp(t0 * uStepRange.y * 2.5, uStepRange.w, uCoarseMax) * jit;

  // How far along the ray the mist integral has been carried. The empty-space
  // search rewinds t whenever it finds something, and without this the span it
  // rewinds over would be integrated twice — as a bright bar in front of every
  // cloud the ray enters, in exactly the place the eye is reading the silhouette.
  float tMist = t;
  float shaftTau = 0.0;
  float tShaftNext = -1.0;

  bool coarse = true;
  int miss = 0;

  for (int i = 0; i < MARCH_STEPS; i++) {
    if (t >= t1 || trans < 0.005) break;

    // The mist for everything traversed since the last iteration, at the
    // transmittance reached so far. Doing it here rather than per branch means
    // the rewind, the miss counter and the early exits all cost nothing to get
    // right: every metre of the ray is covered exactly once, whichever path
    // through the loop covered it.
    if (t > tMist) {
      scatter += trans * exp(-uAerialK * tMist)
               * vw_mist(rd, tMist, t, cosT, jit2, shaftTau, tShaftNext);
      tMist = t;
    }

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
      // pixel, the cloud fills with dots. The upper bound is the other half of
      // it: the conservative test is smooth over a few hundred metres and no
      // further, so the stride cannot be allowed past that either.
      float dc = clamp(t * uStepRange.y * 2.5, uStepRange.w, uCoarseMax);
      if (vw_possible(p, soft)) { coarse = false; miss = 0; t = max(t0, t - dc * (1.0 - jit * 0.9)); }
      else t += dc;
      continue;
    }

    float lod = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, t);
    float d = vw_density(p, lod, soft, h, w);

    if (d <= 0.0) {
      // Do not go back to the search immediately: the inside of a cloud is full
      // of small holes, and bouncing between modes costs more than walking
      // through. And when it does hand back, the conservative test has to agree
      // there is nothing here — otherwise the search says "possible", rewinds a
      // stride, and the two trade the ray back and forth over the same hundred
      // metres until the step budget is gone.
      if (++miss > 4) {
        miss = 0;
        if (!vw_possible(p, soft)) coarse = true;
      }
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
    // Hold the step short until the pixel is largely decided, then let it go.
    // The first step into a cloud writes most of that pixel's colour: if it is
    // allowed to cover much optical depth, its exact position matters, and since
    // that position is dithered per pixel the lit face of every cloud picks up a
    // woven stipple. Past about a quarter transmittance nothing further is
    // visible and the step can grow without anyone seeing it.
    float grow = 1.0 + smoothstep(0.75, 0.15, trans) * 3.5;
    ds = min(ds * grow, uTauCap * grow / (uSigmaT * d));

    float lightDepth = vw_lightMarch(p, soft, jit2);
    vec3 energy = vw_scatterEnergy(lightDepth, d, cosT);

    // Ambient falls off with depth into the layer, which is what makes the base
    // of a cloud dark and its top bright without any extra sampling.
    vec3 amb = mix(uAmbBottom, uAmbTop, h) * (0.30 + 0.70 * exp(-(1.0 - h) * 1.7));

    vec3 radiance = uSunColor * energy + amb;
    // No mist gain here: the cloud has a real scattering coefficient, so a lamp
    // inside one is already hundreds of times better lit than the same lamp in
    // the gap beside it. Applying the mist's legibility gain on top would make
    // flying into cloud with the lights on a white-out.
    if (uLightCount > 0) radiance += vw_localLights(p, rd, soft, jit2);

    float tr = exp(-uSigmaT * d * ds);
    // Analytic integration of the in-scatter across the step, for a medium whose
    // scattering and extinction coefficients are equal. Accumulating
    // radiance*density*ds*trans assumes transmittance is constant over a
    // step where it is not, and bands visibly below a few hundred steps — which
    // is exactly the regime a real-time march lives in.
    //
    // Aerial perspective is the exp(-uAerialK * t) factor and nothing else now.
    // It used to be a two-term blend toward uHazeColor applied at each sample;
    // exp(-uAerialK * t) is identically the (1 - aer) that blend used, and the
    // haze half of it has moved into vw_mist, where it is integrated along the
    // ray instead of painted on at the sample — which is what lets it vary, and
    // a haze that varies with what the sun can reach is a shaft.
    scatter += trans * exp(-uAerialK * t) * radiance * (1.0 - tr);
    trans *= tr;

    t += ds;
  }

  // The last span. Without it every ray stops accumulating mist wherever its
  // step counter ran out, and since the counter runs out at a different place in
  // each pixel the sky picks up a mottle that looks like noise in the field.
  float tEnd = min(t, t1);
  if (tEnd > tMist && trans >= 0.005) {
    scatter += trans * exp(-uAerialK * tMist)
             * vw_mist(rd, tMist, tEnd, cosT, jit2, shaftTau, tShaftNext);
  }

  // Only the sky is dimmed by the mist here. Geometry gets its aerial
  // perspective from the composite, which knows the whole distance to the
  // surface rather than only the part inside the layer; dimming it in both
  // places would fog the ship twice.
  float mistT = (dz < 1.0) ? 1.0 : exp(-uAerialK * (tEnd - t0));
  fragColor = vec4(scatter, clamp(trans * mistT, 0.0, 1.0));
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

uniform sampler2D uBlueNoise;

float vw_blue(vec2 p) {
  ivec2 sz = textureSize(uBlueNoise, 0);
  return texelFetch(uBlueNoise, ivec2(p) % sz, 0).r;
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
  col += (fract(vw_blue(gl_FragCoord.xy) + uDitherPhase) - 0.5) * (1.0 / 255.0);

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

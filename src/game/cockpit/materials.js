// The two materials.
//
// --- why these are not MeshStandardMaterial ---------------------------------
//
// This was reconsidered when the world moved from one sun to three luminaries,
// and the answer came out the same way, so the reasoning is worth recording
// rather than repeating.
//
// The brief for this pass asked for MeshStandardMaterial "so the interior shifts
// colour with the sky, do not hardcode a light". The *requirement* there is
// right and the cockpit was failing it: it read `clouds.sun`, which is only ever
// the single dominant luminary, so the interior was lit by whichever one
// happened to be brightest and knew nothing about the other two. That is fixed
// below — the shell is now lit by all three, live, from `clouds.sky.lights`,
// with the ambient taken from the sky the same system composes. Nothing about
// this world's light is hardcoded here any more; the defaults exist only so that
// a cockpit constructed without a CloudSystem still draws.
//
// The *mechanism* asked for is the part that does not survive contact:
//
//   - **Transmittance.** How much of a luminary arrives depends on the cloud
//     between here and it, which only `CloudSystem.transmittance()` can answer.
//     A DirectionalLight cannot know it, so a standard material lights the
//     cockpit brightly while the ship sits inside a thunderhead. This is the
//     single most valuable thing the interior does.
//   - **The canopy shadow.** ART_DIRECTION asks by name for "shadows thrown
//     across the interior by whatever is outside". That is generated below from
//     the frame's own aperture stack, analytically, for no map and no second
//     pass. A standard material would need a shadow map per luminary — three
//     depth passes, three render targets, for a shadow that is already exact.
//   - **Zero variants.** PERFORMANCE_BUDGET §7 makes post-startup compiles a
//     hard rule. These two programs are built once and cannot permute.
//
// So: the requirement is met, the mechanism is not the one named, and this
// comment is here so the next person does not have to rediscover why.
//
// --- the lighting model -----------------------------------------------------
//
//   luminaries  three of them, direction and colour straight off sky.js, each
//               attenuated by its own real line-of-sight transmittance through
//               the medium and cut by the canopy frame's aperture stack
//   ambient     hemisphere between the sky's own top and bottom, about *world*
//               up, so the interior re-lights as the ship rolls
//   bounce      light returning off the vapour immediately ahead — which is what
//               the ship's own lamps do to a cockpit when they are switched on,
//               and is therefore part of the price of using them
//   glow        the instruments lighting their own panel; the only warm thing
//   detail      plating, wear and condensation, procedural — see DETAIL_GLSL
//
// Everything is evaluated in object space, which for these meshes is ship space.
// The cost of that decision is a handful of vector rotations per frame on the
// CPU; the benefit is that the canopy shadow is a handful of constants from
// layout.js rather than a matrix chain.
//
// Zero variants. Both materials are compiled once at construction. Nothing in
// here can produce a shader compile during play — see PERFORMANCE_BUDGET.md §7.

import * as THREE from 'three';
import { apertures, LAYOUT, EYE } from './layout.js';

const f = (n) => {
  const s = n.toFixed(4);
  return s.indexOf('.') < 0 ? `${s}.0` : s;
};

/**
 * The canopy shadow, unrolled from the aperture stack.
 *
 * Generated rather than written so that it cannot disagree with the geometry:
 * both come out of layout.js. This is the same discipline the cloud field uses
 * for its CPU/GPU pair, for the same reason.
 *
 * Softness grows with distance from the aperture, because the source is not a
 * disc — it is a sky diffused through kilometres of vapour, and a hard-edged bar
 * from a light like that would be the tell that this is a trick.
 */
function shadowGLSL() {
  let src = '';
  for (const a of apertures()) {
    src += `
  if (p.z > ${f(a.z)}) {
    float t = (${f(a.z)} - p.z) / lz;
    vec2 q = p.xy + L.xy * t;
    float soft = 0.045 + 0.075 * t;
    sh *= smoothstep(0.0, soft, ${f(a.w)} - abs(q.x))
        * smoothstep(0.0, soft, min(q.y - ${f(a.yb)}, ${f(a.yt)} - q.y));
  }`;
  }
  return src;
}

/**
 * The cheap half of the shadow: is the light in front of the canopy at all.
 *
 * Used for the third luminary only. Kept as its own generator rather than a flag
 * on the one above so that both forms are compiled into the single program and
 * there is still exactly one variant of this material — see PERFORMANCE_BUDGET
 * §7, and the note at the call site for why the third light wants this and not
 * the full stack.
 */
function gateGLSL() {
  return `  return smoothstep(-0.010, -0.090, L.z);`;
}

const SURF_VERT = /* glsl */`
in vec3 aColor;
in vec2 aFlags;

out vec3 vPos;
out vec3 vNormal;
out vec3 vColor;
out vec2 vFlags;

void main() {
  vPos = position;
  vNormal = normal;
  vColor = aColor;
  vFlags = aFlags;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Plating, wear and condensation — procedural, because geometry cannot afford it.
 *
 * The interior is on screen 100% of the time, so every triangle spent here is
 * permanent. These three effects would cost thousands of them and a texture
 * fetch each; they cost eleven ALU instructions and no memory traffic instead.
 *
 * All three are keyed off object space, which for this mesh is ship space, so
 * they are welded to the hull and do not swim when the ship manoeuvres. Keying
 * them off screen space is the obvious cheap version and it looks like dirt on
 * the lens, which is a different and much worse thing.
 */
const DETAIL_GLSL = /* glsl */`
float h21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

/** Smooth value noise. Four hashes, which is the whole budget for mottling. */
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

/**
 * x — plating: a multiplier on albedo, panel by panel.
 * y — wear: bare metal at the plate edges, which is where a hand or a boot
 *     actually takes the paint off. Drives sheen, not colour.
 * z — condensation: a damp film, heaviest at the cold end.
 */
vec3 surfaceDetail(vec3 p, float toMouth, float down) {
  // Plate pitch along the hull. 0.19 m is a real panel for a machine this size —
  // large enough that the seams are countable rather than a moire at distance,
  // small enough that a rib always has two or three plates between it and the
  // next one. At 0.05 the seams alias into grey the moment the ship moves.
  float pz = p.z * (1.0 / 0.19);
  float px = (p.x + p.y * 0.37) * (1.0 / 0.26);

  // Distance to the nearest seam in each axis, in plate units.
  float ez = abs(fract(pz) - 0.5) * 2.0;
  float ex = abs(fract(px) - 0.5) * 2.0;
  float edge = max(ez, ex);

  // The seam itself: a thin darkening, not a black line. A hard seam reads as a
  // texture; a soft one reads as a shadow in a joint, which is what it is.
  float seam = 1.0 - 0.34 * smoothstep(0.88, 1.0, edge);

  // Plate-to-plate variation. Panels on an old machine were replaced at
  // different times and none of them match; without this the plating reads as
  // wallpaper because every cell is identical.
  float pv = h21(vec2(floor(pz), floor(px)));
  float plate = seam * (0.90 + 0.20 * pv);

  // Wear rides the seams and the high-variance plates.
  float wear = smoothstep(0.90, 1.0, edge) * (0.35 + 0.65 * pv);

  // --- condensation -------------------------------------------------------
  //
  // A film, not beads. The first version drew discrete droplets on a 46-per-metre
  // lattice and it was the worst thing that has ever been in this cockpit: at a
  // metre from the eye a 2.2 cm cell subtends about 30 pixels, so the interior
  // came back covered in pale blue confetti. Shrinking the lattice does not fix
  // it either — once a droplet is near pixel-sized it stops being a droplet and
  // becomes sparkle noise that crawls whenever the ship moves, which is worse
  // again because it draws the eye to the frame instead of the window.
  //
  // So it is a smooth damp sheen with two things driving where it collects, both
  // of them the reasons a real canopy frame mists:
  //
  //   toMouth  the cold end. The frame near the aperture has weather on the
  //            other side of it; the bulkhead behind the pilot's head does not.
  //            Cubed, so it is genuinely concentrated at the front rather than
  //            being a wash over everything.
  //   down     it runs downhill and pools on upward-facing surfaces.
  //
  // Mottled with one octave of value noise at roughly a 12 cm scale, which is
  // large enough to never alias and small enough to read as uneven wetting.
  float mottle = vnoise(vec2(p.z, p.x * 0.7 + p.y * 1.3) * 8.4);
  float cold = toMouth * toMouth * toMouth;
  float cond = cold * (0.35 + 0.65 * down) * (0.45 + 0.55 * mottle);

  return vec3(plate, wear, cond);
}
`;

const SURF_FRAG = (shadow, gate) => /* glsl */`
precision highp float;

in vec3 vPos;
in vec3 vNormal;
in vec3 vColor;
in vec2 vFlags;

layout(location = 0) out vec4 fragColor;

// Three luminaries, live from sky.js. Nothing about this world's light is
// written down in here — these are only sized, not valued.
uniform vec3  uLightDir[3];    // toward the light, in ship space
uniform vec3  uLightColor[3];  // linear HDR radiance, already scaled by intensity
uniform float uLightVis[3];    // real transmittance through the medium, 0..1

uniform vec3  uUpLocal;     // world up, in ship space
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform vec3  uBounce;      // light coming back off the vapour ahead
uniform vec3  uEyeLocal;
uniform vec3  uGlowPos;
uniform vec3  uGlowColor;
uniform float uGlowK;
uniform float uDetail;      // master on the procedural surface, for A/B

${DETAIL_GLSL}

/**
 * How much of a light reaches a point inside the tube.
 *
 * The full form: the ray has to clear every aperture in the frame ahead of it.
 * Generated from layout.js so it cannot disagree with the geometry.
 */
float canopyShadow(vec3 p, vec3 L) {
  // The light has to be somewhere ahead for anything to come through a forward
  // canopy at all. Faded rather than switched, so that a ship turning away from
  // the light loses it over a few degrees instead of in one frame.
  float gate = smoothstep(-0.010, -0.090, L.z);
  if (gate <= 0.0) return 0.0;
  float lz = min(L.z, -1e-3);
  float sh = gate;
${shadow}
  return sh;
}

/** The gate alone — the aperture stack skipped. See the call site. */
float canopyGate(vec3 p, vec3 L) {
${gate}
}

void main() {
  vec3 n = normalize(vNormal);
  bool interior = vFlags.x > 0.5;

  // 0 at the pilot's own plane, 1 at the mouth. Drives condensation, and is the
  // one number that says "this end of the cockpit is the cold end".
  float toMouth = clamp((${f(EYE[2])} - vPos.z) / ${f(LAYOUT.mouth)}, 0.0, 1.0);
  // How upward-facing this surface is, in ship space. Condensation pools on the
  // deck and the lower chamfers and runs off the roof, which is the difference
  // between a wet cockpit and a uniformly shiny one.
  float down = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 det = mix(vec3(1.0, 0.0, 0.0), surfaceDetail(vPos, toMouth, down), uDetail);

  vec3 V = normalize(uEyeLocal - vPos);

  // --- the three luminaries ----------------------------------------------
  //
  // Unrolled rather than looped, because the third one is deliberately cheaper
  // than the other two and a loop cannot express that.
  //
  // Lights 0 and 1 (veil and ember) get the full aperture stack: they are the
  // two that are ever bright enough to throw a readable bar across the interior,
  // and that bar sweeping as the ship turns is the whole point of the frame
  // having ribs at all.
  //
  // Light 2 (drown) gets the gate only. That is not a saving taken at random —
  // sky.js states drown's entire job as giving the dark half of the frame a hue,
  // and a light whose purpose is to fill shadow must not itself be cut into
  // shadow, or the shadows go black and hueless and the frame is halfway to grey.
  // Skipping its aperture stack is therefore both cheaper and more correct.
  vec3 key = vec3(0.0);
  vec3 spec = vec3(0.0);

  {
    vec3 L = uLightDir[0];
    float sh = interior ? canopyShadow(vPos, L) : 1.0;
    vec3 e = uLightColor[0] * (uLightVis[0] * sh);
    key += e * max(dot(n, L), 0.0);
    spec += e * pow(max(dot(n, normalize(L + V)), 0.0), 64.0);
  }
  {
    vec3 L = uLightDir[1];
    float sh = interior ? canopyShadow(vPos, L) : 1.0;
    vec3 e = uLightColor[1] * (uLightVis[1] * sh);
    key += e * max(dot(n, L), 0.0);
    spec += e * pow(max(dot(n, normalize(L + V)), 0.0), 64.0);
  }
  {
    vec3 L = uLightDir[2];
    float sh = interior ? canopyGate(vPos, L) : 1.0;
    key += uLightColor[2] * (uLightVis[2] * sh * max(dot(n, L), 0.0));
  }

  float hemi = dot(n, uUpLocal) * 0.5 + 0.5;
  vec3 amb = mix(uAmbBottom, uAmbTop, hemi);

  // Forward-facing surfaces catch what the medium ahead scatters back. Its
  // strength is driven from outside: lamps on, in thick cloud, is bright.
  vec3 bounce = uBounce * max(-n.z, 0.0);

  // The instruments lighting their own panel. Inverse-square with a soft core,
  // so the pods sit in a small pool of warmth and the rest of the interior does
  // not.
  //
  // This is not a decorative term. At this albedo the world's own ambient leaves
  // the interior at single-digit display values — correctly, the sky here is
  // nearly black — so with every luminary behind cloud, *this* is what the
  // cockpit has any shape at all by. Which is the right answer rather than a
  // workaround: it makes the panel the only thing the pilot can see their own
  // machine by.
  vec3 gd = uGlowPos - vPos;
  float gr2 = dot(gd, gd);
  float gl = uGlowK * max(dot(n, gd * inversesqrt(max(gr2, 1e-4))), 0.0) / (gr2 + 0.10);
  vec3 glow = uGlowColor * gl;

  vec3 albedo = vColor * det.x;
  vec3 col = albedo * (key + amb + bounce + glow);

  // Machined edges, and the metal the paint has come off.
  //
  // Measured down by a factor of three from the first pass: at 0.30 the ribs and
  // the mouth lip reached 0.55 linear with the light ahead and came back near
  // 200/255, which put the brightest thing in the frame on the inside of the
  // ship. A sheen is supposed to say "machined", not "lit".
  float sheen = vFlags.y + det.y * 0.22;
  if (sheen > 0.001) col += spec * (sheen * 0.09);

  // Condensation.
  //
  // Water is not a colour, it is a reflection, so this adds no albedo at all —
  // it darkens what is under it slightly, the way a wet surface always is, and
  // returns the difference as a broad specular. Broad (exponent 12) rather than
  // tight, because a film is rough at this scale; the tight lobe is what a bead
  // would give and there are no beads any more.
  //
  // Deliberately weak. In a frame whose median luminance is in the thirties this
  // is worth two or three display values, which is the correct amount for
  // something the player should notice on the third look and never on the first.
  if (det.z > 0.001) {
    float w = det.z * 0.5;
    col *= 1.0 - w * 0.30;
    col += (spec * 0.35 + amb * 0.5) * w;
  }

  fragColor = vec4(col, 1.0);
}
`;

const EMIS_VERT = /* glsl */`
in vec3 aColor;
in vec2 aMeter;

out vec3 vColor;
out vec2 vMeter;

void main() {
  vColor = aColor;
  vMeter = aMeter;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const EMIS_FRAG = /* glsl */`
precision highp float;

in vec3 vColor;
in vec2 vMeter;

layout(location = 0) out vec4 fragColor;

uniform float uGauge[16];
uniform float uGain;
uniform float uOff;

void main() {
  float lit = 1.0;
  float idx = vMeter.x;
  if (idx >= 0.0) {
    float v = uGauge[int(idx + 0.5)];
    // A lamp reports its value as brightness; a bar segment reports whether the
    // value has reached it. Same uniform, same draw call.
    lit = vMeter.y < 0.0 ? v
        : smoothstep(v + 0.025, v - 0.025, vMeter.y);
  }
  // An unlit segment is not absent. Etched glass with nothing behind it still
  // catches the panel light, and a bar whose empty half vanishes reads as a
  // broken instrument rather than as a low reading.
  fragColor = vec4(vColor * (uGain * (uOff + (1.0 - uOff) * lit)), 1.0);
}
`;

/**
 * Structure material. One instance; nothing about it changes shape at runtime.
 */
export function surfaceMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SURF_VERT,
    fragmentShader: SURF_FRAG(shadowGLSL(), gateGLSL()),
    uniforms: {
      // Sized, not valued. Every one of these is overwritten from
      // `clouds.sky.lights` on the first update; they are zero here so that a
      // cockpit built without a CloudSystem is unlit rather than lit by a light
      // that does not exist in this world. The one exception is the directions,
      // which must be unit vectors or the first frame's dot products are NaN.
      uLightDir: {
        value: [
          new THREE.Vector3(0, 0.2, -1).normalize(),
          new THREE.Vector3(0.8, 0.2, -0.6).normalize(),
          new THREE.Vector3(-0.8, 0.3, -0.5).normalize(),
        ],
      },
      uLightColor: {
        value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
      },
      uLightVis: { value: new Float32Array([1, 1, 1]) },

      uUpLocal: { value: new THREE.Vector3(0, 1, 0) },
      uAmbTop: { value: new THREE.Vector3() },
      uAmbBottom: { value: new THREE.Vector3() },
      uBounce: { value: new THREE.Vector3(0, 0, 0) },
      uEyeLocal: { value: new THREE.Vector3(EYE[0], EYE[1], EYE[2]) },
      uGlowPos: { value: new THREE.Vector3(...LAYOUT.glow) },
      uGlowColor: { value: new THREE.Vector3(1.0, 0.44, 0.15) },
      uGlowK: { value: 0.090 },
      uDetail: { value: 1 },
    },
    side: THREE.FrontSide,
    depthWrite: true,
    depthTest: true,
    toneMapped: false,
  });
}

/**
 * Instrument material.
 *
 * `uGain` is the whole brightness budget for the panel and it is deliberately a
 * fraction. The palette pass spent itself removing brightness; an instrument
 * cluster is exactly the kind of thing that puts it straight back. In a frame
 * whose median luminance is in the thirties, a linear value near 0.11 lands
 * around 90/255 after exposure and ACES — plainly readable, and nowhere near
 * the "blazing" threshold the mood metric watches.
 */
export function instrumentMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: EMIS_VERT,
    fragmentShader: EMIS_FRAG,
    uniforms: {
      // Sixteen, not eight. The extra eight are the signature cluster — the six
      // channels the game is actually played on, plus total exposure and the
      // worst channel. See instruments.js; the array is sized here because the
      // shader's declaration has to agree with it and a mismatch is a silent
      // clamp rather than an error.
      uGauge: { value: new Float32Array(16) },
      uGain: { value: 0.115 },
      uOff: { value: 0.14 },
    },
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

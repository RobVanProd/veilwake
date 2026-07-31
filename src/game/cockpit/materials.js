// The two materials.
//
// Both are hand-written rather than MeshStandardMaterial, and the reason is not
// performance — it is that the cockpit has to be lit by *this* world, and this
// world's light is not in the scene graph. The sun's colour lives in
// CLOUD_PALETTE, its direction lives on CloudSystem, and — the part a
// THREE.DirectionalLight could never know — how much of it actually arrives
// depends on the cloud between here and the sun, which only
// CloudSystem.transmittance() can answer. A standard light would light the
// cockpit brightly while the ship sat inside a thunderhead.
//
// So the lighting model is small and explicit:
//
//   sun       direction and colour from the cloud system, attenuated by real
//             line-of-sight transmittance through the medium, and cut by the
//             canopy frame's own aperture stack
//   ambient   hemisphere between the palette's sky and its ground bounce,
//             about *world* up, so the interior re-lights as the ship rolls
//   bounce    light returning off the vapour immediately ahead — which is what
//             the ship's own lamps do to a cockpit when they are switched on,
//             and is therefore part of the price of using them
//   glow      the instruments lighting their own panel; the only warm thing
//
// Everything is evaluated in object space, which for these meshes is ship space.
// The cost of that decision is three vector rotations per frame on the CPU; the
// benefit is that the canopy shadow is a handful of constants from layout.js
// rather than a matrix chain.
//
// Zero variants. Both materials are compiled once at construction. Nothing in
// here can produce a shader compile during play — see PERFORMANCE_BUDGET.md §7.

import * as THREE from 'three';
import { apertures } from './layout.js';

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

const SURF_FRAG = (shadow) => /* glsl */`
precision highp float;

in vec3 vPos;
in vec3 vNormal;
in vec3 vColor;
in vec2 vFlags;

layout(location = 0) out vec4 fragColor;

uniform vec3  uSunLocal;    // toward the sun, in ship space
uniform vec3  uSunColor;    // linear HDR, from CLOUD_PALETTE
uniform float uSunVis;      // real transmittance through the medium, 0..1
uniform vec3  uUpLocal;     // world up, in ship space
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform vec3  uBounce;      // light coming back off the vapour ahead
uniform vec3  uEyeLocal;
uniform vec3  uGlowPos;
uniform vec3  uGlowColor;
uniform float uGlowK;

float canopyShadow(vec3 p, vec3 L) {
  // The sun has to be somewhere ahead for anything to come through a forward
  // canopy at all. Faded rather than switched, so that a ship turning away from
  // the light loses it over a few degrees instead of in one frame.
  float gate = smoothstep(-0.010, -0.090, L.z);
  if (gate <= 0.0) return 0.0;
  float lz = min(L.z, -1e-3);
  float sh = gate;
${shadow}
  return sh;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 L = uSunLocal;

  float sh = vFlags.x > 0.5 ? canopyShadow(vPos, L) : 1.0;
  float ndl = max(dot(n, L), 0.0);
  vec3 key = uSunColor * (uSunVis * sh * ndl);

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
  // the interior at single-digit display values — correctly, the palette's sky
  // is nearly black — so with the sun behind a cloud, *this* is what the cockpit
  // has any shape at all by. Which is the right answer rather than a workaround:
  // it makes the panel the only thing the pilot can see their own machine by.
  vec3 gd = uGlowPos - vPos;
  float gr2 = dot(gd, gd);
  float gl = uGlowK * max(dot(n, gd * inversesqrt(max(gr2, 1e-4))), 0.0) / (gr2 + 0.10);
  vec3 glow = uGlowColor * gl;

  vec3 col = vColor * (key + amb + bounce + glow);

  // Machined edges. Tiny, and only where flagged.
  //
  // Measured down by a factor of three from the first pass: at 0.30 the ribs and
  // the mouth lip reached 0.55 linear with the sun ahead and came back near
  // 200/255, which put the brightest thing in the frame on the inside of the
  // ship. A sheen is supposed to say "machined", not "lit".
  if (vFlags.y > 0.001) {
    vec3 V = normalize(uEyeLocal - vPos);
    vec3 H = normalize(L + V);
    col += uSunColor * (uSunVis * sh * pow(max(dot(n, H), 0.0), 64.0) * vFlags.y * 0.09);
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

uniform float uGauge[8];
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
    fragmentShader: SURF_FRAG(shadowGLSL()),
    uniforms: {
      uSunLocal: { value: new THREE.Vector3(0, 0, -1) },
      uSunColor: { value: new THREE.Vector3(2.55, 2.20, 1.55) },
      uSunVis: { value: 1 },
      uUpLocal: { value: new THREE.Vector3(0, 1, 0) },
      uAmbTop: { value: new THREE.Vector3(0.126, 0.279, 0.540) },
      uAmbBottom: { value: new THREE.Vector3(0.018, 0.040, 0.063) },
      uBounce: { value: new THREE.Vector3(0, 0, 0) },
      uEyeLocal: { value: new THREE.Vector3(0, 0.55, 1.9) },
      uGlowPos: { value: new THREE.Vector3(0, 0.10, 1.05) },
      uGlowColor: { value: new THREE.Vector3(1.0, 0.44, 0.15) },
      uGlowK: { value: 0.090 },
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
      uGauge: { value: new Float32Array(8) },
      uGain: { value: 0.115 },
      uOff: { value: 0.14 },
    },
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

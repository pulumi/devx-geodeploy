import * as THREE from "three";
import { hexToVec3 } from "./globeShader";

// False-color space backdrop, styled to match the globe's own purple/orange
// palette rather than a realistic starfield: a magenta-to-yellow vertical
// gradient with sparse lavender "stars", rendered on the inside of a large
// sphere (BackSide) that encloses the whole scene.
const MAGENTA = "#D6249F";
const YELLOW = "#FFD400";
const LAVENDER = "#C9A8FF";

const VERTEX_SHADER = `
varying vec3 vPos;

void main() {
  // Object-space position on the (large, unit-direction-only-matters) sphere
  // — its normalized direction from the origin is the "sky direction" the
  // fragment shader gradients/stars are keyed off of.
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform vec3 magentaColor;
uniform vec3 yellowColor;
uniform vec3 starColor;
uniform float opacity;

varying vec3 vPos;

// Same ordered 4x4 Bayer dither as the globe shader (globeShader.ts), kept
// in sync deliberately (not imported/shared across GLSL strings — there's no
// GLSL module system here) so the skybox reads as part of the same retro,
// dithered visual language rather than a separate rendering style.
const float DITHER_PIXEL_SCALE = 3.0;
float bayer4x4(vec2 fragCoord) {
  int x = int(mod(fragCoord.x, 4.0));
  int y = int(mod(fragCoord.y, 4.0));
  int idx = x + y * 4;

  if (idx == 0) return 0.0 / 16.0;
  if (idx == 1) return 8.0 / 16.0;
  if (idx == 2) return 2.0 / 16.0;
  if (idx == 3) return 10.0 / 16.0;
  if (idx == 4) return 12.0 / 16.0;
  if (idx == 5) return 4.0 / 16.0;
  if (idx == 6) return 14.0 / 16.0;
  if (idx == 7) return 6.0 / 16.0;
  if (idx == 8) return 3.0 / 16.0;
  if (idx == 9) return 11.0 / 16.0;
  if (idx == 10) return 1.0 / 16.0;
  if (idx == 11) return 9.0 / 16.0;
  if (idx == 12) return 15.0 / 16.0;
  if (idx == 13) return 7.0 / 16.0;
  return 5.0 / 16.0;
}

// Cheap 3D hash for sparse, stable-per-direction "star" points — no texture,
// no lookup table, just noise keyed off a coarsened sky direction so each
// star occupies a small stable patch of sky rather than flickering per pixel.
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vPos);

  // Vertical gradient: magenta at the bottom of the sky, yellow at the top.
  float t = dir.y * 0.5 + 0.5;
  vec3 gradient = mix(magentaColor, yellowColor, t);

  // Sparse lavender stars: a high threshold on coarse 3D noise gives small,
  // stable, widely-spaced points rather than uniform speckle.
  float starNoise = hash3(floor(dir * 300.0));
  float star = step(0.9975, starNoise);
  vec3 color = mix(gradient, starColor, star);

  float levels = 4.0;
  float threshold = bayer4x4(floor(gl_FragCoord.xy / DITHER_PIXEL_SCALE));
  vec3 quantized = floor(color * (levels - 1.0) + threshold) / (levels - 1.0);
  quantized = clamp(quantized, 0.0, 1.0);

  gl_FragColor = vec4(quantized, opacity);
}
`;

const SKYBOX_RADIUS = 1500;
/** Partially translucent per the request — lets the page's own background color bleed through rather than reading as an opaque wall. */
const SKYBOX_OPACITY = 0.7;

/**
 * A large BackSide sphere enclosing the whole scene, rendered with its own
 * false-color (magenta/yellow/lavender) dithered gradient+stars shader. Added
 * to the scene as a sibling of the globe (never part of `globe` itself), so
 * it's invisible to the existing click-to-select raycasting, which only ever
 * calls `intersectObject(globe, true)`.
 */
export function createSkybox(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKYBOX_RADIUS, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      magentaColor: { value: new THREE.Vector3(...hexToVec3(MAGENTA)) },
      yellowColor: { value: new THREE.Vector3(...hexToVec3(YELLOW)) },
      starColor: { value: new THREE.Vector3(...hexToVec3(LAVENDER)) },
      opacity: { value: SKYBOX_OPACITY },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

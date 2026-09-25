import * as THREE from "three";
import { theme } from "./theme";

// Passes UV (for sampling the water-mask/night-lights textures) and a
// view-space normal (for the cheap fixed-direction shading term below)
// straight through.
const VERTEX_SHADER = `
varying vec2 vUv;
varying vec3 vNormal;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform sampler2D nightTexture;
uniform sampler2D waterMaskTexture;
uniform vec3 oceanColor;
uniform vec3 landColor;

varying vec2 vUv;
varying vec3 vNormal;

// Bumped up from 1.0 (one dither cell per screen pixel) per live feedback
// asking for chunkier, more visible dithering.
const float DITHER_PIXEL_SCALE = 3.0;

// Ordered 4x4 Bayer dither, hardcoded (no lookup texture needed). Returns a
// threshold in [0, 1) for the current fragment's screen position. Written as
// an if-chain rather than a dynamically-indexed array for portability across
// GLSL ES 1.00 implementations.
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
  return 5.0 / 16.0; // idx == 15 (and any stray fp/mod edge case)
}

void main() {
  // earth-water.png (bundled with three-globe, same Greenwich-centered
  // equirectangular projection as earth-night.jpg) is a precise black(land)/
  // white(water) mask — this is the PRIMARY land/ocean signal now, not
  // city-light luminance. City-light luminance alone left deserts, rainforest,
  // and other unlit land reading as ocean; a real coastline mask fixes that.
  float waterMaskRaw = texture2D(waterMaskTexture, vUv).r;
  float isLand = 1.0 - smoothstep(0.35, 0.55, waterMaskRaw);

  vec3 baseColor = mix(oceanColor, landColor, isLand);

  // City-light luminance is now only a subtle in-land brightness detail —
  // demoted from "the mask" to "texture on top of the mask" — so continents
  // still read as one bold, solid color rather than scattered lit dots.
  vec3 texel = texture2D(nightTexture, vUv).rgb;
  float cityLight = dot(texel, vec3(0.299, 0.587, 0.114));
  baseColor *= 1.0 + 0.15 * cityLight * isLand;

  // Cheap fixed-direction diffuse term (no scene lights consulted) — enough
  // to give the sphere visible form/shading for a stylized, deliberately
  // non-photorealistic look, without pulling in three-globe's default
  // MeshPhongMaterial lighting pipeline.
  vec3 lightDir = normalize(vec3(0.6, 0.5, 0.7));
  float diffuse = max(dot(normalize(vNormal), lightDir), 0.0);
  float shade = 0.45 + 0.55 * diffuse;
  vec3 litColor = baseColor * shade;

  // Ordered dither: quantize into a handful of visible bands per channel
  // for the retro, deliberately-banded look (not photorealism). Dividing
  // fragCoord by DITHER_PIXEL_SCALE before indexing the 4x4 matrix makes
  // each dither cell cover a DITHER_PIXEL_SCALE x DITHER_PIXEL_SCALE block
  // of real screen pixels instead of one, so the whole pattern reads chunkier
  // ("bigger") without changing the underlying 4x4 Bayer matrix itself.
  float levels = 4.0;
  float threshold = bayer4x4(floor(gl_FragCoord.xy / DITHER_PIXEL_SCALE));
  vec3 quantized = floor(litColor * (levels - 1.0) + threshold) / (levels - 1.0);
  quantized = clamp(quantized, 0.0, 1.0);

  gl_FragColor = vec4(quantized, 1.0);
}
`;

/** Parses a "#rrggbb" hex string into a 0..1 float triple, for handing a theme color to a GLSL `vec3` uniform. */
export function hexToVec3(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`hexToVec3: not a #rrggbb hex color: "${hex}"`);
  const [, r, g, b] = match;
  return [parseInt(r!, 16) / 255, parseInt(g!, 16) / 255, parseInt(b!, 16) / 255];
}

/**
 * Builds the globe's custom material: purple oceans / bold-orange continents,
 * with an inline ordered (Bayer 4x4) dither for a retro, stylized banded
 * look. Ocean/land colors are read straight from `theme.ts` (converted to
 * 0..1 floats) rather than duplicated as separate hand-typed GLSL constants,
 * so the shader and the rest of the UI can never silently drift apart.
 *
 * Passed to three-globe via `.globeMaterial(material)`, which — verified
 * against three-globe's source (`globeMaterial` setter directly assigns
 * `state.globeObj.material`) — overrides its built-in globeImageUrl/
 * bumpImageUrl material pipeline entirely. The globe mesh's UV mapping and
 * its `rotation.y = -Math.PI/2` "face prime meridian" correction are set
 * once at mesh-creation time independent of material, so this custom
 * material inherits the same correct, non-offset texture mapping the old
 * pipeline relied on — no manual UV/longitude offset needed here either.
 */
export function createStyledGlobeMaterial(nightTextureUrl: string, waterMaskTextureUrl: string): THREE.ShaderMaterial {
  const loader = new THREE.TextureLoader();
  const nightTexture = loader.load(nightTextureUrl);
  nightTexture.colorSpace = THREE.SRGBColorSpace;
  const waterMaskTexture = loader.load(waterMaskTextureUrl);

  return new THREE.ShaderMaterial({
    uniforms: {
      nightTexture: { value: nightTexture },
      waterMaskTexture: { value: waterMaskTexture },
      oceanColor: { value: new THREE.Vector3(...hexToVec3(theme.color.primary)) },
      landColor: { value: new THREE.Vector3(...hexToVec3(theme.color.accent)) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
}

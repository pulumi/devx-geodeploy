import * as THREE from "three";

// Matches three-globe's own internal constant (verified against its bundled
// source, dist/three-globe.js) — needed here because label sprites are
// positioned in the globe's own local space (see positionLabelAboveSurface),
// not exposed as a public API by three-globe itself.
export const GLOBE_RADIUS = 100;

/**
 * The exact lat/lng -> local-space xyz formula three-globe uses internally
 * (verified against its bundled source's own `polar2Cartesian`). Label
 * sprites are added as children of the `globe` object itself (see
 * Globe.tsx), so using this same formula keeps them correctly positioned
 * under the globe's own `rotation.y` correction without needing to know
 * about that rotation here at all.
 */
export function polar2Cartesian(lat: number, lng: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

// Same ordered 4x4 Bayer matrix as globeShader.ts/skyboxShader.ts's GLSL
// version, in plain JS here since dithering a label happens once (at canvas
// render time), not per-pixel-per-frame in a shader.
const BAYER_4X4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Threshold in [0, 1) for the given pixel coordinate, tiling the 4x4 matrix. */
export function bayerThreshold(x: number, y: number): number {
  const row = BAYER_4X4[((y % 4) + 4) % 4]!;
  return row[((x % 4) + 4) % 4]! / 16;
}

/** Quantizes a single 0..1 channel value into `levels` bands using an ordered-dither threshold, matching the globe/skybox shaders' `floor(v * (levels-1) + threshold) / (levels-1)` pattern. */
export function quantizeChannel(value01: number, threshold01: number, levels: number): number {
  const q = Math.floor(value01 * (levels - 1) + threshold01) / (levels - 1);
  return Math.min(1, Math.max(0, q));
}

const DITHER_LEVELS = 4;

/** Applies the ordered dither to every opaque-ish pixel of a canvas's current contents, in place. */
function ditherCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3]!;
      if (alpha === 0) continue;
      const threshold = bayerThreshold(x, y);
      for (let c = 0; c < 3; c++) {
        const v01 = data[idx + c]! / 255;
        data[idx + c] = Math.round(quantizeChannel(v01, threshold, DITHER_LEVELS) * 255);
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export interface RegionLabelSpriteOptions {
  title: string;
  /** e.g. CPU utilization, then the live endpoint — each rendered as its own line below the title, same font/color/weight. */
  subtitleLines?: string[];
  titleColor: string;
  subtitleColor: string;
  /** e.g. theme.font.display — the region-name title's font family. */
  titleFontFamily: string;
  /** e.g. theme.font.sans — the subtitle lines' font family (rendered at normal weight, never bold). */
  subtitleFontFamily: string;
}

// Rendered at 4x the final display resolution so the dither quantization
// below still leaves recognizably crisp letterforms rather than mush.
// Wide enough to fit a real load-balancer hostname at the smaller subtitle
// size without this package taking on its own text-wrapping logic — a
// genuinely oversized string is the caller's job to truncate (see Globe.tsx).
const CANVAS_SCALE = 4;
const CANVAS_WIDTH = 380 * CANVAS_SCALE;
const BASE_CANVAS_HEIGHT = 110 * CANVAS_SCALE;
const SUBTITLE_LINE_HEIGHT = 32 * CANVAS_SCALE;
const TITLE_FONT_PX = 46 * CANVAS_SCALE;
const SUBTITLE_FONT_PX = 30 * CANVAS_SCALE;
// Canvas "bold" alone under-delivers for a decorative display font that may
// only ship one real weight (confirmed live: "VT323" is weight-400-only) —
// redrawing the same glyphs at several 1px-radius offsets
// ("poor man's bold"/text stroke via repeated fills) fattens strokes
// reliably regardless of what weights the font file actually provides.
const BOLD_OFFSETS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

async function ensureFontsLoaded(specs: readonly string[]): Promise<void> {
  try {
    await Promise.all(specs.map((spec) => document.fonts.load(spec)));
    await document.fonts.ready;
  } catch {
    // A failed/slow web font load degrades to the browser's fallback font —
    // still legible, just not on-brand — rather than blocking the label.
  }
}

/**
 * A small floating text label — region name, optionally a CPU-utilization
 * subtitle — rendered onto an offscreen canvas, ordered-dithered to match
 * the globe/skybox's retro aesthetic, and used as a `THREE.Sprite` texture
 * (always faces the camera, unlike a plane). Intended to be added as a child
 * of the `ThreeGlobe` instance itself (see Globe.tsx), positioned via
 * `positionLabelAboveSurface`. Async because it waits for the requested web
 * fonts to actually be loaded before drawing — `fillText` silently falls
 * back to a default font if called before a `@font-face` finishes loading,
 * which a synchronous version of this function could never reliably avoid.
 */
export async function createDitheredLabelSprite(opts: RegionLabelSpriteOptions): Promise<THREE.Sprite> {
  const subtitleLines = opts.subtitleLines?.filter((line) => line.length > 0) ?? [];
  const titleFont = `bold ${TITLE_FONT_PX}px ${opts.titleFontFamily}`;
  const subtitleFont = `${SUBTITLE_FONT_PX}px ${opts.subtitleFontFamily}`;
  await ensureFontsLoaded(subtitleLines.length > 0 ? [titleFont, subtitleFont] : [titleFont]);

  const canvasHeight = BASE_CANVAS_HEIGHT + Math.max(0, subtitleLines.length - 1) * SUBTITLE_LINE_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, CANVAS_WIDTH, canvasHeight);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = opts.titleColor;
  ctx.font = titleFont;
  const titleY = subtitleLines.length > 0 ? BASE_CANVAS_HEIGHT * 0.36 : canvasHeight * 0.5;
  for (const [dx, dy] of BOLD_OFFSETS) {
    ctx.fillText(opts.title, CANVAS_WIDTH / 2 + dx, titleY + dy);
  }

  ctx.fillStyle = opts.subtitleColor;
  ctx.font = subtitleFont;
  const firstSubtitleY = BASE_CANVAS_HEIGHT * 0.74;
  subtitleLines.forEach((line, i) => {
    ctx.fillText(line, CANVAS_WIDTH / 2, firstSubtitleY + i * SUBTITLE_LINE_HEIGHT);
  });

  ditherCanvas(ctx, CANVAS_WIDTH, canvasHeight);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);

  // 50% bigger than the original 10, per live feedback — scales the whole
  // rendered label (not just the font-within-canvas), which is the more
  // direct way to make "the text" read bigger on screen. World-units-per-
  // canvas-pixel is held constant (spriteHeight scales *up* with a taller
  // canvas) so the title renders at the same on-screen size regardless of
  // how many subtitle lines got stacked underneath it — a title-only label
  // and a title+2-subtitle-line label read with the same-size region name.
  const aspect = CANVAS_WIDTH / canvasHeight;
  const spriteHeight = 15 * (canvasHeight / BASE_CANVAS_HEIGHT);
  sprite.scale.set(spriteHeight * aspect, spriteHeight, 1);
  return sprite;
}

/** Positions a label sprite a small distance above the globe's surface at the given lat/lng, in the globe's own local space (see the module doc comment on `polar2Cartesian`). */
export function positionLabelAboveSurface(sprite: THREE.Sprite, lat: number, lng: number, altitudeFraction = 0.08): void {
  sprite.position.copy(polar2Cartesian(lat, lng, GLOBE_RADIUS * (1 + altitudeFraction)));
}

/** Disposes a label sprite's texture and material — call on every removal/replacement to avoid leaking GPU resources across data updates. */
export function disposeLabelSprite(sprite: THREE.Sprite): void {
  const material = sprite.material;
  material.map?.dispose();
  material.dispose();
}

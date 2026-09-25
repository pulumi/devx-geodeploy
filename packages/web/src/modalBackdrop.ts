import { bayerThreshold, quantizeChannel } from "./labelSprite";

// Same false-color palette as skyboxShader.ts's 3D backdrop, rasterized as a
// flat 2D image here (a modal overlay is a DOM element, not a WebGL scene)
// so the two "dithered space" surfaces read as the same visual language.
const MAGENTA: readonly [number, number, number] = [0xd6, 0x24, 0x9f];
const YELLOW: readonly [number, number, number] = [0xff, 0xd4, 0x00];
const LAVENDER: readonly [number, number, number] = [0xc9, 0xa8, 0xff];

const DEFAULT_SIZE = 220;
const DITHER_LEVELS = 4;
const STAR_CELL = 3;
const STAR_THRESHOLD = 0.985;

/** Cheap 2D hash, deterministic per coordinate — same role as skyboxShader.ts's `hash3`, just 2D since this is a flat image rather than a sphere direction. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const cachedDataUrlBySize = new Map<number, string>();

/**
 * A tiled, ordered-dithered magenta-to-yellow gradient with sparse lavender
 * "stars" — a flat, DOM-friendly counterpart to the 3D skybox
 * (skyboxShader.ts) for use as a modal backdrop's `background-image`.
 * Generated once per requested `size` and cached (module-level): it's
 * decorative and identical on every call for a given size, so there's no
 * reason to re-render the canvas per modal open. `size` defaults to a small
 * tile (220px) meant to be CSS-tiled behind a modal that only covers part of
 * the screen; a full-viewport surface (see Wizard.tsx, stretched via
 * `background-size: cover`) asks for a larger size instead so it isn't
 * visibly upscaled-blurry once stretched across a whole screen.
 */
export function getDitheredModalBackdropDataUrl(size: number = DEFAULT_SIZE): string {
  const cached = cachedDataUrlBySize.get(size);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const threshold = bayerThreshold(x, y);
      const isStar = hash2(Math.floor(x / STAR_CELL), Math.floor(y / STAR_CELL)) > STAR_THRESHOLD;
      for (let c = 0; c < 3; c++) {
        const gradientValue = MAGENTA[c]! + (YELLOW[c]! - MAGENTA[c]!) * t;
        const value01 = (isStar ? LAVENDER[c]! : gradientValue) / 255;
        data[idx + c] = Math.round(quantizeChannel(value01, threshold, DITHER_LEVELS) * 255);
      }
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  cachedDataUrlBySize.set(size, dataUrl);
  return dataUrl;
}

/**
 * CSS `background` value for a modal overlay: the dithered pattern above,
 * with a dark translucent scrim layered on top so the modal panel in front
 * of it stays the clear focal point.
 */
export function ditheredModalBackdropCss(size: number = DEFAULT_SIZE, scrimAlpha = 0.45): string {
  const url = getDitheredModalBackdropDataUrl(size);
  return `linear-gradient(rgba(0,0,0,${scrimAlpha}), rgba(0,0,0,${scrimAlpha})), url(${url})`;
}

/** Pixel measurements on captures — deterministic, no model. Used by render-valid and, as a guard, before any model call. */
import { decodePngSafe } from "./images.js";

/**
 * Share of pixels that are not backdrop. The previewer's backdrop is a smooth vertical gradient, so every row is near
 * one color; a pixel whose red, green or blue is farther than `tolerance` from that channel's median in its row is
 * something drawn. Each channel is compared on its own: a dark red glove (86, 12, 16) is as bright as the grey
 * backdrop (50, 50, 50) by its channel sum, so a brightness-only test counted it as backdrop. Measured on real
 * captures: an item alone reads 12–23 %, a worn avatar 8–13 %, a pair of thin wrist bands about 1.5 %.
 */
export function subjectRatio(bytes: Uint8Array, tolerance: number): number | undefined {
  const png = decodePngSafe(bytes);
  if (!png || png.depth !== 8 || png.channels < 3) return undefined;
  const { width, height, channels, data } = png;
  const red = new Int32Array(width);
  const green = new Int32Array(width);
  const blue = new Int32Array(width);
  const middle = width >> 1;
  let subject = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      red[x] = data[o];
      green[x] = data[o + 1];
      blue[x] = data[o + 2];
    }
    const r = red.slice().sort()[middle];
    const g = green.slice().sort()[middle];
    const b = blue.slice().sort()[middle];
    for (let x = 0; x < width; x++) {
      if (Math.abs(red[x] - r) > tolerance || Math.abs(green[x] - g) > tolerance || Math.abs(blue[x] - b) > tolerance) subject++;
    }
  }
  return subject / (width * height);
}

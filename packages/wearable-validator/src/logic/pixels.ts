/** Pixel measurements on captures — deterministic, no model. Used by render-valid and, as a guard, before any model call. */
import { decodePngSafe } from "./images.js";

/**
 * Share of pixels that are not backdrop. The render server frames the item in the middle of a smooth vertical
 * gradient, so each row's first pixel is that row's backdrop; a pixel whose red, green or blue sits farther than
 * `tolerance` from it is something drawn. Channels are compared one by one: a dark red glove (86, 12, 16) is about as
 * bright as the grey backdrop (50, 50, 50), so a brightness-only test read it as backdrop.
 * Measured on the job's real captures: an item alone reads 10–38 %, the worn avatar's front view 9–13 %.
 */
export function subjectRatio(bytes: Uint8Array, tolerance: number): number | undefined {
  const png = decodePngSafe(bytes);
  if (!png || png.depth !== 8 || png.channels < 3) return undefined;
  const { width, height, channels, data } = png;
  let subject = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    const [r, g, b] = [data[row], data[row + 1], data[row + 2]];
    for (let x = 0; x < width; x++) {
      const o = row + x * channels;
      if (Math.abs(data[o] - r) > tolerance || Math.abs(data[o + 1] - g) > tolerance || Math.abs(data[o + 2] - b) > tolerance) subject++;
    }
  }
  return subject / (width * height);
}

/** Pixel measurements on captures — deterministic, no model. Used by render-valid and, as a guard, before any model call. */
import { decodePngSafe } from "./images.js";

/**
 * Share of pixels that are not backdrop. The previewer's backdrop is a smooth vertical gradient, so every row is near
 * one color. Each row's backdrop is a real pixel of that row, the one at the median brightness (red + green + blue):
 * a backdrop pixel whenever the item covers less than half the row, as every item near render-valid's floors does.
 * A pixel whose red, green or blue sits farther than `tolerance` from that pixel's own channel is something drawn.
 * - Channels are compared one by one: a dark red glove (86, 12, 16) is about as bright as the grey backdrop
 *   (50, 50, 50), so a brightness-only test read it as backdrop.
 * - The reference is a whole pixel, not a median per channel: once an item covers half a row or more, per-channel
 *   medians can mix a color that is in no pixel, and the backdrop then counted as drawn too. With a real pixel such a
 *   row counts its backdrop instead of the item, never both, so a large item reads roughly; its verdict is unchanged.
 * Measured on the job's real captures: an item alone reads 10–39 %, the worn avatar's front view 9–13 %.
 */
export function subjectRatio(bytes: Uint8Array, tolerance: number): number | undefined {
  const png = decodePngSafe(bytes);
  if (!png || png.depth !== 8 || png.channels < 3) return undefined;
  const { width, height, channels, data } = png;
  const brightness = new Int32Array(width);
  const middle = width >> 1;
  let subject = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      const o = row + x * channels;
      brightness[x] = data[o] + data[o + 1] + data[o + 2];
    }
    // the first pixel of the row at the median brightness: a whole pixel, never a mix of channels
    const reference = row + brightness.indexOf(brightness.slice().sort()[middle]) * channels;
    const [r, g, b] = [data[reference], data[reference + 1], data[reference + 2]];
    for (let x = 0; x < width; x++) {
      const o = row + x * channels;
      if (Math.abs(data[o] - r) > tolerance || Math.abs(data[o + 1] - g) > tolerance || Math.abs(data[o + 2] - b) > tolerance) subject++;
    }
  }
  return subject / (width * height);
}

import { encode } from "fast-png";

/** A previewer-like capture: smooth vertical gradient backdrop with, optionally, a dark block drawn on it. A `mark` tints one corner pixel, so each frame's bytes can differ. */
export function renderedFrame(size: number, subject = true, mark = 0): Uint8Array {
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    const shade = 0x38 + Math.round((y / size) * 0x18);
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      const inside = subject && x > size * 0.3 && x < size * 0.7 && y > size * 0.2 && y < size * 0.8;
      data[o] = data[o + 1] = data[o + 2] = inside ? 0x10 : shade;
    }
  }
  if (mark) [data[0], data[1]] = [mark & 0xff, (mark >> 8) & 0xff];
  return encode({ width: size, height: size, data, channels: 3 });
}

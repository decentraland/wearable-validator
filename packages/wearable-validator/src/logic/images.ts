/** Image dimensions and bounded pixel decoding shared by checks and adapters. */
import { decode as decodePng } from "fast-png";
import { manifest } from "../manifest/index.js";
import { boundedPng } from "./png.js";

export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length > 25 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** The SOF segment, walking markers the way jpeg-js does (fill bytes skipped): precision, height, width. */
function jpegFrame(bytes: Uint8Array): { precision: number; width: number; height: number } | undefined {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) return undefined;
      return { precision: bytes[i + 4], height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + length;
  }
  return undefined;
}

interface PngHeader {
  width: number;
  height: number;
  colorType: number;
}

/** The IHDR fast-png reads: the first one, behind any ancillary chunks; nothing after it is looked at, so trailing bytes do not matter here. */
function pngHeader(bytes: Uint8Array): PngHeader | undefined {
  if (!isPngBytes(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IHDR") {
      if (length !== 13 || offset + 21 > bytes.length) return undefined;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      return width > 0 && height > 0 ? { width, height, colorType: bytes[offset + 17] } : undefined;
    }
    // a critical chunk ahead of IHDR is not a PNG any decoder reads
    if ((bytes[offset + 4] & 32) === 0) return undefined;
    offset += 12 + length;
  }
  return undefined;
}

/**
 * Header dimensions of a PNG or JPEG, read the way the decoders read them; undefined for anything else and for a
 * header that cannot be read. Only a header: whether the whole file decodes is decodePngSafe()'s question.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const dimensions = isPngBytes(bytes) ? pngHeader(bytes) : isJpegBytes(bytes) ? jpegFrame(bytes) : undefined;
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? { width: dimensions.width, height: dimensions.height } : undefined;
}

/** PNG alpha: IHDR color type 4 (gray+alpha) / 6 (RGBA), or palette (3) with a tRNS chunk. */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  const colorType = pngHeader(bytes)?.colorType;
  if (colorType === 4 || colorType === 6) return true;
  if (colorType === 3) {
    for (let i = 8; i + 4 < bytes.length; i++) {
      if (bytes[i] === 0x74 && bytes[i + 1] === 0x52 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x53) return true;
    }
  }
  return false;
}

/** JPEG SOF precision (bits per channel). */
export function jpegPrecision(bytes: Uint8Array): number | undefined {
  return jpegFrame(bytes)?.precision;
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  depth: number;
  data: Uint8Array | Uint16Array;
  palette?: number[][];
  /** tRNS colour key of a grey or RGB PNG: the raw sample values drawn fully transparent. */
  transparency?: Uint16Array;
}

/** Full PNG decode that never throws and never decodes an unreadable header or one above the pixel budget; the data view is always indexable as bytes or 16-bit samples. */
export function decodePngSafe(bytes: Uint8Array, maxPixels = manifest.images.maxDecodePixels): DecodedPng | undefined {
  try {
    const safe = boundedPng(bytes, maxPixels);
    if (!safe) return undefined;
    const img = decodePng(safe);
    // fast-png may hand back a Uint8ClampedArray — view it as Uint8Array (same buffer, same indexing).
    const data = img.data instanceof Uint16Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { width: img.width, height: img.height, channels: img.channels, depth: img.depth, data, palette: img.palette, transparency: img.transparency };
  } catch {
    return undefined;
  }
}

/**
 * 8-bit RGBA pixels of a decoded PNG, whatever its colour type: palette entries with their tRNS alpha, a grey or RGB
 * tRNS colour key, packed 1/2/4-bit rows, 16-bit samples. Undefined for a channel layout no PNG has.
 */
export function pngToRgba(img: DecodedPng): Uint8ClampedArray | undefined {
  const { width, height, channels, depth, data, palette, transparency } = img;
  if (channels < 1 || channels > 4) return undefined;
  // rows below 8 bits are packed; 8 and 16 bits are one array element per sample
  const stride = depth < 8 ? Math.ceil((width * channels * depth) / 8) : width * channels;
  const mask = (1 << Math.min(depth, 8)) - 1;
  const sample = (x: number, y: number, c: number): number => {
    if (depth >= 8) return data[y * stride + x * channels + c];
    const bit = (x * channels + c) * depth;
    return (data[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
  };
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / mask) : v);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (palette && channels === 1) {
        const entry = palette[sample(x, y, 0)] ?? [0, 0, 0];
        out[o] = entry[0]; out[o + 1] = entry[1]; out[o + 2] = entry[2];
        out[o + 3] = entry.length > 3 ? entry[3] : 255;
        continue;
      }
      const r = sample(x, y, 0);
      const g = channels >= 3 ? sample(x, y, 1) : r;
      const b = channels >= 3 ? sample(x, y, 2) : r;
      out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
      if (channels === 2 || channels === 4) out[o + 3] = to8(sample(x, y, channels - 1));
      else out[o + 3] = isColourKey(transparency, channels, r, g, b) ? 0 : 255;
    }
  }
  return out;
}

function isColourKey(key: Uint16Array | undefined, channels: number, r: number, g: number, b: number): boolean {
  if (!key || key.length !== channels) return false;
  return channels === 1 ? key[0] === r : key[0] === r && key[1] === g && key[2] === b;
}

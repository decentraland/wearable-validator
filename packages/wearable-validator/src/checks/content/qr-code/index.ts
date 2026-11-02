/** F-04 QR codes — a scannable code's target can change after review, so any readable one is rejected. */
import jsQR from "jsqr";
import { decode as decodeJpeg } from "jpeg-js";
import { decodePngSafe, imageDimensions, isJpegBytes, isPngBytes, pngToRgba } from "../../../logic/images.js";
import { textureLabel } from "../../../logic/materials.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { POLICY } from "../../docs.js";

const meta: CheckMeta = { name: "qr-code", group: "content", rule: "F-04", docs: POLICY };

interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decode PNG/JPEG bytes to RGBA for jsQR. Undecodable/unsupported images return undefined (texture-format's territory). */
function toRgba(bytes: Uint8Array, maxPixels: number): RgbaImage | undefined {
  try {
    if (isPngBytes(bytes)) {
      const png = decodePngSafe(bytes, maxPixels);
      if (!png) return undefined;
      const data = pngToRgba(png);
      return data ? { data, width: png.width, height: png.height } : undefined;
    }
    if (isJpegBytes(bytes)) {
      // jpeg-js keeps its own bound too, in case its parser reads the frame differently from the header walk
      const jpg = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: Math.ceil(maxPixels / 1_000_000), maxMemoryUsageInMB: Math.ceil((maxPixels * 24) / 1_048_576) });
      return { data: new Uint8ClampedArray(jpg.data.buffer, jpg.data.byteOffset, jpg.data.length), width: jpg.width, height: jpg.height };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface Scan {
  decoded?: string;
  /**
   * A code-shaped detection whose content jsQR could not read: jsQR skips modes it doesn't implement (Structured
   * Append, FNC1), so one symbol of a multi-part code decodes as empty — while phone scanners still open it.
   */
  unreadableCode?: boolean;
  /** Header dimensions of an image the scanner refused to decode — reported, never silently passed. */
  unscanned?: { width: number; height: number };
  /** A PNG or JPEG whose header could not be read: not decoded either, since the decoders may still accept it. */
  unreadable?: boolean;
}

/** Whether jsQR read any content: text or bytes. */
export function hasPayload(qr: { data: string; binaryData: ArrayLike<number> } | null): boolean {
  return qr !== null && (qr.data.length > 0 || qr.binaryData.length > 0);
}

interface Point {
  x: number;
  y: number;
}
interface QrLocation {
  topLeftCorner: Point; topRightCorner: Point; bottomRightCorner: Point; bottomLeftCorner: Point;
  topLeftFinderPattern: Point; topRightFinderPattern: Point; bottomLeftFinderPattern: Point;
}

/**
 * Whether a detection has the shape of a real code: a convex outline inside the image, and finder patterns at a
 * roughly square corner (top-left → top-right and top-left → bottom-left are the code's two sides). On patterned art
 * (stitches, 2D-view atlases) jsQR can "find" a version-1 code with no content whose finder patterns sit a few pixels
 * apart and whose outline folds over itself or leaves the image; such a detection is not a code.
 */
export function plausibleLocation(loc: QrLocation, width: number, height: number, rules: { qrMaxSideRatio: number; qrEdgeMarginRatio: number }): boolean {
  const quad = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
  const turns = quad.map((p, i) => {
    const a = quad[(i + 1) % 4];
    const b = quad[(i + 2) % 4];
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  if (!(turns.every((t) => t > 0) || turns.every((t) => t < 0))) return false;
  const margin = rules.qrEdgeMarginRatio * Math.max(width, height);
  if (quad.some((p) => p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin)) return false;
  const side = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  const across = side(loc.topLeftFinderPattern, loc.topRightFinderPattern);
  const down = side(loc.topLeftFinderPattern, loc.bottomLeftFinderPattern);
  if (Math.min(across, down) < 1) return false;
  return Math.max(across, down) / Math.min(across, down) <= rules.qrMaxSideRatio;
}

/** `budget` is what is left of the item's scan pixels: an image past it is left out, never decoded. */
function scan(bytes: Uint8Array, maxPixels: number, rules: { qrMaxSideRatio: number; qrEdgeMarginRatio: number }, budget = { left: Infinity, skipped: 0 }): Scan {
  if (!isPngBytes(bytes) && !isJpegBytes(bytes)) return {};
  const header = imageDimensions(bytes);
  if (!header) return { unreadable: true };
  if (header.width * header.height > maxPixels) return { unscanned: header };
  if (header.width * header.height > budget.left) {
    budget.skipped++;
    return {};
  }
  budget.left -= header.width * header.height;
  const rgba = toRgba(bytes, maxPixels);
  if (!rgba) return { unreadable: true };
  const qr = jsQR(rgba.data, rgba.width, rgba.height);
  if (!qr) return {};
  if (hasPayload(qr)) return { decoded: qr.data };
  return plausibleLocation(qr.location, rgba.width, rgba.height, rules) ? { unreadableCode: true } : {};
}

const truncate = (text: string): string => (text.length > 64 ? `${text.slice(0, 64)}…` : text);

export const qrCode: CheckDefinition = {
  ...meta,
  title: "QR codes",
  describe: "no decodable QR codes in textures or the thumbnail",
  explanation: "Scannable QR codes are rejected — their target can change after review.",
  fix: "Remove the QR code from the texture or thumbnail — QR targets can change after review, so they're rejected outright.",
  details: "Decodes every texture and the thumbnail to pixels and runs a QR detector over them — any readable code fails, and so does a code-shaped detection whose content the detector can't read (one symbol of a multi-part code). A detection without content whose outline is not code-shaped (images.qrMaxSideRatio, images.qrEdgeMarginRatio) is a pattern in the art and is ignored. Images above the decode budget (images.maxDecodePixels) are reported as unscanned instead of decoded, and so are textures past the item's total (images.maxScanPixels).",
  measure: (ctx) => {
    let images = 0;
    for (const model of ctx.models) images += model.doc.getRoot().listTextures().length;
    if (ctx.files.has(ctx.item.thumbnailPath ?? "thumbnail.png")) images++;
    return `${images} image${images === 1 ? "" : "s"} scanned`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxPixels = ctx.manifest.images.maxDecodePixels;
    const megapixels = Math.round(maxPixels / 100000) / 10;
    const report = (message: string, where: string, decoded: string): void => {
      findings.push(finding(meta, "error", message, { where, data: { decoded: truncate(decoded) } }));
    };
    const unscanned = (label: string, where: string, size: { width: number; height: number }): void => {
      findings.push(finding(meta, "warning", `${label} is ${size.width}×${size.height} — too large to scan for QR codes (the scanner reads images up to ${megapixels} megapixels). Shrink it to the texture and thumbnail size limits so it can be checked.`, {
        where, measured: `${size.width}×${size.height}`, limit: `${megapixels} megapixels`
      }));
    };
    const rules = ctx.manifest.images;
    const unreadableCode = (label: string, where: string): void => {
      findings.push(finding(meta, "error", `${label} contains a QR code whose content this scanner can't read (for example one symbol of a multi-part code) — phone scanners may still open it, and QR codes aren't allowed in published content. Remove it.`, { where, data: { decoded: "" } }));
    };
    const unreadable = (label: string, where: string): void => {
      findings.push(finding(meta, "warning", `${label} has an image header that could not be read, so it was not scanned for QR codes. Re-export it as a standard PNG or JPEG so it can be checked.`, { where }));
    };

    const budget = { left: ctx.manifest.images.maxScanPixels, skipped: 0 };
    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const name = textureLabel(model.doc, tex, i);
        const where = `"${model.mainFile}" › ${name}`;
        const result = scan(img, maxPixels, rules, budget);
        if (result.unscanned) return unscanned(`Texture "${name}" in "${model.mainFile}"`, where, result.unscanned);
        if (result.unreadable) return unreadable(`Texture "${name}" in "${model.mainFile}"`, where);
        if (result.unreadableCode) return unreadableCode(`Texture "${name}" in "${model.mainFile}"`, where);
        if (result.decoded === undefined) return;
        report(
          `Texture "${name}" in "${model.mainFile}" contains a scannable QR code (it decodes to "${truncate(result.decoded)}") — QR codes aren't allowed in published content. Remove it from the texture.`,
          where,
          result.decoded
        );
      });
    }

    if (budget.skipped > 0) {
      const scanMegapixels = Math.round(ctx.manifest.images.maxScanPixels / 100000) / 10;
      findings.push(finding(meta, "warning", `${budget.skipped} texture${budget.skipped === 1 ? " was" : "s were"} not scanned for QR codes — the item's textures add up to more than the ${scanMegapixels} megapixels the scanner reads per item. Remove unused or duplicate textures so every one can be checked.`, {
        measured: `${budget.skipped} unscanned`, limit: `${scanMegapixels} megapixels`
      }));
    }

    const thumbnailPath = ctx.item.thumbnailPath ?? "thumbnail.png";
    const thumbnail = ctx.files.get(thumbnailPath);
    if (thumbnail) {
      const result = scan(thumbnail, maxPixels, rules);
      if (result.unscanned) unscanned(`The thumbnail "${thumbnailPath}"`, thumbnailPath, result.unscanned);
      else if (result.unreadable) unreadable(`The thumbnail "${thumbnailPath}"`, thumbnailPath);
      else if (result.unreadableCode) unreadableCode(`The thumbnail "${thumbnailPath}"`, thumbnailPath);
      else if (result.decoded !== undefined) {
        report(
          `The thumbnail "${thumbnailPath}" contains a scannable QR code (it decodes to "${truncate(result.decoded)}") — QR codes aren't allowed in published content. Remove it from the image.`,
          thumbnailPath,
          result.decoded
        );
      }
    }

    return findings;
  }
};

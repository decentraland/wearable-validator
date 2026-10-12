/** S-06 Thumbnail — the marketplace and backpack composite the preview over their own background, so it must be a transparent PNG within size limits. */
import { mb } from "../../../logic/bytes.js";
import { decodePngSafe, imageDimensions, isPngBytes, pngToRgba, type DecodedPng } from "../../../logic/images.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding, type Severity } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "thumbnail", group: "files", rule: "S-06", docs: `${UPLOADING}#custom-thumbnails` };

export const thumbnail: CheckDefinition = {
  ...meta,
  title: "Thumbnail",
  describe: "square PNG, ≤1 MB, ≤1024px, transparent background",
  explanation: "The thumbnail is the preview image shown in the marketplace and backpack: a square PNG with a transparent background, up to 1024×1024 and 1 MB — the same limits the catalyst enforces.",
  fix: "Export a square PNG of at most 1024×1024 with a transparent background (in Blender: render with Film → Transparent; in Photoshop/GIMP: delete the background layer before saving).",
  details: "Decodes the PNG: format, ≤1 MB and ≤1024×1024 are hard limits; squareness and background transparency are warnings. Transparency is read from any PNG kind (alpha channel, palette with tRNS, colour key) and judged on the outermost ring of pixels: most of the border must be transparent.",
  measure: (ctx) => {
    const bytes = ctx.files.get(ctx.item.thumbnailPath ?? "thumbnail.png");
    if (!bytes) return undefined;
    const dims = imageDimensions(bytes);
    return dims ? `${dims.width}×${dims.height} · ${mb(bytes.length)} MB` : `${mb(bytes.length)} MB`;
  },
  appliesTo: (ctx) => (ctx.inputKind === "glb" || ctx.inputKind === "png-set" ? "bare inputs carry no thumbnail" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const path = ctx.item.thumbnailPath ?? "thumbnail.png";
    const f = (severity: Severity, message: string, extra?: Partial<Finding>) => findings.push(finding(meta, severity, message, { where: path, ...extra }));
    const bytes = ctx.files.get(path);
    if (!bytes) {
      f("error", `Thumbnail "${path}" not found — add a square PNG with a transparent background.`);
      return findings;
    }
    if (!isPngBytes(bytes)) {
      f("error", `Thumbnail "${path}" is not a PNG — export it as a PNG with transparency.`);
      return findings;
    }
    const { thumbnailBytes, thumbnailMaxSize } = ctx.manifest.fileSize;
    if (bytes.length > thumbnailBytes) {
      f("error", `Thumbnail is ${mb(bytes.length)} MB — the maximum is ${mb(thumbnailBytes)} MB. Export it smaller or with stronger PNG compression.`, {
        measured: bytes.length,
        limit: thumbnailBytes
      });
    }
    // the header decides before any pixel is decoded: an oversized thumbnail is never inflated
    const header = imageDimensions(bytes);
    if (header && (header.width > thumbnailMaxSize || header.height > thumbnailMaxSize)) {
      const dims = `${header.width}×${header.height}`;
      f("error", `Thumbnail is ${dims} — no dimension may exceed ${thumbnailMaxSize}px.`, { measured: dims, limit: `${thumbnailMaxSize}×${thumbnailMaxSize}` });
      return findings;
    }
    const img = decodePngSafe(bytes);
    if (!img) {
      f("error", `Thumbnail "${path}" could not be decoded — re-export it as a standard PNG.`);
      return findings;
    }
    if (img.width !== img.height) {
      f("warning", `Thumbnail is ${img.width}×${img.height} — it should be square.`, { measured: `${img.width}×${img.height}` });
    }

    const rgba = hasAlpha(img) ? pngToRgba(img) : undefined;
    if (!rgba) {
      f("warning", "Thumbnail has no transparency — the background should be transparent. Export as a PNG with an alpha channel.");
    } else {
      const { alphaThreshold, minTransparentBorderRatio } = ctx.manifest.thumbnail;
      const ratio = transparentBorderRatio(rgba, img.width, img.height, alphaThreshold);
      if (ratio < minTransparentBorderRatio) {
        f(
          "warning",
          `Thumbnail background does not look transparent (${(ratio * 100).toFixed(0)}% of the border is transparent; at least ${minTransparentBorderRatio * 100}% expected) — remove the background.`,
          { measured: ratio, limit: minTransparentBorderRatio }
        );
      }
    }
    return findings;
  }
};

/** Any PNG kind that can draw a transparent pixel: an alpha channel, palette entries with tRNS alpha, or a colour key. */
function hasAlpha(img: DecodedPng): boolean {
  if (img.channels === 2 || img.channels === 4) return true;
  if (img.palette) return img.palette.some((entry) => entry.length > 3 && entry[3] < 255);
  return img.transparency !== undefined;
}

/** Share of the outermost ring of pixels whose alpha is under the threshold: the background shows there, the item rarely does. */
function transparentBorderRatio(rgba: Uint8ClampedArray, width: number, height: number, alphaThreshold: number): number {
  let ring = 0;
  let transparent = 0;
  for (let y = 0; y < height; y++) {
    const edgeRow = y === 0 || y === height - 1;
    for (let x = 0; x < width; x += edgeRow || x === width - 1 ? 1 : width - 1) {
      ring++;
      if (rgba[(y * width + x) * 4 + 3] < alphaThreshold) transparent++;
    }
  }
  return ring === 0 ? 0 : transparent / ring;
}

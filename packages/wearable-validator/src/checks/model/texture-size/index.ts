/** M-03 Texture size — oversized or non-square textures blow the avatar's memory budget and mip poorly. */
import { imageDimensions, isJpegBytes, isPngBytes, pngHasAlpha } from "../../../logic/images.js";
import { textureLabel } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "texture-size", group: "model", rule: "M-03", docs: `${WEARABLES}#base-materials-and-textures` };

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

function dimensionFindings(where: string, dims: { width: number; height: number }, maxSize: number, facial: boolean): Finding[] {
  const findings: Finding[] = [];
  const measured = `${dims.width}×${dims.height}`;
  if (dims.width > maxSize || dims.height > maxSize) {
    findings.push(
      finding(meta, "error",
        `${where} is ${measured}; the maximum ${facial ? "facial-feature texture" : "texture"} size is ${maxSize}×${maxSize}. Resize it to ${maxSize}×${maxSize} or smaller.`,
        { where, measured, limit: `${maxSize}×${maxSize}` })
    );
  }
  if (dims.width !== dims.height) {
    findings.push(
      finding(meta, "error",
        `${where} is ${measured} — textures must be square. Re-export it with equal width and height.`,
        { where, measured })
    );
  } else if (!isPowerOfTwo(dims.width)) {
    findings.push(
      finding(meta, "warning",
        `${where} is ${measured}, which is not a power of two — GPUs handle 256×256 or 512×512 far better. Resize to the nearest power of two.`,
        { where, measured })
    );
  }
  return findings;
}

const unreadable = (where: string, path: string): Finding =>
  finding(meta, "error", `${where} is a PNG or JPEG whose dimensions cannot be read — the file is damaged or truncated. Re-export the texture.`, { where: path });

function textureSizes(ctx: CheckContext): [number, number][] {
  const sizes: [number, number][] = [];
  for (const model of ctx.models) {
    for (const texture of model.doc.getRoot().listTextures()) {
      const size = texture.getSize();
      if (size) sizes.push([size[0], size[1]]);
    }
  }
  return sizes;
}

export const textureSize: CheckDefinition = {
  ...meta,
  title: "Texture size",
  describe: "textures are square, within the size limit (512², facial features 256² with alpha), and warn when not power-of-two",
  explanation: "Textures must be square and at most 512×512 pixels (256×256 for facial features).",
  fix: "Resize the texture to 512×512 or smaller (256×256 for facial features) and make it square — re-bake or scale it in any image editor.",
  details: "Reads each image's dimensions from its header: over the limit or non-square fails; non-power-of-two dimensions warn.",
  categoryDependent: true,
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    const sizes = textureSizes(ctx);
    if (sizes.length === 0) return "no textures";
    const largest = sizes.reduce((a, b) => (b[0] * b[1] > a[0] * a[1] ? b : a));
    return `largest ${largest[0]}×${largest[1]}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const facial = ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
    const maxSize = facial ? ctx.manifest.textures.facialMaxSize : ctx.manifest.textures.maxSize;

    if (facial) {
      const skip = new Set([ctx.item.thumbnailPath ?? "thumbnail.png", ctx.item.rarityImagePath ?? "image.png"]);
      for (const [path, bytes] of ctx.files) {
        if (skip.has(path) || !isPngBytes(bytes)) continue;
        const dims = imageDimensions(bytes);
        if (!dims) {
          findings.push(unreadable(`"${path}"`, path));
          continue;
        }
        findings.push(...dimensionFindings(`"${path}"`, dims, maxSize, true));
        if (!pngHasAlpha(bytes)) {
          findings.push(
            finding(meta, "error",
              `"${path}" has no alpha channel — facial-feature textures must be PNGs with transparency so they can be masked onto the face. Re-export it as RGBA.`,
              { where: path })
          );
        }
      }
    }

    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const where = `"${model.mainFile}" › ${textureLabel(model.doc, tex, i)}`;
        const dims = imageDimensions(img);
        // other formats are texture-format's finding; a PNG or JPEG whose header cannot be read is never "nothing to measure"
        if (!dims) {
          if (isPngBytes(img) || isJpegBytes(img)) findings.push(unreadable(where, model.mainFile));
          return;
        }
        findings.push(...dimensionFindings(where, dims, maxSize, facial));
      });
    }
    return findings;
  }
};

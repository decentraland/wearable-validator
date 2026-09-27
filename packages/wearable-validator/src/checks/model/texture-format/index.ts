/** M-04 Texture format — the renderer decodes only 8-bit PNG/JPEG; anything else fails to load in-world. */
import { isJpegBytes, isPngBytes, jpegPrecision } from "../../../logic/images.js";
import { textureLabel } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "texture-format", group: "model", rule: "M-04", docs: `${WEARABLES}#base-materials-and-textures` };

export const textureFormat: CheckDefinition = {
  ...meta,
  title: "Texture format",
  describe: "embedded texture images are PNG or JPEG with 8-bit channels",
  explanation: "Textures must be standard 8-bit PNG or JPEG images.",
  fix: "Convert the texture to 8-bit PNG or JPEG. In Blender's image settings pick 'RGBA 8-bit'; 16-bit and exotic formats aren't supported.",
  details: "Sniffs the image magic bytes (PNG/JPEG only) and reads the bit depth from the header — 8-bit required.",
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    const formats = new Set<string>();
    for (const model of ctx.models) {
      for (const texture of model.doc.getRoot().listTextures()) {
        const bytes = texture.getImage();
        if (!bytes) formats.add("Image bytes unavailable");
        else if (isPngBytes(bytes)) formats.add(`PNG · ${bytes[24]}-bit`);
        else if (isJpegBytes(bytes)) {
          const depth = jpegPrecision(bytes);
          formats.add(`JPEG · ${depth === undefined ? "unknown bit depth" : `${depth}-bit`}`);
        } else formats.add(texture.getMimeType() || "Unknown format");
      }
    }
    return formats.size > 0 ? [...formats].join(" / ") : "No embedded textures";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const where = `"${model.mainFile}" › ${textureLabel(model.doc, tex, i)}`;
        if (isPngBytes(img)) {
          const depth = img[24];
          if (depth !== 8) {
            findings.push(
              finding(meta, "error",
                `${where} is a ${depth}-bit PNG; textures must use 8 bits per channel. Re-export it as an 8-bit PNG.`,
                { where, measured: `${depth}-bit`, limit: "8-bit" })
            );
          }
        } else if (isJpegBytes(img)) {
          const precision = jpegPrecision(img);
          if (precision !== undefined && precision !== 8) {
            findings.push(
              finding(meta, "error",
                `${where} is a ${precision}-bit JPEG; textures must use 8 bits per channel. Re-export it as a standard 8-bit JPEG.`,
                { where, measured: `${precision}-bit`, limit: "8-bit" })
            );
          }
        } else {
          const mime = tex.getMimeType() || "an unknown format";
          findings.push(
            finding(meta, "error",
              `${where} is ${mime} — embedded textures must be PNG or JPEG. Convert the image and re-export the GLB.`,
              { where, measured: mime, limit: "image/png or image/jpeg" })
          );
        }
      });
    }
    return findings;
  }
};

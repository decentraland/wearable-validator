/** S-01 File format — the engine loads self-contained models (GLB, or glTF with everything embedded); facial features are PNG sets, so anything else never renders. */
import { isGlb, readSelfContainedGltf } from "../../../logic/gltf.js";
import { decodePngSafe, imageDimensions, isPngBytes } from "../../../logic/images.js";
import { isFacial } from "../../../logic/facial.js";
import { modelFileCandidates } from "../../../logic/model-files.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding, type Severity } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "file-format", group: "files", rule: "S-01", docs: `${WEARABLES}#building-3d-models-for-wearables` };

function facialPngFindings(ctx: CheckContext, path: string): Finding[] {
  const out: Finding[] = [];
  const f = (severity: Severity, message: string, extra?: Partial<Finding>) => out.push(finding(meta, severity, message, { where: path, ...extra }));
  const bytes = ctx.files.get(path);
  if (!bytes) return out; // representations (S-04) reports missing files
  if (!path.endsWith(".png") || !isPngBytes(bytes)) {
    f("error", `"${path}" must be a PNG — facial-feature wearables (${ctx.manifest.facialCategories.join("/")}) are texture-only PNG sets.`);
    return out;
  }
  const max = ctx.manifest.textures.facialMaxSize;
  // the header decides before any pixel is decoded: an oversized texture is never inflated
  const header = imageDimensions(bytes);
  if (header && (header.width > max || header.height > max)) {
    f("error", `"${path}" is ${header.width}×${header.height} — facial-feature textures must be at most ${max}×${max}.`, {
      measured: `${header.width}×${header.height}`,
      limit: `${max}×${max}`
    });
    return out;
  }
  const img = decodePngSafe(bytes);
  if (!img) {
    f("error", `"${path}" is not a decodable PNG — re-export it as a standard PNG file.`);
    return out;
  }
  if (img.width !== img.height) {
    f("error", `"${path}" is ${img.width}×${img.height} — facial-feature textures must be square.`, { measured: `${img.width}×${img.height}` });
  }
  if (img.width > max || img.height > max) {
    f("error", `"${path}" is ${img.width}×${img.height} — facial-feature textures must be at most ${max}×${max}.`, {
      measured: `${img.width}×${img.height}`,
      limit: `${max}×${max}`
    });
  }
  if (img.channels !== 4 && img.channels !== 2) {
    f("error", `"${path}" has no alpha channel — facial-feature textures need transparency. Export as RGBA PNG.`);
  }
  return out;
}

export const fileFormat: CheckDefinition = {
  ...meta,
  title: "File format",
  describe: ".glb (or a self-contained .gltf) for models; facial features are square PNG sets with alpha",
  explanation:
    "Wearables must be exported as a single .glb file (a .gltf works too when everything is embedded in it). Eyebrows, eyes and mouth items are PNG images with a transparent background instead of a 3D model.",
  fix: "In Blender: File → Export → glTF 2.0, format 'glTF Binary (.glb)'. For eyebrows/eyes/mouth, export a square PNG with a transparent background instead.",
  details:
    "Reads the model files' magic bytes — a real GLB starts with the 'glTF' header; a .gltf must embed every buffer and image (data: URIs), since a file it names elsewhere cannot be loaded from the item. Facial-feature categories route to the PNG path instead (square, ≤256×256, alpha channel) and skip every mesh rule.",
  measure: (ctx) => {
    const models = [...ctx.files.keys()].filter((p) => p.endsWith(".glb") || p.endsWith(".gltf"));
    return models.length > 0 ? `${models.length} model file${models.length > 1 ? "s" : ""}` : undefined;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    if (isFacial(ctx)) {
      const paths = new Set<string>();
      const reps = ctx.item.representations ?? [];
      if (reps.length > 0) {
        for (const rep of reps) {
          paths.add(rep.mainFile);
          for (const content of rep.contents) if (content.endsWith(".png")) paths.add(content);
        }
      } else {
        for (const path of ctx.files.keys()) if (path.endsWith(".png")) paths.add(path);
      }
      // The thumbnail and rarity image have their own rules (S-06 / S-05).
      paths.delete(ctx.item.thumbnailPath ?? "thumbnail.png");
      paths.delete(ctx.item.rarityImagePath ?? "image.png");
      for (const path of [...paths].sort()) findings.push(...facialPngFindings(ctx, path));
      return findings;
    }

    const candidates = modelFileCandidates(ctx);
    if (candidates.length === 0) {
      findings.push(finding(meta, "error", "No model file found — the item needs a .glb model (glTF 2.0 binary)."));
      return findings;
    }
    for (const path of candidates) {
      const bytes = ctx.files.get(path);
      if (path.endsWith(".gltf")) {
        // published items use .gltf with everything embedded; one that names other files cannot be loaded from the item
        try {
          if (bytes) readSelfContainedGltf(bytes);
        } catch (error) {
          findings.push(finding(meta, "error", `"${path}" cannot be used: ${error instanceof Error ? error.message : "it is not a valid glTF"}.`, { where: path }));
        }
        continue;
      }
      if (!path.endsWith(".glb")) {
        findings.push(finding(meta, "error", `Model file "${path}" must be a .glb (glTF 2.0 binary).`, { where: path }));
        continue;
      }
      if (bytes && !isGlb(bytes)) {
        findings.push(
          finding(meta, "error", `"${path}" is named .glb but its content is not GLB binary — re-export the model as glTF 2.0 binary.`, { where: path })
        );
      }
    }
    return findings;
  }
};

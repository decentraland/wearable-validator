/** S-05 File size — every byte is downloaded by every avatar nearby, so the whole item has a per-category ceiling (ADR-246). */
import { mb, uniqueBytesTotal } from "../../../logic/bytes.js";
import { fileSizeLimit } from "../../../manifest/index.js";
import { modelFileCandidates } from "../../../logic/model-files.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "file-size", group: "files", rule: "S-05", docs: `${WEARABLES}#building-3d-models-for-wearables` };

export const fileSize: CheckDefinition = {
  ...meta,
  title: "File size",
  describe: "total size within the category limit (thumbnail + rarity image included)",
  explanation: "The full item — model, thumbnail and rarity image included — must stay under 3 MB (9 MB for skins) so it loads fast in-world.",
  fix: "Shrink textures first (biggest win): halve them (1024×1024 → 512×512) and re-bake. Then remove unused geometry and merge duplicated meshes. The thumbnail and rarity image count toward the limit too.",
  details:
    "Sums the actual file bytes — model, thumbnail and rarity image included (ADR-246), each identical file once, as the catalyst counts a deployment by unique content hash — against the per-category ceiling. A wearable's model alone must also stay fileSize.modelHeadroomBytes under that ceiling; an emote has no per-model rule (fileSize.emoteModelHeadroomBytes is 0), only its total.",
  measure: (ctx) => `${mb(uniqueBytesTotal(ctx.files.values()))} MB total`,
  categoryDependent: true,
  run: (ctx) => {
    const findings: Finding[] = [];
    const { fileSize: sizes } = ctx.manifest;
    const limit = fileSizeLimit(ctx.itemType, ctx.category);
    const label = ctx.itemType === "emote" ? "an emote" : ctx.category === "skin" ? "a skin" : "a wearable";

    // the Builder keeps a copy per body shape (male/x.glb, female/x.glb): the catalyst stores and counts one
    const total = uniqueBytesTotal(ctx.files.values());
    if (total > limit) {
      findings.push(
        finding(
          meta,
          "error",
          `The item totals ${mb(total)} MB; the limit for ${label} is ${mb(limit)} MB — the thumbnail and rarity image count toward it (ADR-246). Reduce textures or geometry.`,
          { measured: total, limit, data: { includesThumbnailAndRarityImage: true } }
        )
      );
    }

    // emotes have no per-model rule: the total above, thumbnail included, is the whole limit (curators' decision)
    const headroom = ctx.itemType === "emote" ? sizes.emoteModelHeadroomBytes : sizes.modelHeadroomBytes;
    if (headroom <= 0) return findings;
    const modelLimit = limit - headroom;
    for (const path of modelFileCandidates(ctx)) {
      const bytes = ctx.files.get(path);
      if (bytes && bytes.length > modelLimit) {
        findings.push(
          finding(
            meta,
            "error",
            `The model "${path}" alone is ${mb(bytes.length)} MB; it must stay under ${mb(modelLimit)} MB to leave room for the thumbnail and rarity image.`,
            { where: path, measured: bytes.length, limit: modelLimit }
          )
        );
      }
    }
    return findings;
  }
};

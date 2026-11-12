/** M-06 Material count — each material is a separate draw call; the budget keeps crowded scenes rendering. */
import { countedMaterials, isSkinMaterial } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "material-count", group: "model", rule: "M-06", docs: `${WEARABLES}#base-materials-and-textures` };

export const materialCount: CheckDefinition = {
  ...meta,
  title: "Material count",
  describe: "materials stay within the per-category limit (2 by default, 5 for skins), excluding the skin material",
  explanation: "Models may use at most 2 materials (5 for skins), not counting the skin material (AvatarSkin_MAT).",
  fix: "Merge materials: join meshes and assign one shared material with an atlas texture. At most 2 materials (5 for skins), not counting AvatarSkin_MAT.",
  details: "Counts distinct material objects per representation, excluding colliders and the skin material. Skin is recognised as the engine does: any material whose name contains \"skin\" in any case (materials.skinNameToken), so AvatarSkin_MAT.001, the name Blender gives a copy, is left out too. Repeated names do not merge materials. The displayed count is the largest per-representation count.",
  categoryDependent: true,
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    const count = Math.max(0, ...ctx.models.map(model => countedMaterials(model.doc).filter(material => !isSkinMaterial(material, ctx.manifest.materials.skinNameToken)).length));
    return `${count} material${count === 1 ? "" : "s"}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const limit = ctx.category === "skin" ? ctx.manifest.materials.skin : ctx.manifest.materials.default;
    for (const model of ctx.models) {
      const mats = countedMaterials(model.doc).filter((m) => !isSkinMaterial(m, ctx.manifest.materials.skinNameToken));
      if (mats.length > limit) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" uses ${mats.length} materials; the limit is ${limit}${ctx.category === "skin" ? " for skins" : ""} (${ctx.manifest.materials.avatarSkinMat} excluded). Merge meshes so they share at most ${limit} materials.`,
            { where: model.mainFile, measured: mats.length, limit, data: { materials: mats.map((m) => m.getName()) } })
        );
      }
    }
    return findings;
  }
};

/** M-06 Material count — each material is a separate draw call; the budget keeps crowded scenes rendering. */
import { countedMaterials, isEmissive, isTransparent } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "material-count", group: "model", rule: "M-06", docs: `${WEARABLES}#base-materials-and-textures` };

export const materialCount: CheckDefinition = {
  ...meta,
  title: "Material count",
  describe: "materials stay within the per-category limit (2 by default, 3 with emission or transparency, 5 for skins), excluding AvatarSkin_MAT",
  explanation: "Models may use at most 2 materials, or 3 when one of them is emissive or transparent (5 for skins), not counting AvatarSkin_MAT.",
  fix: "Merge materials: join meshes and assign one shared material with an atlas texture. At most 2 materials, or 3 when one is emissive or transparent (5 for skins), not counting AvatarSkin_MAT.",
  details: "Counts distinct material objects per representation, excluding colliders and AvatarSkin_MAT. Repeated names do not merge materials. A non-skin item gets materials.extraWithEmissionOrAlpha more when any counted material is emissive (an emissive texture or a non-black emissive colour) or transparent (alpha blend or cutout): base, emission and alpha cannot share one material. The displayed count is the largest per-representation count.",
  categoryDependent: true,
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    const count = Math.max(0, ...ctx.models.map(model => countedMaterials(model.doc).filter(material => material.getName() !== ctx.manifest.materials.avatarSkinMat).length));
    return `${count} material${count === 1 ? "" : "s"}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { materials } = ctx.manifest;
    const isSkin = ctx.category === "skin";
    for (const model of ctx.models) {
      const mats = countedMaterials(model.doc).filter((m) => m.getName() !== materials.avatarSkinMat);
      // emission and transparency each need a material of their own, so an item using either gets one more
      const special = !isSkin && mats.some((m) => isEmissive(m) || isTransparent(m));
      const limit = isSkin ? materials.skin : materials.default + (special ? materials.extraWithEmissionOrAlpha : 0);
      if (mats.length > limit) {
        const why = isSkin ? " for skins" : special ? " for an item with emission or transparency" : "";
        const hint = isSkin || special ? "" : ` Up to ${materials.default + materials.extraWithEmissionOrAlpha} are accepted only when one of them is emissive or transparent.`;
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" uses ${mats.length} materials; the limit is ${limit}${why} (${materials.avatarSkinMat} excluded).${hint} Merge meshes so they share at most ${limit} materials.`,
            { where: model.mainFile, measured: mats.length, limit, data: { materials: mats.map((m) => m.getName()) } })
        );
      }
    }
    return findings;
  }
};

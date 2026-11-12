/** M-07 Material & mesh names — AvatarSkin_MAT is the engine's tint target and facial tokens drive face masking. */
import type { Document } from "@gltf-transform/core";
import { colliderNodes } from "../../../logic/gltf.js";
import { countedMaterials, isSkinMaterial } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "material-names", group: "model", rule: "M-07", docs: `${WEARABLES}#base-materials-and-textures` };

/** Mesh names on non-collider nodes (unique). */
function countedMeshNames(doc: Document): string[] {
  const names = new Set<string>();
  const colliders = colliderNodes(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    names.add(mesh.getName());
  }
  return [...names];
}

export const materialNames: CheckDefinition = {
  ...meta,
  title: "Material & mesh names",
  describe: "skin items include an AvatarSkin_MAT material; mesh names don't use reserved facial-feature tokens",
  explanation: "The material that shows skin should be named AvatarSkin_MAT so the engine can tint it to the player's skin color. The engine tints any material with \"skin\" in its name, so a copy such as AvatarSkin_MAT.001 works too.",
  fix: "Rename the material that shows skin to 'AvatarSkin_MAT' so the engine can tint it. Avoid reserved mesh-name patterns (_mouth, _eyebrows, _eyes) on non-facial items.",
  details: "Skin items should carry a skin material, recognised as the engine does: a name containing \"skin\" in any case (materials.skinNameToken). Non-facial mesh names must avoid the reserved facial patterns.",
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    for (const model of ctx.models) {
      for (const material of model.doc.getRoot().listMaterials()) {
        if (isSkinMaterial(material, ctx.manifest.materials.skinNameToken)) return `has ${material.getName()}`;
      }
    }
    return `no ${ctx.manifest.materials.avatarSkinMat}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const skinMat = ctx.manifest.materials.avatarSkinMat;
    const facial = ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
    for (const model of ctx.models) {
      if (ctx.category === "skin" && !countedMaterials(model.doc).some((m) => isSkinMaterial(m, ctx.manifest.materials.skinNameToken))) {
        findings.push(
          finding(meta, "warning",
            `"${model.mainFile}" has no skin material — skin items need one so the engine can tint the body with the player's skin color. Name the body material "${skinMat}" (the engine tints any material with "skin" in its name).`,
            { where: model.mainFile, data: { expected: skinMat } })
        );
      }
      if (!facial) {
        for (const meshName of countedMeshNames(model.doc)) {
          const lower = meshName.toLowerCase();
          for (const pattern of ctx.manifest.materials.forbiddenMeshNamePatterns) {
            if (!lower.includes(pattern.toLowerCase())) continue;
            findings.push(
              finding(meta, "error",
                `Mesh "${meshName}" in "${model.mainFile}" contains the reserved token "${pattern}", which is reserved for facial-feature wearables. Rename the mesh.`,
                { where: `"${model.mainFile}" › ${meshName}`, data: { pattern } })
            );
          }
        }
      }
    }
    return findings;
  }
};

/** M-05 Texture maps — the avatar shader ignores normal/metallic/occlusion maps, so they are dead weight: worth telling the creator, not a reason to reject. */
import type { Material, Texture } from "@gltf-transform/core";
import { countedMaterials } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "texture-maps", group: "model", rule: "M-05", docs: `${WEARABLES}#base-materials-and-textures` };

const IGNORED_MAPS: { label: string; prop: string; get: (m: Material) => Texture | null }[] = [
  { label: "normal map", prop: "normalTexture", get: (m) => m.getNormalTexture() },
  { label: "metallic/roughness map", prop: "metallicRoughnessTexture", get: (m) => m.getMetallicRoughnessTexture() },
  { label: "occlusion map", prop: "occlusionTexture", get: (m) => m.getOcclusionTexture() }
];

export const textureMaps: CheckDefinition = {
  ...meta,
  title: "Texture maps",
  describe: "materials use only base color, emissive and alpha — normal, metallic/roughness and occlusion maps are flagged",
  explanation: "Only base color, emission and alpha textures are supported. Normal, roughness, metallic and occlusion maps are ignored by the avatar renderer: they do not show in-world and only add to the file size. They are a warning, not a rejection.",
  fix: "Remove normal, roughness, metallic and occlusion maps — the avatar renderer ignores them. Bake any detail you want to keep into the base color texture.",
  details: "Walks every material: each normal, metallic-roughness or occlusion map is a warning that names the map. The maps still count toward the texture limit (texture-count) and the item size.",
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    const slots = new Set<string>();
    for (const model of ctx.models) {
      for (const material of model.doc.getRoot().listMaterials()) {
        if (material.getBaseColorTexture()) slots.add("base color");
        if (material.getEmissiveTexture()) slots.add("emission");
        if (material.getNormalTexture()) slots.add("normal");
        if (material.getMetallicRoughnessTexture()) slots.add("metallic-roughness");
        if (material.getOcclusionTexture()) slots.add("occlusion");
      }
    }
    return slots.size > 0 ? [...slots].join(" · ") : "untextured";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      for (const mat of countedMaterials(model.doc)) {
        for (const { label, prop, get } of IGNORED_MAPS) {
          if (!get(mat)) continue;
          findings.push(
            finding(meta, "warning",
              `Material "${mat.getName()}" in "${model.mainFile}" uses a ${label} — Decentraland's avatar shader only supports base color, emissive and alpha, so it will not show in-world and only adds to the file size. Bake the detail into the base color texture and remove the ${label}.`,
              { where: `"${model.mainFile}" › ${mat.getName()}`, data: { map: prop } })
          );
        }
      }
    }
    return findings;
  }
};

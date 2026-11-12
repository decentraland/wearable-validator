/** M-02 Texture count — every extra image is another draw call on an avatar that shares the frame with dozens of others. */
import type { Material, Texture } from "@gltf-transform/core";
import { countedMaterials, isSkinMaterial, textureName } from "../../../logic/materials.js";
import { wearableMaterialsOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "texture-count", group: "model", rule: "M-02", docs: `${WEARABLES}#base-materials-and-textures` };

const TEXTURE_SLOTS: { slot: string; get: (m: Material) => Texture | null }[] = [
  { slot: "baseColorTexture", get: (m) => m.getBaseColorTexture() },
  { slot: "emissiveTexture", get: (m) => m.getEmissiveTexture() },
  { slot: "normalTexture", get: (m) => m.getNormalTexture() },
  { slot: "metallicRoughnessTexture", get: (m) => m.getMetallicRoughnessTexture() },
  { slot: "occlusionTexture", get: (m) => m.getOcclusionTexture() }
];

export const textureCount: CheckDefinition = {
  ...meta,
  title: "Texture count",
  describe: "unique texture images stay within the per-category limit (2 by default, 5 for skins)",
  explanation: "Models may use at most 2 textures (5 for skins).",
  fix: "Bake your textures into a single atlas (Blender: UV → Pack Islands, then bake all materials to one image) so the model references at most 2 images.",
  details: "Counts unique texture images referenced by any material slot. The skin material is left out: any material whose name contains \"skin\", which is how the engine recognises it (AvatarSkin_MAT, or the AvatarSkin_MAT.001 Blender gives a copy).",
  appliesTo: wearableMaterialsOnly,
  measure: (ctx) => {
    let images = 0;
    for (const model of ctx.models) images = Math.max(images, model.doc.getRoot().listTextures().length);
    return `${images} texture${images === 1 ? "" : "s"}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const limit = ctx.category === "skin" ? ctx.manifest.textures.skin : ctx.manifest.textures.default;
    for (const model of ctx.models) {
      const textures = new Set<Texture>();
      for (const mat of countedMaterials(model.doc)) {
        if (isSkinMaterial(mat, ctx.manifest.materials.skinNameToken)) continue;
        for (const { get } of TEXTURE_SLOTS) {
          const tex = get(mat);
          if (tex) textures.add(tex);
        }
      }
      if (textures.size > limit) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" references ${textures.size} texture images; the limit is ${limit}${ctx.category === "skin" ? " for skins" : ""}. Merge the images into a texture atlas so the model uses at most ${limit}.`,
            {
              where: model.mainFile,
              measured: textures.size,
              limit,
              data: { textures: [...textures].map((t, i) => textureName(t, i)) }
            })
        );
      }
    }
    return findings;
  }
};

/** Material/texture bookkeeping shared by the model checks and their measures — colliders never count. */
import type { Document, Material, Texture } from "@gltf-transform/core";
import { colliderNodes } from "./gltf.js";

/**
 * Whether the engine treats a material as the avatar's skin: its name contains the token ("skin", any case), which is how
 * the explorer picks the materials it tints with the player's skin colour (unity-explorer DecentralandMaterialGenerator).
 * So "AvatarSkin_MAT.001", what Blender names a second copy, is skin as much as "AvatarSkin_MAT" is.
 */
export function isSkinMaterial(material: Material, token: string): boolean {
  return material.getName().toLowerCase().includes(token.toLowerCase());
}

/** Materials that count toward limits: used by primitives of meshes on non-collider nodes. */
export function countedMaterials(doc: Document): Material[] {
  const set = new Set<Material>();
  const colliders = colliderNodes(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat) set.add(mat);
    }
  }
  return [...set];
}

export function textureName(tex: Texture, index: number): string {
  return tex.getName() || tex.getURI() || `texture #${index}`;
}

const SLOTS: [string, (material: Material) => Texture | null][] = [
  ["base color", (material) => material.getBaseColorTexture()],
  ["emissive", (material) => material.getEmissiveTexture()],
  ["normal map", (material) => material.getNormalTexture()],
  ["occlusion", (material) => material.getOcclusionTexture()],
  ["metallic-roughness", (material) => material.getMetallicRoughnessTexture()]
];

/**
 * A texture's name for a finding. Exporters often give two images the same name (a copy per material slot), and then
 * two findings read like one said twice: a shared name gets where each image is used, so the creator can find both.
 */
export function textureLabel(doc: Document, tex: Texture, index: number): string {
  const textures = doc.getRoot().listTextures();
  const name = textureName(tex, index);
  const twins = textures.filter((other, i) => textureName(other, i) === name);
  if (twins.length < 2) return name;
  const uses = doc.getRoot().listMaterials().flatMap((material) =>
    SLOTS.filter(([, slot]) => slot(material) === tex).map(([slot]) => `${slot} of ${material.getName() || "an unnamed material"}`)
  );
  return `${name} (${uses.length ? uses.join(", ") : `image ${twins.indexOf(tex) + 1} of ${twins.length}`})`;
}

/**
 * M-15 Representations match — the male and female versions of a body garment have to sit on their bodies the same
 * way, and one model rarely fits both bodies past the hips. Curators send back female-only fit problems (waist height,
 * hip seam, see-through) that the male version doesn't show.
 */
import { BodyShape } from "@dcl/schemas";
import type { Accessor, Document, Skin } from "@gltf-transform/core";
import { colliderNodes, invert, worldMatrices } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding, type ParsedModel } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "representations-match", group: "model", rule: "M-15", docs: `${WEARABLES}#building-3d-models-for-wearables` };

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where a garment sits on its own body: its lowest and highest point as a share of the body (feet 0, head 1). */
interface Extent {
  bottom: number;
  top: number;
}

/** The skeleton a mesh is measured against: the height of the feet and the distance from the feet to the head. */
interface Frame {
  feet: number;
  body: number;
}

function frameOf(head: number | undefined, left: number | undefined, right: number | undefined): Frame | null {
  if (head === undefined || left === undefined || right === undefined) return null;
  const feet = (left + right) / 2;
  const body = head - feet;
  return body > 0 ? { feet, body } : null;
}

/**
 * The skin's feet and head heights at bind time: each joint sits at the inverse of its inverse bind matrix, in the
 * space the skinned mesh's positions are stored in — whatever pose the file was saved in. Null when the skin leaves
 * the head or a foot out of its joints: their node pose would only be right if the file were saved in bind pose.
 */
function bindFrame(skin: Skin): Frame | null {
  const joints = skin.listJoints();
  const inverseBind = skin.getInverseBindMatrices();
  const height = (name: string): number | undefined => {
    const index = joints.findIndex((joint) => joint.getName() === name);
    if (index < 0) return undefined;
    // without inverse bind matrices glTF means identity: every joint bound at the origin
    const bind = inverseBind ? invert(inverseBind.getElement(index, new Array<number>(16).fill(0))) : IDENTITY;
    return bind ? bind[13] : undefined;
  };
  return frameOf(height("Avatar_Head"), height("Avatar_LeftFoot"), height("Avatar_RightFoot"));
}

const heightOf = (m: number[], p: [number, number, number]): number => m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];

/**
 * The garment's extent against the model's own skeleton. A skinned mesh ignores its node: at bind time its vertices
 * are their stored positions, measured against the bones its inverse bind matrices place. A mesh without a skin is
 * measured where its node puts it, against the bones' node pose; its bounding box turns with a rotated node, so it can
 * measure taller than it is. Null when a drawn mesh has no feet and head bones to measure against (its skin leaves
 * them out of its joints, or the file has none): the rest alone could warn on a version that is fine.
 */
export function extentOf(doc: Document): Extent | null {
  const worlds = worldMatrices(doc);
  const nodes = doc.getRoot().listNodes();
  const poseHeight = (name: string): number | undefined => {
    const node = nodes.find((n) => n.getName() === name);
    return node ? worlds.get(node)![13] : undefined;
  };
  const pose = frameOf(poseHeight("Avatar_Head"), poseHeight("Avatar_LeftFoot"), poseHeight("Avatar_RightFoot"));
  const binds = new Map<Skin, Frame | null>();
  const colliders = colliderNodes(doc);
  let bottom = Infinity;
  let top = -Infinity;
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    const skin = node.getSkin();
    if (skin && !binds.has(skin)) binds.set(skin, bindFrame(skin));
    const frame = skin ? binds.get(skin)! : pose;
    const matrix = skin ? IDENTITY : worlds.get(node)!;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position || position.getCount() === 0) continue;
      if (!frame) return null;
      // KHR_mesh_quantization stores normalized integers: decode them to the values the vertices stand for
      const min = position.getMinNormalized([0, 0, 0]);
      const max = position.getMaxNormalized([0, 0, 0]);
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const share = (heightOf(matrix, [x, y, z]) - frame.feet) / frame.body;
        bottom = Math.min(bottom, share);
        top = Math.max(top, share);
      }
    }
  }
  return Number.isFinite(bottom) && Number.isFinite(top) ? { bottom, top } : null;
}

/** The model each body shape wears, when the item declares both. */
function versions(ctx: CheckContext): { male: ParsedModel; female: ParsedModel } | null {
  const male = ctx.models.find((model) => model.bodyShapes.includes(BodyShape.MALE));
  const female = ctx.models.find((model) => model.bodyShapes.includes(BodyShape.FEMALE));
  return male && female ? { male, female } : null;
}

/** Which comparisons the item's category takes part in: separate versions that must line up, one model that must not pass the hips. */
function scopeOf(ctx: CheckContext): { compared: boolean; fitted: boolean } {
  const { comparedCategories, fittedCategories } = ctx.manifest.representations;
  const category = ctx.category;
  return {
    compared: category !== undefined && comparedCategories.includes(category),
    fitted: category !== undefined && fittedCategories.includes(category)
  };
}

/** Every drawn primitive's POSITION accessor, in file order (colliders excluded). */
function positionsOf(doc: Document): Accessor[] {
  const colliders = colliderNodes(doc);
  const positions: Accessor[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (position) positions.push(position);
    }
  }
  return positions;
}

/** The same vertex positions (decoded, if quantized) in every primitive. Counts go first, so most separate versions exit before a vertex is decoded. */
function sameVertices(a: Document, b: Document): boolean {
  const left = positionsOf(a);
  const right = positionsOf(b);
  if (left.length !== right.length || left.some((position, i) => position.getCount() !== right[i].getCount())) return false;
  const x = [0, 0, 0];
  const y = [0, 0, 0];
  return left.every((position, i) => {
    for (let v = 0; v < position.getCount(); v++) {
      position.getElement(v, x);
      right[i].getElement(v, y);
      if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
    }
    return true;
  });
}

/** One model for both bodies, or two versions, with where each sits on its body. */
type Reading = { shared: true; extent: Extent | null } | { shared: false; male: Extent | null; female: Extent | null };

/**
 * One model is the same file, or the same vertices uploaded again under another file or material name that also sit
 * at the same place on their bodies. Identical vertices that a node or the inverse bind matrices place differently
 * (a copy exported at the wrong scale) are two versions, and are compared.
 */
function read({ male, female }: { male: ParsedModel; female: ParsedModel }): Reading {
  if (male.mainFile === female.mainFile) return { shared: true, extent: extentOf(male.doc) };
  const maleExtent = extentOf(male.doc);
  const femaleExtent = extentOf(female.doc);
  const sameExtent = maleExtent?.bottom === femaleExtent?.bottom && maleExtent?.top === femaleExtent?.top;
  return sameExtent && sameVertices(male.doc, female.doc)
    ? { shared: true, extent: maleExtent }
    : { shared: false, male: maleExtent, female: femaleExtent };
}

const share = (n: number): string => `${Math.round(n * 100)}%`;

export const representationsMatch: CheckDefinition = {
  ...meta,
  title: "Male and female versions",
  describe: "an upper- or lower-body garment's male and female versions sit alike on their bodies",
  explanation: "The male and female avatars differ at the chest, waist and hips. The two versions of an upper- or lower-body garment should sit on their bodies the same way: one far higher, lower or bigger than the other is usually a broken export, and curators send back waistbands at the wrong height and broken hip seams. Hair, hats and other items can differ by body on purpose and are not compared.",
  fix: "Wear the item on both base bodies in the Builder preview. If one version is far higher, lower or bigger than the other, fix its scale or position in your 3D tool and upload it again.",
  details: "Only categories in representations.comparedCategories (upper and lower body today) are compared. Measures each version's lowest and highest point against its own skeleton, from the feet (0) to the head bone (1). A skinned mesh is measured in bind pose: its stored (decoded, if quantized) positions against the head and feet bones its inverse bind matrices place, so the pose the file was saved in does not matter. A mesh without a skin is measured by its bounding box where its node puts it; on a rotated node the box turns with it, so it may measure taller than it is. A version with a mesh whose skin leaves the head or feet bones out of its joints is not measured, and nothing is compared. Separate versions whose top or bottom edge differ by more than representations.maxEdgeGap warn. The same file, or the same vertex positions that also sit at the same place on their bodies, count as one model; a copy that a node or bind transform places differently is compared as a separate version. One model for both bodies warns only in representations.fittedCategories, when its bottom edge reaches below representations.hipLine; that list is empty today, so a shared model is not flagged.",
  categoryDependent: true,
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const pair = versions(ctx);
    if (!pair) return "one body shape declared";
    const { compared, fitted } = scopeOf(ctx);
    const skipped = ctx.category ? `${ctx.category} is not compared` : "category unknown";
    if (!compared && !fitted) return skipped;
    const reading = read(pair);
    if (reading.shared) return "one model for both bodies";
    if (!compared) return skipped;
    const { male, female } = reading;
    return male && female ? `male ${share(male.bottom)}–${share(male.top)} · female ${share(female.bottom)}–${share(female.top)} of body height` : "no head and feet bones to measure against";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const pair = versions(ctx);
    const { compared, fitted } = scopeOf(ctx);
    if (!pair || !ctx.category || (!compared && !fitted)) return findings;
    const { maxEdgeGap, hipLine } = ctx.manifest.representations;
    const reading = read(pair);
    if (reading.shared) {
      const { extent } = reading;
      if (!fitted || !extent || extent.bottom >= hipLine) return findings;
      const { male, female } = pair;
      const worn = male.mainFile === female.mainFile
        ? `"${male.mainFile}" is worn by both body shapes and reaches`
        : `"${male.mainFile}" and "${female.mainFile}" are the same model, so both body shapes wear it, and it reaches`;
      findings.push(finding(meta, "warning",
        `${worn} past the hips (down to ${share(extent.bottom)} of body height). The female body differs at the waist and hips; check the fit on BaseFemale, or upload a fitted female version.`,
        { where: female.mainFile, measured: share(extent.bottom), limit: `separate versions below ${share(hipLine)}` }));
      return findings;
    }
    if (!compared) return findings;
    const { male, female } = reading;
    if (!male || !female) return findings;
    const gap = Math.max(Math.abs(male.top - female.top), Math.abs(male.bottom - female.bottom));
    if (gap > maxEdgeGap) {
      findings.push(finding(meta, "warning",
        `The male and female versions sit differently on their bodies: "${pair.male.mainFile}" spans ${share(male.bottom)}–${share(male.top)} of body height, "${pair.female.mainFile}" ${share(female.bottom)}–${share(female.top)}. One may be at the wrong scale or position; compare them on both bodies.`,
        { where: pair.female.mainFile, measured: share(gap), limit: `≤ ${share(maxEdgeGap)}` }));
    }
    return findings;
  }
};

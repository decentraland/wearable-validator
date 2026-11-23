/**
 * Where a model sits on the avatar it was made for, measured against its own skeleton: shared by the checks that
 * compare a garment's height on the body (representations-match, hides-coverage).
 */
import type { Document, Skin } from "@gltf-transform/core";
import { colliderNodes, invert, worldMatrices } from "./gltf.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where a garment sits on its own body: its lowest and highest point as a share of the body (feet 0, head 1). */
export interface Extent {
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

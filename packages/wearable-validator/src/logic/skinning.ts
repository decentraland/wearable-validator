/**
 * Linear blend skinning the way the avatar does it (unity-explorer, ComputeShaderSkinning.compute): the avatar's own
 * bones drive the mesh, and the file supplies weights, joint indices and inverse bind matrices. Bones are matched by
 * their position in the joint list, never by name. Shared by skin-deformation; the rig and the poses come from the manifest.
 */
import type { Accessor, Document, Node, Skin } from "@gltf-transform/core";
import { colliderNodes, IDENTITY, multiply } from "./gltf.js";
import { readVec4 } from "./weights.js";

/** One bone of the avatar's skeleton. The rig lists them in the order the avatar indexes them (AvatarBase.prefab). */
export interface RigBone {
  name: string;
  /** null for the root bone. */
  parent: string | null;
  /** Column-major world matrix of the bone in the avatar's bind pose (a T-pose, metres, +Y up, facing +Z). */
  bindMatrix: number[];
}

export interface PoseRotation {
  bone: string;
  /** Avatar-space axis the bone turns around, at its own joint. */
  axis: "x" | "y" | "z";
  degrees: number;
}

export interface SkinPose {
  name: string;
  /** Creator-facing words for the pose: "with the arms down". */
  label: string;
  /** Applied in order; a bone listed twice turns twice. */
  rotations: PoseRotation[];
}

/** Every skinned vertex of a model in one soup, with the matrices that move it. */
export interface SkinnedGeometry {
  vertexCount: number;
  /** xyz as stored in the file: where the creator sees the vertex. */
  positions: Float32Array;
  /** Four entries per vertex into `joints`, strongest first. */
  influences: Uint32Array;
  /** Four normalized weights per vertex; all zero when the file gives the vertex no weight. */
  weights: Float32Array;
  /** Vertex index triples. */
  triangles: Uint32Array;
  /** Every skin's joint list, once per skin however many meshes use it. */
  joints: SkinJoint[];
  /** Mesh node name per vertex range, for messages. Ranges are in order and do not overlap. */
  parts: { node: string; start: number; end: number }[];
  /** Vertices with weight on a joint index the skin does not have. That weight is dropped here; the client reads whatever bone sits there. */
  invalidInfluences: number;
  /** Skinned mesh nodes that carry no JOINTS_0 or WEIGHTS_0: nothing moves them. */
  unweighted: string[];
}

export interface SkinJoint {
  /** The joint's name in the file. */
  name: string;
  /**
   * The rig bone that moves this joint. The avatar matches bones by position, not by name: joint i of the file's list
   * is moved by bone i of the rig. Joints past the rig's length (spring and helper bones) follow the nearest ancestor
   * that is one of the first. null = nothing moves it.
   */
  carrier: string | null;
  /** The joint's position in its skin's joint list when the rig has a bone there; null for joints past the rig's length. */
  slot: number | null;
  /**
   * Where the avatar's bind pose puts what this joint holds, against where the file has it: rig bind matrix × the
   * file's inverse bind matrix, identity when the file was bound to the avatar's bind pose. A joint past the rig's
   * length has its carrier's: the client keeps its own bind pose and hangs it from that bone. null when nothing carries it.
   */
  bindOffset: number[] | null;
}

/** Reads every skinned triangle mesh (colliders excluded) into one geometry. null when the model has no skinned mesh. */
export function readSkinnedGeometry(doc: Document, rig: RigBone[]): SkinnedGeometry | null {
  const colliders = colliderNodes(doc);
  const joints: SkinJoint[] = [];
  const positions: number[] = [];
  const influences: number[] = [];
  const weights: number[] = [];
  const triangles: number[] = [];
  const parts: SkinnedGeometry["parts"] = [];
  const unweighted: string[] = [];
  const ranges = new Map<Skin, { base: number; count: number }>();
  let invalidInfluences = 0;
  let skinned = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin || colliders.has(node)) continue;
    skinned = true;
    const range = ranges.get(skin) ?? readJoints(skin, rig, joints);
    ranges.set(skin, range);
    const name = node.getName() || mesh.getName() || "mesh";
    const start = positions.length / 3;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const j0 = prim.getAttribute("JOINTS_0");
      const w0 = prim.getAttribute("WEIGHTS_0");
      if (!position) continue;
      if (!j0 || !w0) {
        if (!unweighted.includes(name)) unweighted.push(name);
        continue;
      }
      const j1 = prim.getAttribute("JOINTS_1");
      const w1 = prim.getAttribute("WEIGHTS_1");
      const base = positions.length / 3;
      const count = position.getCount();
      const element = [0, 0, 0];
      const jointElement = [0, 0, 0, 0];
      for (let v = 0; v < count; v++) {
        position.getElement(v, element);
        positions.push(element[0], element[1], element[2]);
        const pairs: [number, number][] = [];
        let invalid = false;
        const collect = (jointsAccessor: Accessor, weightsAccessor: Accessor): void => {
          jointsAccessor.getElement(v, jointElement);
          const w = readVec4(weightsAccessor, v);
          for (let c = 0; c < 4; c++) {
            if (!(w[c] > 0)) continue;
            const joint = jointElement[c];
            if (Number.isInteger(joint) && joint >= 0 && joint < range.count) pairs.push([range.base + joint, w[c]]);
            else invalid = true;
          }
        };
        collect(j0, w0);
        if (j1 && w1) collect(j1, w1);
        if (invalid) invalidInfluences++;
        pairs.sort((a, b) => b[1] - a[1]);
        const kept = pairs.slice(0, 4);
        const sum = kept.reduce((total, pair) => total + pair[1], 0);
        for (let c = 0; c < 4; c++) {
          influences.push(kept[c]?.[0] ?? range.base);
          weights.push(kept[c] && sum > 0 ? kept[c][1] / sum : 0);
        }
      }
      if (prim.getMode() !== 4) continue;
      const indices = prim.getIndices();
      const indexCount = indices ? indices.getCount() : count;
      for (let i = 0; i + 2 < indexCount; i += 3) {
        const a = indices ? indices.getScalar(i) : i;
        const b = indices ? indices.getScalar(i + 1) : i + 1;
        const c = indices ? indices.getScalar(i + 2) : i + 2;
        if (a >= 0 && b >= 0 && c >= 0 && a < count && b < count && c < count) triangles.push(base + a, base + b, base + c);
      }
    }
    const end = positions.length / 3;
    if (end > start) parts.push({ node: name, start, end });
  }
  if (!skinned) return null;
  return {
    vertexCount: positions.length / 3,
    positions: new Float32Array(positions),
    influences: new Uint32Array(influences),
    weights: new Float32Array(weights),
    triangles: new Uint32Array(triangles),
    joints,
    parts,
    invalidInfluences,
    unweighted
  };
}

/** Appends one skin's joints and returns where they sit. */
function readJoints(skin: Skin, rig: RigBone[], joints: SkinJoint[]): { base: number; count: number } {
  const base = joints.length;
  const inverseBind = skin.getInverseBindMatrices();
  const stored = inverseBind ? inverseBind.getCount() : 0;
  const skinJoints = skin.listJoints();
  const slotOf = new Map(skinJoints.slice(0, rig.length).map((joint, index) => [joint, index]));
  skinJoints.forEach((joint, index) => {
    if (index >= rig.length) {
      const slot = rigAncestor(joint, slotOf);
      // the rig slots of this skin are already in `joints`: the first rig.length entries from `base`
      joints.push({ name: joint.getName(), carrier: slot === null ? null : rig[slot].name, slot: null, bindOffset: slot === null ? null : joints[base + slot].bindOffset });
      return;
    }
    // a joint the accessor has no matrix for, or an unreadable one, is bound at the origin, as glTF reads a skin without matrices
    const read = index < stored ? inverseBind!.getElement(index, new Array<number>(16)) : IDENTITY;
    const inverse = read.every((value) => Number.isFinite(value)) ? read : IDENTITY;
    joints.push({ name: joint.getName(), carrier: rig[index].name, slot: index, bindOffset: multiply(rig[index].bindMatrix, inverse) });
  });
  return { base, count: skinJoints.length };
}

function rigAncestor(joint: Node, slotOf: Map<Node, number>): number | null {
  for (let parent = joint.getParentNode(); parent; parent = parent.getParentNode()) {
    const slot = slotOf.get(parent);
    if (slot !== undefined) return slot;
  }
  return null;
}

/**
 * How far each rig bone moves the geometry it carries in a pose: one avatar-space matrix per bone, identity in the bind
 * pose. Each bone turns around its own joint and carries its children with it.
 */
export function poseDeltas(rig: RigBone[], pose: SkinPose): Map<string, readonly number[]> {
  const local = new Map<string, number[]>();
  for (const rotation of pose.rotations) {
    const turn = axisRotation(rotation.axis, rotation.degrees);
    local.set(rotation.bone, multiply(turn, local.get(rotation.bone) ?? IDENTITY));
  }
  const byName = new Map(rig.map((bone) => [bone.name, bone]));
  const deltas = new Map<string, readonly number[]>();
  const resolve = (bone: RigBone, depth: number): readonly number[] => {
    const known = deltas.get(bone.name);
    if (known) return known;
    const parent = bone.parent !== null && depth < rig.length ? byName.get(bone.parent) : undefined;
    const inherited = parent ? resolve(parent, depth + 1) : IDENTITY;
    const turn = local.get(bone.name);
    const [x, y, z] = [bone.bindMatrix[12], bone.bindMatrix[13], bone.bindMatrix[14]];
    const delta = turn ? multiply(inherited, multiply(translation(x, y, z), multiply(turn, translation(-x, -y, -z)))) : inherited;
    deltas.set(bone.name, delta);
    return delta;
  };
  for (const bone of rig) resolve(bone, 0);
  return deltas;
}

/**
 * Where the avatar draws every vertex: Σ weight × bone delta × bind offset × stored position. Without deltas it is the
 * bind pose, which equals the stored positions when the file was bound to the avatar's own bind pose.
 */
export function skinPositions(geometry: SkinnedGeometry, deltas?: Map<string, readonly number[]>): Float32Array {
  const matrices = geometry.joints.map((joint) => {
    const delta = (joint.carrier !== null && deltas?.get(joint.carrier)) || IDENTITY;
    return joint.bindOffset ? multiply(delta, joint.bindOffset) : delta;
  });
  const out = new Float32Array(geometry.vertexCount * 3);
  const { positions, influences, weights } = geometry;
  for (let v = 0; v < geometry.vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let total = 0;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let c = 0; c < 4; c++) {
      const w = weights[v * 4 + c];
      if (w === 0) continue;
      const m = matrices[influences[v * 4 + c]];
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      total += w;
    }
    // a vertex with no weight is bone-weights' finding (M-10); here it stays where it was stored
    out[v * 3] = total > 0 ? ox : x;
    out[v * 3 + 1] = total > 0 ? oy : y;
    out[v * 3 + 2] = total > 0 ? oz : z;
  }
  return out;
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function axisRotation(axis: "x" | "y" | "z", degrees: number): number[] {
  const angle = (degrees * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === "x") return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === "y") return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

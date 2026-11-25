/**
 * Linear blend skinning the way the avatar does it (unity-explorer, ComputeShaderSkinning.compute): the avatar's own
 * bones drive the mesh, and the file supplies weights, joint indices and inverse bind matrices. Bones are matched by
 * their position in the joint list, never by name. Shared by skin-deformation; the rig and the poses come from the manifest.
 */
import type { Accessor, Document, Node, Primitive, Skin } from "@gltf-transform/core";
import type { RigBone, SkinPose } from "../manifest/index.js";
import { colliderNodes, IDENTITY, multiply } from "./gltf.js";
import { readVec4 } from "./weights.js";

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

/** One drawn piece of skinned geometry: a primitive under a skin. */
interface SkinnedPrimitive {
  node: string;
  skin: Skin;
  prim: Primitive;
  weighted: boolean;
}

/**
 * The skinned primitives a model draws (colliders excluded), each once. A skinned mesh ignores its node, so the same
 * mesh and skin on another node, or another primitive made of the same accessors, draws the same vertices again:
 * it is read once however many times the file repeats it.
 */
function skinnedPrimitives(doc: Document): SkinnedPrimitive[] | null {
  const colliders = colliderNodes(doc);
  const ids = new Map<object, number>();
  const idOf = (thing: object | null): number => {
    if (thing === null) return -1;
    let id = ids.get(thing);
    if (id === undefined) {
      id = ids.size;
      ids.set(thing, id);
    }
    return id;
  };
  const seen = new Set<string>();
  const out: SkinnedPrimitive[] = [];
  let skinned = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin || colliders.has(node)) continue;
    skinned = true;
    const name = node.getName() || mesh.getName() || "mesh";
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      const attributes = ["JOINTS_0", "WEIGHTS_0", "JOINTS_1", "WEIGHTS_1"].map((semantic) => prim.getAttribute(semantic));
      const key = [skin, position, ...attributes, prim.getIndices()].map(idOf).concat(prim.getMode()).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ node: name, skin, prim, weighted: attributes[0] !== null && attributes[1] !== null });
    }
  }
  return skinned ? out : null;
}

/** How many skinned vertices the model draws, without reading them: what the check compares with its limit before measuring. null when the model has no skinned mesh. */
export function countSkinnedVertices(doc: Document): number | null {
  const primitives = skinnedPrimitives(doc);
  if (!primitives) return null;
  let count = 0;
  for (const { prim, weighted } of primitives) if (weighted) count += prim.getAttribute("POSITION")!.getCount();
  return count;
}

/** Reads every skinned triangle mesh (colliders excluded) into one geometry. null when the model has no skinned mesh. */
export function readSkinnedGeometry(doc: Document, rig: RigBone[]): SkinnedGeometry | null {
  const primitives = skinnedPrimitives(doc);
  if (!primitives) return null;
  let total = 0;
  for (const { prim, weighted } of primitives) if (weighted) total += prim.getAttribute("POSITION")!.getCount();
  const positions = new Float32Array(total * 3);
  const influences = new Uint32Array(total * 4);
  const weights = new Float32Array(total * 4);
  const triangles: number[] = [];
  const joints: SkinJoint[] = [];
  const parts: SkinnedGeometry["parts"] = [];
  const unweighted = new Set<string>();
  const ranges = new Map<Skin, { base: number; count: number }>();
  let invalidInfluences = 0;
  let next = 0;
  const element = [0, 0, 0];
  const jointElement = [0, 0, 0, 0];
  for (const { node, skin, prim, weighted } of primitives) {
    if (!weighted) {
      unweighted.add(node);
      continue;
    }
    const range = ranges.get(skin) ?? readJoints(skin, rig, joints);
    ranges.set(skin, range);
    const position = prim.getAttribute("POSITION")!;
    const sets: [Accessor, Accessor][] = [[prim.getAttribute("JOINTS_0")!, prim.getAttribute("WEIGHTS_0")!]];
    const j1 = prim.getAttribute("JOINTS_1");
    const w1 = prim.getAttribute("WEIGHTS_1");
    if (j1 && w1) sets.push([j1, w1]);
    const base = next;
    const count = position.getCount();
    for (let v = 0; v < count; v++) {
      position.getElement(v, element);
      positions.set(element, next * 3);
      const pairs: [number, number][] = [];
      let invalid = false;
      for (const [jointsAccessor, weightsAccessor] of sets) {
        jointsAccessor.getElement(v, jointElement);
        const w = readVec4(weightsAccessor, v);
        for (let c = 0; c < 4; c++) {
          if (!(w[c] > 0)) continue;
          const joint = jointElement[c];
          if (Number.isInteger(joint) && joint >= 0 && joint < range.count) pairs.push([range.base + joint, w[c]]);
          else invalid = true;
        }
      }
      if (invalid) invalidInfluences++;
      pairs.sort((a, b) => b[1] - a[1]);
      let sum = 0;
      for (let c = 0; c < 4 && c < pairs.length; c++) sum += pairs[c][1];
      for (let c = 0; c < 4; c++) {
        influences[next * 4 + c] = pairs[c]?.[0] ?? range.base;
        weights[next * 4 + c] = pairs[c] && sum > 0 ? pairs[c][1] / sum : 0;
      }
      next++;
    }
    const last = parts[parts.length - 1];
    if (last && last.node === node && last.end === base) last.end = next;
    else if (next > base) parts.push({ node, start: base, end: next });
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
  return { vertexCount: total, positions, influences, weights, triangles: new Uint32Array(triangles), joints, parts, invalidInfluences, unweighted: [...unweighted] };
}

/** Appends one skin's joints and returns where they sit. */
function readJoints(skin: Skin, rig: RigBone[], joints: SkinJoint[]): { base: number; count: number } {
  const base = joints.length;
  const inverseBind = skin.getInverseBindMatrices();
  // an accessor of another type holds no matrices to read
  const stored = inverseBind && inverseBind.getType() === "MAT4" ? inverseBind.getCount() : 0;
  const skinJoints = skin.listJoints();
  // the rig slot that carries each node; helper chains ask their parent, so every node is answered once
  const slotOf = new Map<Node, number | null>(skinJoints.slice(0, rig.length).map((joint, index) => [joint, index]));
  skinJoints.forEach((joint, index) => {
    if (index >= rig.length) {
      const slot = rigAncestor(joint, slotOf);
      // the rig slots of this skin are already in `joints`: the first rig.length entries from `base`
      joints.push({ name: joint.getName(), carrier: slot === null ? null : rig[slot].name, slot: null, bindOffset: slot === null ? null : joints[base + slot].bindOffset });
      return;
    }
    // a joint the accessor has no matrix for, or an unreadable one, is bound at the origin, as glTF reads a skin without matrices
    const read = index < stored ? inverseBind!.getElement(index, new Array<number>(16).fill(NaN)) : IDENTITY;
    const inverse = read.every((value) => Number.isFinite(value)) ? read : IDENTITY;
    joints.push({ name: joint.getName(), carrier: rig[index].name, slot: index, bindOffset: multiply(rig[index].bindMatrix, inverse) });
  });
  return { base, count: skinJoints.length };
}

/** The rig slot of the nearest ancestor that has one. Every node on the way up remembers the answer. */
function rigAncestor(joint: Node, slotOf: Map<Node, number | null>): number | null {
  const walked: Node[] = [];
  let slot: number | null = null;
  for (let parent = joint.getParentNode(); parent; parent = parent.getParentNode()) {
    const known = slotOf.get(parent);
    if (known !== undefined) {
      slot = known;
      break;
    }
    walked.push(parent);
  }
  for (const node of walked) slotOf.set(node, slot);
  slotOf.set(joint, slot);
  return slot;
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

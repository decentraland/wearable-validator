import { Document, WebIO } from "@gltf-transform/core";
import { invert, multiply } from "../../src/logic/gltf.js";
import { manifest } from "../../src/manifest/index.js";

const io = new WebIO();
const RIG = manifest.skinDeformation.rig;

/** One vertex's weights by bone name; they should sum to 1. An empty object leaves the vertex without weight. */
export type BoneWeights = Record<string, number>;

export interface RiggedOptions {
  /**
   * Weights for a vertex at (x, y, z), replacing the clean ones. Return undefined to keep the clean weights.
   * +x is the avatar's left.
   */
  weights?: (x: number, y: number, z: number) => BoneWeights | undefined;
  /**
   * List the skin's joints in another order than the avatar's. The file stays consistent with itself, as an exporter
   * leaves it: every vertex still names the bone it was painted for, so it looks right wherever bones are matched by name.
   */
  jointOrder?: (names: string[]) => string[];
  /** Where each bone stands at bind time, replacing the avatar's bind matrix: a mesh bound to another skeleton. */
  bindMatrix?: (bone: string, avatar: number[]) => number[];
  /** Height the band is drawn at (default: the shoulders). */
  height?: number;
  /** Where the band starts on the avatar's right (default -0.6, the mirror of where it ends on the left). */
  minX?: number;
  /** Scale the armature and the mesh together, as a file modelled at another size would be. */
  scale?: number;
  /** Extra joints past the avatar's 62, by name, each under the bone named (a spring or helper bone standing on its parent). `weights` can name them. */
  helpers?: Record<string, string>;
  /** A second mesh node, "Band2", drawing the same band with the same skin: what Blender exports for two objects on one armature. */
  secondMesh?: boolean;
  /** Keep only this many matrices in the inverse bind accessor: a skin with fewer matrices than joints. */
  inverseBindCount?: number;
  /** The joint number written for a vertex's first influence, replacing the one its weights name: -1 or a number past the joint list. */
  rawJoint?: (x: number, y: number) => number | undefined;
  /** Name the bone nodes something else, keeping their order: a rig from another tool. `weights` still uses the avatar's names. */
  rename?: (name: string) => string;
  /** Leave JOINTS_0 and WEIGHTS_0 out: a mesh with a skin and nothing to move it. */
  noWeights?: boolean;
}

const SHOULDER_HEIGHT = 1.466;
const SHOULDER_X = 0.177;

/** A clean weight paint for the band: the chest follows the spine, each sleeve its arm, blended across the shoulder. */
export function cleanWeights(x: number): BoneWeights {
  const side = x > 0 ? "Left" : "Right";
  const arm = Math.min(1, Math.max(0, (Math.abs(x) - (SHOULDER_X - 0.05)) / 0.1));
  return arm === 0 ? { Avatar_Spine2: 1 } : arm === 1 ? { [`Avatar_${side}Arm`]: 1 } : { Avatar_Spine2: 1 - arm, [`Avatar_${side}Arm`]: arm };
}

/**
 * A wearable rigged to the avatar's real skeleton (the manifest's rig, with its hierarchy and bind pose): a band of
 * quads across the chest and along both arms in the T-pose, the same on both sides, weighted like a clean shirt.
 * Every skinning defect is one option away.
 */
export async function riggedGlb(options: RiggedOptions = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("scene");
  const armature = doc.createNode("Armature");
  scene.addChild(armature);

  const scale = options.scale ?? 1;
  const scaled = (matrix: number[]): number[] => matrix.map((value, i) => (i % 4 === 3 ? value : value * scale));
  const bind = new Map(RIG.map((bone) => [bone.name, scaled(options.bindMatrix?.(bone.name, bone.bindMatrix) ?? bone.bindMatrix)]));
  const nodes = new Map(RIG.map((bone) => [bone.name, doc.createNode(options.rename?.(bone.name) ?? bone.name)]));
  for (const bone of RIG) {
    const node = nodes.get(bone.name)!;
    const parent = bone.parent === null ? null : nodes.get(bone.parent)!;
    (parent ?? armature).addChild(node);
    const parentInverse = bone.parent === null ? null : invert(bind.get(bone.parent)!);
    node.setMatrix((parentInverse ? multiply(parentInverse, bind.get(bone.name)!) : bind.get(bone.name)!) as never);
  }

  // a 49 × 9 grid: x from -0.6 to 0.6 in 0.025 m steps, 0.2 m tall, 0.1 m in front of the spine
  const firstColumn = Math.round(((options.minX ?? -0.6) + 0.6) / 0.025);
  const columns = 49 - firstColumn;
  const rows = 9;
  const height = options.height ?? SHOULDER_HEIGHT;
  const names = RIG.map((bone) => bone.name);
  const order = [...(options.jointOrder?.(names) ?? names)];
  for (const [helper, parent] of Object.entries(options.helpers ?? {})) {
    const node = doc.createNode(helper);
    nodes.get(parent)!.addChild(node);
    nodes.set(helper, node);
    bind.set(helper, bind.get(parent)!);
    order.push(helper);
  }
  const positions: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  // influences past the fourth go to a second set, as an exporter without a limit writes them
  const joints1: number[] = [];
  const weights1: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = Number((-0.6 + (firstColumn + column) * 0.025).toFixed(3));
      const y = height - 0.1 + row * 0.025;
      const z = 0.1;
      positions.push(x * scale, y * scale, z * scale);
      const entries = Object.entries(options.weights?.(x, y, z) ?? cleanWeights(x)).slice(0, 8);
      for (let slot = 0; slot < 8; slot++) {
        (slot < 4 ? joints : joints1).push(entries[slot] ? order.indexOf(entries[slot][0]) : 0);
        (slot < 4 ? weights : weights1).push(entries[slot]?.[1] ?? 0);
      }
      const raw = options.rawJoint?.(x, y);
      if (raw !== undefined) joints[joints.length - 4] = raw;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      indices.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
    }
  }

  const prim = doc.createPrimitive().setMode(4)
    .setAttribute("POSITION", doc.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setIndices(doc.createAccessor("indices").setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(doc.createMaterial("Wearable_MAT"));
  if (!options.noWeights) {
    // a negative joint number only fits a signed array
    const jointArray = joints.some((joint) => joint < 0) ? new Int16Array(joints) : new Uint16Array(joints);
    prim.setAttribute("JOINTS_0", doc.createAccessor("JOINTS_0").setType("VEC4").setArray(jointArray).setBuffer(buffer));
    prim.setAttribute("WEIGHTS_0", doc.createAccessor("WEIGHTS_0").setType("VEC4").setArray(new Float32Array(weights)).setBuffer(buffer));
    if (weights1.some((weight) => weight > 0)) {
      prim.setAttribute("JOINTS_1", doc.createAccessor("JOINTS_1").setType("VEC4").setArray(new Uint16Array(joints1)).setBuffer(buffer));
      prim.setAttribute("WEIGHTS_1", doc.createAccessor("WEIGHTS_1").setType("VEC4").setArray(new Float32Array(weights1)).setBuffer(buffer));
    }
  }
  const mesh = doc.createMesh("Band").addPrimitive(prim);
  const meshNode = doc.createNode("Band").setMesh(mesh);
  scene.addChild(meshNode);

  const skin = doc.createSkin("skin");
  const inverseBind = new Float32Array(order.length * 16);
  order.forEach((name, index) => {
    skin.addJoint(nodes.get(name)!);
    inverseBind.set(invert(bind.get(name)!)!, index * 16);
  });
  const kept = options.inverseBindCount === undefined ? inverseBind : inverseBind.slice(0, options.inverseBindCount * 16);
  skin.setInverseBindMatrices(doc.createAccessor("inverse_bind").setType("MAT4").setArray(kept).setBuffer(buffer));
  meshNode.setSkin(skin);
  if (options.secondMesh) scene.addChild(doc.createNode("Band2").setMesh(mesh).setSkin(skin));
  return io.writeBinary(doc);
}

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
  const nodes = new Map(RIG.map((bone) => [bone.name, doc.createNode(bone.name)]));
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
  const order = options.jointOrder?.(names) ?? names;
  const positions: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = Number((-0.6 + (firstColumn + column) * 0.025).toFixed(3));
      const y = height - 0.1 + row * 0.025;
      const z = 0.1;
      positions.push(x * scale, y * scale, z * scale);
      const entries = Object.entries(options.weights?.(x, y, z) ?? cleanWeights(x)).slice(0, 4);
      for (let slot = 0; slot < 4; slot++) {
        joints.push(entries[slot] ? order.indexOf(entries[slot][0]) : 0);
        weights.push(entries[slot]?.[1] ?? 0);
      }
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
    .setAttribute("JOINTS_0", doc.createAccessor("JOINTS_0").setType("VEC4").setArray(new Uint16Array(joints)).setBuffer(buffer))
    .setAttribute("WEIGHTS_0", doc.createAccessor("WEIGHTS_0").setType("VEC4").setArray(new Float32Array(weights)).setBuffer(buffer))
    .setIndices(doc.createAccessor("indices").setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(doc.createMaterial("Wearable_MAT"));
  const meshNode = doc.createNode("Band").setMesh(doc.createMesh("Band").addPrimitive(prim));
  scene.addChild(meshNode);

  const skin = doc.createSkin("skin");
  const inverseBind = new Float32Array(order.length * 16);
  order.forEach((name, index) => {
    skin.addJoint(nodes.get(name)!);
    inverseBind.set(invert(bind.get(name)!)!, index * 16);
  });
  skin.setInverseBindMatrices(doc.createAccessor("inverse_bind").setType("MAT4").setArray(inverseBind).setBuffer(buffer));
  meshNode.setSkin(skin);
  return io.writeBinary(doc);
}

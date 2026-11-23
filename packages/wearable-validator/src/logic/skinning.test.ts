import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebIO } from "@gltf-transform/core";
import { cleanWeights, riggedGlb } from "#test/helpers/rigged.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { transformPoint } from "./gltf.js";
import { manifest } from "../manifest/index.js";
import { poseDeltas, readSkinnedGeometry, skinPositions } from "./skinning.js";

const { rig, poses } = manifest.skinDeformation;
const pose = (name: string) => poses.find((p) => p.name === name)!;
const bindPosition = (bone: string): [number, number, number] => {
  const m = rig.find((b) => b.name === bone)!.bindMatrix;
  return [m[12], m[13], m[14]];
};
const near = (actual: number, expected: number, tolerance = 1e-4): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe("skinning", () => {
  it("the rig is the 62-bone avatar skeleton, each parent listed before its children", () => {
    assert.equal(rig.length, 62);
    const seen = new Set<string>();
    for (const bone of rig) {
      assert.equal(bone.bindMatrix.length, 16, bone.name);
      if (bone.parent !== null) assert.ok(seen.has(bone.parent), `${bone.name} comes before its parent ${bone.parent}`);
      seen.add(bone.name);
    }
    assert.deepEqual(rig.filter((bone) => bone.parent === null).map((bone) => bone.name), ["Avatar_Hips"]);
  });

  it("every pose turns bones the rig has", () => {
    const names = new Set(rig.map((bone) => bone.name));
    for (const p of poses) for (const rotation of p.rotations) assert.ok(names.has(rotation.bone), `${p.name}: ${rotation.bone}`);
  });

  it("arms down swings the left hand under the shoulder and leaves the spine alone", () => {
    const deltas = poseDeltas(rig, pose("arms-down"));
    const shoulder = bindPosition("Avatar_LeftArm");
    const hand = transformPoint(deltas.get("Avatar_LeftHand")!, bindPosition("Avatar_LeftHand"));
    const reach = Math.hypot(...bindPosition("Avatar_LeftHand").map((value, i) => value - shoulder[i]));
    near(Math.hypot(...hand.map((value, i) => value - shoulder[i])), reach);
    assert.ok(hand[1] < shoulder[1] - 0.4, "the hand hangs well below the shoulder");
    assert.ok(hand[0] > 0, "and stays on the avatar's left");
    assert.deepEqual(transformPoint(deltas.get("Avatar_Spine2")!, [0.1, 1.3, 0.1]), [0.1, 1.3, 0.1]);
  });

  it("a child bone is carried by its parent's turn", () => {
    const deltas = poseDeltas(rig, pose("head-turn"));
    assert.deepEqual(deltas.get("Avatar_LeftHand"), deltas.get("Avatar_Hips"));
    assert.notDeepEqual(deltas.get("Avatar_Head"), deltas.get("Avatar_Neck"));
  });

  it("the bind pose of a mesh bound to the rig is its stored positions", async () => {
    const doc = await new WebIO().readBinary(await riggedGlb());
    const geometry = readSkinnedGeometry(doc, rig)!;
    assert.equal(geometry.vertexCount, 49 * 9);
    assert.equal(geometry.triangles.length, 48 * 8 * 2 * 3);
    const bind = skinPositions(geometry);
    for (let i = 0; i < bind.length; i++) near(bind[i], geometry.positions[i], 1e-5);
  });

  it("skinning blends the bones by weight", async () => {
    const doc = await new WebIO().readBinary(await riggedGlb({ weights: (x) => (x === 0.6 ? { Avatar_LeftArm: 0.5, Avatar_Spine2: 0.5 } : cleanWeights(x)) }));
    const geometry = readSkinnedGeometry(doc, rig)!;
    const deltas = poseDeltas(rig, pose("arms-down"));
    const posed = skinPositions(geometry, deltas);
    const tip = 48; // last vertex of the first row: x = 0.6
    const stored: [number, number, number] = [geometry.positions[tip * 3], geometry.positions[tip * 3 + 1], geometry.positions[tip * 3 + 2]];
    const onArm = transformPoint(deltas.get("Avatar_LeftArm")!, stored);
    for (let i = 0; i < 3; i++) near(posed[tip * 3 + i], (stored[i] + onArm[i]) / 2, 1e-5);
  });

  it("the rig is in the order the client indexes the avatar's bones", () => {
    // unity-explorer AvatarBase.prefab: hips, legs, spine, left arm and hand, right arm and hand, neck, head
    assert.deepEqual(rig.slice(0, 5).map((bone) => bone.name), ["Avatar_Hips", "Avatar_LeftUpLeg", "Avatar_LeftLeg", "Avatar_LeftFoot", "Avatar_LeftToeBase"]);
    assert.deepEqual(rig.slice(9, 13).map((bone) => bone.name), ["Avatar_Spine", "Avatar_Spine1", "Avatar_Spine2", "Avatar_LeftShoulder"]);
    assert.deepEqual(rig.slice(16, 18).map((bone) => bone.name), ["Avatar_LeftHandThumb1", "Avatar_LeftHandThumb2"]);
    assert.deepEqual(rig.slice(36, 38).map((bone) => bone.name), ["Avatar_RightShoulder", "Avatar_RightArm"]);
    assert.deepEqual(rig.slice(60).map((bone) => bone.name), ["Avatar_Neck", "Avatar_Head"]);
  });

  it("a joint is carried by the rig bone at its position in the joint list, not the one of its name", async () => {
    const doc = await new WebIO().readBinary(await riggedGlb({ jointOrder: (names) => [...names].reverse() }));
    const geometry = readSkinnedGeometry(doc, rig)!;
    assert.equal(geometry.joints[0].name, rig[rig.length - 1].name);
    assert.equal(geometry.joints[0].carrier, rig[0].name);
    assert.deepEqual(geometry.skinStarts, [0]);
    // bound to its own bone's pose but moved by another: the bind offset is no longer the identity
    assert.ok(Math.abs(geometry.joints[0].bindOffset![13]) > 0.1);
  });

  it("returns null for a model without a skinned mesh", async () => {
    const doc = await new WebIO().readBinary(await syntheticGlb({ skinned: false }));
    assert.equal(readSkinnedGeometry(doc, rig), null);
  });
});

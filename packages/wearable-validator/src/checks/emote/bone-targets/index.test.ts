import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeIO } from "@gltf-transform/core";
import { validate } from "../../../index.js";
import { of, runChecks } from "#test/helpers/emote.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";

describe("bone-targets (E-03)", () => {
  it("errors when a clip animates a mesh node", async () => {
    const result = await runChecks({ animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "cube_node" }] }, ["bone-targets"]);
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /mesh/);
  });

  it("errors on a non-canonical bone name", async () => {
    const result = await runChecks(
      { animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "Armature" }] },
      ["bone-targets"]
    );
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Armature/);
  });

  it("errors when a non-prop clip animates a prop bone", async () => {
    const result = await runChecks(
      { prop: { bones: 2 }, animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "Prop_Bone_0" }] },
      ["bone-targets"]
    );
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /_Prop/);
  });

  it("reports a clip retargeted from another rig once, naming its bones", async () => {
    const io = new NodeIO();
    const doc = await io.readBinary(await syntheticGlb({ animations: [{ name: "Horse_Avatar", seconds: 2 }] }));
    const clip = doc.getRoot().listAnimations()[0];
    const sampler = clip.listSamplers()[0];
    for (let i = 0; i < 40; i++) {
      const node = doc.createNode(`CTRL_Avatar_Bone${i}`);
      doc.getRoot().listScenes()[0].addChild(node);
      clip.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("translation").setSampler(sampler));
    }
    const result = await validate(await io.writeBinary(doc), { checks: ["bone-targets"], itemType: "emote" });
    const errors = of(result, "bone-targets");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /"CTRL_Avatar_Bone0", .* \(\+35 more\), which are not canonical/);
    assert.equal((errors[0].data as { nodes: string[] }).nodes.length, 40);
  });

  it("accepts avatar bones, springbones and prop bones from a prop clip", async () => {
    const result = await runChecks(
      {
        bones: undefined,
        prop: { bones: 2 },
        animations: [
          { name: "Wave_Avatar", seconds: 2, targetBone: "Avatar_Hips" },
          { name: "Wave_Prop", seconds: 2, targetNode: "Prop_Bone_0" }
        ]
      },
      ["bone-targets"]
    );
    assert.equal(of(result, "bone-targets").length, 0);
  });
});

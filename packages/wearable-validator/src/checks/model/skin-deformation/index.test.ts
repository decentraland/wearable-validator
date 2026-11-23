import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { cleanWeights, riggedGlb, type RiggedOptions } from "#test/helpers/rigged.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

const config = manifest.skinDeformation;

async function run(options: RiggedOptions = {}, category = "upper_body") {
  const result = await validate(await syntheticZip({ glb: await riggedGlb(options), category }), { checks: ["skin-deformation"] });
  return { result, findings: found(result, "skin-deformation") };
}

const signals = (findings: { severity: string; data?: Record<string, unknown> }[]): string[] => findings.map((f) => `${f.severity}:${String(f.data?.signal)}`);

describe("skin-deformation (M-16)", () => {
  it("passes a mesh bound to the avatar's bind pose with clean, mirrored weights", async () => {
    const { result, findings } = await run();
    assert.deepEqual(findings, []);
    assert.equal(status(result, "skin-deformation"), "passed");
    assert.match(result.checks[0].measured ?? "", /^largest stretch /);
  });

  it("passes the plain synthetic wearable every other suite uses", async () => {
    const result = await validate(await syntheticZip({ category: "upper_body" }), { checks: ["skin-deformation"] });
    assert.equal(status(result, "skin-deformation"), "passed");
  });

  describe("bind pose", () => {
    it("errors when the mesh is bound to a skeleton with other proportions", async () => {
      // every bone 20% further from the hips, as on a taller custom armature that kept the Avatar_ names
      const { result, findings } = await run({
        bindMatrix: (_bone, avatar) => avatar.map((value, i) => (i === 12 || i === 14 ? value * 1.2 : i === 13 ? 1 + (value - 1) * 1.2 : value))
      });
      assert.deepEqual(signals(findings), ["error:bind-pose"]);
      assert.equal(status(result, "skin-deformation"), "failed");
      assert.equal(findings[0].limit, config.bindPoseToleranceMeters);
      assert.ok((findings[0].measured as number) > config.bindPoseToleranceMeters);
      assert.equal(findings[0].where, "model.glb");
      assert.match(findings[0].message, /do not stand where the avatar's bones stand/);
      assert.match(findings[0].message, /official armature/);
      assert.match(result.checks[0].measured ?? "", /^bind pose off by /);
    });

    it("says nothing else about a mesh whose binding is distorted", async () => {
      const { findings } = await run({
        bindMatrix: (_bone, avatar) => avatar.map((value, i) => (i === 12 ? value * 1.5 : value)),
        weights: (x) => (x < 0 ? {} : undefined)
      });
      assert.deepEqual(signals(findings), ["error:bind-pose"]);
    });

    it("accepts an armature scaled as a whole: the mesh lands on the avatar in one piece", async () => {
      const { findings } = await run({ scale: 2.4 });
      assert.deepEqual(findings, []);
    });
  });

  describe("symmetry", () => {
    it("errors when one side of a mirrored mesh has lost its weights", async () => {
      const { result, findings } = await run({ weights: (x) => (x < -config.symmetry.centreBandMeters ? {} : undefined) });
      const symmetry = findings.find((f) => f.data?.signal === "symmetry");
      assert.ok(symmetry);
      assert.equal(symmetry.severity, "error");
      assert.equal(symmetry.limit, config.symmetry.errorShare);
      assert.ok((symmetry.measured as number) >= config.symmetry.errorShare);
      assert.match(symmetry.message, /weighted differently from their mirror/);
      assert.match(symmetry.message, /Weights → Mirror/);
      assert.equal(status(result, "skin-deformation"), "failed");
    });

    it("errors when one side was all moved onto the hips", async () => {
      const { findings } = await run({ weights: (x) => (x < -config.symmetry.centreBandMeters ? { Avatar_Hips: 1 } : undefined) });
      const symmetry = findings.find((f) => f.data?.signal === "symmetry");
      assert.equal(symmetry?.severity, "error");
      assert.equal(symmetry?.data?.bone, "Avatar_LeftArm");
      assert.equal(symmetry?.data?.mirrorBone, "Avatar_Hips");
    });

    it("warns when a smaller share of the pairs differ", async () => {
      // the last 3 of 24 columns of the right sleeve follow the spine: an eighth of the mirrored pairs
      const { findings } = await run({ weights: (x) => (x < -0.53 ? { Avatar_Spine2: 1 } : undefined) });
      const symmetry = findings.find((f) => f.data?.signal === "symmetry");
      assert.equal(symmetry?.severity, "warning");
      assert.equal(symmetry?.limit, config.symmetry.warnShare);
      assert.ok((symmetry?.measured as number) < config.symmetry.errorShare);
    });

    it("does not compare the two sides of a mesh that is not mirrored", async () => {
      // a top with one sleeve: what is left of the right side follows the hips, but most of the left has no mirror
      const { findings } = await run({ minX: -0.15, weights: (x) => (x < -0.02 ? { Avatar_Hips: 1 } : undefined) });
      assert.equal(findings.some((f) => f.data?.signal === "symmetry"), false);
    });
  });

  describe("stretch in standard poses", () => {
    it("warns when a small part on the chest follows the arm", async () => {
      // a drawstring: three vertices at the centre of the chest weighted to the left upper arm
      const { result, findings } = await run({ weights: (x, y) => (x === 0 && y < 1.42 ? { Avatar_LeftArm: 1 } : undefined) });
      assert.deepEqual(signals(findings), ["warning:spike"]);
      assert.equal(status(result, "skin-deformation"), "warning");
      assert.equal(findings[0].limit, config.stretch.localGrowthMeters);
      assert.ok((findings[0].measured as number) >= config.stretch.localGrowthMeters);
      assert.ok((findings[0].data?.edges as number) >= config.stretch.localMinEdges);
      assert.deepEqual([...(findings[0].data?.bones as string[])].sort(), ["Avatar_LeftArm", "Avatar_Spine2"]);
      assert.match(findings[0].message, /with the arms /);
      assert.match(findings[0].message, /mesh "Band"/);
    });

    it("errors when most of a part's edges are torn between two bones", async () => {
      // every other column of the chest follows the head: no drawstring, a mesh weighted to the wrong bones
      const { result, findings } = await run({ weights: (x) => (Math.abs(x) < 0.12 && Math.round(Math.abs(x) / 0.025) % 2 === 1 ? { Avatar_Head: 1 } : undefined) });
      assert.deepEqual(signals(findings), ["error:stretch"], "the gross finding already covers the pose: no spike warning on top");
      assert.equal(findings[0].limit, config.stretch.grossEdgeShare);
      assert.ok((findings[0].measured as number) >= config.stretch.grossEdgeShare);
      assert.equal(config.poses.find((pose) => pose.name === findings[0].data?.pose)?.local, true);
      assert.match(findings[0].message, /of the mesh's edges stretch by/);
      assert.match(findings[0].message, /with the head /);
      assert.equal(status(result, "skin-deformation"), "failed");
    });

    it("only warns when that much stretch comes from the legs, where skirts stretch by design", async () => {
      // a band at knee height, every other column on its own side's thigh and the rest on the hips: mirrored, so symmetry is quiet
      const { result, findings } = await run({
        height: 0.6,
        weights: (x) => ({ [Math.round(Math.abs(x) / 0.025) % 2 === 1 ? (x > 0 ? "Avatar_LeftUpLeg" : "Avatar_RightUpLeg") : "Avatar_Hips"]: 1 })
      });
      assert.deepEqual(signals(findings), ["warning:stretch"]);
      assert.equal(config.poses.find((pose) => pose.name === findings[0].data?.pose)?.local, false);
      assert.equal(status(result, "skin-deformation"), "warning");
    });

    it("accepts a skirt split between the two legs along one seam", async () => {
      const { findings } = await run({ height: 0.6, weights: (x) => ({ [x >= 0 ? "Avatar_LeftUpLeg" : "Avatar_RightUpLeg"]: 1 }) });
      assert.deepEqual(findings, []);
    });

    it("errors when the file lists its joints in another order than the weights were written for", async () => {
      // alphabetical instead of the rig's order: each index now names some other bone, and the two sides stop matching
      const { result, findings } = await run({ jointOrder: (names) => [...names].sort() });
      assert.ok(findings.some((f) => f.severity === "error"));
      assert.equal(status(result, "skin-deformation"), "failed");
    });

    it("keeps quiet about clean weights blended across the shoulder", async () => {
      const { findings } = await run({ weights: (x) => cleanWeights(x) });
      assert.deepEqual(findings, []);
    });
  });

  describe("head items", () => {
    const onSpine = { weights: () => ({ Avatar_Spine2: 1 }) };

    it("warns when a hat is not weighted to the head bone", async () => {
      const { result, findings } = await run(onSpine, "hat");
      assert.deepEqual(signals(findings), ["warning:head-follow"]);
      assert.equal(findings[0].limit, config.headFollow.minWeightShare);
      assert.equal(findings[0].measured, 0);
      assert.match(findings[0].message, new RegExp(`"${config.headFollow.bone}"`));
      assert.equal(status(result, "skin-deformation"), "warning");
    });

    it("passes a hat weighted to the head", async () => {
      const { findings } = await run({ weights: () => ({ [config.headFollow.bone]: 1 }) }, "hat");
      assert.deepEqual(findings, []);
    });

    it("does not ask body garments to follow the head", async () => {
      const { findings } = await run(onSpine, "upper_body");
      assert.deepEqual(findings, []);
    });

    it("covers every listed head category", async () => {
      for (const category of config.headFollow.categories) {
        const { findings } = await run(onSpine, category);
        assert.deepEqual(signals(findings), ["warning:head-follow"], category);
      }
    });
  });

  it("reports every problem of a model at once", async () => {
    const { findings } = await run({ weights: (x) => (x < -config.symmetry.centreBandMeters ? { Avatar_Hips: 1 } : x === 0 ? { Avatar_LeftArm: 1 } : undefined) }, "hat");
    const seen = signals(findings);
    assert.ok(seen.includes("error:symmetry"));
    assert.ok(seen.includes("warning:head-follow"));
    assert.ok(seen.some((signal) => signal.endsWith(":spike") || signal.endsWith(":stretch")));
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["skin-deformation"] });
    assert.equal(result.checks.length, 0);
  });

  it("is not applicable to a wearable without a skinned mesh", async () => {
    const result = await validate(await syntheticZip({ glb: await syntheticGlb({ skinned: false }) }), { checks: ["skin-deformation"] });
    assert.equal(result.checks.length, 0);
  });

  it("never returns a verdict from a run of this check alone", async () => {
    const { result } = await run();
    assert.equal(result.passed, null);
  });
});

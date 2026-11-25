import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { measureGeometry } from "./index.js";
import { found, status } from "#test/helpers/findings.js";
import { cleanWeights, riggedGlb, type RiggedOptions } from "#test/helpers/rigged.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

const config = manifest.skinDeformation;

async function run(options: RiggedOptions = {}, category = "upper_body") {
  const result = await validate(await syntheticZip({ glb: await riggedGlb(options), category }), { checks: ["skin-deformation"] });
  return { result, findings: found(result, "skin-deformation") };
}

const signals = (findings: { severity: string; data?: Record<string, unknown> }[]): string[] => findings.map((f) => `${f.severity}:${String(f.data?.signal)}`);

describe("skin-deformation (M-17)", () => {
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
      assert.match(result.checks[0].measured ?? "", /^out of shape by .* m on the avatar$/);
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

  describe("joint order", () => {
    // what an armature rebuilt outside the official file exports: the same bones, children in alphabetical order
    const alphabetical = (names: string[]): string[] => [...names].sort();

    it("errors when the joints are listed in another order than the avatar's, although every weight names the right bone", async () => {
      const { result, findings } = await run({ jointOrder: alphabetical });
      assert.deepEqual(signals(findings), ["error:joint-order"]);
      assert.equal(status(result, "skin-deformation"), "failed");
      const [found] = findings;
      const sorted = alphabetical(config.rig.map((bone) => bone.name));
      const position = sorted.findIndex((name, index) => name !== config.rig[index].name);
      assert.equal(found.data?.position, position);
      assert.equal(found.data?.bone, sorted[position]);
      assert.equal(found.data?.expected, config.rig[position].name);
      assert.equal(found.limit, config.jointOrder.errorShare);
      assert.ok((found.measured as number) >= config.jointOrder.errorShare);
      assert.ok((found.data?.offsetMeters as number) > config.bindPoseToleranceMeters);
      assert.match(found.message, /matched by position, not by name/);
      assert.match(found.message, /official armature/);
    });

    it("passes a file in another order when every bone it uses is still at the avatar's position", async () => {
      // the two last bones swapped: the band is weighted to the spine and the arms, which stay where they were
      const swapTail = (names: string[]): string[] => [...names.slice(0, -2), names[names.length - 1], names[names.length - 2]];
      const { findings } = await run({ jointOrder: swapTail });
      assert.deepEqual(findings, []);
    });

    it("moves a joint by the avatar's bone at its position, whatever the joint is called", async () => {
      // the same swap, with the band on the head: by position the file's Avatar_Head is the avatar's neck
      const swapTail = (names: string[]): string[] => [...names.slice(0, -2), names[names.length - 1], names[names.length - 2]];
      assert.deepEqual(config.rig.slice(-2).map((bone) => bone.name), ["Avatar_Neck", "Avatar_Head"]);
      const { findings } = await run({ jointOrder: swapTail, weights: (x) => (x > 0 ? { Avatar_Head: 1 } : { Avatar_Spine2: 1 }) });
      assert.deepEqual(signals(findings), ["error:joint-order"]);
      assert.equal(findings[0].data?.bone, "Avatar_Head");
      assert.equal(findings[0].data?.expected, "Avatar_Neck");
    });
  });

  describe("joint order, graded by how much of the mesh it moves", () => {
    // the two last bones swapped: by position the file's Avatar_Head is the avatar's neck
    const swapTail = (names: string[]): string[] => [...names.slice(0, -2), names[names.length - 1], names[names.length - 2]];

    it("warns when only a small part of the mesh is on the misplaced joints", async () => {
      // a token piece, like the 28-vertex earring of a staff filed as an earring: one column of 49 on the head
      const { result, findings } = await run({ jointOrder: swapTail, weights: (x) => (x === 0.6 ? { Avatar_Head: 1 } : undefined) });
      assert.deepEqual(signals(findings), ["warning:joint-order"]);
      assert.equal(status(result, "skin-deformation"), "warning");
      assert.equal(findings[0].limit, config.jointOrder.errorShare);
      assert.ok((findings[0].measured as number) < config.jointOrder.errorShare);
      assert.equal(findings[0].data?.vertices, 9);
      assert.match(findings[0].message, /9 of 441 vertices \(2%\)/);
      assert.match(findings[0].message, /so this is a warning/);
    });

    it("errors once the share reaches the limit", async () => {
      const { findings } = await run({ jointOrder: swapTail, weights: (x) => (x > 0.45 ? { Avatar_Head: 1 } : undefined) });
      assert.deepEqual(signals(findings), ["error:joint-order"]);
      assert.ok((findings[0].measured as number) >= config.jointOrder.errorShare);
    });

    it("does not call it joint order when the names are another rig's: skeleton (M-09) reports those", async () => {
      // the right order, other names, other proportions: bind pose is the cause, not order
      const { findings } = await run({
        rename: (name) => name.replace("Avatar_", "mixamorig:"),
        bindMatrix: (_bone, avatar) => avatar.map((value, i) => (i === 12 || i === 14 ? value * 1.2 : i === 13 ? 1 + (value - 1) * 1.2 : value))
      });
      assert.deepEqual(signals(findings), ["error:bind-pose"]);
    });

    it("counts a skin once however many meshes use it", async () => {
      const sorted = [...config.rig.map((bone) => bone.name)].sort();
      const out = sorted.filter((name, index) => name !== config.rig[index].name).length;
      const { findings } = await run({ jointOrder: (names) => [...names].sort(), secondMesh: true });
      assert.deepEqual(signals(findings), ["error:joint-order"]);
      assert.equal(findings[0].data?.joints, out);
    });
  });

  describe("joints past the avatar's 62", () => {
    const helpers = { Sleeve_springbone: "Avatar_LeftArm" };
    const onHelper = (x: number) => (x > 0.3 ? { Sleeve_springbone: 1 } : undefined);

    it("a helper joint follows the bone it hangs from", async () => {
      const { findings } = await run({ helpers, weights: onHelper });
      assert.deepEqual(findings, []);
    });

    it("on an armature scaled as a whole, its vertices land with the rest of the mesh", async () => {
      const { findings } = await run({ helpers, weights: onHelper, scale: 2.4 });
      assert.deepEqual(findings, []);
    });
  });

  describe("damaged skins", () => {
    it("errors on a joint number past the skin's joint list", async () => {
      const { result, findings } = await run({ rawJoint: (x, y) => (x === 0 && y < 1.42 ? 500 : undefined) });
      const found = findings.find((f) => f.data?.signal === "joint-index");
      assert.equal(found?.severity, "error");
      assert.equal(found?.data?.vertices, 3);
      assert.match(found?.message ?? "", /a joint number the skin does not have/);
      assert.equal(status(result, "skin-deformation"), "failed");
    });

    it("errors on a negative joint number instead of throwing", async () => {
      const { result, findings } = await run({ rawJoint: (x, y) => (x === 0 && y < 1.42 ? -1 : undefined) });
      assert.equal(findings.find((f) => f.data?.signal === "joint-index")?.data?.vertices, 3);
      assert.equal(status(result, "skin-deformation"), "failed");
    });

    it("errors when the skin has fewer inverse bind matrices than joints", async () => {
      // the arms' joints have no matrix: they are bound at the origin, far from where the avatar's arms stand
      const { findings } = await run({ inverseBindCount: 12 });
      assert.deepEqual(signals(findings), ["error:bind-pose"]);
    });

    it("warns about a skinned mesh without joints or weights", async () => {
      const { result, findings } = await run({ noWeights: true });
      assert.deepEqual(signals(findings), ["warning:unweighted"]);
      assert.deepEqual(findings[0].data?.meshes, ["Band"]);
      assert.match(findings[0].message, /"Band" is a skinned mesh without joints or weights/);
      assert.equal(status(result, "skin-deformation"), "warning");
    });
  });

  it("reads a second set of influences: the four strongest of the eight move the vertex", async () => {
    // five influences on the chest; the weakest, on the far arm, is dropped as the client drops it
    const five = { Avatar_Spine2: 0.6, Avatar_Spine1: 0.2, Avatar_Spine: 0.1, Avatar_Hips: 0.06, Avatar_LeftArm: 0.04 };
    const { findings } = await run({ weights: (x) => (Math.abs(x) < 0.02 ? five : undefined) });
    assert.deepEqual(findings, []);
  });

  it("keeps the mirror search linear when thousands of vertices sit on one point", () => {
    // 40,000 vertices on two mirrored points: every one a candidate for every other without the cap
    const count = 40_000;
    const geometry = {
      vertexCount: count,
      positions: Float32Array.from({ length: count * 3 }, (_, i) => (i % 3 === 0 ? (Math.floor(i / 3) % 2 === 0 ? 0.1 : -0.1) : i % 3 === 1 ? 1.4 : 0)),
      influences: new Uint32Array(count * 4).fill(11),
      weights: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
      triangles: new Uint32Array(0),
      joints: config.rig.map((bone, slot) => ({ name: bone.name, carrier: bone.name, slot, bindOffset: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
      parts: [{ node: "Stack", start: 0, end: count }],
      invalidInfluences: 0,
      unweighted: []
    };
    const started = performance.now();
    const measured = measureGeometry(geometry, config);
    assert.ok(performance.now() - started < 5000, "the measurement took over 5 s");
    assert.equal(measured.symmetry?.pairs, count);
    assert.equal(measured.symmetry?.differing, 0);
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

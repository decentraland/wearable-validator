import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyShape } from "@dcl/schemas";
import { loadInput, manifest, validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import type { CheckContext, Finding } from "../../../types.js";
import { representationsMatch } from "./index.js";

// on the standing test skeleton the feet are at 0.08 m and the head at 1.6 m (a body of 1.52 m)
const pants = (offsetY = 0.07) => syntheticGlb({ standing: true, scale: 0.85, offset: [0, offsetY, 0] });
/** The pants' vertices on an unskinned mesh, drawn where its node puts them. */
const rigidPants = (nodeScale = 1) => syntheticGlb({ standing: true, skinned: false, scale: 0.85, offset: [0, 0.07, 0], nodeScale });
/** A cube spanning `from`–`to` of body height. */
const span = (from: number, to: number) => syntheticGlb({ standing: true, scale: 1.52 * (to - from), offset: [0, 0.08 + 1.52 * from, 0] });

function wearable(category: string, representations: unknown[]) {
  return { name: "Test Wearable", description: "synthetic", rarity: "common", data: { category, tags: ["test"], hides: [], replaces: [], representations } };
}

async function separate(category: string, male: Uint8Array, female: Uint8Array) {
  const manifest = wearable(category, [
    { bodyShapes: [BodyShape.MALE], mainFile: "male.glb", contents: ["male.glb"] },
    { bodyShapes: [BodyShape.FEMALE], mainFile: "female.glb", contents: ["female.glb"] }
  ]);
  return syntheticZip({ manifest, extraFiles: { "male.glb": male, "female.glb": female } });
}

async function shared(category: string, glb: Uint8Array) {
  return syntheticZip({ glb, manifest: wearable(category, [{ bodyShapes: [BodyShape.MALE, BodyShape.FEMALE], mainFile: "model.glb", contents: ["model.glb"] }]) });
}

/** The shared-model warning ships off (an empty list): these tests list the body garments to exercise it. */
async function withFittedCategories<T>(run: () => Promise<T>): Promise<T> {
  const before = manifest.representations.fittedCategories;
  manifest.representations.fittedCategories = ["upper_body", "lower_body"];
  try {
    return await run();
  } finally {
    manifest.representations.fittedCategories = before;
  }
}

describe("representations-match (M-15)", () => {
  it("passes separate versions that sit alike on their bodies", async () => {
    const result = await validate(await separate("lower_body", await pants(), await pants(0.1)), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.match(result.checks[0].measured ?? "", /male -?\d+%–\d+% · female/);
  });

  it("warns when one version sits far from the other on its body", async () => {
    const result = await validate(await separate("lower_body", await pants(), await pants(0.6)), { checks: ["representations-match"] });
    const [warning] = found(result, "representations-match");
    assert.equal(warning.severity, "warning");
    assert.match(warning.message, /sit differently on their bodies/);
    assert.equal(warning.where, "female.glb");
  });

  it("compares only the categories it was calibrated on: short male hair and shoulder-length female hair pass", async () => {
    assert.deepEqual(manifest.representations.comparedCategories, ["upper_body", "lower_body"]);
    // short male hair 103–113% of body height, shoulder-length female hair 77–113%: a 0.26 gap at the bottom edge
    const short = await span(1.03, 1.13);
    const long = await span(0.77, 1.13);
    const hair = await validate(await separate("hair", short, long), { checks: ["representations-match"] });
    assert.equal(status(hair, "representations-match"), "passed");
    assert.equal(hair.checks[0].measured, "hair is not compared");
    // the same pair as a top is past maxEdgeGap
    const top = await validate(await separate("upper_body", short, long), { checks: ["representations-match"] });
    assert.equal(found(top, "representations-match").length, 1);
  });

  it("reads quantized positions as metres", async () => {
    const floats = await validate(await separate("lower_body", await pants(), await pants(0.1)), { checks: ["representations-match"] });
    const quantized = await syntheticGlb({ standing: true, scale: 0.85, offset: [0, 0.1, 0], quantizedPositions: true });
    const result = await validate(await separate("lower_body", await pants(), quantized), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.equal(result.checks[0].measured, floats.checks[0].measured);
  });

  it("measures in bind pose, whatever pose the file was saved in", async () => {
    const bind = await validate(await separate("lower_body", await pants(), await pants(0.1)), { checks: ["representations-match"] });
    const posed = await syntheticGlb({ standing: true, scale: 0.85, offset: [0, 0.1, 0], pose: { Avatar_Hips: [0, 1.45, 0], Avatar_Head: [0, 2, 0.3] } });
    const result = await validate(await separate("lower_body", await pants(), posed), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.equal(result.checks[0].measured, bind.checks[0].measured);
  });

  it("measures an unskinned mesh where its node puts it", async () => {
    const skinned = await validate(await separate("lower_body", await pants(), await pants(0.1)), { checks: ["representations-match"] });
    const result = await validate(await separate("lower_body", await rigidPants(), await pants(0.1)), { checks: ["representations-match"] });
    assert.equal(result.checks[0].measured, skinned.checks[0].measured);
  });

  it("compares identical vertices as two versions when one node scales them 3×", async () => {
    const copy = await validate(await separate("lower_body", await rigidPants(), await rigidPants()), { checks: ["representations-match"] });
    assert.equal(copy.checks[0].measured, "one model for both bodies");
    const result = await validate(await separate("lower_body", await rigidPants(), await rigidPants(3)), { checks: ["representations-match"] });
    assert.match(result.checks[0].measured ?? "", /male -?\d+%–\d+% · female/);
    const [warning] = found(result, "representations-match");
    assert.match(warning.message, /sit differently on their bodies/);
  });

  it("does not measure a version whose skin leaves the head out of its joints", async () => {
    // the head node is there but not a joint: its node pose would only be right in bind pose, so nothing is compared
    const headless = await syntheticGlb({ standing: true, scale: 0.85, offset: [0, 0.6, 0], unskinnedBones: ["Avatar_Head"] });
    const result = await validate(await separate("lower_body", await pants(), headless), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.equal(result.checks[0].measured, "no head and feet bones to measure against");
  });

  it("does not flag one model worn by both bodies while no category is listed as fitted", async () => {
    assert.deepEqual(manifest.representations.fittedCategories, [], "the shared-model warning ships off");
    const result = await validate(await shared("lower_body", await pants()), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.equal(result.checks[0].measured, "one model for both bodies");
  });

  it("warns when one model is worn by both bodies and reaches past the hips, once its category is listed", async () => {
    const result = await withFittedCategories(async () => validate(await shared("lower_body", await pants()), { checks: ["representations-match"] }));
    const [warning] = found(result, "representations-match");
    assert.equal(warning.severity, "warning");
    assert.match(warning.message, /^"model\.glb" is worn by both body shapes and reaches past the hips/);
  });

  it("treats the same mesh uploaded twice as one model, even with another material name, and names both files", async () => {
    const copy = await syntheticGlb({ standing: true, scale: 0.85, offset: [0, 0.07, 0], materialName: "Female_MAT" });
    const result = await withFittedCategories(async () => validate(await separate("lower_body", await pants(), copy), { checks: ["representations-match"] }));
    assert.equal(result.checks[0].measured, "one model for both bodies");
    const [warning] = found(result, "representations-match");
    assert.match(warning.message, /^"male\.glb" and "female\.glb" are the same model, so both body shapes wear it, and it reaches past the hips/);
    assert.equal(warning.where, "female.glb");
  });

  it("leaves a short top that both bodies share alone", async () => {
    const top = await syntheticGlb({ standing: true, scale: 0.5, offset: [0, 0.9, 0] });
    const result = await withFittedCategories(async () => validate(await shared("upper_body", top), { checks: ["representations-match"] }));
    assert.equal(status(result, "representations-match"), "passed");
  });

  it("does not compare feet, which both bodies share by design", async () => {
    const shoes = await syntheticGlb({ standing: true, scale: 0.12, offset: [0, 0.02, 0] });
    const result = await validate(await shared("feet", shoes), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
    assert.equal(result.checks[0].measured, "feet is not compared");
  });

  it("finds nothing without a category", async () => {
    // validate() reports an unknown category itself (categoryDependent); the check stays silent if called without one
    const { ctx } = await loadInput(await separate("lower_body", await pants(), await pants(0.6)), {});
    assert.ok(ctx);
    const run = (context: CheckContext) => representationsMatch.run(context) as Finding[];
    assert.equal(run(ctx).length, 1, "the pair warns with its category");
    ctx.category = undefined;
    assert.deepEqual(run(ctx), []);
    assert.equal(representationsMatch.measure?.(ctx), "category unknown");
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["representations-match"] });
    assert.equal(result.checks.length, 0);
  });
});

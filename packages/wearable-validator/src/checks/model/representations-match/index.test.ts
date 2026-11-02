import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { invert } from "./index.js";

const MALE = "urn:decentraland:off-chain:base-avatars:BaseMale";
const FEMALE = "urn:decentraland:off-chain:base-avatars:BaseFemale";

// on the standing test skeleton the feet are at 0.08 m and the head at 1.6 m
const pants = (offsetY = 0.07) => syntheticGlb({ standing: true, scale: 0.85, offset: [0, offsetY, 0] });

function wearable(category: string, representations: unknown[]) {
  return { name: "Test Wearable", description: "synthetic", rarity: "common", data: { category, tags: ["test"], hides: [], replaces: [], representations } };
}

async function separate(category: string, male: Uint8Array, female: Uint8Array) {
  const manifest = wearable(category, [
    { bodyShapes: [MALE], mainFile: "male.glb", contents: ["male.glb"] },
    { bodyShapes: [FEMALE], mainFile: "female.glb", contents: ["female.glb"] }
  ]);
  return syntheticZip({ manifest, extraFiles: { "male.glb": male, "female.glb": female } });
}

async function shared(category: string, glb: Uint8Array) {
  return syntheticZip({ glb, manifest: wearable(category, [{ bodyShapes: [MALE, FEMALE], mainFile: "model.glb", contents: ["model.glb"] }]) });
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

  it("warns when one model is worn by both bodies and reaches past the hips", async () => {
    const result = await validate(await shared("lower_body", await pants()), { checks: ["representations-match"] });
    const [warning] = found(result, "representations-match");
    assert.equal(warning.severity, "warning");
    assert.match(warning.message, /worn by both body shapes and reaches past the hips/);
  });

  it("treats the same mesh uploaded twice as one model, even with another material name", async () => {
    const copy = await syntheticGlb({ standing: true, scale: 0.85, offset: [0, 0.07, 0], materialName: "Female_MAT" });
    const result = await validate(await separate("lower_body", await pants(), copy), { checks: ["representations-match"] });
    assert.equal(result.checks[0].measured, "one model for both bodies");
    const [warning] = found(result, "representations-match");
    assert.match(warning.message, /worn by both body shapes and reaches past the hips/);
  });

  it("inverts bind matrices with rotation and scale", () => {
    // 90° about X, scale 2, then (1, 2, 3): column-major
    const m = [2, 0, 0, 0, 0, 0, 2, 0, 0, -2, 0, 0, 1, 2, 3, 1];
    const inverse = invert(m)!;
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += m[k * 4 + row] * inverse[col * 4 + k];
        assert.ok(Math.abs(sum - (row === col ? 1 : 0)) < 1e-9, `m × m⁻¹ at row ${row}, column ${col} is ${sum}`);
      }
    }
    assert.equal(invert(new Array(16).fill(0)), null);
  });

  it("leaves a short top that both bodies share alone", async () => {
    const top = await syntheticGlb({ standing: true, scale: 0.5, offset: [0, 0.9, 0] });
    const result = await validate(await shared("upper_body", top), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
  });

  it("does not compare feet, which both bodies share by design", async () => {
    const shoes = await syntheticGlb({ standing: true, scale: 0.12, offset: [0, 0.02, 0] });
    const result = await validate(await shared("feet", shoes), { checks: ["representations-match"] });
    assert.equal(status(result, "representations-match"), "passed");
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["representations-match"] });
    assert.equal(result.checks.length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("texture-maps (M-05)", () => {
  it("warns for each map the avatar shader ignores, naming it (curators' decision: flag it, do not reject)", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      textureImages: [
        { slot: "normal", size: 32 },
        { slot: "metallicRoughness", size: 16 },
        { slot: "occlusion", size: 8 }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    const findings = found(result, "texture-maps");
    assert.equal(findings.length, 3);
    for (const f of findings) assert.equal(f.severity, "warning");
    assert.deepEqual(
      findings.map((f) => f.data?.map).sort(),
      ["metallicRoughnessTexture", "normalTexture", "occlusionTexture"]
    );
  });

  it("does not stop an item whose only finding is a normal map", async () => {
    // like Fishing World Gear / Half Sardine, approved with a normal map on its material
    const glb = await syntheticGlb({ texture: { size: 64 }, textureImages: [{ slot: "normal", size: 32 }] });
    const result = await validate(await syntheticZip({ glb }));
    assert.equal(found(result, "texture-maps").length, 1);
    assert.equal(result.findings.filter((f) => f.severity === "error").length, 0);
    assert.equal(result.passed, true);
  });

  it("passes base color + emissive", async () => {
    const glb = await syntheticGlb({ texture: { size: 64 }, textureImages: [{ slot: "emissive", size: 32 }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    assert.equal(found(result, "texture-maps").length, 0);
  });
});

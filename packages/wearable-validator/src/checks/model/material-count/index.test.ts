import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("material-count (M-06)", () => {
  it("errors above the default limit", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    const findings = found(result, "material-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 3);
    assert.equal(findings[0].limit, 2);
  });

  it("excludes AvatarSkin_MAT from the count", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "AvatarSkin_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    assert.equal(found(result, "material-count").length, 0);
  });

  it("accepts a third material when one of them is emissive or transparent (curators' decision)", async () => {
    // like Antrom WildBonds: a base material, a glowing one and a transparent one
    const cases = [
      [{ name: "Glow_MAT", emissiveFactor: [1, 1, 1] as [number, number, number] }, { name: "Third_MAT" }],
      [{ name: "Glass_MAT", alphaMode: "BLEND" as const }, { name: "Third_MAT" }],
      [{ name: "Cutout_MAT", alphaMode: "MASK" as const }, { name: "Third_MAT" }],
      [{ name: "GlowTex_MAT", emissiveFactor: [1, 1, 1] as [number, number, number], textures: [{ slot: "emissive" as const, size: 16 }] }, { name: "Third_MAT" }]
    ];
    for (const extraMaterialDefs of cases) {
      const glb = await syntheticGlb({ extraMaterialDefs });
      const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
      assert.equal(found(result, "material-count").length, 0, extraMaterialDefs[0].name);
    }
  });

  it("rejects a third material when none is emissive or transparent, and says what would allow it", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }] });
    const [finding] = found(await validate(await syntheticZip({ glb }), { checks: ["material-count"] }), "material-count");
    assert.equal(finding.limit, 2);
    assert.match(finding.message, /Up to 3 are accepted only when one of them is emissive or transparent/);
  });

  it("does not count an emissive texture with a black factor as emission: nothing glows", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "DeadGlow_MAT", textures: [{ slot: "emissive", size: 16 }] }, { name: "Third_MAT" }] });
    const [finding] = found(await validate(await syntheticZip({ glb }), { checks: ["material-count"] }), "material-count");
    assert.equal(finding.severity, "error");
    assert.equal(finding.limit, 2);
  });

  it("leaves the hint out when emission or transparency would not be enough", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }, { name: "Fourth_MAT" }] });
    const [finding] = found(await validate(await syntheticZip({ glb }), { checks: ["material-count"] }), "material-count");
    assert.equal(finding.measured, 4);
    assert.doesNotMatch(finding.message, /emissive or transparent/);
  });

  it("rejects a fourth material even with emission and transparency", async () => {
    const glb = await syntheticGlb({
      extraMaterialDefs: [{ name: "Glow_MAT", emissiveFactor: [1, 1, 1] }, { name: "Glass_MAT", alphaMode: "BLEND" }, { name: "Fourth_MAT" }]
    });
    const [finding] = found(await validate(await syntheticZip({ glb }), { checks: ["material-count"] }), "material-count");
    assert.equal(finding.severity, "error");
    assert.equal(finding.measured, 4);
    assert.equal(finding.limit, 3);
  });

  it("allows 5 materials for skins", async () => {
    const glb = await syntheticGlb({
      extraMaterialDefs: [{ name: "M2" }, { name: "M3" }, { name: "M4" }, { name: "M5" }]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-count"] });
    assert.equal(found(result, "material-count").length, 0);
  });
});

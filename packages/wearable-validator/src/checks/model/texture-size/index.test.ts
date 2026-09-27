import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("texture-size (M-03)", () => {
  it("errors on textures over 512 on either axis", async () => {
    const glb = await syntheticGlb({ texture: { size: 1024 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "1024×1024");
  });

  it("still measures a texture whose PNG carries trailing bytes, and errors on one whose header cannot be read", async () => {
    const png = pngBytes(1024, 1024);
    const trailing = new Uint8Array(png.length + 1);
    trailing.set(png);
    const result = await validate(await syntheticZip({ glb: await syntheticGlb({ texture: { size: 1024, bytes: trailing } }) }), { checks: ["texture-size"] });
    assert.equal(found(result, "texture-size")[0]?.measured, "1024×1024");
    const damaged = await validate(await syntheticZip({ glb: await syntheticGlb({ texture: { size: 8, bytes: png.subarray(0, 28) } }) }), { checks: ["texture-size"] });
    const findings = found(damaged, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /cannot be read/);
  });

  it("tells two images with the same name apart by where each is used", async () => {
    const glb = await syntheticGlb({
      materialName: "M002T",
      textureImages: [
        { name: "M002", slot: "baseColor", bytes: pngBytes(515, 512) },
        { name: "M002", slot: "emissive", bytes: pngBytes(515, 512, true) }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const places = [...new Set(found(result, "texture-size").map((finding) => finding.where))].sort();
    assert.deepEqual(places, ['"model.glb" › M002 (base color of M002T)', '"model.glb" › M002 (emissive of M002T)']);
  });

  it("errors on non-square textures", async () => {
    const glb = await syntheticGlb({ texture: { size: 512, nonSquare: true } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /square/);
  });

  it("warns on square non-power-of-two textures", async () => {
    const glb = await syntheticGlb({ texture: { size: 300 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /power of two/);
  });

  it("passes a 512×512 texture", async () => {
    const glb = await syntheticGlb({ texture: { size: 512 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    assert.equal(found(result, "texture-size").length, 0);
  });

  it("facial features over 256 are errors", async () => {
    const result = await validate(pngBytes(512, 512), { category: "eyes", checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, "256×256");
  });

  it("facial features without alpha are errors", async () => {
    const result = await validate(pngBytes(256, 256, true, 3), { category: "mouth", checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /alpha/);
  });

  it("warns once with category-unknown on a bare GLB without a hint", async () => {
    const glb = await syntheticGlb({ texture: { size: 1024 } });
    const result = await validate(glb, { checks: ["texture-size"] });
    const findings = found(result, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });
});

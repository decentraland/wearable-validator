import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifest, validate } from "../../../index.js";
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

  it("excludes every material the engine treats as skin, not only the exact name", async () => {
    // Blender names a second copy AvatarSkin_MAT.001; the explorer tints any material with "skin" in its name
    for (const name of ["AvatarSkin_MAT.001", "AvatarSkin_F_MAT.002", "Avatar_Skin", "skin"]) {
      const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name }] });
      const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
      assert.equal(found(result, "material-count").length, 0, name);
    }
  });

  it("an empty skin token exempts nothing", async () => {
    const { isSkinMaterial } = await import("../../../logic/materials.js");
    const { Document } = await import("@gltf-transform/core");
    assert.equal(isSkinMaterial(new Document().createMaterial("AvatarSkin_MAT"), ""), false);
    assert.notEqual(manifest.materials.skinNameToken, "");
  });

  it("still counts every other material when a skin copy is present", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }, { name: "AvatarSkin_MAT.001" }] });
    const findings = found(await validate(await syntheticZip({ glb }), { checks: ["material-count"] }), "material-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].measured, 3);
  });

  it("allows 5 materials for skins", async () => {
    const glb = await syntheticGlb({
      extraMaterialDefs: [{ name: "M2" }, { name: "M3" }, { name: "M4" }, { name: "M5" }]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-count"] });
    assert.equal(found(result, "material-count").length, 0);
  });
});

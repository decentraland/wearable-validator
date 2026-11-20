import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("material-names (M-07)", () => {
  it("warns when a skin item has no AvatarSkin_MAT material", async () => {
    const result = await validate(await syntheticZip({ category: "skin" }), { checks: ["material-names"] });
    const findings = found(result, "material-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /AvatarSkin_MAT/);
  });

  it("passes a skin item whose skin material is a copy the engine still tints", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "AvatarSkin_MAT.001" }] });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-names"] });
    assert.equal(found(result, "material-names").length, 0);
  });

  it("passes a skin item that includes AvatarSkin_MAT", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "AvatarSkin_MAT" }] });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-names"] });
    assert.equal(found(result, "material-names").length, 0);
  });

  it("errors on reserved facial tokens in mesh names of non-facial items", async () => {
    const glb = await syntheticGlb({ meshName: "cube_Eyes" });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-names"] });
    const findings = found(result, "material-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.pattern, "_eyes");
  });

  it("passes a plain mesh name", async () => {
    const result = await validate(await syntheticZip(), { checks: ["material-names"] });
    assert.equal(found(result, "material-names").length, 0);
  });
});

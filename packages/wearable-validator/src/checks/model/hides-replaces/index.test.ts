import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyShape } from "@dcl/schemas";
import { manifest, validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

const { skinMustHide } = manifest.hides;
const CHECK = { checks: ["hides-replaces"] };

describe("hides-replaces (M-12)", () => {
  it("warns when hides contains the item's own category, without calling it harmless", async () => {
    const zip = await wearableZip({}, { hides: ["hat"] });
    const result = await validate(zip, CHECK);
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /own category "hat"\. An item cannot hide itself/);
    assert.doesNotMatch(findings[0].message, /harmless/);
  });

  it("warns when replaces contains the item's own category", async () => {
    const zip = await wearableZip({}, { replaces: ["hat"] });
    const result = await validate(zip, CHECK);
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.doesNotMatch(findings[0].message, /harmless/);
  });

  it("warns on a skin that hides nothing, naming every accessory slot", async () => {
    const result = await validate(await wearableZip({}, { category: "skin", hides: [] }), CHECK);
    const findings = found(result, "hides-replaces");
    assert.equal(status(result, "hides-replaces"), "warning");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.deepEqual(findings[0].data?.missing, skinMustHide);
    assert.match(findings[0].message, /This skin does not hide mask, eyewear, .* and helmet/);
    assert.equal(findings[0].limit, `all ${skinMustHide.length}`);
  });

  it("names only the slots a skin leaves out", async () => {
    const hides = skinMustHide.filter((slot) => slot !== "top_head");
    const result = await validate(await wearableZip({}, { category: "skin", hides }), CHECK);
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].data?.missing, ["top_head"]);
    assert.match(findings[0].message, /does not hide top head \(1 of the/);
  });

  it("passes a skin that hides every accessory slot: the engine hides the head, hands and clothes itself", async () => {
    const result = await validate(await wearableZip({}, { category: "skin", hides: skinMustHide }), CHECK);
    assert.equal(status(result, "hides-replaces"), "passed");
  });

  it("counts replaces and a version's overrideHides as hidden, and reports a version that hides less", async () => {
    const replaced = await validate(await wearableZip({}, { category: "skin", hides: skinMustHide.slice(1), replaces: skinMustHide.slice(0, 1) }), CHECK);
    assert.equal(status(replaced, "hides-replaces"), "passed");
    const glb = await syntheticGlb();
    const representations = [
      { bodyShapes: [BodyShape.MALE], mainFile: "male.glb", contents: ["male.glb"], overrideHides: [] },
      { bodyShapes: [BodyShape.FEMALE], mainFile: "female.glb", contents: ["female.glb"], overrideHides: ["hat"] }
    ];
    const zip = await syntheticZip({
      glb,
      extraFiles: { "male.glb": glb, "female.glb": glb },
      manifest: { name: "Test", description: "synthetic", rarity: "common", data: { category: "skin", tags: [], hides: skinMustHide, replaces: [], representations } }
    });
    const findings = found(await validate(zip, CHECK), "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].where, "female.glb");
    assert.deepEqual(findings[0].data?.missing, skinMustHide.filter((slot) => slot !== "hat"));
  });

  it("passes a plain wearable", async () => {
    const hat = await validate(await wearableZip({}, { hides: ["mask"] }), CHECK);
    assert.equal(status(hat, "hides-replaces"), "passed");
  });

  it("is not applicable without metadata", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { ...CHECK, category: "hat" });
    assert.equal(result.checks.length, 0);
  });
});

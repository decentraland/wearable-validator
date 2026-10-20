import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("hides-replaces (M-12)", () => {
  it("warns when hides contains the item's own category", async () => {
    const zip = await wearableZip({}, { hides: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /own category/);
  });

  it("warns when replaces contains the item's own category", async () => {
    const zip = await wearableZip({}, { replaces: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("passes a skin that hides nothing: the client hides the base body under every skin", async () => {
    const skin = await validate(await wearableZip({}, { category: "skin", hides: ["head", "hands_wear"] }), { checks: ["hides-replaces"] });
    assert.equal(status(skin, "hides-replaces"), "passed");
    const bare = await validate(await wearableZip({}, { category: "skin", hides: [] }), { checks: ["hides-replaces"] });
    assert.equal(status(bare, "hides-replaces"), "passed");
  });

  it("passes a plain wearable", async () => {
    const hat = await validate(await wearableZip({}, { hides: ["mask"] }), { checks: ["hides-replaces"] });
    assert.equal(status(hat, "hides-replaces"), "passed");
  });

  it("is not applicable without metadata", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["hides-replaces"], category: "hat" });
    assert.equal(result.checks.length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("triangle-count (M-01)", () => {
  it("errors when triangles exceed the category budget by more than 10%", async () => {
    const zip = await wearableZip({ triangles: 1700 }); // hat budget: 1500, tolerated up to 1650
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 1700);
    assert.equal(findings[0].limit, 1500);
    assert.match(findings[0].message, /1700 triangles, 14% over the limit of 1500 for hat; up to 10% over \(1650\) is accepted/);
    assert.equal(status(result, "triangle-count"), "failed");
  });

  it("warns, without failing, when triangles are at most 10% over the budget", async () => {
    const result = await validate(await wearableZip({ triangles: 1600 }), { checks: ["triangle-count"] });
    const [warning] = found(result, "triangle-count");
    assert.equal(warning.severity, "warning");
    assert.deepEqual([warning.measured, warning.limit, warning.data?.tolerated], [1600, 1500, 1650]);
    assert.match(warning.message, /1600 triangles, 7% over the limit of 1500 for hat\. Up to 10% over \(1650\) is accepted with a warning/);
    assert.equal(status(result, "triangle-count"), "warning");
  });

  it("draws the line at exactly 10% over: 1,650 warns for a 1,500 budget, 1,651 fails", async () => {
    const [edge] = found(await validate(await wearableZip({ triangles: 1650 }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(edge.severity, "warning");
    const [past] = found(await validate(await wearableZip({ triangles: 1651 }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(past.severity, "error");
    assert.match(past.message, /11% over/, "never reads as 10% over while failing");
  });

  it("applies the margin to the pooled budget, not the category's base", async () => {
    // a jacket hiding the hands: 1,500 + 500 = 2,000, tolerated up to 2,200
    const within = await validate(await wearableZip({ triangles: 2150 }, { category: "upper_body", hides: ["hands"] }), { checks: ["triangle-count"] });
    assert.equal(status(within, "triangle-count"), "warning");
    const past = await validate(await wearableZip({ triangles: 2250 }, { category: "upper_body", hides: ["hands"] }), { checks: ["triangle-count"] });
    assert.equal(status(past, "triangle-count"), "failed");
  });

  it("pools hidden-slot budgets into the limit", async () => {
    const zip = await wearableZip({ triangles: 1600 }, { hides: ["mask"] }); // 1500 + 500
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
    assert.equal(status(result, "triangle-count"), "passed");
  });

  const representation = (overrideHides?: string[]) => [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"], ...(overrideHides ? { overrideHides } : {}) }];

  it("reads a representation's overrideHides: a hands accessory hiding the base hand there gets 1,500", async () => {
    const hidden = await validate(await wearableZip({ triangles: 1200 }, { category: "hands_wear", representations: representation(["hands"]) }), { checks: ["triangle-count"] });
    assert.equal(status(hidden, "triangle-count"), "passed");
    const shown = await validate(await wearableZip({ triangles: 1200 }, { category: "hands_wear", representations: representation() }), { checks: ["triangle-count"] });
    assert.equal(found(shown, "triangle-count")[0]?.limit, 1000);
  });

  it("lets a representation's overrideHides replace the item's hides, as the engine does", async () => {
    const zip = await wearableZip({ triangles: 2500 }, { category: "upper_body", hides: ["lower_body"], representations: representation(["mask"]) });
    const [finding] = found(await validate(zip, { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(finding.limit, 2000, "1,500 + the mask's 500, not the item's lower_body");
  });

  it("caps a helmet at 4,000 however many head slots it hides", async () => {
    const allHead = ["head", "earring", "eyewear", "tiara", "hat", "facial_hair", "hair", "top_head"];
    const [over] = found(await validate(await wearableZip({ triangles: 4100 }, { category: "helmet", hides: allHead }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(over.limit, 4000);
    assert.equal(status(await validate(await wearableZip({ triangles: 3900 }, { category: "helmet", hides: allHead }), { checks: ["triangle-count"] }), "triangle-count"), "passed");
    const [hair] = found(await validate(await wearableZip({ triangles: 3100 }, { category: "helmet", hides: ["hair"] }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(hair.limit, 3000, "fewer hidden slots still pool below the cap");
  });

  it("adds the base hands' 500 to any item that hides them (a jacket covering the hands)", async () => {
    const zip = await wearableZip({ triangles: 1594 }, { category: "upper_body", hides: ["hands"] });
    assert.equal(status(await validate(zip, { checks: ["triangle-count"] }), "triangle-count"), "passed");
    const [over] = found(await validate(await wearableZip({ triangles: 2100 }, { category: "upper_body", hides: ["hands"] }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(over.limit, 2000);
  });

  it("does not add an item's own slot to its budget when it hides it", async () => {
    const [hat] = found(await validate(await wearableZip({ triangles: 1600 }, { category: "hat", hides: ["hat"] }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(hat.limit, 1500);
  });

  it("counts hiding the head as hiding every head slot, up to 4,000", async () => {
    const [mask] = found(await validate(await wearableZip({ triangles: 4100 }, { category: "mask", hides: ["head"] }), { checks: ["triangle-count"] }), "triangle-count");
    assert.equal(mask.limit, 4000);
    assert.equal(status(await validate(await wearableZip({ triangles: 3900 }, { category: "helmet", hides: ["head"] }), { checks: ["triangle-count"] }), "triangle-count"), "passed");
  });

  it("warns on TRIANGLE_STRIP/FAN primitives", async () => {
    const zip = await wearableZip({ stripVertices: 5 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /STRIP/);
  });

  it("excludes collider nodes from the count", async () => {
    const zip = await wearableZip({ triangles: 12, colliderTriangles: 5000 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
  });

  it("warns category-unknown on a bare GLB without a hint", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("triangle-count (M-01)", () => {
  it("errors when triangles exceed the category budget", async () => {
    const zip = await wearableZip({ triangles: 1600 }); // hat budget: 1500
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 1600);
    assert.equal(findings[0].limit, 1500);
    assert.equal(status(result, "triangle-count"), "failed");
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

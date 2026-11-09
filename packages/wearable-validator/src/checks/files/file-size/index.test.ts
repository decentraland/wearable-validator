import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { padBytes } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";

describe("file-size (S-05)", () => {
  it("errors on total size and on the model-alone headroom", async () => {
    const glb = padBytes(await syntheticGlb(), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.equal(findings[0].limit, 3145728); // total, from the manifest
    assert.equal(findings[1].limit, 3145728 - 1048576); // model alone ≤ limit − headroom
    assert.equal(findings[1].where, "model.glb");
  });

  it("counts a file both body shapes share once, as the catalyst counts unique content hashes", async () => {
    const glb = padBytes(await syntheticGlb(), 1_600_000);
    const shared = await validate(await syntheticZip({ glb, extraFiles: { "female/model.glb": glb } }), { checks: ["file-size"] });
    assert.equal(only(shared.findings, "file-size").length, 0, "the same 1.6 MB twice is one 1.6 MB upload");
    const other = padBytes(await syntheticGlb({ triangles: 20 }), 1_600_000);
    const distinct = await validate(await syntheticZip({ glb, extraFiles: { "female/model.glb": other } }), { checks: ["file-size"] });
    assert.equal(only(distinct.findings, "file-size").length, 1, "two different files both count");
  });

  it("gives skins the skin budget", async () => {
    const glb = padBytes(await syntheticGlb(), 4_000_000);
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });

  it("applies the emote budget to emotes, as the item total only", async () => {
    const glb = padBytes(await syntheticGlb({ animation: { name: "Pose_Avatar", seconds: 2 } }), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb, kind: "emote" }), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 1, "no separate model-alone error for an emote");
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, 3145728);
    assert.match(findings[0].message, /emote/);
  });

  it("passes an emote whose model is over 2 MB while the item stays under 3 MB (curators' decision)", async () => {
    // like Master of the Dead (2.12 MB model) and Lolth (2.32 MB), approved and published
    const glb = padBytes(await syntheticGlb({ animation: { name: "Pose_Avatar", seconds: 2 } }), 2_500_000);
    const result = await validate(await syntheticZip({ glb, kind: "emote" }), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });

  it("still holds a wearable's model alone to the ceiling minus the headroom", async () => {
    const glb = padBytes(await syntheticGlb(), 2_500_000);
    const [model] = only((await validate(await syntheticZip({ glb }), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(model.limit, 3145728 - 1048576);
    assert.equal(model.where, "model.glb");
  });

  it("warns once with category-unknown on a bare GLB without a hint", async () => {
    const findings = only((await validate(await syntheticGlb(), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });

  it("passes a small wearable", async () => {
    const result = await validate(await syntheticZip(), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });
});

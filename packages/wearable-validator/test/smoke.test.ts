import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checks, validate } from "../src/index.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("plumbing smoke", () => {
  it("runs on a synthetic wearable zip and returns a result", async () => {
    const zip = await syntheticZip();
    const result = await validate(zip);
    assert.equal(typeof result.summary.checked, "number");
    assert.ok(Array.isArray(result.findings));
  });

  it("bare GLB never mints a verdict", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb);
    assert.equal(result.passed, null);
  });

  // a facial feature is a PNG set: the model checks cannot run on it, so it is never fully asserted
  const facial = (size: number) => {
    const representation = { bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "eyes.png", contents: ["eyes.png", "eyes_mask.png"] };
    const manifest = { name: "Big Eyes", description: "synthetic", rarity: "common", data: { category: "eyes", tags: [], hides: [], replaces: [], representations: [representation] } };
    return syntheticZip({ manifest, extraFiles: { "eyes.png": pngBytes(size, size), "eyes_mask.png": pngBytes(size, size) } });
  };

  it("fails a full run on an error even when some checks could not run (a facial feature over the size limit)", async () => {
    const result = await validate(await facial(1100));
    assert.ok(result.checks.some((row) => row.status === "skipped"), "the model checks skip a PNG set");
    assert.ok(result.findings.some((finding) => finding.severity === "error"));
    assert.equal(result.passed, false);
  });

  it("leaves a full run without errors undecided when some checks could not run", async () => {
    const result = await validate(await facial(256));
    assert.equal(result.findings.filter((finding) => finding.severity === "error").length, 0);
    assert.equal(result.passed, null);
  });

  it("still never mints a verdict for a subset of checks, errors or not", async () => {
    const result = await validate(await facial(1100), { checks: ["file-format"] });
    assert.ok(result.findings.some((finding) => finding.severity === "error"));
    assert.equal(result.passed, null);
  });

  it("still never mints a verdict for a subset of groups, errors or not", async () => {
    const result = await validate(await facial(1100), { groups: ["files"] });
    assert.ok(result.findings.some((finding) => finding.severity === "error"));
    assert.equal(result.passed, null);
  });

  it("fails a full run on a broken model: the model checks skip it, file-format errors", async () => {
    const result = await validate(await syntheticZip({ glb: new TextEncoder().encode("not a real model at all, sorry!!") }));
    assert.ok(result.checks.some((row) => row.status === "skipped"));
    assert.ok(result.findings.some((finding) => finding.check === "file-format" && finding.severity === "error"));
    assert.equal(result.passed, false);
  });

  it("fails a full run on an error even when another check throws", async () => {
    const texture = checks["texture-size"];
    const run = texture.run;
    texture.run = () => { throw new Error("boom"); };
    try {
      const result = await validate(await syntheticZip({ glb: await syntheticGlb({ triangles: 5000 }) }));
      assert.equal(result.checks.find((row) => row.check === "texture-size")?.status, "errored");
      assert.ok(result.findings.some((finding) => finding.check === "triangle-count" && finding.severity === "error"));
      assert.equal(result.passed, false);
    } finally {
      texture.run = run;
    }
  });

  it("bad bytes yield a file-format finding, never a throw", async () => {
    const result = await validate(new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(result.passed, false);
    assert.equal(result.findings[0].check, "file-format");
  });

  it("unknown check name throws (programmer error)", async () => {
    await assert.rejects(() => validate(new Uint8Array([1]), { checks: ["nope"] }), /Unknown check/);
  });
});

describe("progress events", () => {
  it("reports every check starting and finishing, in registry order, without changing the result", async () => {
    const events: string[] = [];
    const result = await validate(await syntheticZip(), {
      onProgress: (event) => events.push(event.type === "check-started" ? `>${event.check}` : `<${event.result.check}:${event.result.status}`)
    });
    const names = result.checks.map((row) => row.check);
    assert.deepEqual(events.filter((e) => e.startsWith(">")).map((e) => e.slice(1)), names);
    assert.deepEqual(events.filter((e) => e.startsWith("<")).map((e) => e.slice(1)), result.checks.map((row) => `${row.check}:${row.status}`));
    for (let i = 0; i < names.length; i++) assert.equal(events.indexOf(`>${names[i]}`) < events.findIndex((e) => e.startsWith(`<${names[i]}:`)), true);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";

describe("smart-wearable (S-11)", () => {
  it("is not applicable to a plain wearable with no empty files", async () => {
    const result = await validate(await syntheticZip(), { checks: ["smart-wearable"] });
    assert.equal(result.checks.length, 0);
  });

  it("reports stray 0-byte files even on non-smart items", async () => {
    const zip = await syntheticZip({ extraFiles: { "stray.txt": new Uint8Array(0) } });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "stray.txt");
    assert.match(findings[0].message, /0-byte/);
  });

  it("errors when scene.json points at a missing bundle", async () => {
    const zip = await syntheticZip({ extraFiles: { "scene.json": enc(JSON.stringify({ main: "bin/game.js" })) } });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /bin\/game\.js/);
  });

  it("warns on permissions outside the allowed set", async () => {
    const zip = await syntheticZip({
      extraFiles: {
        "scene.json": enc(JSON.stringify({ main: "game.js", requiredPermissions: ["ALLOW_EVERYTHING"] })),
        "game.js": enc("//bundle")
      }
    });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.permission, "ALLOW_EVERYTHING");
  });

  it("errors on a video over the size cap (size only, never decoded)", async () => {
    const videoLimit = 262144000; // manifest smartWearableVideoBytes
    const files = new Map<string, Uint8Array>([
      ["scene.json", enc(JSON.stringify({ main: "game.js" }))],
      ["game.js", enc("//bundle")],
      ["intro.mp4", new Uint8Array(videoLimit + 1)]
    ]);
    const findings = only(
      (await validate({ files }, { checks: ["smart-wearable"], maxInputBytes: 400 * 1024 * 1024 })).findings,
      "smart-wearable"
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "intro.mp4");
    assert.equal(findings[0].limit, videoLimit);
  });

  it("passes a complete smart wearable with allowed permissions", async () => {
    const zip = await syntheticZip({
      extraFiles: {
        "scene.json": enc(JSON.stringify({ main: "game.js", requiredPermissions: ["USE_FETCH"] })),
        "game.js": enc("//bundle")
      }
    });
    const result = await validate(zip, { checks: ["smart-wearable"] });
    assert.equal(only(result.findings, "smart-wearable").length, 0);
    assert.equal(result.checks[0]?.status, "passed");
  });

  it("reads a scene bundle in each body shape's folder, as the Builder keeps them, resolving the main script from there", async () => {
    const bundle = (folder: string) => ({ [`${folder}/scene.json`]: enc(JSON.stringify({ main: "bin/game.js" })), [`${folder}/bin/game.js`]: enc("//bundle") });
    const both = await validate(await syntheticZip({ extraFiles: { ...bundle("male"), ...bundle("female") } }), { checks: ["smart-wearable"] });
    assert.equal(only(both.findings, "smart-wearable").length, 0, "male/scene.json → male/bin/game.js");
    const missing = await validate(await syntheticZip({ extraFiles: { ...bundle("male"), "female/scene.json": enc(JSON.stringify({ main: "bin/game.js" })) } }), { checks: ["smart-wearable"] });
    assert.deepEqual(only(missing.findings, "smart-wearable").map((finding) => finding.where), ["female/bin/game.js"], "each folder needs its own bundle");
    const escaping = await validate(await syntheticZip({ extraFiles: { "male/scene.json": enc(JSON.stringify({ main: "../../game.js" })), "game.js": enc("//bundle") } }), { checks: ["smart-wearable"] });
    assert.equal(only(escaping.findings, "smart-wearable").length, 1, "a main script outside the item is never found");
  });

  it("refuses a scene.json that is not a JSON object", async () => {
    const zip = await syntheticZip({ extraFiles: { "scene.json": enc("null"), "game.js": enc("//bundle") } });
    assert.match(only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable")[0].message, /not a valid scene definition/);
  });
});

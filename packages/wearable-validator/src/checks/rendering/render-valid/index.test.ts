import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { digest } from "../../../logic/captures.js";
import { subjectRatio } from "../../../logic/pixels.js";
import { manifest } from "../../../manifest/index.js";
import type { Renderer } from "../../../types.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { renderedFrame } from "#test/helpers/frames.js";

const SIZE = manifest.rendering.imageSizePx;

const frame = (subject: boolean): Uint8Array => renderedFrame(SIZE, subject);

function renderer(bytesFor: (id: string) => Uint8Array) {
  const rendered: string[][] = [];
  const service: Renderer = {
    buildId: "test-renderer",
    capture: async (_input, requests) => {
      rendered.push(requests.map((request) => request.id));
      return Promise.all(requests.map(async (request) => {
        const bytes = bytesFor(request.id);
        return { request, bytes, sha256: await digest(bytes), width: SIZE, height: SIZE };
      }));
    },
    stop: async () => {}
  };
  return { service, rendered };
}

describe("render-valid (V-01)", () => {
  it("measures a drawn block as subject and a bare gradient as nothing", () => {
    assert.ok(subjectRatio(frame(true), manifest.renderValid.backgroundTolerance)! > 0.2);
    assert.equal(subjectRatio(frame(false), manifest.renderValid.backgroundTolerance), 0);
  });

  it("passes a wearable that draws on both body shapes from two item-alone front views", async () => {
    const mock = renderer(() => frame(true));
    const result = await validate(await syntheticZip(), { checks: ["render-valid"], services: { renderer: mock.service } });
    assert.equal(result.checks[0].status, "passed");
    assert.deepEqual(mock.rendered, [["BaseMale-wearable-000", "BaseFemale-wearable-000"]]);
    assert.match(result.checks[0].measured ?? "", /2 views/);
    assert.equal(result.passed, null);
  });

  it("errors per body shape that renders nothing, citing the capture", async () => {
    const mock = renderer((id) => frame(!id.startsWith("BaseFemale")));
    const result = await validate(await syntheticZip(), { checks: ["V-01"], services: { renderer: mock.service } });
    assert.equal(result.checks[0].status, "failed");
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].message, /BaseFemale/);
    assert.deepEqual(result.findings[0].evidence, [{ captureId: "BaseFemale-wearable-000" }]);
    assert.equal(result.findings[0].limit, `≥ ${(manifest.renderValid.minSubjectRatio * 100).toFixed(1)}%`);
  });

  it("uses the avatar at the clip start for emotes", async () => {
    const mock = renderer(() => frame(true));
    const input = await syntheticZip({
      kind: "emote",
      manifest: {
        name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "simple",
        representations: [{ bodyShapes: manifest.rendering.bodyShapes, mainFile: "model.glb", contents: ["model.glb"] }]
      }
    });
    await validate(input, { checks: ["render-valid"], services: { renderer: mock.service } });
    assert.deepEqual(mock.rendered, [["BaseMale-avatar-000-t0", "BaseFemale-avatar-000-t0"]]);
  });

  it("is skipped, never passed, without a renderer", async () => {
    const result = await validate(await syntheticZip(), { checks: ["render-valid"] });
    assert.equal(result.checks[0].status, "skipped");
    assert.equal(result.checks[0].coverage, "missing");
  });

  it("asks for its two front views but the run renders the whole recipe once, up front", async () => {
    const mock = renderer(() => frame(true));
    const result = await validate(await syntheticZip(), { groups: ["rendering"], services: { renderer: mock.service } });
    // one batch: the two front views first, then the ten rest-pose views and the sixteen-frame motion pass the rules after it will need
    assert.deepEqual(mock.rendered.map((batch) => batch.length), [28]);
    assert.equal(result.captures.length, 28);
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:skipped", "visual-quality:skipped"]);
  });
});

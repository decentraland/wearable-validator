import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { digest } from "../../../logic/captures.js";
import { subjectRatio } from "../../../logic/pixels.js";
import { manifest } from "../../../manifest/index.js";
import type { Renderer } from "../../../types.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { renderedFrame } from "#test/helpers/frames.js";
import { encode as encodePng } from "fast-png";

const SIZE = manifest.rendering.imageSizePx;

const frame = (subject: boolean): Uint8Array => renderedFrame(SIZE, subject);

/** A flat backdrop with a centered square of another color covering `share` of the frame. */
function blockFrame(backdrop: [number, number, number], block: [number, number, number], share: number): Uint8Array {
  const data = new Uint8Array(SIZE * SIZE * 3);
  const side = Math.round(Math.sqrt(share) * SIZE);
  const start = Math.floor((SIZE - side) / 2);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = x >= start && x < start + side && y >= start && y < start + side;
      data.set(inside ? block : backdrop, (y * SIZE + x) * 3);
    }
  }
  return encodePng({ width: SIZE, height: SIZE, data, channels: 3 });
}

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

  it("counts a dark red item that is as bright as the grey backdrop", () => {
    // the Santa's Slay Gloves case: (86, 12, 16) sums to 114, the backdrop (50, 50, 50) to 150 — a brightness-only
    // test within 3 × 24 of the row read the gloves as backdrop
    const ratio = subjectRatio(blockFrame([50, 50, 50], [86, 12, 16], 0.25), manifest.renderValid.backgroundTolerance)!;
    assert.ok(ratio > 0.2, `measured ${ratio}`);
  });

  it("warns, without failing, on an item that draws only a little of its frame", async () => {
    // a thin band or a small held prop: visible, but under the warning share
    const mock = renderer(() => blockFrame([68, 68, 68], [230, 230, 230], 0.005));
    const result = await validate(await syntheticZip(), { checks: ["render-valid"], services: { renderer: mock.service } });
    assert.equal(result.checks[0].status, "warning");
    assert.equal(result.findings.length, 2, "one per body shape");
    assert.ok(result.findings.every((f) => f.severity === "warning"));
    assert.match(result.findings[0].message, /draws only 0\.\d+% of the frame/);
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
    assert.equal(result.findings[0].limit, `≥ ${(manifest.renderValid.minSubjectRatio * 100).toFixed(2)}%`);
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
    // one batch: the two front views first, then the ten rest-pose views and the eight-frame motion pass the rules after it will need
    assert.deepEqual(mock.rendered.map((batch) => batch.length), [20]);
    assert.equal(result.captures.length, 20);
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:skipped", "visual-quality:skipped"]);
  });
});

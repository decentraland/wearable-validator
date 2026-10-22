import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { digest, digestJson } from "../../../logic/captures.js";
import { parseThumbnailAnswer, thumbnailPrompt } from "./index.js";
import { manifest } from "../../../manifest/index.js";
import { registry } from "../../../registry.js";
import type { Renderer, Reviewer, ReviewRequest, ReviewResult } from "../../../types.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { renderedFrame } from "#test/helpers/frames.js";

const CHECK = { checks: ["thumbnail-honesty"] };

function metadata(request: ReviewRequest, extra: Partial<ReviewResult["metadata"]> = {}): ReviewResult["metadata"] {
  return { provider: "test", model: "fixture", promptDigest: request.promptDigest, promptVersion: request.prompt.version, ...extra };
}

function matches(request: ReviewRequest): ReviewResult {
  return {
    ok: true,
    answer: { verdict: "matches", summary: "The thumbnail depicts the same item.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
    metadata: metadata(request)
  };
}

/** Fake renderer counting the requests per capture() call and a scripted reviewer recording every request. */
function services(answer: (request: ReviewRequest) => ReviewResult = matches) {
  const rendered: number[] = [];
  const reviews: ReviewRequest[] = [];
  const size = manifest.rendering.imageSizePx;
  const bytes = renderedFrame(size); // something drawn, or the empty-render guard skips the review
  const renderer: Renderer = {
    buildId: "test-renderer",
    capture: async (_input, requests) => {
      rendered.push(requests.length);
      return Promise.all(requests.map(async (request) => ({ request, bytes, sha256: await digest(bytes), width: size, height: size })));
    },
    stop: async () => {}
  };
  const reviewer: Reviewer = {
    review: async (request) => {
      reviews.push(request);
      return answer(request);
    }
  };
  return { renderer, reviewer, rendered, reviews };
}

describe("thumbnail-honesty captures", () => {
  it("V-05 alone renders 12 named views, reuses them without a renderer and never mints a verdict", async () => {
    const input = await syntheticZip();
    const mock = services();
    const result = await validate(input, { ...CHECK, services: mock });
    assert.equal(result.passed, null);
    assert.equal(result.checks[0].status, "passed");
    assert.equal(result.captures.length, 12);
    assert.equal(result.captures[0].request.id, "BaseMale-avatar-000");
    assert.equal(result.captures[11].request.id, "BaseFemale-wearable-180");
    assert.deepEqual(mock.reviews[0].images.map((image) => image.id).slice(-2), ["BaseFemale-wearable-180", "thumbnail"]);
    assert.equal(mock.reviews[0].images.length, 13);
    assert.equal(mock.reviews[0].images[0].label, "BaseMale: avatar, azimuth 0 degrees");
    const reused = await validate(input, { ...CHECK, captures: result.captures, services: { reviewer: mock.reviewer } });
    assert.equal(reused.checks[0].status, "passed");
    assert.equal(reused.captures.length, 12);
    assert.deepEqual(mock.rendered, [12]);
  });

  it("emotes sample the avatar view at five clip fractions on both shapes", async () => {
    const mock = services();
    const input = await syntheticZip({
      kind: "emote",
      manifest: {
        name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "simple",
        representations: [{ bodyShapes: manifest.rendering.bodyShapes, mainFile: "model.glb", contents: ["model.glb"] }]
      }
    });
    const result = await validate(input, { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "passed");
    assert.equal(result.captures.length, 20);
    assert.equal(result.captures[0].request.id, "BaseMale-avatar-000-t0");
    assert.equal(result.captures[3].request.id, "BaseMale-avatar-090-t0.25");
    assert.equal(result.captures[5].request.id, "BaseMale-avatar-090-t0.5");
    assert.ok(mock.reviews[0].images[5].label.endsWith("clip fraction 0.5"));
    assert.ok(result.captures.every((capture) => capture.request.view === "avatar"));
  });

  it("partial and corrupt supplied evidence regenerates only the missing view", async () => {
    const input = await syntheticZip();
    const mock = services();
    const first = await validate(input, { ...CHECK, services: mock });
    await validate(input, { ...CHECK, services: mock, captures: first.captures.slice(1) });
    first.captures[0].bytes = new Uint8Array([1, 2, 3]);
    await validate(input, { ...CHECK, services: mock, captures: first.captures });
    assert.deepEqual(mock.rendered, [12, 1, 1]);
  });

  it("thumbnail-only edits reuse model evidence; model and renderer-build edits invalidate it", async () => {
    const glb = await syntheticGlb();
    const mock = services();
    const first = await validate(await syntheticZip({ glb }), { ...CHECK, services: mock });
    const changedThumbnail = await syntheticZip({ glb, thumbnail: pngBytes(128, 128) });
    await validate(changedThumbnail, { ...CHECK, services: mock, captures: first.captures });
    assert.deepEqual(mock.rendered, [12]);
    mock.renderer.buildId = "new-renderer";
    await validate(changedThumbnail, { ...CHECK, services: mock, captures: first.captures });
    assert.deepEqual(mock.rendered, [12, 12]);
    mock.renderer.buildId = "test-renderer";
    const changedModel = await syntheticZip({ glb: await syntheticGlb({ triangles: 24 }) });
    await validate(changedModel, { ...CHECK, services: mock, captures: first.captures });
    assert.deepEqual(mock.rendered, [12, 12, 12]);
  });

  it("missing views without a renderer, or mixed supplied builds, skip with the reason", async () => {
    const input = await syntheticZip();
    const mock = services();
    const first = await validate(input, { ...CHECK, services: mock });
    const partial = await validate(input, { ...CHECK, captures: first.captures.slice(1), services: { reviewer: mock.reviewer } });
    assert.equal(partial.checks[0].status, "skipped");
    assert.match(partial.checks[0].skipReason ?? "", /Supply 1 missing or stale rendered views/);
    first.captures[0].request.rendererBuild = "other-build";
    const mixed = await validate(input, { ...CHECK, captures: first.captures, services: { reviewer: mock.reviewer } });
    assert.equal(mixed.checks[0].status, "skipped");
    assert.match(mixed.checks[0].skipReason ?? "", /one renderer build/);
    assert.equal(mock.reviews.length, 1);
  });

  it("missing metadata, thumbnail, renderer or reviewer skips without rendering or reviewing", async () => {
    const mock = services();
    const input = await syntheticZip();
    for (const options of [{ services: {} }, { services: { reviewer: mock.reviewer } }]) {
      const result = await validate(input, { ...CHECK, ...options });
      assert.equal(result.checks[0].status, "skipped");
      assert.equal(result.checks[0].coverage, "missing");
    }
    const noThumbnail = await validate(await syntheticZip({ thumbnail: null }), { ...CHECK, services: mock });
    assert.equal(noThumbnail.checks[0].status, "skipped");
    assert.match(noThumbnail.checks[0].skipReason ?? "", /thumbnail\.png/);
    const noRepresentations = await validate(
      await syntheticZip({ manifest: { name: "x", description: "x", rarity: "common", data: { category: "hat", tags: [], hides: [], replaces: [] } } }),
      { ...CHECK, services: mock }
    );
    assert.equal(noRepresentations.checks[0].status, "skipped");
    assert.match(noRepresentations.checks[0].skipReason ?? "", /representations/);
    assert.equal(mock.reviews.length, 0);
    assert.deepEqual(mock.rendered, []);
  });

  it("missing reviewer still resolves the captures so a host can review later", async () => {
    const mock = services();
    const result = await validate(await syntheticZip(), { ...CHECK, services: { renderer: mock.renderer } });
    assert.equal(result.checks[0].status, "skipped");
    assert.match(result.checks[0].skipReason ?? "", /services\.reviewer/);
    assert.equal(result.captures.length, 12);
    assert.deepEqual(mock.rendered, [12]);
  });

  it("unsupported, oversized or truncated thumbnails stop before rendering and review", async () => {
    const mock = services();
    const oversized = pngBytes(manifest.fileSize.thumbnailMaxSize + 1, 8);
    for (const thumbnail of [new TextEncoder().encode("not an image"), pngBytes(128, 128).slice(0, 32), oversized]) {
      const result = await validate(await syntheticZip({ thumbnail }), { ...CHECK, services: mock });
      assert.equal(result.checks[0].status, "skipped");
      assert.equal(result.checks[0].coverage, "missing");
      assert.match(result.checks[0].skipReason ?? "", /decodable PNG or JPEG/);
    }
    assert.deepEqual(mock.rendered, []);
    assert.deepEqual(mock.reviews, []);
  });

  it("facial categories are absent and an unparseable model skips", async () => {
    const mock = services();
    const facial = await validate(await syntheticZip({ category: manifest.facialCategories[0] }), { ...CHECK, services: mock });
    assert.equal(facial.checks.length, 0);
    const broken = await validate(await syntheticZip({ glb: new Uint8Array([1, 2, 3, 4]) }), { ...CHECK, services: mock });
    assert.equal(broken.checks[0].status, "skipped");
    assert.match(broken.checks[0].skipReason ?? "", /Fix the model/);
    assert.deepEqual(mock.rendered, []);
  });
});

describe("thumbnail-honesty review", () => {
  it("matches → passed with the comparison as measured", async () => {
    const result = await validate(await syntheticZip(), { ...CHECK, services: services() });
    assert.equal(result.checks[0].status, "passed");
    assert.equal(result.checks[0].coverage, "complete");
    assert.equal(result.checks[0].measured, "Compared the thumbnail with 12 rendered views. The thumbnail depicts the same item.");
    assert.equal(result.checks[0].review?.promptVersion, manifest.thumbnailHonesty.promptVersion);
  });

  it("mismatches are advisory warnings pointing at the thumbnail plus rendered evidence", async () => {
    const mock = services((request) => ({
      ok: true,
      answer: {
        verdict: "mismatch",
        summary: "The thumbnail shows a different hat.",
        reviewedCaptureIds: request.images.map((image) => image.id),
        findings: [{ message: "The thumbnail shows a red hat; the item is blue.", fix: "Regenerate the thumbnail from this model.", captureIds: ["thumbnail", request.images[0].id] }]
      },
      metadata: metadata(request)
    }));
    const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "warning");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "warning");
    assert.equal(result.findings[0].where, "thumbnail.png");
    assert.equal(result.findings[0].message, "The thumbnail shows a red hat; the item is blue. Regenerate the thumbnail from this model.");
    assert.deepEqual(result.findings[0].evidence, [{ captureId: "thumbnail" }, { captureId: "BaseMale-avatar-000" }]);
    assert.equal(result.passed, null);
  });

  it("inconclusive → errored with coverage missing, captures still returned", async () => {
    const mock = services((request) => ({
      ok: true,
      answer: { verdict: "inconclusive", summary: "The item is cropped out of the thumbnail.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
      metadata: metadata(request)
    }));
    const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "errored");
    assert.equal(result.checks[0].coverage, "missing");
    assert.equal(result.checks[0].skipReason, "The item is cropped out of the thumbnail.");
    assert.equal(result.captures.length, 12);
  });

  it("a soft reviewer failure keeps the provenance and usage on the errored row", async () => {
    const usage = { input: 19710, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.06 };
    const mock = services((request) => ({ ok: false, reason: "The model stopped before the answer was complete.", metadata: metadata(request, { usage, stopReason: "length" }) }));
    const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "errored");
    assert.equal(result.checks[0].skipReason, "The model stopped before the answer was complete.");
    assert.deepEqual(result.checks[0].review?.usage, usage);
    assert.equal(result.checks[0].review?.stopReason, "length");
    assert.equal(result.findings.length, 0);
  });

  it("metadata for another prompt digest or version is errored", async () => {
    for (const extra of [{ promptDigest: "0".repeat(64) }, { promptVersion: manifest.thumbnailHonesty.promptVersion + 1 }]) {
      const mock = services((request) => ({ ...matches(request), metadata: metadata(request, extra) }));
      const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
      assert.equal(result.checks[0].status, "errored");
      assert.match(result.checks[0].skipReason ?? "", /different prompt/);
    }
  });

  it("malformed answers never pass", async () => {
    const ids = ["thumbnail", "front"];
    const limits = { maxFindings: manifest.thumbnailHonesty.maxFindings, maxTextLength: manifest.ai.maxTextLength };
    const valid = { verdict: "matches", summary: "Matches.", reviewedCaptureIds: ids, findings: [] };
    assert.deepEqual(parseThumbnailAnswer(valid, ids, limits), valid);
    const invalid: unknown[] = [
      null,
      "refused",
      { ...valid, reviewedCaptureIds: ["thumbnail"] },
      { ...valid, reviewedCaptureIds: ["thumbnail", "thumbnail"] },
      { ...valid, verdict: "mismatch" },
      { ...valid, findings: [{ message: "Wrong", fix: "Fix", captureIds: ["thumbnail", "invented"] }] },
      { ...valid, findings: [{ message: "Wrong", fix: "Fix", captureIds: ["thumbnail"] }] },
      { ...valid, summary: "x".repeat(limits.maxTextLength + 1) }
    ];
    for (const value of invalid) assert.equal(typeof parseThumbnailAnswer(value, ids, limits), "string", JSON.stringify(value)?.slice(0, 60));
    for (const answer of [null, "refused", { ...valid, reviewedCaptureIds: ["thumbnail"] }]) {
      const mock = services((request) => ({ ok: true, answer, metadata: metadata(request) }));
      const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
      assert.equal(result.checks[0].status, "errored");
      assert.equal(result.checks[0].coverage, "missing");
      assert.ok(result.checks[0].review);
    }
  });

  it("default and group runs never spend a render or review call on their own, and abort rejects", async () => {
    const mock = services();
    const input = await syntheticZip();
    const code = await validate(input, { services: mock });
    assert.ok(!code.checks.some((check) => check.group === "rendering"));
    assert.deepEqual(mock.rendered, []);
    assert.deepEqual(mock.reviews, []);
    // a group subset that includes rendering runs the check but stays a partial run
    const partial = await validate(input, { groups: ["files", "model", "emote", "rendering"], services: mock });
    assert.equal(partial.passed, null);
    assert.equal(partial.checks.find((check) => check.check === "thumbnail-honesty")?.status, "passed");
    await assert.rejects(validate(input, { ...CHECK, services: mock, signal: AbortSignal.abort() }), /abort/i);
  });
});

describe("thumbnail-honesty prompt", () => {
  it("is pinned by digest — bump manifest.thumbnailHonesty.promptVersion with any text change", async () => {
    // 2026-09-10 v3 → v4: corresponding-sides rule after tools/artifacts/thumbnail-hsd3yC false mismatch
    assert.equal(await digestJson(thumbnailPrompt), "9df22b603a06cf320e3e50575783a46fb32fc61482dc459ceabc4ee6dc8f5dee");
    assert.equal(thumbnailPrompt.version, 4);
  });

  it("every check with a prompt is an opt-in model check whose prompt version matches its manifest block", () => {
    const camelCase = (name: string): string => name.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());
    const blocks = manifest as unknown as Record<string, { promptVersion?: number } | undefined>;
    const withPrompt = registry.filter((check) => check.prompt);
    assert.deepEqual(withPrompt.map((check) => check.name), ["thumbnail-honesty", "visual-quality", "emote-quality", "smart-wearable-code"]);
    for (const check of withPrompt) {
      assert.ok(check.group === "rendering" || check.group === "code", check.name);
      assert.equal(check.prompt?.version, blocks[camelCase(check.name)]?.promptVersion, check.name);
    }
  });
});

describe("thumbnail-honesty cancellation and untrusted answers", () => {
  it("a run cancelled while rendering rejects instead of recording an errored row", async () => {
    const controller = new AbortController();
    const mock = services();
    mock.renderer.capture = async (_input, _requests, signal) => {
      controller.abort();
      signal?.throwIfAborted();
      return [];
    };
    await assert.rejects(validate(await syntheticZip(), { ...CHECK, services: mock, signal: controller.signal }), /abort/i);
    assert.equal(mock.reviews.length, 0);
  });

  it("rejects a non-string verdict and model text carrying terminal control characters", () => {
    const ids = ["BaseMale-avatar-000", "thumbnail"];
    const limits = { maxFindings: manifest.thumbnailHonesty.maxFindings, maxTextLength: manifest.ai.maxTextLength };
    const valid = { verdict: "matches", summary: "Matches.", reviewedCaptureIds: ids, findings: [] };
    const escape = String.fromCharCode(27);
    assert.equal(typeof parseThumbnailAnswer({ ...valid, verdict: ["matches"] }, ids, limits), "string");
    assert.equal(typeof parseThumbnailAnswer({ ...valid, summary: `clear${escape}[2J the screen` }, ids, limits), "string");
    assert.equal(typeof parseThumbnailAnswer({ ...valid, summary: "two\nlines are fine" }, ids, limits), "object");
  });
});

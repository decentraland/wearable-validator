import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { digest } from "../../../logic/captures.js";
import { manifest } from "../../../manifest/index.js";
import type { Renderer, Reviewer, ReviewRequest, ReviewResult } from "../../../types.js";
import { ASPECT_RULES, parseVisualQualityAnswer, visualQualityPrompt } from "./index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { renderedFrame } from "#test/helpers/frames.js";

const CHECK = { checks: ["visual-quality"] };
const SIZE = manifest.rendering.imageSizePx;

function metadata(request: ReviewRequest): ReviewResult["metadata"] {
  return { provider: "test", model: "fixture", promptDigest: request.promptDigest, promptVersion: request.prompt.version };
}

function services(answer: (request: ReviewRequest) => ReviewResult) {
  const bytes = renderedFrame(SIZE);
  const rendered: number[] = [];
  const reviews: ReviewRequest[] = [];
  const renderer: Renderer = {
    buildId: "test-renderer",
    capture: async (_input, requests) => {
      rendered.push(requests.length);
      return Promise.all(requests.map(async (request) => ({ request, bytes, sha256: await digest(bytes), width: SIZE, height: SIZE })));
    },
    stop: async () => {}
  };
  const reviewer: Reviewer = { review: async (request) => (reviews.push(request), answer(request)) };
  return { renderer, reviewer, rendered, reviews };
}

const ok = (request: ReviewRequest): ReviewResult => ({
  ok: true,
  answer: { verdict: "ok", summary: "No visible defects.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
  metadata: metadata(request)
});

describe("visual-quality (V-02 · V-03 · V-04 · V-06)", () => {
  it("reviews the twelve captures thumbnail-honesty takes plus the sixteen-frame motion pass, with no thumbnail, and passes on ok", async () => {
    const mock = services(ok);
    const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "passed");
    assert.deepEqual(mock.rendered, [28]);
    assert.equal(mock.reviews[0].images.length, 28);
    const stress = mock.reviews[0].images.filter((image) => image.label.includes("bright green"));
    assert.equal(stress.length, 16);
    // the synthetic item is a hat: the head poses
    const head = manifest.rendering.stress.poses[manifest.rendering.stress.categoryPoses.hat].map((pose) => pose.clip);
    assert.ok(stress.every((image) => head.some((clip) => image.label.includes(`pose ${clip}`))));
    assert.ok(!mock.reviews[0].images.some((image) => image.id === "thumbnail"));
    assert.equal(mock.reviews[0].check, "visual-quality");
    assert.equal(result.passed, null);
  });

  it("shares captures with render-valid and thumbnail-honesty: one render batch of twenty-eight, two model calls", async () => {
    const mock = services(ok);
    mock.reviewer.review = async (request) =>
      request.check === "thumbnail-honesty"
        ? { ok: true, answer: { verdict: "matches", summary: "Same.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] }, metadata: metadata(request) }
        : ok(request);
    const result = await validate(await syntheticZip(), { groups: ["rendering"], services: mock });
    assert.deepEqual(mock.rendered, [28]);
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
  });

  it("turns each reported defect into a warning carrying the aspect's own rule id and evidence", async () => {
    const mock = services((request) => ({
      ok: true,
      answer: {
        verdict: "issues",
        summary: "Two defects.",
        reviewedCaptureIds: request.images.map((image) => image.id),
        findings: [
          { aspect: "clipping", message: "Skin shows through the left sleeve.", fix: "Widen the sleeve mesh.", captureIds: ["BaseMale-avatar-090"] },
          { aspect: "texture", message: "The back is flat magenta.", fix: "Embed the back texture.", captureIds: ["BaseMale-avatar-180", "BaseFemale-avatar-180"] }
        ]
      },
      metadata: metadata(request)
    }));
    const result = await validate(await syntheticZip(), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "warning");
    assert.deepEqual(result.findings.map((finding) => finding.rule), [ASPECT_RULES.clipping, ASPECT_RULES.texture]);
    assert.deepEqual(result.findings.map((finding) => finding.data?.aspect), ["clipping", "texture"]);
    assert.equal(result.findings[1].evidence?.length, 2);
    assert.match(result.findings[0].message, /^clipping: Skin shows/);
    assert.equal(result.findings[0].where, "model.glb");
  });

  it("is not applicable to emotes and skips without a reviewer", async () => {
    const mock = services(ok);
    const emote = await validate(await syntheticZip({ kind: "emote" }), { ...CHECK, services: mock });
    assert.equal(emote.checks.length, 0);
    const noReviewer = await validate(await syntheticZip(), { ...CHECK, services: { renderer: mock.renderer } });
    assert.equal(noReviewer.checks[0].status, "skipped");
    assert.equal(noReviewer.captures.length, 28);
  });

  it("rejects answers it cannot trust", () => {
    const ids = ["BaseMale-avatar-000", "BaseMale-avatar-090"];
    const limits = { maxFindings: manifest.visualQuality.maxFindings, maxTextLength: manifest.ai.maxTextLength };
    const valid = { verdict: "ok", summary: "Fine.", reviewedCaptureIds: ids, findings: [] };
    assert.equal(typeof parseVisualQualityAnswer(valid, ids, limits), "object");
    for (const bad of [
      null,
      { ...valid, verdict: "matches" },
      { ...valid, reviewedCaptureIds: ids.slice(0, 1) },
      { ...valid, verdict: "issues" },
      { ...valid, verdict: "issues", findings: [{ aspect: "style", message: "x", fix: "y", captureIds: ids }] },
      { ...valid, verdict: "issues", findings: [{ aspect: "clipping", message: "x", fix: "y", captureIds: ["invented"] }] },
      { ...valid, verdict: "issues", findings: [{ aspect: "clipping", message: "x", fix: "y", captureIds: [] }] }
    ]) {
      assert.equal(typeof parseVisualQualityAnswer(bad, ids, limits), "string");
    }
  });

  it("pins its prompt version to the manifest", () => {
    assert.equal(visualQualityPrompt.version, manifest.visualQuality.promptVersion);
  });
});

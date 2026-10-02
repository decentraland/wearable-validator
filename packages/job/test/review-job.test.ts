import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createBuilderComponent, SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../src/adapters/builder.js";
import { createSlackComponent, itemMessage } from "../src/adapters/slack.js";
import type { IWorkQueueComponent, QueueMessage } from "../src/adapters/work-queue.js";
import { collectionResult, createReviewJob, type CollectionResultBody, type ItemResult } from "../src/logic/review-job.js";
import { InvalidReviewRequest, parseReviewRequest, REVIEW_EVENT, type ValidationRequest } from "../src/logic/review-request.js";
import { fakeRenderer, fakeReviewer, silentLogs, type RenderCalls } from "./fakes.js";
import { syntheticEntity, type SyntheticEntity } from "../../wearable-validator/test/helpers/entity.js";
import { pngBytes, syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";

const CONTENT = "https://builder.example";
const CALLBACK = "https://builder-callback.example";
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

/** The job wired to fakes; Slack stays off unless a fake Slack is given. */
async function job(builder: ReturnType<typeof fakeBuilder>, bodies: string[] = [], slackFetch?: typeof globalThis.fetch) {
  const logs = silentLogs();
  const calls: RenderCalls = { started: 0 };
  const queue = fakeQueue(bodies);
  const config = createConfigComponent({ BUILDER_CONTENT_URL: `${CONTENT}/`, BUILDER_CALLBACK_URL: CALLBACK, BUILDER_CALLBACK_SECRET: SECRET, ...(slackFetch ? { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C123" } : {}) });
  const slack = await createSlackComponent({ config, logs, fetch: slackFetch });
  const reviewJob = createReviewJob({ logs, queue, builder: await createBuilderComponent({ config, logs, fetch: builder.fetch, sleep: async () => {} }), renderer: fakeRenderer(calls), reviewer: fakeReviewer(), slack });
  return { reviewJob, queue, calls };
}

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

describe("the review job", () => {
  it("validates every item and posts one signed result in the Builder's shape", async () => {
    const builder = fakeBuilder([clean, heavy]);
    const { reviewJob, calls } = await job(builder);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(heavy, ITEMS[1])])))), "delete");
    assert.equal(calls.started, 2, "one render per item, the item with code errors included");
    const [post] = builder.posts;
    assert.equal(post.url, `${CALLBACK}/v1/collections/${COLLECTION}/validation-result`);
    assert.equal(post.headers[SIGNATURE_HEADER], signature(SECRET, post.headers[TIMESTAMP_HEADER], post.body), "the Builder can check it came from us");
    const body = builder.body();
    assert.deepEqual([body.validationId, body.verdict, body.rulesVersion], [VALIDATION, "rejected", manifest.version]);
    assert.deepEqual(body.items.map(({ itemId, contentHash, passed }) => [itemId, contentHash, passed]), [[ITEMS[0], "bafkrei11111111", true], [ITEMS[1], "bafkrei22222222", false]]);
    const triangles = body.items[1].findings.find((finding) => finding.check === "triangle-count")!;
    assert.deepEqual([triangles.rule, triangles.severity, typeof triangles.measured, typeof triangles.limit, typeof triangles.fix], ["M-01", "error", "number", "number", "string"]);
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
});

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

/** Slack's Web API: records every call; `refuse` makes every chat call answer ok: false. */
function fakeSlack(refuse = false) {
  const calls: SlackCall[] = [];
  let files = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://slack.com/api/")) return new Response("OK");
    const method = url.slice("https://slack.com/api/".length);
    const raw = String(init?.body ?? "");
    const body = method === "files.getUploadURLExternal" ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ method, body });
    if (refuse && method.startsWith("chat.")) return Response.json({ ok: false, error: "not_in_channel" });
    if (method === "files.getUploadURLExternal") return Response.json({ ok: true, upload_url: `https://files.slack.com/upload/${++files}`, file_id: `F${files}` });
    if (method === "chat.postMessage") return Response.json({ ok: true, ts: `1700000000.00000${calls.filter((call) => call.method === method).length}` });
    return Response.json({ ok: true });
  };
  return { fetch, calls };
}

describe("Slack", () => {
  const blocksText = (body: Record<string, unknown>): string => JSON.stringify(body.blocks);

  it("posts the collection, one reply per item in its thread with its pictures, then edits the collection to its verdict", async () => {
    const slack = fakeSlack();
    const builder = fakeBuilder([clean, heavy]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0]), item(heavy, ITEMS[1])])))), "delete");
    const chat = slack.calls.filter((call) => call.method.startsWith("chat.") || call.method === "files.completeUploadExternal");
    assert.deepEqual(chat.map((call) => call.method), ["chat.postMessage", "chat.postMessage", "files.completeUploadExternal", "chat.postMessage", "files.completeUploadExternal", "chat.update"]);
    const [collection, firstReply, firstShare, secondReply] = chat;
    assert.equal(collection.body.thread_ts, undefined);
    assert.match(blocksText(collection.body), /Validating 2 items/);
    for (const reply of [firstReply, secondReply]) assert.equal(reply.body.thread_ts, "1700000000.000001");
    assert.deepEqual([firstShare.body.channel_id, firstShare.body.thread_ts], ["C123", "1700000000.000001"], "pictures shared into the thread, the one way Slack shows them");
    assert.ok((firstShare.body.files as unknown[]).length >= 2, "the thumbnail and the worn front view");
    assert.match(blocksText(secondReply.body), /triangle-count\* \(M-01\)/);
    const update = chat.at(-1)!;
    assert.equal(update.body.ts, "1700000000.000001");
    assert.match(blocksText(update.body), /Rejected/);
    assert.equal(builder.posts.length, 1, "and the Builder still gets its result");
  });

  it("never lets Slack decide the job: refused messages leave the callback and the delete as they were", async () => {
    const slack = fakeSlack(true);
    const builder = fakeBuilder([clean]);
    const { reviewJob } = await job(builder, [], slack.fetch);
    assert.equal(await reviewJob.process(message(envelope(request([item(clean, ITEMS[0])])))), "delete");
    assert.equal(builder.posts.length, 1);
    assert.deepEqual(slack.calls.map((call) => call.method), ["chat.postMessage"], "no thread to reply in, so nothing more is tried");
  });

  const finding = (check: string, rule: string, severity: "error" | "warning", message: string, where?: string) => ({ rule, check, severity, message, ...(where ? { where } : {}), docs: "https://docs.example" });
  const tropicalMask = { itemId: ITEMS[0], contentHash: "bafkreiabc", itemType: "wearable" as const, metadata: { name: "Tropical Mask" }, contents: {} };

  it("groups an item's findings by check, errors first, a male/female pair told once with its shapes", () => {
    const mesh = (shape: string) => finding("material-names", "M-07", "error", `Mesh "M_Mask_Eyebrows_Mesh.000" in "${shape}/TropicalMask.glb" contains the reserved token "_eyebrows". Rename the mesh.`, `"${shape}/TropicalMask.glb" › M_Mask_Eyebrows_Mesh.000`);
    const findings = [
      finding("thumbnail", "S-06", "warning", "Thumbnail is 1024×1024 — a square 256×256 PNG is recommended.", "thumbnail.png"),
      finding("thumbnail", "S-06", "warning", "Thumbnail has no alpha channel. Export as RGBA PNG.", "thumbnail.png"),
      mesh("male"),
      mesh("female")
    ];
    const message = itemMessage(tropicalMask, { itemId: ITEMS[0], contentHash: "bafkreiabc", passed: false, findings });
    const text = JSON.stringify(message.blocks);
    assert.match(message.text, /1 error, 2 warnings$/, "counted as a curator reads them, not per body-shape copy");
    assert.equal(text.split("material-names").length - 1, 1, "the male and female copies are one line");
    assert.match(text, /material-names\* \(M-07\) · male, female/);
    assert.match(text, /in \\"TropicalMask\.\u200bglb\\"/, "the message names the file without its folder");
    assert.equal(text.split("thumbnail* (S-06)").length - 1, 1, "two thumbnail findings under one check heading");
    assert.ok(text.indexOf("*Errors*") < text.indexOf("*Warnings*"), "errors first");
  });

  it("shows every finding however many there are", () => {
    const findings = Array.from({ length: 12 }, (_, n) => finding(`check-${n}`, "M-01", "warning", `Warning ${n}.`));
    const text = JSON.stringify(itemMessage(tropicalMask, { itemId: ITEMS[0], contentHash: "bafkreiabc", passed: true, findings }).blocks);
    for (let n = 0; n < 12; n++) assert.ok(text.includes(`Warning ${n}.`), `warning ${n} is shown`);
  });
});

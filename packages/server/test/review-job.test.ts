import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createBuilderComponent, SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../src/adapters/builder.js";
import type { IWorkQueueComponent, QueueMessage } from "../src/adapters/work-queue.js";
import { collectionResult, createReviewJob, type CollectionResultBody, type ItemResult } from "../src/logic/review-job.js";
import { InvalidReviewRequest, parseReviewRequest, REVIEW_EVENT, type ValidationRequest } from "../src/logic/review-request.js";
import { fakeRenderer, fakeReviewer, recordingLogs, type ServiceCalls } from "./components.js";
import { syntheticEntity, type SyntheticEntity } from "../../wearable-validator/test/helpers/entity.js";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";

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

async function job(builder: ReturnType<typeof fakeBuilder>, bodies: string[] = []) {
  const logs = recordingLogs([]);
  const calls: ServiceCalls = { services: 0, rendered: [] };
  const queue = fakeQueue(bodies);
  const config = createConfigComponent({ BUILDER_CONTENT_URL: `${CONTENT}/`, BUILDER_CALLBACK_URL: CALLBACK, BUILDER_CALLBACK_SECRET: SECRET });
  const reviewJob = createReviewJob({ logs, queue, builder: await createBuilderComponent({ config, logs, fetch: builder.fetch, sleep: async () => {} }), renderer: fakeRenderer(calls), reviewer: fakeReviewer() });
  return { reviewJob, queue, calls };
}

let clean: SyntheticEntity;
let heavy: SyntheticEntity;
before(async () => {
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
    assert.equal(calls.services, 2, "one render per item, the item with code errors included");
    const [post] = builder.posts;
    assert.equal(post.url, `${CALLBACK}/v1/collections/${COLLECTION}/validation-result`);
    assert.equal(post.headers[SIGNATURE_HEADER], signature(SECRET, post.headers[TIMESTAMP_HEADER], post.body), "the Builder can check it came from us");
    const body = builder.body();
    assert.deepEqual([body.validationId, body.verdict, body.rulesVersion], [VALIDATION, "rejected", manifest.version]);
    assert.deepEqual(body.items.map(({ itemId, contentHash, passed }) => [itemId, contentHash, passed]), [[ITEMS[0], "bafkrei11111111", true], [ITEMS[1], "bafkrei22222222", false]]);
    const triangles = body.items[1].findings.find((finding) => finding.check === "triangle-count")!;
    assert.deepEqual([triangles.rule, triangles.severity, typeof triangles.measured, typeof triangles.limit, typeof triangles.fix], ["M-01", "error", "number", "number", "string"]);
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

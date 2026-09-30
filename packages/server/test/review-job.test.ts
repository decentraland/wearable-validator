import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createBuilderComponent, SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../src/adapters/builder.js";
import type { IWorkQueueComponent, QueueMessage } from "../src/adapters/work-queue.js";
import { createReviewJob, type ReviewResultBody } from "../src/logic/review-job.js";
import { InvalidReviewRequest, parseReviewRequest, REVIEW_EVENT } from "../src/logic/review-request.js";
import { fakeRenderer, fakeReviewer, recordingLogs, type RecordedLine, type ServiceCalls } from "./components.js";
import { syntheticEntity, type SyntheticEntity } from "../../wearable-validator/test/helpers/entity.js";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";

const API = "https://builder.example/v1";
const SECRET = "shh";
const ITEM = "11111111-2222-4333-8444-555555555555";
const COLLECTION = "99999999-8888-4777-8666-555555555555";

function event(entity: SyntheticEntity, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...REVIEW_EVENT,
    key: ITEM,
    timestamp: 1790000000000,
    metadata: {
      itemId: ITEM,
      collectionId: COLLECTION,
      contentHash: "bafkreicontenthash",
      itemType: "wearable",
      entityMetadata: entity.metadata,
      contents: Object.fromEntries(entity.content.map(({ file, hash }) => [file, hash])),
      ...overrides
    }
  };
}

/** The SNS envelope a topic subscription wraps every message in. */
const envelope = (value: unknown): string => JSON.stringify({ Type: "Notification", Message: JSON.stringify(value) });

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Builder storage serving the entity's files by hash, and a webhook that records what it got and answers `status`. */
function fakeBuilder(entity: SyntheticEntity, status = 200): { fetch: typeof globalThis.fetch; posted: Posted[]; downloads: string[] } {
  const byHash = new Map(entity.content.map(({ file, hash }) => [hash, entity.files.get(file)!]));
  const posted: Posted[] = [];
  const downloads: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const stored = /\/storage\/contents\/([^/]+)$/.exec(url);
    if (stored) {
      downloads.push(stored[1]);
      const bytes = byHash.get(stored[1]);
      return bytes ? new Response(bytes.slice().buffer as ArrayBuffer) : new Response("missing", { status: 404 });
    }
    posted.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(null, { status });
  };
  return { fetch, posted, downloads };
}

function fakeQueue(bodies: string[]): IWorkQueueComponent & { deleted: string[] } {
  const pending: QueueMessage[] = bodies.map((body, i) => ({ id: `m${i}`, receiptHandle: `r${i}`, body }));
  const deleted: string[] = [];
  return { deleted, receive: async () => pending.shift(), delete: async (handle) => void deleted.push(handle) };
}

async function job(entity: SyntheticEntity, options: { status?: number; bodies?: string[] } = {}) {
  const builder = fakeBuilder(entity, options.status);
  const lines: RecordedLine[] = [];
  const logs = recordingLogs(lines);
  const calls: ServiceCalls = { services: 0, rendered: [] };
  const queue = fakeQueue(options.bodies ?? []);
  const reviewJob = createReviewJob({
    logs,
    queue,
    builder: await createBuilderComponent({ config: createConfigComponent({ BUILDER_API_URL: `${API}/`, BUILDER_WEBHOOK_SECRET: SECRET }), logs, fetch: builder.fetch }),
    renderer: fakeRenderer(calls),
    reviewer: fakeReviewer()
  });
  return { reviewJob, builder, queue, calls, lines };
}

let entity: SyntheticEntity;
before(async () => {
  entity = await syntheticEntity(await syntheticZip(), `urn:decentraland:amoy:collections-v2:0x${"ab".repeat(20)}:0`);
});

describe("parseReviewRequest", () => {
  it("reads the event from the SNS envelope or bare", () => {
    for (const body of [envelope(event(entity)), JSON.stringify(event(entity))]) {
      const request = parseReviewRequest(body);
      assert.deepEqual([request.itemId, request.collectionId, request.itemType], [ITEM, COLLECTION, "wearable"]);
      assert.equal(Object.keys(request.contents).length, entity.content.length);
    }
  });

  it("refuses anything it could not act on safely", () => {
    const refused = (value: unknown) => assert.throws(() => parseReviewRequest(typeof value === "string" ? value : JSON.stringify(value)), InvalidReviewRequest);
    refused("not json");
    refused({ ...event(entity), subType: "item-published" });
    refused(event(entity, { itemId: "../../admin" }));
    refused(event(entity, { itemType: "scene" }));
    refused(event(entity, { contents: {} }));
    refused(event(entity, { contents: { "../../etc/passwd": "bafkreiabc" } }));
    refused(event(entity, { contents: { "male\\..\\x.glb": "bafkreiabc" } }));
    refused(event(entity, { contents: { "model.glb": "../storage" } }));
  });
});

describe("the review job", () => {
  it("fetches the item from Builder storage, checks and renders it, and posts a signed result to the webhook", async () => {
    const { reviewJob, builder, calls } = await job(entity);
    assert.equal(await reviewJob.process(envelope(event(entity))), "delete");
    assert.deepEqual(builder.downloads.sort(), entity.content.map(({ hash }) => hash).sort(), "every file, by its hash");
    assert.equal(calls.services, 1, "the render server started once for the item");
    assert.equal(builder.posted.length, 1);
    const [post] = builder.posted;
    assert.equal(post.url, `${API}/items/${ITEM}/validation`);
    assert.equal(post.headers[SIGNATURE_HEADER], signature(SECRET, post.headers[TIMESTAMP_HEADER], post.body), "the Builder can check it came from us");
    const result = JSON.parse(post.body) as ReviewResultBody;
    assert.deepEqual([result.itemId, result.collectionId, result.contentHash, result.rulesVersion], [ITEM, COLLECTION, "bafkreicontenthash", manifest.version]);
    assert.equal(result.passed, true);
    assert.equal(result.decision.state, "ready");
    assert.ok(result.checks.some((row) => row.check === "triangle-count") && result.checks.some((row) => row.check === "render-valid"), "code and visual rows together");
  });

  it("still renders an item with code errors, and says what blocks it", async () => {
    const heavy = await syntheticEntity(await syntheticZip({ glb: await syntheticGlb({ triangles: 5000 }) }), `urn:decentraland:amoy:collections-v2:0x${"cd".repeat(20)}:0`);
    const { reviewJob, builder, calls } = await job(heavy);
    assert.equal(await reviewJob.process(envelope(event(heavy))), "delete");
    const result = JSON.parse(builder.posted[0].body) as ReviewResultBody;
    assert.equal(result.passed, false);
    assert.equal(result.decision.state, "blocked");
    assert.match(result.decision.reasons[0], /^triangle-count: /);
    assert.equal(calls.services, 1, "curators still get the views");
  });

  it("leaves the message to retry when the webhook refuses or storage is missing a file, and drops what it can never read", async () => {
    const refused = await job(entity, { status: 503 });
    assert.equal(await refused.reviewJob.process(envelope(event(entity))), "retry");
    const missing = await job(entity);
    assert.equal(await missing.reviewJob.process(envelope(event(entity, { contents: { "model.glb": "bafkreinothere" } }))), "retry");
    assert.equal(missing.builder.posted.length, 0);
    const junk = await job(entity);
    assert.equal(await junk.reviewJob.process("{}"), "delete");
    assert.equal(junk.builder.downloads.length + junk.builder.posted.length, 0, "nothing fetched for a message that is not a review request");
  });

  it("drains the queue, deleting only what reached the Builder, then exits on an empty queue", async () => {
    const { reviewJob, queue } = await job(entity, { bodies: [envelope(event(entity)), "{}", envelope(event(entity, { contents: { "model.glb": "bafkreinothere" } }))] });
    assert.equal(await reviewJob.drain({ maxRuntimeMs: 60_000, emptyReceivesToExit: 1 }), 3);
    assert.deepEqual(queue.deleted, ["r0", "r1"], "the failed one stays for SQS to redeliver");
  });
});

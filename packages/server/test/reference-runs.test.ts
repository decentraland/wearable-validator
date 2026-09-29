/** Runs started from a marketplace reference: the server fetches the item from a (fake) catalyst inside the run. */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { catalystFetch, syntheticEntity, type SyntheticEntity } from "../../wearable-validator/test/helpers/entity.js";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { createCatalystComponent, type ICatalystComponent } from "../src/adapters/catalyst.js";
import { createSlackComponent } from "../src/adapters/slack.js";
import { fakeRenderer, recordingLogs, startTestServer, type RecordedLine, type ServiceCalls, type TestServer } from "./components.js";

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

interface RunRow {
  id: string;
  name: string;
  done: boolean;
  passed: boolean | null;
}

interface Post {
  text: string;
  thread_ts?: string;
  blocks: { type: string; text?: { text: string } }[];
}

const CONTRACT = "0x" + "ab".repeat(20);
const MATIC = `urn:decentraland:matic:collections-v2:${CONTRACT}:12`;
const ETHEREUM = `urn:decentraland:ethereum:collections-v2:${CONTRACT}:12`;
const SHOP_URL = `https://decentraland.org/shop/item/${CONTRACT}/12`;
const alice = { "x-test-user": "alice" };
const bob = { "x-test-user": "bob" };
const json = { "content-type": "application/json" };

async function catalystOver(entities: SyntheticEntity[], status?: number, lines: RecordedLine[] = []): Promise<ICatalystComponent> {
  return createCatalystComponent({ config: createConfigComponent({ CATALYST_URL: "https://peer.example/" }), logs: recordingLogs(lines), fetch: catalystFetch(entities, { status }) });
}

function parseFrames(text: string): Frame[] {
  return text.split("\n\n").filter((block) => block.includes("event:")).map((block) => ({ type: /event: (.*)/.exec(block)![1], data: JSON.parse(/data: (.*)/.exec(block)![1]) as Record<string, unknown> }));
}

async function readEvents(url: string, headers: Record<string, string> = alice): Promise<Frame[]> {
  return parseFrames(await (await fetch(url, { headers })).text());
}

async function startReference(base: string, reference: string, query = "", headers: Record<string, string> = alice): Promise<Response> {
  return fetch(`${base}/api/runs${query}`, { method: "POST", body: JSON.stringify({ reference }), headers: { ...json, ...headers } });
}

async function startRun(base: string, reference: string, query = "", headers: Record<string, string> = alice): Promise<string> {
  const res = await startReference(base, reference, query, headers);
  if (res.status !== 201) assert.fail(`expected 201, got ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function listAs(base: string, headers: Record<string, string>): Promise<RunRow[]> {
  return ((await (await fetch(`${base}/api/runs`, { headers })).json()) as { runs: RunRow[] }).runs;
}

async function until<T>(read: () => T, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

async function stopAndClean(server: TestServer): Promise<void> {
  await server.stop();
  await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Answers every Slack call as Slack would and keeps the messages posted. */
function slackRecorder(): { posts: Post[]; fetch: typeof globalThis.fetch } {
  const posts: Post[] = [];
  let files = 0;
  const answer = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/files.getUploadURLExternal")) return answer({ ok: true, upload_url: `https://files.slack.com/upload/${++files}`, file_id: `F${files}` });
    if (url.endsWith("/files.completeUploadExternal")) return answer({ ok: true });
    if (url.endsWith("/chat.postMessage")) {
      posts.push(JSON.parse(String(init?.body)) as Post);
      return answer({ ok: true, ts: `1700000000.${String(posts.length).padStart(6, "0")}` });
    }
    return new Response("OK", { status: 200 });
  };
  return { posts, fetch };
}

describe("runs from a marketplace reference", () => {
  let server: TestServer;
  let base: string;
  let entity: SyntheticEntity;
  const calls: ServiceCalls = { services: 0, rendered: [] };
  const catalystLines: RecordedLine[] = [];

  before(async () => {
    // published under the ethereum URN only: a shop URL resolves through its matic candidate first
    entity = await syntheticEntity(await syntheticZip(), ETHEREUM);
    server = await startTestServer({ renderer: fakeRenderer(calls), catalyst: await catalystOver([entity], undefined, catalystLines) });
    base = server.base;
  });
  after(() => stopAndClean(server));

  it("fetches the item inside the run, streams the download, gates it, renders it and keeps the item in the folder", async () => {
    const id = await startRun(base, SHOP_URL);
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const types = events.map((event) => event.type);
    const fetchStages = events.filter((event) => event.type === "stage" && event.data.kind === "fetch");
    assert.deepEqual(fetchStages[0].data, { text: "Fetching the item from the catalyst", kind: "fetch" });
    assert.deepEqual(fetchStages.slice(1).map((event) => [event.data.text, event.data.done, event.data.total]), [0, 1, 2, 3].map((done) => ["Downloading the item's files", done, 3]));
    assert.ok(types.indexOf("stage") < types.indexOf("check"), "the download comes before the first code check");
    const gate = events.find((event) => event.type === "gate")!;
    assert.equal(gate.data.passed, true, "a published item passes the code checks, content integrity included");
    assert.ok(types.indexOf("gate") < types.indexOf("capture"), "then the renderer");
    assert.equal(events.filter((event) => event.type === "capture").length, 20);
    assert.equal(events.filter((event) => event.type === "review").length, 4);
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    assert.equal(done.data.name, "Test Wearable", "the run takes the item's name once the catalyst answers");
    assert.equal(done.data.zipUrl, undefined, "nothing to download: there was no upload");
    assert.equal(done.data.reference, ETHEREUM, "the URN the item was found under, so the site can preview it");
    const gateResult = done.data.gate as { passed: boolean; checks: { check: string }[] };
    assert.equal(gateResult.passed, true);
    assert.ok(gateResult.checks.some((row) => row.check === "content-integrity"));
    const result = done.data.result as { checks: { check: string; status: string }[] };
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
    assert.equal((await fetch(`${base}/api/runs/${id}/input.zip`, { headers: alice })).status, 404);

    const rows = await listAs(base, alice);
    assert.deepEqual(rows.filter((row) => row.id === id).map((row) => [row.name, row.done, row.passed]), [["Test Wearable", true, true]], "History lists the run under the item's name");

    const dir = join(server.artifacts, `visual-${CONTRACT}-12-${id}`);
    const stored = JSON.parse(await readFile(join(dir, "entity.json"), "utf8")) as { urn: string; id: string; name: string; content: unknown[]; metadata: unknown };
    assert.deepEqual([stored.urn, stored.id, stored.name, stored.content, stored.metadata], [ETHEREUM, entity.id, "Test Wearable", entity.content, entity.metadata]);
    assert.deepEqual(new Uint8Array(await readFile(join(dir, "item", "model.glb"))), entity.files.get("model.glb"));
    assert.ok((await stat(join(dir, "item", "thumbnail.png"))).isFile());
    assert.ok((await stat(join(dir, "gate.json"))).isFile());
    await assert.rejects(stat(join(dir, "input.zip")), "no input.zip is written for a reference run");
    const input = JSON.parse(await readFile(join(dir, "input.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual([input.name, input.reference, input.entityId, input.sha256, input.gatePassed], ["Test Wearable", ETHEREUM, entity.id, undefined, true]);
    assert.ok(server.lines.some((line) => line.message === "run accepted" && line.extra.run === id && line.extra.reference === MATIC && line.extra.bytes === undefined));
    assert.ok(catalystLines.some((line) => line.message === "item fetched" && line.extra.entity === entity.id && line.extra.files === 3));
  });

  it("refuses what is not a reference with the site's own sentence, without taking a slot", async () => {
    const before = (await listAs(base, alice)).length;
    const bad = await startReference(base, "not a reference");
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { message: string }).message, "That doesn't look like a shop item URL or a wearable URN (expected decentraland.org/shop/item/0x…/N or urn:decentraland:…).");
    const token = await startReference(base, `https://decentraland.org/marketplace/contracts/${CONTRACT}/tokens/5`);
    assert.equal(token.status, 400);
    assert.match(((await token.json()) as { message: string }).message, /open the item's shop page instead/);
    const shapeless = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ urn: MATIC }), headers: { ...json, ...alice } });
    assert.equal(shapeless.status, 400);
    assert.match(((await shapeless.json()) as { message: string }).message, /"reference"/);
    const broken = await fetch(`${base}/api/runs`, { method: "POST", body: "{not json", headers: { ...json, ...alice } });
    assert.equal(broken.status, 400);
    const huge = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ reference: "x".repeat(5000) }), headers: { ...json, ...alice } });
    assert.equal(huge.status, 413);
    assert.equal((await listAs(base, alice)).length, before, "nothing was accepted");
    const other = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ reference: MATIC }), headers: { "content-type": "text/plain", ...alice } });
    assert.equal(other.status, 415);
    assert.match(((await other.json()) as { message: string }).message, /application\/zip.*application\/json/);
  });

  it("fails the run with the library's sentence when no candidate is published", async () => {
    const id = await startRun(base, `urn:decentraland:matic:collections-v2:${"0x" + "cd".repeat(20)}:1`);
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    assert.deepEqual(events.map((event) => event.type), ["stage", "error"]);
    assert.equal(events[1].data.message, "No published item found for that reference — check the URN or URL, or the item may not be published yet.");
    assert.equal(events[1].data.zipUrl, undefined);
    const row = (await listAs(base, alice)).find((entry) => entry.id === id)!;
    assert.deepEqual([row.name, row.done, row.passed], [`${"0x" + "cd".repeat(20)}-1`, true, null], "the folder name stays URN-derived: the catalyst never named the item");
  });

  it("shows the earlier run's photos at once for the same entity and renders nothing again", async () => {
    const renderedBefore = calls.rendered.length;
    const id = await startRun(base, ETHEREUM);
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const types = events.map((event) => event.type);
    assert.ok(events.some((event) => event.type === "stage" && event.data.text === "Reusing 20 views from an earlier run"));
    assert.equal(types.filter((type) => type === "capture").length, 20);
    assert.ok(types.indexOf("capture") < types.indexOf("review"));
    assert.deepEqual(calls.rendered.slice(renderedBefore), [], "no renderer call for an unchanged entity");
    assert.equal(events.at(-1)!.type, "done");
  });

  it("hides a reference run's item files from everyone but its owner, like every run file", async () => {
    const id = (await listAs(base, alice)).find((row) => row.name === "Test Wearable")!.id;
    assert.equal((await fetch(`${base}/api/runs/${id}/entity.json`, { headers: alice })).status, 200);
    assert.equal((await fetch(`${base}/api/runs/${id}/item/model.glb`, { headers: alice })).status, 200);
    assert.equal((await fetch(`${base}/api/runs/${id}/entity.json`, { headers: bob })).status, 404);
  });
});

describe("a catalyst that is down", () => {
  it("ends the run with an error event and still tells the channel, naming the marketplace item", async () => {
    const recorder = slackRecorder();
    const slack = await createSlackComponent({ config: createConfigComponent({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C123", SITE_URL: "https://validator.example" }), logs: recordingLogs([]), fetch: recorder.fetch });
    const server = await startTestServer({ catalyst: await catalystOver([], 500), slack });
    try {
      const id = await startRun(server.base, SHOP_URL);
      const events = await readEvents(`${server.base}/api/runs/${id}/events`);
      assert.equal(events.at(-1)!.type, "error");
      assert.equal(events.at(-1)!.data.message, "The catalyst answered 500 — try again in a moment.");
      assert.ok(server.lines.some((line) => line.level === "ERROR" && line.message === "run failed" && line.extra.run === id));
      await until(() => recorder.posts.length, (count) => count === 1);
      const summary = recorder.posts[0].blocks[1].text!.text;
      assert.match(summary, /\*Verdict\* 💥 The run failed/);
      assert.ok(summary.includes(`· from the marketplace <https://decentraland.org/marketplace/contracts/${CONTRACT}/items/12|${MATIC}>`), summary);
      assert.ok(!server.lines.some((line) => line.message === "slack notification failed"));
    } finally {
      await stopAndClean(server);
    }
  });
});

describe("a download that fails midway", () => {
  it("ends the run with the error frame and nothing after it, on the stream and in the run's stored events", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const gone = { ...entity, content: [entity.content[0], { file: "missing.bin", hash: "bafymissing" }, ...entity.content.slice(1)] };
    const server = await startTestServer({ catalyst: await catalystOver([gone]) });
    try {
      const id = await startRun(server.base, MATIC);
      const events = await readEvents(`${server.base}/api/runs/${id}/events`);
      assert.equal(events.at(-1)!.type, "error");
      assert.equal(events.at(-1)!.data.message, 'The catalyst answered 404 for "missing.bin".');
      // the other downloads held their bytes when the missing one failed: none of them may count or report now
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stored = (await (await fetch(`${server.base}/api/runs/${id}`, { headers: alice })).json()) as { events: Frame[] };
      assert.equal(stored.events.length, events.length, "no stage lands after the error");
      assert.equal(stored.events.at(-1)!.type, "error");
      assert.ok(!stored.events.some((event) => event.type === "stage" && typeof event.data.done === "number" && event.data.done > 0));
    } finally {
      await stopAndClean(server);
    }
  });
});

describe("a catalyst that never answers", () => {
  it("ends the run within CATALYST_TIMEOUT_MS with a retry hint and frees the owner's slot", async () => {
    // accepts the connection and stalls, like a wedged peer: only the abort signal ever settles it, as with undici
    const stalled: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    });
    const lines: RecordedLine[] = [];
    const catalyst = await createCatalystComponent({ config: createConfigComponent({ CATALYST_URL: "https://peer.example", CATALYST_TIMEOUT_MS: "50" }), logs: recordingLogs(lines), fetch: stalled });
    const server = await startTestServer({ catalyst, env: { MAX_ACTIVE_RUNS_PER_OWNER: "1" } });
    try {
      const id = await startRun(server.base, MATIC);
      const events = await readEvents(`${server.base}/api/runs/${id}/events`);
      assert.deepEqual(events.map((event) => event.type), ["stage", "error"]);
      assert.equal(events[1].data.message, "The catalyst did not answer in time — try again in a moment.");
      assert.ok(lines.some((line) => line.level === "WARN" && line.message === "catalyst timed out" && line.extra.timeoutMs === 50));
      const row = (await listAs(server.base, alice)).find((entry) => entry.id === id)!;
      assert.deepEqual([row.done, row.passed], [true, null]);
      const next = await startReference(server.base, MATIC);
      assert.equal(next.status, 201, "the timed-out run no longer counts against the owner's active runs");
      await readEvents(`${server.base}/api/runs/${((await next.json()) as { id: string }).id}/events`);
    } finally {
      await stopAndClean(server);
    }
  });
});

describe("a reference run after a restart", () => {
  it("comes back from its folder with the code gate, the item's name and its views to reuse", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const first = await startTestServer({ catalyst: await catalystOver([entity]) });
    const artifacts = first.artifacts;
    let id: string;
    try {
      id = await startRun(first.base, MATIC);
      assert.equal((await readEvents(`${first.base}/api/runs/${id}/events`)).at(-1)!.type, "done");
    } finally {
      await first.stop();
    }
    const calls: ServiceCalls = { services: 0, rendered: [] };
    const second = await startTestServer({ env: { ARTIFACTS_DIR: artifacts }, renderer: fakeRenderer(calls), catalyst: await catalystOver([entity]) });
    try {
      assert.deepEqual((await listAs(second.base, alice)).map((row) => [row.id, row.name, row.passed]), [[id, "Test Wearable", true]]);
      const restored = (await (await fetch(`${second.base}/api/runs/${id}`, { headers: alice })).json()) as { events: Frame[] };
      assert.equal(restored.events.length, 1);
      const done = restored.events[0].data;
      assert.equal(done.zipUrl, undefined);
      assert.equal((done.gate as { passed: boolean }).passed, true, "gate.json is read back for History");
      assert.match(String(done.reference), /^urn:decentraland:/, "the replayed run still says it was fetched, not uploaded");
      assert.equal((done.result as { checks: unknown[] }).checks.length, 3);
      const again = await startRun(second.base, MATIC, "?model=0");
      const events = await readEvents(`${second.base}/api/runs/${again}/events`);
      assert.equal(events.filter((event) => event.type === "capture").length, 20);
      assert.deepEqual(calls.rendered, [], "the earlier folder's views are reused across the restart");
    } finally {
      await stopAndClean(second);
    }
  });

  it("stops at the code gate for a published item with code errors and keeps that gate for History", async () => {
    const zip = await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) });
    const entity = await syntheticEntity(zip, MATIC);
    const server = await startTestServer({ catalyst: await catalystOver([entity]) });
    try {
      const id = await startRun(server.base, MATIC);
      const events = await readEvents(`${server.base}/api/runs/${id}/events`);
      const done = events.at(-1)!;
      assert.equal(done.type, "done");
      assert.equal(done.data.skipped, true);
      assert.equal((done.data.gate as { passed: boolean }).passed, false);
      assert.ok(!events.some((event) => event.type === "capture"));
      const dir = join(server.artifacts, `visual-${CONTRACT}-12-${id}`);
      const gate = JSON.parse(await readFile(join(dir, "gate.json"), "utf8")) as { passed: boolean; findings: { check: string }[] };
      assert.equal(gate.passed, false);
      assert.ok(gate.findings.some((finding) => finding.check === "triangle-count"));
      const input = JSON.parse(await readFile(join(dir, "input.json"), "utf8")) as Record<string, unknown>;
      assert.deepEqual([input.reference, input.entityId], [MATIC, undefined], "the entity id is written only when the run reaches the renderer");
    } finally {
      await stopAndClean(server);
    }
  });
});

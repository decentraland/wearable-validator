/** Runs through the real server graph with the real Slack component over a recording fetch: what the channel sees per run. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { createSlackComponent } from "../src/adapters/slack.js";
import { fakeRenderer, recordingLogs, startTestServer, type RecordedLine, type ServiceCalls, type TestServer } from "./components.js";

interface Block {
  type: string;
  text?: { text: string };
  slack_file?: { id: string };
  elements?: { url?: string; text?: { text: string } | string }[];
}

interface Post {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks: Block[];
}

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

const alice = { "x-test-user": "alice@example.com" };
const bob = { "x-test-user": "bob" };
const bot = { "x-test-user": "service:slack-bot" };
const zipUpload = { "content-type": "application/zip" };
const body = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Answers every Slack call as Slack would and keeps the messages posted. */
function slackRecorder(): { posts: Post[]; fetch: typeof globalThis.fetch } {
  const posts: Post[] = [];
  let files = 0;
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/files.getUploadURLExternal")) return json({ ok: true, upload_url: `https://files.slack.com/upload/${++files}`, file_id: `F${files}` });
    if (url.endsWith("/files.completeUploadExternal")) return json({ ok: true });
    if (url.endsWith("/chat.postMessage")) {
      posts.push(JSON.parse(String(init?.body)) as Post);
      return json({ ok: true, ts: `1700000000.${String(posts.length).padStart(6, "0")}` });
    }
    return new Response("OK", { status: 200 });
  };
  return { posts, fetch };
}

async function withSlack(renderer = fakeRenderer({ services: 0, rendered: [] })): Promise<{ server: TestServer; posts: Post[]; slackLines: RecordedLine[] }> {
  const slackLines: RecordedLine[] = [];
  const recorder = slackRecorder();
  const slack = await createSlackComponent({
    config: createConfigComponent({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C123", SITE_URL: "https://validator.example" }),
    logs: recordingLogs(slackLines),
    fetch: recorder.fetch
  });
  const server = await startTestServer({ renderer, slack });
  return { server, posts: recorder.posts, slackLines };
}

async function startRun(base: string, zip: Uint8Array, query: string, headers: Record<string, string>, name = "shirt.zip"): Promise<string> {
  const res = await fetch(`${base}/api/runs${query}`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...headers, "x-file-name": name } });
  if (res.status !== 201) assert.fail(`expected 201, got ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function readEvents(url: string, headers: Record<string, string>): Promise<Frame[]> {
  const text = await (await fetch(url, { headers })).text();
  return text.split("\n\n").filter((block) => block.includes("event:")).map((block) => ({ type: /event: (.*)/.exec(block)![1], data: JSON.parse(/data: (.*)/.exec(block)![1]) as Record<string, unknown> }));
}

async function until<T>(read: () => T, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

const stopAndClean = async (server: TestServer) => {
  await server.stop();
  await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

describe("run notifications", () => {
  it("tells the channel once per finished run: who sent it, the verdict, the thumbnail, the button, then the front views in a thread", async () => {
    const { server, posts, slackLines } = await withSlack();
    const { base } = server;
    try {
      const id = await startRun(base, await syntheticZip(), "?standalone=1", alice);
      const events = await readEvents(`${base}/api/runs/${id}/events`, alice);
      assert.equal(events.at(-1)!.type, "done");
      assert.equal(events.at(-1)!.data.zipUrl, `/api/runs/${id}/input.zip`, "the done event points at the kept upload");
      await until(() => posts.length, (count) => count === 2);
      const [message, thread] = posts;
      assert.equal(message.channel, "C123");
      assert.equal(message.thread_ts, undefined);
      // the synthetic zip passes every code check without a warning and the fake reviewer passes every visual row
      const approval = "✅ Nothing found — look at the views before approving";
      assert.equal(message.text, `Test Wearable — ✅ Passed — ${approval} (sent by alice@example.com)`, "the item's own name, not the zip's");
      assert.match(message.blocks[1].text!.text, /\*Item\* Test Wearable \(.*wearable.*\)/);
      const summary = message.blocks[1].text!.text;
      assert.match(summary, /\*Sent by\* alice@example\.com/);
      assert.match(summary, /\*Verdict\* ✅ Passed/);
      assert.ok(summary.includes(`*Approval* ${approval}`), summary);
      assert.ok(message.blocks.some((block) => block.type === "image" && block.slack_file?.id === "F1"), "the thumbnail was uploaded first and is shown");
      assert.equal(message.blocks.find((block) => block.type === "actions")!.elements![0].url, `https://validator.example/?run=${id}`);
      assert.match(message.blocks.at(-1)!.elements![0].text as string, new RegExp(`^run ${id} · rules v.* · rendered in \\d+ s$`));
      assert.equal(thread.thread_ts, "1700000000.000001");
      assert.deepEqual(thread.blocks.map((block) => block.slack_file!.id), ["F2", "F3"]);
      assert.deepEqual(slackLines.filter((line) => line.message === "slack notified").map((line) => line.extra.run), [id]);
      assert.ok(!server.lines.some((line) => line.message === "slack notification failed"));
    } finally {
      await stopAndClean(server);
    }
  });

  it("says a run stopped at the code gate is blocked, naming the failing check, and still keeps the zip", async () => {
    const { server, posts } = await withSlack();
    const { base } = server;
    try {
      const id = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "", alice, "bad.zip");
      const events = await readEvents(`${base}/api/runs/${id}/events`, alice);
      assert.equal(events.at(-1)!.data.skipped, true);
      assert.equal(events.at(-1)!.data.zipUrl, `/api/runs/${id}/input.zip`);
      await until(() => posts.length, (count) => count === 1);
      assert.match(posts[0].blocks[1].text!.text, /\*Verdict\* ❌ Failed the code checks\n\*Approval\* ⛔ Blocked: triangle-count: /);
      assert.ok(!posts[0].blocks.some((block) => block.type === "image"), "no thumbnail was extracted before the gate");
      assert.ok(posts[0].blocks.some((block) => block.text?.text.includes("*triangle-count*")), "the findings are listed");
    } finally {
      await stopAndClean(server);
    }
  });

  it("tells nobody about a cancelled run", async () => {
    let release!: () => void;
    const gate = { open: new Promise<void>((resolve) => (release = resolve)) };
    const calls: ServiceCalls = { services: 0, rendered: [] };
    const { server, posts } = await withSlack(fakeRenderer(calls, gate));
    const { base } = server;
    try {
      const id = await startRun(base, await syntheticZip(), "?model=0", alice);
      await until(() => server.lines.some((line) => line.message === "run started" && line.extra.run === id), (started) => started);
      assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: alice })).status, 202);
      release();
      const events = await readEvents(`${base}/api/runs/${id}/events`, alice);
      assert.equal(events.at(-1)!.type, "error");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(posts.length, 0);
    } finally {
      release();
      await stopAndClean(server);
    }
  });

  it("logs a failed notification against the run and never breaks the run itself", async () => {
    const slack = await createSlackComponent({
      config: createConfigComponent({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C123", SITE_URL: "https://validator.example" }),
      logs: recordingLogs([]),
      fetch: async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const server = await startTestServer({ slack });
    const { base } = server;
    try {
      const id = await startRun(base, await syntheticZip(), "?model=0", alice);
      assert.equal((await readEvents(`${base}/api/runs/${id}/events`, alice)).at(-1)!.type, "done");
      const failed = await until(() => server.lines.find((line) => line.message === "slack notification failed" && line.extra.run === id), (line) => line !== undefined);
      assert.equal(failed!.level, "WARN");
      assert.equal(failed!.extra.reason, "SLACK_CHANNEL is not a channel id the app can see.");
    } finally {
      await stopAndClean(server);
    }
  });
});

describe("the kept upload", () => {
  it("is served as application/zip to the owner and to an operator, and hidden from everyone else", async () => {
    const server = await startTestServer();
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const id = await startRun(base, zip, "?model=0", alice);
      await readEvents(`${base}/api/runs/${id}/events`, alice);
      for (const headers of [alice, bot]) {
        const res = await fetch(`${base}/api/runs/${id}/input.zip`, { headers });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/zip");
        assert.deepEqual(new Uint8Array(await res.arrayBuffer()), zip, "byte for byte what was uploaded");
      }
      assert.equal((await fetch(`${base}/api/runs/${id}/input.zip`, { headers: bob })).status, 404);
      const view = (await (await fetch(`${base}/api/runs/${id}`, { headers: alice })).json()) as { owner?: string; events: Frame[] };
      assert.equal(view.owner, undefined, "a curator is not told who sent a run (it is their own)");
      assert.equal(view.events.at(-1)!.data.zipUrl, `/api/runs/${id}/input.zip`);
      const seen = (await (await fetch(`${base}/api/runs/${id}`, { headers: bot })).json()) as { owner?: string };
      assert.equal(seen.owner, "alice@example.com", "an operator learns who sent it");
    } finally {
      await stopAndClean(server);
    }
  });
});

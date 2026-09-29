import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { manifest, type CaptureRecord, type Finding, type Result } from "@dcl-regenesislabs/wearable-validator";
import { pngBytes } from "../../wearable-validator/test/helpers/synthetic.js";
import { createSlackComponent, frontViews, marketplaceUrl, runMessage, slackError, type RunMessage } from "../src/adapters/slack.js";
import type { RunNotice } from "../src/types.js";
import { recordingLogs, type RecordedLine } from "./components.js";

interface Block {
  type: string;
  text?: { type: string; text: string };
  slack_file?: { id: string };
  alt_text?: string;
  elements?: { type: string; text?: { text: string } | string; url?: string; style?: string }[];
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The JSON body parsed, a form body as its pairs, raw bytes as they were sent. */
  body: Record<string, unknown> | Uint8Array | undefined;
}

interface FakeSlack {
  calls: Call[];
  fetch: typeof globalThis.fetch;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/** Records every call and answers like Slack does; `answer` overrides one method's reply per call. */
function fakeSlack(answer: (method: string, call: Call, index: number) => Response | undefined = () => undefined): FakeSlack {
  const calls: Call[] = [];
  let files = 0;
  let messages = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    let body: Call["body"];
    if (raw instanceof Uint8Array) body = raw;
    else if (typeof raw === "string") body = headers["content-type"]?.startsWith("application/json") ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
    const call: Call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const method = url.startsWith("https://slack.com/api/") ? url.slice("https://slack.com/api/".length) : "upload";
    const custom = answer(method, call, calls.length - 1);
    if (custom) return custom;
    switch (method) {
      case "files.getUploadURLExternal": return json({ ok: true, upload_url: `https://files.slack.com/upload/v1/ticket-${++files}`, file_id: `F${files}` });
      case "files.completeUploadExternal": return json({ ok: true, files: ((body as { files: { id: string; title: string }[] }).files).map(({ id, title }) => ({ id, title })) });
      case "chat.postMessage": return json({ ok: true, channel: "C123", ts: `1700000000.00010${++messages}` });
      case "chat.update": return json({ ok: true, channel: "C123", ts: (body as { ts: string }).ts });
      case "upload": return new Response("OK", { status: 200 });
      default: return json({ ok: false, error: "unknown_method" });
    }
  };
  return { calls, fetch };
}

const methodOf = (call: Call): string => (call.url.startsWith("https://slack.com/api/") ? call.url.slice("https://slack.com/api/".length) : "upload");

function finding(check: string, severity: Finding["severity"], message: string): Finding {
  return { check, group: "model", severity, message, rule: "M-01", docs: "https://docs.example/#x" };
}

function result(overrides: Partial<Result> = {}): Result {
  return { passed: null, checks: [], findings: [], captures: [], summary: { errors: 0, warnings: 0, checked: 0, skipped: 0 }, ...overrides };
}

function capture(id: string, bodyShape: string, view: "avatar" | "wearable", azimuthDegrees: number, extra: Partial<CaptureRecord["request"]> = {}): CaptureRecord {
  const bytes = pngBytes(4, 4);
  return { request: { id, key: id, inputDigest: "in", rendererBuild: "b", recipeVersion: 1, bodyShape, mainFile: "model.glb", view, azimuthDegrees, size: 4, ...extra }, bytes, sha256: "s", width: 4, height: 4 };
}

function notice(overrides: Partial<RunNotice> = {}): RunNotice {
  return {
    id: "0123456789abcdef0123456789abcdef", owner: "alice@example.com", name: "shirt.zip", dir: "/nowhere", startedAt: 1000, beganAt: 2000, finishedAt: 32400,
    outcome: "passed", passed: true, decision: { state: "ready", reasons: [] }, ...overrides
  };
}

const sectionText = (block: Block): string => block.text?.text ?? "";
/** The adapter types blocks loosely (Block Kit is JSON); the tests read them through the shape they expect. */
const blocksOf = (message: RunMessage): Block[] => message.blocks as unknown as Block[];

async function component(fake: FakeSlack, env: Record<string, string> = {}, lines: RecordedLine[] = []) {
  return createSlackComponent({ config: createConfigComponent({ SLACK_BOT_TOKEN: "xoxb-test-token", SLACK_CHANNEL: "C123", SITE_URL: "https://validator.example/", ...env }), logs: recordingLogs(lines), fetch: fake.fetch });
}

describe("runMessage", () => {
  it("names the item, says who sent it, the verdict and that no curator is needed, and links the run on the site", () => {
    const message = runMessage(notice({ item: { name: "Red Shirt", category: "upper_body", itemType: "wearable", rarity: "epic" } }), "https://validator.example", "F1");
    const blocks = blocksOf(message);
    assert.deepEqual(blocks.map((block) => block.type), ["header", "section", "image", "actions", "context"]);
    assert.deepEqual(blocks[0].text, { type: "plain_text", text: "Red Shirt" });
    const summary = sectionText(blocks[1]);
    assert.match(summary, /^\*Sent by\* alice@example\.com\n/);
    assert.match(summary, /\*Item\* Red Shirt \(upper_body · wearable · epic\)/);
    assert.match(summary, /\*Verdict\* ✅ Passed/);
    assert.match(summary, /\*Approval\* ✅ Nothing found — look at the views before approving/);
    assert.deepEqual(blocks[2], { type: "image", slack_file: { id: "F1" }, alt_text: "Red Shirt thumbnail" });
    const button = blocks[3].elements![0];
    assert.equal(button.type, "button");
    assert.equal(button.style, "primary");
    assert.equal(button.url, `https://validator.example/?run=${notice().id}`);
    assert.deepEqual(button.text, { type: "plain_text", text: "Open run" });
    assert.equal(blocks[4].elements![0].text, `run ${notice().id} · rules v${manifest.version} · rendered in 30 s`);
    assert.equal(message.text, "Red Shirt — ✅ Passed — ✅ Nothing found — look at the views before approving (sent by alice@example.com)");
  });

  it("falls back to the zip name without .zip, skips the image without a file id, and links relatively without a site", () => {
    const blocks = blocksOf(runMessage(notice({ name: "My-Item.ZIP" }), ""));
    assert.equal(blocks[0].text!.text, "My-Item");
    assert.deepEqual(blocks.map((block) => block.type), ["header", "section", "actions", "context"]);
    assert.equal(blocks[2].elements![0].url, `/?run=${notice().id}`);
  });

  it("says a marketplace item came from there, linking its page when the URN names a collections-v2 item", () => {
    const contract = "0x" + "ab".repeat(20);
    const urn = `urn:decentraland:matic:collections-v2:${contract}:12`;
    const linked = sectionText(blocksOf(runMessage(notice({ reference: urn, item: { name: "Red Shirt", itemType: "wearable" } }), ""))[1]);
    assert.ok(linked.includes(`*Item* Red Shirt (wearable) · from the marketplace <https://decentraland.org/marketplace/contracts/${contract}/items/12|${urn}>`), linked);
    const other = "urn:decentraland:ethereum:collections-v1:some_collection:some_item";
    const plain = sectionText(blocksOf(runMessage(notice({ reference: other }), ""))[1]);
    assert.ok(plain.includes(`*Item* shirt · from the marketplace \`${other}\``), plain);
    assert.equal(marketplaceUrl(other), undefined);
    assert.equal(marketplaceUrl(`URN:decentraland:ethereum:collections-v2:${contract.toUpperCase()}:3`), `https://decentraland.org/marketplace/contracts/${contract}/items/3`);
    assert.equal(marketplaceUrl(`urn:decentraland:amoy:collections-v2:${contract}:1`), `https://decentraland.zone/marketplace/contracts/${contract}/items/1`, "the test network's items live on decentraland.zone");
    assert.ok(!sectionText(blocksOf(runMessage(notice(), ""))[1]).includes("marketplace"), "an upload says nothing about it");
  });

  it("keeps the header under 150 characters and escapes what mrkdwn would read as markup", () => {
    const name = "<b>&".repeat(60);
    const blocks = blocksOf(runMessage(notice({ item: { name, itemType: "emote" }, owner: "<script>@example.com" }), ""));
    assert.equal(blocks[0].text!.text.length, 150);
    assert.ok(blocks[0].text!.text.endsWith("…"));
    const summary = sectionText(blocks[1]);
    assert.match(summary, /\*Sent by\* &lt;script&gt;@example\.com/);
    assert.match(summary, /&lt;b&gt;&amp;/);
    assert.ok(!/<b>/.test(summary));
    assert.match(summary, /\(emote\)/);
  });

  it("words every verdict and every decision state", () => {
    const wording = (outcome: RunNotice["outcome"], decision: RunNotice["decision"]) => sectionText(blocksOf(runMessage(notice({ outcome, decision }), ""))[1]);
    assert.match(wording("failed", { state: "blocked", reasons: ["render-valid: nothing drawn"] }), /\*Verdict\* ❌ Failed\n\*Approval\* ⛔ Blocked: render-valid: nothing drawn/);
    assert.match(wording("no-verdict", { state: "review", reasons: ["visual-quality was not reviewed (no model)", "2 warnings"] }), /\*Verdict\* ⚠️ No verdict\n\*Approval\* 👀 Needs a curator: visual-quality was not reviewed \(no model\), 2 warnings/);
    assert.match(wording("gate", { state: "blocked", reasons: ["3 code errors"] }), /\*Verdict\* ❌ Failed the code checks\n\*Approval\* ⛔ Blocked: 3 code errors/);
    assert.match(wording("error", { state: "blocked", reasons: ["the run failed"] }), /\*Verdict\* 💥 The run failed\n\*Approval\* ⛔ Blocked: the run failed/);
  });

  it("lists at most five findings, errors first, escaped, and counts the rest", () => {
    const gate = result({ findings: [finding("metadata", "warning", "Tag <odd> & strange."), finding("triangle-count", "error", "1,600 > 1,500 tris.")], summary: { errors: 1, warnings: 1, checked: 2, skipped: 0 } });
    const visual = result({ findings: Array.from({ length: 6 }, (_, i) => finding("visual-quality", "warning", `Aspect ${i}.`)) });
    const blocks = blocksOf(runMessage(notice({ gate, visual, outcome: "failed", decision: { state: "blocked", reasons: ["1 code error"] } }), ""));
    assert.equal(blocks[2].type, "section");
    const lines = sectionText(blocks[2]).split("\n");
    assert.equal(lines[0], "• *triangle-count* — 1,600 &gt; 1,500 tris.");
    assert.equal(lines[1], "• *metadata* — Tag &lt;odd&gt; &amp; strange.");
    assert.equal(lines.length, 6);
    assert.equal(lines[5], "_+3 more_");
  });

  it("lists a finding every body shape repeats once, with how many times it came up", () => {
    const seam = "This looping emote ends in a different pose than it starts.";
    const gate = result({ findings: [finding("loop-seam", "warning", seam), finding("loop-seam", "warning", seam), finding("file-size", "error", "4.03 MB of 3 MB.")] });
    const lines = sectionText(blocksOf(runMessage(notice({ gate }), ""))[2]).split("\n");
    assert.deepEqual(lines, ["• *file-size* — 4.03 MB of 3 MB.", `• *loop-seam* — ${seam} _(×2)_`]);
  });

  it("never lets the findings section pass 3000 characters", () => {
    const visual = result({ findings: Array.from({ length: 5 }, (_, i) => finding("visual-quality", "warning", `${i} ` + "x".repeat(900))) });
    const blocks = blocksOf(runMessage(notice({ visual }), ""));
    const text = sectionText(blocks[2]);
    assert.ok(text.length <= 3000);
    assert.match(text, /_\+\d more_$/);
    const huge = result({ findings: [finding("visual-quality", "warning", "y".repeat(5000))] });
    const alone = sectionText((blocksOf(runMessage(notice({ visual: huge }), "")))[2]);
    assert.ok(alone.length <= 3000 && alone.startsWith("• *visual-quality* — yyy"));
  });

  it("adds the model cost to the context line when the rows carry usage, and omits the render time without a start", () => {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.0123 };
    const checks: Result["checks"] = [
      { check: "thumbnail-honesty", group: "rendering", status: "passed", coverage: "complete", review: { provider: "p", model: "m", promptVersion: 1, promptDigest: "d", usage } },
      { check: "visual-quality", group: "rendering", status: "passed", coverage: "complete", review: { provider: "p", model: "m", promptVersion: 1, promptDigest: "d", usage: { ...usage, cost: 0.02 } } }
    ];
    const blocks = blocksOf(runMessage(notice({ visual: result({ checks }), beganAt: undefined }), ""));
    assert.equal(blocks.at(-1)!.elements![0].text, `run ${notice().id} · rules v${manifest.version} · $0.0323`);
  });

  it("picks the worn front view of each body shape for the thread, never a stress pose", () => {
    const captures = [capture("BaseMale-wearable-000", "BaseMale", "wearable", 0), capture("BaseMale-avatar-000", "BaseMale", "avatar", 0), capture("BaseMale-avatar-090", "BaseMale", "avatar", 90), capture("BaseMale-avatardab-000-t0.5", "BaseMale", "avatar", 0, { pose: "dab", timeFraction: 0.5, skin: "00ff00" }), capture("BaseFemale-avatar-000", "BaseFemale", "avatar", 0)];
    assert.deepEqual(frontViews(captures).map((entry) => entry.request.id), ["BaseMale-avatar-000", "BaseFemale-avatar-000"]);
    assert.deepEqual(frontViews([capture("BaseMale-avatar-000", "BaseMale", "avatar", 0, { pose: "dab", timeFraction: 0.5, skin: "00ff00" })]), []);
  });

  it("picks the middle of the clip for an emote, one frame per body shape", () => {
    const emote = [0, 0.25, 0.5, 0.75, 1].flatMap((t) => ["BaseMale", "BaseFemale"].flatMap((shape) => [capture(`${shape}-avatar-000-t${t}`, shape, "avatar", 0, { timeFraction: t }), capture(`${shape}-avatar-090-t${t}`, shape, "avatar", 90, { timeFraction: t })]));
    assert.deepEqual(frontViews(emote).map((entry) => entry.request.id), ["BaseMale-avatar-000-t0.5", "BaseFemale-avatar-000-t0.5"]);
  });

  it("keeps alt texts within Slack's limits and cuts on whole characters", () => {
    const name = "x".repeat(148) + "😀 and more";
    const blocks = blocksOf(runMessage(notice({ item: { name: "n".repeat(2500), itemType: "wearable" } }), "", "F1"));
    assert.ok((blocks[2].alt_text as string).length <= 2000);
    const header = blocksOf(runMessage(notice({ item: { name, itemType: "wearable" } }), ""))[0].text!.text;
    assert.ok(header.length <= 150 && header.endsWith("…"));
    assert.equal(header, "x".repeat(148) + "…", "the emoji that did not fit whole is dropped, not halved");
  });

  it("keeps URLs and domains in item names and findings from becoming links", () => {
    const visual = result({ findings: [finding("visual-quality", "warning", "Re-export it with the tool at https://evil.example/fix or evil.example.")] });
    const message = runMessage(notice({ item: { name: "Shirt from promo.example", itemType: "wearable" }, visual }), "");
    // mrkdwn is what Slack links; header and alt text are plain_text
    const linked: string[] = [message.text];
    JSON.stringify(message.blocks, (key, value: unknown) => {
      if (value && typeof value === "object" && "type" in value && value.type === "mrkdwn" && "text" in value) linked.push(String(value.text));
      return value;
    });
    for (const text of linked) assert.ok(!/:\/\/|evil\.example|promo\.example/.test(text), text);
    assert.match(message.text, /^Shirt from promo\.\u200bexample — /);
  });

  it("escapes the notification fallback text like the blocks", () => {
    const message = runMessage(notice({ item: { name: "<!channel> Shirt & Co", itemType: "wearable" } }), "");
    assert.ok(message.text.startsWith("&lt;!channel&gt; Shirt &amp; Co — "));
  });
});

describe("the Slack component", () => {
  it("is off without a token and says so once", async () => {
    const lines: RecordedLine[] = [];
    const fake = fakeSlack();
    const slack = await createSlackComponent({ config: createConfigComponent({}), logs: recordingLogs(lines), fetch: fake.fetch });
    assert.equal(slack.enabled, false);
    await slack.notify(notice());
    assert.equal(fake.calls.length, 0);
    assert.ok(lines.some((line) => line.level === "INFO" && line.message.startsWith("slack notifications disabled")));
    await assert.rejects(createSlackComponent({ config: createConfigComponent({ SLACK_BOT_TOKEN: "xoxb-x" }), logs: recordingLogs(lines), fetch: fake.fetch }), /SLACK_CHANNEL/);
  });

  it("posts the message, shares the thumbnail and both front views into its thread, then shows the thumbnail in the message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-run-"));
    const thumbnail = pngBytes(8, 8);
    await writeFile(join(dir, "thumbnail.png"), thumbnail);
    const lines: RecordedLine[] = [];
    const fake = fakeSlack();
    const slack = await component(fake, {}, lines);
    try {
      assert.deepEqual([slack.enabled, slack.channel], [true, "C123"]);
      const visual = result({ captures: [capture("BaseMale-avatar-000", "BaseMale", "avatar", 0), capture("BaseMale-avatar-090", "BaseMale", "avatar", 90), capture("BaseFemale-avatar-000", "BaseFemale", "avatar", 0)] });
      await slack.notify(notice({ dir, visual, item: { name: "Red Shirt", itemType: "wearable" } }));
      assert.deepEqual(fake.calls.map(methodOf), [
        "chat.postMessage",
        "files.getUploadURLExternal", "upload",
        "files.getUploadURLExternal", "upload",
        "files.getUploadURLExternal", "upload",
        "files.completeUploadExternal",
        "chat.update"
      ]);
      const [post, ticket, upload] = fake.calls;
      const body = post.body as { channel: string; text: string; unfurl_links: boolean; unfurl_media: boolean; blocks: Block[]; thread_ts?: string };
      assert.equal(post.headers["content-type"], "application/json; charset=utf-8");
      assert.deepEqual([body.channel, body.unfurl_links, body.unfurl_media, body.thread_ts], ["C123", false, false, undefined]);
      assert.match(body.text, /^Red Shirt — ✅ Passed/);
      assert.ok(!body.blocks.some((block) => block.type === "image"), "no image until its file is shared");
      assert.equal(body.blocks.find((block) => block.type === "actions")!.elements![0].url, `https://validator.example/?run=${notice().id}`);
      assert.equal(ticket.headers.authorization, "Bearer xoxb-test-token");
      assert.equal(ticket.headers["content-type"], "application/x-www-form-urlencoded");
      assert.deepEqual(ticket.body, { filename: "thumbnail.png", length: String(thumbnail.byteLength), alt_txt: "Red Shirt thumbnail" });
      assert.equal(upload.url, "https://files.slack.com/upload/v1/ticket-1");
      assert.equal(upload.headers["content-type"], "application/octet-stream");
      assert.equal(upload.headers.authorization, undefined, "the pre-signed upload URL never sees the token");
      assert.deepEqual(upload.body, thumbnail);
      assert.deepEqual([fake.calls[3].body, fake.calls[5].body].map((entry) => (entry as Record<string, string>).filename), ["BaseMale-avatar-000.png", "BaseFemale-avatar-000.png"]);
      assert.deepEqual(fake.calls[7].body, {
        files: [{ id: "F1", title: "Red Shirt thumbnail" }, { id: "F2", title: "Red Shirt worn, BaseMale" }, { id: "F3", title: "Red Shirt worn, BaseFemale" }],
        channel_id: "C123",
        thread_ts: "1700000000.000101",
        initial_comment: "Thumbnail and rendered front views"
      }, "one share into the message's thread");
      const update = fake.calls[8].body as { channel: string; ts: string; blocks: Block[] };
      assert.deepEqual([update.channel, update.ts], ["C123", "1700000000.000101"]);
      assert.deepEqual(update.blocks.find((block) => block.type === "image"), { type: "image", slack_file: { id: "F1" }, alt_text: "Red Shirt thumbnail" });
      const notified = lines.filter((line) => line.message === "slack notified");
      assert.equal(notified.length, 1);
      assert.deepEqual(notified[0].extra, { run: notice().id, channel: "C123", ts: "1700000000.000101" });
      assert.ok(!JSON.stringify(lines).includes("xoxb-"), "the token never reaches a log line");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("posts without a thumbnail when the folder has none, and without a thread when there are no captures", async () => {
    const fake = fakeSlack();
    const slack = await component(fake);
    await slack.notify(notice({ dir: "/no/such/folder" }));
    assert.deepEqual(fake.calls.map(methodOf), ["chat.postMessage"]);
    const body = fake.calls[0].body as { blocks: Block[] };
    assert.ok(!body.blocks.some((block) => block.type === "image"));
  });

  it("rejects a message Slack refuses", async () => {
    let posts = 0;
    const fake = fakeSlack((method) => {
      if (method !== "chat.postMessage") return undefined;
      posts++;
      return json({ ok: false, error: "invalid_blocks" });
    });
    const slack = await component(fake);
    await assert.rejects(slack.notify(notice({ dir: "/no/such/folder" })), /Slack answered invalid_blocks to chat\.postMessage\./);
    assert.equal(posts, 1);
  });

  it("retries the thumbnail edit once while Slack processes the file, then leaves it in the thread and warns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-run-"));
    await writeFile(join(dir, "thumbnail.png"), pngBytes(8, 8));
    const lines: RecordedLine[] = [];
    let updates = 0;
    const fake = fakeSlack((method) => {
      if (method !== "chat.update") return undefined;
      updates++;
      return json({ ok: false, error: "invalid_blocks" });
    });
    const slack = await component(fake, {}, lines);
    try {
      await slack.notify(notice({ dir }));
      assert.equal(updates, 2);
      assert.ok(lines.some((line) => line.level === "WARN" && line.message === "slack kept the thumbnail in the thread only"));
      assert.equal(lines.filter((line) => line.message === "slack notified").length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honours one 429 with retry-after before giving up", async () => {
    let first = true;
    const fake = fakeSlack((method) => {
      if (method !== "chat.postMessage" || !first) return undefined;
      first = false;
      return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" });
    });
    const slack = await component(fake);
    await slack.notify(notice());
    assert.deepEqual(fake.calls.map(methodOf), ["chat.postMessage", "chat.postMessage"]);
    const always = fakeSlack(() => json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" }));
    await assert.rejects((await component(always)).notify(notice()), /Slack answered HTTP 429 to chat\.postMessage\./);
    assert.equal(always.calls.length, 2, "one retry, not a loop");
  });

  it("turns Slack's error codes into what the operator must do", async () => {
    assert.equal(slackError("chat.postMessage", "not_in_channel").message, "Invite the Slack app to the channel (/invite @app) or grant chat:write.public.");
    assert.equal(slackError("chat.postMessage", "channel_not_found").message, "SLACK_CHANNEL is not a channel id the app can see.");
    for (const code of ["invalid_auth", "not_authed", "token_expired"]) assert.equal(slackError("chat.postMessage", code).message, "SLACK_BOT_TOKEN is not a valid bot token.");
    assert.equal(slackError("files.getUploadURLExternal", "missing_scope").message, "The Slack app needs the chat:write and files:write scopes.");
    assert.equal(slackError("chat.postMessage", "msg_too_long").message, "Slack answered msg_too_long to chat.postMessage.");
    const fake = fakeSlack((method) => (method === "chat.postMessage" ? json({ ok: false, error: "not_in_channel" }) : undefined));
    await assert.rejects((await component(fake)).notify(notice()), /Invite the Slack app to the channel/);
  });

  it("still posts when the images cannot be shared, and only logs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-run-"));
    await writeFile(join(dir, "thumbnail.png"), pngBytes(8, 8));
    const lines: RecordedLine[] = [];
    const fake = fakeSlack((method) => (method === "files.getUploadURLExternal" ? json({ ok: false, error: "missing_scope" }) : undefined));
    const slack = await component(fake, {}, lines);
    try {
      await slack.notify(notice({ dir, visual: result({ captures: [capture("BaseMale-avatar-000", "BaseMale", "avatar", 0)] }) }));
      assert.deepEqual(fake.calls.map(methodOf), ["chat.postMessage", "files.getUploadURLExternal"]);
      assert.ok(lines.some((line) => line.level === "WARN" && line.message === "slack images failed" && String(line.extra.reason).includes("files:write")));
      assert.equal(lines.filter((line) => line.message === "slack notified").length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

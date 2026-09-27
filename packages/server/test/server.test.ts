import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { createAccessVerifier } from "../src/adapters/access.js";
import { accessIdentity } from "../src/adapters/identity.js";
import { hostAllowed } from "../src/logic/hosts.js";
import { fakeRenderer, startTestServer, type ServiceCalls, type TestServer } from "./components.js";

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

interface RunRow {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  queued: boolean;
}

interface QueueView {
  running: { position: number; mine: boolean; id?: string; name?: string; since: number }[];
  waiting: { position: number; mine: boolean; id?: string; name?: string; since: number }[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
}

const body = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const alice = { "x-test-user": "alice" };
const bob = { "x-test-user": "bob" };
const carol = { "x-test-user": "carol" };
/** A service identity: an operator that reads everything and changes nothing. */
const bot = { "x-test-user": "service:slack-bot" };
const zipUpload = { "content-type": "application/zip" };

/** One raw HTTP/1.1 request, so the path and Host reach the server exactly as written. */
function rawRequest(base: string, path: string, host = new URL(base).host, headers: Record<string, string> = {}): Promise<string> {
  const { hostname, port } = new URL(base);
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

function parseFrames(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const type = /event: (.*)/.exec(block)![1];
      const data = /data: (.*)/.exec(block)![1];
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/** Reads one SSE stream to its end and returns the parsed frames. */
async function readEvents(url: string, headers: Record<string, string> = alice): Promise<Frame[]> {
  return parseFrames(await (await fetch(url, { headers })).text());
}

async function startRun(base: string, zip: Uint8Array, query = "", headers: Record<string, string> = alice): Promise<string> {
  const res = await fetch(`${base}/api/runs${query}`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...headers } });
  if (res.status !== 201) assert.fail(`expected 201, got ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function queueAs(base: string, headers: Record<string, string>): Promise<QueueView> {
  return (await (await fetch(`${base}/api/queue`, { headers })).json()) as QueueView;
}

async function listAs(base: string, headers: Record<string, string>): Promise<RunRow[]> {
  return ((await (await fetch(`${base}/api/runs`, { headers })).json()) as { runs: RunRow[] }).runs;
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

/** A renderer that does not answer until the test says so, to hold a run in the render slot. */
function heldRenderer(calls: ServiceCalls): { renderer: ReturnType<typeof fakeRenderer>; release(): void } {
  let release!: () => void;
  const gate = { open: new Promise<void>((resolve) => (release = resolve)) };
  return { renderer: fakeRenderer(calls, gate), release };
}

/** A cancelled run may still be writing its last event when the server stops: retry the sweep rather than race it. */
async function stopAndClean(server: TestServer): Promise<void> {
  await server.stop();
  await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("run server", () => {
  let server: TestServer;
  let base: string;
  const calls: ServiceCalls = { services: 0, rendered: [] };

  before(async () => {
    server = await startTestServer({ env: { MAX_UPLOAD_BYTES: String(4 * 1024 * 1024) }, renderer: fakeRenderer(calls) });
    base = server.base;
  });
  after(() => stopAndClean(server));

  it("reports its capabilities, without identity, and names the caller when it can", async () => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; visual: { renderer: boolean; reviewer: string }; checks: string[]; rulesVersion: string; owner: string | null; operator: boolean; build: { version: string; commit: string; builtAt: string | null; startedAt: number } };
    assert.equal(health.build.commit, "dev", "a checkout has no build-info.json: the Docker image writes one from COMMIT_HASH");
    assert.equal(health.build.builtAt, null);
    assert.ok(health.build.startedAt > 0 && typeof health.build.version === "string");
    assert.equal(health.ok, true);
    assert.deepEqual(health.visual, { renderer: true, reviewer: "dry-run" });
    assert.deepEqual(health.checks, ["render-valid", "thumbnail-honesty", "visual-quality", "emote-quality"]);
    assert.equal(health.rulesVersion, manifest.version);
    assert.equal(health.owner, null);
    assert.equal(health.operator, false);
    const known = (await (await fetch(`${base}/api/health`, { headers: alice })).json()) as { owner: string | null; operator: boolean };
    assert.deepEqual([known.owner, known.operator], ["alice", false]);
    const operator = (await (await fetch(`${base}/api/health`, { headers: { ...alice, "x-test-operator": "1" } })).json()) as { owner: string | null; operator: boolean };
    assert.deepEqual([operator.owner, operator.operator], ["alice", true], "the site asks for everyone's runs only for an operator who is a person");
    const service = (await (await fetch(`${base}/api/health`, { headers: bot })).json()) as { owner: string | null; operator: boolean };
    assert.deepEqual([service.owner, service.operator], [null, false], "a service token is not a person: the site never greets it");
  });

  it("answers 401 on every other route without an identity, and keeps those refusals out of the operator log", async () => {
    for (const path of ["/api/runs", "/api/runs/nope", "/api/runs/nope/events", "/api/runs/nope/captures/x.png", "/api/queue", "/api/stats", "/api/logs"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
      assert.equal(((await res.json()) as { message: string }).message, "Sign in to use the run server.");
    }
    assert.equal((await fetch(`${base}/api/runs`, { method: "POST", body: body(await syntheticZip()) })).status, 401);
    assert.equal((await fetch(`${base}/api/runs/nope`, { method: "DELETE" })).status, 401);

    const logs = (await (await fetch(`${base}/api/logs?limit=2000`, { headers: bot })).json()) as { lines: { message: string; fields: Record<string, unknown> }[] };
    assert.ok(!logs.lines.some((line) => line.message === "request refused"), "a refusal never enters the ring buffer");
    assert.ok(!logs.lines.some((line) => line.message === "request" && line.fields.status === 401), "nor its access-log line");
    const refused = server.lines.filter((line) => line.message === "request refused" && line.extra.reason === "no-identity");
    assert.ok(refused.length >= 9, "the host's collector still sees each one, at debug level");
    assert.ok(refused.every((line) => line.level === "DEBUG"));
    assert.deepEqual(refused.map((line) => line.extra.api).filter((api) => api !== "runs"), ["queue", "stats", "logs"]);
    assert.match(await server.metricsText(), /refused_requests_total\{reason="no-identity"\} (9|[1-9]\d)/);
  });

  it("answers a JSON 404 for an API path no route claims", async () => {
    const res = await fetch(`${base}/api/nope`, { headers: alice });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { message: "Not found." });
  });

  it("refuses cross-site browser calls that start or cancel a run, and accepts same-origin ones", async () => {
    const zip = await syntheticZip();
    const crossSite = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice, "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const id = await startRun(base, zip, "?model=0", { ...alice, "sec-fetch-site": "same-origin" });
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: { ...alice, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: { ...alice, "sec-fetch-site": "none" } })).status, 202);
    await readEvents(`${base}/api/runs/${id}/events`);
  });

  it("lets a service identity read but never start or cancel a run", async () => {
    const zip = await syntheticZip();
    const refused = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...bot } });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { message: string }).message, /read-only/);
    const id = await startRun(base, zip, "?model=0");
    assert.equal((await fetch(`${base}/api/runs/${id}`, { headers: bot })).status, 200, "an operator sees the run");
    const cancel = await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: bot });
    assert.equal(cancel.status, 403, "but cannot cancel it");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    assert.equal(events.at(-1)?.type, "done", "the run was not touched");
    assert.match(await server.metricsText(), /refused_requests_total\{reason="read-only-service"\} 2/);
  });

  it("takes only application/zip uploads: what a form or a no-cors fetch from another site can never send", async () => {
    const zip = body(await syntheticZip());
    for (const type of [undefined, "text/plain", "multipart/form-data; boundary=x"]) {
      const res = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: type ? { ...alice, "content-type": type } : alice });
      assert.equal(res.status, 415, String(type));
      assert.match(((await res.json()) as { message: string }).message, /application\/zip/);
    }
    const id = await startRun(base, await syntheticZip(), "?model=0", { ...alice, "content-type": "Application/Zip; charset=binary" });
    await readEvents(`${base}/api/runs/${id}/events`);
  });

  it("refuses a name that does not decode without taking the run slot, and cuts a long one down to a folder name", async () => {
    const zip = await syntheticZip();
    const bad = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice, "x-file-name": "%" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /x-file-name/);
    const long = await startRun(base, zip, "?model=0", { ...alice, "x-file-name": encodeURIComponent("a".repeat(300) + ".zip") });
    await readEvents(`${base}/api/runs/${long}/events`);
    const name = (await listAs(base, alice)).find((row) => row.id === long)!.name;
    assert.equal(name.length, 80);
    assert.match(name, /^a+\.zip$/);
  });

  it("stops at the code gate: an item with code errors is neither rendered nor reviewed unless asked", async () => {
    const zip = await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) });
    const id = await startRun(base, zip, "", { ...alice, "x-file-name": "bad.zip" });
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("gate"));
    assert.equal(types.filter((t) => t === "capture").length, 0, "no rendering");
    assert.equal(types.filter((t) => t === "review").length, 0, "no model call");
    assert.equal((events.at(-1)!.data as { skipped?: boolean }).skipped, true);
    assert.equal((events.at(-1)!.data.gate as { passed: boolean }).passed, false, "the done event carries the code gate for History");
    assert.ok(types.filter((t) => t === "check").length > 10, "the code checks stream too");
    const forced = await startRun(base, zip, "?standalone=1");
    const forcedEvents = await readEvents(`${base}/api/runs/${forced}/events`);
    assert.equal(forcedEvents.filter((e) => e.type === "capture").length, 20, "standalone renders");
    assert.equal(forcedEvents.filter((e) => e.type === "review").length, 4, "and asks the model");
  });

  it("renders without the model when asked with model=0 even if code checks pass", async () => {
    const id = await startRun(base, await syntheticZip(), "?model=0");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    assert.equal(events.filter((e) => e.type === "review").length, 0);
    assert.equal(events.filter((e) => e.type === "capture").length, 20);
  });

  it("announces a one-shape item's plan on its single body shape", async () => {
    const data = { category: "hat", tags: ["test"], hides: [], replaces: [], representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }] };
    const zip = await syntheticZip({ manifest: { name: "One shape", description: "synthetic", rarity: "common", data } });
    const id = await startRun(base, zip, "?model=0&standalone=1");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const captures = events.filter((e) => e.type === "capture").length;
    const rendering = events.find((e) => e.type === "stage" && e.data.views !== undefined)!;
    assert.deepEqual(rendering.data, { text: `Rendering ${captures} views on BaseMale`, views: captures, bodyShapes: ["BaseMale"] });
    assert.equal(captures, 10, "half the two-shape recipe");
  });

  it("streams every capture, the prompt and the answer, and serves the images", async () => {
    const zip = await syntheticZip();
    const id = await startRun(base, zip, "?standalone=1", { ...alice, "x-file-name": "shirt.zip" });
    assert.equal(id.length, 32, "16 random bytes as hex");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const captures = events.filter((e) => e.type === "capture");
    assert.equal(captures.length, 20);
    assert.ok(captures.some((c) => c.data.id === "BaseMale-wearable-000"), "the item-alone front view is among them");
    const rendering = events.find((e) => e.type === "stage" && e.data.views !== undefined)!;
    assert.deepEqual(rendering.data, { text: "Rendering 20 views on BaseMale and BaseFemale", views: captures.length, bodyShapes: ["BaseMale", "BaseFemale"] }, "the site sizes its placeholders from the stage event");
    const reviews = events.filter((e) => e.type === "review").map((e) => `${e.data.check}:${e.data.phase}`);
    assert.deepEqual(reviews, ["thumbnail-honesty:request", "thumbnail-honesty:answer", "visual-quality:request", "visual-quality:answer"]);
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    const result = done.data.result as { checks: { check: string; status: string }[]; captures: { url: string }[] };
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
    assert.equal(result.captures.length, 20);
    const gate = done.data.gate as { passed: boolean; checks: { check: string }[]; captures: unknown[] };
    assert.equal(gate.passed, true, "the done event carries the code gate beside the visual result");
    assert.ok(gate.checks.some((row) => row.check === "triangle-count"));
    assert.deepEqual(gate.captures, []);
    assert.equal(JSON.parse(await readFile(join(server.artifacts, `visual-shirt-${id}`, "gate.json"), "utf8")).passed, true, "and gate.json keeps it for History");
    const image = await fetch(`${base}${captures[3].data.url}`, { headers: alice });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(new Uint8Array(await image.arrayBuffer())[1], 0x50);
    const prompt = await fetch(`${base}/api/runs/${id}/thumbnail-honesty/1-prompt.md`, { headers: alice });
    assert.equal(prompt.status, 200);
    assert.match(await prompt.text(), /Image ID: BaseMale-avatar-000/);
    assert.ok(calls.services >= 1);
    const runs = await listAs(base, alice);
    const input = JSON.parse(await readFile(join(server.artifacts, `visual-shirt-${id}`, "input.json"), "utf8")) as Record<string, unknown>;
    assert.equal(input.id, id);
    assert.equal(input.owner, "alice");
    assert.equal(input.name, "shirt.zip");
    assert.equal(input.startedAt, runs.find((row) => row.id === id)!.startedAt);
    assert.equal(typeof input.sha256, "string");
    assert.ok((await stat(join(server.artifacts, `visual-shirt-${id}`, "input.zip"))).isFile(), "the upload stays in the folder: the site offers it as Download zip");
  });

  it("hides a run from everyone but its owner: 404 on the run, its events, its files and cancel", async () => {
    const id = await startRun(base, await syntheticZip(), "?model=0");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const capture = events.find((e) => e.type === "capture")!.data.url as string;
    for (const path of [`/api/runs/${id}`, `/api/runs/${id}/events`, capture]) {
      const res = await fetch(`${base}${path}`, { headers: bob });
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as { message: string }).message, "Unknown run.");
    }
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: bob })).status, 404);
    assert.equal((await fetch(`${base}${capture}`, { headers: alice })).status, 200);
    assert.ok((await listAs(base, bob)).every((row) => row.id !== id), "bob's list never shows alice's run");
    const bobsLines = server.lines.filter((line) => line.message === "request" && line.extra.owner === "bob");
    assert.deepEqual(bobsLines.map((line) => [line.level, line.extra.route, line.extra.status]), [
      ["INFO", "/api/runs/:id", 404], ["INFO", "/api/runs/:id/events", 404], ["INFO", "/api/runs/:id/(.*)", 404], ["INFO", "/api/runs/:id", 404]
    ], "a thrown 404 is logged as the 404 the client got, never as a 500; the site's list polling is not logged at all");
  });

  it("serves Prometheus metrics at /metrics, behind the bearer token when one is set", async () => {
    await fetch(`${base}/api/health`);
    const open = await fetch(`${base}/metrics`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get("content-type") ?? "", /text\/plain/);
    const text = await open.text();
    assert.match(text, /http_requests_total\{method="GET",handler="\/api\/health",code="200"\}/);
    assert.match(text, /runs_accepted_total/);
    const gated = await startTestServer({ env: { WKC_METRICS_BEARER_TOKEN: "metrics-secret" } });
    try {
      assert.equal((await fetch(`${gated.base}/metrics`)).status, 401);
      assert.equal((await fetch(`${gated.base}/metrics`, { headers: { authorization: "Bearer metrics-secret" } })).status, 200);
    } finally {
      await stopAndClean(gated);
    }
    const exposed = await startTestServer({ env: { HTTP_SERVER_HOST: "0.0.0.0" } });
    try {
      const res = await fetch(`${exposed.base}/metrics`);
      assert.doesNotMatch(await res.text(), /runs_accepted_total/, "a public bind without a token serves no metrics");
    } finally {
      await stopAndClean(exposed);
    }
  });

  it("logs what a check measured without the control characters a model name can carry", async () => {
    const glb = await syntheticGlb({ animation: { name: "\u001b[31mALERT\u001b[0m\nfake log line: run passed", seconds: 1 } });
    const id = await startRun(base, await syntheticZip({ glb, kind: "emote" }), "");
    await readEvents(`${base}/api/runs/${id}/events`);
    const measured = server.lines.filter((line) => line.message === "check finished" && line.extra.run === id).map((line) => String(line.extra.measured ?? ""));
    assert.ok(measured.some((text) => text.includes("ALERT")), "the clip name reaches the log");
    assert.ok(measured.every((text) => !/[\u0000-\u001f\u007f-\u009f]/.test(text)), "without its escape sequences or newlines");
  });

  it("lists only the caller's runs, newest first, with a verdict", async () => {
    const bobRun = await startRun(base, await syntheticZip(), "?standalone=1", { ...bob, "x-file-name": "bobs.zip" });
    await readEvents(`${base}/api/runs/${bobRun}/events`, bob);
    const older = await startRun(base, await syntheticZip(), "?standalone=1", { ...alice, "x-file-name": "older.zip" });
    await readEvents(`${base}/api/runs/${older}/events`);
    const newer = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "", { ...alice, "x-file-name": "newer.zip" });
    await readEvents(`${base}/api/runs/${newer}/events`);
    const runs = await listAs(base, alice);
    assert.deepEqual(runs.slice(0, 2).map((row) => row.id), [newer, older]);
    assert.ok(runs.every((row) => row.done));
    assert.ok(runs.every((row) => row.id !== bobRun));
    assert.equal(runs[0].name, "newer.zip");
    assert.equal(runs[0].passed, false, "stopped at the code gate");
    assert.equal(runs[1].passed, true, "every visual row passed");
    assert.ok(runs[0].startedAt >= runs[1].startedAt);
    assert.deepEqual((await listAs(base, bob)).map((row) => row.id), [bobRun]);
  });

  it("lists a standalone run whose code checks failed as failed, whatever the visual rows say", async () => {
    const id = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "?standalone=1", { ...alice, "x-file-name": "gated.zip" });
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    assert.equal((events.find((e) => e.type === "gate")!.data as { passed: boolean | null }).passed, false);
    const result = (events.at(-1)!.data as { result: { checks: { status: string }[] } }).result;
    assert.ok(result.checks.every((row) => row.status === "passed"), "the visual rows alone would pass");
    assert.equal((await listAs(base, alice)).find((row) => row.id === id)!.passed, false, "the code gate still decides the verdict");
  });

  it("shows an earlier run's photos at once and renders nothing again for the same file", async () => {
    const zip = await syntheticZip();
    const first = await startRun(base, zip, "?standalone=1");
    await readEvents(`${base}/api/runs/${first}/events`);
    const renderedBefore = calls.rendered.length;
    const second = await startRun(base, zip, "?standalone=1");
    const events = await readEvents(`${base}/api/runs/${second}/events`);
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === "capture").length, 20);
    assert.ok(types.indexOf("capture") < types.indexOf("review"), "photos arrive before the model is asked");
    assert.deepEqual(calls.rendered.slice(renderedBefore), [], "no renderer call for an unchanged file");
    assert.equal(events.at(-1)!.type, "done");
  });

  it("replays a finished run after Last-Event-ID and refuses paths outside the run folder", async () => {
    const zip = await syntheticZip();
    const id = await startRun(base, zip, "?standalone=1");
    const all = await readEvents(`${base}/api/runs/${id}/events`);
    const later = await (await fetch(`${base}/api/runs/${id}/events`, { headers: { ...alice, "last-event-id": String(all.length - 2) } })).text();
    assert.equal(parseFrames(later).length, 2);
    // fetch normalises "..", so speak raw HTTP to make sure the guard itself refuses traversal, encoded or not
    for (const path of [`/api/runs/${id}/captures/../../../etc/passwd`, `/api/runs/${id}/captures/%2e%2e/%2e%2e/%2e%2e/etc/passwd`]) {
      assert.match(await rawRequest(base, path, undefined, alice), /^HTTP\/1\.1 404/);
    }
    assert.equal((await fetch(`${base}/api/runs/nope/events`, { headers: alice })).status, 404);
  });

  it("refuses requests whose Host header is not its own address (DNS rebinding), except the health probe", async () => {
    assert.match(await rawRequest(base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 403/);
    assert.match(await rawRequest(base, "/api/health", "attacker.example"), /^HTTP\/1\.1 200/);
    assert.match(await rawRequest(base, "/api/runs", undefined, alice), /^HTTP\/1\.1 200/);
    assert.equal(hostAllowed("localhost:4180"), true);
    assert.equal(hostAllowed("[::1]:4180"), true);
    assert.equal(hostAllowed("10.0.0.5:4180", "10.0.0.5"), true);
    assert.equal(hostAllowed("evil.example", "10.0.0.5"), false);
    assert.equal(hostAllowed("api.example.com", "0.0.0.0", ["api.example.com"]), true);
    assert.equal(hostAllowed("API.example.com:443", "0.0.0.0", ["api.example.com"]), true);
    assert.equal(hostAllowed("evil.example", "0.0.0.0", ["api.example.com"]), false);
    assert.equal(hostAllowed(undefined), false);
  });

  it("logs a hostile Host header as a fingerprint at debug level: never its text, never in the operator log", async () => {
    // shell and JSON metacharacters a URL host may carry: what an operator's terminal or the Slack bot would otherwise render
    const hostile = "evil_$(id);{json}'\"quoted\".example";
    assert.match(await rawRequest(base, "/api/runs", hostile, alice), /^HTTP\/1\.1 403/);
    const refused = server.lines.filter((line) => line.message === "request refused" && line.extra.reason === "host");
    assert.ok(refused.length >= 1);
    assert.ok(refused.every((line) => line.level === "DEBUG"));
    assert.match(String(refused.at(-1)!.extra.host), new RegExp(`^[0-9a-f]{8}/${hostile.length}$`));
    assert.ok(!JSON.stringify(server.lines).includes("evil_"), "the attacker's bytes reach no log line");
    assert.ok(!server.components.logBuffer.recent(2000).some((line) => line.message === "request refused"), "the ring buffer never keeps a refusal");
    assert.match(await server.metricsText(), /refused_requests_total\{reason="host"\} [1-9]/);
  });

  it("answers 413 with a message instead of dropping the connection on an oversize upload", async () => {
    const res = await fetch(`${base}/api/runs`, { method: "POST", body: new ArrayBuffer(5 * 1024 * 1024), headers: { ...zipUpload, ...alice } });
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { message: string }).message, /larger than 4194304 bytes/);
    assert.ok((await listAs(base, alice)).every((row) => row.name !== "item.zip" || row.done), "nothing was accepted");
  });

  it("accepts two simultaneous uploads and runs them one after the other", async () => {
    const zip = body(await syntheticZip());
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...alice } })));
    assert.deepEqual([a.status, b.status], [201, 201]);
    for (const res of [a, b]) {
      const { id } = (await res.json()) as { id: string };
      const events = await readEvents(`${base}/api/runs/${id}/events`);
      assert.equal(events.at(-1)?.type, "done");
      assert.ok(events.some((event) => event.type === "queue" && event.data.position === 0), "every run hears when its turn comes");
    }
  });
});

describe("the waiting line", () => {
  it("runs in arrival order, tells each run its place, names only your own items, and lets a waiting run leave", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      // each code gate runs in its own worker thread: a run joins the line when its gate finishes, so start them one by one
      const queued = (count: number) => until(() => queueAs(base, alice), (q) => q.running.length + q.waiting.length === count);
      const a = await startRun(base, zip, "?model=0", alice);
      await queued(1);
      const b = await startRun(base, zip, "?model=0", bob);
      await queued(2);
      const c = await startRun(base, zip, "?model=0", alice);
      const view = await until(() => queueAs(base, alice), (q) => q.running.length === 1 && q.waiting.length === 2);
      assert.deepEqual(view.running.map((entry) => [entry.mine, entry.id]), [[true, a]]);
      assert.deepEqual(view.waiting.map((entry) => [entry.position, entry.mine, entry.id, entry.name]), [[1, false, undefined, undefined], [2, true, c, "item.zip"]]);
      assert.equal(view.averageRunMs, null, "no estimate before the first run finishes");
      const bobView = await queueAs(base, bob);
      assert.deepEqual(bobView.waiting.map((entry) => [entry.position, entry.mine, entry.id]), [[1, true, b], [2, false, undefined]]);
      assert.equal(bobView.running[0].id, undefined);

      const cEvents = (await (await fetch(`${base}/api/runs/${c}`, { headers: alice })).json()) as { events: Frame[] };
      const told = cEvents.events.filter((event) => event.type === "queue").at(-1)!.data;
      assert.equal(told.position, 2);
      assert.equal(told.ahead, 2);
      assert.deepEqual((await listAs(base, alice)).map((run) => [run.id, run.queued]), [[c, true], [a, false]]);
      await stat(join(server.artifacts, `visual-item-${c}`, "input.zip"));
      await stat(join(server.artifacts, `visual-item-${a}`, "input.zip"));

      const cancelled = await fetch(`${base}/api/runs/${b}`, { method: "DELETE", headers: bob });
      assert.equal(cancelled.status, 202);
      const bEvents = await readEvents(`${base}/api/runs/${b}/events`, bob);
      assert.equal(bEvents.at(-1)?.type, "error");
      assert.match(String(bEvents.at(-1)?.data.message), /cancelled/);
      assert.ok(server.lines.some((line) => line.level === "WARN" && line.message === "run stopped" && line.extra.run === b), "a cancel is logged as a stop, not a failure");
      assert.ok(!server.lines.some((line) => line.level === "ERROR" && line.extra.run === b));
      const moved = await until(() => queueAs(base, alice), (q) => q.waiting.length === 1);
      assert.deepEqual(moved.waiting.map((entry) => [entry.position, entry.id]), [[1, c]]);
      const cAgain = (await (await fetch(`${base}/api/runs/${c}`, { headers: alice })).json()) as { events: Frame[] };
      assert.equal(cAgain.events.filter((event) => event.type === "queue").at(-1)!.data.position, 1);

      held.release();
      const aEvents = await readEvents(`${base}/api/runs/${a}/events`);
      assert.equal(aEvents.at(-1)?.type, "done");
      const cDone = await readEvents(`${base}/api/runs/${c}/events`);
      assert.equal(cDone.at(-1)?.type, "done");
      assert.deepEqual(cDone.filter((event) => event.type === "queue").map((event) => event.data.position), [2, 1, 0]);
      assert.equal(cDone.at(-1)?.data.zipUrl, `/api/runs/${c}/input.zip`);
      const after = await queueAs(base, alice);
      assert.deepEqual([after.running.length, after.waiting.length], [0, 0]);
      assert.ok(typeof after.averageRunMs === "number" && after.averageRunMs >= 0);
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });

  it("keeps a run with code errors out of the line and runs two at once when allowed", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer, env: { MAX_CONCURRENT_RUNS: "2" } });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      const b = await startRun(base, zip, "?model=0", alice);
      const broken = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "?model=0", alice);
      const brokenEvents = await readEvents(`${base}/api/runs/${broken}/events`);
      assert.equal(brokenEvents.at(-1)?.type, "done");
      assert.equal(brokenEvents.at(-1)?.data.skipped, true);
      assert.ok(!brokenEvents.some((event) => event.type === "queue"), "never joined the line");
      const view = await until(() => queueAs(base, alice), (q) => q.running.length === 2);
      assert.deepEqual(view.running.map((entry) => entry.id).sort(), [a, b].sort());
      assert.equal(view.maxConcurrentRuns, 2);
      held.release();
      for (const id of [a, b]) assert.equal((await readEvents(`${base}/api/runs/${id}/events`)).at(-1)?.type, "done");
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });

  it("refuses a fourth run in flight for one owner with 429, standalone or not", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await startRun(base, zip, "?model=0", alice));
      const fourth = await fetch(`${base}/api/runs?model=0&standalone=1`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice } });
      assert.equal(fourth.status, 429);
      assert.match(((await fourth.json()) as { message: string }).message, /already have 3 runs in progress/);
      assert.equal((await startRun(base, zip, "?model=0", bob)).length, 32, "another owner is not held back");
      assert.equal((await listAs(base, alice)).length, 3, "the refused upload left nothing behind");
      held.release();
      for (const id of ids) assert.equal((await readEvents(`${base}/api/runs/${id}/events`)).at(-1)?.type, "done");
      assert.equal((await startRun(base, zip, "?model=0", alice)).length, 32, "a finished run frees the slot");
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });

  it("answers 503 with a retry-after when the whole line is taken", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer, env: { MAX_WAITING_RUNS: "1" } });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      const b = await startRun(base, zip, "?model=0", bob);
      await until(() => queueAs(base, alice), (q) => q.running.length === 1 && q.waiting.length === 1);
      const full = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...carol } });
      assert.equal(full.status, 503);
      assert.equal(full.headers.get("retry-after"), "120");
      assert.match(((await full.json()) as { message: string }).message, /Try again in a few minutes/);
      assert.deepEqual(await listAs(base, carol), []);
      held.release();
      for (const [id, headers] of [[a, alice], [b, bob]] as const) assert.equal((await readEvents(`${base}/api/runs/${id}/events`, headers)).at(-1)?.type, "done");
      assert.equal((await startRun(base, zip, "?model=0", carol)).length, 32, "room again once the line moved");
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });

  it("counts the runs that reached the renderer against a daily cap and says when the next slot opens", async () => {
    const server = await startTestServer({ env: { MAX_RUNS_PER_OWNER_PER_DAY: "1" } });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const gated = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "", alice);
      await readEvents(`${base}/api/runs/${gated}/events`);
      const first = await startRun(base, zip, "?model=0", alice);
      await readEvents(`${base}/api/runs/${first}/events`);
      const second = await fetch(`${base}/api/runs?standalone=1`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice } });
      assert.equal(second.status, 429, "the gated run cost nothing; the rendered one used the day's slot");
      const message = ((await second.json()) as { message: string }).message;
      assert.match(message, /used today's 1 visual review/);
      const opensAt = /opens at (\S+)\./.exec(message)![1];
      const retryAfter = Number(second.headers.get("retry-after"));
      assert.ok(Date.parse(opensAt) - Date.now() > 23 * 60 * 60 * 1000);
      assert.ok(retryAfter > 23 * 60 * 60 && retryAfter <= 24 * 60 * 60);
      assert.equal((await startRun(base, zip, "?model=0", bob)).length, 32, "the cap is per owner");
    } finally {
      await stopAndClean(server);
    }
  });

  it("refuses the extra upload among concurrent ones from the same owner before reading its body", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => fetch(`${base}/api/runs?model=0&standalone=1`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice } }))
      );
      assert.deepEqual(responses.map((res) => res.status).sort(), [201, 201, 201, 429, 429]);
      assert.equal(server.lines.filter((line) => line.message === "run accepted").length, 3, "the refused uploads were never accepted nor gated");
      assert.equal((await listAs(base, alice)).length, 3);
      held.release();
      for (const res of responses) {
        if (res.status !== 201) continue;
        const { id } = (await res.json()) as { id: string };
        assert.equal((await readEvents(`${base}/api/runs/${id}/events`)).at(-1)?.type, "done");
      }
      assert.equal((await startRun(base, zip, "?model=0", alice)).length, 32, "the slots are free again");
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });

  it("tells a rendering run's tab that the server is restarting before closing it, at warn level", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer });
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const rendering = await startRun(base, zip, "?model=0", alice);
      const waiting = await startRun(base, zip, "?model=0", bob);
      await until(() => queueAs(base, alice), (q) => q.running.length === 1 && q.waiting.length === 1);
      const tabs = await Promise.all([fetch(`${base}/api/runs/${rendering}/events`, { headers: alice }), fetch(`${base}/api/runs/${waiting}/events`, { headers: bob })]);
      await server.stop();
      for (const tab of tabs) {
        const last = parseFrames(await tab.text()).at(-1);
        assert.equal(last?.type, "error");
        assert.match(String(last?.data.message), /server is restarting/);
      }
      for (const id of [rendering, waiting]) {
        assert.ok(server.lines.some((line) => line.level === "WARN" && line.message === "run stopped" && line.extra.run === id));
        assert.ok(!server.lines.some((line) => line.level === "ERROR" && line.extra.run === id), "a restart is not a failure");
      }
    } finally {
      held.release();
      await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("lets five tabs follow one run and turns the sixth away with 429", async () => {
    const held = heldRenderer({ services: 0, rendered: [] });
    const server = await startTestServer({ renderer: held.renderer });
    const { base } = server;
    try {
      const id = await startRun(base, await syntheticZip(), "?model=0", alice);
      await until(() => queueAs(base, alice), (q) => q.running.length === 1);
      const tabs: Response[] = [];
      for (let i = 0; i < 5; i++) {
        const tab = await fetch(`${base}/api/runs/${id}/events`, { headers: alice });
        assert.equal(tab.status, 200);
        tabs.push(tab);
      }
      const sixth = await fetch(`${base}/api/runs/${id}/events`, { headers: alice });
      assert.equal(sixth.status, 429);
      assert.match(((await sixth.json()) as { message: string }).message, /Too many tabs/);
      assert.ok(server.lines.some((line) => line.message === "request" && line.extra.route === "/api/runs/:id/events" && line.extra.status === 429), "the refusal is logged as the 429 it was");
      held.release();
      for (const tab of tabs) assert.equal(parseFrames(await tab.text()).at(-1)?.type, "done", "every attached tab saw the run end");
      assert.equal(parseFrames(await (await fetch(`${base}/api/runs/${id}/events`, { headers: alice })).text()).at(-1)?.type, "done", "a finished run has no cap");
    } finally {
      held.release();
      await stopAndClean(server);
    }
  });
});

describe("a run folder that cannot be created", () => {
  it("answers 500 without the path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "run-server-broken-"));
    const file = join(parent, "not-a-directory");
    await writeFile(file, "");
    const server = await startTestServer({ env: { ARTIFACTS_DIR: join(file, "runs") } });
    const { base } = server;
    try {
      const zip = body(await syntheticZip());
      const first = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...alice } });
      assert.equal(first.status, 500);
      const answer = (await first.json()) as { message: string; reference: string };
      assert.equal(answer.message, "Request failed.");
      assert.match(answer.reference, /^[0-9a-f]{8}$/);
      const logged = server.lines.find((line) => line.message === "request failed" && line.extra.reference === answer.reference);
      assert.ok(logged, "the reason waits in the log under the reference");
      assert.equal(logged.extra.route, "/api/runs");
      assert.match(String(logged.extra.error), /ENOTDIR|ENOENT/);
      const second = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...bob } });
      assert.equal(second.status, 500, "the failed upload left nothing behind");
    } finally {
      await server.stop();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("public hosts", () => {
  it("PUBLIC_HOSTS extends the Host allow list on a non-loopback bind; without it the check is skipped", async () => {
    const gated = await startTestServer({ env: { HTTP_SERVER_HOST: "0.0.0.0", PUBLIC_HOSTS: "review.example" } });
    const open = await startTestServer({ env: { HTTP_SERVER_HOST: "0.0.0.0" } });
    try {
      assert.match(await rawRequest(gated.base, "/api/runs", "review.example", alice), /^HTTP\/1\.1 200/);
      assert.match(await rawRequest(gated.base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 403/);
      assert.match(await rawRequest(open.base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 200/);
      assert.ok(open.lines.some((line) => line.level === "WARN" && line.message.startsWith("Host header check skipped")));
    } finally {
      await stopAndClean(gated);
      await stopAndClean(open);
    }
  });
});

describe("runs outlive memory and restarts", () => {
  let out: string;

  before(async () => {
    out = await mkdtemp(join(tmpdir(), "run-server-disk-"));
  });
  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("serves an evicted finished run from its folder as one done event, and lists it again after a restart", async () => {
    const first = await startTestServer({ env: { ARTIFACTS_DIR: out } });
    const zip = await syntheticZip();
    const evicted = await startRun(first.base, zip, "?standalone=1", { ...alice, "x-file-name": "first.zip" });
    const live = await readEvents(`${first.base}/api/runs/${evicted}/events`);
    const capture = live.find((e) => e.type === "capture")!.data.url as string;
    const bobs = await startRun(first.base, zip, "?standalone=1", { ...bob, "x-file-name": "bobs.zip" });
    await readEvents(`${first.base}/api/runs/${bobs}/events`, bob);
    const filler = await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) });
    const gated = await startRun(first.base, filler, "?standalone=1", { ...bob, "x-file-name": "gated.zip" });
    await readEvents(`${first.base}/api/runs/${gated}/events`, bob);
    // the server keeps 50 runs in memory: fifty quick gated runs push the first ones out, leaving only their folders
    for (let i = 0; i < 50; i++) await readEvents(`${first.base}/api/runs/${await startRun(first.base, filler, "", carol)}/events`, carol);
    const reloaded = (await (await fetch(`${first.base}/api/runs/${evicted}`, { headers: alice })).json()) as { id: string; name: string; done: boolean; events: Frame[] };
    assert.equal(reloaded.done, true);
    assert.equal(reloaded.name, "first.zip");
    assert.equal(reloaded.events.length, 1);
    assert.equal(reloaded.events[0].type, "done");
    const result = reloaded.events[0].data.result as { checks: { check: string; status: string }[]; captures: { url: string; file?: string }[] };
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
    assert.equal(result.captures.length, 20);
    assert.ok(result.captures.every((entry) => entry.url.startsWith(`/api/runs/${evicted}/captures/`) && entry.file === undefined));
    assert.equal((reloaded.events[0].data.gate as { passed: boolean }).passed, true, "gate.json comes back with the run");
    const replay = await readEvents(`${first.base}/api/runs/${evicted}/events`);
    assert.deepEqual(replay.map((e) => e.type), ["done"]);
    assert.equal((await fetch(`${first.base}${capture}`, { headers: alice })).status, 200);
    assert.equal((await fetch(`${first.base}/api/runs/${evicted}`, { headers: bob })).status, 404);
    await first.stop();

    const second = await startTestServer({ env: { ARTIFACTS_DIR: out } });
    try {
      const runs = await listAs(second.base, alice);
      assert.deepEqual(runs.map((row) => [row.id, row.name, row.done, row.passed]), [[evicted, "first.zip", true, true]]);
      assert.deepEqual((await listAs(second.base, bob)).map((row) => [row.id, row.passed]), [[gated, false], [bobs, true]], "the index rebuilt from input.json keeps the gate verdict");
      const carols = await listAs(second.base, carol);
      assert.equal(carols.length, 50);
      assert.ok(carols.every((row) => row.passed === false), "a gate-stopped run keeps its verdict from gate.json across the restart");
      const restored = (await (await fetch(`${second.base}/api/runs/${evicted}`, { headers: alice })).json()) as { done: boolean; events: Frame[] };
      assert.equal(restored.done, true);
      assert.equal(restored.events[0].type, "done");
      assert.equal((await fetch(`${second.base}${capture}`, { headers: alice })).status, 200);
      assert.equal((await fetch(`${second.base}/api/runs/${evicted}`, { headers: bob })).status, 404);
    } finally {
      await second.stop();
    }
  });
});

describe("operators", () => {
  it("see every run, the stats and the log; curators get 403 for those and 404 for each other's runs", async () => {
    const server = await startTestServer();
    const { base } = server;
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      await readEvents(`${base}/api/runs/${a}/events`);
      const b = await startRun(base, zip, "?model=0", bob);
      await readEvents(`${base}/api/runs/${b}/events`, bob);

      for (const path of ["/api/stats", "/api/logs", "/api/runs?all=1"]) {
        const res = await fetch(`${base}${path}`, { headers: alice });
        assert.equal(res.status, 403, path);
        assert.match(((await res.json()) as { message: string }).message, /Only operators/);
      }
      assert.equal((await fetch(`${base}/api/runs/${b}`, { headers: alice })).status, 404);

      const every = (await (await fetch(`${base}/api/runs?all=1`, { headers: bot })).json()) as { runs: { id: string; owner: string }[] };
      assert.deepEqual(every.runs.map((run) => [run.id, run.owner]), [[b, "bob"], [a, "alice"]]);
      assert.equal((await listAs(base, bot)).length, 0, "without all=1 an operator lists only its own runs");
      const person = { ...carol, "x-test-operator": "1" };
      const asPerson = (await (await fetch(`${base}/api/runs?all=1`, { headers: person })).json()) as { runs: { id: string; owner?: string }[] };
      assert.deepEqual(asPerson.runs.map((run) => run.owner), ["bob", "alice"], "a signed-in operator (the one /api/health reports) sees who sent each run");
      assert.ok((await listAs(base, alice)).every((run) => !("owner" in run)), "a curator's own list names no owner");
      assert.equal((await fetch(`${base}/api/runs/${b}`, { headers: bot })).status, 200);
      assert.equal((await fetch(`${base}/api/runs/${a}/events`, { headers: bot })).status, 200);

      const stats = (await (await fetch(`${base}/api/stats`, { headers: bot })).json()) as { runs: { total: number; passed: number; running: number; waiting: number }; byOwner: { owner: string; runs: number }[]; byDay: { runs: number }[]; averageRunMs: number | null; maxConcurrentRuns: number; rulesVersion: string };
      assert.equal(stats.runs.total, 2);
      assert.deepEqual([stats.runs.running, stats.runs.waiting], [0, 0]);
      assert.deepEqual(stats.byOwner.map((row) => row.runs), [1, 1]);
      assert.equal(stats.byDay.reduce((sum, row) => sum + row.runs, 0), 2);
      assert.equal(stats.maxConcurrentRuns, 1);
      assert.equal(typeof stats.averageRunMs, "number");
      assert.equal(stats.rulesVersion, manifest.version);

      const logs = (await (await fetch(`${base}/api/logs?limit=500`, { headers: bot })).json()) as { lines: { time: string; level: string; message: string; fields: Record<string, unknown> }[] };
      assert.ok(logs.lines.some((line) => line.message === "run accepted" && line.fields.owner === "alice"));
      assert.ok(logs.lines.some((line) => line.message === "request" && line.fields.route === "/api/runs" && line.fields.status === 201 && line.fields.owner === "alice"), "every API call is one access-log line with its caller");
      assert.ok(logs.lines.some((line) => line.message === "request" && line.fields.route === "/api/runs/:id/events" && line.fields.kind === "service"), "the route is the pattern, never the URL as sent");
      assert.ok(!logs.lines.some((line) => line.fields.route === `/api/runs/${a}/events`));
      assert.ok(!logs.lines.some((line) => line.message === "request" && line.fields.route === "/api/health"));
      assert.ok(!logs.lines.some((line) => line.fields.status === 403), "a curator's 403 is not the operator's business");
      assert.ok(server.lines.some((line) => line.level === "DEBUG" && line.message === "request" && line.extra.route === "/api/stats" && line.extra.status === 403 && line.extra.owner === "alice"), "it still reaches the host's collector");
      const since = logs.lines.at(-1)!;
      const later = (await (await fetch(`${base}/api/logs?since=${encodeURIComponent(since.time)}`, { headers: bot })).json()) as { lines: unknown[] };
      assert.ok(later.lines.length < logs.lines.length);
    } finally {
      await stopAndClean(server);
    }
  });
});

describe("a sign-in that cannot be verified", () => {
  it("answers 503 and asks to retry, never 401 or 500, while the certs are unreachable", async () => {
    const verifier = createAccessVerifier({ teamDomain: "example-team", audience: "aud-1", fetchKeys: async () => { throw new Error("Cloudflare Access certs answered 503."); } });
    const server = await startTestServer({ identity: { identify: accessIdentity(verifier), kind: "cloudflare-access (example-team)" } });
    const { base } = server;
    try {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = `${encode({ alg: "RS256", kid: "kid-1", typ: "JWT" })}.${encode({ email: "curator@example.com" })}.sig`;
      const res = await fetch(`${base}/api/runs`, { headers: { "cf-access-jwt-assertion": token } });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "5");
      assert.deepEqual(await res.json(), { message: "Sign-in could not be verified right now." });
      assert.equal((await fetch(`${base}/api/runs`)).status, 401, "no token at all is still a plain sign-in");
      const health = (await (await fetch(`${base}/api/health`, { headers: { "cf-access-jwt-assertion": token } })).json()) as { ok: boolean; owner: string | null };
      assert.deepEqual([health.ok, health.owner], [true, null], "the probe stays green");
      assert.ok(server.lines.some((line) => line.level === "WARN" && line.message === "sign-in could not be verified" && String(line.extra.error).includes("503")));
    } finally {
      await stopAndClean(server);
    }
  });
});

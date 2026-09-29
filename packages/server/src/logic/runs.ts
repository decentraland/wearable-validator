/** The life of a run: accept → code gate → the line → execute, every step an event the browser follows and the operator reads in the log. */
import { createHash, randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import { START_COMPONENT, STOP_COMPONENT, type IBaseComponent, type IConfigComponent, type ILoggerComponent, type IMetricsComponent } from "@well-known-components/interfaces";
import { loadInput, plannedCaptures, registry, validate, type CheckContext, type Input, type Renderer, type Result } from "@dcl-regenesislabs/wearable-validator";
import type { ICatalystComponent } from "../adapters/catalyst.js";
import { appLogger, type AppLogger } from "../adapters/log-buffer.js";
import type { IRendererComponent } from "../adapters/renderer.js";
import type { IReviewerComponent } from "../adapters/reviewer.js";
import type { ISlackComponent } from "../adapters/slack.js";
import type { metricDeclarations } from "../metrics.js";
import type { Identity, QueueState, RunEvent, RunEventType, RunItem, RunNotice, RunOutcome, RunSink, RunSummary } from "../types.js";
import { runCodeChecks } from "./code-checks.js";
import { curatorDecision } from "./decision.js";
import { QueueFullError, TooManyListenersError, TooManyRunsError } from "./errors.js";
import type { IQueueComponent } from "./queue.js";
import { readRunInput, verdict, type IRunStoreComponent, type StoredRun } from "./run-store.js";
import { computeStats, type Stats } from "./stats.js";

export const VISUAL_CHECKS = registry.filter((check) => check.group === "rendering").map((check) => check.name);

// finished runs kept in memory for event replay; the run folder stays the durable record
const MAX_RUNS_IN_MEMORY = 50;
// the upload's name becomes part of the run folder name; filesystems cap a folder name at 255 bytes
const MAX_NAME_CHARS = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
// the whole code gate of one item runs in a worker; a real item needs seconds
const CODE_CHECKS_TIMEOUT_MS = 60_000;
// a listener whose socket stops draining for this long is dropped rather than buffered for
const DRAIN_TIMEOUT_MS = 5000;
// model text reaches the operator's terminal before any parser sees it: never let it carry escape sequences
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export const clean = (value: unknown, max: number): string => String(value ?? "").replace(CONTROL, " ").slice(0, max);

/** x-file-name made safe for a folder name; undefined when it does not decode. */
export function safeFileName(header: string | null | undefined): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(header ?? "item.zip");
  } catch {
    return undefined;
  }
  const safe = basename(decoded).replace(/[^\w.-]/g, "_");
  const ext = extname(safe);
  return safe.length > MAX_NAME_CHARS ? safe.slice(0, MAX_NAME_CHARS - ext.length) + ext : safe;
}

/** The folder name a run started from a URN gets until the item is fetched: the URN's last two segments (contract and item id). */
export function referenceName(urn: string): string {
  const segments = urn.split(":").filter(Boolean);
  return segments.slice(-2).join("-").replace(/[^\w.-]/g, "_").slice(0, MAX_NAME_CHARS) || "item";
}

export interface AcceptInput {
  identity: Identity;
  /** Already through safeFileName() or referenceName(). */
  name: string;
  /** The upload; absent when the run starts from a reference. */
  bytes?: Uint8Array;
  /** The URN candidates a shop URL or URN resolved to (parseItemReference); the run fetches the item itself. */
  reference?: string[];
  /** false: render only (?model=0). */
  model: boolean;
  /** true: render and review even when the code gate fails (?standalone=1). */
  standalone: boolean;
  /** The slot reserved before the upload was read; accept() takes it over and frees it. */
  reservation?: Reservation;
}

/** A slot in the owner's quota, held while an upload is read; release() is safe to call more than once. */
export interface Reservation {
  release(): void;
}

export interface Accepted {
  id: string;
  events: string;
  queue: string;
}

export interface RunView {
  id: string;
  owner: string;
  name: string;
  dir: string;
  done: boolean;
  passed: boolean | null;
  events: RunEvent[];
}

/** What an SSE response looks like from here: a PassThrough stream satisfies it. */
export interface RunListener {
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
  destroy(): void;
}

export interface IRunsComponent extends IBaseComponent {
  readonly visualChecks: string[];
  /** Throws TooManyRunsError (429) / QueueFullError (503); the slot counts against the owner until released. */
  reserve(identity: Identity): Promise<Reservation>;
  accept(input: AcceptInput): Promise<Accepted>;
  list(identity: Identity, everyone: boolean): Promise<RunSummary[]>;
  /** Someone else's run is indistinguishable from no run at all; operators see every run. */
  find(id: string, identity: Identity): Promise<RunView | undefined>;
  /** Replays after `after`, then attaches; throws TooManyListenersError; returns the detach, or undefined when the run is unknown to this caller. */
  follow(id: string, identity: Identity, after: number, listener: RunListener): Promise<(() => void) | undefined>;
  cancel(id: string, identity: Identity): Promise<boolean>;
  queueState(owner: string): QueueState;
  stats(): Stats;
}

interface Run extends StoredRun {
  events: RunEvent[];
  /** The timer is set while a listener is waiting to drain. */
  listeners: Map<RunListener, NodeJS.Timeout | undefined>;
  controller: AbortController;
  /** When the render actually started; startedAt is when the upload was accepted. */
  beganAt?: number;
  /** Kept for the notice conclude() sends: the code gate's Result, the visual Result, the item's metadata, the failure. */
  gate?: Result;
  visual?: Result;
  item?: RunItem;
  error?: string;
  outcome?: RunOutcome;
  /** Set once the upload is known to be in the folder; rides on the done event so the site can offer the zip. */
  zipUrl?: string;
  /** A reference run: the first candidate URN until the catalyst answers, then the one the item was found under. */
  reference?: string;
  /** The fetched entity's id: the key its views are remembered under, as the sha256 is for an upload. */
  entityId?: string;
}

interface Mode {
  model: boolean;
  standalone: boolean;
}

interface RunsComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  metrics: IMetricsComponent<keyof typeof metricDeclarations>;
  runStore: IRunStoreComponent;
  queue: IQueueComponent;
  renderer: IRendererComponent;
  reviewer: IReviewerComponent;
  catalyst: ICatalystComponent;
  /** Told once per concluded run; a disabled notifier resolves at once. */
  notifier: ISlackComponent;
}

const uploadUrl = (runId: string): string => `/api/runs/${runId}/input.zip`;

const captureUrl = (runId: string, captureId: string): string => `/api/runs/${runId}/captures/${captureId}.png`;

function serializeResult(run: Run, result: Result): unknown {
  return { ...result, captures: result.captures.map(({ bytes, ...capture }) => ({ ...capture, url: captureUrl(run.id, capture.request.id) })) };
}

const frameOf = (event: RunEvent): string => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

const summarize = ({ id, owner, name, dir, startedAt, done, passed, rendered }: StoredRun): StoredRun => ({ id, owner, name, dir, startedAt, done, passed, rendered });

/** The rendering stage names what the site should expect: how many capture events, on which body shapes. */
async function renderingStage(ctx: CheckContext | undefined): Promise<{ text: string; views: number; bodyShapes: string[] }> {
  const views = ctx ? await plannedCaptures(ctx) : 0;
  const bodyShapes = [...new Set(ctx?.item.representations?.flatMap((rep) => rep.bodyShapes) ?? [])].map((urn) => urn.split(":").pop() ?? urn);
  const where = bodyShapes.length ? ` on ${bodyShapes.join(" and ")}` : "";
  return { text: `Rendering ${views} view${views === 1 ? "" : "s"}${where}`, views, bodyShapes };
}

function logEvent(log: AppLogger, run: Run, type: RunEventType, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;
  const ms = Date.now() - run.startedAt;
  switch (type) {
    case "check": {
      const event = d as { type: string; check?: string; result?: { check: string; status: string; measured?: string; skipReason?: string } };
      if (event.type === "check-finished" && event.result && event.result.status !== "passed") {
        // the reason is what an operator needs when a render errors: the row on the site shows the same text
        log.info("check finished", { run: run.id, check: event.result.check, status: event.result.status, measured: clean(event.result.measured, 120) || undefined, reason: clean(event.result.skipReason, 300) || undefined, ms });
      }
      return;
    }
    case "gate": {
      const result = d.result as { passed: boolean | null; summary: { errors: number; warnings: number; checked: number } };
      log.info("code gate", { run: run.id, passed: result.passed, errors: result.summary.errors, warnings: result.summary.warnings, checks: result.summary.checked, ms });
      return;
    }
    case "stage":
      log.info(clean(d.text, 200), { run: run.id, ms, ...(typeof d.done === "number" ? { done: d.done, total: d.total } : {}) });
      return;
    case "queue":
      log.info(d.position === 0 ? "run started" : "waiting in line", { run: run.id, position: d.position, ahead: d.ahead, etaMs: d.etaMs, ms });
      return;
    case "capture":
      log.info("captured", { run: run.id, view: d.id, ms });
      return;
    case "review": {
      if (d.phase === "request") {
        const images = d.images as unknown[];
        log.info("asking the model", { run: run.id, check: d.check, prompt: `v${d.promptVersion}`, digest: String(d.promptDigest).slice(0, 8), images: images.length, ms });
        return;
      }
      const metadata = d.metadata as { model?: string; stopReason?: string; usage?: { input: number; output: number; cacheRead: number; cost: number } };
      const answer = d.answer as { verdict?: string; summary?: string; findings?: unknown[] } | undefined;
      if (d.ok) {
        log.info("model answered", {
          run: run.id, check: d.check, model: metadata.model, verdict: answer?.verdict, findings: answer?.findings?.length ?? 0,
          input: metadata.usage?.input, output: metadata.usage?.output, cacheRead: metadata.usage?.cacheRead,
          cost: metadata.usage ? `$${metadata.usage.cost.toFixed(4)}` : undefined, ms, summary: clean(answer?.summary, 160)
        });
      } else {
        log.warn("model did not answer", { run: run.id, check: d.check, model: metadata.model, stop: metadata.stopReason, reason: clean(d.reason, 200), ms });
      }
      return;
    }
    case "done": {
      const result = d.result as { checks: { check: string; status: string }[] } | undefined;
      if (result) log.info("run finished", { run: run.id, rows: result.checks.map((row) => `${row.check}:${row.status}`).join(","), ms });
      else log.info("run stopped at the gate", { run: run.id, reason: d.message, ms });
      return;
    }
    case "error":
      // a cancel or a restart is not a failure: warn, so the logger prints no stack for it
      if (run.controller.signal.aborted) log.warn("run stopped", { run: run.id, reason: clean(d.message, 300), ms });
      else log.error("run failed", { run: run.id, error: clean(d.message, 300), ms });
      return;
  }
}

export async function createRunsComponent(components: RunsComponents): Promise<IRunsComponent> {
  const { config, logs, metrics, runStore, queue, renderer, reviewer, catalyst, notifier } = components;
  const log = appLogger(logs, "runs");
  const maxListeners = (await config.getNumber("MAX_SSE_LISTENERS_PER_RUN")) ?? 5;
  const maxPerDay = (await config.getNumber("MAX_RUNS_PER_OWNER_PER_DAY")) ?? 40;
  const maxActive = (await config.getNumber("MAX_ACTIVE_RUNS_PER_OWNER")) ?? 3;
  // live runs by id; the store's index has every run this server has ever seen, the rest come back from disk on demand
  const runs = new Map<string, Run>();
  // uploads being read per owner: they hold a slot before the run exists, so concurrent uploads cannot slip past the cap
  const reserved = new Map<string, number>();
  const serverStartedAt = Date.now();

  const remember = (run: Run): void => runStore.set(summarize(run));

  function drop(run: Run, listener: RunListener, why: string): void {
    const timer = run.listeners.get(listener);
    if (timer) clearTimeout(timer);
    run.listeners.delete(listener);
    listener.destroy();
    log.warn("dropped a listener", { run: run.id, why });
  }

  function send(run: Run, listener: RunListener, frame: string): void {
    if (listener.write(frame) || run.listeners.get(listener)) return;
    const timer = setTimeout(() => drop(run, listener, "did not drain within 5 s"), DRAIN_TIMEOUT_MS);
    timer.unref();
    run.listeners.set(listener, timer);
    listener.once("drain", () => {
      clearTimeout(timer);
      if (run.listeners.has(listener)) run.listeners.set(listener, undefined);
    });
  }

  function emit(run: Run, type: RunEventType, data: unknown): void {
    // a concluded run never grows its log: a late download or check must not land after the error frame
    if (run.done) return;
    const event: RunEvent = { id: run.events.length + 1, type, data };
    run.events.push(event);
    logEvent(log, run, type, data);
    const frame = frameOf(event);
    for (const listener of [...run.listeners.keys()]) send(run, listener, frame);
    void runStore.appendEvent(run.dir, event).catch(() => {});
  }

  function finish(run: Run, data: { result?: Result; skipped?: boolean; message?: string }, wire: Record<string, unknown> = data): void {
    // a standalone run renders past a failed gate: its visual-only Result never carries the code verdict
    run.passed = data.result ? (run.gate?.passed === false ? false : verdict(data.result)) : null;
    run.outcome = data.result && !data.skipped ? (run.passed === null ? "no-verdict" : run.passed ? "passed" : "failed") : "gate";
    metrics.increment("runs_finished_total", { status: run.outcome });
    // the same keys a run reloaded from its folder replays with: the site previews the item from them
    emit(run, "done", { ...wire, ...(run.zipUrl ? { zipUrl: run.zipUrl } : {}), ...(run.reference ? { reference: run.reference } : {}) });
  }

  function noticeOf(run: Run): RunNotice {
    const { id, owner, name, dir, startedAt, beganAt, passed, gate, visual, item, error, zipUrl, reference } = run;
    const outcome = run.outcome ?? "error";
    const decision = curatorDecision({ gate, visual, passed, error: outcome === "error" ? error ?? "The run failed." : undefined });
    return { id, owner, name, dir, startedAt, beganAt, finishedAt: Date.now(), outcome, passed, decision, gate, visual, item, error, zipUrl, reference };
  }

  /** The single exit of every run: closes the tabs, then tells the channel — never awaited, never in the run's way. */
  function conclude(run: Run): void {
    if (run.done) return;
    run.done = true;
    remember(run);
    for (const [listener, timer] of run.listeners) {
      if (timer) clearTimeout(timer);
      listener.end();
    }
    run.listeners.clear();
    // the upload stays in the folder: the site offers it as Download zip to the owner and to operators
    const notice = run.outcome === "error" && run.controller.signal.aborted ? undefined : noticeOf(run);
    // the results carry every capture's bytes: only the in-flight notice keeps them, not the fifty runs remembered here
    run.visual = undefined;
    run.gate = undefined;
    // a cancelled run tells nobody; one that reached a verdict before the cancel landed is announced like any other
    if (notice) void notifier.notify(notice).catch((error: unknown) => log.warn("slack notification failed", { run: run.id, reason: error instanceof Error ? error.message : String(error) }));
  }

  function fail(run: Run, error: unknown, message?: string): void {
    if (run.done) return;
    const cancelled = run.controller.signal.aborted;
    run.outcome = "error";
    run.error = message ?? (cancelled ? "The run was cancelled." : error instanceof Error ? error.message : "The run failed.");
    metrics.increment("runs_finished_total", { status: cancelled ? "cancelled" : "error" });
    emit(run, "error", run.zipUrl ? { message: run.error, zipUrl: run.zipUrl } : { message: run.error });
  }

  /** Ends a run from outside its own flow (cancel, restart): the frame reaches the tabs before they are closed. */
  function stop(run: Run, message?: string): void {
    run.controller.abort();
    queue.leave(run.id);
    fail(run, undefined, message);
    conclude(run);
  }

  queue.onMove((item, position) => {
    const run = runs.get(item.id);
    if (run && !run.done) emit(run, "queue", position);
  });

  /** The published item behind a reference, fetched inside the run so the stream shows the download; the folder keeps it like an upload. */
  async function fetchItem(run: Run, candidates: string[]): Promise<Input> {
    emit(run, "stage", { text: "Fetching the item from the catalyst", kind: "fetch" });
    let reported: number | undefined;
    const item = await catalyst.fetchItem(candidates, ({ text, done, total }) => {
      // the library reports the lookup and every file; the stream carries one stage per file count
      if (done === undefined || done === reported) return;
      reported = done;
      emit(run, "stage", { text, kind: "fetch", done, total });
    }, run.controller.signal);
    await runStore.writeEntity(run.dir, item);
    run.reference = item.urn;
    run.entityId = item.id;
    run.name = clean(item.name, MAX_NAME_CHARS).trim() || run.name;
    await runStore.writeInput(run.dir, { id: run.id, owner: run.owner, name: run.name, startedAt: run.startedAt, reference: item.urn });
    remember(run);
    return { files: item.files, metadata: item.metadata, content: item.content };
  }

  /** The code gate runs at once (it costs nothing); only a run that needs the renderer joins the line. */
  async function admit(run: Run, source: Uint8Array | string[], mode: Mode): Promise<void> {
    try {
      let input: Input;
      if (source instanceof Uint8Array) {
        if (await runStore.hasUpload(run.dir)) run.zipUrl = uploadUrl(run.id);
        input = source;
      } else {
        input = await fetchItem(run, source);
      }
      const code = await runCodeChecks(input, { signal: run.controller.signal, onProgress: (event) => emit(run, "check", event), timeoutMs: CODE_CHECKS_TIMEOUT_MS });
      run.gate = code;
      // on disk before the event: History reads gate.json for every run, live or long finished
      await runStore.writeGate(run.dir, code);
      emit(run, "gate", { result: code, passed: code.passed });
      if (run.done) return;
      if (code.passed !== true && !mode.standalone) {
        const message = "Visual review was not started: fix the code checks first, or press Render and review anyway.";
        finish(run, { skipped: true, result: code, message }, { skipped: true, result: code, gate: code, message });
        conclude(run);
        return;
      }
    } catch (error) {
      fail(run, error);
      conclude(run);
      return;
    }
    try {
      queue.enqueue({ id: run.id, owner: run.owner, name: run.name, since: run.startedAt }, () => execute(run, mode));
    } catch (error) {
      // the line filled while the gate ran: the caller was told 201, so the stream carries the refusal
      run.outcome = "error";
      run.error = error instanceof TooManyRunsError || error instanceof QueueFullError ? error.message : "The run could not join the line.";
      emit(run, "error", { message: run.error });
      conclude(run);
      return;
    }
    log.info("run queued", { run: run.id, position: queue.waiting().length, running: queue.running().length });
  }

  async function execute(run: Run, mode: Mode): Promise<"finished" | "cancelled"> {
    let browser: Renderer | undefined;
    const began = Date.now();
    try {
      run.beganAt = began;
      run.rendered = true;
      remember(run);
      // the item waited on disk, not in memory: a full line costs folders, not RAM; an upload stays there for Download zip
      const input = await runStore.readInput(run.dir);
      const loaded = await loadInput(input, {});
      if (loaded.ctx) run.item = { name: loaded.ctx.item.name, category: loaded.ctx.category ?? loaded.ctx.item.category, itemType: loaded.ctx.itemType, rarity: loaded.ctx.item.rarity };
      const thumbnail = loaded.ctx?.files.get(loaded.ctx.item.thumbnailPath ?? "thumbnail.png");
      // on disk now, not at the end with writeRun(): the site shows it beside the views while they are still rendering
      if (thumbnail) await runStore.writeThumbnail(run.dir, thumbnail);
      const inputKey = input instanceof Uint8Array ? createHash("sha256").update(input).digest("hex") : run.entityId;
      if (!inputKey) throw new Error("The run has no entity id to remember its views under.");
      const origin = input instanceof Uint8Array ? { sha256: inputKey } : { entityId: inputKey, reference: run.reference };
      await runStore.writeInput(run.dir, { id: run.id, owner: run.owner, name: run.name, startedAt: run.startedAt, ...origin, gatePassed: run.gate?.passed });
      // an earlier run of the same item: show its photos now; only stale or missing views get rendered again
      const earlier = runStore.previousRun(inputKey);
      const captures = earlier && earlier !== run.dir ? await runStore.readRun(earlier).catch(() => []) : [];
      runStore.rememberRun(inputKey, run.dir);
      const io = sink(run);
      if (captures.length) {
        emit(run, "stage", { text: `Reusing ${captures.length} views from an earlier run` });
        for (const capture of captures) await io.capture(capture);
      }
      emit(run, "stage", { text: "Starting the renderer" });
      browser = await renderer.forRun(io);
      const model = reviewer.forRun(io);
      emit(run, "stage", await renderingStage(loaded.ctx));
      const result = await validate(input, {
        checks: VISUAL_CHECKS,
        captures,
        services: { renderer: browser, reviewer: mode.model ? model : undefined },
        signal: run.controller.signal,
        onProgress: (event) => emit(run, "check", event)
      });
      await runStore.writeRun(run.dir, result, thumbnail);
      run.visual = result;
      finish(run, { result }, { result: serializeResult(run, result), name: run.name, ...(run.gate ? { gate: serializeResult(run, run.gate) } : {}) });
    } catch (error) {
      fail(run, error);
    } finally {
      conclude(run);
      await browser?.stop().catch(() => {});
    }
    if (run.controller.signal.aborted) return "cancelled";
    metrics.observe("render_duration_seconds", {}, (Date.now() - began) / 1000);
    return "finished";
  }

  function sink(run: Run): RunSink {
    return {
      id: run.id,
      dir: run.dir,
      emit: (type, data) => emit(run, type, data),
      capture: async (capture) => {
        const { id } = capture.request;
        await runStore.writeCapture(run.dir, id, capture.bytes);
        emit(run, "capture", { id, request: capture.request, sha256: capture.sha256, url: captureUrl(run.id, id) });
      }
    };
  }

  // an evicted or pre-restart run comes back from its folder as one `done` event: the same shape the live stream ended with
  async function loadFinishedRun(stored: StoredRun): Promise<RunView> {
    const result = await runStore.readResult(stored.dir);
    const data: Record<string, unknown> = result
      ? { result: { ...result, captures: result.captures.map(({ file, ...capture }) => ({ ...capture, url: captureUrl(stored.id, capture.request.id) })) }, name: stored.name }
      : { skipped: true, message: "This run finished without a saved result." };
    const gate = await runStore.readGate(stored.dir);
    if (gate) data.gate = gate;
    // a published item's run replays as one: the site still needs to know it was fetched, not uploaded
    const input = await readRunInput(stored.dir);
    if (input?.reference) data.reference = input.reference;
    if (await runStore.hasUpload(stored.dir)) data.zipUrl = uploadUrl(stored.id);
    return { id: stored.id, owner: stored.owner, name: stored.name, dir: stored.dir, done: true, passed: stored.passed, events: [{ id: 1, type: "done", data }] };
  }

  const mine = (identity: Identity, owner: string): boolean => identity.operator || owner === identity.owner;

  async function reserve(identity: Identity): Promise<Reservation> {
    await runStore.ready();
    const owner = identity.owner;
    // no await from here to the increment: two uploads arriving together see each other
    const active = [...runs.values()].filter((run) => run.owner === owner && !run.done).length + (reserved.get(owner) ?? 0);
    if (active >= maxActive) throw new TooManyRunsError(`You already have ${active} run${active === 1 ? "" : "s"} in progress. Wait for one to finish before starting another.`);
    if (!queue.hasRoom()) throw new QueueFullError();
    const since = Date.now() - DAY_MS;
    const today = runStore.all().filter((run) => run.owner === owner && run.rendered && run.startedAt > since);
    if (today.length >= maxPerDay) {
      const retryAt = Math.min(...today.map((run) => run.startedAt)) + DAY_MS;
      throw new TooManyRunsError(`You have used today's ${maxPerDay} visual reviews. The next one opens at ${new Date(retryAt).toISOString()}.`, retryAt);
    }
    reserved.set(owner, (reserved.get(owner) ?? 0) + 1);
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const left = (reserved.get(owner) ?? 1) - 1;
        if (left > 0) reserved.set(owner, left);
        else reserved.delete(owner);
      }
    };
  }

  async function find(id: string, identity: Identity): Promise<RunView | undefined> {
    await runStore.ready();
    const live = runs.get(id);
    if (live) return mine(identity, live.owner) ? live : undefined;
    const stored = runStore.get(id);
    return stored && mine(identity, stored.owner) ? loadFinishedRun(stored) : undefined;
  }

  return {
    visualChecks: VISUAL_CHECKS,

    reserve,

    async accept({ identity, name, bytes, reference, model, standalone, reservation }) {
      const held = reservation ?? (await reserve(identity));
      const owner = identity.owner;
      try {
        if (!bytes && !reference?.length) throw new Error("A run starts from the zip bytes or from a reference.");
        const id = randomBytes(16).toString("hex");
        const dir = await runStore.createRunDir(id, name);
        const run: Run = { id, owner, name, dir, startedAt: Date.now(), done: false, passed: null, rendered: false, events: [], listeners: new Map(), controller: new AbortController(), reference: reference?.[0] };
        await runStore.writeInput(dir, { id, owner, name, startedAt: run.startedAt, reference: run.reference });
        if (bytes) await runStore.writeUpload(dir, bytes);
        runs.set(id, run);
        remember(run);
        for (const [oldId, old] of runs) {
          if (runs.size <= MAX_RUNS_IN_MEMORY) break;
          if (old.done) runs.delete(oldId);
        }
        metrics.increment("runs_accepted_total");
        log.info("run accepted", { run: id, owner, file: name, bytes: bytes?.length, reference: run.reference, model, standalone, dir });
        void admit(run, bytes ?? reference ?? [], { model, standalone });
        return { id, events: `/api/runs/${id}/events`, queue: "/api/queue" };
      } finally {
        // the run is in the map (or nothing was accepted) before the slot is freed: no await sits between the two
        held.release();
      }
    },

    async list(identity, everyone) {
      await runStore.ready();
      const all = everyone && identity.operator;
      const waiting = new Set(queue.waiting().map((item) => item.id));
      return runStore
        .all()
        .filter((run) => all || run.owner === identity.owner)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(({ id, owner, name, startedAt, done, passed }) => ({ id, ...(all ? { owner } : {}), name, startedAt, done, passed, queued: waiting.has(id) }));
    },

    find,

    async follow(id, identity, after, listener) {
      const view = await find(id, identity);
      if (!view) return undefined;
      const run = runs.get(id);
      if (!run || run.done) {
        // a finished run is its events and nothing more: send what is asked for, then close
        for (const event of view.events) if (event.id > after) listener.write(frameOf(event));
        listener.end();
        return () => {};
      }
      if (run.listeners.size >= maxListeners) throw new TooManyListenersError();
      // replay and attach in one go: no await in between, so no event can slip past a refreshed tab
      for (const event of run.events) if (event.id > after) send(run, listener, frameOf(event));
      if (!run.listeners.has(listener)) run.listeners.set(listener, undefined);
      return () => {
        const timer = run.listeners.get(listener);
        if (timer) clearTimeout(timer);
        run.listeners.delete(listener);
      };
    },

    async cancel(id, identity) {
      const view = await find(id, identity);
      if (!view) return false;
      const run = runs.get(id);
      if (!run || run.done) return true;
      log.info("run cancelled by the client", { run: run.id });
      // a waiting or gating run ends here; a running one ends through its signal, so its own flow writes the frame
      if (queue.running().some((item) => item.id === run.id)) run.controller.abort();
      else stop(run);
      return true;
    },

    queueState: (owner) => queue.snapshot(owner),

    stats: () =>
      computeStats({
        runs: runStore.all(),
        running: queue.running().length,
        waiting: queue.waiting().length,
        averageRunMs: queue.averageRunMs(),
        maxConcurrentRuns: queue.maxConcurrent,
        serverStartedAt
      }),

    [START_COMPONENT]: () => runStore.ready(),

    async [STOP_COMPONENT]() {
      queue.drain();
      // every live run, rendering included, hears the reason before its stream closes; its own flow then finds it concluded
      for (const run of runs.values()) if (!run.done) stop(run, "The server is restarting. Start the run again in a moment.");
    }
  };
}

/**
 * The queue-driven validation: a collection published in the Builder has each of its items fetched, checked, rendered
 * and reviewed, and one result for the whole collection goes back to the Builder's callback. The task runs until the
 * queue is empty and exits, so it scales to zero between collections; a message is deleted only once the Builder has
 * the result, so a failure to reach the callback is retried by SQS.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { fileSizeLimit, fixes, manifest, registry, uniqueBytesTotal, validate, type CaptureRecord, type Finding, type Input, type Result, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import type { IBuilderComponent } from "../adapters/builder.js";
import type { IRendererComponent } from "../adapters/renderer.js";
import type { ISlackComponent, ItemSize } from "../adapters/slack.js";
import type { IWorkQueueComponent, QueueMessage } from "../adapters/work-queue.js";
import { runCodeChecks } from "./code-checks.js";
import { InvalidReviewRequest, parseReviewRequest, summarizeRequest, type ReviewItem, type ValidationRequest } from "./review-request.js";

const CODE_CHECKS_TIMEOUT_MS = 120_000;
// a transient SQS error must not end the drain: nothing relaunches this task until the next collection
const MAX_CONSECUTIVE_RECEIVE_FAILURES = 5;
// the checks that need the renderer or the model: run after the code checks, with both
const MODEL_CHECKS = registry.filter((check) => check.group === "rendering" || check.group === "code").map((check) => check.name);
// a model check the model did not answer — its row is errored and `retryable`: the call failed, timed out or was rate
// limited, or the answer could not be read — is asked again after each of these waits, on the views already rendered.
// An inconclusive answer, no model, a request over budget or an unavailable model is never asked again: the same
// question would end the same way. Configurable as VISUAL_RETRY_DELAYS_MS; the library adapter's ai.maxRetries (0) is
// the SDK's own retry inside one call and stays off, so this is the only retry policy.
export const VISUAL_RETRY_DELAYS_MS = [10_000, 30_000];
// the file an item's finding points at starts with its body shape's folder: `male/shirt.glb` or `"male/shirt.glb" › Albedo`
const BODY_SHAPE = /^"?(male|female)\//i;

export interface ItemFinding {
  /** Rule-book id, e.g. M-01. */
  rule: string;
  check: string;
  severity: Finding["severity"];
  message: string;
  where?: string;
  bodyShape?: "male" | "female";
  measured?: number;
  limit?: number;
  fix?: string;
  docs?: string;
}

/** One item's result, for the content hash it was validated at. */
export interface ItemResult {
  itemId: string;
  contentHash: string;
  /** null: no verdict, with nothing failed — the item could not be validated, a visual check was not answered, or some checks cannot measure this kind of item. */
  passed: boolean | null;
  findings: ItemFinding[];
  /** What the model saw, one line per visual check it answered. */
  visualSummary?: string;
  /** Undecided because the validator cannot judge this kind of item, not because something went wrong. */
  unsupported?: boolean;
  /** Why the item could not be validated. */
  error?: string;
}

/** What the Builder receives: the collection's verdict and one result per item. */
export interface CollectionResultBody {
  validationId: string;
  collectionId: string;
  /** passed: every item passed · rejected: every item decided, one or more failed · error: some item undecided. */
  verdict: "passed" | "rejected" | "error";
  /** error only: every undecided item is one the validator cannot judge. */
  reason?: "unsupported";
  /** error only: sending the same collection again may decide it. */
  retryable?: boolean;
  rulesVersion: string;
  items: ItemResult[];
}

export interface ReviewJobComponents {
  logs: ILoggerComponent;
  queue: IWorkQueueComponent;
  builder: IBuilderComponent;
  renderer: IRendererComponent;
  reviewer: Reviewer;
  slack: ISlackComponent;
  /** Waits before asking unanswered model checks again, one retry each (default VISUAL_RETRY_DELAYS_MS); [] turns retries off. */
  visualRetryDelaysMs?: number[];
  /** Waits `ms`, or less once `signal` aborts (stop() was called). Tests pass one that returns at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface DrainOptions {
  maxRuntimeMs: number;
  /** Empty long polls in a row before the queue counts as drained. */
  emptyReceivesToExit: number;
}

const numeric = (value: number | string | undefined): number | undefined => (typeof value === "number" ? value : undefined);

/** VISUAL_RETRY_DELAYS_MS as the job reads it: comma-separated whole milliseconds; empty turns retries off; unset is the default. */
export function visualRetryDelays(value: string | undefined): number[] {
  if (value === undefined) return VISUAL_RETRY_DELAYS_MS;
  if (value.trim() === "") return [];
  const delays = value.split(",").map((part) => (/^\s*\d+\s*$/.test(part) ? Number(part) : NaN));
  if (delays.some((ms) => !Number.isSafeInteger(ms))) throw new Error(`VISUAL_RETRY_DELAYS_MS must be comma-separated whole milliseconds, such as 10000,30000, or empty for no retries; got "${value}".`);
  return delays;
}

/** The checks worth asking the model again: unanswered, and the library says another try may answer them. */
const unanswered = (visual: Result): string[] => visual.checks.filter((row) => row.status === "errored" && row.retryable).map((row) => row.check);

function itemFinding(finding: Finding): ItemFinding {
  const shape = BODY_SHAPE.exec(finding.where ?? "")?.[1]?.toLowerCase() as ItemFinding["bodyShape"];
  return {
    rule: finding.rule,
    check: finding.check,
    severity: finding.severity,
    message: finding.message,
    ...(finding.where ? { where: finding.where } : {}),
    ...(shape ? { bodyShape: shape } : {}),
    ...(numeric(finding.measured) !== undefined ? { measured: numeric(finding.measured) } : {}),
    ...(numeric(finding.limit) !== undefined ? { limit: numeric(finding.limit) } : {}),
    ...(fixes[finding.check] ? { fix: fixes[finding.check] } : {}),
    docs: finding.docs
  };
}

/** The visual checks' verdict: failed if any row failed, passed when every row passed or only warned, else none. */
function visualVerdict(visual: Result): boolean | null {
  if (visual.passed !== null) return visual.passed;
  if (visual.checks.every((row) => row.status === "passed" || row.status === "warning")) return true;
  return visual.checks.some((row) => row.status === "failed") ? false : null;
}

/**
 * The item's size as the catalyst counts it — every file once, thumbnail and rarity image included — against its
 * ceiling, so Slack shows the same total the size check measures even when nothing fails. Not part of the Builder's
 * callback: its schema is strict.
 */
export function sizeOf(item: ReviewItem, files: Map<string, Uint8Array>): ItemSize {
  const data = item.metadata.data as { category?: unknown } | undefined;
  const category = typeof data?.category === "string" ? data.category : undefined;
  return { bytes: uniqueBytesTotal(files.values()), limit: fileSizeLimit(item.itemType, category) };
}

/** The item's thumbnail, as its metadata names it. */
function thumbnailOf(item: ReviewItem, files: Map<string, Uint8Array>): Uint8Array | undefined {
  const path = typeof item.metadata.thumbnail === "string" ? item.metadata.thumbnail : "thumbnail.png";
  return files.get(path);
}

export function itemResult(item: ReviewItem, gate: Result, visual: Result): ItemResult {
  // no verdict from the code checks is no verdict for the item: a facial feature without errors (it is PNGs, no model
  // check can measure it) stays undecided; with an error the code checks already said false
  const passed = gate.passed === false ? false : gate.passed === null ? null : visualVerdict(visual);
  const rows = [...gate.checks, ...visual.checks];
  // undecided only because some checks cannot measure this kind of item, with nothing failed or unanswered: a person
  // decides, and sending it again would answer the same
  const unsupported = passed === null && rows.some((row) => row.status === "skipped" && row.coverage === "missing") && !rows.some((row) => row.status === "failed" || row.status === "errored");
  const visualRows = visual.checks;
  // a visual row the model answered carries its summary as the measured value
  const visualSummary = visualRows.filter((row) => row.review && row.measured && row.status !== "errored" && row.status !== "skipped").map((row) => `${row.check}: ${row.measured}`).join("\n");
  return {
    itemId: item.itemId,
    contentHash: item.contentHash,
    passed,
    findings: [...gate.findings, ...visual.findings].map(itemFinding),
    ...(visualSummary ? { visualSummary } : {}),
    ...(unsupported ? { unsupported } : {})
  };
}

/**
 * The first visual run with the checks asked again replacing theirs: their rows and their findings. A view is the
 * capture it was requested as (its request key): the retry is handed the first run's views and returns them, so only a
 * view the first run never drew is added, and none is listed twice. `passed` is null, as for any subset of the checks:
 * the item's verdict comes from the merged rows (visualVerdict).
 */
export function mergeVisual(first: Result, again: Result): Result {
  const redone = new Map(again.checks.map((row) => [row.check, row]));
  const checks = first.checks.map((row) => redone.get(row.check) ?? row);
  const findings = [...first.findings.filter((finding) => !redone.has(finding.check)), ...again.findings];
  const drawn = new Set(first.captures.map((capture) => capture.request.key));
  const captures = [...first.captures, ...again.captures.filter((capture) => !drawn.has(capture.request.key))];
  return {
    passed: null,
    checks,
    findings,
    captures,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      checked: checks.filter((row) => row.status !== "skipped").length,
      skipped: checks.filter((row) => row.status === "skipped").length
    }
  };
}

export function collectionResult(request: ValidationRequest, items: ItemResult[]): CollectionResultBody {
  const base = { validationId: request.validationId, collectionId: request.collectionId, rulesVersion: manifest.version, items };
  const undecided = items.filter((item) => item.passed === null);
  if (undecided.length === 0) return { ...base, verdict: items.some((item) => item.passed === false) ? "rejected" : "passed" };
  return undecided.every((item) => item.unsupported) ? { ...base, verdict: "error", reason: "unsupported", retryable: false } : { ...base, verdict: "error", retryable: true };
}

export function createReviewJob(components: ReviewJobComponents) {
  const { logs, queue, builder, renderer, reviewer, slack } = components;
  const retryDelaysMs = components.visualRetryDelaysMs ?? VISUAL_RETRY_DELAYS_MS;
  const sleep = components.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(() => {}));
  const log = logs.getLogger("review-job");
  let stopping = false;
  // stop() aborts it: a wait before a retry ends at once
  const stopped = new AbortController();
  // drain() sets it: a retry is started only if it fits in what is left of the runtime budget
  let deadline = Infinity;

  /** Why the checks are not asked again now, or undefined when they are. */
  function noRetry(checks: string[], delayMs: number): string | undefined {
    if (stopping) return "the job is stopping";
    // the checks run in series, and in a provider slowdown each call lasts the adapter's whole timeout: a retry is
    // started only if its wait plus that worst case ends before the runtime budget does
    if (Date.now() + delayMs + checks.length * manifest.ai.timeoutMs > deadline) return "the runtime budget left is too short";
    return undefined;
  }

  /**
   * Renders and reviews one item; the render server is started for it and stopped after, whatever happens. A model
   * check left unanswered is asked again while the server is still up, reusing the views it already drew, so one
   * failed call does not leave the item without a verdict.
   */
  async function renderAndReview(item: ReviewItem, input: Input): Promise<Result> {
    const drawer = await renderer.forItem(item.itemId);
    try {
      let visual = await validate(input, { checks: MODEL_CHECKS, services: { renderer: drawer, reviewer } });
      for (const delayMs of retryDelaysMs) {
        const checks = unanswered(visual);
        if (checks.length === 0) break;
        const skip = noRetry(checks, delayMs);
        if (skip) {
          log.warn("not asking the model again", { item: item.itemId, checks: checks.join(","), reason: skip });
          break;
        }
        log.info("asking the model again", { item: item.itemId, checks: checks.join(","), afterMs: delayMs });
        await sleep(delayMs, stopped.signal);
        if (stopping) break;
        visual = mergeVisual(visual, await validate(input, { checks, services: { renderer: drawer, reviewer }, captures: visual.captures }));
      }
      const stillUnanswered = visual.checks.filter((row) => row.status === "errored").map((row) => `${row.check}${row.retryable ? "" : " (not retryable)"}`);
      if (stillUnanswered.length) log.warn("model checks still unanswered", { item: item.itemId, checks: stillUnanswered.join(",") });
      return visual;
    } finally {
      await drawer.stop().catch(() => {});
    }
  }

  /** One item's result, with what Slack shows of it: the thumbnail and the rendered views. */
  async function validateItem(item: ReviewItem): Promise<{ result: ItemResult; thumbnail?: Uint8Array; captures: CaptureRecord[]; size?: ItemSize }> {
    const started = Date.now();
    let files: Map<string, Uint8Array> | undefined;
    let size: ItemSize | undefined;
    try {
      files = await builder.fetchFiles(item);
      size = sizeOf(item, files);
      // the entity mode: metadata, the files, and the hash each file was published under, so content integrity is checked too
      const input: Input = { files, metadata: item.metadata, content: Object.entries(item.contents).map(([file, hash]) => ({ file, hash })) };
      const gate = await runCodeChecks(input, { signal: new AbortController().signal, onProgress: () => {}, timeoutMs: CODE_CHECKS_TIMEOUT_MS });
      // curators look at the views whatever the code checks said, as a standalone run on the site does
      const visual = await renderAndReview(item, input);
      const result = itemResult(item, gate, visual);
      log.info("item validated", { item: item.itemId, passed: String(result.passed), ms: Date.now() - started });
      return { result, thumbnail: thumbnailOf(item, files), captures: visual.captures, size };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("item could not be validated", { item: item.itemId, reason });
      return { result: { itemId: item.itemId, contentHash: item.contentHash, passed: null, findings: [], error: reason }, thumbnail: files && thumbnailOf(item, files), captures: [], size };
    }
  }

  /** "delete" once the Builder has the result or the message can never be acted on; "retry" leaves it for SQS to redeliver. */
  async function process(message: QueueMessage): Promise<"delete" | "retry"> {
    const summary = summarizeRequest(message.body);
    const named = { id: message.id, collection: summary.collectionId ?? "unknown", validation: summary.validationId ?? "unknown", items: summary.items ?? 0 };
    log.info("request received", named);
    let request: ValidationRequest;
    try {
      request = parseReviewRequest(message.body);
    } catch (error) {
      if (!(error instanceof InvalidReviewRequest)) throw error;
      // never dropped unseen: the curators are told this collection gets no automatic review, and why
      log.error("request refused: not validated", { ...named, reason: error.message });
      await slack.requestRefused(summary, error.message);
      return "delete";
    }
    // a collection of many items outlasts one visibility timeout: keep it hidden from other tasks while it is in hand
    const heartbeat = setInterval(() => void queue.extend(message.receiptHandle).catch(() => {}), (queue.visibilityTimeout * 1000) / 3);
    try {
      const started = Date.now();
      // nothing is kept after the job exits: the channel is where a curator sees each item, as it is validated
      const ts = await slack.collectionStarted(request);
      const items: ItemResult[] = [];
      for (const item of request.items) {
        const { result, thumbnail, captures, size } = await validateItem(item);
        items.push(result);
        if (ts) await slack.itemValidated(ts, { item, result, thumbnail, captures, size });
      }
      const body = collectionResult(request, items);
      if (ts) await slack.collectionFinished(ts, request, body, Date.now() - started);
      await builder.postResult(request.collectionId, body);
      log.info("collection validated", { validation: request.validationId, collection: request.collectionId, items: items.length, verdict: body.verdict, ms: Date.now() - started });
      return "delete";
    } catch (error) {
      log.warn("could not post the result: left on the queue to retry", { validation: request.validationId, reason: error instanceof Error ? error.message : String(error) });
      return "retry";
    } finally {
      clearInterval(heartbeat);
    }
  }

  return {
    process,
    /** The collection in hand finishes, with no more waits or retries; then the drain ends. */
    stop(): void {
      stopping = true;
      stopped.abort();
    },
    /** Works through the queue until it is empty, the runtime budget is spent or stop() is called. */
    async drain(options: DrainOptions): Promise<number> {
      deadline = Date.now() + options.maxRuntimeMs;
      let processed = 0;
      let empty = 0;
      let failures = 0;
      while (!stopping && Date.now() < deadline) {
        let message;
        try {
          message = await queue.receive();
          failures = 0;
        } catch (error) {
          failures++;
          log.warn("could not read the work queue", { failures, reason: error instanceof Error ? error.message : String(error) });
          if (failures >= MAX_CONSECUTIVE_RECEIVE_FAILURES) break;
          await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
          continue;
        }
        if (!message) {
          if (++empty >= options.emptyReceivesToExit) break;
          continue;
        }
        empty = 0;
        if ((await process(message)) === "delete") {
          // a failed delete only means the message comes back; the Builder gets the same result twice
          await queue.delete(message.receiptHandle).catch((error: unknown) => log.warn("could not delete a handled message", { id: message.id, reason: error instanceof Error ? error.message : String(error) }));
        }
        processed++;
      }
      log.info("drain finished", { processed, stopped: String(stopping) });
      return processed;
    }
  };
}

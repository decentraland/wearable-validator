/**
 * The queue-driven validation: a collection published in the Builder has each of its items fetched, checked, rendered
 * and reviewed, and one result for the whole collection goes back to the Builder's callback. The task runs until the
 * queue is empty and exits, so it scales to zero between collections; a message is deleted only once the Builder has
 * the result, so a failure to reach the callback is retried by SQS.
 */
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { fixes, manifest, registry, validate, type Finding, type Input, type Result, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import type { IBuilderComponent } from "../adapters/builder.js";
import type { IRendererComponent } from "../adapters/renderer.js";
import type { IWorkQueueComponent, QueueMessage } from "../adapters/work-queue.js";
import { runCodeChecks } from "./code-checks.js";
import { InvalidReviewRequest, parseReviewRequest, type ReviewItem, type ValidationRequest } from "./review-request.js";

const CODE_CHECKS_TIMEOUT_MS = 120_000;
// a transient SQS error must not end the drain: nothing relaunches this task until the next collection
const MAX_CONSECUTIVE_RECEIVE_FAILURES = 5;
const VISUAL_CHECKS = registry.filter((check) => check.group === "rendering").map((check) => check.name);
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
  /** null: no verdict — the item could not be validated, or a visual check was not answered. */
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
}

export interface DrainOptions {
  maxRuntimeMs: number;
  /** Empty long polls in a row before the queue counts as drained. */
  emptyReceivesToExit: number;
}

const numeric = (value: number | string | undefined): number | undefined => (typeof value === "number" ? value : undefined);

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

export function itemResult(item: ReviewItem, gate: Result, visual: Result): ItemResult {
  const passed = gate.passed === false ? false : visualVerdict(visual);
  const visualRows = visual.checks;
  // nothing to look at for this kind of item (every visual row skipped for it): a curator decides, not a retry
  const unsupported = passed === null && visualRows.length > 0 && visualRows.every((row) => row.status === "skipped");
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

export function collectionResult(request: ValidationRequest, items: ItemResult[]): CollectionResultBody {
  const base = { validationId: request.validationId, collectionId: request.collectionId, rulesVersion: manifest.version, items };
  const undecided = items.filter((item) => item.passed === null);
  if (undecided.length === 0) return { ...base, verdict: items.some((item) => item.passed === false) ? "rejected" : "passed" };
  return undecided.every((item) => item.unsupported) ? { ...base, verdict: "error", reason: "unsupported", retryable: false } : { ...base, verdict: "error", retryable: true };
}

export function createReviewJob(components: ReviewJobComponents) {
  const { logs, queue, builder, renderer, reviewer } = components;
  const log = logs.getLogger("review-job");
  let stopping = false;

  /** Renders and reviews one item; the render server is started for it and stopped after, whatever happens. */
  async function renderAndReview(item: ReviewItem, input: Input): Promise<Result> {
    const drawer = await renderer.forItem(item.itemId);
    try {
      return await validate(input, { checks: VISUAL_CHECKS, services: { renderer: drawer, reviewer } });
    } finally {
      await drawer.stop().catch(() => {});
    }
  }

  async function validateItem(item: ReviewItem): Promise<ItemResult> {
    const started = Date.now();
    try {
      // the entity mode: metadata, the files, and the hash each file was published under, so content integrity is checked too
      const input: Input = { files: await builder.fetchFiles(item), metadata: item.metadata, content: Object.entries(item.contents).map(([file, hash]) => ({ file, hash })) };
      const gate = await runCodeChecks(input, { signal: new AbortController().signal, onProgress: () => {}, timeoutMs: CODE_CHECKS_TIMEOUT_MS });
      // curators look at the views whatever the code checks said, as a standalone run on the site does
      const result = itemResult(item, gate, await renderAndReview(item, input));
      log.info("item validated", { item: item.itemId, passed: String(result.passed), ms: Date.now() - started });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("item could not be validated", { item: item.itemId, reason });
      return { itemId: item.itemId, contentHash: item.contentHash, passed: null, findings: [], error: reason };
    }
  }

  /** "delete" once the Builder has the result or the message can never be acted on; "retry" leaves it for SQS to redeliver. */
  async function process(message: QueueMessage): Promise<"delete" | "retry"> {
    let request: ValidationRequest;
    try {
      request = parseReviewRequest(message.body);
    } catch (error) {
      if (!(error instanceof InvalidReviewRequest)) throw error;
      log.error("dropping a message that is not a validation request", { id: message.id, reason: error.message });
      return "delete";
    }
    // a collection of many items outlasts one visibility timeout: keep it hidden from other tasks while it is in hand
    const heartbeat = setInterval(() => void queue.extend(message.receiptHandle).catch(() => {}), (queue.visibilityTimeout * 1000) / 3);
    try {
      const started = Date.now();
      const items: ItemResult[] = [];
      for (const item of request.items) items.push(await validateItem(item));
      const body = collectionResult(request, items);
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
    stop(): void {
      stopping = true;
    },
    /** Works through the queue until it is empty, the runtime budget is spent or stop() is called. */
    async drain(options: DrainOptions): Promise<number> {
      const deadline = Date.now() + options.maxRuntimeMs;
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

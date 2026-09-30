/**
 * The queue-driven review: an item submitted for curation in the Builder is fetched, checked, rendered and reviewed,
 * and the result goes back to the Builder's webhook. The task runs until the queue is empty and exits, so it scales to
 * zero between submissions; a message is deleted only once the Builder has the result, so a failure is retried by SQS.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { manifest, validate, type CheckResult, type Finding, type Input, type Result } from "@dcl-regenesislabs/wearable-validator";
import type { IBuilderComponent } from "../adapters/builder.js";
import { appLogger } from "../adapters/log-buffer.js";
import type { IRendererComponent } from "../adapters/renderer.js";
import type { IReviewerComponent } from "../adapters/reviewer.js";
import type { IWorkQueueComponent } from "../adapters/work-queue.js";
import type { CuratorDecision, RunSink } from "../types.js";
import { runCodeChecks } from "./code-checks.js";
import { curatorDecision } from "./decision.js";
import { InvalidReviewRequest, parseReviewRequest, type ReviewRequest } from "./review-request.js";
import { verdict } from "./run-store.js";
import { VISUAL_CHECKS } from "./runs.js";

const CODE_CHECKS_TIMEOUT_MS = 120_000;
// a transient SQS error must not end the drain: nothing relaunches this task until the next submission
const MAX_CONSECUTIVE_RECEIVE_FAILURES = 5;

/** What the Builder receives: the verdict, what a curator must do, and every row and finding, for the content hash it was asked about. */
export interface ReviewResultBody {
  itemId: string;
  collectionId: string;
  contentHash: string;
  rulesVersion: string;
  passed: boolean | null;
  decision: CuratorDecision;
  summary: { errors: number; warnings: number };
  checks: Pick<CheckResult, "check" | "group" | "status" | "measured" | "skipReason">[];
  findings: Pick<Finding, "check" | "severity" | "message" | "where" | "docs">[];
}

export interface ReviewJobComponents {
  logs: ILoggerComponent;
  queue: IWorkQueueComponent;
  builder: IBuilderComponent;
  renderer: IRendererComponent;
  reviewer: IReviewerComponent;
}

export interface DrainOptions {
  maxRuntimeMs: number;
  /** Empty long polls in a row before the queue counts as drained. */
  emptyReceivesToExit: number;
}

export function resultBody(request: ReviewRequest, gate: Result, visual: Result | undefined): ReviewResultBody {
  const passed = gate.passed === false ? false : visual ? verdict(visual) : null;
  const rows = [...gate.checks, ...(visual?.checks ?? [])];
  const findings = [...gate.findings, ...(visual?.findings ?? [])];
  return {
    itemId: request.itemId,
    collectionId: request.collectionId,
    contentHash: request.contentHash,
    rulesVersion: manifest.version,
    passed,
    decision: curatorDecision({ gate, visual, passed }),
    summary: { errors: gate.summary.errors + (visual?.summary.errors ?? 0), warnings: gate.summary.warnings + (visual?.summary.warnings ?? 0) },
    checks: rows.map(({ check, group, status, measured, skipReason }) => ({ check, group, status, measured, skipReason })),
    findings: findings.map(({ check, severity, message, where, docs }) => ({ check, severity, message, where, docs }))
  };
}

export function createReviewJob(components: ReviewJobComponents) {
  const { logs, queue, builder, renderer, reviewer } = components;
  const log = appLogger(logs, "review-job");
  let stopping = false;

  /** Renders and reviews one item; the render server is started for it and stopped after, whatever happens. */
  async function review(request: ReviewRequest, input: Input): Promise<Result> {
    const dir = await mkdtemp(join(tmpdir(), "review-"));
    const sink: RunSink = { id: request.itemId, dir, emit: (type, data) => log.info(type, { item: request.itemId, data: JSON.stringify(data).slice(0, 300) }), capture: async () => {} };
    const drawer = await renderer.forRun(sink);
    try {
      return await validate(input, { checks: VISUAL_CHECKS, services: { renderer: drawer, reviewer: reviewer.forRun(sink) } });
    } finally {
      await drawer?.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** "delete" once the Builder has the result or the message can never be acted on; "retry" leaves it for SQS to redeliver. */
  async function process(body: string): Promise<"delete" | "retry"> {
    let request: ReviewRequest;
    try {
      request = parseReviewRequest(body);
    } catch (error) {
      if (!(error instanceof InvalidReviewRequest)) throw error;
      log.error("dropping a message that is not a review request", { reason: error.message });
      return "delete";
    }
    const started = Date.now();
    try {
      const input: Input = { files: await builder.fetchFiles(request), metadata: request.entityMetadata };
      const gate = await runCodeChecks(input, { signal: new AbortController().signal, onProgress: () => {}, timeoutMs: CODE_CHECKS_TIMEOUT_MS });
      // curators look at the views whatever the code checks said, as a standalone run on the site does
      const visual = await review(request, input);
      const result = resultBody(request, gate, visual);
      await builder.postResult(request, result);
      log.info("item reviewed", { item: request.itemId, passed: String(result.passed), decision: result.decision.state, ms: Date.now() - started });
      return "delete";
    } catch (error) {
      log.warn("review failed: left on the queue to retry", { item: request.itemId, reason: error instanceof Error ? error.message : String(error) });
      return "retry";
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
        if ((await process(message.body)) === "delete") {
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

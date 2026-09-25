/** Reviewer wrappers around the library's Reviewer contract: recording, dry run, replay and live. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { manifest, type Reviewer, type ReviewResult } from "@dcl-regenesislabs/wearable-validator";
import { createPiReviewer, setupTokenCredentials } from "@dcl-regenesislabs/wearable-validator/ai";
import { contextJson, promptMarkdown, readEvidenceFile } from "../logic/run-store.js";
import type { RunSink } from "../types.js";

export const DRY_RUN_REASON = "The model was not called: the run server has no ANTHROPIC_OAUTH_SETUP_TOKEN.";

/** Writes <check>/1-prompt.md and 2-context.json BEFORE forwarding, 3-answer.json after — so a dry run still leaves the prompt on disk. */
export function recordingReviewer(reviewer: Reviewer, dir: string): Reviewer {
  return {
    async review(request, signal) {
      const folder = join(dir, request.check);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "1-prompt.md"), promptMarkdown(request));
      await writeFile(join(folder, "2-context.json"), JSON.stringify(await contextJson(request), null, 2));
      const result = await reviewer.review(request, signal);
      await writeFile(join(folder, "3-answer.json"), JSON.stringify(result, null, 2));
      return result;
    }
  };
}

/** No model: renders and records the prompt, never calls it; the row becomes errored with this reason. */
export function dryRunReviewer(reason = DRY_RUN_REASON): Reviewer {
  return {
    async review(request) {
      return {
        ok: false,
        reason,
        metadata: { provider: "none", model: "none", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
      };
    }
  };
}

/** --from <run> --answer: replays each check's saved 3-answer.json through the checks with zero network. */
export function replayReviewer(runDir: string): Reviewer {
  return {
    async review(request) {
      const answerPath = join(runDir, request.check, "3-answer.json");
      const saved: unknown = JSON.parse((await readEvidenceFile(answerPath)).toString("utf8"));
      if (!saved || typeof saved !== "object" || typeof (saved as { ok?: unknown }).ok !== "boolean" || !("metadata" in saved)) {
        throw new Error(`${answerPath} is not a saved ReviewResult. Run npm run review with ANTHROPIC_OAUTH_SETUP_TOKEN set first.`);
      }
      const result = saved as ReviewResult;
      if (result.metadata.promptDigest !== request.promptDigest) {
        console.error(`Warning: ${answerPath} was produced for prompt digest ${result.metadata.promptDigest}, the current prompt is ${request.promptDigest}.`);
      }
      // echo the request's digest — the answer is replayed against this prompt on purpose
      const metadata = { ...result.metadata, promptVersion: request.prompt.version, promptDigest: request.promptDigest };
      return result.ok ? { ok: true, answer: result.answer, metadata } : { ok: false, reason: result.reason, metadata };
    }
  };
}

/** Announces the prompt before the model call and the answer after it, on top of the recording wrapper. */
export function liveReviewer(reviewer: Reviewer, run: RunSink): Reviewer {
  return {
    async review(request, signal) {
      const check = request.check;
      run.emit("review", {
        check,
        phase: "request",
        promptVersion: request.prompt.version,
        promptDigest: request.promptDigest,
        images: request.images.map((image) => ({ id: image.id, label: image.label })),
        promptUrl: `/api/runs/${run.id}/${check}/1-prompt.md`
      });
      const result = await reviewer.review(request, signal);
      run.emit("review", { check, phase: "answer", ...result });
      return result;
    }
  };
}

export interface IReviewerComponent {
  readonly kind: "pi" | "dry-run";
  readonly model?: string;
  forRun(run: RunSink): Reviewer;
}

export async function createReviewerComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IReviewerComponent> {
  const { config, logs } = components;
  // the only credential is the year-long `claude setup-token` from the environment: no session file, nothing to refresh or persist
  const setupToken = await config.getString("ANTHROPIC_OAUTH_SETUP_TOKEN");
  const credentials = setupToken ? setupTokenCredentials(setupToken) : undefined;
  if (!credentials) logs.getLogger("reviewer").warn("no OAuth session: reviews render and write the prompt without calling the model (set ANTHROPIC_OAUTH_SETUP_TOKEN to a claude setup-token)");
  return {
    kind: credentials ? "pi" : "dry-run",
    model: credentials ? manifest.ai.model : undefined,
    forRun: (run) => liveReviewer(recordingReviewer(credentials ? createPiReviewer({ credentials }) : dryRunReviewer(), run.dir), run)
  };
}

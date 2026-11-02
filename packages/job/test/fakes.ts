/** Stand-ins for the render server, the model and the logger, so the job runs in tests with no Docker and no network. */
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { digest, manifest, type CaptureRecord, type Renderer, type ReviewRequest, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import { renderedFrame } from "../../wearable-validator/test/helpers/frames.js";
import type { IRendererComponent } from "../src/adapters/renderer.js";

/** Nothing is printed. */
export function silentLogs(): ILoggerComponent {
  const quiet = () => {};
  return { getLogger: () => ({ log: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet }) };
}

export interface RenderCalls {
  /** Render servers started: one per item that reached rendering. */
  started: number;
  /** Views drawn across every server. */
  frames?: number;
}

/** A render server that answers every view at once, each drawing with bytes of its own: a view drawn twice would not match. */
export function fakeRenderer(calls: RenderCalls): IRendererComponent {
  const size = manifest.rendering.imageSizePx;
  return {
    forItem: async (): Promise<Renderer> => {
      calls.started++;
      return {
        buildId: "fake-build",
        capture: async (_input, requests) => {
          const captures: CaptureRecord[] = [];
          for (const request of requests) {
            calls.frames = (calls.frames ?? 0) + 1;
            const bytes = renderedFrame(size, true, calls.frames);
            captures.push({ request, bytes, sha256: await digest(bytes), width: size, height: size });
          }
          return captures;
        },
        stop: async () => {}
      };
    }
  };
}

/** A model that always agrees and finds nothing. */
export function fakeReviewer(): Reviewer {
  return {
    review: async (request) => ({
      ok: true,
      answer: {
        verdict: request.check === "thumbnail-honesty" ? "matches" : "ok",
        summary: request.check === "smart-wearable-code" ? "Plays a beat when the wearer dances." : "Same shirt.",
        reviewedCaptureIds: request.images.map((image) => image.id),
        findings: []
      },
      metadata: { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
    })
  };
}

/**
 * A model that drops a check's first `failures[check]` calls, as an overloaded or timed-out call comes back (worth
 * asking again), then answers with `answers[check]` when given, else like fakeReviewer. `calls` counts every request
 * per check; `seen` holds, per check and call, the sha256 of each image it was shown.
 */
export function flakyReviewer(failures: Record<string, number>, answers: Record<string, (request: ReviewRequest) => unknown> = {}): Reviewer & { calls: Record<string, number>; seen: Record<string, string[][]> } {
  const agreeing = fakeReviewer();
  const calls: Record<string, number> = {};
  const seen: Record<string, string[][]> = {};
  return {
    calls,
    seen,
    review: async (request, signal) => {
      calls[request.check] = (calls[request.check] ?? 0) + 1;
      (seen[request.check] ??= []).push(await Promise.all(request.images.map((image) => digest(image.bytes))));
      const metadata = { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest };
      if (calls[request.check] <= (failures[request.check] ?? 0)) return { ok: false, reason: "The review did not finish (error). 529 overloaded_error", metadata, retryable: true };
      const answer = answers[request.check];
      return answer ? { ok: true, answer: answer(request), metadata } : agreeing.review(request, signal);
    }
  };
}

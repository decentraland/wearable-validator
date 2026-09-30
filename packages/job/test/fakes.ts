/** Stand-ins for the render server, the model and the logger, so the job runs in tests with no Docker and no network. */
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { digest, manifest, type CaptureRecord, type Renderer, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
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
}

/** A render server that answers every view with the same frame, at once. */
export function fakeRenderer(calls: RenderCalls): IRendererComponent {
  const size = manifest.rendering.imageSizePx;
  const bytes = renderedFrame(size);
  return {
    forItem: async (): Promise<Renderer> => {
      calls.started++;
      return {
        buildId: "fake-build",
        capture: async (_input, requests) => {
          const captures: CaptureRecord[] = [];
          for (const request of requests) captures.push({ request, bytes, sha256: await digest(bytes), width: size, height: size });
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
      answer: { verdict: request.check === "thumbnail-honesty" ? "matches" : "ok", summary: "Same shirt.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
      metadata: { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
    })
  };
}

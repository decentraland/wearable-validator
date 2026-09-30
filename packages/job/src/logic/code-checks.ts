import { Worker } from "node:worker_threads";
import type { Input, ProgressEvent, Result } from "@dcl-regenesislabs/wearable-validator";

type WorkerMessage = { progress: ProgressEvent } | { result: Result };

export interface CodeCheckOptions {
  signal: AbortSignal;
  onProgress: (event: ProgressEvent) => void;
  timeoutMs: number;
  /** V8 heap of the worker; the file bytes themselves live outside it and are bounded by the manifest instead. */
  maxHeapMb?: number;
}

/** The code checks in a worker thread: a file that stalls them costs that thread and its deadline, never the server's event loop. */
export function runCodeChecks(input: Input, options: CodeCheckOptions): Promise<Result> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./code-checks-worker.ts", import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? 1024 }
    });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      void worker.terminate();
      finish();
    };
    const abort = (): void => settle(() => reject(options.signal.reason));
    const timer = setTimeout(() => settle(() => reject(new Error(`The code checks did not finish within ${Math.round(options.timeoutMs / 1000)} seconds on this file. Re-export the model with fewer nodes, meshes and textures and try again.`))), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: WorkerMessage) => {
      if ("progress" in message) options.onProgress(message.progress);
      else settle(() => resolve(message.result));
    });
    worker.on("error", (error: Error & { code?: string }) => {
      settle(() => reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error("The code checks ran out of memory on this file. Re-export the model with less geometry, animation or texture data and try again.") : error));
    });
    worker.on("exit", () => settle(() => reject(new Error("The code checks stopped before they finished."))));
  });
}

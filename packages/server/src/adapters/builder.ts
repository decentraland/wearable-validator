/** The Builder side of a queued review: the item's files from its storage, and the result posted back to its webhook, signed. */
import { createHmac } from "node:crypto";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import type { ReviewRequest } from "../logic/review-request.js";
import { appLogger } from "./log-buffer.js";

const TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
export const SIGNATURE_HEADER = "x-wearable-validator-signature";
export const TIMESTAMP_HEADER = "x-wearable-validator-timestamp";

export interface IBuilderComponent {
  /** The item's files by name; rejects past the manifest's input limits or when storage does not answer. */
  fetchFiles(request: ReviewRequest): Promise<Map<string, Uint8Array>>;
  /** Rejects unless the webhook answered 2xx: the message then stays on the queue and is retried. */
  postResult(request: ReviewRequest, body: unknown): Promise<void>;
}

export interface BuilderComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  /** Injectable so tests serve storage and record the webhook; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** HMAC-SHA256 over `<timestamp>.<body>`: the Builder recomputes it with the shared secret and refuses stale timestamps. */
export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function createBuilderComponent(components: BuilderComponents): Promise<IBuilderComponent> {
  const { config, logs } = components;
  const fetchImpl = components.fetch ?? globalThis.fetch;
  const log = appLogger(logs, "builder");
  // e.g. https://builder-api.decentraland.org/v1: files come from <api>/storage/contents/<hash>, results go to <api>/items/<id>/validation
  const api = (await config.requireString("BUILDER_API_URL")).replace(/\/+$/, "");
  const secret = await config.requireString("BUILDER_WEBHOOK_SECRET");
  const maxBytes = manifest.fileSize.maxInputBytes;

  return {
    async fetchFiles(request) {
      const files = new Map<string, Uint8Array>();
      const queue = Object.entries(request.contents);
      let bytes = 0;
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [file, hash] = next;
          const res = await fetchImpl(`${api}/storage/contents/${hash}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) throw new Error(`Builder storage answered ${res.status} for "${file}".`);
          const data = new Uint8Array(await res.arrayBuffer());
          bytes += data.byteLength;
          if (bytes > maxBytes) throw new Error(`The item's files exceed the ${Math.round(maxBytes / 1048576)} MB input limit.`);
          files.set(file, data);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return files;
    },

    async postResult(request, body) {
      const text = JSON.stringify(body);
      const timestamp = String(Date.now());
      const res = await fetchImpl(`${api}/items/${request.itemId}/validation`, {
        method: "POST",
        headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature(secret, timestamp, text) },
        body: text,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`The Builder webhook answered ${res.status} for item ${request.itemId}.`);
      log.info("result posted", { item: request.itemId, contentHash: request.contentHash });
    }
  };
}

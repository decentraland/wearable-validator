/**
 * The Builder side of a queued validation: each item's files from its content storage, and the result posted back
 * to its callback, signed. The Builder's address comes from config, never from a request, so a message cannot point the
 * job at another host.
 */
import { createHmac } from "node:crypto";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { ReviewItem } from "../logic/review-request.js";

const TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
// the same cap an upload to the run server has: one item's files together
const DEFAULT_MAX_ITEM_BYTES = 32 * 1024 * 1024;
// the callback's backoff; past the last try the message stays on the queue and SQS retries the whole collection
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
export const SIGNATURE_HEADER = "x-wearable-validator-signature";
export const TIMESTAMP_HEADER = "x-wearable-validator-timestamp";

export interface IBuilderComponent {
  /** The item's files by path; rejects past the per-item cap or when storage does not answer. */
  fetchFiles(item: ReviewItem): Promise<Map<string, Uint8Array>>;
  /** Rejects unless the callback answered 2xx within its retries. */
  postResult(collectionId: string, body: unknown): Promise<void>;
}

export interface BuilderComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  /** Injectable so tests stand in for the Builder; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable so tests do not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/** HMAC-SHA256 over `<timestamp>.<raw body>`: the Builder recomputes it with the shared secret and refuses stale timestamps. */
export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const retryable = (status: number): boolean => status >= 500 || status === 408 || status === 429;

export async function createBuilderComponent(components: BuilderComponents): Promise<IBuilderComponent> {
  const { config, logs } = components;
  const fetchImpl = components.fetch ?? globalThis.fetch;
  const sleep = components.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = logs.getLogger("builder");
  // builder-server serves both the items' files and the callback, e.g. https://builder-api.decentraland.org
  const api = (await config.requireString("BUILDER_API_URL")).replace(/\/+$/, "");
  const secret = await config.requireString("BUILDER_CALLBACK_SECRET");
  const maxItemBytes = (await config.getNumber("MAX_UPLOAD_BYTES")) ?? DEFAULT_MAX_ITEM_BYTES;

  return {
    async fetchFiles(item) {
      // the Builder stores one file per body shape: male/x.glb and female/x.glb are often the same bytes under one hash,
      // downloaded and counted once, as the catalyst counts a deployment's size
      const byHash = new Map<string, Uint8Array>();
      const queue = [...new Set(Object.values(item.contents))];
      let bytes = 0;
      const worker = async (): Promise<void> => {
        for (let hash = queue.shift(); hash; hash = queue.shift()) {
          // the route redirects to the storage bucket; fetch follows it
          const res = await fetchImpl(`${api}/v1/storage/contents/${hash}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) throw new Error(`Builder storage answered ${res.status} for "${Object.keys(item.contents).find((file) => item.contents[file] === hash)}".`);
          const data = new Uint8Array(await res.arrayBuffer());
          bytes += data.byteLength;
          if (bytes > maxItemBytes) throw new Error(`The item's files exceed ${Math.round(maxItemBytes / 1048576)} MB.`);
          byHash.set(hash, data);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return new Map(Object.entries(item.contents).map(([file, hash]) => [file, byHash.get(hash)!]));
    },

    async postResult(collectionId, body) {
      const text = JSON.stringify(body);
      const url = `${api}/v1/collections/${collectionId}/validation-result`;
      for (let attempt = 0; ; attempt++) {
        const timestamp = String(Date.now());
        let res: Response | undefined;
        let reason = "";
        try {
          res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature(secret, timestamp, text) },
            body: text,
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
        if (res?.ok) {
          log.info("result posted", { collection: collectionId, attempts: attempt + 1 });
          return;
        }
        // a refusal the Builder meant (another 4xx) is final
        if (res && !retryable(res.status)) throw new Error(`The Builder callback answered ${res.status} for collection ${collectionId}.`);
        if (res) reason = `HTTP ${res.status}`;
        if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`The Builder callback did not take the result for collection ${collectionId}: ${reason}.`);
        log.warn("callback failed: retrying", { collection: collectionId, attempt: attempt + 1, reason });
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  };
}

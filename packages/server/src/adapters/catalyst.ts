/** The catalyst a run fetches a published item from: the library does the fetching, this names the peer and the fetch to use. */
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { fetchCatalystItem, type CatalystItem } from "@dcl-regenesislabs/wearable-validator";
import { appLogger } from "./log-buffer.js";

export interface CatalystProgress {
  text: string;
  done?: number;
  total?: number;
}

export interface ICatalystComponent {
  readonly peer: string;
  /** Rejects with the library's creator-facing sentence: no entity, catalyst down, over the input limits. */
  fetchItem(candidates: string[], onProgress: (progress: CatalystProgress) => void, signal?: AbortSignal): Promise<CatalystItem>;
}

export interface CatalystComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  /** Injectable so tests serve entities without a network; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export async function createCatalystComponent(components: CatalystComponents): Promise<ICatalystComponent> {
  const { config, logs } = components;
  const log = appLogger(logs, "catalyst");
  // unset: each item's network picks the catalyst (mainnet on .org, the test networks on .zone)
  const configured = (await config.getString("CATALYST_URL"))?.replace(/\/+$/, "");
  const timeoutMs = (await config.getNumber("CATALYST_TIMEOUT_MS")) ?? 60000;
  return {
    peer: configured ?? "by network",
    async fetchItem(candidates, onProgress, signal) {
      // the lookup and every download share one deadline: a peer that accepts the connection and stalls must not hold the run
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const item = await fetchCatalystItem(candidates, { peer: configured, fetch: components.fetch, onProgress, signal: combined });
        const bytes = [...item.files.values()].reduce((sum, file) => sum + file.byteLength, 0);
        log.info("item fetched", { urn: item.urn, entity: item.id, files: item.files.size, bytes });
        return item;
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) {
          log.warn("catalyst timed out", { peer: configured ?? "by network", timeoutMs });
          throw new Error("The catalyst did not answer in time — try again in a moment.");
        }
        throw error;
      }
    }
  };
}

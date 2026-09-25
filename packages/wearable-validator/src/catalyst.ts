/**
 * A published item straight from a catalyst: a URN or a marketplace URL becomes the entity's files and metadata,
 * the same {files, metadata, content} the platform itself validates. Isomorphic: the site and the run server share it.
 */
import { manifest } from "./manifest/index.js";

export const DEFAULT_CATALYST = "https://peer.decentraland.org";
const CONCURRENCY = 6;

export interface CatalystItem {
  urn: string;
  /** The entity id (its content hash): the key an earlier run of the same published item is found under. */
  id: string;
  name: string;
  files: Map<string, Uint8Array>;
  metadata: unknown;
  content: { file: string; hash: string }[];
}

export interface CatalystOptions {
  /** The catalyst to ask; DEFAULT_CATALYST unless the deployment names another. */
  peer?: string;
  /** Injectable so tests never patch the global fetch. */
  fetch?: typeof globalThis.fetch;
  onProgress?: (progress: { text: string; done?: number; total?: number }) => void;
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
}

/** Marketplace and shop item URLs (decentraland.org/marketplace/contracts/0x…/items/0, decentraland.org/shop/item/0x…/0) and urn:decentraland:… references; null when it is none of them. */
export function parseItemReference(raw: string): string[] | null {
  const input = raw.trim();
  if (/^urn:decentraland:[a-z]+:collections-v[12]:[a-z0-9:_-]+$/i.test(input)) return [input.toLowerCase()];
  const url = input.match(/shop\/item\/(0x[0-9a-fA-F]{40})\/(\d+)/) ?? input.match(/marketplace\/contracts\/(0x[0-9a-fA-F]{40})\/items\/(\d+)/);
  if (url) {
    const [, contract, item] = url;
    // the URL does not say which chain: matic first (nearly every item), then ethereum
    return [`urn:decentraland:matic:collections-v2:${contract.toLowerCase()}:${item}`, `urn:decentraland:ethereum:collections-v2:${contract.toLowerCase()}:${item}`];
  }
  // only a marketplace URL gets the hint: a local path such as ~/Downloads/tokens/shirt.zip is not a reference
  if (/^(https?:\/\/)?([a-z0-9-]+\.)*decentraland\.(org|zone)\/.*\/tokens\//i.test(input)) throw new Error("That's an NFT token page — open the item's shop page instead (decentraland.org/shop/item/0x…/N).");
  return null;
}

interface ActiveEntity {
  id: string;
  pointers: string[];
  content: { file: string; hash: string }[];
  metadata: Record<string, unknown> & { name?: string };
}

/** The active entity behind the first candidate that resolves, then its files, within the manifest's input limits. */
export async function fetchCatalystItem(candidates: string[], options: CatalystOptions = {}): Promise<CatalystItem> {
  const peer = (options.peer ?? DEFAULT_CATALYST).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const progress = options.onProgress ?? (() => {});
  const maxFiles = options.maxFiles ?? manifest.fileSize.maxEntries;
  const maxBytes = options.maxBytes ?? manifest.fileSize.maxInputBytes;
  // one controller for every request: the caller's signal trips it, and so does the first failed download
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  const { signal } = controller;
  progress({ text: "Looking up the item on the catalyst" });
  let entity: ActiveEntity | undefined;
  let urn = candidates[0];
  for (const candidate of candidates) {
    const res = await fetchImpl(`${peer}/content/entities/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pointers: [candidate] }),
      signal
    });
    if (!res.ok) throw new Error(`The catalyst answered ${res.status} — try again in a moment.`);
    const entities = (await res.json()) as ActiveEntity[];
    if (entities.length > 0) {
      entity = entities[0];
      urn = candidate;
      break;
    }
  }
  if (!entity) throw new Error("No published item found for that reference — check the URN or URL, or the item may not be published yet.");
  if (!Array.isArray(entity.content) || typeof entity.id !== "string") throw new Error("The catalyst answered an entity without an id or a content list.");
  if (entity.content.length > maxFiles) throw new Error(`The item has ${entity.content.length} files — the maximum is ${maxFiles}.`);

  const files = new Map<string, Uint8Array>();
  const total = entity.content.length;
  let done = 0;
  let bytes = 0;
  const queue = [...entity.content];
  progress({ text: "Downloading the item's files", done, total });
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    try {
      for (;;) {
        const next = queue.shift();
        if (!next || signal.aborted) return;
        if (typeof next.file !== "string" || !/^[a-z0-9]+$/i.test(next.hash ?? "")) throw new Error("The catalyst listed a file without a usable hash.");
        const res = await fetchImpl(`${peer}/content/contents/${next.hash}`, { signal });
        if (!res.ok) throw new Error(`The catalyst answered ${res.status} for "${next.file}".`);
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (bytes + declared > maxBytes) throw new Error(`The item's files exceed the ${Math.round(maxBytes / 1048576)} MB input limit.`);
        const data = new Uint8Array(await res.arrayBuffer());
        // another worker failed while this one downloaded: the caller was already told, so neither count nor report
        if (signal.aborted) return;
        bytes += data.length;
        if (bytes > maxBytes) throw new Error(`The item's files exceed the ${Math.round(maxBytes / 1048576)} MB input limit.`);
        files.set(next.file, data);
        done++;
        progress({ text: "Downloading the item's files", done, total });
      }
    } catch (error) {
      controller.abort();
      throw error;
    }
  });
  await Promise.all(workers);
  return { urn, id: entity.id, name: typeof entity.metadata?.name === "string" && entity.metadata.name ? entity.metadata.name : urn, files, metadata: entity.metadata, content: entity.content };
}

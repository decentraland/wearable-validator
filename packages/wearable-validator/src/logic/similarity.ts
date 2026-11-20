/**
 * Compares a model's fingerprint with a catalog of published items. Shared by every host of the similar-items check: a
 * server that answers lookups, the curation job, a test.
 *
 * Two measurements per pair of models (see fingerprint.ts), each as a share of the upload's own geometry:
 *   position  cells of the upload that the published model also has
 *   shape     triangles of the upload in parts the published model also has (same signature, same proportions)
 * and the same two the other way round, as a share of the published model: how much of it sits inside the upload.
 *
 * Common geometry is removed from both sides first: nobody owns it. commonGeometry() derives it when the catalog is built.
 */
import type { Manifest } from "../manifest/index.js";
import type { Catalog, CatalogAnswer, CatalogMatch, CatalogRequest } from "../types.js";
import { fingerprintVersion, type ModelFingerprint, type PartFingerprint } from "./fingerprint.js";

type Rules = Manifest["similarItems"];

export interface CatalogEntry {
  urn: string;
  name: string;
  /** Creator wallet, lower case. */
  creator: string;
  /** Unix seconds: when the item's collection was created on-chain. */
  publishedAt: number;
  /** The item's public marketplace page. */
  url: string;
  models: ModelFingerprint[];
}

/** Where a published item has its public page: the only place a warning may link to. */
export const MARKETPLACE = "https://decentraland.org/marketplace/";

/**
 * What a warning may say about a published item, or null when it cannot be said safely. The name is written by another
 * creator and ends up in a message shown to the uploader and to curators, on surfaces that may render Markdown or HTML
 * and turn anything that looks like an address into a link. So only letters, digits, spaces and ' & + , - are kept
 * (no dots, slashes, colons, formatting marks, mentions or invisible characters), cut at maxNameLength characters.
 * The link must be a page under the marketplace, the creator a wallet, the date a real one that has passed.
 */
export function presentable<T extends { name: string; creator: string; publishedAt: number; url: string }>(item: T, maxNameLength: number): T | null {
  if (!item || typeof item.creator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item.creator)) return null;
  if (typeof item.publishedAt !== "number" || !Number.isFinite(item.publishedAt) || item.publishedAt <= 0 || item.publishedAt > Date.now() / 1000 + 86_400) return null;
  if (typeof item.url !== "string" || !marketplacePage(item.url)) return null;
  const kept = (typeof item.name === "string" ? item.name : "").replace(/[^\p{L}\p{N} '&+,-]/gu, " ").replace(/ +/g, " ").trim();
  const name = Array.from(kept).slice(0, maxNameLength).join("").trim(); // by code point: never half a character
  return { ...item, name: name || "an unnamed item" };
}

/** A URL that is exactly a page under the marketplace: parsed, so "../" and look-alike hosts do not pass. */
function marketplacePage(url: string): boolean {
  if (!/^[A-Za-z0-9/_.:-]+$/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.href === url && `${parsed.origin}/` === new URL(MARKETPLACE).origin + "/" && parsed.pathname.startsWith(new URL(MARKETPLACE).pathname) && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export interface CommonGeometry {
  cells: number[];
  signatures: string[];
}

export interface CatalogIndex {
  /** fingerprintVersion(rules) of the code that fingerprinted the entries: cells and signatures from another version never match. */
  fingerprint: string;
  entries: CatalogEntry[];
  common: CommonGeometry;
}

/**
 * Geometry nobody owns: everything in the base avatars' models, plus cells and part signatures found in the items of
 * rules.commonCreators or more different creators (the reference body that ships inside many files).
 */
export function commonGeometry(entries: CatalogEntry[], baseModels: ModelFingerprint[], rules: Rules): CommonGeometry {
  const cells = new Set<number>(baseModels.flatMap((model) => model.cells));
  const signatures = new Set<string>(baseModels.flatMap((model) => model.parts.filter((part) => counts(part, rules)).map((part) => part.signature)));
  // signatures are few (one per part); cells are millions, past what a Map holds: flat (cell, creator) arrays, sorted, then runs counted
  const signatureCreators = new Map<string, Set<string>>();
  const creatorIds = new Map<string, number>();
  let pairs = 0;
  for (const entry of entries) for (const model of entry.models) pairs += model.cells.length;
  const cellOf = new Float64Array(pairs);
  const creatorOf = new Uint32Array(pairs);
  let at = 0;
  for (const entry of entries) {
    let creator = creatorIds.get(entry.creator.toLowerCase());
    if (creator === undefined) creatorIds.set(entry.creator.toLowerCase(), (creator = creatorIds.size));
    for (const model of entry.models) {
      for (const cell of model.cells) {
        if (cells.has(cell) || !Number.isFinite(cell)) continue;
        cellOf[at] = cell; creatorOf[at++] = creator;
      }
      for (const part of model.parts) {
        if (!counts(part, rules) || signatures.has(part.signature)) continue;
        let set = signatureCreators.get(part.signature);
        if (!set) signatureCreators.set(part.signature, (set = new Set()));
        set.add(entry.creator.toLowerCase());
      }
    }
  }
  const order = Uint32Array.from({ length: at }, (_, i) => i).sort((a, b) => cellOf[a] - cellOf[b] || creatorOf[a] - creatorOf[b]);
  for (let start = 0; start < at; ) {
    let end = start, distinct = 0;
    for (; end < at && cellOf[order[end]] === cellOf[order[start]]; end++) if (end === start || creatorOf[order[end]] !== creatorOf[order[end - 1]]) distinct++;
    if (distinct >= rules.commonCreators) cells.add(cellOf[order[start]]);
    start = end;
  }
  for (const [signature, creators] of signatureCreators) if (creators.size >= rules.commonCreators) signatures.add(signature);
  return { cells: [...cells].sort((a, b) => a - b), signatures: [...signatures].sort() };
}

/** A part says something about a model only when it is big enough and not a primitive. */
function counts(part: PartFingerprint, rules: Rules): boolean {
  return part.triangles >= rules.minPartTriangles && part.kinds >= rules.minPartKinds;
}

interface Own {
  /** Sorted cells left after removing common ones; empty when fewer than rules.minCells are left. */
  cells: number[];
  /** signature → the parts that count. */
  parts: Map<string, PartFingerprint[]>;
  /** Triangles in those parts; 0 when fewer than rules.minTriangles. */
  triangles: number;
}

/**
 * A fingerprint may come from anyone (a server answering lookups receives them from browsers), so it is read as data:
 * anything that is not the expected shape is left out, cells are deduplicated and must be finite, parts must carry
 * finite numbers, and neither list may be longer than what a model within the work budget can produce.
 */
function own(model: ModelFingerprint, common: { cells: Set<number>; signatures: Set<string> }, rules: Rules): Own {
  const sentCells = Array.isArray(model?.cells) ? model.cells.slice(0, rules.maxElements) : [];
  const sentParts = Array.isArray(model?.parts) ? model.parts : [];
  const cells = [...new Set(sentCells)].filter((cell) => typeof cell === "number" && Number.isFinite(cell) && !common.cells.has(cell)).sort((a, b) => a - b);
  const parts = new Map<string, PartFingerprint[]>();
  // a part that counts has minPartTriangles triangles, so a model within the work budget cannot have more of them than this
  let room = Math.floor(rules.maxElements / (3 * rules.minPartTriangles));
  let triangles = 0;
  for (const part of sentParts) {
    if (room <= 0) break;
    if (!part || typeof part.signature !== "string" || !Array.isArray(part.ratios)) continue;
    if (!Number.isFinite(part.triangles) || !Number.isFinite(part.kinds) || !Number.isFinite(part.ratios[0]) || !Number.isFinite(part.ratios[1])) continue;
    if (!counts(part, rules) || common.signatures.has(part.signature)) continue;
    room--;
    const list = parts.get(part.signature);
    if (list) list.push(part);
    else parts.set(part.signature, [part]);
    triangles += part.triangles;
  }
  const comparable = triangles >= rules.minTriangles;
  return { cells: cells.length >= rules.minCells ? cells : [], parts: comparable ? parts : new Map(), triangles: comparable ? triangles : 0 };
}

/** Triangles of `a` in parts that `b` also has, with the same proportions. */
function sharedTriangles(a: Own, b: Own, tolerance: number): number {
  let shared = 0;
  for (const [signature, parts] of a.parts) {
    const others = b.parts.get(signature);
    if (!others) continue;
    for (const part of parts) {
      if (others.some((other) => Math.abs(part.ratios[0] - other.ratios[0]) <= tolerance && Math.abs(part.ratios[1] - other.ratios[1]) <= tolerance)) shared += part.triangles;
    }
  }
  return shared;
}

export interface CatalogOptions {
  rules: Rules;
}

/**
 * An in-memory catalog. Building it is the slow part (one pass over every model), done once; a lookup reads only what
 * the upload touches and says whose upload it is.
 */
export function createCatalog(index: CatalogIndex, options: CatalogOptions): Catalog {
  const { rules } = options;
  if (index.fingerprint !== fingerprintVersion(rules)) {
    throw new Error(`The catalog index was built with fingerprint version "${index.fingerprint}" and this validator uses "${fingerprintVersion(rules)}": nothing would match. Rebuild the index with this version.`);
  }
  const common = { cells: new Set(index.common.cells), signatures: new Set(index.common.signatures) };
  const models: { entry: number; own: Own }[] = [];
  // an entry a warning could not name safely (see presentable) is not compared at all
  const entries = index.entries.map((entry) => presentable(entry, rules.maxNameLength));
  entries.forEach((entry, e) => {
    if (!entry || !Array.isArray(entry.models)) return;
    for (const model of entry.models) models.push({ entry: e, own: own(model, common, rules) });
  });

  // every (cell, model) pair sorted by cell: two flat arrays instead of a map with millions of keys
  let pairs = 0;
  for (const model of models) pairs += model.own.cells.length;
  const order = new Uint32Array(pairs);
  const cellOf = new Float64Array(pairs);
  const modelOf = new Uint32Array(pairs);
  let at = 0;
  models.forEach((model, m) => {
    for (const cell of model.own.cells) { cellOf[at] = cell; modelOf[at] = m; order[at] = at++; }
  });
  order.sort((a, b) => cellOf[a] - cellOf[b]);
  const sortedCells = Float64Array.from(order, (i) => cellOf[i]);
  const sortedModels = Uint32Array.from(order, (i) => modelOf[i]);
  const firstAt = (cell: number): number => {
    let low = 0, high = sortedCells.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sortedCells[mid] < cell) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const bySignature = new Map<string, number[]>();
  models.forEach((model, m) => {
    for (const signature of model.own.parts.keys()) {
      const list = bySignature.get(signature);
      if (list) list.push(m);
      else bySignature.set(signature, [m]);
    }
  });

  return {
    async match(uploaded: ModelFingerprint[], request: CatalogRequest = {}): Promise<CatalogAnswer> {
      if (typeof request.fingerprint === "string" && request.fingerprint !== index.fingerprint) {
        throw new Error(`The lookup was fingerprinted with version "${request.fingerprint}" and this catalog's index with "${index.fingerprint}": nothing would match. Rebuild the index or update the validator.`);
      }
      const mine = new Set((Array.isArray(request.ownCreators) ? request.ownCreators : []).filter((creator) => typeof creator === "string").map((creator) => creator.toLowerCase()));
      const matches: CatalogMatch[] = [];
      let compared = false;
      (Array.isArray(uploaded) ? uploaded : []).slice(0, rules.maxModels).forEach((fingerprint, modelIndex) => {
        request.signal?.throwIfAborted();
        // per uploaded model: what one model matched must not hide what another did
        const best = new Map<number, CatalogMatch>();
        const upload = own(fingerprint, common, rules);
        if (upload.cells.length === 0 && upload.triangles === 0) return;
        compared = true;
        const sharedCells = new Map<number, number>();
        for (const cell of upload.cells) {
          for (let i = firstAt(cell); i < sortedCells.length && sortedCells[i] === cell; i++) sharedCells.set(sortedModels[i], (sharedCells.get(sortedModels[i]) ?? 0) + 1);
        }
        const candidates = new Set(sharedCells.keys());
        for (const signature of upload.parts.keys()) for (const m of bySignature.get(signature) ?? []) candidates.add(m);
        for (const m of candidates) {
          const entry = entries[models[m].entry]!;
          if (mine.has(entry.creator.toLowerCase())) continue;
          const other = models[m].own;
          const cells = sharedCells.get(m) ?? 0;
          const position = upload.cells.length ? cells / upload.cells.length : 0;
          const shape = upload.triangles ? sharedTriangles(upload, other, rules.ratioTolerance) / upload.triangles : 0;
          const contains = Math.max(other.cells.length ? cells / other.cells.length : 0, other.triangles ? sharedTriangles(other, upload, rules.ratioTolerance) / other.triangles : 0);
          const share = Math.max(position, shape);
          if (share < rules.warnShare && contains < rules.containsShare) continue;
          // an item with several models: its strongest similarity and its strongest containment, whichever model gave each
          const current = best.get(models[m].entry);
          if (current) {
            if (share > current.share) Object.assign(current, { share, position, shape });
            current.contains = Math.max(current.contains, contains);
            continue;
          }
          best.set(models[m].entry, { urn: entry.urn, name: entry.name, creator: entry.creator, publishedAt: entry.publishedAt, url: entry.url, model: modelIndex, share, position, shape, contains });
        }
        matches.push(...best.values());
      });
      return { compared, matches: matches.sort((a, b) => a.publishedAt - b.publishedAt || a.model - b.model) };
    }
  };
}

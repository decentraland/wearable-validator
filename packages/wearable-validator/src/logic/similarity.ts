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
  const cellCreators = new Map<number, Set<string>>();
  const signatureCreators = new Map<string, Set<string>>();
  const note = <K>(map: Map<K, Set<string>>, key: K, creator: string) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(creator);
  };
  for (const entry of entries) {
    for (const model of entry.models) {
      for (const cell of model.cells) if (!cells.has(cell)) note(cellCreators, cell, entry.creator);
      for (const part of model.parts) if (counts(part, rules) && !signatures.has(part.signature)) note(signatureCreators, part.signature, entry.creator);
    }
  }
  for (const [cell, creators] of cellCreators) if (creators.size >= rules.commonCreators) cells.add(cell);
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

function own(model: ModelFingerprint, common: { cells: Set<number>; signatures: Set<string> }, rules: Rules): Own {
  const cells = model.cells.filter((cell) => !common.cells.has(cell));
  const parts = new Map<string, PartFingerprint[]>();
  let triangles = 0;
  for (const part of model.parts) {
    if (!counts(part, rules) || common.signatures.has(part.signature)) continue;
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
  index.entries.forEach((entry, e) => {
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
      const mine = new Set((request.ownCreators ?? []).map((creator) => creator.toLowerCase()));
      const matches: CatalogMatch[] = [];
      let compared = false;
      uploaded.forEach((fingerprint, modelIndex) => {
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
          const entry = index.entries[models[m].entry];
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

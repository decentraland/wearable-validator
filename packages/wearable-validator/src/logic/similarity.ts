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

const YIELD_EVERY = 512; // candidates compared between two turns of the event loop

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

/** A published item's public page, exactly: the only thing a warning may link to. */
const MARKETPLACE_ITEM = /^https:\/\/decentraland\.org\/marketplace\/contracts\/0x[0-9a-fA-F]{40}\/items\/[0-9]+$/;

/**
 * What a warning may say about a published item, or null when it cannot be said safely. The name is written by another
 * creator and ends up in a message shown to the uploader and to curators, on surfaces that may render Markdown or HTML
 * and turn anything that looks like an address into a link. So only letters with their accents and vowel signs,
 * digits, spaces and ' & + , - are kept (no dots, slashes, colons, formatting marks, mentions or invisible
 * characters), at most two marks stacked on a letter, cut at maxNameLength characters. The link must be the item's
 * marketplace page, the creator a wallet, and the date one a collection can have: after earliestPublishedAt and not
 * past now by more than clockSkewSeconds.
 */
export function presentable<T extends { name: string; creator: string; publishedAt: number; url: string }>(item: T, rules: Rules): T | null {
  if (!item || typeof item.creator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item.creator)) return null;
  if (typeof item.publishedAt !== "number" || !Number.isFinite(item.publishedAt)) return null;
  if (item.publishedAt < rules.earliestPublishedAt || item.publishedAt > Date.now() / 1000 + rules.clockSkewSeconds) return null;
  if (typeof item.url !== "string" || !MARKETPLACE_ITEM.test(item.url)) return null;
  const kept = (typeof item.name === "string" ? item.name : "").normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N} '&+,-]/gu, " ").replace(/(\p{M}{2})\p{M}+/gu, "$1").replace(/(^|[^\p{L}\p{M}\p{N}])\p{M}+/gu, "$1").replace(/ +/g, " ").trim();
  const name = Array.from(kept).slice(0, rules.maxNameLength).join("").trim(); // by code point: never half a character
  return { ...item, name: name || "an unnamed item" };
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

/** The parts of one signature that have the same proportions, as one: its proportions and the triangles of all of them. */
interface Shape {
  ratios: [number, number];
  triangles: number;
}

interface Own {
  /** Sorted cells left after removing common ones; empty when fewer than rules.minCells are left. */
  cells: number[];
  /** signature → the shapes that count, largest first. */
  parts: Map<string, Shape[]>;
  /** Triangles in those shapes; 0 when the model's parts that count have fewer than rules.minTriangles in all. */
  triangles: number;
}

const sameRatios = (a: [number, number], b: [number, number], tolerance: number): boolean => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;

/**
 * A fingerprint may come from anyone (a server answering lookups receives them from browsers), so it is read as data:
 * anything that is not the expected shape is left out, cells are deduplicated and must be finite, parts must carry
 * finite numbers, and neither list may be longer than what a model within the work budget can produce.
 *
 * A model can repeat one part hundreds of times (sequins, chain mail, studs). Comparing each copy with each copy would
 * make a lookup as slow as the upload wants, and dropping copies would change the score. So copies are folded: parts of
 * one signature with the same proportions become one shape that carries the triangles of all of them, and a signature
 * keeps its maxPartsPerShape largest shapes, which is what the model is then measured on (a signature with more
 * different proportions than that is compared on its largest ones, on both sides alike). The fold sorts first, so the
 * order of the parts in the file never matters.
 */
function own(model: ModelFingerprint, common: { cells: Set<number>; signatures: Set<string> }, rules: Rules): Own {
  const sentCells = Array.isArray(model?.cells) ? model.cells.slice(0, rules.maxElements) : [];
  const sentParts = Array.isArray(model?.parts) ? model.parts.slice(0, rules.maxElements) : [];
  const cells = [...new Set(sentCells)].filter((cell) => typeof cell === "number" && Number.isFinite(cell) && !common.cells.has(cell)).sort((a, b) => a - b);
  const sent = new Map<string, Shape[]>();
  // a part that counts has minPartTriangles triangles, so a model within the work budget cannot have more of them than this
  let room = Math.floor(rules.maxElements / (3 * rules.minPartTriangles));
  let triangles = 0;
  for (const part of sentParts) {
    if (room <= 0) break;
    if (!part || typeof part.signature !== "string" || !Array.isArray(part.ratios)) continue;
    if (!Number.isFinite(part.triangles) || !Number.isFinite(part.kinds) || !Number.isFinite(part.ratios[0]) || !Number.isFinite(part.ratios[1])) continue;
    if (!counts(part, rules) || common.signatures.has(part.signature)) continue;
    room--;
    const shape: Shape = { ratios: [part.ratios[0], part.ratios[1]], triangles: part.triangles };
    const list = sent.get(part.signature);
    if (list) list.push(shape);
    else sent.set(part.signature, [shape]);
    triangles += part.triangles;
  }
  const comparable = triangles >= rules.minTriangles;
  const parts = new Map<string, Shape[]>();
  let kept = 0;
  if (comparable) {
    for (const [signature, list] of sent) {
      list.sort((a, b) => a.ratios[0] - b.ratios[0] || a.ratios[1] - b.ratios[1] || b.triangles - a.triangles);
      const shapes: Shape[] = [];
      for (const shape of list) {
        const last = shapes[shapes.length - 1];
        if (last && sameRatios(last.ratios, shape.ratios, rules.ratioTolerance)) last.triangles += shape.triangles;
        else shapes.push({ ratios: shape.ratios, triangles: shape.triangles });
      }
      shapes.sort((a, b) => b.triangles - a.triangles || a.ratios[0] - b.ratios[0] || a.ratios[1] - b.ratios[1]);
      parts.set(signature, shapes.slice(0, rules.maxPartsPerShape));
      for (const shape of parts.get(signature)!) kept += shape.triangles;
    }
  }
  return { cells: cells.length >= rules.minCells ? cells : [], parts, triangles: kept };
}

/** Triangles of `a` in shapes that `b` also has: same signature, same proportions. Walks whichever has fewer signatures. */
function sharedTriangles(a: Own, b: Own, tolerance: number): number {
  let shared = 0;
  const [few, many] = a.parts.size <= b.parts.size ? [a.parts, b.parts] : [b.parts, a.parts];
  for (const signature of few.keys()) {
    if (!many.has(signature)) continue;
    const others = b.parts.get(signature)!;
    for (const shape of a.parts.get(signature)!) {
      if (others.some((other) => sameRatios(shape.ratios, other.ratios, tolerance))) shared += shape.triangles;
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
  // every entry must be one a warning can name (see presentable). The index is built by our own code, so one that is not
  // means the build is wrong (seconds written as milliseconds, another link shape), and comparing against what is left
  // would answer "no similar item" for everything.
  const entries = index.entries.map((entry) => presentable(entry, rules));
  const unusable = index.entries.filter((_, e) => !entries[e] || !Array.isArray(index.entries[e].models));
  if (unusable.length > 0) {
    throw new Error(`${unusable.length} of the catalog index's ${index.entries.length} entries cannot be named in a warning (first: ${String(unusable[0]?.urn)}): each needs a creator wallet, a publishedAt in unix seconds and its marketplace item page as url. Rebuild the index.`);
  }
  entries.forEach((entry, e) => {
    if (!entry) return;
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
    async match(uploaded: ModelFingerprint[], sent?: CatalogRequest | null): Promise<CatalogAnswer> {
      const request: CatalogRequest = sent ?? {}; // a host may hand over parsed JSON, where "nothing" is null
      if (typeof request.fingerprint === "string" && request.fingerprint !== index.fingerprint) {
        throw new Error(`The lookup was fingerprinted with version "${request.fingerprint}" and this catalog's index with "${index.fingerprint}": nothing would match. Rebuild the index or update the validator.`);
      }
      const mine = new Set((Array.isArray(request.ownCreators) ? request.ownCreators : []).filter((creator) => typeof creator === "string").map((creator) => creator.toLowerCase()));
      const signal = request.signal instanceof AbortSignal ? request.signal : undefined; // parsed JSON can carry anything under "signal"
      const matches: CatalogMatch[] = [];
      let compared = false;
      let sinceYield = 0;
      const models_ = (Array.isArray(uploaded) ? uploaded : []).slice(0, rules.maxModels);
      for (let modelIndex = 0; modelIndex < models_.length; modelIndex++) {
        signal?.throwIfAborted();
        // per uploaded model: what one model matched must not hide what another did
        const best = new Map<number, CatalogMatch>();
        const upload = own(models_[modelIndex], common, rules);
        if (upload.cells.length === 0 && upload.triangles === 0) continue;
        compared = true;
        const sharedCells = new Map<number, number>();
        for (const cell of upload.cells) {
          for (let i = firstAt(cell); i < sortedCells.length && sortedCells[i] === cell; i++) sharedCells.set(sortedModels[i], (sharedCells.get(sortedModels[i]) ?? 0) + 1);
        }
        const sameShape = new Set<number>();
        for (const signature of upload.parts.keys()) for (const m of bySignature.get(signature) ?? []) sameShape.add(m);
        for (const m of new Set([...sharedCells.keys(), ...sameShape])) {
          // a long lookup lets the host's timers run, so a timeout can stop it
          if (++sinceYield >= YIELD_EVERY) {
            sinceYield = 0;
            await new Promise((resolve) => setTimeout(resolve, 0));
            signal?.throwIfAborted();
          }
          const other = models[m].own;
          const cells = sharedCells.get(m) ?? 0;
          const position = upload.cells.length ? cells / upload.cells.length : 0;
          const inside = other.cells.length ? cells / other.cells.length : 0;
          // shapes are compared only with a model that has one of the upload's signatures: a model reached through a stray
          // shared cell costs this arithmetic and nothing more
          const shaped = sameShape.has(m);
          if (!shaped && position < rules.warnShare && inside < rules.containsShare) continue;
          const entry = entries[models[m].entry]!;
          if (mine.has(entry.creator.toLowerCase())) continue;
          const shape = shaped && upload.triangles ? sharedTriangles(upload, other, rules.ratioTolerance) / upload.triangles : 0;
          const contains = Math.max(inside, shaped && other.triangles ? sharedTriangles(other, upload, rules.ratioTolerance) / other.triangles : 0);
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
        // the earliest are the ones a warning names and a template is counted from; an answer is never the whole catalog
        for (const match of [...best.values()].sort((x, y) => x.publishedAt - y.publishedAt).slice(0, rules.maxMatches)) matches.push(match);
      }
      return { compared, matches: matches.sort((a, b) => a.publishedAt - b.publishedAt || a.model - b.model) };
    }
  };
}

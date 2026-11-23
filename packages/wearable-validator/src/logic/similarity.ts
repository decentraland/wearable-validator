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

const YIELD_EVERY = 1 << 16; // units of lookup work between two turns of the event loop

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

/**
 * Proportions on a grid. Each of a part's two ratios is snapped to steps of ratioTolerance / ratioSteps, and two parts
 * have the same proportions when their snapped ratios are at most ratioSteps steps apart on both axes. So parts within
 * (1 - 1/ratioSteps) of the tolerance always agree and parts beyond (1 + 1/ratioSteps) of it never do, whatever order
 * the file lists them in and whatever noise a float carries in its last digits.
 */
const RATIO_SPAN = 1 << 20; // a snapped ratio stays far below this (ratios are 0 to 1), so two fit one number
const ratioCell = (ratios: [number, number], rules: Rules): number => {
  const step = rules.ratioTolerance / rules.ratioSteps;
  const snap = (ratio: number) => Math.min(RATIO_SPAN - 1, Math.max(0, Math.round(ratio / step)));
  return snap(ratios[0]) * RATIO_SPAN + snap(ratios[1]);
};

interface Own {
  /** Sorted cells left after removing common ones; empty when fewer than rules.minCells are left. */
  cells: number[];
  /** signature → proportions on the grid → triangles of every part that sits there. Copies of a part fold into one entry and keep their weight. */
  parts: Map<string, Map<number, number>>;
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
  const sentParts = Array.isArray(model?.parts) ? model.parts.slice(0, rules.maxElements) : [];
  const cells = [...new Set(sentCells)].filter((cell) => typeof cell === "number" && Number.isFinite(cell) && !common.cells.has(cell)).sort((a, b) => a - b);
  const parts = new Map<string, Map<number, number>>();
  // a part that counts has minPartTriangles triangles, so a model within the work budget cannot have more of them than this
  let room = Math.floor(rules.maxElements / (3 * rules.minPartTriangles));
  let triangles = 0;
  for (const part of sentParts) {
    if (room <= 0) break;
    if (!part || typeof part.signature !== "string" || !Array.isArray(part.ratios)) continue;
    if (!Number.isFinite(part.triangles) || !Number.isFinite(part.kinds) || !Number.isFinite(part.ratios[0]) || !Number.isFinite(part.ratios[1])) continue;
    if (!counts(part, rules) || common.signatures.has(part.signature)) continue;
    room--;
    let shapes = parts.get(part.signature);
    if (!shapes) parts.set(part.signature, (shapes = new Map()));
    const cell = ratioCell([part.ratios[0], part.ratios[1]], rules);
    shapes.set(cell, (shapes.get(cell) ?? 0) + part.triangles);
    triangles += part.triangles;
  }
  const comparable = triangles >= rules.minTriangles;
  return { cells: cells.length >= rules.minCells ? cells : [], parts: comparable ? parts : new Map(), triangles: comparable ? triangles : 0 };
}

/**
 * What a lookup may spend comparing shapes: one unit per proportion cell it looks at. Past rules.maxLookupWork it stops
 * with an error. Only work an upload can inflate is on the budget (many proportions of one signature); walking the
 * catalog's own postings is not, and only counts toward the next pause.
 */
interface Work {
  left: number;
  sinceYield: number;
}

function spend(work: Work, units: number): void {
  work.left -= units;
  work.sinceYield += units;
  if (work.left < 0) throw new Error("This model takes too much work to compare with published items: it repeats one part in too many different proportions.");
}

/** Triangles of `a` in parts that `b` also has: same signature, same proportions (see ratioCell). Walks whichever has fewer signatures. */
function sharedTriangles(a: Own, b: Own, rules: Rules, work: Work): number {
  let shared = 0;
  const [few, many] = a.parts.size <= b.parts.size ? [a.parts, b.parts] : [b.parts, a.parts];
  const reach = rules.ratioSteps;
  for (const signature of few.keys()) {
    if (!many.has(signature)) continue;
    const others = b.parts.get(signature)!;
    for (const [cell, triangles] of a.parts.get(signature)!) {
      if (others.has(cell)) { spend(work, 1); shared += triangles; continue; } // the usual case: a copy has the same proportions
      spend(work, (2 * reach + 1) ** 2);
      const first = Math.floor(cell / RATIO_SPAN), second = cell % RATIO_SPAN;
      search: for (let i = first - reach; i <= first + reach; i++) {
        for (let j = second - reach; j <= second + reach; j++) {
          if (i >= 0 && j >= 0 && j < RATIO_SPAN && others.has(i * RATIO_SPAN + j)) { shared += triangles; break search; }
        }
      }
    }
  }
  return shared;
}

/** The earliest of each creator first, then the earliest of what is left, up to `limit`: a template is counted by creators, so one prolific creator must not fill the answer. */
function earliest(matches: CatalogMatch[], limit: number): CatalogMatch[] {
  const byDate = [...matches].sort((a, b) => a.publishedAt - b.publishedAt);
  const creators = new Set<string>();
  const first: CatalogMatch[] = [], rest: CatalogMatch[] = [];
  for (const match of byDate) {
    const creator = match.creator.toLowerCase();
    if (creators.has(creator)) rest.push(match);
    else { creators.add(creator); first.push(match); }
  }
  return [...first, ...rest].slice(0, limit);
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
      // anything with throwIfAborted is a signal (another realm's, a polyfill's); parsed JSON cannot carry a function
      const signal = typeof (request.signal as AbortSignal | undefined)?.throwIfAborted === "function" ? request.signal : undefined;
      const work: Work = { left: rules.maxLookupWork, sinceYield: 0 };
      // a long lookup lets the host's timers run, so a timeout can stop it
      const breathe = async (): Promise<void> => {
        if (work.sinceYield < YIELD_EVERY) return;
        work.sinceYield = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      };
      const matches: CatalogMatch[] = [];
      let compared = false;
      const uploads = (Array.isArray(uploaded) ? uploaded : []).slice(0, rules.maxModels);
      for (let modelIndex = 0; modelIndex < uploads.length; modelIndex++) {
        signal?.throwIfAborted();
        // per uploaded model: what one model matched must not hide what another did
        const best = new Map<number, CatalogMatch>();
        const upload = own(uploads[modelIndex], common, rules);
        if (upload.cells.length === 0 && upload.triangles === 0) continue;
        compared = true;
        const sharedCells = new Map<number, number>();
        for (const cell of upload.cells) {
          let i = firstAt(cell);
          const from = i;
          for (; i < sortedCells.length && sortedCells[i] === cell; i++) sharedCells.set(sortedModels[i], (sharedCells.get(sortedModels[i]) ?? 0) + 1);
          // not on the budget: this pass is bounded by the upload's cells times the models that hold each, which grows with
          // the catalog (a template with hundreds of copies, a creator's own recolours), not with anything the upload does
          work.sinceYield += 1 + i - from;
          await breathe();
        }
        const sameShape = new Set<number>();
        for (const signature of upload.parts.keys()) for (const m of bySignature.get(signature) ?? []) sameShape.add(m);
        for (const m of new Set([...sharedCells.keys(), ...sameShape])) {
          work.sinceYield++;
          await breathe();
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
          const shape = shaped && upload.triangles ? sharedTriangles(upload, other, rules, work) / upload.triangles : 0;
          const contains = Math.max(inside, shaped && other.triangles ? sharedTriangles(other, upload, rules, work) / other.triangles : 0);
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
        // an answer is never the whole catalog. Similar items and items only contained are capped apart, so neither crowds out the other.
        const found = [...best.values()];
        matches.push(...earliest(found.filter((match) => match.share >= rules.warnShare), rules.maxMatches));
        matches.push(...earliest(found.filter((match) => match.share < rules.warnShare), rules.maxMatches));
      }
      return { compared, matches: matches.sort((a, b) => a.publishedAt - b.publishedAt || a.model - b.model) };
    }
  };
}

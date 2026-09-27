import JSZip from "jszip";
import { isGlb, parseGlb } from "./logic/gltf.js";
import { manifest } from "./manifest/index.js";
import type { CheckContext, Finding, Input, InputKind, ItemType, MetadataMode, NormalizedItem, Options, ParsedModel } from "./types.js";
import { WEARABLES } from "./checks/docs.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const MANIFEST_NAMES = ["wearable.json", "emote.json"];

export interface LoadedInput {
  ctx?: CheckContext;
  /** Fatal input problems (unrecognized bytes, oversized input) — returned as findings, never thrown. */
  fatal?: Finding[];
}

/** A bound of the manifest's fileSize block was crossed: the caller shows these; any other failure is a damaged or foreign file. */
export class InputLimitError extends Error {}

export const inputTooLarge = (bytes: number, maxBytes = manifest.fileSize.maxInputBytes): string => `Input is ${mb(bytes)} MB — the maximum accepted input is ${mb(maxBytes)} MB.`;

function fileFormatFinding(message: string, data?: Finding["data"]): Finding {
  return { check: "file-format", group: "files", severity: "error", message, data, rule: "S-01", docs: `${WEARABLES}#building-3d-models-for-wearables` };
}

export async function loadInput(input: Input, options: Options): Promise<LoadedInput> {
  const maxBytes = options.maxInputBytes ?? manifest.fileSize.maxInputBytes;

  if (input instanceof Uint8Array) {
    if (input.length > maxBytes) {
      return { fatal: [fileFormatFinding(inputTooLarge(input.length, maxBytes), { measuredBytes: input.length })] };
    }
    if (input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04) {
      return loadZip(input, options);
    }
    if (isGlb(input)) return loadBareGlb(input, options);
    if (PNG_SIGNATURE.every((b, i) => input[i] === b)) {
      if (options.category && manifest.facialCategories.includes(options.category)) {
        return loadPngSet(input, options);
      }
      return { fatal: [fileFormatFinding("PNG input is only valid for facial features — pass a category of eyebrows, eyes or mouth.")] };
    }
    return { fatal: [fileFormatFinding("Unrecognized input: expected a .zip, a .glb, or a facial-feature PNG (with a category hint).")] };
  }

  return loadObjectInput(input, options);
}

async function loadZip(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  let unpacked: UnpackedZip;
  try {
    unpacked = await unpackZip(bytes, options.maxInputBytes);
  } catch (error) {
    // a crossed limit is the caller's to refuse; a zip that will not open is a finding, like any other unreadable input
    if (error instanceof InputLimitError || !(error instanceof Error)) throw error;
    return { fatal: [fileFormatFinding(error.message)] };
  }
  const { files, emptyFiles } = unpacked;
  if (files.has("asset.json")) {
    return { fatal: [fileFormatFinding("Legacy asset.json zips are not supported — export the item from the Builder (wearable.json / emote.json) instead.")] };
  }
  return buildContext({ files, emptyFiles, inputKind: "zip", totalBytes: bytes.length, options });
}

export interface UnpackedZip {
  files: Map<string, Uint8Array>;
  emptyFiles: string[];
}

/** Bounded extraction for validation, metadata display and previews; throws on unsafe or malformed archives. */
export async function unpackZip(bytes: Uint8Array, maxInputBytes = manifest.fileSize.maxInputBytes): Promise<UnpackedZip> {
  if (bytes.length > maxInputBytes) throw new InputLimitError(inputTooLarge(bytes.length, maxInputBytes));
  const { maxEntries } = manifest.fileSize;
  // the end-of-central-directory record says how many entries JSZip would parse: a zip that declares too many never gets parsed
  const declaredEntries = declaredEntryCount(bytes);
  if (declaredEntries !== undefined && declaredEntries > maxEntries) throw tooManyEntries(declaredEntries);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    // JSZip's own sentence ("Can't find end of central directory…") is for its users, not for creators
    throw new Error("The zip cannot be opened — it is damaged or not really a zip. Export the item again from the Builder.");
  }
  const all = Object.values(zip.files);
  if (all.length > maxEntries) throw tooManyEntries(all.length);
  const entries = all.filter((entry) => !entry.dir);
  checkDeclaredSizes(entries);
  const { maxUncompressedBytes, maxEntryUncompressedBytes } = manifest.fileSize;
  const files = new Map<string, Uint8Array>();
  const emptyFiles: string[] = [];
  let inflated = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.name);
    assertItemPath(path);
    const base = path.split("/").pop() ?? path;
    if (base.startsWith(".")) continue;
    // headers can lie: the real bytes count against both caps as they come out of the inflater
    const data = await inflateEntry(
      entry,
      Math.min(maxEntryUncompressedBytes, maxUncompressedBytes - inflated),
      `"${path}" unpacks to more than the zip may hold — no file may unpack to more than ${mb(maxEntryUncompressedBytes)} MB and the whole zip to more than ${mb(maxUncompressedBytes)} MB.`
    );
    inflated += data.length;
    if (data.length === 0) {
      emptyFiles.push(path);
      continue;
    }
    if (files.has(path)) throw new Error(`duplicate file path after normalization: "${path}"`);
    files.set(path, data);
  }
  return { files, emptyFiles };
}

const tooManyEntries = (count: number): Error =>
  new InputLimitError(`The zip holds ${count} entries — the maximum is ${manifest.fileSize.maxEntries}. Remove files and folders that are not part of the item.`);

const EOCD = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
// the EOCD record is 22 bytes plus a comment of at most 65535
const EOCD_SEARCH_BYTES = 22 + 65535;

/** Entries the archive declares (files and folders), from the end-of-central-directory record; undefined when there is none to read. */
export function declaredEntryCount(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stop = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) !== EOCD) continue;
    const count = view.getUint16(i + 10, true);
    if (count !== 0xffff) return count;
    if (i < 20 || view.getUint32(i - 20, true) !== ZIP64_EOCD_LOCATOR) return count;
    const record = Number(view.getBigUint64(i - 12, true));
    if (record + 40 > bytes.length || view.getUint32(record, true) !== ZIP64_EOCD) return count;
    return Number(view.getBigUint64(record + 32, true));
  }
  return undefined;
}

/** The central directory is read before any entry is inflated: too many declared bytes never reach the inflater. */
function checkDeclaredSizes(entries: JSZip.JSZipObject[]): void {
  const { maxUncompressedBytes, maxEntryUncompressedBytes } = manifest.fileSize;
  let declared = 0;
  for (const entry of entries) {
    const size = declaredSize(entry);
    if (size === undefined) continue;
    if (size > maxEntryUncompressedBytes) {
      throw new InputLimitError(`"${normalizePath(entry.name)}" unpacks to ${mb(size)} MB — no file in the zip may unpack to more than ${mb(maxEntryUncompressedBytes)} MB.`);
    }
    declared += size;
  }
  if (declared > maxUncompressedBytes) {
    throw new InputLimitError(`The zip unpacks to ${mb(declared)} MB — the maximum is ${mb(maxUncompressedBytes)} MB. Remove files that are not part of the item.`);
  }
}

/** The uncompressed size the local header declares — JSZip keeps it on the private `_data` of entries read by loadAsync. */
function declaredSize(entry: JSZip.JSZipObject): number | undefined {
  const raw: unknown = entry;
  if (typeof raw !== "object" || raw === null || !("_data" in raw)) return undefined;
  const data = raw._data;
  if (typeof data !== "object" || data === null || !("uncompressedSize" in data)) return undefined;
  return typeof data.uncompressedSize === "number" && Number.isFinite(data.uncompressedSize) ? data.uncompressedSize : undefined;
}

interface StreamingEntry {
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
}

function isStreamingEntry(entry: unknown): entry is StreamingEntry {
  return typeof entry === "object" && entry !== null && "internalStream" in entry && typeof entry.internalStream === "function";
}

/** Inflates one entry chunk by chunk and stops the inflater the moment the running total passes `budget`, rejecting with `reason`. */
export async function inflateEntry(entry: JSZip.JSZipObject, budget: number, reason: string): Promise<Uint8Array> {
  const overBudget = () => new InputLimitError(reason);
  if (!isStreamingEntry(entry)) {
    const data = await entry.async("uint8array");
    if (data.length > budget) throw overBudget();
    return data;
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = entry.internalStream("uint8array");
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > budget) {
        chunks.length = 0;
        stream.pause();
        reject(overBudget());
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    stream.resume();
  });
}

async function loadBareGlb(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>([["model.glb", bytes]]);
  return buildContext({ files, emptyFiles: [], inputKind: "glb", totalBytes: bytes.length, options });
}

async function loadPngSet(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>([["main.png", bytes]]);
  return buildContext({ files, emptyFiles: [], inputKind: "png-set", totalBytes: bytes.length, options });
}

async function loadObjectInput(
  input: { files: Map<string, Uint8Array>; metadata?: unknown; content?: { file: string; hash: string }[] },
  options: Options
): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const [rawPath, data] of input.files) {
    const path = normalizePath(rawPath);
    if (files.has(path)) throw new Error(`duplicate file path after normalization: "${path}"`);
    files.set(path, data);
    totalBytes += data.length;
  }
  const maxBytes = options.maxInputBytes ?? manifest.fileSize.maxInputBytes;
  if (totalBytes > maxBytes) {
    return { fatal: [fileFormatFinding(`Input is ${mb(totalBytes)} MB — the maximum accepted input is ${mb(maxBytes)} MB.`)] };
  }
  return buildContext({ files, emptyFiles: [], inputKind: "object", totalBytes, options, entityMetadata: input.metadata, content: input.content });
}

interface BuildArgs {
  files: Map<string, Uint8Array>;
  emptyFiles: string[];
  inputKind: InputKind;
  totalBytes: number;
  options: Options;
  entityMetadata?: unknown;
  content?: { file: string; hash: string }[];
}

async function buildContext(args: BuildArgs): Promise<LoadedInput> {
  const { files, inputKind, options } = args;

  let metadataMode: MetadataMode = "none";
  let item: NormalizedItem = {};
  const embedded = readEmbeddedManifest(files);

  if (args.entityMetadata !== undefined) {
    metadataMode = "entity";
    item = normalizeEntityMetadata(args.entityMetadata);
  } else if (embedded) {
    metadataMode = "builder";
    item = embedded.item;
  }
  // Explicit metadata beats the embedded manifest; divergence is surfaced by the `metadata` check.

  const itemTypeFromMetadata: ItemType | undefined =
    metadataMode !== "none" ? (item.emoteData || (metadataMode === "builder" && embedded?.kind === "emote") ? "emote" : "wearable") : undefined;

  // Parse every model (per representation, deduped by mainFile).
  const models: ParsedModel[] = [];
  let parseError: string | undefined;
  const modelPaths = resolveModelPaths(files, item);
  for (const { mainFile, bodyShapes } of modelPaths) {
    const bytes = files.get(mainFile);
    if (!bytes) continue; // representations (S-04) reports the missing file
    if (!isGlb(bytes)) {
      parseError = `"${mainFile}" is not a GLB (.gltf with external buffers is not supported — export as .glb)`;
      continue;
    }
    try {
      const { doc, json } = await parseGlb(bytes);
      models.push({ mainFile, bodyShapes, bytes, doc, json });
    } catch (err) {
      parseError = `"${mainFile}" failed to parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const itemType: ItemType =
    options.itemType ??
    itemTypeFromMetadata ??
    (models.some((m) => m.doc.getRoot().listAnimations().length > 0) ? "emote" : "wearable");

  const category = item.category ?? options.category;

  const ctx: CheckContext = {
    files,
    content: args.content,
    entityMetadata: args.entityMetadata,
    item,
    itemType,
    category,
    metadataMode,
    inputKind,
    totalBytes: args.totalBytes,
    models,
    parseError,
    manifest,
    emptyFiles: args.emptyFiles,
    embeddedManifest: embedded?.item
  };
  return { ctx };
}

function resolveModelPaths(files: Map<string, Uint8Array>, item: NormalizedItem): { mainFile: string; bodyShapes: string[] }[] {
  if (item.representations && item.representations.length > 0) {
    const seen = new Map<string, string[]>();
    for (const rep of item.representations) {
      const existing = seen.get(rep.mainFile);
      if (existing) existing.push(...rep.bodyShapes);
      else seen.set(rep.mainFile, [...rep.bodyShapes]);
    }
    return [...seen.entries()].map(([mainFile, bodyShapes]) => ({ mainFile, bodyShapes }));
  }
  // Manifest-less: first model path becomes the main model, worn by both shapes.
  const modelPath = [...files.keys()].find((p) => p.endsWith(".glb") || p.endsWith(".gltf"));
  return modelPath ? [{ mainFile: modelPath, bodyShapes: ["male", "female"] }] : [];
}

function readEmbeddedManifest(files: Map<string, Uint8Array>): { kind: "wearable" | "emote"; item: NormalizedItem } | undefined {
  for (const name of MANIFEST_NAMES) {
    const bytes = files.get(name);
    if (!bytes) continue;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const kind = name === "emote.json" ? "emote" : "wearable";
      return { kind, item: normalizeBuilderManifest(parsed, kind) };
    } catch {
      return { kind: name === "emote.json" ? "emote" : "wearable", item: {} }; // `metadata` check reports unparseable manifests
    }
  }
  return undefined;
}

/** Builder wearable.json / emote.json — fields live either flat or under `data`. Tolerant by design. */
function normalizeBuilderManifest(raw: Record<string, unknown>, kind: "wearable" | "emote"): NormalizedItem {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const pick = <T>(key: string): T | undefined => (data[key] ?? raw[key]) as T | undefined;
  const item: NormalizedItem = {
    name: raw.name as string | undefined,
    description: raw.description as string | undefined,
    rarity: raw.rarity as string | undefined,
    category: pick<string>("category"),
    tags: pick<string[]>("tags"),
    hides: pick<string[]>("hides"),
    replaces: pick<string[]>("replaces"),
    representations: pick<NormalizedItem["representations"]>("representations"),
    requiredPermissions: pick<string[]>("requiredPermissions"),
    springBones: pick<unknown>("springBones")
  };
  if (kind === "emote") {
    item.emoteData = { category: pick<string>("category"), loop: (pick<boolean>("loop") ?? (raw.play_mode === "loop")) || undefined };
    item.loop = item.emoteData.loop;
  }
  return item;
}

/** @dcl/schemas entity metadata (Wearable | Emote). */
function normalizeEntityMetadata(raw: unknown): NormalizedItem {
  const meta = record(raw);
  const hasEmote = "emoteDataADR74" in meta;
  const emoteData = record(meta.emoteDataADR74);
  const data = hasEmote ? emoteData : record(meta.data);
  const reps = Array.isArray(data.representations) ? data.representations.map((value) => {
    const rep = record(value);
    return {
      bodyShapes: strings(rep.bodyShapes) ?? [],
      mainFile: string(rep.mainFile) ?? "",
      contents: strings(rep.contents) ?? [],
      overrideHides: strings(rep.overrideHides),
      overrideReplaces: strings(rep.overrideReplaces)
    };
  }) : undefined;
  const loop = typeof emoteData.loop === "boolean" ? emoteData.loop : undefined;
  return {
    name: string(meta.name),
    description: string(meta.description),
    rarity: string(meta.rarity),
    category: string(data.category),
    tags: strings(data.tags),
    hides: strings(data.hides),
    replaces: strings(data.replaces),
    representations: reps,
    thumbnailPath: string(meta.thumbnail),
    rarityImagePath: string(meta.image),
    springBones: data.springBones,
    requiredPermissions: strings(data.requiredPermissions),
    emoteData: hasEmote ? {
      category: string(emoteData.category), loop,
      outcomes: Array.isArray(emoteData.outcomes) ? emoteData.outcomes : undefined,
      startAnimation: emoteData.startAnimation
    } : undefined,
    loop
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** A file name that stays inside the item wherever it is written: no absolute path, drive, `..` or empty segment. */
export function assertItemPath(path: string): void {
  const segments = path.split("/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`"${path}" is not a file inside the item: it points outside it or has an empty folder name. Rename it and export the item again.`);
  }
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

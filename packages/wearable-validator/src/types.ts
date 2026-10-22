import type { Document } from "@gltf-transform/core";
import type { Manifest } from "./manifest/index.js";

export type Group = "files" | "model" | "emote" | "rendering" | "content" | "code";
export type Severity = "error" | "warning";
export type CheckStatus = "passed" | "failed" | "warning" | "skipped" | "errored";
export type ItemType = "wearable" | "emote";

export interface Finding {
  check: string;
  group: Group;
  severity: Severity;
  /** Creator-facing: what's wrong + how to fix. */
  message: string;
  /** Mesh / file / bone / representation the finding points at. */
  where?: string;
  measured?: number | string;
  limit?: number | string;
  data?: Record<string, string | number | boolean | string[]>;
  /** Rule-book ID, e.g. 'M-01'. */
  rule: string;
  docs: string;
  /** Visual rules: the capture ids (PNG file stems) the finding points at. */
  evidence?: { captureId: string }[];
}

/** What a visual check hands back when it cannot return plain findings: coverage says whether the evidence was complete. */
export interface CheckExecution {
  status: CheckStatus;
  coverage: "complete" | "missing";
  findings: Finding[];
  /** Creator-facing reason for skipped/errored. */
  reason?: string;
  measured?: string;
  review?: ReviewMetadata;
}

export interface CheckResult {
  check: string;
  group: Group;
  status: CheckStatus;
  /** What the item actually measures for this check (e.g. "1,240 tris"). */
  measured?: string;
  skipReason?: string;
  durationMs?: number;
  /** "missing" = the check could not see everything it needed; never counts as a pass. */
  coverage: "complete" | "missing";
  /** Model/prompt/usage provenance for AI-backed checks. */
  review?: ReviewMetadata;
}

export interface Result {
  /** Computed over core groups only. null = partial run or bare GLB — never infer pass from it. */
  passed: boolean | null;
  checks: CheckResult[];
  findings: Finding[];
  /** Every render the run used (supplied or fresh) — pass them back as Options.captures to skip re-rendering. */
  captures: CaptureRecord[];
  summary: { errors: number; warnings: number; checked: number; skipped: number };
}

export interface Options {
  groups?: Group[];
  /** Wins over groups. Rule IDs ('M-01') accepted as aliases. */
  checks?: string[];
  /** Hint for bare GLBs — unlocks category-dependent limits. */
  category?: string;
  /** Overrides clip-presence inference on bare GLBs. */
  itemType?: ItemType;
  /** Default 260 MB. Exceeding it yields an error finding, never a crash. */
  maxInputBytes?: number;
  /** Previously rendered views; only stale or missing ones are rendered again. */
  captures?: CaptureRecord[];
  /** Renderer/reviewer adapters for the rendering group — see /rendering and /ai. */
  services?: Services;
  signal?: AbortSignal;
  /** Called as each check starts and finishes — for live UIs; never affects the result. When set, validate() yields to the event loop after every check so the page can paint. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Check-level progress. Captures and model answers are reported by the adapters that produce them. */
export type ProgressEvent =
  | { type: "check-started"; check: string; group: Group }
  | { type: "check-finished"; result: CheckResult; findings: Finding[] };

export type Input =
  | Uint8Array
  | {
      files: Map<string, Uint8Array>;
      metadata?: unknown;
      content?: { file: string; hash: string }[];
    };

/** Normalized view of item metadata — from @dcl/schemas entity metadata OR a builder zip manifest. */
export interface NormalizedItem {
  name?: string;
  description?: string;
  category?: string;
  rarity?: string;
  tags?: string[];
  hides?: string[];
  replaces?: string[];
  representations?: { bodyShapes: string[]; mainFile: string; contents: string[]; overrideHides?: string[]; overrideReplaces?: string[] }[];
  thumbnailPath?: string;
  rarityImagePath?: string;
  loop?: boolean;
  springBones?: unknown;
  emoteData?: { category?: string; loop?: boolean; outcomes?: unknown[]; startAnimation?: unknown };
  requiredPermissions?: string[];
}

export interface ParsedModel {
  /** Representation main file path, or the single input file for bare GLBs. */
  mainFile: string;
  bodyShapes: string[];
  bytes: Uint8Array;
  doc: Document;
  /** Raw glTF JSON chunk (for things gltf-transform abstracts away, e.g. cameras/extensions). */
  json: Record<string, unknown>;
}

export type MetadataMode = "entity" | "builder" | "none";
export type InputKind = "zip" | "glb" | "object" | "png-set";

export interface CheckContext {
  files: Map<string, Uint8Array>;
  content?: { file: string; hash: string }[];
  item: NormalizedItem;
  itemType: ItemType;
  /** Resolved category (metadata or hint) — undefined for a hint-less bare GLB. */
  category?: string;
  metadataMode: MetadataMode;
  entityMetadata?: unknown;
  inputKind: InputKind;
  totalBytes: number;
  /** One entry per representation; bare GLB = one entry. Empty when the GLB failed to parse. */
  models: ParsedModel[];
  /** Set when GLB parsing failed — model/emote checks skip with this reason. */
  parseError?: string;
  manifest: Manifest;
  /** 0-byte zip entries stripped at load — smart-wearable's stray-file rule reports them. */
  emptyFiles: string[];
  /** The zip's own wearable.json/emote.json view — the `metadata` check reports divergence from explicit metadata. */
  embeddedManifest?: NormalizedItem;
  captures?: CaptureRecord[];
  services?: Services;
  signal?: AbortSignal;
  /** How many rendering-group rules this run executes — with more than one, the first render takes the whole recipe. */
  renderingRules?: number;
}

/**
 * One check = one folder under src/checks/<group>/<name>/ holding this object and its tests.
 * The creator-facing text lives on the definition so no surface (CLI, website, docs) can drift from the code.
 */
export interface CheckDefinition {
  /** Readable API name, e.g. "triangle-count" — the rule ID is metadata, never the API. */
  name: string;
  group: Group;
  /** Rule-book ID, e.g. "M-01". */
  rule: string;
  title: string;
  /** One-line "what it verifies" — docs pages generate from this. */
  describe: string;
  /** Plain words for creators: what the rule is and why it exists. */
  explanation: string;
  /** Concrete steps to fix a failure (tool names, menu paths, numbers). */
  fix: string;
  /** How the check measures — for the website's expanded panel and the generated docs. */
  details: string;
  /** Creator-docs page with the exact section anchor. */
  docs: string;
  /** Emits one warning finding when the category is unknown (bare GLB without hint). */
  categoryDependent?: boolean;
  /** Return a reason string to mark the check not-applicable (absent from results). */
  appliesTo?: (ctx: CheckContext) => true | string;
  /** What the item actually measures for this check, e.g. "1,240 tris" — display only, never affects the run. */
  measure?: (ctx: CheckContext) => string | undefined;
  /** AI-backed checks carry their versioned prompt here so it is registry metadata, not hidden code. */
  prompt?: Prompt;
  run: (ctx: CheckContext) => Finding[] | CheckExecution | Promise<Finding[] | CheckExecution>;
}

export type CheckMeta = Pick<CheckDefinition, "name" | "group" | "rule" | "docs">;

/** Every finding carries its check's identity and docs link; checks build theirs through this. */
export function finding(meta: CheckMeta, severity: Severity, message: string, extra: Partial<Finding> = {}): Finding {
  return { check: meta.name, group: meta.group, rule: meta.rule, docs: meta.docs, severity, message, ...extra };
}

// Visual validation — see docs/visual-validation.md. Types only; adapters live in /rendering and /ai.

export interface CaptureRequest {
  /** Human id, doubles as the PNG file stem and the "Image ID" the model is told: BaseMale-avatar-090. */
  id: string;
  /** Reuse identity: digest of every field below plus the scene settings (manifest.rendering). */
  key: string;
  inputDigest: string;
  rendererBuild: string;
  recipeVersion: number;
  bodyShape: string;
  mainFile: string;
  /** avatar = worn on the body shape; wearable = the item alone. */
  view: "avatar" | "wearable";
  azimuthDegrees: number;
  /** Wearables: the previewer's avatar clip to pose with (idle, walk, run, jump, …); default is the manifest rest pose. */
  pose?: string;
  /** Fraction of the clip to scrub to — the emote's own clip, or the wearable's pose clip. */
  timeFraction?: number;
  /** Avatar skin colour (hex, no #) for this view; unset = the manifest scene skin. Chroma green makes skin through cloth unmistakable. */
  skin?: string;
  size: number;
}

/** Always a PNG of request.size × request.size. */
export interface CaptureRecord {
  request: CaptureRequest;
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
}

export interface RenderInput {
  files: Map<string, Uint8Array>;
  item: NormalizedItem;
  itemType: ItemType;
  category: string;
}

export interface Renderer {
  /** Digest of everything that changes pixels: wrapper lock, binaries, browser, platform. */
  buildId: string;
  capture(input: RenderInput, requests: CaptureRequest[], signal?: AbortSignal): Promise<CaptureRecord[]>;
  stop(): Promise<void>;
}

export interface Prompt {
  version: number;
  system: string;
  instructions: string;
  /** JSON schema the model must answer with. */
  schema: Record<string, unknown>;
}

export interface ReviewImage {
  id: string;
  label: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

/** A file read as text, never run: a smart wearable's code. */
export interface ReviewText {
  id: string;
  label: string;
  text: string;
}

export interface ReviewRequest {
  check: string;
  prompt: Prompt;
  /** sha256 of the canonical prompt — stamped on every answer so a verdict can be re-checked. */
  promptDigest: string;
  images: ReviewImage[];
  texts?: ReviewText[];
  /** The rule's own input budget when it is not manifest.ai.maxInputTokens: reading code takes far more than images. */
  maxInputTokens?: number;
}

export interface ReviewMetadata {
  provider: string;
  model: string;
  promptVersion: number;
  promptDigest: string;
  stopReason?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  images?: { id: string; sha256: string }[];
  texts?: { id: string; sha256: string }[];
  /** Raw model text — the run folder alone reproduces the review. */
  answer?: string;
}

/** Adapters fail soft: ok:false keeps the provenance so an errored row still says which model refused and what it cost. */
export type ReviewResult =
  | { ok: true; answer: unknown; metadata: ReviewMetadata }
  | { ok: false; reason: string; metadata: ReviewMetadata };

export interface Reviewer {
  review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult>;
}

export interface Services {
  renderer?: Renderer;
  reviewer?: Reviewer;
}


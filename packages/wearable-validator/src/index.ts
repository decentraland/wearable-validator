export { validate } from "./validate.js";
export { loadInput, unpackZip, inputTooLarge, assertItemPath, InputLimitError, type LoadedInput, type UnpackedZip } from "./loader.js";
export { digest, plannedCaptures } from "./logic/captures.js";
export { checks, registry, resolveCheck, explanations, fixes, details, docsUrl } from "./registry.js";
export { sourceLinks } from "./source-links.js";
export { parseItemReference, fetchCatalystItem, catalystFor, DEFAULT_CATALYST, TESTNET_CATALYST, type CatalystItem, type CatalystOptions } from "./catalyst.js";
export { manifest, effectiveTriangleLimit, fileSizeLimit, AVATAR_BONE_NAMES, AVATAR_CORE_BONE_NAMES } from "./manifest/index.js";
export { uniqueBytesTotal } from "./logic/bytes.js";
export { fingerprintModel, fingerprintVersion, type ModelFingerprint, type PartFingerprint } from "./logic/fingerprint.js";
export { createCatalog, commonGeometry, type CatalogEntry, type CatalogIndex, type CatalogOptions, type CommonGeometry } from "./logic/similarity.js";
export type {
  Input, Options, Result, Finding, CheckResult, CheckDefinition, CheckContext,
  Group, Severity, CheckStatus, ItemType, NormalizedItem, ParsedModel, CheckExecution, ProgressEvent,
  CaptureRequest, CaptureRecord, RenderInput, Renderer, Prompt, ReviewImage, ReviewRequest, ReviewMetadata, ReviewResult, Reviewer, Services,
  Catalog, CatalogAnswer, CatalogMatch, CatalogRequest
} from "./types.js";

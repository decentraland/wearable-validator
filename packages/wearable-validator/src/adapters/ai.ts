/**
 * The /ai entry: one Anthropic vision call over OAuth through pi-ai — node-only.
 * Previous hop: checks/<rule>.ts builds a ReviewRequest (prompt + labeled images).
 * Next hop: the check maps the ReviewResult to a row; packages/server/src/reviewers.ts
 * records reviewMessages() as 2-context.json and the result as 3-answer.json.
 * Reads top to bottom in call order: gate → budget → build → send → parse → fail soft.
 */
import { createModels, hasApi, type AssistantMessage, type Context, type Credential, type CredentialStore, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { imageSize } from "image-size";
import { digest } from "../logic/captures.js";
import { isJpegBytes, isPngBytes } from "../logic/images.js";
import { manifest } from "../manifest/index.js";
import type { ReviewImage, ReviewMetadata, ReviewRequest, ReviewResult, Reviewer } from "../types.js";

// a `claude setup-token` (sk-ant-oat…) lives about a year and is itself the bearer, not a refresh token
const SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The credentials for createPiReviewer from a `claude setup-token`, held in memory so pi-ai never tries to refresh it. API keys are refused. */
export function setupTokenCredentials(token: string): CredentialStore {
  if (!token.startsWith("sk-ant-oat")) throw new Error("The token must be a `claude setup-token` (sk-ant-oat…), not an API key. Run `claude setup-token` to create one.");
  let current: Credential | undefined = { type: "oauth", access: token, refresh: token, expires: Date.now() + SETUP_TOKEN_TTL_MS };
  return {
    async read(provider, options) {
      options?.signal?.throwIfAborted();
      return provider === "anthropic" ? current : undefined;
    },
    async list() {
      return current ? [{ providerId: "anthropic", type: "oauth" }] : [];
    },
    async modify(provider, fn) {
      if (provider !== "anthropic") throw new Error("This credential store supports Anthropic OAuth only.");
      const next = await fn(current);
      if (next && next.type !== "oauth") throw new Error("Only OAuth credentials can be stored here.");
      if (next) current = next;
      return next ?? current;
    },
    async delete(provider) {
      if (provider === "anthropic") current = undefined;
    }
  };
}

export interface PiReviewerOptions {
  credentials: CredentialStore;
  /** Defaults to manifest.ai.model; must be an image-capable Anthropic model in pi-ai's catalog. */
  model?: string;
  /** "short" adds one prompt-cache breakpoint after the images. */
  cache?: "none" | "short";
  /** Test seam: the transport pi-ai uses for the one HTTP call. */
  fetch?: typeof globalThis.fetch;
}

export function createPiReviewer(options: PiReviewerOptions): Reviewer {
  const ai = manifest.ai;
  const models = createModels({
    credentials: options.credentials,
    authContext: { env: async () => undefined, fileExists: async () => false }
  });
  const provider = anthropicProvider();
  // setProvider with auth: { oauth } only — api-key auth is removed on purpose
  models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
  const selectedModel = models.getModel("anthropic", options.model ?? ai.model);
  if (!selectedModel || !hasApi(selectedModel, "anthropic-messages") || !selectedModel.input.includes("image")) {
    throw new Error("Choose an image-capable Anthropic model from the pinned Pi model catalog.");
  }
  // the type-guard narrowing does not reach the review closure — rebind once
  const model = selectedModel;

  async function review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
    signal?.throwIfAborted();
    const metadata: ReviewMetadata = {
      provider: model.provider,
      model: model.id,
      promptVersion: request.prompt.version,
      promptDigest: request.promptDigest,
      images: await Promise.all(request.images.map(async (image) => ({ id: image.id, sha256: await digest(image.bytes) })))
    };
    const failure = (reason: string): ReviewResult => ({ ok: false, reason, metadata });

    const gate = await requireOAuth(options.credentials, signal);
    if (gate !== true) return failure(gate);
    signal?.throwIfAborted();
    const estimated = estimateTokens(request);
    if (typeof estimated === "string") return failure(estimated);
    if (estimated > ai.maxInputTokens) {
      return failure(`The review needs about ${estimated} input tokens; the budget is ${ai.maxInputTokens}. Reduce the evidence size.`);
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timeout = setTimeout(abort, ai.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    let response: AssistantMessage;
    try {
      // output_config.format json_schema, no tools, maxRetries 0; cache "short" strips every cache_control and marks the LAST image so the prefix is the shared images and the suffix the rule text
      response = await models.complete(model, reviewMessages(request), {
        signal: controller.signal,
        // the model's own ceiling: the answer is never worth truncating, and the timeout is the only budget
        maxTokens: model.maxTokens,
        thinkingEnabled: true,
        thinkingBudgetTokens: ai.thinkingBudgetTokens,
        maxRetries: ai.maxRetries,
        cacheRetention: options.cache ?? "none",
        fetch: options.fetch,
        onPayload: (payload) => configurePayload(payload, request.prompt.schema, options.cache === "short")
      });
    } catch (error) {
      signal?.throwIfAborted();
      return failure(`The review call failed. ${redact(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    signal?.throwIfAborted();
    if (response.stopReason === "aborted") return failure(`The model did not answer within ${ai.timeoutMs} ms. Run the review again.`);
    return parseResponse(response, metadata);
  }
  return { review };
}

/** Reads the credential store before any network: only an Anthropic OAuth session passes — API keys are refused on purpose. */
async function requireOAuth(credentials: CredentialStore, signal?: AbortSignal): Promise<true | string> {
  let credential;
  try {
    credential = await credentials.read("anthropic", { signal });
  } catch {
    signal?.throwIfAborted();
    return "Cannot read the OAuth session. Check the credential store and try again.";
  }
  if (credential?.type !== "oauth" || !credential.access.startsWith("sk-ant-oat")) {
    return "Provide an Anthropic OAuth session through credentials. API-key credentials are not supported.";
  }
  return true;
}

/** Pre-call budget: ceil(chars/3) + Σ ceil(w·h/750) ≤ maxInputTokens, 1..maxImages images — or the reason it cannot be sent. */
function estimateTokens(request: ReviewRequest): number | string {
  const ai = manifest.ai;
  if (!request.images.length || request.images.length > ai.maxImages) {
    return `The review sends ${request.images.length} images; the budget is 1 to ${ai.maxImages}.`;
  }
  const text = request.prompt.system + request.prompt.instructions + request.images.map(imageText).join("");
  let tokens = Math.ceil(text.length / ai.textCharactersPerToken);
  for (const image of request.images) {
    if (!isPngBytes(image.bytes) && !isJpegBytes(image.bytes)) return `Provide PNG or JPEG evidence for the review (${image.id}).`;
    const { width, height } = imageSize(image.bytes);
    tokens += Math.ceil((width * height) / ai.imagePixelsPerToken);
  }
  return tokens;
}

function imageText(image: ReviewImage): string {
  return `Image ID: ${image.id}\n${image.label}`;
}

/** The exact Context sent: "Image ID" + label before each image, the rule instructions last. */
export function reviewMessages(request: ReviewRequest): Context {
  const content: (TextContent | ImageContent)[] = [];
  for (const image of request.images) {
    content.push({ type: "text", text: imageText(image) });
    content.push({ type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType });
  }
  content.push({ type: "text", text: request.prompt.instructions });
  return { systemPrompt: request.prompt.system, messages: [{ role: "user", content, timestamp: Date.now() }] };
}

/** Forces the JSON-schema output format on the wire payload; optionally sets the one cache breakpoint. */
export function configurePayload(body: unknown, schema: Record<string, unknown>, cacheImages: boolean): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Pi provider returned an unsupported request payload.");
  }
  const payload = body as Record<string, unknown>;
  payload.output_config = { format: { type: "json_schema", schema } };
  if (!cacheImages || !Array.isArray(payload.messages)) return;
  let lastImage: Record<string, unknown> | undefined;
  for (const message of payload.messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      delete block.cache_control;
      if (block.type === "image") lastImage = block;
    }
  }
  if (lastImage) lastImage.cache_control = { type: "ephemeral" };
}

/** Narrows the one response; provenance (usage, stopReason, raw text) survives every failure. */
function parseResponse(response: AssistantMessage, base: ReviewMetadata): ReviewResult {
  const { input, output, cacheRead, cacheWrite, cost } = response.usage;
  const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const metadata: ReviewMetadata = {
    ...base,
    stopReason: response.rawStopReason ?? response.stopReason,
    usage: { input, output, cacheRead, cacheWrite, cost: cost.total },
    answer: text
  };
  const failure = (reason: string): ReviewResult => ({ ok: false, reason, metadata });
  if (response.stopReason !== "stop" || response.rawStopReason === "refusal" || response.content.some((block) => block.type === "toolCall")) {
    return failure(failureText(response));
  }
  const maxInputTokens = manifest.ai.maxInputTokens;
  if (input + cacheRead + cacheWrite > maxInputTokens) {
    return failure(`The review used ${input + cacheRead + cacheWrite} input tokens; the budget is ${maxInputTokens}. Reduce the evidence size before retrying.`);
  }
  try {
    return { ok: true, answer: JSON.parse(text), metadata };
  } catch {
    return failure("The reviewer did not return valid JSON. Run the review again.");
  }
}

function failureText(response: AssistantMessage): string {
  const message = response.errorMessage ?? "";
  if (/401|authentication_error|invalid.*token/i.test(message)) return "The OAuth session was rejected. Sign in again before retrying the review.";
  if (/429|rate_limit/i.test(message)) return "The OAuth account is rate limited. Wait before retrying the review.";
  if (/404|not_found|model.*not.*available/i.test(message)) return "The selected model is unavailable to this OAuth account. Configure an available image model.";
  const stop = response.rawStopReason ?? response.stopReason;
  // thinking counts against the same budget as the answer: twenty frames of findings need room for both
  if (stop === "max_tokens") return "The model's answer was longer than the model itself can produce. Retry the review with fewer frames.";
  const detail = redact(message);
  return `The review did not finish (${stop}). ${detail || "Retry the review with complete evidence."}`;
}

function redact(message: string): string {
  return message
    .replace(/sk-[\w-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(0, manifest.ai.maxTextLength);
}

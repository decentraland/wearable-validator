/**
 * The model round-trip every AI-backed rule shares: build the request, ask services.reviewer, refuse an answer
 * that is for another prompt or lacks provenance. Rules keep their own prompt, schema and answer parsing.
 * Previous hop: checks/rendering/<rule>/index.ts. Next hop: the injected Reviewer (/ai in production).
 */
import { digestJson } from "./captures.js";
import type { CheckContext, CheckExecution, Prompt, ReviewImage, ReviewMetadata, ReviewText } from "../types.js";

export const skipped = (reason: string): CheckExecution => ({ status: "skipped", coverage: "missing", findings: [], reason });
export const errored = (reason: string, review?: ReviewMetadata): CheckExecution => ({ status: "errored", coverage: "missing", findings: [], reason, review });

export type ReviewOutcome = { answer: unknown; metadata: ReviewMetadata } | CheckExecution;

export function isExecution(value: ReviewOutcome): value is CheckExecution {
  return "status" in value;
}

/** One call; a missing reviewer is skipped, a refusal or a mismatched prompt is errored — never a pass. */
export async function askReviewer(ctx: CheckContext, check: string, prompt: Prompt, images: ReviewImage[], text?: { texts: ReviewText[]; maxInputTokens: number }): Promise<ReviewOutcome> {
  const reviewer = ctx.services?.reviewer;
  if (!reviewer) return skipped("Configure services.reviewer to run this review. Use the optional /ai adapter for Pi with OAuth.");
  const request = { check, prompt, promptDigest: await digestJson(prompt), images, ...text };
  const result = await reviewer.review(request, ctx.signal);
  ctx.signal?.throwIfAborted();
  if (!result.ok) return errored(result.reason || "The reviewer did not answer.", result.metadata);
  const { metadata } = result;
  if (metadata.promptDigest !== request.promptDigest || metadata.promptVersion !== prompt.version || !metadata.model || !metadata.provider) {
    return errored("The reviewer answered for a different prompt or omitted its model identity. Run the review again.", metadata);
  }
  return { answer: result.answer, metadata };
}

// model text reaches terminals and HTML: control characters are treated as malformed output
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Bounded, printable text from the model. */
export function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value);
}

/** Every id the model cites must be one it was given. */
export function knownIds(value: unknown, imageIds: string[]): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && imageIds.includes(id));
}

/** reviewedCaptureIds must be exactly the supplied set — proof the model looked at every image. */
export function coversEveryImage(value: unknown, imageIds: string[]): value is string[] {
  return knownIds(value, imageIds) && new Set(value).size === imageIds.length && value.length === imageIds.length;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

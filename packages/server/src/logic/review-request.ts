/**
 * The Builder's validation request as it arrives from the work queue, checked before anything acts on it: one job per
 * collection, every item carrying its entity metadata and the hash of each file.
 */
import { assertItemPath } from "@dcl-regenesislabs/wearable-validator";

export const REVIEW_EVENT = { type: "builder", subType: "collection-validation-requested" } as const;

export interface ReviewItem {
  itemId: string;
  /** The Builder's hash of the item's content: its result is posted against it, so a stale answer is recognisable. */
  contentHash: string;
  itemType: "wearable" | "emote";
  /** The entity metadata the Builder would deploy for the item (the @dcl/schemas shape). */
  metadata: Record<string, unknown>;
  /** File path in the item → the hash it is stored under in the Builder's storage. */
  contents: Record<string, string>;
}

export interface ValidationRequest {
  /** New for every attempt: the result carries it back so the Builder matches it to the attempt it sent. */
  validationId: string;
  collectionId: string;
  items: ReviewItem[];
}

/** A message the job can never act on: deleted, not retried. */
export class InvalidReviewRequest extends Error {}

// Builder ids are UUIDs; stored contents are content-addressed hashes (CIDs)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[A-Za-z0-9]{1,128}$/;
export const MAX_ITEMS = 50;
const MAX_FILES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function field(record: Record<string, unknown>, name: string, pattern: RegExp): string {
  const value = record[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new InvalidReviewRequest(`${name} is missing or malformed.`);
  return value;
}

function parseItem(value: unknown): ReviewItem {
  if (!isRecord(value)) throw new InvalidReviewRequest("An item is not an object.");
  const metadata = value.metadata;
  if (!isRecord(metadata)) throw new InvalidReviewRequest("An item has no metadata.");
  const contents = value.contents;
  if (!isRecord(contents) || Object.keys(contents).length === 0) throw new InvalidReviewRequest("An item's contents are missing or empty.");
  if (Object.keys(contents).length > MAX_FILES) throw new InvalidReviewRequest(`An item lists more than ${MAX_FILES} files.`);
  for (const [file, hash] of Object.entries(contents)) {
    try {
      if (file.includes("\\")) throw new Error(`"${file}" uses a backslash: item paths use forward slashes.`);
      assertItemPath(file);
    } catch (error) {
      throw new InvalidReviewRequest(error instanceof Error ? error.message : `"${file}" is not a file inside the item.`);
    }
    if (typeof hash !== "string" || !HASH.test(hash)) throw new InvalidReviewRequest(`The hash of "${file}" is malformed.`);
  }
  return {
    itemId: field(value, "itemId", UUID),
    contentHash: field(value, "contentHash", HASH),
    // an emote's entity metadata carries emoteDataADR74; a wearable's carries data
    itemType: isRecord(metadata.emoteDataADR74) ? "emote" : "wearable",
    metadata,
    contents: contents as Record<string, string>
  };
}

/** The body of one queue message: the event itself, or wrapped in the SNS envelope a topic subscription delivers. */
export function parseReviewRequest(body: string): ValidationRequest {
  let event: unknown;
  try {
    event = JSON.parse(body);
    if (isRecord(event) && typeof event.Message === "string") event = JSON.parse(event.Message);
  } catch {
    throw new InvalidReviewRequest("The message is not JSON.");
  }
  if (!isRecord(event) || event.type !== REVIEW_EVENT.type || event.subType !== REVIEW_EVENT.subType) throw new InvalidReviewRequest(`Not a ${REVIEW_EVENT.type}/${REVIEW_EVENT.subType} event.`);
  const request = event.metadata;
  if (!isRecord(request)) throw new InvalidReviewRequest("The event has no metadata.");
  const items = request.items;
  if (!Array.isArray(items) || items.length === 0) throw new InvalidReviewRequest("The request has no items.");
  if (items.length > MAX_ITEMS) throw new InvalidReviewRequest(`The request has more than ${MAX_ITEMS} items.`);
  return { validationId: field(request, "validationId", UUID), collectionId: field(request, "collectionId", UUID), items: items.map(parseItem) };
}

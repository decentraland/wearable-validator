/** The Builder's "review this item" event as it arrives from the work queue: parsed and checked before anything acts on it. */
import { assertItemPath } from "@dcl-regenesislabs/wearable-validator";

export const REVIEW_EVENT = { type: "builder", subType: "item-review-requested" } as const;

export interface ReviewRequest {
  itemId: string;
  collectionId: string;
  /** The Builder's hash of the item's content: the result is posted against it, so a stale answer is recognisable. */
  contentHash: string;
  itemType: "wearable" | "emote";
  /** The metadata the Builder would deploy for the item (name, description, rarity, data or emoteDataADR74). */
  entityMetadata: Record<string, unknown>;
  /** File name in the item → the hash it is stored under in the Builder's storage. */
  contents: Record<string, string>;
}

/** A message the job can never act on: deleted, not retried. */
export class InvalidReviewRequest extends Error {}

// Builder ids are UUIDs; stored contents are content-addressed hashes (CIDs)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[A-Za-z0-9]{1,128}$/;
const MAX_FILES = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function field(record: Record<string, unknown>, name: string, pattern: RegExp): string {
  const value = record[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new InvalidReviewRequest(`${name} is missing or malformed.`);
  return value;
}

/** The body of one queue message: the event itself, or wrapped in the SNS envelope a topic subscription delivers. */
export function parseReviewRequest(body: string): ReviewRequest {
  let event: unknown;
  try {
    event = JSON.parse(body);
    if (isRecord(event) && typeof event.Message === "string") event = JSON.parse(event.Message);
  } catch {
    throw new InvalidReviewRequest("The message is not JSON.");
  }
  if (!isRecord(event) || event.type !== REVIEW_EVENT.type || event.subType !== REVIEW_EVENT.subType) throw new InvalidReviewRequest(`Not a ${REVIEW_EVENT.type}/${REVIEW_EVENT.subType} event.`);
  const metadata = event.metadata;
  if (!isRecord(metadata)) throw new InvalidReviewRequest("The event has no metadata.");
  const itemType = metadata.itemType;
  if (itemType !== "wearable" && itemType !== "emote") throw new InvalidReviewRequest("itemType must be wearable or emote.");
  if (!isRecord(metadata.entityMetadata)) throw new InvalidReviewRequest("entityMetadata is missing.");
  const contents = metadata.contents;
  if (!isRecord(contents) || Object.keys(contents).length === 0) throw new InvalidReviewRequest("contents is missing or empty.");
  if (Object.keys(contents).length > MAX_FILES) throw new InvalidReviewRequest(`contents lists more than ${MAX_FILES} files.`);
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
    itemId: field(metadata, "itemId", UUID),
    collectionId: field(metadata, "collectionId", UUID),
    contentHash: field(metadata, "contentHash", HASH),
    itemType,
    entityMetadata: metadata.entityMetadata,
    contents: contents as Record<string, string>
  };
}

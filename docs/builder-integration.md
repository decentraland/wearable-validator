# Builder integration

When a creator publishes a collection, the Builder asks for a validation; the validator checks, renders and reviews
every item and posts one result for the collection back. Nothing waits on it.

```
builder-server ──request──▶ topic ──▶ queue ──▶ validation job ──▶ POST …/validation-result ──▶ builder-server
                                                     │
                                                     └── GET …/v1/storage/contents/:hash   (each item's files)
```

The job sleeps between collections: the queue wakes it, it drains the queue and exits. A message is deleted only once
the callback answers 2xx; if the callback cannot be reached the whole collection is retried by the queue (three tries,
then a dead-letter queue).

## 1. The request

Published on the events topic, one per collection and attempt:

```json
{
  "type": "builder",
  "subType": "collection-validation-requested",
  "key": "<collection id>",
  "timestamp": 1790000000000,
  "metadata": {
    "validationId": "<uuid, new for every attempt>",
    "collectionId": "<collection uuid>",
    "items": [
      {
        "itemId": "<item uuid>",
        "contentHash": "<the item's content hash>",
        "metadata": { "…": "the entity metadata the Builder would deploy (@dcl/schemas shape)" },
        "contents": { "male/shirt.glb": "<hash>", "thumbnail.png": "<hash>", "image.png": "<hash>" }
      }
    ]
  }
}
```

- Publish it with the SNS message attributes `type` = `builder` and `subType` = `collection-validation-requested`, as the
  other events on the topic carry theirs: the queue's subscription filters on them.
- 1 to 50 items; each lists 1 to 100 files as `path → hash`. Paths are relative and stay inside the item.
- An emote is told by `metadata.emoteDataADR74`; anything else is a wearable.
- Each file is downloaded from `<content url>/v1/storage/contents/<hash>`, at most 32 MB per item. The content URL is the
  job's own configuration, never taken from the request.
- A request that does not match this shape is dropped and logged, not retried.

## 2. The callback

`POST <callback url>/v1/collections/:collectionId/validation-result`:

```json
{
  "validationId": "<as received>",
  "collectionId": "<as received>",
  "verdict": "rejected",
  "rulesVersion": "0.4.0",
  "items": [
    {
      "itemId": "<item uuid>",
      "contentHash": "<as received>",
      "passed": false,
      "findings": [
        { "rule": "S-05", "check": "file-size", "severity": "error", "message": "The item totals 4.03 MB; the limit for an emote is 3 MB …", "measured": 4228654, "limit": 3145728, "fix": "…", "docs": "https://…" }
      ],
      "visualSummary": "thumbnail-honesty: Compared the thumbnail with 20 rendered views. …"
    }
  ]
}
```

- `verdict`: `passed` when every item passed; `rejected` when every item is decided and one or more failed; `error` when
  an item is undecided (`passed: null`).
- With `error`: `reason: "unsupported"` and `retryable: false` when every undecided item is one the validator cannot
  judge — send it to a person. Otherwise `retryable: true`: send the collection again with a new `validationId`.
- An item that could not be validated carries `error` with why; the others are still reported.
- Findings carry `bodyShape` (`male` / `female`) when they point at one body shape's file, and `measured` / `limit`
  only when they are numbers.
- Retries: on a network error, a 5xx, a 408 or a 429 the job tries again with backoff; any other answer is final.
  Answer 204, also for a result you already have.

### Authenticating the callback

Every call carries two headers, computed with a secret both sides share:

- `x-wearable-validator-timestamp`: milliseconds since the epoch
- `x-wearable-validator-signature`: `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>`

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromValidator(rawBody: string, timestamp: string, header: string, secret: string): boolean {
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false; // refuse replays
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
```

Compute it over the raw body, before JSON parsing.

## Trying it locally

`npm run poc -- [collection contract address] [items]` runs the whole path on a laptop (needs Docker): a real SQS queue
(ElasticMQ), a stand-in Builder that serves the items' files and checks the signature, and the job rendering on the
native render server. The collection is a published one from decentraland.zone, standing in for a Builder collection.

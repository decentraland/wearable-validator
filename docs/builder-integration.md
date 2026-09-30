# Builder integration: queued reviews

When a creator submits an item for curation, the Builder asks for a review; the validator checks, renders and reviews
the item and posts the result back. Nothing waits on it: the Builder publishes an event and later receives a webhook.

```
Builder ──event──▶ topic ──▶ queue ──▶ review job ──▶ POST /v1/items/:id/validation ──▶ Builder
                                          │
                                          └── GET /v1/storage/contents/:hash  (the item's files)
```

The job scales to zero between submissions and drains the queue when one arrives. A message is deleted only once the
webhook answers 2xx; anything else is retried (three tries, then a dead-letter queue).

## 1. The event the Builder publishes

On the shared events topic, whenever an item is submitted or re-submitted for curation (a new `item_curations` row, or a
new `content_hash` on one):

```json
{
  "type": "builder",
  "subType": "item-review-requested",
  "key": "<item id>",
  "timestamp": 1790000000000,
  "metadata": {
    "itemId": "<item uuid>",
    "collectionId": "<collection uuid>",
    "contentHash": "<the item curation's content_hash>",
    "itemType": "wearable",
    "entityMetadata": { "…": "the metadata the Builder would deploy for this item" },
    "contents": { "male/shirt.glb": "<hash>", "thumbnail.png": "<hash>", "image.png": "<hash>" }
  }
}
```

- `itemType` is `wearable` or `emote`.
- `entityMetadata` is exactly what a deployment of the item would carry (`name`, `description`, `rarity`, `i18n`, and `data` for a
  wearable or `emoteDataADR74` for an emote), so the checks judge what would be published.
- `contents` maps every file of the item to the hash it is stored under; the job downloads each from
  `<builder api>/v1/storage/contents/<hash>`. File names must be relative paths inside the item.
- Messages that do not match this shape are dropped and logged, not retried.

## 2. The webhook the Builder exposes

`POST <builder api>/v1/items/:itemId/validation`, JSON body:

```json
{
  "itemId": "<item uuid>",
  "collectionId": "<collection uuid>",
  "contentHash": "<as received>",
  "rulesVersion": "0.4.0",
  "passed": false,
  "decision": { "state": "blocked", "reasons": ["file-size: The item totals 4.03 MB; the limit for an emote is 3 MB"] },
  "summary": { "errors": 1, "warnings": 4 },
  "checks": [{ "check": "render-valid", "group": "rendering", "status": "passed" }],
  "findings": [{ "check": "file-size", "severity": "error", "message": "…", "docs": "https://…" }]
}
```

- `decision.state` is what the curator should do: `ready` (nothing found, look at the views), `review` (warnings or a
  check the model could not answer) or `blocked` (errors). `reasons` are short, ready to show.
- `passed` is `null` when there is no verdict (a visual check was not answered).
- Store it against `contentHash`: if the item changed since, a newer event is already on its way and this result is stale.
- Answer 2xx once stored. The same result may arrive twice (a retried delivery); storing it again must be harmless.

### Authenticating the webhook

Every call carries two headers, computed with a secret shared by both sides:

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

`npm run job:poc -w wearable-validator-server -- [shop item URL or URN]` runs the whole path on a laptop: a real SQS queue
(ElasticMQ in Docker), a stand-in Builder serving the item's files and checking the signature, and the job rendering on
the native render server. It needs Docker.

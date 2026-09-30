# wearable-validator

The Decentraland wearable and emote rule book as code, and the job that applies it to collections published in the
Builder. It checks each item's files together with the metadata, representations and content list the Builder
supplies, renders it on both body shapes and asks a vision model to judge what it sees.

Mandated by [DAO proposal e2a13c58](https://decentraland.org/governance/proposal/?id=e2a13c58-d66d-412d-802f-83190d063636): automate the objective half of wearable curation.

## What's here

| | |
|---|---|
| `packages/wearable-validator` | the published package: 35 deterministic checks (files · model · emote · content) plus four visual checks (render-valid, thumbnail-honesty, visual-quality, emote-quality), the rules manifest and a CLI. One folder per check under `src/checks/<group>/<name>/`; shared algorithms in `src/logic/`; Node-only adapters in `src/adapters/` (`/native` drives the render server, `/ai` calls the model). The root entry is isomorphic |
| `packages/job` | the validation job (`wearable-validator-job`) and its Docker image (`Dockerfile`): wakes on the queue, validates every item of a collection, posts one result to the Builder and exits |
| `tools` | the catalyst runner: validate real published items |

The job imports the library only by package name (`@dcl-regenesislabs/wearable-validator`, `/native`, `/ai`).
Every check carries a rule-book ID (`M-01`…), a plain-language explanation, fix guidance and a docs link, all exported
from the package (`checks`, `explanations`, `fixes`) so no surface can drift from the code. To add or change a rule,
follow [docs/adding-a-check.md](docs/adding-a-check.md).

## Try it

```bash
npm install

# the library's CLI
cd packages/wearable-validator
npx tsx src/cli.ts validate my-wearable.zip
npx tsx src/cli.ts validate model.glb --item-type wearable --category hat
npx tsx src/cli.ts checks        # every check with its plain-language explanation
cd ../..

# real published catalyst items
npm run catalyst -- --wearables 15 --emotes 10

# the whole validation path on a laptop (needs Docker): a real SQS queue, a stand-in Builder and the job
npm run poc
```

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate({ files, metadata, content });
result.passed;    // true | false | null (partial runs never mint a verdict)
result.findings;  // every problem at once: message, where, measured vs limit, fix, docs
```

## The job

When a creator publishes a collection, the Builder publishes a validation request with every item inline. The queue
wakes the job; for each item it downloads the files by hash from Builder storage, runs the code checks, renders on the
native render server (the Unity avatar scene drawn on the CPU, no browser, no GPU) and runs the visual checks. One
result for the collection goes to the Builder's callback, signed, and the job exits once the queue is empty, so it
costs nothing between collections. The contract: [docs/builder-integration.md](docs/builder-integration.md). What it
reads: `packages/job/.env.default`. How the visual checks work: [docs/visual-validation.md](docs/visual-validation.md).

## Deploy

A merge to `main` builds the image and deploys the job to dev through the shared Decentraland pipeline; a GitHub
release deploys prd. A merge that touches the library publishes a `next` snapshot to npm, and a release publishes it on
`latest`. Details: [docs/deployment.md](docs/deployment.md).

## Regressions

- Security: `npm run build -w @dcl-regenesislabs/wearable-validator`, then
  `node --import tsx --test packages/wearable-validator/test/security.test.ts` — cyclic GLB hierarchies, PNG inflation
  beyond the declared scanlines, duplicate PNG headers, ZIP extraction before validation. `pako` is pinned to 2.2.0 so
  the streaming inflation and truncated-input behavior this guard relies on stay stable.
- Correctness: `node --import tsx --test packages/wearable-validator/test/correctness.test.ts` (rarity and body-shape
  metadata, emote categories, repeated material names, per-representation measurements, bounding-box boundaries, spring
  settings) and `packages/wearable-validator/test/metadata-schema.test.ts` (full platform schema validation).
- Content hashes support legacy `Qm…` and UnixFS CIDv1 hashes, computed with Web Crypto; tests compare them with
  `@dcl/hashing` across empty files, chunk boundaries and a two-level tree.

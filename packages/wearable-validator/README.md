# @dcl-regenesislabs/wearable-validator

Decentraland's wearable and emote rule book as code. Hand it a Builder zip, a `.glb` or a published item and it returns every problem at once: what is wrong, where, the measured value against the limit, and how to fix it.

- **36 code checks** (files, model, emote, content) run anywhere: browser or Node.
- **4 visual checks** render the item and ask Claude to judge it. They run on a Node server only (a native Unity render server).
- **1 code review** (`smart-wearable-code`, group `code`) has Claude read a smart wearable's scene and bundle as text, never running it: it says what the code does, and malicious or spam code fails the item. It needs only the `/ai` reviewer.
- **1 catalog check** (`similar-items`, group `catalog`) compares the model's mesh with the items already published and warns, with the item's marketplace link, when it is nearly the same as one or contains one. It runs anywhere and needs a catalog to ask.

```sh
npm i @dcl-regenesislabs/wearable-validator
```

## In the browser: the code checks

Works with any bundler and needs no Node polyfills.

```ts
import { validate, fixes } from "@dcl-regenesislabs/wearable-validator";

const bytes = new Uint8Array(await file.arrayBuffer()); // a Builder .zip or a bare .glb
const result = await validate(bytes);

result.passed; // a full run: false on any error, true when everything was checked and passed, null when a check was skipped; a bare .glb or a subset: always null
for (const finding of result.findings) {
  console.log(finding.severity, finding.message, finding.where, finding.measured, finding.limit);
  console.log("How to fix:", fixes[finding.check], finding.docs);
}
```

A published item works the same way:

```ts
import { validate, fetchCatalystItem, parseItemReference } from "@dcl-regenesislabs/wearable-validator";

// a marketplace or shop item URL, or a urn:decentraland:… reference
const item = await fetchCatalystItem(parseItemReference("https://decentraland.org/marketplace/contracts/0x…/items/0")!);
const result = await validate({ files: item.files, metadata: item.metadata, content: item.content });
```

## On a Node server: code and visual (AI) checks

The visual checks need three things next to the package:

1. **The peer**, pinned exactly: `npm i @earendil-works/pi-ai@0.84.1`
2. **The native render server** (a Linux x86_64 Unity player that draws on the CPU through Mesa and Xvfb), a release asset checked by sha256:
   ```sh
   curl -fsSL https://github.com/dcl-regenesislabs/wearable-validator/releases/download/render-server-1/render-server.tar.gz -o render-server.tar.gz
   echo "99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76  render-server.tar.gz" | sha256sum -c -
   mkdir render-server && tar -xzf render-server.tar.gz -C render-server
   ```
   It needs `libgl1 libglx-mesa0 libgl1-mesa-dri xvfb`. The repository's root `Dockerfile` is a working image, and on a laptop `packages/job/render-server-docker.sh` runs it in Docker.
3. **A Claude setup token** (`claude setup-token`, `sk-ant-oat…`, valid about a year). API keys are refused.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";
import { createNativeRenderer } from "@dcl-regenesislabs/wearable-validator/native";
import { createPiReviewer, setupTokenCredentials } from "@dcl-regenesislabs/wearable-validator/ai";

// one long-running render server per process, reused across items
const renderer = await createNativeRenderer({ command: "./render-server/Builds/RenderServer/entrypoint.sh", build: "render-server-1" });
const reviewer = createPiReviewer({ credentials: setupTokenCredentials(process.env.ANTHROPIC_OAUTH_SETUP_TOKEN!) });

const result = await validate(zipBytes, {
  groups: ["files", "model", "emote", "content", "rendering"], // "rendering" adds the visual checks
  services: { renderer, reviewer }
});

await renderer.stop(); // on shutdown
```

- **Cost:** everything renders on the CPU, with no GPU. Each item makes at most two model calls.
- **Re-runs:** pass the earlier `result.captures` back as `captures` and only missing views are rendered again.
- **Safe failure:** visual findings are warnings. A missing render, a refused or malformed answer, or no `reviewer` never passes; the row becomes `skipped` or `errored` with the reason. Each visual row carries `review` (model, prompt version, token usage).

## Similar published items

`similar-items` fingerprints each model (where its vertices sit on a 1 mm grid, and how each connected part is built) and asks `services.catalog` for published items with the same geometry. Textures, materials and names are ignored, so a recolour of someone else's mesh matches. It only ever warns.

```ts
import { validate, createCatalog, manifest } from "@dcl-regenesislabs/wearable-validator";

// index: { fingerprint, entries: [{ urn, name, creator, publishedAt, url, models }], common } built from published items
const catalog = createCatalog(index, { rules: manifest.similarItems }); // once: this is the slow part
const result = await validate(zip, { groups: ["catalog"], services: { catalog }, ownCreators: [uploaderWallet] });
```

- `createCatalog` answers from an index held in memory. A host that keeps the index on a server implements `Catalog.match(fingerprints)` with a request instead: only fingerprints travel, never the files.
- `fingerprintModel(doc, manifest.similarItems, manifest.materials.skinNameToken)` is the fingerprint of one model, and `commonGeometry(entries, baseAvatarModels, rules)` derives the geometry nobody owns (base avatars, the reference body) when an index is built.
- Pass the uploader's wallets as `ownCreators`: a creator's own earlier items are never a match. They travel with each lookup, so one catalog serves every uploader.
- `index.fingerprint` must equal `fingerprintVersion(manifest.similarItems)`: `createCatalog` refuses an index built by another version instead of silently matching nothing.
- A host that answers lookups from browsers can pass what it receives straight to `match`: fingerprints are read as data (shape checked, deduplicated, capped), and a published item is only ever named through `presentable()`, which keeps only letters, digits and a few marks of its name and accepts only the item's marketplace page. `createCatalog` throws on an index with an entry that fails it, instead of comparing against what is left, so the index builder keeps to Polygon collections (the 2019 Ethereum ones have another link shape). The check sends its `fingerprintVersion` with each lookup; a catalog built by another version must refuse it rather than answer "no match".
- Always give a lookup a deadline: `validate(..., { signal: AbortSignal.timeout(ms) })`. Walking the catalog's cells has no ceiling of its own (its cost is the upload's cells times the models that hold each), it pauses for the event loop, and the signal is what stops a slow one.
- Without a catalog the check is `skipped`. The default run does not include the group, so `passed` is unchanged there. A run that asks for the core groups **and** `catalog` gets `passed: null` when the check is skipped or errors, like any row that could not be asserted, although the check itself can only warn. A host that must never hold an item on this check runs it as its own pass (`groups: ["catalog"]`), the way the visual checks are run.

## Options

| Option | What it does |
| --- | --- |
| `checks` | Run only these checks by name (`"triangle-count"`; rule ids like `"M-01"` work too). The verdict becomes `null`. |
| `groups` | `files`, `model`, `emote`, `content` (the default set), `rendering`, `code` and `catalog` (opt-in: each needs a service). |
| `category`, `itemType` | Hints for a bare `.glb`, which carries no metadata. |
| `onProgress` | Called as each check starts and finishes, for a live UI. |
| `signal` | An `AbortSignal` to cancel the run. |
| `captures`, `services` | The visual checks and the catalog, above. |

## The result

- `passed`: `false` when any check found an error, even if other rows were `skipped` or `errored`; `true` when every check ran and none found an error; `null` when nothing failed but not everything was checked (a row that was `skipped` or `errored`: its `skipReason` says why). A bare `.glb` or a subset of checks is always `null`, errors or not.
- `summary`: `{ errors, warnings, checked, skipped }`.
- `checks[]`: one row per check, with `status` (`passed`, `failed`, `warning`, `skipped` or `errored`), `measured` and `skipReason`. An `errored` row with `retryable: true` may be answered by running that check again (its model call failed or timed out, or the answer could not be read); without it, running again would end the same way (an inconclusive answer, no model, a request over budget).
- `findings[]`: `check`, `severity`, `message` (written for creators), `where`, `measured`, `limit`, `rule`, `docs`.

Lookups:
- `checks` and `registry` describe every check: `explanation`, `fix`, `details`, `docs`.
- `fixes[name]` holds each check's fix steps.
- `manifest` holds every limit, and its `version` is the rules version.

## CLI

```sh
npx @dcl-regenesislabs/wearable-validator validate item.zip [--checks triangle-count] [--groups model] [--json]
```

## Hostile input

Every input path is bounded before it is decoded: the zip's entry count and inflated size, PNG and JPEG pixels, and what a GLB's accessors and images unpack to. A file past a bound gets an error finding, never a crash. To read a zip for display or previews, use `unpackZip(bytes)`: it applies the same bounds and returns `{ files, emptyFiles }`.

## Versions

Every library change merged to `main` publishes a snapshot on the `next` tag (`npm i @dcl-regenesislabs/wearable-validator@next`). A GitHub release tagged with a semver version publishes it on `latest`; tag it with the rules version (`manifest.version`). More in the [repository](https://github.com/decentraland/wearable-validator): [how a visual review works](https://github.com/decentraland/wearable-validator/blob/main/docs/visual-validation.md) and [adding a check](https://github.com/decentraland/wearable-validator/blob/main/docs/adding-a-check.md).

## License

[Apache-2.0](LICENSE)

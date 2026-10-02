# @dcl-regenesislabs/wearable-validator

Decentraland's wearable and emote rule book as code. Hand it a Builder zip, a `.glb` or a published item and it returns every problem at once: what is wrong, where, the measured value against the limit, and how to fix it.

- **35 code checks** (files, model, emote, content) run anywhere: browser or Node.
- **4 visual checks** render the item and ask Claude to judge it. They run on a Node server only (a native Unity render server).

```sh
npm i @dcl-regenesislabs/wearable-validator
```

## In the browser: the code checks

Works with any bundler and needs no Node polyfills.

```ts
import { validate, fixes } from "@dcl-regenesislabs/wearable-validator";

const bytes = new Uint8Array(await file.arrayBuffer()); // a Builder .zip or a bare .glb
const result = await validate(bytes);

result.passed; // true, false, or null when not everything was checked (a bare .glb, a subset, a skipped check)
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

## Options

| Option | What it does |
| --- | --- |
| `checks` | Run only these checks by name (`"triangle-count"`; rule ids like `"M-01"` work too). The verdict becomes `null`. |
| `groups` | `files`, `model`, `emote`, `content` (the default set) and `rendering`. |
| `category`, `itemType` | Hints for a bare `.glb`, which carries no metadata. |
| `onProgress` | Called as each check starts and finishes, for a live UI. |
| `signal` | An `AbortSignal` to cancel the run. |
| `captures`, `services` | The visual checks, above. |

## The result

- `passed`: `true` or `false`; `null` when not everything was checked (a bare `.glb`, a subset of checks, or a row that was `skipped` or `errored`: its `skipReason` says why).
- `summary`: `{ errors, warnings, checked, skipped }`.
- `checks[]`: one row per check, with `status` (`passed`, `failed`, `warning`, `skipped` or `errored`), `measured` and `skipReason`.
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

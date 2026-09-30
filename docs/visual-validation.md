# Visual validation (Phase 4)

**Status.** Four visual checks are built and share one capture recipe: `render-valid` (V-01, deterministic pixels), `thumbnail-honesty` (V-05), `visual-quality` (V-02 clipping, V-03 skinning, V-04 textures, V-06 scale in one model call, findings tagged with the rule they map to) and `emote-quality` (V-07). Every rule is one folder under `src/checks/rendering/`; the renderer (`src/adapters/native.ts`, the native render server), the model call (`src/adapters/ai.ts`), the capture helper (`src/logic/captures.ts`) and the review round-trip (`src/logic/review.ts`) are shared. A wearable costs twelve captures rendered once and two model calls; an emote the same. The validation job (`packages/job/src/logic/review-job.ts`) runs them for every item of a collection the Builder publishes.

**Renderer.** Every view is drawn by the native render server: the avatar-preview-renderer's Unity scene as a Linux player that draws on the CPU with Mesa, no browser ([unity-explorer PR #10268](https://github.com/decentraland/unity-explorer/pull/10268) with PR #10053's camera controls, plus jobs for local items and worn, posed views; release `render-server-1`). One long-running process takes a JSON job per line on stdin and answers a JSON line per job; each job loads the item once and shoots all its yaws and clip moments, so a view's framing never depends on what was drawn before it.

## How to run

The visual checks run inside the validation job (`packages/job`): `npm run poc` runs the whole path on a laptop with
Docker — a real SQS queue, a stand-in Builder and the job rendering each item on the render server in Docker
(`packages/job/render-server-docker.sh`, which builds its image from the pinned release on first use). Set
`ANTHROPIC_OAUTH_SETUP_TOKEN` (a `claude setup-token`) for the model calls; without it the items render and the checks
that ask the model are not answered. The library's own tests drive both adapters against stand-ins.

Ground rules (CLAUDE.md, restated for this phase):

- Adapters fail soft. `Renderer.capture` throws only on renderer crashes (→ `errored`); `Reviewer.review` rejects only on abort and otherwise resolves a `ReviewResult` union (`ok: false` keeps model/usage/raw text); helpers return `T | string` where the string is the creator-facing skip reason — the `appliesTo` `true | "reason"` idiom. No error classes.
- Every number lives once in `manifest.json` (`rendering`, `ai`, `thumbnailHonesty`); code holds structural constants only (job fields, PNG magic) with a one-line why.
- The prompt is registry metadata: `CheckDefinition.prompt`. A digest pin in the test forces a `promptVersion` bump when the text changes.
- Node-only code lives only in `/native`, `/ai`, `packages/job` and `tools/`; the job imports the library by package name only. Root entry stays isomorphic (`captures.ts` and the check use `crypto.subtle`, `fast-png`, `image-size`, `jpeg-js`).
- Nothing is recorded "on the side": everything a check saw and decided is in the `Result` — `Result.captures`, and `CheckResult.review` for the model's answer.

---

## 1. Reading path

The code in the order a review runs. Files in reading order inside `packages/wearable-validator/src/`: `types.ts` (the contracts) → `adapters/native.ts` → `logic/captures.ts` → `checks/rendering/thumbnail-honesty/index.ts` → `adapters/ai.ts`. Each opens with a 3–6 line header naming the previous and next hop.

| Hop | Evidence | File · function | What happens |
|---|---|---|---|
| 0 | — | `packages/job/src/logic/review-job.ts` · `validateItem()` | Code checks → `renderer.forItem()` (`createNativeRenderer({ command, build })`) and the reviewer (`createPiReviewer({ credentials })`) → `validate(input, { checks: VISUAL_CHECKS, services })` |
| 1 | — | `src/validate.ts` · `validate()` | Selects the check, deep-copies files/item, sets `ctx.services/captures/signal`, runs `appliesTo` (facial category → absent), calls `run(ctx)` |
| 2 | — | `src/checks/rendering/thumbnail-honesty/index.ts` · `run()` → `readThumbnail()`, `captureRequests()` | Validates the thumbnail bytes; expands `manifest.thumbnailHonesty` into 12 `CaptureRequest`s (`BaseMale-avatar-000` … `BaseFemale-wearable-180`) via `captures.captureRequest()` |
| 3 | `captures/captures.json` | `src/logic/captures.ts` · `resolveCaptures()` | Keeps every supplied capture that passes `validCapture()`, asks `services.renderer` for the rest, verifies every key came back, writes the ordered list to `ctx.captures` |
| 4 | `captures/BaseMale-avatar-000.png` … | `src/adapters/native.ts` · `createNativeRenderer().capture()` → `groupRequests()` → `jobFor()` | Writes the item's files to the work folder, sends one job per body shape, view, pose and skin to the render server, reads back one PNG per requested view |
| 5 | `thumbnail-honesty/1-prompt.md` | `src/checks/rendering/thumbnail-honesty/index.ts` · `run()` → `imageLabel()` | `ReviewRequest = { check, prompt: thumbnailPrompt, promptDigest, images: [12 labeled captures, thumbnail last] }` |
| 6 | `thumbnail-honesty/2-context.json`, `3-answer.json` | `src/adapters/ai.ts` · `createPiReviewer().review()` → `reviewMessages()`, `configurePayload()`, `parseResponse()` | One `complete()` call over OAuth with `output_config` json_schema, thinking 1024, no tools, no retries → `{ ok, answer | reason, metadata }` |
| 7 | `thumbnail-honesty/4-finding.json` | `src/checks/rendering/thumbnail-honesty/index.ts` · `parseThumbnailAnswer()` → `thumbnailFinding()` | `matches` → passed; `mismatch` → warning findings (`where: thumbnail.png`, `evidence: [{ captureId }]`); `inconclusive`, `ok: false` or malformed → errored with `review` metadata |
| 8 | `Result` | `src/validate.ts` · `normalizeExecution()`, `computePassed()`; `packages/job/src/logic/review-job.ts` · `itemResult()` | Cross-checks status vs findings, `passed: null` (subset), `Result.captures` and `checks[0].review` populated; the job maps it to the Builder's result |

---

## 2. File list

Twelve files carry the phase (5 with logic, 5 tests, 1 launcher pair, 1 doc). Everything else is a one-line edit listed at the end.

| # | Path | ~lines | Exports / signatures | Why this file exists |
|---|---|---|---|---|
| 1 | `packages/wearable-validator/src/types.ts`  | +75 | In one block `// Visual validation` at the bottom: `CaptureRequest { id; key; inputDigest; rendererBuild; recipeVersion; bodyShape; mainFile; view: "avatar" \| "wearable"; azimuthDegrees; timeFraction?; size }` · `CaptureRecord { request; bytes: Uint8Array; sha256; width; height }` (always PNG) · `RenderInput { files; item; itemType; category }` · `Renderer { buildId; capture(input, requests, signal?): Promise<CaptureRecord[]>; stop(): Promise<void> }` · `Prompt { version; system; instructions; schema: Record<string, unknown> }` · `ReviewImage { id; label; bytes; mimeType: "image/png" \| "image/jpeg" }` · `ReviewRequest { check; prompt: Prompt; promptDigest; images }` · `ReviewMetadata { provider; model; promptVersion; promptDigest; stopReason?; usage?: { input; output; cacheRead; cacheWrite; cost }; images?: { id; sha256 }[]; /** raw model text — result.json alone reproduces the review */ answer?: string }` · `type ReviewResult = { ok: true; answer: unknown; metadata } \| { ok: false; reason: string; metadata }` · `Reviewer { review(request, signal?): Promise<ReviewResult> }` · `Services { renderer?; reviewer? }` · `Finding.evidence?: { captureId }[]` · `CheckExecution` (as on the working tree) · `CheckResult.coverage/review` · `Result.captures` · `Options.captures?/services?/signal?` (no `rendererBuild`) · `CheckContext` the same three · `CheckDefinition.prompt?: Prompt` (replaces `requiresReview`) | One bag of interfaces, unprefixed like every other name in the file; kills the `visual-types.ts` circular import. `id` doubles as the PNG file stem and the image id the model is told. |
| 2 | `packages/wearable-validator/src/logic/captures.ts` (isomorphic) | ~120 | `digest(bytes): Promise<string>` · `digestJson(value): Promise<string>` (sha256 of recursively key-sorted JSON) · `inputDigest(ctx): Promise<string>` (sorted `[path, sha256]` of declared files + category/itemType/representations/hides/replaces/loop/springBones; call after the check verified the files exist) · `rendererBuild(ctx): string \| undefined` (`services.renderer.buildId`, else the one build every supplied capture shares; `undefined` for none or mixed — named, tested, no hidden inference) · `captureRequest(ctx, fields: Omit<CaptureRequest, "id" \| "key">): Promise<CaptureRequest>` (fills `id = <Shape>-<view>-<azimuth %03d>[-t<fraction>]` and `key = digestJson({ ...fields, scene: { profile, background, skin, wearablePose, wearablePoseFraction } })` from `manifest.rendering`) · `validCapture(capture, request, maxBytes): Promise<boolean>` · `resolveCaptures(ctx, requests): Promise<CaptureRecord[] \| string>` | The only generic visual-evidence helper; pure functions with one-line invariants shared by every future rule. |
| 3 | `packages/wearable-validator/src/checks/rendering/thumbnail-honesty/index.ts`  | ~260 | Top to bottom: `export const thumbnailPrompt: Prompt` (v4 system + instructions + schema verbatim; `version: manifest.thumbnailHonesty.promptVersion`) · `export interface ThumbnailAnswer` · `export function parseThumbnailAnswer(value, imageIds, limits: { maxFindings; maxTextLength }): ThumbnailAnswer \| string` · `function readThumbnail(ctx): ReviewImage \| string` · `async function captureRequests(ctx, build): Promise<CaptureRequest[] \| string>` · `function imageLabel(request): string` · `function thumbnailFinding(message, extra): Finding` · `const skipped/errored` · `export const thumbnailHonestyCheck: CheckDefinition = { name: "thumbnail-honesty", group: "rendering", rule: "V-05", title, describe, prompt: thumbnailPrompt, appliesTo, run }` | The rule is the file, like `checks/emote.ts`: prompt, schema, recipe and verdict mapping beside the `CheckDefinition`. Numbers from `ctx.manifest.thumbnailHonesty`, `.ai`, `.fileSize`, `.facialCategories`. |
| 4 | `packages/wearable-validator/src/adapters/native.ts` (`/native` entry, node-only) | ~220 | `createNativeRenderer({ command, build, workDirectory?, onCapture?, onLog? }): Promise<Renderer>` · `probeRenderServer()` | Drives the native render server over stdin/stdout and maps its stills back to `CaptureRequest`s |
| 5 | `packages/job/render-server.sh`, `render-server-user.sh`, `render-server-docker.sh` | ~60 | — | Start the render server as the `renderer` user inside the image, or in Docker on a laptop |
| 6 | `packages/wearable-validator/src/adapters/ai.ts` (`/ai` entry; rewrite of 4 files) | ~180 | `PiReviewerOptions { credentials: CredentialStore; model?; cache?: "none" \| "short"; fetch? }` · `createPiReviewer(options): Reviewer` · `reviewMessages(request): Context` (exported: the CLI writes `2-context.json` from the same function that builds the call) · `configurePayload(body, schema, cacheImages): void` (exported for the breakpoint test) · internal in call order: `estimateTokens`, `requireOAuth`, `parseResponse`, `failureText` | One outbound call readable top to bottom (comms-gatekeeper shape: auth gate → budget → build → send → narrow parse → fail soft). `review()` rejects only on abort. |
| 7 | `packages/wearable-validator/src/logic/captures.test.ts`  | ~90 | — | `digestJson` key-order independence; `validCapture` rejects wrong size / wrong sha / non-PNG / other request; `rendererBuild` picks the renderer, else the single shared build, else `undefined` for mixed; `resolveCaptures` returns a reason without renderer, renders only missing keys, rejects a renderer that returns fewer keys, writes back to `ctx.captures`. PNGs from `test/helpers/synthetic.ts pngBytes`. |
| 8 | `packages/wearable-validator/src/checks/rendering/thumbnail-honesty/index.test.ts`  | ~230 | — | Fake `Renderer` (counts requests) + fake `Reviewer` (scripted `ReviewResult`) through `validate()`; capture reuse, skips, verdict mapping, malformed answers, abort. Plus the prompt digest pin and the registry rule "every check with `prompt` is group `rendering` and `prompt.version === manifest[camelCase(name)].promptVersion`". |
| 9 | `packages/wearable-validator/src/adapters/native.test.ts` | ~120 | — | A stand-in render server with the same protocol: job grouping, file URLs, build mismatch, a server that cannot start, models that point outside themselves |
| 10 | `packages/wearable-validator/src/adapters/ai.test.ts`  | ~140 | — | Injected-fetch SSE fixture: Bearer OAuth and no `x-api-key`, no tools, `output_config.format.schema`, instructions last, truncation/non-JSON → `ok: false` after one call with usage kept, missing/api_key credential → `ok: false` with zero fetches, `configurePayload(..., true)` breakpoint on the last image only. |
| 14 | `docs/visual-validation.md` (this document) | — | — | Status → how to run → reading path → files → bundle → manifest → gotchas → later rules. |

**Touched, no new files:** `registry.ts` (lists `thumbnailHonestyCheck` last); `manifest.json` + `manifest/index.ts` (§4, explicit interfaces); `explanations.ts` / `fixes.ts` / `details.ts` / `docs-links.ts` / `source-links.json` (`npm run gen:sources`); `validate.ts` (executions, coverage, captures, signal, the files/item deep copy when a rendering check runs); `index.ts` (type re-exports); `cli.ts` (`checks` prints `prompt v4`, findings print evidence ids); `package.json` (`./rendering`, `./ai` exports, exact optional peers); `README.md`; `packages/wearable-validator/README.md`.

---

## 4. Manifest keys — one place per number

```jsonc
"fileSize": {                       // … the item limits, plus the zip bounds loader.ts enforces before and while inflating
  "maxEntries": 256,                                                    // entries per zip (files and folders), from the end-of-central-directory record before anything is parsed
  "maxUncompressedBytes": 268435456, "maxEntryUncompressedBytes": 268435456   // declared sizes are checked first; the real bytes are counted chunk by chunk and the inflater is stopped the moment either cap is passed (headers can lie)
},
"images": {
  "maxDecodePixels": 16777216,      // header width × height above which nothing decodes an image to pixels (4096×4096): qr-code reports "too large to scan", thumbnail / file-format judge the header, decodePngSafe returns undefined; an unreadable header is treated the same way
  "maxScanPixels": 67108864         // pixels qr-code decodes across all of an item's textures (many entries can point at one image); the rest is one "not scanned" warning
},
"gltf": {                           // … the extension allowlist, plus
  "maxUnpackedBytes": 268435456     // accessors (count × element size) plus embedded images: what parsing a model allocates, read from the JSON and refused before gltf-transform allocates it; every accessor must also fit inside its buffer view
},
"rendering": {                      // the renderer, shared by every visual rule — read by native.ts and captures.captureRequest
  "imageSizePx": 512,
  "bodyShapes": ["urn:decentraland:off-chain:base-avatars:BaseMale", "urn:decentraland:off-chain:base-avatars:BaseFemale"],
  "background": "444444", "skin": "e8b89a",
  "wearablePose": "fist-pump", "wearablePoseFraction": 0,                 // part of every capture key (scene)
  "loadTimeoutMs": 180000,                                                  // one render server job's deadline
  "maxCaptureBytes": 8388608
},
"ai": {                             // the one call, shared by every AI-backed rule — read only by ai.ts (+ maxTextLength by parsers)
  "model": "claude-sonnet-5",
  "maxInputTokens": 40000, "maxImages": 21, "timeoutMs": 120000, "maxRetries": 0,
  "thinkingBudgetTokens": 1024, "imagePixelsPerToken": 750, "textCharactersPerToken": 3, "maxTextLength": 1200
},
"thumbnailHonesty": {               // V-05 only — a flat per-topic block beside thumbnail / hands / emote, HEAD style
  "promptVersion": 4, "recipeVersion": 1,
  "views": { "wearable": ["avatar", "wearable"], "emote": ["avatar"] },
  "azimuthDegrees": { "wearable": [0, 90, 180], "emote": [0, 90] },     // 180 added after rear art was mistaken for the front
  "stress": {                       // V-02's motion pass: worn, front and side, two clip moments per category, skin chroma green
    "skin": "00ff00", "azimuthDegrees": [0, 90],
    "poses": { "arms": [dab 0.5, clap 0.5], "legs": [run 0.25, jump 0.75], "head": [head-explode 0.25, dab 0.5], "body": [dab 0.5, run 0.25] },
    "categoryPoses": { "upper_body": "arms", "lower_body": "legs", "hat": "head", … }   // unlisted categories use "body"
  },
  "emoteFractions": [0, 0.25, 0.5, 0.75, 1],           // five moments: the quarter frames are where mid-motion clipping and sliding show
  "maxCaptures": 20, "maxFindings": 8
}
```

`manifest/index.ts` spells every key out in the `Manifest` interface (`rendering: { imageSizePx: number; … maxCaptureBytes: number }`, `ai: { … }`, `thumbnailHonesty: { promptVersion: number; recipeVersion: number; views: { wearable: ("avatar" | "wearable")[]; emote: (…)[] }; azimuthDegrees: { wearable: number[]; emote: number[] }; emoteFractions: number[]; maxCaptures: number; maxFindings: number }`) — no `typeof manifestJson`. No key is renamed; keys only change block.

Moves out or collapses: `rendering.experiment` (its duplicates of previewVersion / imageSizePx / timeouts / background / normalSkin collapse into `rendering`); `rendering.thumbnailHonesty` + `ai.thumbnailHonesty` (split into the three blocks above); `ai.thumbnailHonesty.cache` (a CLI flag); `ai.oauthLock` (a dev-tool file-lock setting for the old session file; gone with it — the setup token lives in memory, `/ai` `setupTokenCredentials()`); the second and third `previewVersion` (lives only in `rendering-build.json`). `fileSize.thumbnailBytes` / `thumbnailMaxSize` / `facialCategories` are reused, not duplicated.

---

## 5. Verified-facts checklist → file · function · the why-comment

Renderer (`packages/wearable-validator/src/adapters/native.ts` unless noted):

| Fact | Home | One-line why-comment at that line |
|---|---|---|
| One process, JSON jobs in, JSON lines out; boot lines ignored | `startServer()` | `// Unity prints a few boot lines to stdout too: only JSON lines are results` |
| Local items load in builder mode; worn views take a pose clip | unity-explorer `RenderServer.cs` · `RenderAsync()` | `// The marketplace mode resolves urns only; a local item loads the way the builder previews one` |
| One job per body shape, view, pose and skin | `groupRequests()`, `jobFor()` | `/** One job per body shape, view, pose and skin: the server draws every yaw and time of a job from one load. */` |
| Its own user, its own pipes | `packages/job/render-server.sh`, `render-server-user.sh` | `# the player reopens its log and results by path, and a pipe inherited from another user refuses that` |
| Its own process group | `startServer()` | `// its own process group: the display and the player go down with it` |
| Never a model pointing outside itself | `assertSelfContained()` | `// the player would fetch any URI a model names, from inside the server's network` |
| buildId = release + sha256 | `createNativeRenderer()`; `RENDER_SERVER_BUILD` in the Dockerfile | `/** Identity of the player build (its release and sha256): part of buildId, so another build's stills are never reused. */` |
| Packaging pins | `package.json`, `packages/job/package.json` | `@earendil-works/pi-ai 0.84.1`; the render server by release and sha256 |
| Registry surfaces, `CODE_CHECK_COUNT` | `explanations/fixes/details/docs-links.ts`, `source-links.json`, `app.tsx` | test-enforced |

AI (`packages/wearable-validator/src/adapters/ai.ts` unless noted):

| Fact | Home | One-line why-comment |
|---|---|---|
| `createModels` + `anthropicProvider` OAuth only; `getModel`; `hasApi` + image | `createPiReviewer()` | `// setProvider with auth: { oauth } only — api-key auth is removed on purpose` |
| Credential gate before network; Bearer, no x-api-key | `requireOAuth()` | `// type "oauth" and access sk-ant-oat… or { ok: false } before any fetch` |
| `complete()` options; `onPayload` json_schema; no tools; last-image cache breakpoint; SSE | `review()`, `reviewMessages()`, `configurePayload()` | `// output_config.format json_schema, no tools, maxRetries 0; cache "short" strips every cache_control and marks the LAST image so the prefix is the shared images and the suffix the rule text` |
| Budget pre/post | `estimateTokens()`, `parseResponse()` | `// ceil(chars/3) + Σ ceil(w·h/750) ≤ maxInputTokens, 1..maxImages; after the call input+cacheRead+cacheWrite ≤ maxInputTokens` |
| Response gates + metadata + redaction | `parseResponse()`, `failureText()` | `// ok only when stopReason "stop", rawStopReason ≠ "refusal", no toolCall blocks, JSON parses; metadata (usage, stopReason, raw text) survives every failure; sk-* and Bearer redacted; 401/429/404 mapped` |
| Model pin, prompt v4, digest `9df22b60…` | `manifest.ai.model`, `manifest.thumbnailHonesty.promptVersion`, test pin | `// digest = sha256 of canonical { version, schema, system, instructions } — a text change without a version bump fails the pin` |
| Prompt content that fixed real failures | `thumbnailPrompt` literal header | `// v3 → v4: corresponding-sides rule after thumbnail-hsd3yC produced a self-contradicting front/back mismatch` |
| Schema + parse rules → status mapping | `parseThumbnailAnswer()`, `run()` | `// reviewedCaptureIds must be exactly the supplied ids; each finding cites thumbnail + ≥1 render; mismatch ⇔ findings non-empty; inconclusive → errored + coverage missing` |
| OAuth credential | `packages/wearable-validator/src/adapters/ai.ts` · `setupTokenCredentials()` | `// a claude setup-token lives about a year and is itself the bearer, not a refresh token` |
| Smoke proof (two runs, identical captures) | this doc, Status line | prose only |

---

## Render performance

The native render server replaced Chromium on 2026-09-26. Same five sample items, 20 views each: 18–22 s per item end to end (code checks included) with 4 vCPU under x86 emulation on an Apple Silicon Mac, where the Chromium path took 34–42 s natively on the same Mac and about a minute on a 4-vCPU server. A still takes about 0.3 s once the item is loaded. Chromium's stills carried a floor shadow and a soft glow and were about 15% darker; the recipe, framing and poses are the same.

## 6. What is still open

- Of the Rule Book's larger recipe, the animation clips and the chroma-key clipping pass exist as the motion pass (`rendering.stress`: two clip moments per category, worn, front and side, skin chroma green, judged by `visual-quality`); the 8-step turntable, outfit combinations and contact sheets are not built. The renderer already accepts `pose` on a capture request, so animated poses are a recipe change plus a prompt bump when a labeled fixture set shows rest-pose views miss real clipping.
- Accuracy is measured on two items only. A labeled set of known-good and known-bad items is the next thing to build before any finding can become more than advisory.
- Aggregation and policy (`Result.identity`, shadow / advisory / review / block profiles) do not exist; `passed` stays null for every visual run.
- Idempotency: the Builder may send the same `validationId` again; the job has no store to recognise it and validates it again. Also open: a daily spend cap.
- The render server's local-item jobs and worn views (branch `feat/render-server-local-items`, on top of unity-explorer PR #10268 and PR #10053) are not upstream yet.

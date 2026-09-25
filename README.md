# wearable-validator

A shared validator for new Decentraland wearable and emote submissions, designed for Builder integration and server-side validation. It checks the item’s files together with the metadata, representations, and content list supplied by the caller.

The standalone website is a debug and showcase surface: bare GLB uploads run the available file/model checks, while published items and bundled samples demonstrate richer item context. A GLB does not need to embed Decentraland metadata: Builder or the server supplies it through `validate({ files, metadata, content })`. S-03 validates supplied item metadata with the official `Wearable.validate` or `Emote.validate` schema and reports field paths and values. Builder ZIP manifests use their smaller required-field checks; bare GLBs remain partial runs.

Mandated by [DAO proposal e2a13c58](https://decentraland.org/governance/proposal/?id=e2a13c58-d66d-412d-802f-83190d063636): automate the objective half of wearable curation.

## Try it

```bash
npm install

# the website: drop a GLB and choose its type/category to check its limits
npm run dev

# the CLI
cd packages/wearable-validator
npx tsx src/cli.ts validate my-wearable.zip
npx tsx src/cli.ts validate model.glb --item-type wearable --category hat
npx tsx src/cli.ts validate my-wearable.zip --checks triangle-count,skeleton
npx tsx src/cli.ts checks        # list all checks with plain-language explanations

# validate real published catalyst items
npm run catalyst -- --wearables 15 --emotes 10
```

## What's here

| | |
|---|---|
| `packages/wearable-validator` | the published package: 35 deterministic checks (files · model · emote · content) plus four visual checks (render-valid, thumbnail-honesty, visual-quality, emote-quality), rules manifest, CLI. One folder per check under `src/checks/<group>/<name>/` (algorithm, creator-facing text and tests together); shared algorithms in `src/logic/`; Node-only adapters in `src/adapters/` (`/rendering`, `/ai`). The root entry is isomorphic — the website runs it fully in the browser |
| `packages/server` | the run server (`wearable-validator-server`): renders the item with the Unity build in headless Chromium, calls the vision model, streams every step over SSE and keeps one folder per run (owner-scoped); the terminal runner `npm run review`; the Docker image (`Dockerfile`). Run folders land in gitignored `packages/server/artifacts/` |
| `packages/web` | the website (`wearable-validator-web`): upload → filterable per-rule results with separate values, requirements, and colored status labels (including on mobile), inspectable metadata fields, plain explanations, concrete how-to-fix steps, exact-section docs links, a live 3D preview, and the Visual review panel when a run server answers `/api`; `worker.ts` is the Cloudflare Worker that serves it and forwards `/api/*` |
| `tools` | catalyst runner (validate published items), sample generator, renderer probe |

Server and web import the library only by package name (`@dcl-regenesislabs/wearable-validator`, `/rendering`, `/ai`). Requirement labels are formatted in the website; the package owns the manifest values and category-dependent limit calculations.

Every check carries a rule-book ID (`M-01`…), a plain-language explanation, fix guidance, and a docs link — all exported from the package (`checks`, `explanations`, `fixes`) so no surface can drift from the code.

To add or change a rule, follow [docs/adding-a-check.md](docs/adding-a-check.md): one folder per check, numbers in the manifest, tests beside the code.

Visual validation (Phase 4): the item is rendered headlessly on both body shapes once, then pinned vision calls judge the thumbnail, clipping, skinning, textures and scale (wearables) or pose, grounding, ending and motion (emotes). Every run writes a folder you can open — screenshots, the prompt, the exact context sent to the model, the raw answer and the finding. See [docs/visual-validation.md](docs/visual-validation.md).

```sh
npx playwright-core install chromium --no-shell
# once: put the Unity build from unity-explorer PR #10053 in packages/server/renderer-build/ (see docs/visual-validation.md)
# the website with live visual review: builds the site and serves it with the run server at http://127.0.0.1:4180
ANTHROPIC_OAUTH_SETUP_TOKEN=<claude setup-token> npm run serve   # drop a zip → when the code checks pass, screenshots and the two model answers stream in on their own; with errors, press "Render and review anyway"
# or from the terminal
npm run review -- packages/web/public/samples/upper_body.zip --no-ai   # renders + writes the prompt, no spend
npm run review -- packages/web/public/samples/upper_body.zip \
  --from packages/server/artifacts/visual-upper_body-XXXXXX            # with the token set: reuses the renders, two model calls
npm run review -- https://decentraland.org/shop/item/0x…/12 --no-ai     # a published item: a shop item URL or a URN, fetched from the catalyst
```

Leave out the token and the server renders and writes the prompt without calling the model. The terminal shows one line per event (run accepted, code gate, each capture, the model request, the answer with tokens and cost); when hosted, the same process is configured with `PORT`, `HOST`, `ANTHROPIC_OAUTH_SETUP_TOKEN` (a year-long `claude setup-token`, no session file needed), `RENDERER_BUILD`, `ARTIFACTS_DIR`, `CATALYST_URL` (the peer marketplace items are fetched from), the Cloudflare Access variables, `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` + `SITE_URL` (one Slack message per finished run) and logs JSON lines — see [docs/visual-validation.md](docs/visual-validation.md).

## Deploy

Push to `main` deploys the website to wearable-validator.dclregenesislabs.xyz through Cloudflare Workers Builds, behind Cloudflare Access (curators sign in with their email). The Worker forwards `/api/*` to the run server, one container on DigitalOcean App Platform at api.wearable-validator.dclregenesislabs.xyz. Steps in [docs/deployment.md](docs/deployment.md).

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate(zipBytes);
result.passed;    // true | false | null (advisory runs never mint a verdict)
result.findings;  // every problem at once: message, where, measured vs limit, fix, docs
```

## Security regressions

Run `npm run build -w @dcl-regenesislabs/wearable-validator`, then
`node --import tsx --test packages/wearable-validator/test/security.test.ts packages/server/test/security.test.ts packages/web/test/security.test.ts`.
The tests reproduce cyclic GLB hierarchies, PNG inflation beyond the declared
scanlines, duplicate PNG headers, cross-origin reads of the local API, and ZIP
extraction before validation. The cycle test runs in a subprocess with a deadline;
the API test uses a temporary loopback server and fake rendering/review services.

PNG pixel measurements ignore embedded color profiles and text and bound inflation
by the image's scanline layout, including Adam7. `pako` is pinned to 2.2.0 so the
streaming inflation and truncated-input behavior used by this guard stay stable.
ZIP metadata and previews use the package's `unpackZip()` bounds. The API is
same-origin: the website's Worker or Vite proxy forwards `/api`; direct browser
requests from other origins are unsupported. Terminal clients remain supported.

## Browser content-integrity regression

Run `npm run test:browser -w wearable-validator-web`, then open
http://127.0.0.1:4174. The production-bundled scene must show `PASS`: a known
content hash matches, and altered bytes produce a mismatch instead of a crashed
check. This scene reproduced the browser hashing failure before the fix.

Content hashes support both legacy Decentraland `Qm…` whole-file hashes and
UnixFS CIDv1 hashes, in the format declared for each file. They are computed with
Web Crypto (`crypto.subtle`), built into browsers and Node, so no bundler needs
polyfills. Tests compare them with `@dcl/hashing` (a dev dependency only) across
empty files, chunk boundaries and a two-level tree, in Node and the production
browser bundle.

## Emote playback regression

Run `npm run dev` and open
http://localhost:5173/test/emote-playback.html. With internet access, the scene
loads the bundled emote in the hosted previewer and must show `PASS` after testing
Pause, Play, and Restart from a paused position. It checks actual playback events
and button labels; before the fix, commands were ignored and the scene timed out.

## Validation correctness regressions

Run `node --import tsx --test packages/wearable-validator/test/correctness.test.ts`
from the repository root. These cases cover invalid rarity/body-shape metadata,
emote categories, distinct materials with repeated names, per-representation
measurements, bounding-box boundaries, and flat/nested Builder spring settings.
Numeric bounds are compared before display formatting. Metadata checks validate
supplied item metadata against the full platform schema, while Builder manifests
require name/category and a valid rarity when supplied. Run
`node --import tsx --test packages/wearable-validator/test/metadata-schema.test.ts`
for complete wearable/emote fixtures, missing and malformed fields, duplicate
locales, and input-mode regressions.

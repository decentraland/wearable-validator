# wearable-validator

The Decentraland wearable/emote rule book as code (DAO proposal e2a13c58), and the job that applies it to collections published in the Builder. npm monorepo:
`packages/wearable-validator` (published package: 35 deterministic checks + 4 visual checks, manifest, CLI) ·
`packages/job` (the validation job: SQS request → validate every item → signed callback to the Builder; Docker image) ·
`tools` (catalyst runner; `tools/corpus/` holds downloaded catalyst data, blobs gitignored).
Boundary: the job imports the library only by package name (`@dcl-regenesislabs/wearable-validator`, `/native`, `/ai`) — never a relative path into its `src/`. Its tests may import the library's fixtures relatively (`../../wearable-validator/test/helpers/...`): those are not a published surface.
The curators' website and its run server live in the dcl-regenesislabs fork; this repo syncs only the library there.

## Commands

- `npm test` / `npm run typecheck` — full suite (node:test) + tsc, every workspace
- `npm run poc` — the whole job path locally (Docker): SQS queue, stand-in Builder, job; contract in `docs/builder-integration.md`
- `npm run job` — the job against the queue and Builder URLs the environment names (`packages/job/.env.default`)
- `npx tsx src/cli.ts validate <file> [--checks triangle-count] [--groups model]` (from packages/wearable-validator)
- `npm run catalyst -- --wearables 15 --emotes 10` — validate real published items
- Deploy: merge to main → image + dev deploy; GitHub release → prd and npm `latest`: `docs/deployment.md`

## Hard rules

- **Zero crypto.** No contracts, signers, vouchers. ADR-44 signed fetch is request auth only.
- **UX & DevEx are the product.** Readable API names (`triangle-count`, never `M-01` as API — rule IDs are metadata). Every finding is creator-facing: what's wrong, where, measured vs limit, how to fix. All findings at once — never fail-fast.
- **Every number lives in `src/manifest/manifest.json`** — code holds only algorithms. Rules changes are governance acts (version = rules version).
- **One check = one folder.** `src/checks/<group>/<name>/index.ts` holds the `CheckDefinition` (algorithm + `explanation` in plain words, `fix` with concrete steps, `details` on how it measures, `docs` with the exact-section anchor, optional `measure`) and `index.test.ts` holds its tests. The group's `index.ts` lists checks in rule-book order; `registry.ts` derives every surface (explanations, fixes, details, docs links) from the definitions — completeness is test-enforced (`test/registry.test.ts`, `test/source-links.test.ts`). Shared algorithms go to `src/logic/`, Node-only adapters to `src/adapters/` (`/native`, `/ai`). Step-by-step: `docs/adding-a-check.md`.
- Partial runs (check/group subsets, bare GLBs) return `passed: null` — never a verdict.
- The core package stays **isomorphic**: no node builtins, no native deps in `src/` (the renderer and AI are the optional `/native` and `/ai` entries: `/native` drives the Unity render server, AI = pi-ai one pinned call, never an agent loop).

## Style

ESM (`type: module`, `.js`-suffixed relative imports, `node:` builtins), strict minimal tsconfig, kebab-case modules, no barrels beyond a group's `index.ts`, `interface` + string-literal unions, plain `new Error("actionable sentence")`, node:test colocated as `index.test.ts` next to each check (cross-cutting suites stay in `test/`, fixtures in `test/helpers/` imported as `#test/helpers/...`), exact-pin risky deps with a why-comment.

## Reference docs

The RFC (rules + rationale + sources) lives in Notion: "RFC — Wearable & Emote Validator" (DCL Regenesis Labs). The interactive rule book and build plan are Claude artifacts owned by @gonpombo.

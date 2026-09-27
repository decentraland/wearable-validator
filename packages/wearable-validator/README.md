# @dcl-regenesislabs/wearable-validator

Validate Decentraland wearable/emote files and caller-supplied item metadata. Default runs select the 35 deterministic checks. Individual checks return `passed: null`.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate({ files, metadata }, { checks: ["triangle-count"] });
```

For metadata display or previews, `await unpackZip(bytes)` returns `{ files,
emptyFiles }` using the same compressed-size, entry-count and inflation limits as
validation. It throws on unsafe or malformed archives and does not run checks.
Reuse these files instead of extracting uploads with an unbounded ZIP decoder.

The loader rejects cyclic GLB node hierarchies. PNG measurements reject duplicate
headers and excess scanline data, and ignore compressed profiles and text. The
streaming guard pins `pako` to 2.2.0 to preserve its bounded/truncated-input behavior.

The first visual check, `thumbnail-honesty` (V-05), uses the same API with injected `services.renderer` and `services.reviewer`. Pass a previous `result.captures` back as `captures` to reuse renders. Results carry `captures`, per-check `coverage` and `review` provenance (model, prompt version and digest, token usage). Visual discrepancies are advisory warnings; missing evidence, inconclusive answers and provider failures never pass.

Optional Node entries:

- `/native`: `await createNativeRenderer({ command, build })` — drives the avatar-preview-renderer's native render server (a Linux x86_64 Unity player, release `render-server-1` of dcl-regenesislabs/wearable-validator), one long-running process per renderer. Call `renderer.stop()` on shutdown.
- `/ai`: `createPiReviewer({ credentials })` — needs `@earendil-works/pi-ai@0.84.1` and a host-owned Pi `CredentialStore` holding an Anthropic OAuth session. One schema-constrained image request, no tools, no agent loop.

The `/ai` peer is an exact pin on purpose (the provider API is what the answers were verified against); a host that already carries another patch must install with `--legacy-peer-deps` or match the pin. Root imports need none of this. See the repository's [docs/visual-validation.md](https://github.com/dcl-regenesislabs/wearable-validator/blob/main/docs/visual-validation.md) for the run folder every review writes.

## Publishing

The package version is the rules version (`manifest.version`); bump both together in the PR that changes the rules. When that PR merges to `main`, `.github/workflows/release.yml` publishes it with `npm publish --provenance` through npm's trusted publishing (GitHub OIDC). No npm token lives anywhere and nothing is tagged. npm refuses a version it already has, so a library change merged without a bump fails that run: bump the version.

The very first version of a new package has to be published once by hand (`npm publish -w @dcl-regenesislabs/wearable-validator` from a logged-in machine); after that, set the trusted publisher on npmjs.com (package → Settings → Trusted Publisher: this repository, workflow `release.yml`) and every version bump publishes itself.

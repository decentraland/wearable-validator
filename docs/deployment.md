# Deployment

- **Web** — wearable-validator.dclregenesislabs.xyz, Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access: curators sign in with their email, then the site runs the code checks in the browser and the visual review through the run server.
- **Worker** — `packages/web/worker.ts` forwards `/api/*` to `API_ORIGIN` (the run server, set in `wrangler.jsonc`), headers and streamed body intact (SSE included).
- **Backend** — one container (the root `Dockerfile`), deployed through the shared Decentraland pipeline: a merge to `main` deploys dev (`.github/workflows/docker-next.yml`), a GitHub release deploys prd (`docker-release.yml`), and `manual-deployment.yml` deploys any image tag. It runs as a single instance: runs, the queue and their streams live in the process.
- **Identity** — the server verifies the Access JWT the Worker forwards (`packages/server/src/adapters/access.ts`); every run belongs to the email that started it. Access itself is the allow-list, so everyone it lets in is a curator: an operator who sees every run, the stats and the log. Service tokens (the Slack bot) see everything too but change nothing (`POST`/`DELETE` answer 403).
- **Which build is running** — the Docker build reads the commit from the checkout's `.git/HEAD` into `packages/server/build-info.json`; `/api/health` and `/api/stats` answer `build: { version, commit, builtAt, startedAt }`, the startup log line carries the same, and the Slack bot's `stats` question reports it.
- **Self-test** — at startup the server checks the two things a render depends on and says so in the log: the hosts it must reach (`cdn.decentraland.org` for the pinned wrapper, `peer.decentraland.org` for the avatar the previewer loads) and whether Chromium gets a WebGPU device in this container. A render that hangs with an idle CPU is one of those two; `RENDERER_SELF_TEST=0` skips it.
- **Isolation** — creator files are hostile input. The code checks run in a worker thread with a 60 s deadline, so a file that stalls them never blocks the server. Chromium runs inside its own sandbox where the container runtime allows the user namespaces it needs (`CHROMIUM_SANDBOX`, on by default; the startup self-test fails when it cannot start) and gets only `PATH`/`HOME`-style variables, never the server's tokens.
- **Logs** — one JSON line per event on stdout: every API request (caller, status, ms), each run's gate, queue, captures, model calls and result, and the browser's own story (launch, previewer load or failure with the last wrapper messages, page crashes, console errors, retried views). Operators can read the recent lines through `GET /api/logs`. Refused requests (bad Host, no sign-in, 403) are counted in the `refused_requests_total` metric and printed at debug level with the Host hashed; they never enter that log. `GET /metrics` serves the Prometheus registry (HTTP defaults, `runs_accepted_total`, `runs_finished_total{status}`, `render_duration_seconds`, `refused_requests_total{reason}`) on the server itself, outside the Host and sign-in checks, behind `WKC_METRICS_BEARER_TOKEN`; without the token it is served on loopback only.

## One-time setup

### 1. Upload the Unity build

The Docker image downloads the PR #10053 renderer build from a GitHub release asset and checks its sha256. The current one is `renderer-build-2` (sha256 `41c129dd81e909797646353a9525df0245ac7a8213f2a8fa3896c377ece8f52b`), built from unity-explorer branch `feat/validator-capture-controls` with the render-profile parameters (`renderScale`, `hdr`, `shadowMap`, `postProcessing`) that the manifest's `rendering.quality` relies on.

To build it: Unity 6000.5.9f1 with Web Build Support installed under Unity Hub, a unity-explorer checkout on that branch, then `tools/renderer-build/build.sh <unity-explorer dir>` (batch mode, about five minutes; the four files land in `tools/artifacts/avatar-preview-renderer/Build`). Then, with the tarball at `tools/artifacts/renderer-build.tar.gz`:

```sh
gh release create renderer-build-3 tools/artifacts/renderer-build.tar.gz \
  --repo dcl-regenesislabs/wearable-validator \
  --title "renderer-build-3" \
  --notes "Unity Web build of unity-explorer PR #10053 (avatar-preview-renderer). sha256 <sha>"
```

To re-pin after a new Unity build: `COPYFILE_DISABLE=1 tar -czf renderer-build.tar.gz -C <Build dir> avatar-preview-renderer.loader.js avatar-preview-renderer.framework.js avatar-preview-renderer.wasm avatar-preview-renderer.data` (the four files at the tarball's top level and nothing else: without `COPYFILE_DISABLE` macOS adds `._*` metadata entries that GNU tar unpacks as junk files), `shasum -a 256 renderer-build.tar.gz`, create the next release the same way, then update the two `ARG` defaults (`RENDERER_BUILD_URL`, `RENDERER_BUILD_SHA256`) in the root `Dockerfile`.

### 2. Cloudflare Zero Trust (Access)

1. Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `wearable-validator.dclregenesislabs.xyz`.
3. Policy: Allow, include the curators' emails (or the Workspace domain).
4. Save, then copy from the application's overview the **Application Audience (AUD) tag** → `CF_ACCESS_AUD`. The team domain is the slug before `.cloudflareaccess.com` (e.g. `dclregenesislabs`) → `CF_ACCESS_TEAM_DOMAIN`.
5. Settings → Cookie settings → **SameSite attribute: Lax**, so the Access cookie never rides on a request another site starts (the server also refuses cross-site and non-`application/zip` uploads; this is the second lock).

### 3. The run server

A merge to `main` builds the image and deploys it to dev; publishing a GitHub release deploys it to prd; the **Manual deployment** workflow deploys any tag. `.github/workflows/ci.yml` runs typecheck, tests and the build on every pull request. The Unity build stays a release asset of dcl-regenesislabs/wearable-validator (§1), since a release here is a prd deploy.

The first start pulls a large image (Chromium plus the Unity build); the log then shows the self-test: the dependencies it reached and whether WebGPU draws. The run server's environment needs:

The image listens on port 5000 on every interface and answers `/health/live`, like every well-known-components server.

| Variable | Value |
| --- | --- |
| `PUBLIC_HOSTS` | the hostname the server answers on |
| `ANTHROPIC_OAUTH_SETUP_TOKEN` | a `claude setup-token`; without it the server renders and writes the prompt but calls no model |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | the Access application (§2) whose JWT the Worker forwards |
| `OPERATOR_TOKEN` | the Slack bot's shared secret (§5) |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SITE_URL` | run notifications (§5b) |
| `ARTIFACTS_DIR`, `CHROMIUM_PROFILE_DIR` | `/data/artifacts` and `/data/chromium`, the folders the image prepares |

Everything else has a default in `packages/server/.env.default`; the ones a deployment may want to change:

| Variable | Value |
| --- | --- |
| `CATALYST_URL` | the catalyst a run started from a shop item URL or URN fetches the published item from; default `https://peer.decentraland.org` |
| `CATALYST_TIMEOUT_MS` | how long the whole catalyst fetch (lookup and every file) may take before the run ends with "The catalyst did not answer in time — try again in a moment."; default 60000 |
| `MAX_CONCURRENT_RUNS` | renders at once, about one per 2 GB of RAM and 3 vCPU; default 1 |
| `RENDER_COMMAND_TIMEOUT_MS`, `RENDER_LOAD_TIMEOUT_MS`, `RENDER_TOTAL_TIMEOUT_MS` | raise them on a host with few vCPUs: software rendering there is many times slower |

### 4. Workers

Workers & Pages → `wearable-validator` → Settings → Build: build command `npm ci && npm run build -w wearable-validator-web`, deploy command `npx wrangler deploy`. Every push to `main` redeploys the site; `API_ORIGIN` is in `wrangler.jsonc`, nothing to set in the dashboard. Until the Access application (step 2) exists the site is public and the run server answers 401 to everyone; the Access login is what makes the visual review work.

### 5. The Slack bot (or any operator script)

The bot is the one machine caller, so it gets a shared secret instead of a login:

1. Pick a long random secret (32+ characters) and keep it only in the two environments below.
2. The run server's environment → `OPERATOR_TOKEN` = that value, as a secret. Redeploy.
3. Slack bot → environment → `WEARABLE_VALIDATOR_TOKEN` = the same value, encrypted. Its `wearable-validator` skill calls the run server (`API_ORIGIN`) directly with `Authorization: Bearer <token>`; the server compares it in constant time and treats the caller as operator `service:bot`.

Check from a terminal: `curl -s -H "Authorization: Bearer <token>" <API_ORIGIN>/api/stats` answers JSON.

The token is read-only: it never starts or cancels a run (403), and `/api/health` reports `owner: null` for it. Operator endpoints, all JSON: `GET /api/stats` (totals, by day, by curator, average render time, queue), `GET /api/runs?all=1` (every run with its owner), `GET /api/runs/<id>` for any run, `GET /api/logs?limit=200&since=<ISO time>` (the server's recent log lines, kept in memory since the last restart). Rotating the secret is changing the two variables. Cloudflare Access service tokens (a "Service Auth" policy on the application) are also accepted as operators, for a caller that should not hold a shared secret.

### 5b. Slack notifications

Every finished run posts one message to the curators' channel: who sent it, the item's thumbnail, the verdict, what the curator should do (nothing found, look at the views / needs a curator / blocked, with the reasons), the first findings, an **Open run** button to `/?run=<id>` on the site (Cloudflare Access still gates it by email) and, in a thread, the two worn front views. Cancelled runs post nothing; a failed post is one `slack notification failed` warning in the log, the run itself is never affected.

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch, in the workspace.
2. **OAuth & Permissions** → Bot Token Scopes: add `chat:write` and `files:write`.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. In the curators' channel: `/invite @<app name>`.
5. Channel details (click the channel name) → copy the **Channel ID** at the bottom (`C…`).
6. Set the three variables in the run server's environment and redeploy.

| Variable | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | the Bot User OAuth Token; unset disables notifications (one info line at startup) |
| `SLACK_CHANNEL` | the channel id (`C…` / `G…`); required with the token |
| `SITE_URL` | the public site, `https://wearable-validator.dclregenesislabs.xyz`; unset makes the button link relative, with a startup warning |

The thumbnail and the views are uploaded privately to the app (`files.getUploadURLExternal` → upload → `files.completeUploadExternal` without a channel) and shown through `slack_file` blocks; if Slack refuses that block the message is posted again without the picture. Slack's error codes are translated in the log: `not_in_channel` → invite the app, `channel_not_found` → wrong id, `invalid_auth` → wrong token, `missing_scope` → add the two scopes.

### 6. Smoke test

1. Two curators sign in at wearable-validator.dclregenesislabs.xyz (Access login). The Visual review panel header says **Signed in as <email>**.
2. Each drops a zip and gets a streamed run.
3. Each sees only their own runs on the **History** tab (`GET /api/runs`); operators see everyone's (`GET /api/runs?all=1`).
4. Paste the other person's run URL (`/api/runs/<id>/events`) into the browser: `404 { "message": "Unknown run." }`.
5. `curl <API_ORIGIN>/api/health` answers `{ "ok": true, …, "owner": null }`; `curl …/api/runs` answers 401.

## Local development

```sh
# single local owner, no Access, site built into the server at http://127.0.0.1:4180
ANTHROPIC_OAUTH_SETUP_TOKEN=<claude setup-token> npm run serve

# the image itself (defaults: the pinned release asset; to test another build pass BOTH args, the sha256 check has no bypass)
docker build -t wearable-validator-server .
docker build --build-arg RENDERER_BUILD_URL=<url> --build-arg RENDERER_BUILD_SHA256=<sha256 of that tarball> -t wearable-validator-server .
# Chromium's sandbox needs Playwright's seccomp profile (utils/docker/seccomp_profile.json in the Playwright repo)
docker run --rm --shm-size=1g --memory=4g --security-opt seccomp=seccomp_profile.json -p 5000:5000 -e INSECURE_ANONYMOUS=1 wearable-validator-server
```

Leave the token out and the server renders and writes the prompt without calling the model.

## What is not done yet

- ADR-44 signed fetch identity for the Builder (owner = wallet address). The seam is `packages/server/src/adapters/identity.ts` (`Identify`); `localIdentity` and `accessIdentity` are the two providers today.
- Run retention: nothing deletes old run folders, and since the Slack notifications every folder also keeps the upload itself (`input.zip`, served at `/api/runs/<id>/input.zip` to the owner and operators as the site's **Download zip**): budget the disk for the zips as well as the captures, and the folders live only as long as the server's disk until runs move to a database.
- A daily spend cap on model calls.

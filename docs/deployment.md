# Deployment

- **Web** — wearable-validator.dclregenesislabs.xyz, Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access: curators sign in with their email, then the site runs the code checks in the browser and the visual review through the run server.
- **Worker** — `packages/web/worker.ts` forwards `/api/*` to `API_ORIGIN` (the run server, set in `wrangler.jsonc`), headers and streamed body intact (SSE included).
- **Backend** — one container (the root `Dockerfile`), deployed through the shared Decentraland pipeline: a merge to `main` deploys dev (`.github/workflows/docker-next.yml`), a GitHub release deploys prd (`docker-release.yml`), and `manual-deployment.yml` deploys any image tag. It runs as a single instance: runs, the queue and their streams live in the process.
- **Identity** — the server verifies the Access JWT the Worker forwards (`packages/server/src/adapters/access.ts`); every run belongs to the email that started it. Access itself is the allow-list, so everyone it lets in is a curator: an operator who sees every run, the stats and the log. Service tokens (the Slack bot) see everything too but change nothing (`POST`/`DELETE` answer 403).
- **Which build is running** — the Docker build reads the commit from the checkout's `.git/HEAD` into `packages/server/build-info.json`; `/api/health` and `/api/stats` answer `build: { version, commit, builtAt, startedAt }`, the startup log line carries the same, and the Slack bot's `stats` question reports it.
- **Self-test** — at startup the server checks the two things a render depends on and says so in the log: the content servers the render server loads the avatar from (`peer.decentraland.org`) and whether the render server draws here (one still of a stock item). A render that fails with nothing in the log is one of those two; `RENDERER_SELF_TEST=0` skips it.
- **Renderer** — visual reviews render on the native render server: the Unity avatar scene as a Linux x86_64 player that draws on the CPU with Mesa, no browser. The image downloads it from the `render-server-1` release of dcl-regenesislabs/wearable-validator (sha256-checked) and sets `RENDER_SERVER`, `RENDER_SERVER_BUILD` and `RENDER_SERVER_WORK_DIR`. A 20-view item takes about 20 s with 4 vCPU and about 1 GB.
- **Isolation** — creator files are hostile input. The code checks run in a worker thread with a 60 s deadline, so a file that stalls them never blocks the server. The render server runs as its own Linux user, `renderer` (`packages/server/render-server-user.sh` → `render-server.sh`), gets only the variables it needs, and is never handed a model that names a file outside itself; the server runs as `validator` and writes its run folders with umask 077. So an exploit in the player reads neither the server's tokens nor other creators' uploads, and `packages/server/check-renderer-user.sh` proves it against a built image.
- **Logs** — one JSON line per event on stdout: every API request (caller, status, ms), each run's gate, queue, captures, model calls and result, and the render server's start and its failures (with its last log lines). Operators can read the recent lines through `GET /api/logs`. Refused requests (bad Host, no sign-in, 403) are counted in the `refused_requests_total` metric and printed at debug level with the Host hashed; they never enter that log. `GET /metrics` serves the Prometheus registry (HTTP defaults, `runs_accepted_total`, `runs_finished_total{status}`, `render_duration_seconds`, `refused_requests_total{reason}`) on the server itself, outside the Host and sign-in checks, behind `WKC_METRICS_BEARER_TOKEN`; without the token it is served on loopback only.

## One-time setup

### 1. The render server build

The image downloads the render server from a GitHub release asset of dcl-regenesislabs/wearable-validator and checks its sha256: `render-server-1` (sha256 `99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76`). It is the avatar-preview-renderer project from unity-explorer, branch `feat/render-server-local-items`: [PR #10268](https://github.com/decentraland/unity-explorer/pull/10268)'s native server with [PR #10053](https://github.com/decentraland/unity-explorer/pull/10053)'s camera controls, plus jobs that take a local item and worn, posed views.

To build the next one: Unity 6000.5.9f1 with **Linux Build Support (IL2CPP)**, Git LFS pulled, then from the unity-explorer checkout:

```sh
Unity -batchmode -nographics -quit -projectPath avatar-preview-renderer -buildTarget Linux64 -executeMethod Editor.RenderServerBuild.Build
cd avatar-preview-renderer
tar -czf render-server.tar.gz --exclude='*_BackUpThisFolder_ButDontShipItWithYourGame' --exclude='*_DoNotShip' Builds/RenderServer RenderServer
shasum -a 256 render-server.tar.gz
gh release create render-server-2 render-server.tar.gz --repo dcl-regenesislabs/wearable-validator --latest=false
```

Then update the `RENDER_SERVER_RELEASE` / `RENDER_SERVER_SHA256` defaults in the root `Dockerfile` and the defaults in `packages/server/render-server-docker.sh`. Keep it a release of dcl-regenesislabs: a release in this repo is a prd deploy.

### 2. Cloudflare Zero Trust (Access)

1. Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `wearable-validator.dclregenesislabs.xyz`.
3. Policy: Allow, include the curators' emails (or the Workspace domain).
4. Save, then copy from the application's overview the **Application Audience (AUD) tag** → `CF_ACCESS_AUD`. The team domain is the slug before `.cloudflareaccess.com` (e.g. `dclregenesislabs`) → `CF_ACCESS_TEAM_DOMAIN`.
5. Settings → Cookie settings → **SameSite attribute: Lax**, so the Access cookie never rides on a request another site starts (the server also refuses cross-site and non-`application/zip` uploads; this is the second lock).

### 3. The run server

A merge to `main` builds the image and deploys it to dev; publishing a GitHub release deploys it to prd; the **Manual deployment** workflow deploys any tag. `.github/workflows/ci.yml` runs typecheck, tests and the build on every pull request. The Unity build stays a release asset of dcl-regenesislabs/wearable-validator (§1), since a release here is a prd deploy.

The log then shows the self-test: the content servers it reached and whether the render server draws. The run server's environment needs:

The image listens on port 5000 on every interface and answers `/health/live`, like every well-known-components server.

| Variable | Value |
| --- | --- |
| `PUBLIC_HOSTS` | the hostname the server answers on |
| `ANTHROPIC_OAUTH_SETUP_TOKEN` | a `claude setup-token`; without it the server renders and writes the prompt but calls no model |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | the Access application (§2) whose JWT the Worker forwards |
| `OPERATOR_TOKEN` | the Slack bot's shared secret (§5) |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SITE_URL` | run notifications (§5b) |
| `ARTIFACTS_DIR` | `/data/artifacts`, set by the image |

Everything else has a default in `packages/server/.env.default`; the ones a deployment may want to change:

| Variable | Value |
| --- | --- |
| `CATALYST_URL` | the catalyst a run started from a shop item URL or URN fetches the published item from; default `https://peer.decentraland.org` |
| `CATALYST_TIMEOUT_MS` | how long the whole catalyst fetch (lookup and every file) may take before the run ends with "The catalyst did not answer in time — try again in a moment."; default 60000 |
| `MAX_CONCURRENT_RUNS` | renders at once, about one per 1 GB of RAM; default 1 |
| `LP_NUM_THREADS` | Mesa's rendering threads; match the CPU limit (4 in the image) |

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
# single local owner, no Access, site built into the server at http://127.0.0.1:4180; renders run the render server in Docker
ANTHROPIC_OAUTH_SETUP_TOKEN=<claude setup-token> npm run serve

# the image itself (the render server is x86_64: on Apple Silicon Docker runs it emulated)
docker build --platform linux/amd64 -t wearable-validator-server .
docker run --rm --platform linux/amd64 -p 5000:5000 -e INSECURE_ANONYMOUS=1 wearable-validator-server
```

Leave the token out and the server renders and writes the prompt without calling the model.

## What is not done yet

- ADR-44 signed fetch identity for the Builder (owner = wallet address). The seam is `packages/server/src/adapters/identity.ts` (`Identify`); `localIdentity` and `accessIdentity` are the two providers today.
- Run retention: nothing deletes old run folders, and since the Slack notifications every folder also keeps the upload itself (`input.zip`, served at `/api/runs/<id>/input.zip` to the owner and operators as the site's **Download zip**): budget the disk for the zips as well as the captures, and the folders live only as long as the server's disk until runs move to a database.
- A daily spend cap on model calls.

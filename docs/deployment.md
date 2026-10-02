# Deployment

- **The job** — one image (the root `Dockerfile`), deployed through the shared Decentraland pipeline as a queue-triggered
  task: a merge to `main` deploys dev (`.github/workflows/docker-next.yml`), a GitHub release deploys prd
  (`docker-release.yml`), and `manual-deployment.yml` deploys any image tag. A request on the queue starts the task; it
  drains the queue and exits, so nothing runs between collections. The contract with the Builder:
  [builder-integration.md](builder-integration.md).
- **What it reads** — `packages/job/.env.default`: the work queue, the Builder's content and callback URLs, the callback
  secret and the model token. The content and callback URLs are configuration only, never taken from a request.
- **Renderer** — the native render server: the Unity avatar scene as a Linux x86_64 player that draws on the CPU with
  Mesa, no browser. The image downloads it from the `render-server-1` release of dcl-regenesislabs/wearable-validator
  (sha256-checked) and sets `RENDER_SERVER`, `RENDER_SERVER_BUILD` and `RENDER_SERVER_WORK_DIR`. A 20-view item takes
  about 20 s with 4 vCPU and about 1 GB.
- **Isolation** — creator files are hostile input. The code checks run in a worker thread with a deadline. The render
  server runs as its own Linux user, `renderer` (`packages/job/render-server-user.sh` → `render-server.sh`), gets only the
  variables it needs, and is never handed a model that names a file outside the item; the job runs as `validator`. An
  exploit in the player reads neither the model token nor the callback secret.
- **Slack** — with `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`, one message per collection, edited to its verdict, and one
  thread reply per item with every finding, the model's summary and the pictures. The job keeps nothing after it exits,
  so this is the curators' record. A Slack failure only logs; it never changes the result sent to the Builder.
- **Logs** — one JSON line per event on stdout: each collection and item, the render server's start and failures (with
  its last log lines), the model calls, the callback and its retries.

## The render server build

The image downloads the render server from a GitHub release asset of dcl-regenesislabs/wearable-validator and checks its
sha256: `render-server-1` (sha256 `99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76`). It is the
avatar-preview-renderer project from unity-explorer, branch `feat/render-server-local-items`:
[PR #10268](https://github.com/decentraland/unity-explorer/pull/10268)'s native server with
[PR #10053](https://github.com/decentraland/unity-explorer/pull/10053)'s camera controls, plus jobs that take a local
item and worn, posed views.

To build the next one: Unity 6000.5.9f1 with **Linux Build Support (IL2CPP)**, Git LFS pulled, then from the
unity-explorer checkout:

```sh
Unity -batchmode -nographics -quit -projectPath avatar-preview-renderer -buildTarget Linux64 -executeMethod Editor.RenderServerBuild.Build
cd avatar-preview-renderer
tar -czf render-server.tar.gz --exclude='*_BackUpThisFolder_ButDontShipItWithYourGame' --exclude='*_DoNotShip' Builds/RenderServer RenderServer
shasum -a 256 render-server.tar.gz
gh release create render-server-2 render-server.tar.gz --repo dcl-regenesislabs/wearable-validator --latest=false
```

Then update the `RENDER_SERVER_RELEASE` / `RENDER_SERVER_SHA256` defaults in the root `Dockerfile` and in
`packages/job/render-server-docker.sh`.

## Local development

- `npm run poc` — the whole path on a laptop (needs Docker): a real SQS queue (ElasticMQ), a stand-in Builder serving
  a published `.zone` collection's files and checking the callback's signature, and the job rendering in Docker.
- `npm run job` — the job against whatever `WORK_QUEUE_URL` and Builder URLs the environment names; set
  `AWS_ENDPOINT_URL_SQS` for a local queue. Without `RENDER_SERVER` the render server runs in Docker
  (`packages/job/render-server-docker.sh`).

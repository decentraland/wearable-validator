# The validation job's image: the job plus the native render server (a Unity player that draws on the CPU). It drains
# the work queue once and exits (packages/job/.env.default lists what it reads).
#
#   docker build --platform linux/amd64 -t wearable-validator .
#   docker run --rm --memory=4g -e WORK_QUEUE_URL=... -e BUILDER_API_URL=... \
#     -e BUILDER_CALLBACK_SECRET=... -e ANTHROPIC_OAUTH_SETUP_TOKEN=... wearable-validator
#
# Stages: 1. render server download  2. the image (system, app, users, runtime)

# The render server release: too big for git, so a pinned asset checked by sha256
ARG RENDER_SERVER_RELEASE=render-server-1
ARG RENDER_SERVER_SHA256=99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76

# ── 1. Download and verify the render server ────────────────────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS renderserver
ARG RENDER_SERVER_RELEASE
ARG RENDER_SERVER_SHA256
RUN wget -q -O /tmp/render-server.tar.gz \
      "https://github.com/dcl-regenesislabs/wearable-validator/releases/download/$RENDER_SERVER_RELEASE/render-server.tar.gz" \
 && echo "$RENDER_SERVER_SHA256  /tmp/render-server.tar.gz" | sha256sum -c - \
 && mkdir /release && tar -xzf /tmp/render-server.tar.gz -C /release

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node

# ── 2. The image: Ubuntu 24.04, the OS the render server was built and tested on ──────────────────────────────────────
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
ARG RENDER_SERVER_RELEASE
ARG RENDER_SERVER_SHA256

# 2a. System: Mesa (software OpenGL), a virtual display (Xvfb), the X libraries Unity loads, tini, and Node
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
      libgl1 libglx-mesa0 libgl1-mesa-dri xvfb \
      libx11-6 libxcursor1 libxext6 libxi6 libxinerama1 libxrandr2 libxxf86vm1 libglib2.0-0t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# 2b. The render server
COPY --from=renderserver /release/Builds/RenderServer/ /opt/renderer/
RUN chmod +x /opt/renderer/renderer.x86_64

# 2c. The app (dependencies first, so code changes reuse the npm layer)
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/job/package.json packages/job/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/wearable-validator ./packages/wearable-validator
COPY packages/job ./packages/job

# 2d. Users. The render server parses creator models, so it runs as its own user and cannot read the job's
# environment (the model token, the callback secret):
#   validator  runs the job
#   renderer   runs the render server; the job starts it through a setpriv copy that is setuid renderer
#   render     group both share: /data/native (item files in, stills out) and /data/mesa (shader cache)
# /app stays root's, so neither user can replace code that runs.
RUN groupadd --system render \
 && useradd --system --create-home --shell /usr/sbin/nologin validator \
 && useradd --system --gid render --create-home --home-dir /home/renderer --shell /usr/sbin/nologin renderer \
 && usermod -aG render validator \
 && mkdir -p /usr/local/lib/renderer \
 && install -o renderer -g render -m 6750 /usr/bin/setpriv /usr/local/lib/renderer/setpriv \
 && chmod 700 /home/renderer
RUN mkdir -p /data/native /data/mesa /tmp/.X11-unix \
 && chgrp render /data/native /data/mesa && chmod 2770 /data/native /data/mesa \
 && chmod 1777 /tmp/.X11-unix

# 2e. Runtime
ENV LOG_FORMAT=json \
    RENDER_SERVER=/app/packages/job/render-server-user.sh \
    RENDER_SERVER_WORK_DIR=/data/native \
    RENDER_SERVER_BUILD=${RENDER_SERVER_RELEASE}:${RENDER_SERVER_SHA256} \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GALLIUM_DRIVER=llvmpipe \
    LP_NUM_THREADS=4 \
    MESA_SHADER_CACHE_DIR=/data/mesa
USER validator
# tini as PID 1 forwards SIGTERM to the job and reaps the render server's exited processes
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "job", "-w", "wearable-validator-job"]

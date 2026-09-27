# The run server image: the Node server plus the native render server (a Unity player that draws on the CPU).
#
#   docker build --platform linux/amd64 -t wearable-validator-server .
#   docker run --rm --memory=2g -p 5000:5000 -e ANTHROPIC_OAUTH_SETUP_TOKEN=... wearable-validator-server
#
# Stages: 1. commit id  2. render server download  3. the image (system, app, users, runtime)

# The render server release: too big for git, so a pinned asset checked by sha256
ARG RENDER_SERVER_RELEASE=render-server-1
ARG RENDER_SERVER_SHA256=99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76


# ── 1. The commit this image was built from (shown in /api/health) ──────────────────────────────────────────────────
# Only .git/HEAD, refs and packed-refs reach the build context (.dockerignore).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS gitinfo
WORKDIR /src
COPY .git .git
RUN ref=$(sed -n 's/^ref: //p' .git/HEAD); \
    if [ -n "$ref" ] && [ -f ".git/$ref" ]; then sha=$(cat ".git/$ref"); \
    elif [ -n "$ref" ] && [ -f .git/packed-refs ]; then sha=$(grep " $ref$" .git/packed-refs | cut -c1-40); \
    else sha=$(cat .git/HEAD); fi; \
    printf '{"commit":"%s","builtAt":"%s"}' "${sha:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /build-info.json


# ── 2. Download and verify the render server ────────────────────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS renderserver
ARG RENDER_SERVER_RELEASE
ARG RENDER_SERVER_SHA256
RUN wget -q -O /tmp/render-server.tar.gz \
      "https://github.com/dcl-regenesislabs/wearable-validator/releases/download/$RENDER_SERVER_RELEASE/render-server.tar.gz" \
 && echo "$RENDER_SERVER_SHA256  /tmp/render-server.tar.gz" | sha256sum -c - \
 && mkdir /release && tar -xzf /tmp/render-server.tar.gz -C /release

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node


# ── 3. The image: Ubuntu 24.04, the OS the render server was built and tested on ──────────────────────────────────────
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
ARG RENDER_SERVER_RELEASE
ARG RENDER_SERVER_SHA256

# 3a. System: Mesa (software OpenGL), a virtual display (Xvfb), the X libraries Unity loads, and Node
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
      libgl1 libglx-mesa0 libgl1-mesa-dri xvfb \
      libx11-6 libxcursor1 libxext6 libxi6 libxinerama1 libxrandr2 libxxf86vm1 libglib2.0-0t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# 3b. The render server
COPY --from=renderserver /release/Builds/RenderServer/ /opt/renderer/
RUN chmod +x /opt/renderer/renderer.x86_64

# 3c. The app (dependencies first, so code changes reuse the npm layer)
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/wearable-validator ./packages/wearable-validator
COPY packages/server ./packages/server
COPY --from=gitinfo /build-info.json ./packages/server/build-info.json

# 3d. Users. The render server parses creator models, so it runs as its own user and cannot read the server's
# environment or run folders:
#   validator  runs the server; owns /data/artifacts (run folders)
#   renderer   runs the render server; the server starts it through a setpriv copy that is setuid renderer
#   render     group both share: /data/native (item files in, stills out) and /data/mesa (shader cache)
# /app stays root's, so neither user can replace code that runs.
RUN groupadd --system render \
 && useradd --system --create-home --shell /usr/sbin/nologin validator \
 && useradd --system --gid render --create-home --home-dir /home/renderer --shell /usr/sbin/nologin renderer \
 && usermod -aG render validator \
 && mkdir -p /usr/local/lib/renderer \
 && install -o renderer -g render -m 6750 /usr/bin/setpriv /usr/local/lib/renderer/setpriv \
 && chmod 700 /home/renderer
RUN mkdir -p /data/artifacts /data/native /data/mesa /tmp/.X11-unix \
 && chown validator:validator /data/artifacts && chmod 700 /data/artifacts \
 && chgrp render /data/native /data/mesa && chmod 2770 /data/native /data/mesa \
 && chmod 1777 /tmp/.X11-unix

# 3e. Runtime
# 5000: the port every well-known-components server listens on in a container (local runs keep 4180)
ENV HOST=0.0.0.0 \
    PORT=5000 \
    LOG_FORMAT=json \
    ARTIFACTS_DIR=/data/artifacts \
    RENDER_SERVER=/app/packages/server/render-server-user.sh \
    RENDER_SERVER_WORK_DIR=/data/native \
    RENDER_SERVER_BUILD=${RENDER_SERVER_RELEASE}:${RENDER_SERVER_SHA256} \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GALLIUM_DRIVER=llvmpipe \
    LP_NUM_THREADS=4 \
    MESA_SHADER_CACHE_DIR=/data/mesa
USER validator
EXPOSE 5000
# umask 077: run folders stay the server's own, the renderer user cannot read them
CMD ["sh", "-c", "umask 077 && exec npm start -w wearable-validator-server"]

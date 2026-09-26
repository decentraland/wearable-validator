# Run server image: the server plus the native render server (the Unity avatar scene as a Linux player that draws on
# the CPU with Mesa, no browser). Build from the repo root:  docker build --platform linux/amd64 -t wearable-validator-server .
# The render server is x86_64 only. Run:  docker run --rm --memory=2g -p 5000:5000 \
#   -e ANTHROPIC_OAUTH_SETUP_TOKEN=... -e CF_ACCESS_TEAM_DOMAIN=... -e CF_ACCESS_AUD=... wearable-validator-server
# stage 1: the commit this image was built from, read from the checkout's .git (HEAD, refs and packed-refs are the
# only .git files in the build context); the server shows it in /api/health so operators know what is running
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS gitinfo
WORKDIR /src
COPY .git .git
RUN ref=$(sed -n 's/^ref: //p' .git/HEAD); \
    if [ -n "$ref" ] && [ -f ".git/$ref" ]; then sha=$(cat ".git/$ref"); \
    elif [ -n "$ref" ] && [ -f .git/packed-refs ]; then sha=$(grep " $ref$" .git/packed-refs | cut -c1-40); \
    else sha=$(cat .git/HEAD); fi; \
    printf '{"commit":"%s","builtAt":"%s"}' "${sha:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /build-info.json && cat /build-info.json

# stage 2: the render server release, too big for git: a pinned asset, verified before it is unpacked
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS renderserver
ARG RENDER_SERVER_URL=https://github.com/dcl-regenesislabs/wearable-validator/releases/download/render-server-1/render-server.tar.gz
ARG RENDER_SERVER_SHA256=99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76
RUN wget -q -O /tmp/render-server.tar.gz "$RENDER_SERVER_URL" \
  && echo "$RENDER_SERVER_SHA256  /tmp/render-server.tar.gz" | sha256sum -c - \
  && mkdir -p /release && tar -xzf /tmp/render-server.tar.gz -C /release

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node

# the render server was built and tested on Ubuntu 24.04; Node comes from the official image
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
ARG RENDER_SERVER_SHA256=99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgl1 libglx-mesa0 libgl1-mesa-dri xvfb \
       libx11-6 libxcursor1 libxext6 libxi6 libxinerama1 libxrandr2 libxxf86vm1 libglib2.0-0t64 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=renderserver /release/Builds/RenderServer/ /opt/renderer/
ENV LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=4 MESA_SHADER_CACHE_DIR=/data/mesa

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/wearable-validator ./packages/wearable-validator
COPY packages/server ./packages/server
COPY --from=gitinfo /build-info.json ./packages/server/build-info.json
ENV LOG_FORMAT=json
ENV HOST=0.0.0.0
# 5000: the port every well-known-components server listens on in a container (local runs keep 4180)
ENV PORT=5000
# Two users: the server (validator) and the render server (renderer), which parses creator models and so must not read
# the server's environment or run folders. validator steps down through a copy of setpriv that is setuid renderer,
# setgid render; the work folder and Mesa's shader cache belong to the render group both users share.
RUN groupadd --system render \
  && useradd --system --create-home --shell /usr/sbin/nologin validator \
  && useradd --system --gid render --home-dir /home/renderer --create-home --shell /usr/sbin/nologin renderer \
  && usermod -aG render validator \
  && mkdir -p /usr/local/lib/renderer \
  && install -o renderer -g render -m 6750 /usr/bin/setpriv /usr/local/lib/renderer/setpriv \
  && chmod +x /opt/renderer/renderer.x86_64 \
  && mkdir -p /data/artifacts /data/native /data/mesa /tmp/.X11-unix \
  && chown -R validator:validator /app /data/artifacts && chmod 700 /home/renderer /data/artifacts \
  && chgrp render /data/native /data/mesa && chmod 2770 /data/native /data/mesa && chmod 1777 /tmp/.X11-unix
ENV ARTIFACTS_DIR=/data/artifacts
ENV RENDER_SERVER=/app/packages/server/render-server-user.sh RENDER_SERVER_WORK_DIR=/data/native
ENV RENDER_SERVER_BUILD=render-server-1:${RENDER_SERVER_SHA256}
USER validator
EXPOSE 5000
# umask 077: run folders stay the server's own, the renderer user cannot read them
CMD ["sh", "-c", "umask 077 && exec npm start -w wearable-validator-server"]

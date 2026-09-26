# Run server image: Playwright's Chromium (full headless, SwiftShader WebGPU) + the Unity build + the server.
# Build from the repo root:  docker build -t wearable-validator-server .
# The build context is the whole repo. Run:  docker run --rm --shm-size=1g --memory=4g -p 5000:5000 \
#   -e ANTHROPIC_OAUTH_SETUP_TOKEN=... -e CF_ACCESS_TEAM_DOMAIN=... -e CF_ACCESS_AUD=... wearable-validator-server
# Chromium's sandbox needs user namespaces, which Docker's default seccomp profile refuses: add Playwright's profile
# (--security-opt seccomp=<utils/docker/seccomp_profile.json>); the startup self-test says when the sandbox cannot start.
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

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
ARG RENDERER_BUILD_URL=https://github.com/dcl-regenesislabs/wearable-validator/releases/download/renderer-build-2/renderer-build.tar.gz
ARG RENDERER_BUILD_SHA256=41c129dd81e909797646353a9525df0245ac7a8213f2a8fa3896c377ece8f52b
# the native render server: the same Unity scene as a Linux player drawing on the CPU (Mesa llvmpipe), no browser
ARG RENDER_SERVER_URL=https://github.com/dcl-regenesislabs/wearable-validator/releases/download/render-server-1/render-server.tar.gz
ARG RENDER_SERVER_SHA256=99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund --ignore-scripts
# the Playwright image ships Chromium for its own version; playwright-core@1.63.0 must match it
RUN npx playwright-core install chromium --no-shell
# the PR #10053 Unity build is too big for git: a pinned release asset, verified before it is unpacked
RUN curl -fsSL "$RENDERER_BUILD_URL" -o /tmp/renderer-build.tar.gz \
  && echo "$RENDERER_BUILD_SHA256  /tmp/renderer-build.tar.gz" | sha256sum -c - \
  && mkdir -p /app/packages/server/renderer-build \
  && tar -xzf /tmp/renderer-build.tar.gz -C /app/packages/server/renderer-build \
  && rm /tmp/renderer-build.tar.gz
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglx-mesa0 libgl1-mesa-dri xvfb \
       libx11-6 libxcursor1 libxext6 libxi6 libxinerama1 libxrandr2 libxxf86vm1 libglib2.0-0t64 \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "$RENDER_SERVER_URL" -o /tmp/render-server.tar.gz \
  && echo "$RENDER_SERVER_SHA256  /tmp/render-server.tar.gz" | sha256sum -c - \
  && mkdir -p /tmp/render-server /opt/renderer \
  && tar -xzf /tmp/render-server.tar.gz -C /tmp/render-server \
  && cp -R /tmp/render-server/Builds/RenderServer/. /opt/renderer/ \
  && cp /tmp/render-server/RenderServer/entrypoint.sh /opt/renderer/entrypoint.sh \
  && chmod +x /opt/renderer/entrypoint.sh /opt/renderer/renderer.x86_64 \
  && rm -rf /tmp/render-server /tmp/render-server.tar.gz
ENV LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=4 MESA_SHADER_CACHE_DIR=/data/mesa
COPY tsconfig.base.json ./
COPY packages/wearable-validator ./packages/wearable-validator
COPY packages/server ./packages/server
COPY --from=gitinfo /build-info.json ./packages/server/build-info.json
ENV RENDERER_BUILD=/app/packages/server/renderer-build
# Linux Chromium reaches SwiftShader WebGPU only through Vulkan; without those two flags pipeline creation fails.
# Hosted containers often give /dev/shm 64 MB, far too small for this page: --disable-dev-shm-usage moves
# Chromium's shared memory to /tmp. CHROMIUM_ARGS is an operator-trusted knob spliced straight into the launch arguments.
ENV CHROMIUM_ARGS="--enable-features=Vulkan --use-vulkan=swiftshader --disable-dev-shm-usage"
ENV LOG_FORMAT=json
ENV HOST=0.0.0.0
# 5000: the port every well-known-components server listens on in a container (local runs keep 4180)
ENV PORT=5000
# Chromium loads creator-supplied models: never as root. pwuser ships with the Playwright image.
# /data is where a deployment mounts its volumes (run folders, the browser profile); Docker gives a fresh named
# volume the ownership of the image's directory, so it must exist and belong to pwuser or the server cannot write.
RUN mkdir -p /data/artifacts /data/chromium && chown -R pwuser:pwuser /app /data
# Chromium runs as its own user (packages/server/chromium-user.sh), so a renderer exploit cannot read the server's
# environment or the run folders. pwuser steps down through a copy of setpriv that is setuid chrome, setgid render.
RUN groupadd --system render \
  && useradd --system --gid render --home-dir /home/chrome --create-home --shell /usr/sbin/nologin chrome \
  && usermod -aG render pwuser \
  && mkdir -p /usr/local/lib/chromium \
  && install -o chrome -g render -m 6750 /usr/bin/setpriv /usr/local/lib/chromium/setpriv \
  && ln -s "$(node -p "require('playwright-core').chromium.executablePath()")" /usr/local/lib/chromium/chrome \
  && chmod 700 /home/chrome /data/artifacts \
  && chgrp render /data/chromium && chmod 2770 /data/chromium \
  && mkdir -p /data/native /data/mesa && chgrp render /data/native /data/mesa && chmod 2770 /data/native /data/mesa \
  && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
ENV CHROMIUM_EXECUTABLE=/app/packages/server/chromium-user.sh
# visual reviews render on the native server; unset RENDER_SERVER to fall back to Chromium and the Unity Web build
ENV RENDER_SERVER=/app/packages/server/render-server-user.sh RENDER_SERVER_WORK_DIR=/data/native
ENV RENDER_SERVER_BUILD=render-server-1:${RENDER_SERVER_SHA256}
USER pwuser
EXPOSE 5000
# umask 077: run folders stay the server's own, Chromium's user cannot read them
CMD ["sh", "-c", "umask 077 && exec npm start -w wearable-validator-server"]

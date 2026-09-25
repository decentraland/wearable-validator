# Run server image: Playwright's Chromium (full headless, SwiftShader WebGPU) + the Unity build + the server.
# Build from the repo root:  docker build -t wearable-validator-server .
# The build context is the whole repo. Run:  docker run --rm --shm-size=1g --memory=4g -p 4180:4180 \
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
# Chromium loads creator-supplied models: never as root. pwuser ships with the Playwright image.
# /data is where a deployment mounts its volumes (run folders, the browser profile); Docker gives a fresh named
# volume the ownership of the image's directory, so it must exist and belong to pwuser or the server cannot write.
RUN mkdir -p /data/artifacts /data/chromium && chown -R pwuser:pwuser /app /data
USER pwuser
EXPOSE 4180
CMD ["npm", "start", "-w", "wearable-validator-server"]

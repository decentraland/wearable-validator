#!/bin/sh
# Proves the image runs Chromium as its own user, locked out of the server's environment and run folders.
# Usage (repo root): packages/server/check-chromium-user.sh [image]      SANDBOX=1 also turns Chromium's sandbox on.
set -eu
image=${1:-wearable-validator-server}
[ $# -eq 0 ] && docker build -q -t "$image" . >/dev/null
name=wv-chromium-user-check
docker rm -f "$name" >/dev/null 2>&1 || true
if [ "${SANDBOX:-0}" = 1 ]; then
  # the sandbox needs user namespaces: Playwright's seccomp profile for the pinned version allows them
  profile=$(mktemp)
  curl -fsSL https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json -o "$profile"
  sandbox="--security-opt seccomp=$profile -e CHROMIUM_SANDBOX=1"
else
  sandbox="-e CHROMIUM_SANDBOX=0"
fi
# shellcheck disable=SC2086
docker run -d --name "$name" --shm-size=1g $sandbox -e INSECURE_ANONYMOUS=1 -e ARTIFACTS_DIR=/data/artifacts -e CHROMIUM_PROFILE_DIR=/data/chromium -e ANTHROPIC_OAUTH_SETUP_TOKEN=sk-ant-oat01-canary "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT
fail() { echo "FAIL: $1"; exit 1; }
as_chrome() { docker exec "$name" /usr/local/lib/chromium/setpriv --reuid=chrome --regid=render --keep-groups "$@"; }

for _ in $(seq 60); do docker logs "$name" 2>&1 | grep -q "renderer self-test" && break; sleep 2; done
docker logs "$name" 2>&1 | grep -q "renderer self-test passed" || fail "the renderer self-test did not pass: $(docker logs "$name" 2>&1 | grep 'self-test' | tail -1)"

docker cp packages/web/public/samples/earring.zip "$name":/tmp/item.zip
run=$(docker exec "$name" curl -s -X POST "http://127.0.0.1:5000/api/runs?model=0&standalone=1" -H "content-type: application/zip" -H "sec-fetch-site: same-origin" --data-binary @/tmp/item.zip | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')
[ -n "$run" ] || fail "the run did not start"
users=""
for _ in $(seq 120); do users=$(docker exec "$name" ps -C chrome -o user= | sort -u | tr '\n' ' '); [ -n "$users" ] && break; sleep 1; done
[ "$users" = "chrome " ] || fail "Chromium runs as: '${users}'"

server=$(docker exec "$name" pgrep -f "src/index.ts" | head -1)
docker exec "$name" sh -c "tr '\0' '\n' < /proc/$server/environ" | grep -q canary || fail "control: the server's own user cannot read its environment"
as_chrome cat "/proc/$server/environ" >/dev/null 2>&1 && fail "Chromium's user reads the server's environment"
folder=$(docker exec "$name" sh -c "ls -d /data/artifacts/*$run*" 2>/dev/null | head -1)
[ -n "$folder" ] || fail "no run folder for $run"
docker exec "$name" cat "$folder/input.json" >/dev/null || fail "control: the server's own user cannot read the run's input"
as_chrome ls "$folder" >/dev/null 2>&1 && fail "Chromium's user lists the run folder"
as_chrome cat "$folder/input.json" >/dev/null 2>&1 && fail "Chromium's user reads the run's input"

for _ in $(seq 120); do docker exec "$name" curl -s "http://127.0.0.1:5000/api/runs/$run" -H "sec-fetch-site: same-origin" | grep -q '"done":true' && break; sleep 2; done
docker exec "$name" curl -s "http://127.0.0.1:5000/api/runs/$run" -H "sec-fetch-site: same-origin" | grep -q '"check":"render-valid","group":"rendering","status":"passed"' || fail "the render did not pass"
echo "OK: Chromium runs as 'chrome', cannot read the server's environment or run folders, and renders (sandbox ${SANDBOX:-0})"

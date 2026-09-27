#!/bin/sh
# Proves the image renders on the native render server as its own user, locked out of the server's environment and
# run folders. Usage (repo root): packages/server/check-renderer-user.sh [image]   (no image: builds one)
set -eu
image=${1:-wearable-validator-server}
[ $# -eq 0 ] && docker build -q --platform linux/amd64 -t "$image" . >/dev/null
name=wv-renderer-user-check
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --platform linux/amd64 -e INSECURE_ANONYMOUS=1 -e ARTIFACTS_DIR=/data/artifacts -e ANTHROPIC_OAUTH_SETUP_TOKEN=sk-ant-oat01-canary "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT
fail() { echo "FAIL: $1"; exit 1; }
as_renderer() { docker exec "$name" /usr/local/lib/renderer/setpriv --reuid=renderer --regid=render --keep-groups "$@"; }

for _ in $(seq 90); do docker logs "$name" 2>&1 | grep -q "renderer self-test" && break; sleep 2; done
docker logs "$name" 2>&1 | grep -q "renderer self-test passed" || fail "the renderer self-test did not pass: $(docker logs "$name" 2>&1 | grep 'self-test' | tail -1)"

docker cp packages/web/public/samples/upper_body.zip "$name":/tmp/item.zip
run=$(docker exec "$name" sh -c 'node -e "fetch(\"http://127.0.0.1:5000/api/runs?model=0&standalone=1\",{method:\"POST\",headers:{\"content-type\":\"application/zip\",\"sec-fetch-site\":\"same-origin\"},body:require(\"fs\").readFileSync(\"/tmp/item.zip\")}).then(r=>r.json()).then(j=>console.log(j.id))"')
[ -n "$run" ] || fail "the run did not start"
users=""
for _ in $(seq 240); do users=$(docker exec "$name" sh -c 'ps -eo user,args | grep "[r]enderer.x86_64" | cut -d" " -f1 | sort -u'); [ -n "$users" ] && break; sleep 0.25; done
[ "$users" = "renderer" ] || fail "the render server runs as: '${users}'"

server=$(docker exec "$name" pgrep -f "src/index.ts" | head -1)
docker exec "$name" sh -c "tr '\0' '\n' < /proc/$server/environ" | grep -q canary || fail "control: the server's own user cannot read its environment"
as_renderer cat "/proc/$server/environ" >/dev/null 2>&1 && fail "the renderer user reads the server's environment"
folder=$(docker exec "$name" sh -c "ls -d /data/artifacts/*$run*" 2>/dev/null | head -1)
[ -n "$folder" ] || fail "no run folder for $run"
docker exec "$name" cat "$folder/input.json" >/dev/null || fail "control: the server's own user cannot read the run's input"
as_renderer cat "$folder/input.json" >/dev/null 2>&1 && fail "the renderer user reads the run's input"

state() { docker exec "$name" node -e "fetch('http://127.0.0.1:5000/api/runs/$run',{headers:{'sec-fetch-site':'same-origin'}}).then(r=>r.text()).then(console.log)"; }
for _ in $(seq 120); do state | grep -q '"done":true' && break; sleep 2; done
state | grep -q '"check":"render-valid","group":"rendering","status":"passed"' || fail "the render did not pass"
echo "OK: the render server draws as 'renderer', and cannot read the server's environment or run folders"

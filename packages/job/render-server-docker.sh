#!/bin/sh
# The render server on a laptop: it is a Linux x86_64 player, so it runs in Docker. The work folder is mounted at the
# same path, so the file:// URLs and output paths the validator writes mean the same inside the container.
# First use builds the image from the release the server image pins.
set -eu
release="${RENDER_SERVER_RELEASE:-render-server-1}"
sha="${RENDER_SERVER_SHA256:-99f4927a1f044ec3995f59b5610dc97ffaf8d1c4bbb68031fca25f2a4eb4ae76}"
image="wearable-validator-render-server:$release"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  build="$(mktemp -d)"
  curl -fsSL "https://github.com/dcl-regenesislabs/wearable-validator/releases/download/$release/render-server.tar.gz" -o "$build/render-server.tar.gz"
  echo "$sha  $build/render-server.tar.gz" | shasum -a 256 -c - >&2
  tar -xzf "$build/render-server.tar.gz" -C "$build"
  docker build -q --platform linux/amd64 -f "$build/RenderServer/Dockerfile" -t "$image" "$build" >&2
  rm -rf "$build"
fi
out=""
previous=""
for arg; do
  [ "$previous" = "--out" ] && out="$arg"
  previous="$arg"
done
mkdir -p "$out"
exec docker run --rm -i --platform linux/amd64 -e RENDER_SERVER_SIZE -v "$out:$out" "$image" "$@"

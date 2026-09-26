#!/bin/sh
# The render server's virtual display and player, run as Chromium's user by render-server-user.sh. It replaces the
# release's entrypoint.sh because the player reopens its log and results by path, and a pipe inherited from another
# user refuses that: here both are pipes this user creates, relayed to the stdout and stderr the server reads.
set -eu
SIZE="${RENDER_SERVER_SIZE:-1024}"
display=":$((99 + $$ % 100))"
run="$(mktemp -d)"
trap 'kill 0 2>/dev/null; rm -rf "$run"' EXIT INT TERM

Xvfb "$display" -screen 0 "$((SIZE + 64))x$((SIZE + 64))x24" -nolisten tcp >/dev/null 2>&1 &
export DISPLAY="$display"
i=0
while [ ! -e "/tmp/.X11-unix/X${display#:}" ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "Xvfb did not start" >&2; exit 3; }
  sleep 0.1
done

mkfifo "$run/log"
cat "$run/log" >&2 &
# results on descriptor 3, the player's own stdout: a pipe of this shell's, so /dev/fd/3 reopens
/opt/renderer/renderer.x86_64 -logFile "$run/log" -screen-fullscreen 0 -screen-width "$SIZE" -screen-height "$SIZE" \
  --size "$SIZE" --results /dev/fd/3 "$@" 3>&1 | cat

#!/bin/sh
# The render server as its own user: the Unity player parses creator models, so it must not be able to read the
# server's environment or run folders. The files it reads and the stills it writes live in RENDER_SERVER_WORK_DIR,
# whose group (render) both users share.
set -e
umask 007
HOME=/home/renderer exec /usr/local/lib/renderer/setpriv --reuid=renderer --regid=render --keep-groups /app/packages/job/render-server.sh "$@"

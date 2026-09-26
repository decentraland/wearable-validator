#!/bin/sh
# The native render server as its own user, like Chromium (chromium-user.sh): the Unity player parses creator
# models, so it must not be able to read the server's environment or run folders. The files it reads and the stills
# it writes live in RENDER_SERVER_WORK_DIR, whose group (render) both users share.
set -e
umask 007
HOME=/home/chrome exec /usr/local/lib/chromium/setpriv --reuid=chrome --regid=render --keep-groups /app/packages/server/render-server.sh "$@"

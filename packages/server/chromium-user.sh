#!/bin/sh
# Chromium as its own user: a renderer exploit then cannot read the server's environment (the kernel checks
# /proc/<pid>/environ by user) or the run folders (the server writes them with umask 077). Playwright runs this as
# pwuser; setpriv is a copy that is setuid chrome and setgid render, so it can only step down to that user.
set -e
for arg; do
  case "$arg" in
    --user-data-dir=*)
      # Playwright made the profile as pwuser: hand it to the render group both users share
      dir="${arg#--user-data-dir=}"
      find "$dir" -user "$(id -u)" -exec chgrp render {} + -exec chmod g+rwX {} +
      chmod g+s "$dir"
      ;;
  esac
done
# Playwright deletes a temporary profile as pwuser, which cannot remove what Chromium made inside: old ones go here
stale="-maxdepth 1 -name playwright_chromiumdev_profile-* -mmin +60"
/usr/local/lib/chromium/setpriv --reuid=chrome --regid=render --keep-groups find "${TMPDIR:-/tmp}" $stale -exec rm -rf {} + 2>/dev/null || true
find "${TMPDIR:-/tmp}" $stale -empty -delete 2>/dev/null || true
umask 007
HOME=/home/chrome XDG_CONFIG_HOME=/home/chrome/.config XDG_CACHE_HOME=/home/chrome/.cache \
  exec /usr/local/lib/chromium/setpriv --reuid=chrome --regid=render --keep-groups /usr/local/lib/chromium/chrome "$@"

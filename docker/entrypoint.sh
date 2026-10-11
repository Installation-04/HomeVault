#!/bin/sh
# Starts as root only long enough to make the mounted data folders writable
# by the unprivileged "node" user, then drops privileges before running the
# app. If ownership can't be changed (some NAS/NFS mounts forbid chown) it
# falls back to running as root, exactly like earlier versions did, rather
# than refusing to start.
set -e

if [ "$(id -u)" = "0" ]; then
  as_node() { setpriv --reuid=node --regid=node --init-groups "$@"; }
  drop=1

  for dir in "$(dirname "${DB_PATH:-./data/homevault.sqlite}")" "${UPLOAD_DIR:-./data/uploads}" "${BACKUP_DIR:-./data/backups}"; do
    mkdir -p "$dir"
    # Only walk the whole tree when the top folder isn't ours yet, so
    # restarts stay fast even with thousands of stored documents.
    if [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
      chown -R node:node "$dir" 2>/dev/null || true
    fi
    if ! as_node test -w "$dir"; then
      echo "warning: $dir is not writable by the 'node' user and ownership could not be changed; running as root." >&2
      drop=0
    fi
  done

  if [ "$drop" = "1" ]; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
fi

exec "$@"

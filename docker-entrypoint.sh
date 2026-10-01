#!/bin/sh
set -eu

if [ -d /data ]; then
  chown -R node:node /data
fi

if [ -n "${GITLAB_MAINTENANCE_PROJECT:-}" ]; then
  gosu node node /app/src/gitlab-file-maintenance.mjs
fi

exec gosu node "$@"

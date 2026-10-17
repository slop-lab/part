#!/usr/bin/env sh
set -eu

exec sudo --user dim-agent --set-home \
  sh -lc '
    cd /workspace
    npm ci
    export PART_PREVIEW_PORT=3000
    exec npm run preview
  '

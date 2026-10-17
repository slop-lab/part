#!/usr/bin/env sh
set -eu

exec sudo --preserve-env=DIM_DEVELOPMENT_GATEWAY_PORT \
  --user dim-agent --set-home \
  sh -lc '
    cd /workspace
    npm ci
    export PART_PREVIEW_PORT="${DIM_DEVELOPMENT_GATEWAY_PORT:?}"
    exec npm run preview
  '

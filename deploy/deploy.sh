#!/usr/bin/env bash

# This legacy one-click path bypasses the controlled production-release checks.
# Keep the executable as a fail-closed tombstone so old operator commands cannot
# silently regain deployment authority.
retired_deploy_entrypoint() {
  printf '%s\n' \
    '[DeployBlocked] deploy/deploy.sh is retired and disabled.' \
    'Use the controlled production release runbook: deploy/DEPLOY.md' >&2
  exit 64
}

# The first executable action is the fail-closed guard above. Nothing may be
# added before this call that builds, reads release inputs, connects remotely,
# or writes local/production state.
retired_deploy_entrypoint "$@"

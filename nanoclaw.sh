#!/bin/bash
# NanoClaw launcher — start or connect to the NanoClaw sandbox
#
# Usage:
#   ./nanoclaw.sh                    # Create new sandbox with workspace mounts
#   ./nanoclaw.sh --continue         # Connect and resume last conversation
#   ./nanoclaw.sh --without-mounts   # Connect to existing sandbox
#
# Place this somewhere on your PATH (e.g., ~/bin/nanoclaw.sh)
# or alias it: alias nanoclaw="~/nanoclaw.sh"

SANDBOX_NAME="nanoclaw-sandbox-3936"

# Workspaces Aime should be able to access
WORKSPACES=(
  "$HOME/hypr"
  "$HOME/projects"
  "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/SecondBrain"
)

if [[ "$1" == "--without-mounts" ]]; then
  # Connect to existing sandbox, pass any args through
  AGENT_ARGS=()
  for arg in "$@"; do
    AGENT_ARGS+=("$arg")
  done

  shift # remove --without-mounts
  if [[ ${#AGENT_ARGS[@]} -gt 0 ]]; then
    docker sandbox run "$SANDBOX_NAME" -- "${AGENT_ARGS[@]}"
  else
    docker sandbox run "$SANDBOX_NAME"
  fi
else
  echo "Creating NanoClaw sandbox with workspace mounts..."

  # Build workspace args
  WORKSPACE_ARGS=()
  for ws in "${WORKSPACES[@]}"; do
    WORKSPACE_ARGS+=("$ws")
  done

  echo ${WORKSPACE_ARGS[@]}

  docker sandbox run \
    --name "$SANDBOX_NAME" \
    claude \
    "$HOME/projects/nanoclaw" \
    "${WORKSPACE_ARGS[@]}" \
    -- "$@"
fi

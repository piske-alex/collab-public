#!/usr/bin/env bash
# collab-cli.sh — Launch the Collaborator Electron app from the command line.
# Installed to ~/.local/bin/collab by the app.

set -euo pipefail

# Resolve the path to the Electron app
if [[ "$(uname)" == "Darwin" ]]; then
  APP_PATH="/Applications/Collaborator.app"
  if [[ ! -d "$APP_PATH" ]]; then
    APP_PATH="$HOME/Applications/Collaborator.app"
  fi
  if [[ -d "$APP_PATH" ]]; then
    open "$APP_PATH" --args "$@"
  else
    echo "Error: Collaborator.app not found in /Applications or ~/Applications" >&2
    exit 1
  fi
else
  # Linux — find the installed binary
  BINARY=""
  for candidate in \
    "/usr/bin/collaborator" \
    "/usr/local/bin/collaborator" \
    "/opt/Collaborator/collaborator" \
    "$HOME/.local/share/Collaborator/collaborator" \
    "/snap/bin/collaborator" \
    "/usr/share/collaborator/collaborator"; do
    if [[ -x "$candidate" ]]; then
      BINARY="$candidate"
      break
    fi
  done

  if [[ -z "$BINARY" ]]; then
    echo "Error: Collaborator binary not found. Is it installed?" >&2
    exit 1
  fi

  "$BINARY" "$@" &
  disown
fi

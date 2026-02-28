#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"

PROFILE="${PROFILE:-release}" # release | debug

echo "[dist] Building Node engine (root)..."
(cd "$ROOT_DIR" && npm run -s build)

echo "[dist] Building Tauri app (desktop, profile=$PROFILE)..."
TAURI_FLAGS=(build --bundles app --no-sign)
if [[ "$PROFILE" == "debug" ]]; then
  TAURI_FLAGS+=(--debug)
fi
(cd "$DESKTOP_DIR" && npm run -s tauri -- "${TAURI_FLAGS[@]}")

APP_DIR="$DESKTOP_DIR/src-tauri/target/$PROFILE/bundle/macos"
# Use `-d` so `ls` prints the .app directory itself (not its contents).
APP_PATH="$(ls -1td "$APP_DIR"/*.app 2>/dev/null | head -n 1 || true)"

echo "[dist] Done."
if [[ -n "$APP_PATH" ]]; then
  echo "[dist] Built app: $APP_PATH"
else
  echo "[dist] Note: could not locate .app under $APP_DIR"
fi

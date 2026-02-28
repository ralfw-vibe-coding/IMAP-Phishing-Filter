#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"

PROFILE="${PROFILE:-release}" # release | debug
APP_DIR="$DESKTOP_DIR/src-tauri/target/$PROFILE/bundle/macos"
# Use `-d` so `ls` prints the .app directory itself (not its contents).
APP_PATH="$(ls -1td "$APP_DIR"/*.app 2>/dev/null | head -n 1 || true)"

if [[ -z "$APP_PATH" || "$APP_PATH" != *.app ]]; then
  echo "[deploy] No .app found under: $APP_DIR"
  echo "[deploy] Run: npm run dist:mac"
  exit 1
fi

DEST_DIR="${DEST_DIR:-$HOME/Applications}"
mkdir -p "$DEST_DIR"

APP_NAME="$(basename "$APP_PATH")"
DEST_PATH="$DEST_DIR/$APP_NAME"

echo "[deploy] Deploying $APP_NAME"
echo "[deploy] From: $APP_PATH"
echo "[deploy] To:   $DEST_PATH"

rm -rf "$DEST_PATH"
ditto "$APP_PATH" "$DEST_PATH"

echo "[deploy] Done."
echo "[deploy] You can start it via Finder or:"
echo "         open \"$DEST_PATH\""

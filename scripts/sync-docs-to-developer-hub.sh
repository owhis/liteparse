#!/usr/bin/env bash
set -euo pipefail

DOCS_REPO="${1:?Usage: $0 /path/to/developer-hub-repo}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Markdown docs ---
SOURCE_DIR="$REPO_ROOT/docs/src/content/docs/liteparse"
DEST_DIR="$DOCS_REPO/src/content/docs/liteparse"

echo "=== Syncing markdown docs ==="
mkdir -p "$DEST_DIR"

rsync -av --delete \
  --include='*/' \
  --include='*.md' \
  --include='*.mdx' \
  --include='*.yml' \
  --include='*.png' \
  --include='*.jpg' \
  --include='*.jpeg' \
  --include='*.svg' \
  --exclude='*' \
  "$SOURCE_DIR/" "$DEST_DIR/"

echo "Docs sync complete."

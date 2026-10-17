#!/usr/bin/env bash
set -euo pipefail

# Build and install Token Watcher on macOS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ROOT_DIR/release"

APP_NAME="Token Watcher.app"

cd "$ROOT_DIR"

echo "==> Building TypeScript..."
pnpm run build

echo "==> Building GUI renderer..."
pnpm run build:gui

echo "==> Generating icons..."
pnpm run build:icons

echo "==> Packaging for macOS with electron-builder..."
NODE_OPTIONS="--experimental-require-module" npx electron-builder --mac

echo "==> Build complete."

# Install with verified rollback archives and preserve all user data.
node scripts/install-mac.mjs

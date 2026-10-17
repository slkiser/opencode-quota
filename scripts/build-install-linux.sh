#!/usr/bin/env bash
set -euo pipefail

# Build and install Token Watcher on Linux

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ROOT_DIR/release"

cd "$ROOT_DIR"

echo "==> Building TypeScript..."
pnpm run build

echo "==> Building GUI renderer..."
pnpm run build:gui

echo "==> Generating icons..."
pnpm run build:icons

echo "==> Packaging for Linux with electron-builder..."
NODE_OPTIONS="--experimental-require-module" npx electron-builder --linux

echo "==> Build complete."

# --- Install ---
echo ""
echo "==> Looking for packages in $RELEASE_DIR ..."

DEB_FILE=$(ls "$RELEASE_DIR"/*.deb 2>/dev/null | head -1 || true)
APPIMAGE_FILE=$(ls "$RELEASE_DIR"/*.AppImage 2>/dev/null | head -1 || true)

if [ -n "$DEB_FILE" ]; then
  echo "==> Found .deb: $DEB_FILE"
  echo "==> Installing with dpkg (requires sudo)..."
  sudo dpkg -i "$DEB_FILE"

  # Clean up stale user-local desktop entries that would shadow
  # the system-installed .desktop file from the deb package.
  STALE_DESKTOP="${HOME}/.local/share/applications/opencode-quota.desktop"
  if [ -f "$STALE_DESKTOP" ]; then
    echo "==> Removing stale user-local desktop entry: $STALE_DESKTOP"
    rm -f "$STALE_DESKTOP"
  fi

  # Clean up stale AppImage from previous manual installs.
  STALE_APPIMAGE="${HOME}/Applications/OpenCode-Quota.AppImage"
  if [ -f "$STALE_APPIMAGE" ]; then
    echo "==> Removing stale AppImage: $STALE_APPIMAGE"
    rm -f "$STALE_APPIMAGE"
  fi

  echo "==> Installed. Run with: token-watcher gui"
elif [ -n "$APPIMAGE_FILE" ]; then
  echo "==> Found .AppImage: $APPIMAGE_FILE"
  INSTALL_DIR="${HOME}/.local/bin"
  INSTALL_PATH="${INSTALL_DIR}/token-watcher"
  mkdir -p "$INSTALL_DIR"
  cp "$APPIMAGE_FILE" "$INSTALL_PATH"
  chmod +x "$INSTALL_PATH"

  # Create/update user-local desktop entry so the app launcher works.
  DESKTOP_DIR="${HOME}/.local/share/applications"
  DESKTOP_FILE="${DESKTOP_DIR}/token-watcher.desktop"
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_FILE" <<DESKTOPEOF
[Desktop Entry]
Name=Token Watcher
Comment=Quota, usage, and token visibility for OpenCode
Exec=${INSTALL_PATH}
Icon=token-watcher
Type=Application
Categories=Development;
Terminal=false
StartupWMClass=Token Watcher
DESKTOPEOF
  echo "==> Wrote desktop entry: $DESKTOP_FILE"

  # Clean up stale AppImage from previous manual installs.
  STALE_APPIMAGE="${HOME}/Applications/OpenCode-Quota.AppImage"
  if [ -f "$STALE_APPIMAGE" ]; then
    echo "==> Removing stale AppImage: $STALE_APPIMAGE"
    rm -f "$STALE_APPIMAGE"
  fi

  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "WARNING: $INSTALL_DIR is not in your PATH."
    echo "Add this to your shell config (~/.bashrc or ~/.zshrc):"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi

  echo "==> Installed to: $INSTALL_PATH"
  echo "==> Run with: token-watcher gui"
else
  echo "ERROR: No .deb or .AppImage found in $RELEASE_DIR"
  exit 1
fi

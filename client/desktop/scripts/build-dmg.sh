#!/usr/bin/env bash
# ASOptimus macOS .dmg build + (optional) code-sign + notarize pipeline.
#
#   ./scripts/build-dmg.sh [arm64|x64|both]     (default: both)
#
# Steps: build the Bun client sidecars (both arches) → generate icons → `tauri build`
# per target, producing a drag-to-Applications .dmg. Signing/notarization happen
# automatically inside `tauri build` when the env vars below are present.
#
# ─ The ONLY things the user supplies at the end (like API keys) ─
#   APPLE_SIGNING_IDENTITY       e.g. "Developer ID Application: Acme Inc (TEAMID1234)"
#                                (a Developer ID cert installed in the login keychain)
#   APPLE_ID                     Apple Developer account email
#   APPLE_TEAM_ID                10-char team id
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password for notarization
#                                (mapped to APPLE_PASSWORD, which Tauri reads)
#
# Without the signing vars the build still succeeds but yields an UNSIGNED .dmg (dev only).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
cd "$DESKTOP"

ARCH="${1:-both}"

# ── tooling checks ───────────────────────────────────────────────────────────
command -v bun >/dev/null   || { echo "✗ bun not found (needed to compile the sidecar). Install: https://bun.sh"; exit 1; }
command -v cargo >/dev/null || { echo "✗ cargo/Rust not found (needed to build the Tauri app). Install: https://rustup.rs"; exit 1; }

# ── map signing secret to the env name Tauri expects ─────────────────────────
if [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  export APPLE_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
fi
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "→ signing as: $APPLE_SIGNING_IDENTITY"
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_PASSWORD:-}" ]]; then
    echo "→ notarization credentials present — will notarize + staple"
  else
    echo "⚠ APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD not all set — signing WITHOUT notarization"
  fi
else
  echo "⚠ APPLE_SIGNING_IDENTITY not set — producing an UNSIGNED .dmg (dev only; add the cert to ship)"
fi

# ── deps: @tauri-apps/cli ────────────────────────────────────────────────────
if [[ ! -d node_modules/@tauri-apps/cli ]]; then
  echo "→ installing @tauri-apps/cli"
  bun install
fi

# ── icons ────────────────────────────────────────────────────────────────────
if [[ ! -f src-tauri/icons/icon.icns ]]; then
  echo "→ generating icon set"
  bash "$HERE/make-icons.sh"
fi

# ── sidecars (both arches — Tauri picks the matching triple per target) ──────
echo "→ compiling Bun client sidecars"
bun ../src/build.ts --sidecar

build_target() {
  local triple="$1"
  echo "──────────────────────────────────────────────"
  echo "→ tauri build --target $triple --bundles dmg"
  bun run tauri build --target "$triple" --bundles app,dmg
}

case "$ARCH" in
  arm64) build_target "aarch64-apple-darwin" ;;
  x64)   build_target "x86_64-apple-darwin" ;;
  both)
    build_target "aarch64-apple-darwin"
    build_target "x86_64-apple-darwin"
    ;;
  *) echo "usage: build-dmg.sh [arm64|x64|both]"; exit 2 ;;
esac

echo "──────────────────────────────────────────────"
echo "✓ done. DMG(s):"
find src-tauri/target -name '*.dmg' -maxdepth 5 -print 2>/dev/null || true

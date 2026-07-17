#!/usr/bin/env bash
# Generate the macOS icon set (icon.icns + the PNGs tauri.conf.json references) from a
# 1024×1024 source PNG, using only macOS built-ins (sips, iconutil). Regenerate the source
# with gen-icon.mjs. Idempotent: safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS="$HERE/../src-tauri/icons"
SRC="$ICONS/icon.png"

mkdir -p "$ICONS"

# 1) source PNG
if [[ ! -f "$SRC" ]]; then
  echo "→ generating source icon.png"
  node "$HERE/gen-icon.mjs"
fi

command -v sips >/dev/null || { echo "sips not found (need macOS)"; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil not found (need macOS)"; exit 1; }

# 2) PNGs referenced by tauri.conf.json bundle.icon
echo "→ generating 32x32 / 128x128 / 128x128@2x PNGs"
sips -z 32 32     "$SRC" --out "$ICONS/32x32.png"      >/dev/null
sips -z 128 128   "$SRC" --out "$ICONS/128x128.png"    >/dev/null
sips -z 256 256   "$SRC" --out "$ICONS/128x128@2x.png" >/dev/null

# 3) icon.icns via an .iconset
echo "→ generating icon.icns"
SET="$(mktemp -d)/icon.iconset"
mkdir -p "$SET"
sips -z 16 16     "$SRC" --out "$SET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$SRC" --out "$SET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$SRC" --out "$SET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_512x512.png"    >/dev/null
cp "$SRC"                 "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$ICONS/icon.icns"

echo "✓ icons written to $ICONS"

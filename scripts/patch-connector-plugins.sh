#!/usr/bin/env bash
# The pinned plugins own the Bot access switch and the web canvas client. Keep the
# small iOS integrations with their owners, without touching a user's profile.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
modules="$(cd "${1:?path to engine node_modules}" && pwd)"
for pkg in ds-bot dsh-image-gen; do
  dir="$modules/$pkg"
  node -e 'const [manifest, pins, name] = process.argv.slice(1); const version = require(manifest).version; if (version !== require(pins)[name].version) throw new Error(name + " has an unexpected version: " + version)' \
    "$dir/package.json" "$root/engine/plugins/ios-host/pins.json" "$pkg"
  patchfile="$root/engine/patches/$pkg.patch"
  if patch -s -f -F 0 --dry-run -d "$dir" -p1 < "$patchfile" >/dev/null 2>&1; then
    patch -s -f -F 0 -d "$dir" -p1 < "$patchfile"
  elif ! patch -s -f -F 0 --dry-run -R -d "$dir" -p1 < "$patchfile" >/dev/null 2>&1; then
    echo "Connector integration no longer matches $pkg; review its pinned source." >&2
    exit 1
  fi
done

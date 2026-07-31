#!/usr/bin/env bash
# scripts/build-gui-mac.sh
# Single bash entry point for the macOS GUI production build chain. Sources
# the signing env (so the loader's bash-only `[[`, BASH_SOURCE detection, and
# printf color escapes all work even when `bun run` invokes the script string
# via /bin/sh — which is dash on Debian/Ubuntu CI) and then runs the build +
# ad-hoc sign steps in this same bash process so the env propagates naturally.
#
# This is the script invoked by `bun run build:gui:mac` in package.json.

set -euo pipefail

# Resolve symlinks + cd so .env.local and scripts/* paths are stable no matter
# what the user's CWD is when they run `bun run build:gui:mac`.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Source the signing env. The loader is bash-only (`[[`, BASH_SOURCE, printf
# escapes). Inside this bash process (per shebang) it works on macOS bash-3.2,
# bash 4/5 on Linux, and bash anywhere else.
. scripts/load-tauri-signing-env.sh

# Build the app + UI bundle, then ad-hoc sign + remove xattr quarantine for
# double-click from Finder. Both env vars and the surrounding bash process
# stay alive through these children.
bun run gui:build
bun run sign:mac

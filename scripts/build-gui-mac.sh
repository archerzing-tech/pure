#!/usr/bin/env bash
# scripts/build-gui-mac.sh
# Single bash entry point for the macOS GUI production build chain. Sources
# the signing env (so the loader's bash-only `[[`, BASH_SOURCE detection, and
# printf color escapes all work even when `bun run` invokes the script string
# via /bin/sh — which is dash on Debian/Ubuntu CI) and then runs the build +
# ad-hoc sign steps in this same bash process so the env propagates naturally.
#
# This is the script invoked by `bun run build:gui:mac` in package.json.
#
# Opt-in local deploy: set `PURE_DEPLOY_LOCAL=1` (in .env.local, the env, or
# the shell) and after the build+sign succeeds the freshly-built .app will be
# copied to `/Applications/pure.app` and re-registered with LaunchServices.
# Skipped automatically when `APPLE_DEVELOPER_IDENTITY` is set or `CI` is
# set so production builds never clobber your local install.
#
# Skip updater signing: set `PURE_SKIP_UPDATER_SIGN=1` (in .env.local, the
# env, or the shell) to build WITHOUT the auto-updater sidecar signature.
# `tauri build` then runs with createUpdaterArtifacts disabled, so a missing
# or rotated signing key no longer aborts an otherwise-complete local build.

set -euo pipefail

# Resolve symlinks + cd so .env.local and scripts/* paths are stable no matter
# what the user's CWD is when they run `bun run build:gui:mac`.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Source the signing env. The loader is bash-only (`[[`, BASH_SOURCE, printf
# escapes). Inside this bash process (per shebang) it works on macOS bash-3.2,
# bash 4/5 on Linux, and bash anywhere else.
. scripts/load-tauri-signing-env.sh

# Regenerate platform icons from the canonical SVG source so design tweaks in
# `prototype/pure-diamond.svg` automatically propagate into the .app + favicon
# + updater artifacts (no more invisible-icon bug from forgotten `npx tauri
# icon` after edits). Set PURE_SKIP_REGEN_ICONS=1 to opt out entirely (CI
# builds that already pre-ran the regen, or quick test re-builds), or
# PURE_FORCE_REGEN_ICONS=1 to bypass the mtime skip on the SVG-vs-icon
# freshness check.
if [[ "${PURE_SKIP_REGEN_ICONS:-0}" != "1" && -f prototype/pure-diamond.svg ]]; then
  # Skip work when the SVG hasn't changed since the last regen. The `find
  # -newer` analogue in bash is `[[ A -nt B ]]` (test the mtime of A vs B);
  # we use `src-tauri/icons/icon.png` as the canonical "have we regenned"
  # sentinel since the master PNG is regenerated on every tauri-icon run.
  should_regen=0
  if [[ "${PURE_FORCE_REGEN_ICONS:-0}" == "1" ]]; then
    should_regen=1
  elif [[ ! -f src-tauri/icons/icon.png ]]; then
    should_regen=1
  elif [[ prototype/pure-diamond.svg -nt src-tauri/icons/icon.png ]]; then
    should_regen=1
  fi
  if [[ $should_regen -eq 1 ]]; then
    echo ""
    echo "▶ ICON REGEN: prototype/pure-diamond.svg → src-tauri/icons/"
    # `&&` chain (not `;` or `| tail -8` standalone) so a `npx tauri icon`
    # crash short-circuits cleanly via the `||` handler below. The naive
    # `npx … 2>&1 | tail -8; cp; echo ✔` form masks npx's exit because
    # `tail` always returns 0, and with pipefail the pipeline's exit value
    # gets discarded by the `;`. The inner block + `||` makes the failure
    # visible (and aborts the build) — important because silently
    # propagating the broken icons into `bun run gui:build` would reproduce
    # the exact "the icon is transparent" bug we just fixed.
    { npx tauri icon prototype/pure-diamond.svg -o src-tauri/icons/ 2>&1 | tail -8 \
        && cp -f src-tauri/icons/32x32.png public/favicon.png \
        && echo "✔ icons + favicon refreshed"; } \
      || { echo "✘ ICON REGEN: npx tauri icon failed; aborting build before gui:build"; exit 1; }
  else
    echo ""
    echo "⏭  ICON REGEN: skipped (prototype/pure-diamond.svg is older than src-tauri/icons/icon.png; set PURE_FORCE_REGEN_ICONS=1 to override)"
  fi
fi

# Build the app + UI bundle, then ad-hoc sign + remove xattr quarantine for
# double-click from Finder. Both env vars and the surrounding bash process
# stay alive through these children.
if [[ "${PURE_SKIP_UPDATER_SIGN:-0}" == "1" ]]; then
  echo ""
  echo "⏭  UPDATER SIGN: skipped (PURE_SKIP_UPDATER_SIGN=1)"
  bun run tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
else
  bun run gui:build
fi
bun run sign:mac

# ── Optional local deploy to /Applications/pure.app ────────────────────────
# Opt in with PURE_DEPLOY_LOCAL=1 to skip the manual copy after every build.
# Skipped automatically when the build is intended for distribution:
#   • APPLE_DEVELOPER_IDENTITY is set  → real Developer ID signing path
#   • CI env var is set                 → GitHub Actions / similar
# What the deploy actually does:
#   1. rm -rf /Applications/pure.app
#   2. cp -R the freshly-built .app
#   3. Strip quarantine so Gatekeeper doesn't complain on first launch
#   4. Re-register with LaunchServices so the new Info.plist + icon take
#      effect immediately. Dock icon visual still needs `killall Dock` —
#      we don't kill it here to avoid disrupting your other workspaces.
if [[ "${PURE_DEPLOY_LOCAL:-0}" == "1" \
   && -z "${APPLE_DEVELOPER_IDENTITY:-}" \
   && -z "${CI:-}" ]]; then
  echo ""
  echo "▶ DEPLOY LOCAL: replacing /Applications/pure.app with the freshly-built bundle"
  [[ -d /Applications/pure.app ]] && rm -rf /Applications/pure.app
  cp -R src-tauri/target/release/bundle/macos/pure.app /Applications/
  xattr -dr com.apple.quarantine /Applications/pure.app 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
    -f /Applications/pure.app 2>/dev/null || true
  echo "✅ Installed → /Applications/pure.app"
  echo "   ↪ Tip: relaunch or \`killall Dock\` if the icon visual is still the old one."
else
  echo ""
  echo "⏭  DEPLOY LOCAL: skipped (set PURE_DEPLOY_LOCAL=1 to auto-sync to /Applications/pure.app)"
fi

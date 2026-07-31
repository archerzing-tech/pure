#!/usr/bin/env bash
# scripts/sign-app.sh
# macOS ad-hoc local signing + quarantine removal for the Tauri .app bundle.
# Wraps the manual workflow: reset prior sig → ad-hoc sign → strip xattr → verify.
# Signs both the .app bundle and the standalone Rust binary so Finder can
# double-click either one without Gatekeeper prompts. Run after `bun run gui:build`.
#
# Usage:
#   scripts/sign-app.sh                                # sign the default bundle
#   scripts/sign-app.sh path/to/Some.app other/Bin     # sign custom paths
#   bun run sign:mac                                   # via npm script
#
# Notes:
#   • ad-hoc ("-") signing is *local* only — no Apple Developer ID, no notarization.
#   • spctl assessment will report "rejected" (ad-hoc is unsigned for Gatekeeper),
#     but Finder double-click goes through quarantine + signature presence checks,
#     not the strict spctl path. Result: app launches when double-clicked.
#   • For real distribution, swap to Developer ID + `xcrun notarytool`. Out of scope here.

set -euo pipefail

APP_PATH="${1:-src-tauri/target/release/bundle/macos/pure.app}"
RAW_BIN_PATH="${2:-src-tauri/target/release/pure}"

# ── Color helpers (no-op when stdout is not a TTY or NO_COLOR is set) ──
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  readonly C_BOLD=$'\033[1m'
  readonly C_DIM=$'\033[2m'
  readonly C_CYAN=$'\033[36m'
  readonly C_GREEN=$'\033[32m'
  readonly C_RED=$'\033[31m'
  readonly C_YELLOW=$'\033[33m'
  readonly C_RESET=$'\033[0m'
else
  readonly C_BOLD='' C_DIM='' C_CYAN='' C_GREEN='' C_RED='' C_YELLOW='' C_RESET=''
fi

c_echo() {
  local color="$1"; shift
  printf '%s%s%s\n' "$color" "$*" "$C_RESET"
}

info() { c_echo "${C_BOLD}${C_CYAN}"  "  ▶ $*"; }
ok()   { c_echo "${C_GREEN}"          "  ✓ $*"; }
warn() { c_echo "${C_YELLOW}"         "  ! $*"; }
fail() { c_echo "${C_RED}"            "  ✗ $*" >&2; }

# ── Pre-flight ──

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This script runs on macOS only. Detected: $(uname -s)"
  exit 1
fi

if ! command -v codesign >/dev/null 2>&1; then
  fail "codesign not found on PATH."
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  fail "App bundle not found: $APP_PATH"
  fail "Run 'bun run gui:build' first to produce the bundle."
  exit 1
fi

# ── 1. Reset prior signatures (idempotent — won't fail if missing) ──

info "Reset prior signatures on $APP_PATH"
codesign --remove-signature "$APP_PATH/Contents/MacOS/pure" 2>/dev/null || true
codesign --remove-signature "$APP_PATH"                       2>/dev/null || true
ok "OK"

# ── 2. Ad-hoc sign the .app bundle ──

info "Ad-hoc sign: $APP_PATH"
codesign --force --deep --sign - --timestamp=none "$APP_PATH"
ok "Signed."

# ── 3. Strip com.apple.quarantine (recursive) ──

info "Strip com.apple.quarantine (recursive on $APP_PATH)"
xattr -dr com.apple.quarantine "$APP_PATH"
ok "Stripped."

# ── 4. Also sign + strip the standalone Rust binary if present ──

if [[ -f "$RAW_BIN_PATH" ]]; then
  info "Ad-hoc sign: $RAW_BIN_PATH"
  codesign --force --sign - "$RAW_BIN_PATH"
  xattr -dr com.apple.quarantine "$RAW_BIN_PATH"
  ok "Signed + stripped."
else
  warn "Raw binary not found at $RAW_BIN_PATH (skipping — only matters if you launch the CLI flasher directly)"
fi

# ── 5. Verify ──

info "codesign -dv $APP_PATH"
echo ""
codesign -dv "$APP_PATH" 2>&1 | sed 's/^/    /'
echo ""

info "spctl --assess (informational; ad-hoc always reports rejected, double-click still works)"
spctl --assess --verbose=4 "$APP_PATH" 2>&1 | sed 's/^/    /' || true

info "Remaining xattr on $APP_PATH"
local_xattr=$(xattr -lr "$APP_PATH" 2>&1 | head -20)
if [[ -z "$local_xattr" ]]; then
  echo "    ${C_DIM}(none)${C_RESET}"
else
  echo "$local_xattr" | sed 's/^/    /'
fi

# ── Done ──

echo ""
ok "All done. Launch with one of:"
echo "      ${C_BOLD}open \"$APP_PATH\"${C_RESET}"
echo "      ${C_DIM}or in Finder: double-click the .app${C_RESET}"

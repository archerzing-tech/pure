#!/usr/bin/env bash
# scripts/sign-app.sh
# macOS code signing + optional notarization for the Tauri .app bundle.
# Run after `bun run gui:build`.
#
# Two modes (auto-detected):
#   Developer ID mode  — APPLE_DEVELOPER_IDENTITY env var is set.
#                         Uses hardened runtime + timestamp, optional notarization.
#   Ad-hoc mode        — APPLE_DEVELOPER_IDENTITY is empty or unset.
#                         codesign --sign - (local only; double-click works, Gatekeeper warns).
#
# Usage:
#   scripts/sign-app.sh                                    # sign default bundle
#   scripts/sign-app.sh path/to/Some.app other/Bin         # sign custom paths
#   bun run sign:mac                                       # via npm script
#
# Developer ID env vars (all optional; mode auto-detected):
#   APPLE_DEVELOPER_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_TEAM_ID              e.g. "ABCDE12345"
#   APPLE_ID                   Apple ID email (for notarization)
#   APPLE_APP_SPECIFIC_PASSWORD  App-specific password (for notarization)
#   APPLE_KEYCHAIN_PROFILE     notarytool keychain profile name (optional; auto-created if unset)

set -euo pipefail

APP_PATH="${1:-src-tauri/target/release/bundle/macos/pure.app}"
RAW_BIN_PATH="${2:-src-tauri/target/release/pure}"
IDENTITY="${APPLE_DEVELOPER_IDENTITY:-}"

# ── Color helpers ──
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  readonly C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_CYAN=$'\033[36m'
  readonly C_GREEN=$'\033[32m' C_RED=$'\033[31m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
  readonly C_BOLD='' C_DIM='' C_CYAN='' C_GREEN='' C_RED='' C_YELLOW='' C_RESET=''
fi

c_echo() { local color="$1"; shift; printf '%s%s%s\n' "$color" "$*" "$C_RESET"; }
info()  { c_echo "${C_BOLD}${C_CYAN}"  "  ▶ $*"; }
ok()    { c_echo "${C_GREEN}"          "  ✓ $*"; }
warn()  { c_echo "${C_YELLOW}"         "  ! $*"; }
fail()  { c_echo "${C_RED}"            "  ✗ $*" >&2; }

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

# ── Detect signing mode ──

if [[ -n "$IDENTITY" ]]; then
  MODE="developer-id"
  info "Developer ID signing mode — identity: $IDENTITY"
else
  MODE="ad-hoc"
  info "Ad-hoc signing mode (no APPLE_DEVELOPER_IDENTITY set)"
fi

# ── 1. Reset prior signatures ──

info "Reset prior signatures on $APP_PATH"
codesign --remove-signature "$APP_PATH/Contents/MacOS/pure" 2>/dev/null || true
codesign --remove-signature "$APP_PATH"                       2>/dev/null || true
ok "OK"

# ── 2. Sign the .app bundle ──

if [[ "$MODE" == "developer-id" ]]; then
  # Enable hardened runtime (required for notarization)
  ENTITLEMENTS="/tmp/pure.entitlements"
  cat > "$ENTITLEMENTS" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
EOF

  info "Developer ID sign: $APP_PATH (hardened runtime)"
  codesign --force --deep --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" \
    --timestamp \
    "$APP_PATH"
  rm -f "$ENTITLEMENTS"
  ok "Signed with Developer ID."
else
  info "Ad-hoc sign: $APP_PATH"
  codesign --force --deep --sign - --timestamp=none "$APP_PATH"
  ok "Signed (ad-hoc)."
fi

# ── 3. Sign the standalone Rust binary if present ──

if [[ -f "$RAW_BIN_PATH" ]]; then
  if [[ "$MODE" == "developer-id" ]]; then
    info "Developer ID sign: $RAW_BIN_PATH"
    codesign --force --options runtime --sign "$IDENTITY" --timestamp "$RAW_BIN_PATH"
  else
    info "Ad-hoc sign: $RAW_BIN_PATH"
    codesign --force --sign - "$RAW_BIN_PATH"
  fi
  ok "Binary signed."
else
  warn "Raw binary not found at $RAW_BIN_PATH (skipping)"
fi

# ── 4. Strip com.apple.quarantine (recursive) ──

info "Strip com.apple.quarantine (recursive on $APP_PATH)"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
ok "Stripped."

# ── 5. Notarization (Developer ID only) ──

if [[ "$MODE" == "developer-id" ]]; then
  NOTARY_PROFILE="${APPLE_KEYCHAIN_PROFILE:-pure-notary-profile}"

  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    # Store credentials in keychain (idempotent — fails gracefully if already present)
    xcrun notarytool store-credentials "$NOTARY_PROFILE" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "${APPLE_TEAM_ID:-}" \
      2>/dev/null || true

    info "Submitting for notarization…"
    xcrun notarytool submit "$APP_PATH" \
      --keychain-profile "$NOTARY_PROFILE" \
      --wait
    ok "Notarization submitted."

    info "Stapling notarization ticket…"
    xcrun stapler staple "$APP_PATH"
    ok "Stapled."
  else
    warn "Skipping notarization (APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set)"
    warn "  Set them to enable notarization. Without it, Gatekeeper will warn on first launch."
  fi
fi

# ── 6. Verify ──

echo ""
info "Signature verification:"
codesign -dv "$APP_PATH" 2>&1 | sed 's/^/    /'
echo ""

if [[ "$MODE" == "developer-id" ]]; then
  info "spctl --assess"
  spctl --assess --verbose=4 "$APP_PATH" 2>&1 | sed 's/^/    /' || true
fi

# ── Done ──

echo ""
ok "All done. Launch with:"
echo "      ${C_BOLD}open \"$APP_PATH\"${C_RESET}"
echo "      ${C_DIM}or in Finder: double-click the .app${C_RESET}"

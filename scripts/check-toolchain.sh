#!/usr/bin/env bash
# scripts/check-toolchain.sh
# macOS build-toolchain doctor. Audits every component the production GUI
# build chain needs (bun run build:gui:mac → scripts/build-gui-mac.sh) and
# reports pass / warn / fail per item, plus the exact command to fix each
# gap. Read-only: never modifies the system. Entry point: bun run toolchain:check
#
# Checks:
#   • macOS + arch + free disk            • Rust toolchain + arch target
#   • Bun / Node runtimes                 • Tauri CLI (local @tauri-apps/cli)
#   • Full Xcode.app + xcode-select       • codesign/hdiutil/iconutil/notarytool
#   • Tauri updater signing key           • (optional) Apple distribution creds
#
# Exit code 0 = all critical checks pass; 1 = at least one critical failure.

set -uo pipefail

# Resolve symlinks + cd so repo-root-relative paths (.env.local, node_modules,
# prototype/, …) stay stable no matter what CWD the script is invoked from
# (same preamble as scripts/build-gui-mac.sh).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── Color helpers (macOS bash-3.2 compatible; mirrors scripts/sign-app.sh) ──
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  readonly C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_CYAN=$'\033[36m'
  readonly C_GREEN=$'\033[32m' C_RED=$'\033[31m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
  readonly C_BOLD='' C_DIM='' C_CYAN='' C_GREEN='' C_RED='' C_YELLOW='' C_RESET=''
fi

c_echo() { local color="$1"; shift; printf '%s%s%s\n' "$color" "$*" "$C_RESET"; }
info()  { c_echo "${C_BOLD}${C_CYAN}" "$*"; }
ok()    { c_echo "${C_GREEN}"         "  ✓ $*"; }
warn()  { c_echo "${C_YELLOW}"        "  ! $*"; }
fail()  { c_echo "${C_RED}"           "  ✗ $*"; }
hdr()   { echo ""; c_echo "${C_BOLD}" "$*"; }

# ── Counters ──
PASS=0; WARN=0; FAIL=0

# ── Helpers ──
ver_num() { # "rustc 1.96.0 (…)" → "1.96.0"
  echo "$1" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1
}
ver_major() { # "1.96.0" → 96
  echo "$1" | cut -d. -f2
}

echo ""
info "pure — macOS build toolchain doctor"
info "Auditing every component required by: bun run build:gui:mac"

# ════════════════════════════════════════════════════════════════════════
hdr "1. OS"
# ════════════════════════════════════════════════════════════════════════
if [[ "$(uname -s)" == "Darwin" ]]; then
  OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
  ARCH="$(uname -m)"
  ok "macOS $OS_VERSION ($ARCH)"
  PASS=$((PASS+1))
  [[ "$ARCH" == "x86_64" || "$ARCH" == "arm64" ]] || warn "unrecognized arch: $ARCH"
else
  fail "not macOS (detected: $(uname -s)) — this toolchain is macOS-only"
  FAIL=$((FAIL+1))
fi

# ════════════════════════════════════════════════════════════════════════
hdr "2. Core runtimes"
# ════════════════════════════════════════════════════════════════════════

# ── Bun (required: every npm script runs through it) ──
if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
  PASS=$((PASS+1))
else
  fail "bun not found — fix: bash scripts/setup-mac-toolchain.sh"
  FAIL=$((FAIL+1))
fi

# ── Node (optional: only used for npx fallbacks) ──
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version 2>/dev/null)"
  PASS=$((PASS+1))
else
  warn "node not found (optional; bun covers the toolchain)"
  WARN=$((WARN+1))
fi

# ── Rust (rustc + cargo + rustup) ──
if command -v rustc >/dev/null 2>&1; then
  RV="$(ver_num "$(rustc --version)")"
  if [[ -n "$RV" ]]; then
    MAJ="$(ver_major "$RV")"
    if [[ "$MAJ" -lt 75 ]]; then  # Tauri v2 MSRV ≈ 1.75
      warn "rustc $RV — older than Tauri's ~1.75 MSRV; upgrade via: rustup update stable"
      WARN=$((WARN+1))
    else
      ok "rustc $RV"
      PASS=$((PASS+1))
    fi
  else
    warn "rustc present but version unparseable: $(rustc --version)"
    WARN=$((WARN+1))
  fi
else
  fail "rustc not found — fix: bash scripts/setup-mac-toolchain.sh"
  FAIL=$((FAIL+1))
fi
command -v cargo >/dev/null 2>&1 && { ok "cargo"; PASS=$((PASS+1)); } \
  || { fail "cargo not found"; FAIL=$((FAIL+1)); }
command -v rustup >/dev/null 2>&1 && { ok "rustup"; PASS=$((PASS+1)); } \
  || { warn "rustup not found (rustc/cargo may be brew-installed)"; WARN=$((WARN+1)); }

# ── Rust host target (must match the machine arch for cargo to link) ──
if command -v rustup >/dev/null 2>&1; then
  TARGET="$(uname -m)-apple-darwin"
  if rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    ok "rust target $TARGET"
    PASS=$((PASS+1))
  else
    fail "rust target '$TARGET' not installed — fix: rustup target add $TARGET"
    FAIL=$((FAIL+1))
  fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "3. Apple toolchain"
# ════════════════════════════════════════════════════════════════════════

# ── Full Xcode.app (REQUIRED by Tauri v2 for macOS builds) ──
XCODE_APP=""
for p in /Applications/Xcode.app /Applications/Xcode-beta.app "$HOME/Applications/Xcode.app"; do
  [[ -d "$p" ]] && XCODE_APP="$p" && break
done
if [[ -n "$XCODE_APP" ]]; then
  XBV="$(xcodebuild -version 2>/dev/null | sed -n '1p' | sed 's/^Xcode //')"
  if [[ -n "$XBV" ]]; then
    XMAJ="$(echo "$XBV" | cut -d. -f1)"
    if [[ "$XMAJ" -lt 14 ]]; then
      warn "Xcode $XBV is old; Tauri v2 works best with Xcode 15+"
      WARN=$((WARN+1))
    else
      ok "Xcode $XBV ($XCODE_APP)"
      PASS=$((PASS+1))
    fi
  else
    ok "Xcode.app present at $XCODE_APP (version unknown)"
    PASS=$((PASS+1))
  fi
  XSEL="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$XSEL" == "$XCODE_APP/Contents/Developer" ]]; then
    ok "xcode-select points at Xcode"
    PASS=$((PASS+1))
  else
    warn "xcode-select points at '$XSEL', not Xcode — fix: sudo xcode-select -s '$XCODE_APP/Contents/Developer'"
    WARN=$((WARN+1))
  fi
else
  fail "full Xcode.app not found (only Command Line Tools may be installed)"
  fail "  Tauri v2 needs Xcode's SDKs/frameworks (WebKit, Cocoa); CLT alone cannot build the .app"
  fail "  fix: bash scripts/setup-mac-toolchain.sh   (installs Xcode via 'xcodes')"
  FAIL=$((FAIL+1))
fi

# ── Command Line Tools (fallback / xcrun base) ──
XCLT="$(xcode-select -p 2>/dev/null || true)"
if [[ -n "$XCLT" ]]; then
  ok "Command Line Tools: $XCLT"
  PASS=$((PASS+1))
else
  warn "xcode-select -p is empty — run: xcode-select --install"
  WARN=$((WARN+1))
fi

# ── macOS SDK (newest available) ──
NEWEST_SDK=""
for sdk_dir in \
  "$XCODE_APP/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs" \
  /Library/Developer/CommandLineTools/SDKs; do
  if [[ -d "$sdk_dir" ]]; then
    for f in "$sdk_dir"/MacOSX*.sdk; do
      [[ -d "$f" ]] && NEWEST_SDK="$(basename "$f")"
    done
    break
  fi
done
if [[ -n "$NEWEST_SDK" ]]; then
  ok "macOS SDK: $NEWEST_SDK"
  PASS=$((PASS+1))
else
  warn "no macOS SDK found under Xcode or CLT"
  WARN=$((WARN+1))
fi

# ── Bundling / signing / notarization utilities ──
for tool in codesign hdiutil iconutil security spctl; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool"
    PASS=$((PASS+1))
  else
    fail "$tool not found — fix: install Xcode (see setup script)"
    FAIL=$((FAIL+1))
  fi
done
if xcrun --find notarytool >/dev/null 2>&1; then
  ok "notarytool (xcrun)"
  PASS=$((PASS+1))
else
  warn "notarytool not found (only needed for Developer ID notarization)"
  WARN=$((WARN+1))
fi

# ════════════════════════════════════════════════════════════════════════
hdr "4. Project build chain"
# ════════════════════════════════════════════════════════════════════════

# ── Local dependencies + Tauri CLI (scripts run via node_modules/.bin) ──
if [[ -x node_modules/.bin/tauri || -d node_modules/@tauri-apps/cli ]]; then
  TAV="$(node_modules/.bin/tauri --version 2>/dev/null || true)"
  ok "Tauri CLI ${TAV:-present} (local @tauri-apps/cli)"
  PASS=$((PASS+1))
else
  if [[ -d node_modules ]]; then
    fail "@tauri-apps/cli not installed — fix: bun install"
  else
    fail "node_modules missing — fix: bun install"
  fi
  FAIL=$((FAIL+1))
fi

# ── Source icon (canonical app icon for the regen step in build-gui-mac.sh) ──
if [[ -f prototype/pure-diamond.svg ]]; then
  ok "icon source prototype/pure-diamond.svg"
  PASS=$((PASS+1))
else
  warn "prototype/pure-diamond.svg missing — icon regen in build-gui-mac.sh will be skipped"
  WARN=$((WARN+1))
fi

# ════════════════════════════════════════════════════════════════════════
hdr "5. Signing"
# ════════════════════════════════════════════════════════════════════════

# ── Tauri updater signing key (required: createUpdaterArtifacts=true) ──
KEY_SET=0
if [[ -f "$HOME/.tauri/pure.key" ]]; then
  ok "updater signing key: ~/.tauri/pure.key"
  PASS=$((PASS+1))
  KEY_SET=1
fi
if [[ -f .env.local ]] && grep -q '^TAURI_SIGNING_PRIVATE_KEY=' .env.local 2>/dev/null; then
  ok "TAURI_SIGNING_PRIVATE_KEY set in .env.local"
  PASS=$((PASS+1))
  KEY_SET=1
fi
if [[ "${TAURI_SIGNING_PRIVATE_KEY:-}" != "" ]]; then
  ok "TAURI_SIGNING_PRIVATE_KEY exported in this shell"
  PASS=$((PASS+1))
  KEY_SET=1
fi
if [[ "$KEY_SET" -eq 0 ]]; then
  warn "no updater signing key found"
  warn "  fix: bash scripts/setup-mac-toolchain.sh   (or manually:)"
  warn "       npx tauri signer generate -w ~/.tauri/pure.key"
  WARN=$((WARN+1))
fi

# ── Apple distribution credentials (optional: only for Developer ID mode) ──
if [[ -n "${APPLE_DEVELOPER_IDENTITY:-}" || -n "${APPLE_ID:-}" ]]; then
  ok "Apple distribution env vars present (Developer ID mode)"
  PASS=$((PASS+1))
  [[ -n "${APPLE_DEVELOPER_IDENTITY:-}" ]] && ok "  APPLE_DEVELOPER_IDENTITY set"
  [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && ok "  APPLE_APP_SPECIFIC_PASSWORD set"
else
  warn "no Apple distribution credentials (fine for ad-hoc local builds;"
  warn "  set APPLE_DEVELOPER_IDENTITY/APPLE_ID to enable signing+notarization)"
  WARN=$((WARN+1))
fi

# ════════════════════════════════════════════════════════════════════════
hdr "6. Environment"
# ════════════════════════════════════════════════════════════════════════

# ── Free disk (full Xcode install needs ~15 GB) ──
FREE_GB="$(df -k / 2>/dev/null | awk 'NR==2 { print int($4/1024/1024) }')"
if [[ -n "$FREE_GB" && "$FREE_GB" -gt 0 ]]; then
  if [[ "$FREE_GB" -lt 20 ]]; then
    warn "only ${FREE_GB}GB free disk — installing full Xcode needs ~15GB"
    WARN=$((WARN+1))
  else
    ok "${FREE_GB}GB free disk"
    PASS=$((PASS+1))
  fi
fi

# ════════════════════════════════════════════════════════════════════════
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  info "Verdict: toolchain ready — ${PASS} pass, ${WARN} warn, ${FAIL} fail"
  info "Next: bun run build:gui:mac"
  exit 0
else
  c_echo "${C_RED}" "Verdict: ${FAIL} critical item(s) missing — ${PASS} pass, ${WARN} warn"
  info "Next: bash scripts/setup-mac-toolchain.sh   (installs everything missing)"
  exit 1
fi

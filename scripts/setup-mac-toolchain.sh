#!/usr/bin/env bash
# scripts/setup-mac-toolchain.sh
# One-shot installer for the COMPLETE macOS build toolchain (the machine-side
# half of `bun run build:gui:mac`). Idempotent: installs/upgrades ONLY what is
# missing — safe to re-run any time. Run the doctor first to see the gaps:
#
#   bash scripts/check-toolchain.sh
#   bash scripts/setup-mac-toolchain.sh [--yes] [--dry-run] [--skip-xcode]
#
# Options:
#   --dry-run       print the plan without changing anything
#   --yes           skip interactive confirmations
#   --skip-xcode    skip the full-Xcode step (CLT-only builds will not work)
#   --skip-bun-install  don't run `bun install` for project deps
#
# Env overrides:
#   XCODE_VERSION=x.y.z   pin the Xcode version (default: latest compatible)
#   NO_COLOR=1            plain output
#
# What it installs (in order):
#   1. Homebrew (if missing)
#   2. Xcode Command Line Tools (if xcode-select -p is empty)
#   3. Full Xcode.app via the `xcodes` cask (REQUIRED by Tauri v2) — the only
#      step that needs an Apple ID; xcodes signin prompts for it
#   4. Rust via rustup + the native arch target (aarch64 too, for universal)
#   5. Bun (or upgrade when stale)
#   6. Node via brew (optional)
#   7. bun install (project dependencies, unless --skip-bun-install)
#   8. Tauri updater signing key (if missing) + pubkey sync into tauri.conf.json
#
# Never downgrades anything; never touches your Apple signing identity.

set -uo pipefail

# Resolve symlinks + cd so repo-root-relative paths (node_modules, .env.local,
# scripts/sync-pubkey.sh, …) stay stable no matter what CWD the script is
# invoked from (same preamble as scripts/build-gui-mac.sh).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── Flags ──
DRY_RUN=0
ASSUME_YES=0
SKIP_XCODE=0
SKIP_BUN_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes)     ASSUME_YES=1 ;;
    --skip-xcode) SKIP_XCODE=1 ;;
    --skip-bun-install) SKIP_BUN_INSTALL=1 ;;
    *) echo "  unknown option: $arg (see header for usage)" >&2; exit 2 ;;
  esac
done

# ── Color helpers (macOS bash-3.2 compatible; mirrors scripts/sign-app.sh) ──
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  readonly C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_CYAN=$'\033[36m'
  readonly C_GREEN=$'\033[32m' C_RED=$'\033[31m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
  readonly C_BOLD='' C_DIM='' C_CYAN='' C_GREEN='' C_RED='' C_YELLOW='' C_RESET=''
fi

c_echo() { local color="$1"; shift; printf '%s%s%s\n' "$color" "$*" "$C_RESET"; }
info()   { c_echo "${C_BOLD}${C_CYAN}"  "  ▶ $*"; }
ok()     { c_echo "${C_GREEN}"          "  ✓ $*"; }
warn()   { c_echo "${C_YELLOW}"         "  ! $*"; }
fail()   { c_echo "${C_RED}"            "  ✗ $*" >&2; }
hdr()    { echo ""; c_echo "${C_BOLD}"  "═══ $* ═══"; }

[[ "$(uname -s)" == "Darwin" ]] || { fail "macOS only (detected: $(uname -s))"; exit 1; }

# Execute a command (or show it under --dry-run).
doit() {
  local label="$1"; shift
  echo "  ▶ $label"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    # %q keeps quoting intact so the plan reads like the real command
    printf '      '
    printf '%q ' "$@"
    echo
    return 0
  fi
  "$@" || { fail "failed: $*"; exit 1; }
}

# Execute a shell pipeline string (for curl | bash installers). The string is
# only eval'd on a real run, so --dry-run neither hits the network nor dumps
# fetched script text.
pipeit() {
  local label="$1" cmd="$2"
  echo "  ▶ $label"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '      %s\n' "$cmd" | sed "s|$HOME|~|g"
    return 0
  fi
  eval "$cmd" || { fail "failed: $label"; exit 1; }
}

confirm() {
  # dry-run: auto-accept so the full plan previews without prompting
  [[ "$DRY_RUN" -eq 1 || "$ASSUME_YES" -eq 1 ]] && return 0
  printf '  Proceed? [y/N] '
  local ans
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

has() { command -v "$1" >/dev/null 2>&1; }

echo ""
info "pure — macOS build toolchain setup"
if [[ "$DRY_RUN" -eq 1 ]]; then echo "  ${C_DIM}(dry-run: showing the plan, changing nothing)${C_RESET}"; fi

# ════════════════════════════════════════════════════════════════════════
hdr "1. Homebrew"
# ════════════════════════════════════════════════════════════════════════
if has brew; then
  ok "Homebrew $(brew --version 2>/dev/null | sed -n '1p' | sed 's/^Homebrew //')"
else
  warn "Homebrew missing — installing (needs sudo; the official script)"
  if confirm; then
    pipeit "install Homebrew (official script)" \
      "/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  else
    warn "skipped Homebrew (xcodes / node steps below will be skipped too)"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "2. Xcode Command Line Tools"
# ════════════════════════════════════════════════════════════════════════
if [[ -n "$(xcode-select -p 2>/dev/null)" ]]; then
  ok "Command Line Tools: $(xcode-select -p)"
else
  warn "Command Line Tools missing — run 'xcode-select --install' and click Install"
  warn "  (xcode-select opens a GUI prompt; it cannot be automated)"
  echo "      xcode-select --install"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "3. Full Xcode.app (required by Tauri v2)"
# ════════════════════════════════════════════════════════════════════════
XCODE_APP=""
for p in /Applications/Xcode.app /Applications/Xcode-beta.app "$HOME/Applications/Xcode.app"; do
  [[ -d "$p" ]] && XCODE_APP="$p" && break
done
if [[ -n "$XCODE_APP" ]]; then
  ok "Xcode.app found: $XCODE_APP"
  XSEL="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$XSEL" != "$XCODE_APP/Contents/Developer" ]]; then
    warn "xcode-select points at '$XSEL' — repointing to Xcode (needs sudo)"
    doit "xcode-select -s $XCODE_APP/Contents/Developer" \
      sudo xcode-select -s "$XCODE_APP/Contents/Developer"
  fi
  if ! xcodebuild -version >/dev/null 2>&1; then
    warn "Xcode not licensed / first launch incomplete — fixing (needs sudo)"
    doit "xcodebuild -license accept" sudo xcodebuild -license accept
    doit "xcodebuild -runFirstLaunch"  sudo xcodebuild -runFirstLaunch
  fi
elif [[ "$SKIP_XCODE" -eq 1 ]]; then
  warn "--skip-xcode set: leaving full Xcode uninstalled (CLT-only builds will FAIL)"
else
  warn "full Xcode.app not found — installing via Homebrew 'xcodes' cask"
  warn "  Downloads ~10–15GB from Apple and needs an Apple ID:"
  warn "    brew install --cask xcodes && xcodes signin   (Apple ID + 2FA)"
  if confirm; then
    if ! has brew; then
      fail "Homebrew is required to install xcodes — re-run after installing Homebrew"
      exit 1
    fi
    if ! has xcodes; then
      doit "brew install --cask xcodes" brew install --cask xcodes
    fi
    if has xcodes && ! xcodes list >/dev/null 2>&1; then
      warn "xcodes is not signed in — run: xcodes signin"
      warn "  (or: xcodes signin --apple-id YOU@MAIL --password APP-PASSWORD — 2FA still interactive)"
    fi
    XV="${XCODE_VERSION:-}"
    if [[ -z "$XV" ]]; then
      # `xcodes install --latest` fetches the NEWEST Xcode, which in recent
      # years requires a newer macOS than this machine may have — on macOS 14
      # it would download ~15GB then fail to launch. Pin a Sonoma-compatible
      # release and let the user override (set XCODE_VERSION or answer below).
      warn "macOS $(sw_vers -productVersion) is Sonoma: Xcode 16.x is the newest"
      warn "  supported line (Xcode 26 needs macOS 15+). Defaulting to 16.2."
      if has xcodes && xcodes list >/dev/null 2>&1; then
        info "Xcode versions available to your Apple ID:"
        xcodes list 2>/dev/null | sed 's/^/    /' | head -15
      fi
      XV="16.2"
      if [[ "$DRY_RUN" -eq 1 || "$ASSUME_YES" -eq 1 ]]; then
        warn "  (auto-accepted: Xcode $XV — override with XCODE_VERSION=… )"
      else
        printf '  Xcode version to install [%s]: ' "$XV"
        xv_in=""
        read -r xv_in
        [[ -n "$xv_in" ]] && XV="$xv_in"
      fi
    fi
    doit "xcodes install $XV" xcodes install "$XV" --experimental-unxip
    if [[ -d /Applications/Xcode.app ]]; then
      doit "xcode-select -s /Applications/Xcode.app/Contents/Developer" \
        sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
      doit "xcodebuild -license accept" sudo xcodebuild -license accept
      doit "xcodebuild -runFirstLaunch"  sudo xcodebuild -runFirstLaunch
    elif [[ "$DRY_RUN" -eq 0 ]]; then
      warn "Xcode did not land at /Applications/Xcode.app — select it manually:"
      warn "  sudo xcode-select -s <path>/Contents/Developer"
    fi
  else
    warn "skipped. Install manually via the Mac App Store, then re-run this script"
    warn "  (or: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer)"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "4. Rust toolchain"
# ════════════════════════════════════════════════════════════════════════
if ! has rustup; then
  if has rustc; then
    warn "rustc present but rustup missing (brew-installed Rust works, rustup is recommended)"
  fi
  if [[ "$DRY_RUN" -eq 1 ]] || confirm; then
    pipeit "install rustup (stable, minimal profile)" \
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable"
    # rustup's env must be in the current shell for the target step below
    if [[ -f "$HOME/.cargo/env" ]]; then
      set -a; . "$HOME/.cargo/env"; set +a
    fi
  else
    warn "skipped rustup install"
  fi
else
  ok "rustup present"
fi

if has rustup; then
  TARGET="$(uname -m)-apple-darwin"
  if rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    ok "rust target $TARGET"
  else
    doit "rustup target add $TARGET" rustup target add "$TARGET"
  fi
  # aarch64 target enables universal (both-arch) builds — optional but cheap
  if ! rustup target list --installed 2>/dev/null | grep -qx "aarch64-apple-darwin"; then
    doit "rustup target add aarch64-apple-darwin (universal builds)" \
      rustup target add aarch64-apple-darwin
  fi
  RV="$(rustc --version 2>/dev/null | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)"
  if [[ -n "$RV" && "$(echo "$RV" | cut -d. -f2)" -lt 75 ]]; then
    warn "rustc $RV is below Tauri's ~1.75 MSRV — upgrading"
    doit "rustup update stable" rustup update stable
  else
    ok "rustc ${RV:-?}"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "5. Bun runtime"
# ════════════════════════════════════════════════════════════════════════
if has bun; then
  BV="$(bun --version 2>/dev/null)"
  ok "bun $BV"
  if [[ "$(echo "$BV" | cut -d. -f1)" -lt 1 ]]; then
    warn "bun $BV is stale — upgrading"
    doit "bun upgrade" bun upgrade
  fi
else
  if confirm; then
    pipeit "install bun (https://bun.sh)" \
      "curl -fsSL https://bun.sh/install | bash"
    warn "bun installed to ~/.bun/bin — add it to PATH:  export PATH=\"\$HOME/.bun/bin:\$PATH\""
  else
    warn "skipped bun install (the project requires bun for every npm script)"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
hdr "6. Node (optional)"
# ════════════════════════════════════════════════════════════════════════
if has node; then
  ok "node $(node --version 2>/dev/null)"
elif has brew; then
  warn "node missing (optional) — installing via brew"
  doit "brew install node" brew install node
else
  warn "node missing (optional) — install via https://nodejs.org"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "7. Project dependencies"
# ════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_BUN_INSTALL" -eq 1 ]]; then
  warn "--skip-bun-install set — leaving node_modules alone"
elif [[ ! -d node_modules ]]; then
  doit "bun install" bun install
else
  ok "node_modules present (re-run with --skip-bun-install to skip)"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "8. Tauri updater signing key"
# ════════════════════════════════════════════════════════════════════════
KEY_SET=0
[[ -f "$HOME/.tauri/pure.key" ]] && KEY_SET=1
[[ -f .env.local ]] && grep -q '^TAURI_SIGNING_PRIVATE_KEY=' .env.local 2>/dev/null && KEY_SET=1
[[ "${TAURI_SIGNING_PRIVATE_KEY:-}" != "" ]] && KEY_SET=1
if [[ "$KEY_SET" -eq 1 ]]; then
  ok "updater signing key present"
else
  warn "no updater signing key — generating one now"
  warn "  NOTE: this changes the updater public key; tauri.conf.json's pubkey"
  warn "  will be re-synced, and your update server must serve the NEW key"
  if confirm; then
    TAURI_BIN="node_modules/.bin/tauri"
    if [[ -x "$TAURI_BIN" ]]; then
      doit "$TAURI_BIN signer generate -w $HOME/.tauri/pure.key" \
        "$TAURI_BIN" signer generate -w "$HOME/.tauri/pure.key"
    else
      doit "npx tauri signer generate -w $HOME/.tauri/pure.key" \
        npx tauri signer generate -w "$HOME/.tauri/pure.key"
    fi
    if [[ -f scripts/sync-pubkey.sh ]]; then
      doit "sync new pubkey into tauri.conf.json" bash scripts/sync-pubkey.sh
    fi
  else
    warn "skipped key generation — the build will fail at the updater-artifact step"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
echo ""
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "dry-run complete — re-run without --dry-run to apply."
else
  info "setup complete — verifying with the doctor…"
  bash scripts/check-toolchain.sh
fi

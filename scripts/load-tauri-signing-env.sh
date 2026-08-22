#!/usr/bin/env bash
# scripts/load-tauri-signing-env.sh
# Populate TAURI_SIGNING_PRIVATE_KEY (+ optional TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
# for the current shell + child processes so `bun run gui:build` can sign the
# auto-updater sidecar (.app.tar.gz → .sig).
#
# Two invocation modes (both supported):
#
#   Source-mode  [preferred — package.json uses this]
#     . scripts/load-tauri-signing-env.sh
#     Runs IN the calling shell, so the exported vars persist for the
#     rest of `&& bun run gui:build && bun run sign:mac`. Failure
#     returns 1 (does NOT kill your interactive shell).
#
#   Exec-mode  [diagnostic / CI use]
#     bash scripts/load-tauri-signing-env.sh
#     Runs as a subprocess. Env vars die with the subprocess; only
#     useful as a "is my key loadable?" smoke test. Failure exits 1.
#
# Source precedence (in both modes):
#   1. ./.env.local                                     (gitignored; canonical dev-machine path)
#   2. $HOME/.tauri/pure.key                            (Tauri's default unencrypted-key location)
#
# Recommended .env.local form (keeps the key on disk; Tauri reads it at build):
#   TAURI_SIGNING_PRIVATE_KEY=file://$HOME/.tauri/pure.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...             # only if -w was used when generating
#
# Local-build opt-out: set PURE_SKIP_UPDATER_SIGN=1 (in .env.local or the
# shell) to skip the key requirement entirely — used with build-gui-mac.sh's
# matching switch so `tauri build` also disables createUpdaterArtifacts.

# ── Detect sourced vs executed ──
# When sourced via `. script.sh` or `source script.sh`:
#   BASH_SOURCE[0] is this script's path;  $0 is the parent shell's name.
# When executed via `bash script.sh` or as a subprocess:
#   Both are identical.
# Default both to empty so set -u doesn't trip on shells without BASH_SOURCE.
_BASH_SOURCE_0="${BASH_SOURCE[0]:-}"
_SOURCED=0
[[ "${_BASH_SOURCE_0}" != "" && "${_BASH_SOURCE_0}" != "${0}" ]] && _SOURCED=1

_die() {
  printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
  printf '\033[36m→\033[0m Generate a key with:  npx tauri signer generate -w ~/.tauri/pure.key\n' >&2
  printf '\033[36m→\033[0m Or create .env.local next to package.json:\n' >&2
  printf '       \033[2mcp .env.example .env.local\033[0m\n' >&2
  printf '\033[36m→\033[0m See SIGNING.md for full flow + rotation procedure.\n' >&2
  if [[ "${_SOURCED}" -eq 1 ]]; then
    return 1 2>/dev/null || exit 1
  fi
  exit 1
}

# ── 1. Source .env.local if present (auto-export every var read) ──
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

# ── 1.5 Local build opt-out (checked AFTER .env.local so the flag can live
#       there). Skip the key entirely — no loud failure, no decryption. ──
if [[ "${PURE_SKIP_UPDATER_SIGN:-0}" == "1" ]]; then
  printf '\033[33m⏭\033[0m PURE_SKIP_UPDATER_SIGN=1 — skipping updater signing key load\n'
  if [[ "${_SOURCED}" -eq 1 ]]; then
    return 0
  fi
  exit 0
fi

# ── 2. Fall back to Tauri's default unencrypted key location ──
# If .env.local explicitly said file://…, leave it; Tauri reads the file directly.
# Otherwise, if ~/.tauri/pure.key exists and we have nothing, read it into env.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.tauri/pure.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/pure.key")"
fi

# ── 3. Loud failure if we still have nothing ──
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  _die "TAURI_SIGNING_PRIVATE_KEY is not set."
fi

# ── 4. Masked diagnostic — secret bytes never echoed ──
val="${TAURI_SIGNING_PRIVATE_KEY}"
if [[ "$val" == file://* ]]; then
  # file:// form — Tauri reads the file at build time. Don't claim "key length".
  printf '\033[32m✓\033[0m TAURI_SIGNING_PRIVATE_KEY=file://…  source='
  if [[ -f .env.local ]] && grep -q '^TAURI_SIGNING_PRIVATE_KEY=' .env.local; then
    printf '.env.local'
  else
    printf '(default)'
  fi
else
  printf '\033[32m✓\033[0m TAURI_SIGNING_PRIVATE_KEY loaded (length=%d, source=' "${#val}"
  if [[ -f .env.local ]] && grep -q '^TAURI_SIGNING_PRIVATE_KEY=' .env.local; then
    printf '.env.local'
  else
    printf '$HOME/.tauri/pure.key'
  fi
  printf ')'
fi
printf ', password='
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  printf 'set'
else
  printf '(none)'
fi
printf '\n'

# Source-mode: env was just exported into the calling shell — caller continues
# with `&& bun run gui:build`.  Exec-mode: caller gets nothing from this process
# because subprocess envs don't propagate back, so this is purely diagnostic.

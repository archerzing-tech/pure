#!/usr/bin/env bash
# scripts/sync-pubkey.sh
# Read ~/.tauri/pure.key.pub (the minisign public-key file), base64-encode its
# full content into a single line, and patch `plugins.updater.pubkey` in
# src-tauri/tauri.conf.json. Use after key rotation or to install the public
# half of a freshly generated keypair so the running app can verify future
# updates.
#
# Usage:
#   bash scripts/sync-pubkey.sh                          # default ~/.tauri/pure.key.pub → tauri.conf.json
#   bash scripts/sync-pubkey.sh /path/to/other.pub       # custom input file
#   bash scripts/sync-pubkey.sh --dry-run                # print base64 value, don't write
#   bash scripts/sync-pubkey.sh /path/to/other.pub --dry-run

set -euo pipefail

DRY_RUN=0
PUB_PATH="$HOME/.tauri/pure.key.pub"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) PUB_PATH="$arg" ;;
  esac
done

TAURI_CONF="src-tauri/tauri.conf.json"
if [[ ! -f "$PUB_PATH" ]]; then
  printf '\033[1;31m✗\033[0m Public key file not found: %s\n' "$PUB_PATH" >&2
  printf '\033[36m→\033[0m Generate one with:  npx tauri signer generate -w ~/.tauri/pure.key\n' >&2
  exit 1
fi

PUB_B64="$(base64 -i "$PUB_PATH" | tr -d '\n')"

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '\033[36m→\033[0m [dry-run] would set plugins.updater.pubkey to:\n\033[2m%s\033[0m\n' "$PUB_B64"
  printf '\033[2m(Decoded back to original file? %s)\033[0m\n' "$([[ "$(printf '%s' "$PUB_B64" | base64 -d)" == "$(cat "$PUB_PATH")" ]] && echo yes || echo NO)"
  exit 0
fi

if [[ ! -f "$TAURI_CONF" ]]; then
  printf '\033[1;31m✗\033[0m Tauri config not found: %s\n' "$TAURI_CONF" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  TMP="$(mktemp)"
  jq --arg k "$PUB_B64" '.plugins.updater.pubkey = $k' "$TAURI_CONF" > "$TMP"
  mv "$TMP" "$TAURI_CONF"
else
  TMP="$(mktemp)"
  node -e "const fs=require('fs');const k=process.argv[1];const p=process.argv[2];const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.plugins=c.plugins||{};c.plugins.updater=c.plugins.updater||{};c.plugins.updater.pubkey=k;fs.writeFileSync(p+'.new',JSON.stringify(c,null,2)+'\\n')" "$PUB_B64" "$TAURI_CONF"
  mv "$TAURI_CONF.new" "$TAURI_CONF"
fi

printf '\033[32m✓\033[0m Updated plugins.updater.pubkey in %s from %s\n' "$TAURI_CONF" "$PUB_PATH"

# Round-trip verify
DECODED="$(printf '%s' "$PUB_B64" | base64 -d)"
if [[ "$DECODED" == "$(cat "$PUB_PATH")" ]]; then
  printf '\033[32m✓\033[0m Round-trip verified — pubkey decodes to identical file content.\n'
else
  printf '\033[1;31m✗\033[0m Round-trip MISMATCH — file content differs. Manual check needed.\n' >&2
  exit 1
fi

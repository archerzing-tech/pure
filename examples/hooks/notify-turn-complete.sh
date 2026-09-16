#!/usr/bin/env bash
# pure user hook — desktop notification (on_turn_complete)
#
# Fires once per finished turn (first run and every follow-up), awaited
# before the turn returns. Keep it fast — a slow hook delays your next
# prompt. Output is not fed back to the model.
set -euo pipefail

case "$(uname -s)" in
  Darwin) osascript -e 'display notification "Turn complete" with title "pure"' >/dev/null ;;
  Linux)  notify-send "pure" "Turn complete" 2>/dev/null || true ;;
  *)      ;;  # Windows: swap in a PowerShell toast if you want one
esac

#!/usr/bin/env bash
# pure user hook — auto-test (on_post_tool, matcher: write_file / edit_file)
#
# After pure edits a source file, run the test suite once. stdout is appended
# to the tool result the model reads on its next THINK, so stay silent on
# success and speak up on failure — the model then fixes the regression
# itself instead of wading through noise after every edit.
#
# Stdin: one JSON line, e.g.
#   {"event":"on_post_tool","tool":"write_file","args":{"path":"src/x.ts"},"success":true}
#
# Requires jq (brew install jq / apt install jq). If jq is missing the hook
# exits silently rather than failing every edit.
set -euo pipefail

path=$(jq -r '.args.path // empty' 2>/dev/null || true)
case "$path" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs) ;;  # source code — worth testing
  *) exit 0 ;;                              # docs, assets, config — not so much
esac

if ! bun test >/dev/null 2>&1; then
  echo "auto-test hook: the suite FAILS after the edit to $path — run the tests, fix the failures, then continue."
fi

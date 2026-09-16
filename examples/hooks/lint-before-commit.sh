#!/usr/bin/env bash
# pure user hook — lint before commit (on_pre_tool, matcher: execute_command)
#
# Blocks `git commit` while the lint suite fails. Exit code 2 vetoes the tool
# call deterministically, and the stderr below becomes the reason the model
# sees — it fixes lint and retries instead of committing red code. Any other
# exit code would only be advisory.
#
# Stdin: one JSON line, e.g.
#   {"event":"on_pre_tool","tool":"execute_command","args":{"command":"git commit -m ..."}}
#
# Requires jq (brew install jq / apt install jq). If jq is missing the hook
# exits silently rather than gating every command.
set -euo pipefail

command=$(jq -r '.args.command // empty' 2>/dev/null || true)
case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;;   # not a commit — nothing to gate
esac

if ! bun run lint >/dev/null 2>&1; then
  echo "lint-before-commit hook: lint fails — fix the lint errors, then commit again." >&2
  exit 2
fi

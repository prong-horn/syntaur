#!/usr/bin/env bash
# Syntaur codex notify spool writer (chain-aware). Wire it in ~/.codex/config.toml:
#   notify = ["/abs/path/to/notify-spool.sh"]
# or, preserving an existing notify program:
#   notify = ["/abs/path/to/notify-spool.sh", "--chain", "/prior/program", "prior-arg"]
# Codex appends the event payload as the FINAL argument. Always exits 0.

set -o pipefail 2>/dev/null || true

PAYLOAD="${@: -1}"

if [ -n "${SYNTAUR_HOOK_SPOOL:-}" ] && [ -f "$SYNTAUR_HOOK_SPOOL" ] \
   && [ -n "$PAYLOAD" ] && command -v jq >/dev/null 2>&1; then
  AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '%s' "$PAYLOAD" \
    | jq -c --arg at "$AT" '{event: "notify", at: $at, payload: .}' \
    >> "$SYNTAUR_HOOK_SPOOL" 2>/dev/null \
  || jq -nc --arg at "$AT" --arg raw "$PAYLOAD" '{event: "notify", at: $at, payload: {raw: $raw}}' \
    >> "$SYNTAUR_HOOK_SPOOL" 2>/dev/null \
  || true
fi

if [ "${1:-}" = "--chain" ] && [ "$#" -ge 3 ]; then
  shift
  CHAIN_ARGC=$(($# - 1))
  "${@:1:$CHAIN_ARGC}" "$PAYLOAD" >/dev/null 2>&1 || true
fi

exit 0

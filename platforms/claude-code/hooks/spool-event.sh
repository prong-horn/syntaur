#!/usr/bin/env bash
# Syntaur hook-event spool writer — append ONE NDJSON line to the spool the
# pty-host planted in SYNTAUR_HOOK_SPOOL (daemon-hosted sessions only; a
# no-op everywhere else). PURE OBSERVER: never emits stdout JSON (a
# PermissionRequest hook that emitted output could influence the decision),
# never blocks, ALWAYS exits 0.

set -o pipefail 2>/dev/null || true

[ -n "${SYNTAUR_HOOK_SPOOL:-}" ] || exit 0
[ -f "$SYNTAUR_HOOK_SPOOL" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# jq -c emits exactly one line; >> opens O_APPEND. Payload = stdin verbatim
# (D3) — the adapter, not this script, decides which fields matter.
printf '%s' "$INPUT" \
  | jq -c --arg at "$AT" '{event: (.hook_event_name // "unknown"), at: $at, payload: .}' \
  >> "$SYNTAUR_HOOK_SPOOL" 2>/dev/null || true

exit 0

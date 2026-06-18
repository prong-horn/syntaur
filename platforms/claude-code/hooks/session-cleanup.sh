#!/usr/bin/env bash
# Syntaur SessionEnd Hook — thin wrapper around `syntaur session stop`.
# The CLI resolves the ENDING session's id (stdin .session_id first, the shared
# context.json scalar only as a fallback) and marks the row stopped with a
# direct DB write. No dashboard required. Reads JSON from stdin, always exits 0.

set -o pipefail 2>/dev/null || true

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

command -v syntaur >/dev/null 2>&1 || exit 0

# Bounded SIGKILL watchdog (portable — no `timeout` on stock macOS). ~4s stays
# under the hook's `timeout: 5` budget. A stale CLI without the subcommand
# exits non-zero — swallowed; the scanner sweeps the row on its next tick.
syntaur_bounded_stop() {
  local cpid kpid rc
  printf '%s' "$INPUT" | syntaur session stop --from-hook >/dev/null 2>&1 &
  cpid=$!
  ( sleep 4; kill -KILL "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  kpid=$!
  wait "$cpid" 2>/dev/null
  rc=$?
  kill -KILL "$kpid" 2>/dev/null
  wait "$kpid" 2>/dev/null
  return "$rc"
}
syntaur_bounded_stop || true

# Keep derived status fresh on session end so an assignment doesn't sit stale
# after the agent walks away. Best-effort, bounded (~3s, no `timeout` on macOS),
# and migration-gated (`--if-migrated`) so it can't re-derive pre-migration
# assignments during rollout. Resolves the assignment from the ending session's
# cwd `.syntaur/context.json`; no-ops silently when none is present.
HOOK_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
syntaur_bounded_recompute() {
  local cpid kpid rc
  [ -n "$HOOK_CWD" ] && [ -f "$HOOK_CWD/.syntaur/context.json" ] || return 0
  ( cd "$HOOK_CWD" 2>/dev/null && syntaur recompute --if-migrated >/dev/null 2>&1 ) &
  cpid=$!
  ( sleep 3; kill -KILL "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  kpid=$!
  wait "$cpid" 2>/dev/null
  rc=$?
  kill -KILL "$kpid" 2>/dev/null
  wait "$kpid" 2>/dev/null
  return "$rc"
}
syntaur_bounded_recompute || true

exit 0

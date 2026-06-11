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

exit 0

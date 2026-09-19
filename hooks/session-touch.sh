#!/usr/bin/env bash
# Syntaur session heartbeat — thin wrapper around `syntaur session touch`.
#
# The stale sweep decides a session is abandoned from `sessions.updated_at`
# alone, and nothing else moves that column mid-session (register, revive and a
# status change are the only other writers). Without this hook, any session
# longer than the idle window would be swept while it is alive.
#
# RATE LIMITED to one write per five minutes per session via a stamp file, so a
# tool-heavy turn does not hammer SQLite. Wired to PostToolUse (the common
# case).
#
# Reads the hook JSON from stdin. Always exits 0.

set -o pipefail 2>/dev/null || true

. "${BASH_SOURCE[0]%/*}/lib.sh"

command -v jq >/dev/null 2>&1 || exit 0
command -v syntaur >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0

# Reject anything that is not a plain session id before it reaches a path.
printf '%s' "$SID" | grep -Eq '^[A-Za-z0-9._-]+$' || exit 0

STAMP_DIR="${SYNTAUR_HOME:-$HOME/.syntaur}/runtime/touch"
STAMP="$STAMP_DIR/$SID"
mkdir -p "$STAMP_DIR" 2>/dev/null || exit 0

# One write per 300s. `find -newermt` is not portable to stock macOS, so compare
# mtimes numerically: BSD `stat -f %m` first, GNU `stat -c %Y` second.
if [ -f "$STAMP" ]; then
  LAST=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ -n "$LAST" ] && [ "$LAST" -gt 0 ] 2>/dev/null; then
    AGE=$((NOW - LAST))
    [ "$AGE" -lt 300 ] && exit 0
  fi
fi

if printf '%s' "$INPUT" | syntaur_bounded 4 session touch --from-hook >/dev/null 2>&1; then
  # Only stamp on success, so a failed touch retries on the next tool call
  # rather than going quiet for five minutes.
  : > "$STAMP" 2>/dev/null || true
fi

exit 0

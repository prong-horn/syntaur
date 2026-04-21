#!/usr/bin/env bash
# Syntaur Codex resolve-session helper
# Finds the most-recent Codex rollout file whose session_meta.payload.cwd
# matches $1 (default $PWD) and emits two lines to stdout:
#   session_id=<id>
#   transcript_path=<absolute path>
# Exits non-zero with nothing on stdout if no match.
#
# Override the search root via CODEX_SESSIONS_DIR (default: $HOME/.codex/sessions).
# Known limitation: if multiple concurrent Codex sessions share the same cwd,
# this picks the newest-by-mtime. Users can bypass by passing --session-id and
# --transcript-path explicitly to `syntaur track-session`.

set -o pipefail 2>/dev/null || true

command -v jq >/dev/null 2>&1 || { exit 1; }

TARGET_CWD="${1:-$PWD}"
SESSIONS_ROOT="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"

shopt -s nullglob 2>/dev/null || true

# Expand the glob explicitly via bash. If no files match, `files` stays empty
# and we exit without invoking ls — guards against `ls -1t` falling back to
# listing the current directory when the glob strips to zero operands.
files=("$SESSIONS_ROOT"/*/*/*/rollout-*.jsonl)
[ "${#files[@]}" -eq 0 ] && exit 1

MATCHED_FILE=""
MATCHED_ID=""

while IFS= read -r f; do
  [ -z "$f" ] && continue
  FIRST=$(head -n 1 "$f" 2>/dev/null)
  [ -z "$FIRST" ] && continue
  SESSION_CWD=$(printf '%s' "$FIRST" | jq -r 'select(.type=="session_meta") | .payload.cwd // empty' 2>/dev/null)
  SESSION_ID=$(printf '%s' "$FIRST" | jq -r 'select(.type=="session_meta") | .payload.id // empty' 2>/dev/null)
  if [ "$SESSION_CWD" = "$TARGET_CWD" ] && [ -n "$SESSION_ID" ]; then
    MATCHED_FILE="$f"
    MATCHED_ID="$SESSION_ID"
    break
  fi
done < <(ls -1t "${files[@]}" 2>/dev/null)

[ -z "$MATCHED_FILE" ] && exit 1

printf 'session_id=%s\n' "$MATCHED_ID"
printf 'transcript_path=%s\n' "$MATCHED_FILE"
exit 0

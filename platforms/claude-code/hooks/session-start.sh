#!/usr/bin/env bash
# Syntaur SessionStart Hook
# (1) Merges the real Claude Code session_id + transcript_path into an
#     EXISTING .syntaur/context.json. Never creates context.json — that would
#     break grab-assignment's "context.json implies active assignment" semantic.
# (2) Pre-registers a minimal row in the dashboard sessions table so
#     SessionEnd's PATCH /status always has a row to target. Best-effort —
#     silently ignores dashboard-unreachable.
#
# Reads JSON from stdin per Claude Code SessionStart contract:
#   { "session_id": "...", "transcript_path": "...", "cwd": "...", ... }
#
# Always exits 0.

set -o pipefail 2>/dev/null || true

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0
[ -z "$CWD" ] && exit 0

CONTEXT_FILE="$CWD/.syntaur/context.json"

# REQUIRED invariant: only operate on an EXISTING context file. If the current
# cwd has no active Syntaur assignment, leave the filesystem untouched.
[ ! -f "$CONTEXT_FILE" ] && exit 0

# --- (1) Merge session fields into context.json.
# Always replace both sessionId and transcriptPath together. If the incoming
# transcript_path is empty, explicitly null the stored transcriptPath so a new
# session never inherits a stale transcript path from the prior session.
TMP="${CONTEXT_FILE}.tmp.$$"
jq \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  '. + {sessionId: $sid, transcriptPath: (if ($tp | length) > 0 then $tp else null end)}' \
  "$CONTEXT_FILE" > "$TMP" 2>/dev/null \
  && mv "$TMP" "$CONTEXT_FILE" 2>/dev/null \
  || rm -f "$TMP"

# --- (2) Best-effort pre-registration in the dashboard.
# Read project/assignment context if present so the pre-registered row is
# already linked. Upsert semantics on the server mean this is idempotent with
# later /track-session or grab-assignment calls.
MISSION_SLUG=$(jq -r '.projectSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
ASSIGNMENT_SLUG=$(jq -r '.assignmentSlug // empty' "$CONTEXT_FILE" 2>/dev/null)

PORT="${SYNTAUR_DASHBOARD_PORT:-}"
if [ -z "$PORT" ]; then
  PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")
fi

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  --arg proj "$MISSION_SLUG" \
  --arg assn "$ASSIGNMENT_SLUG" \
  --arg path "$CWD" \
  '{ agent: "claude", sessionId: $sid, path: $path }
   + (if ($tp   | length) > 0 then {transcriptPath: $tp}    else {} end)
   + (if ($proj | length) > 0 then {projectSlug: $proj}     else {} end)
   + (if ($assn | length) > 0 then {assignmentSlug: $assn}  else {} end)' 2>/dev/null)

if [ -n "$BODY" ]; then
  # --max-time bounds the hook's wall-clock cost if the dashboard socket
  # accepts but then hangs. The hook itself is registered with timeout: 5.
  curl -sf --max-time 3 -X POST "http://127.0.0.1:${PORT}/api/agent-sessions" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    -o /dev/null 2>/dev/null || true
fi

exit 0

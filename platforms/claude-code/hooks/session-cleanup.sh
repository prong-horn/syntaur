#!/usr/bin/env bash
# Syntaur SessionEnd Hook
# Logs and marks agent sessions as "stopped" when a Claude Code session exits.
# If the session was never registered but has an active assignment, registers it first.
# Reads JSON from stdin, always exits 0.

# --- Safety: never fail ---
set -o pipefail 2>/dev/null || true

# --- Step 1: Check for jq ---
if ! command -v jq &>/dev/null; then
  exit 0
fi

# --- Step 2: Read stdin ---
INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

# --- Step 3: Find context file ---
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$CWD" ]; then
  exit 0
fi

CONTEXT_FILE="$CWD/.syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  exit 0
fi

# --- Step 4: Extract context info ---
SESSION_ID=$(jq -r '.sessionId // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_SLUG=$(jq -r '.projectSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
ASSIGNMENT_SLUG=$(jq -r '.assignmentSlug // empty' "$CONTEXT_FILE" 2>/dev/null)

# Fall back to the SessionEnd stdin payload if context.json didn't have the id.
# Claude Code passes session_id on stdin for SessionEnd.
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
fi

# No real session id available — exit quietly. We never synthesize one.
[ -z "$SESSION_ID" ] && exit 0

# --- Dashboard endpoint resolution (mirror session-start.sh exactly so start
# and end hooks always target the same host:port) ---
PORT="${SYNTAUR_DASHBOARD_PORT:-}"
if [ -z "$PORT" ]; then
  PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")
fi

# --- Step 5: Mark session as stopped via dashboard API ---
BODY="{\"status\": \"stopped\"}"
if [ -n "$MISSION_SLUG" ]; then
  BODY="{\"status\": \"stopped\", \"projectSlug\": \"${MISSION_SLUG}\"}"
fi

curl -sf --max-time 3 -X PATCH "http://127.0.0.1:${PORT}/api/agent-sessions/${SESSION_ID}/status" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -o /dev/null 2>/dev/null || true

exit 0

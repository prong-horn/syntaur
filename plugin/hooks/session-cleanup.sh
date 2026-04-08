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
MISSION_SLUG=$(jq -r '.missionSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
ASSIGNMENT_SLUG=$(jq -r '.assignmentSlug // empty' "$CONTEXT_FILE" 2>/dev/null)

PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")

# --- Step 5: If no session was registered, try to auto-register (requires mission+assignment) ---
if [ -z "$SESSION_ID" ]; then
  # Can only auto-register if we have mission and assignment context
  if [ -z "$MISSION_SLUG" ] || [ -z "$ASSIGNMENT_SLUG" ]; then
    exit 0
  fi

  # Generate a session ID for the log entry
  SESSION_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "ses-$(date +%s)")
  # Lowercase the UUID (uuidgen on macOS outputs uppercase)
  SESSION_ID=$(echo "$SESSION_ID" | tr '[:upper:]' '[:lower:]')

  RESPONSE=$(curl -sf -X POST "http://localhost:${PORT}/api/agent-sessions" \
    -H "Content-Type: application/json" \
    -d "{\"missionSlug\": \"${MISSION_SLUG}\", \"assignmentSlug\": \"${ASSIGNMENT_SLUG}\", \"agent\": \"claude\", \"sessionId\": \"${SESSION_ID}\", \"path\": \"${CWD}\"}" \
    2>/dev/null) || true

  # If registration succeeded, update the context file with the session ID
  if [ -n "$RESPONSE" ]; then
    jq --arg sid "$SESSION_ID" '. + {sessionId: $sid}' "$CONTEXT_FILE" > "${CONTEXT_FILE}.tmp" 2>/dev/null \
      && mv "${CONTEXT_FILE}.tmp" "$CONTEXT_FILE" 2>/dev/null || true
  fi
fi

# --- Step 6: Mark session as stopped via dashboard API ---
BODY="{\"status\": \"stopped\"}"
if [ -n "$MISSION_SLUG" ]; then
  BODY="{\"status\": \"stopped\", \"missionSlug\": \"${MISSION_SLUG}\"}"
fi

curl -sf -X PATCH "http://localhost:${PORT}/api/agent-sessions/${SESSION_ID}/status" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -o /dev/null 2>/dev/null || true

exit 0

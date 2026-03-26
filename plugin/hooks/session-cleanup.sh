#!/usr/bin/env bash
# Syntaur SessionEnd Hook
# Marks agent sessions as "stopped" when a Claude Code session exits.
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

# --- Step 4: Extract session info ---
SESSION_ID=$(jq -r '.sessionId // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_SLUG=$(jq -r '.missionSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_DIR=$(jq -r '.missionDir // empty' "$CONTEXT_FILE" 2>/dev/null)
ASSIGNMENT_DIR=$(jq -r '.assignmentDir // empty' "$CONTEXT_FILE" 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ -z "$MISSION_SLUG" ]; then
  exit 0
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Step 5: Try dashboard API first ---
PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")
API_OK=false
if curl -sf -X PATCH "http://localhost:${PORT}/api/agent-sessions/${SESSION_ID}/status" \
  -H "Content-Type: application/json" \
  -d "{\"status\": \"stopped\", \"missionSlug\": \"${MISSION_SLUG}\"}" \
  -o /dev/null 2>/dev/null; then
  API_OK=true
fi

# --- Step 6: Fall back to direct file edit ---
if [ "$API_OK" = false ] && [ -n "$MISSION_DIR" ]; then
  INDEX_FILE="$MISSION_DIR/_index-sessions.md"
  if [ -f "$INDEX_FILE" ]; then
    # Replace status for the matching session ID line
    if grep -q "$SESSION_ID" "$INDEX_FILE"; then
      sed -i '' "/$SESSION_ID/s/| active |/| stopped |/" "$INDEX_FILE" 2>/dev/null ||
        sed -i "/$SESSION_ID/s/| active |/| stopped |/" "$INDEX_FILE" 2>/dev/null
      # Update activeSessions count
      ACTIVE_COUNT=$(grep -c "| active |" "$INDEX_FILE" 2>/dev/null || echo "0")
      sed -i '' "s/^activeSessions:.*/activeSessions: ${ACTIVE_COUNT}/" "$INDEX_FILE" 2>/dev/null ||
        sed -i "s/^activeSessions:.*/activeSessions: ${ACTIVE_COUNT}/" "$INDEX_FILE" 2>/dev/null
    fi
  fi
fi

# --- Step 7: Update assignment-level Sessions table ---
if [ -n "$ASSIGNMENT_DIR" ]; then
  ASSIGNMENT_FILE="$ASSIGNMENT_DIR/assignment.md"
  if [ -f "$ASSIGNMENT_FILE" ] && grep -q "$SESSION_ID" "$ASSIGNMENT_FILE"; then
    # Fill in Ended timestamp and set status to stopped
    sed -i '' "/$SESSION_ID/s/| *| active |/| ${NOW} | stopped |/" "$ASSIGNMENT_FILE" 2>/dev/null ||
      sed -i "/$SESSION_ID/s/| *| active |/| ${NOW} | stopped |/" "$ASSIGNMENT_FILE" 2>/dev/null
  fi
fi

exit 0

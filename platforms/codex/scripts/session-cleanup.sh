#!/usr/bin/env bash
# Syntaur SessionEnd hook for Codex plugins.
# Marks active agent sessions as stopped when a Codex session exits.

set -o pipefail 2>/dev/null || true

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$CWD" ]; then
  exit 0
fi

CONTEXT_FILE="$CWD/.syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  exit 0
fi

SESSION_ID=$(jq -r '.sessionId // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_SLUG=$(jq -r '.missionSlug // empty' "$CONTEXT_FILE" 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ -z "$MISSION_SLUG" ]; then
  exit 0
fi

PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")
curl -sf -X PATCH "http://localhost:${PORT}/api/agent-sessions/${SESSION_ID}/status" \
  -H "Content-Type: application/json" \
  -d "{\"status\": \"stopped\", \"missionSlug\": \"${MISSION_SLUG}\"}" \
  -o /dev/null 2>/dev/null || true

exit 0

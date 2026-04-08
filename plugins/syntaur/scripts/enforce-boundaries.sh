#!/usr/bin/env bash
# Syntaur write boundary enforcement hook for Codex plugins.
# Reads JSON from stdin and returns a block decision only for writes outside the
# active assignment boundary. Any parse or runtime error falls back to allow.

allow_and_exit() {
  echo '{}'
  exit 0
}

if ! command -v jq >/dev/null 2>&1; then
  echo '{"systemMessage":"Syntaur boundary hook: jq not found, skipping enforcement"}'
  exit 0
fi

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  allow_and_exit
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
if [ -z "$TOOL_NAME" ]; then
  allow_and_exit
fi

case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    ;;
  *)
    allow_and_exit
    ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -z "$FILE_PATH" ]; then
  allow_and_exit
fi

if [[ "$FILE_PATH" != /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi

FILE_PATH=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && echo "$(pwd)/$(basename "$FILE_PATH")") || FILE_PATH=""
if [ -z "$FILE_PATH" ]; then
  allow_and_exit
fi

CONTEXT_FILE=".syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  allow_and_exit
fi

ASSIGNMENT_DIR=$(jq -r '.assignmentDir // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_DIR=$(jq -r '.missionDir // empty' "$CONTEXT_FILE" 2>/dev/null)
WORKSPACE_ROOT=$(jq -r '.workspaceRoot // empty' "$CONTEXT_FILE" 2>/dev/null)

if [ -z "$ASSIGNMENT_DIR" ] || [ -z "$MISSION_DIR" ]; then
  allow_and_exit
fi

ASSIGNMENT_DIR="${ASSIGNMENT_DIR/#\~/$HOME}"
MISSION_DIR="${MISSION_DIR/#\~/$HOME}"
if [ -n "$WORKSPACE_ROOT" ] && [ "$WORKSPACE_ROOT" != "null" ]; then
  WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"
else
  WORKSPACE_ROOT=""
fi

if [[ "$FILE_PATH" == "$ASSIGNMENT_DIR"/* ]]; then
  allow_and_exit
fi

if [[ "$FILE_PATH" == "$MISSION_DIR/resources/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != _* ]]; then
    allow_and_exit
  fi
fi

if [[ "$FILE_PATH" == "$MISSION_DIR/memories/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != _* ]]; then
    allow_and_exit
  fi
fi

CONTEXT_ABS="$(cd "$(dirname "$CONTEXT_FILE")" 2>/dev/null && echo "$(pwd)/$(basename "$CONTEXT_FILE")")"
if [ "$FILE_PATH" = "$CONTEXT_ABS" ]; then
  allow_and_exit
fi

if [ -n "$WORKSPACE_ROOT" ] && [[ "$FILE_PATH" == "$WORKSPACE_ROOT"/* ]]; then
  allow_and_exit
fi

REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. Allowed paths: assignment dir ($ASSIGNMENT_DIR), mission resources/memories, workspace ($WORKSPACE_ROOT)."
REASON_ESCAPED=$(echo "$REASON" | jq -Rs '.' 2>/dev/null)
if [ -z "$REASON_ESCAPED" ]; then
  REASON_ESCAPED="\"Syntaur write boundary violation\""
fi

echo "{\"decision\":\"block\",\"reason\":${REASON_ESCAPED}}"
exit 0

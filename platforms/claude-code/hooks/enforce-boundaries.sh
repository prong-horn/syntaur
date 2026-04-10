#!/usr/bin/env bash
# Syntaur Write Boundary Enforcement Hook
# PreToolUse hook that validates Edit/Write/MultiEdit targets against assignment boundaries.
# Reads JSON from stdin, outputs JSON to stdout. Always exits 0.

# --- Safety: never fail due to hook errors ---
allow_and_exit() {
  echo '{}'
  exit 0
}

# --- Step 1: Check for jq ---
if ! command -v jq &>/dev/null; then
  # Cannot parse JSON without jq; allow all operations
  echo '{"systemMessage": "Syntaur boundary hook: jq not found, skipping enforcement"}'
  exit 0
fi

# --- Step 2: Read stdin ---
INPUT=$(cat)
if [ -z "$INPUT" ]; then
  allow_and_exit
fi

# --- Step 3: Extract tool name ---
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
if [ -z "$TOOL_NAME" ]; then
  allow_and_exit
fi

# --- Step 4: Only check file-writing tools ---
case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    ;;
  *)
    allow_and_exit
    ;;
esac

# --- Step 5: Extract file path from tool input ---
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -z "$FILE_PATH" ]; then
  # Cannot determine file path; allow (defensive)
  allow_and_exit
fi

# --- Step 6: Resolve to absolute path ---
# If path is relative, make it absolute relative to cwd
if [[ "$FILE_PATH" != /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi
# Normalize path (resolve .. and . components)
FILE_PATH=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && echo "$(pwd)/$(basename "$FILE_PATH")") || FILE_PATH=""
if [ -z "$FILE_PATH" ]; then
  allow_and_exit
fi

# --- Step 7: Check for context file ---
CONTEXT_FILE=".syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  # No active assignment; allow all writes
  allow_and_exit
fi

# --- Step 8: Read context ---
ASSIGNMENT_DIR=$(jq -r '.assignmentDir // empty' "$CONTEXT_FILE" 2>/dev/null)
MISSION_DIR=$(jq -r '.missionDir // empty' "$CONTEXT_FILE" 2>/dev/null)
WORKSPACE_ROOT=$(jq -r '.workspaceRoot // empty' "$CONTEXT_FILE" 2>/dev/null)

if [ -z "$ASSIGNMENT_DIR" ] || [ -z "$MISSION_DIR" ]; then
  # Malformed context file; allow (defensive)
  allow_and_exit
fi

# --- Step 9: Expand ~ in paths ---
ASSIGNMENT_DIR="${ASSIGNMENT_DIR/#\~/$HOME}"
MISSION_DIR="${MISSION_DIR/#\~/$HOME}"
if [ -n "$WORKSPACE_ROOT" ] && [ "$WORKSPACE_ROOT" != "null" ]; then
  WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"
else
  WORKSPACE_ROOT=""
fi

# --- Step 10: Check allowed paths ---

# Allow: files inside the assignment directory
if [[ "$FILE_PATH" == "$ASSIGNMENT_DIR"/* ]]; then
  allow_and_exit
fi

# Allow: files in mission resources/ directory (but NOT derived _index.md)
if [[ "$FILE_PATH" == "$MISSION_DIR/resources/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" == _* ]]; then
    # Derived file (e.g., _index.md) -- fall through to block
    :
  else
    allow_and_exit
  fi
fi

# Allow: files in mission memories/ directory (but NOT derived _index.md)
if [[ "$FILE_PATH" == "$MISSION_DIR/memories/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" == _* ]]; then
    # Derived file (e.g., _index.md) -- fall through to block
    :
  else
    allow_and_exit
  fi
fi

# Allow: the context file itself
CONTEXT_ABS="$(cd "$(dirname "$CONTEXT_FILE")" 2>/dev/null && echo "$(pwd)/$(basename "$CONTEXT_FILE")")"
if [ "$FILE_PATH" = "$CONTEXT_ABS" ]; then
  allow_and_exit
fi

# Allow: files inside workspace root (if set)
if [ -n "$WORKSPACE_ROOT" ] && [[ "$FILE_PATH" == "$WORKSPACE_ROOT"/* ]]; then
  allow_and_exit
fi

# --- Step 11: Block the write ---
REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. Allowed paths: assignment dir ($ASSIGNMENT_DIR), mission resources/memories, workspace ($WORKSPACE_ROOT)."

# Escape for JSON
REASON_ESCAPED=$(echo "$REASON" | jq -Rs '.' 2>/dev/null)
if [ -z "$REASON_ESCAPED" ]; then
  REASON_ESCAPED="\"Syntaur write boundary violation\""
fi

echo "{\"decision\": \"block\", \"reason\": ${REASON_ESCAPED}}"

exit 0

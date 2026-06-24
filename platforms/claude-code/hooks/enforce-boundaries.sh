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
# context.json is a WORKSPACE MARKER. Its mere presence means "this workspace is
# under Syntaur enforcement"; its absence means "not a Syntaur workspace → allow".
CONTEXT_FILE=".syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  # No Syntaur workspace; allow all writes (unchanged behavior).
  allow_and_exit
fi

# --- Step 8: Resolve the write boundary from the session's OPEN engagement ---
# The assignment scalars were demoted out of context.json — the active assignment
# now lives on the session's engagement. Ask the CLI to resolve it. Parse the
# PreToolUse stdin payload for the calling session id and pass it explicitly so
# co-tenant clobbering can't misattribute. If the CLI is unavailable or resolves
# nothing, ASSIGNMENT_DIR/MISSION_DIR stay empty → we enforce WORKSPACE-ONLY
# below (we do NOT fail open).
ASSIGNMENT_DIR=""
MISSION_DIR=""
WORKSPACE_ROOT=""

# The cwd holding this context file (its parent's parent: ".syntaur/context.json").
CONTEXT_DIR="$(cd "$(dirname "$CONTEXT_FILE")/.." 2>/dev/null && pwd)"
[ -z "$CONTEXT_DIR" ] && CONTEXT_DIR="$(pwd)"

SID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

if command -v syntaur >/dev/null 2>&1; then
  BOUNDARY_JSON=$(cd "$CONTEXT_DIR" 2>/dev/null && \
    syntaur session boundary --json ${SID:+--session-id "$SID"} 2>/dev/null)
  if [ -n "$BOUNDARY_JSON" ]; then
    ASSIGNMENT_DIR=$(echo "$BOUNDARY_JSON" | jq -r '.assignmentDir // empty' 2>/dev/null)
    MISSION_DIR=$(echo "$BOUNDARY_JSON" | jq -r '.projectDir // empty' 2>/dev/null)
    WORKSPACE_ROOT=$(echo "$BOUNDARY_JSON" | jq -r '.workspaceRoot // empty' 2>/dev/null)
  fi
fi

# Fall back to the context.json workspace marker if the CLI did not surface one
# (e.g. standalone session with a worktree but no engagement yet).
if [ -z "$WORKSPACE_ROOT" ]; then
  WORKSPACE_ROOT=$(jq -r '.workspaceRoot // empty' "$CONTEXT_FILE" 2>/dev/null)
fi

# --- Step 9: Expand ~ in paths (guarding empties) ---
[ -n "$ASSIGNMENT_DIR" ] && ASSIGNMENT_DIR="${ASSIGNMENT_DIR/#\~/$HOME}"
[ -n "$MISSION_DIR" ] && MISSION_DIR="${MISSION_DIR/#\~/$HOME}"
if [ -n "$WORKSPACE_ROOT" ] && [ "$WORKSPACE_ROOT" != "null" ]; then
  WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"
else
  WORKSPACE_ROOT=""
fi

# --- Step 10: Check allowed paths ---
# NOTE: every prefix test is guarded by a non-empty check so an EMPTY $DIR never
# globs to "/*" and silently allows the whole filesystem. When no assignment
# resolves, only the workspace-root (and context file) checks can match → this is
# WORKSPACE-ONLY enforcement, NOT fail-open.

# Allow: files inside the assignment directory
if [ -n "$ASSIGNMENT_DIR" ] && [[ "$FILE_PATH" == "$ASSIGNMENT_DIR"/* ]]; then
  allow_and_exit
fi

# Allow: files in project resources/ directory (but NOT derived _index.md)
if [ -n "$MISSION_DIR" ] && [[ "$FILE_PATH" == "$MISSION_DIR/resources/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" == _* ]]; then
    # Derived file (e.g., _index.md) -- fall through to block
    :
  else
    allow_and_exit
  fi
fi

# Allow: files in project memories/ directory (but NOT derived _index.md)
if [ -n "$MISSION_DIR" ] && [[ "$FILE_PATH" == "$MISSION_DIR/memories/"* ]]; then
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
if [ -n "$CONTEXT_ABS" ] && [ "$FILE_PATH" = "$CONTEXT_ABS" ]; then
  allow_and_exit
fi

# Allow: files inside workspace root (if set)
if [ -n "$WORKSPACE_ROOT" ] && [[ "$FILE_PATH" == "$WORKSPACE_ROOT"/* ]]; then
  allow_and_exit
fi

# --- Step 11: Block the write ---
if [ -n "$ASSIGNMENT_DIR" ]; then
  REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. Allowed paths: assignment dir ($ASSIGNMENT_DIR), project resources/memories${MISSION_DIR:+ ($MISSION_DIR)}, workspace (${WORKSPACE_ROOT:-none})."
else
  REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. No active assignment for this session — writes are restricted to the workspace (${WORKSPACE_ROOT:-none}). Run /grab-assignment to bind an assignment and widen the boundary."
fi

# Escape for JSON
REASON_ESCAPED=$(echo "$REASON" | jq -Rs '.' 2>/dev/null)
if [ -z "$REASON_ESCAPED" ]; then
  REASON_ESCAPED="\"Syntaur write boundary violation\""
fi

echo "{\"decision\": \"block\", \"reason\": ${REASON_ESCAPED}}"

exit 0

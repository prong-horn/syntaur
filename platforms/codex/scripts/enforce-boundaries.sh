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

# context.json is a WORKSPACE MARKER. Its presence means "Syntaur-enforced
# workspace"; its absence means "not a Syntaur workspace → allow".
CONTEXT_FILE=".syntaur/context.json"
if [ ! -f "$CONTEXT_FILE" ]; then
  allow_and_exit
fi

# Resolve the write boundary from the session's OPEN engagement (the assignment
# scalars were demoted out of context.json). Codex's PreToolUse stdin MAY carry
# .session_id; if absent, fall back to the ancestor-pid runtime markers (same
# scheme as session-cleanup.sh). Pass whatever id we have to the CLI explicitly.
# If the CLI is unavailable or resolves nothing, ASSIGNMENT_DIR/MISSION_DIR stay
# empty → WORKSPACE-ONLY enforcement below (NOT fail-open).
ASSIGNMENT_DIR=""
MISSION_DIR=""
WORKSPACE_ROOT=""

CONTEXT_DIR="$(cd "$(dirname "$CONTEXT_FILE")/.." 2>/dev/null && pwd)"
[ -z "$CONTEXT_DIR" ] && CONTEXT_DIR="$(pwd)"

SID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$SID" ]; then
  # Fall back to ancestor-pid runtime markers (pid-reuse-guarded by procStart).
  RUNTIME_DIR="${SYNTAUR_RUNTIME_SESSIONS_DIR:-$HOME/.syntaur/runtime/sessions}"
  _pid="$PPID"
  _depth=0
  while [ "$_depth" -lt 12 ]; do
    case "$_pid" in
      '' | *[!0-9]*) break ;;
    esac
    [ "$_pid" -le 1 ] && break
    _marker="$RUNTIME_DIR/$_pid.json"
    if [ -f "$_marker" ]; then
      _sid=$(jq -r '.sessionId // empty' "$_marker" 2>/dev/null)
      _procstart=$(jq -r '.procStart // empty' "$_marker" 2>/dev/null)
      if [ -n "$_sid" ]; then
        if [ -n "$_procstart" ]; then
          _actual=$(ps -o lstart= -p "$_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')
          if [ -n "$_actual" ] && [ "$_actual" = "$_procstart" ]; then
            SID="$_sid"
            break
          fi
        else
          SID="$_sid"
          break
        fi
      fi
    fi
    _pid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
    _depth=$((_depth + 1))
  done
fi

if command -v syntaur >/dev/null 2>&1; then
  BOUNDARY_JSON=$(cd "$CONTEXT_DIR" 2>/dev/null && \
    syntaur session boundary --json ${SID:+--session-id "$SID"} 2>/dev/null)
  if [ -n "$BOUNDARY_JSON" ]; then
    ASSIGNMENT_DIR=$(echo "$BOUNDARY_JSON" | jq -r '.assignmentDir // empty' 2>/dev/null)
    MISSION_DIR=$(echo "$BOUNDARY_JSON" | jq -r '.projectDir // empty' 2>/dev/null)
    WORKSPACE_ROOT=$(echo "$BOUNDARY_JSON" | jq -r '.workspaceRoot // empty' 2>/dev/null)
  fi
fi

# Fall back to the context.json workspace marker if the CLI did not surface one.
if [ -z "$WORKSPACE_ROOT" ]; then
  WORKSPACE_ROOT=$(jq -r '.workspaceRoot // empty' "$CONTEXT_FILE" 2>/dev/null)
fi

[ -n "$ASSIGNMENT_DIR" ] && ASSIGNMENT_DIR="${ASSIGNMENT_DIR/#\~/$HOME}"
[ -n "$MISSION_DIR" ] && MISSION_DIR="${MISSION_DIR/#\~/$HOME}"
if [ -n "$WORKSPACE_ROOT" ] && [ "$WORKSPACE_ROOT" != "null" ]; then
  WORKSPACE_ROOT="${WORKSPACE_ROOT/#\~/$HOME}"
else
  WORKSPACE_ROOT=""
fi

# Every prefix test is guarded so an EMPTY $DIR never globs to "/*" and allows
# the whole filesystem. No assignment → only workspace-root/context match →
# WORKSPACE-ONLY enforcement (NOT fail-open).
if [ -n "$ASSIGNMENT_DIR" ] && [[ "$FILE_PATH" == "$ASSIGNMENT_DIR"/* ]]; then
  allow_and_exit
fi

if [ -n "$MISSION_DIR" ] && [[ "$FILE_PATH" == "$MISSION_DIR/resources/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != _* ]]; then
    allow_and_exit
  fi
fi

if [ -n "$MISSION_DIR" ] && [[ "$FILE_PATH" == "$MISSION_DIR/memories/"* ]]; then
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != _* ]]; then
    allow_and_exit
  fi
fi

CONTEXT_ABS="$(cd "$(dirname "$CONTEXT_FILE")" 2>/dev/null && echo "$(pwd)/$(basename "$CONTEXT_FILE")")"
if [ -n "$CONTEXT_ABS" ] && [ "$FILE_PATH" = "$CONTEXT_ABS" ]; then
  allow_and_exit
fi

if [ -n "$WORKSPACE_ROOT" ] && [[ "$FILE_PATH" == "$WORKSPACE_ROOT"/* ]]; then
  allow_and_exit
fi

if [ -n "$ASSIGNMENT_DIR" ]; then
  REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. Allowed paths: assignment dir ($ASSIGNMENT_DIR), project resources/memories${MISSION_DIR:+ ($MISSION_DIR)}, workspace (${WORKSPACE_ROOT:-none})."
else
  REASON="Syntaur write boundary violation: Cannot write to '$FILE_PATH'. No active assignment for this session — writes are restricted to the workspace (${WORKSPACE_ROOT:-none})."
fi
REASON_ESCAPED=$(echo "$REASON" | jq -Rs '.' 2>/dev/null)
if [ -z "$REASON_ESCAPED" ]; then
  REASON_ESCAPED="\"Syntaur write boundary violation\""
fi

echo "{\"decision\":\"block\",\"reason\":${REASON_ESCAPED}}"
exit 0

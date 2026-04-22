#!/usr/bin/env bash
# Syntaur Claude Code statusLine.
#
# Renders a single line with:
#   <branch> · <worktree-basename> · <assignment> · <sessionId-suffix>
#
# Reads JSON from stdin per Claude Code statusLine contract:
#   { "session_id": "...", "cwd": "...", "workspace": { "current_dir": "..." }, ... }
#
# Empty segments are omitted. Never fails the terminal — always exits 0.

set -o pipefail 2>/dev/null || true

INPUT=$(cat)

# Degrade cleanly if jq is unavailable.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s' '(syntaur: jq missing)'
  exit 0
fi

SESSION_ID=""
CWD=""

if [ -n "$INPUT" ]; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  CWD=$(printf '%s' "$INPUT" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
fi

# Fall back to the shell's CWD if the payload omits it.
[ -z "$CWD" ] && CWD="$PWD"

# --- Segment 1: branch ---
BRANCH=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$BRANCH" = "HEAD" ] || [ -z "$BRANCH" ]; then
    SHORT=$(git -C "$CWD" rev-parse --short HEAD 2>/dev/null)
    if [ -n "$SHORT" ]; then
      BRANCH="detached@$SHORT"
    else
      BRANCH=""
    fi
  fi
fi

# --- Segment 2: worktree basename ---
WORKTREE=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  WT_PATH=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$WT_PATH" ]; then
    WORKTREE=$(basename "$WT_PATH")
  fi
fi

# --- Segment 3: active syntaur assignment ---
ASSIGNMENT=""
CONTEXT_FILE="$CWD/.syntaur/context.json"
if [ -f "$CONTEXT_FILE" ]; then
  PROJECT_SLUG=$(jq -r '.projectSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
  ASSIGNMENT_SLUG=$(jq -r '.assignmentSlug // empty' "$CONTEXT_FILE" 2>/dev/null)
  ASSIGNMENT_DIR=$(jq -r '.assignmentDir // empty' "$CONTEXT_FILE" 2>/dev/null)

  TITLE=""
  if [ -n "$ASSIGNMENT_DIR" ] && [ -f "$ASSIGNMENT_DIR/assignment.md" ]; then
    TITLE=$(awk '/^title:/{sub(/^title:[[:space:]]*"?/,""); sub(/"?[[:space:]]*$/,""); print; exit}' "$ASSIGNMENT_DIR/assignment.md" 2>/dev/null)
  fi

  LABEL=""
  if [ -n "$PROJECT_SLUG" ] && [ -n "$ASSIGNMENT_SLUG" ]; then
    LABEL="$PROJECT_SLUG/$ASSIGNMENT_SLUG"
  elif [ -n "$ASSIGNMENT_SLUG" ]; then
    # Standalone assignment — assignmentSlug is the UUID folder name. Take the
    # first 8 chars for terseness.
    UUID_PREFIX="${ASSIGNMENT_SLUG:0:8}"
    LABEL="standalone/$UUID_PREFIX"
  fi

  if [ -n "$LABEL" ] && [ -n "$TITLE" ]; then
    ASSIGNMENT="$LABEL — $TITLE"
  elif [ -n "$LABEL" ]; then
    ASSIGNMENT="$LABEL"
  fi
fi

# --- Segment 4: session id suffix ---
SESSION_SUFFIX=""
if [ -n "$SESSION_ID" ]; then
  LEN=${#SESSION_ID}
  if [ "$LEN" -gt 8 ]; then
    SESSION_SUFFIX="…${SESSION_ID: -8}"
  else
    SESSION_SUFFIX="$SESSION_ID"
  fi
fi

# --- Join segments with ' · ', suppressing empties. ---
OUT=""
for seg in "$BRANCH" "$WORKTREE" "$ASSIGNMENT" "$SESSION_SUFFIX"; do
  if [ -n "$seg" ]; then
    if [ -z "$OUT" ]; then
      OUT="$seg"
    else
      OUT="$OUT · $seg"
    fi
  fi
done

printf '%s' "$OUT"
exit 0

#!/usr/bin/env bash
# Syntaur statusline for Claude Code.
#
# Reads JSON from stdin per Claude Code's statusLine contract and prints a
# single line containing:
#   [optional: output from a wrapped user script]
#   <git repo:branch>
#   <active syntaur assignment>
#   <sessionId suffix>
#
# Wrapping: if SYNTAUR_STATUSLINE_WRAP names an executable, or the first
# non-empty line of $HOME/.syntaur/statusline.conf is a path to an executable,
# that script is invoked first with the same stdin; its stdout becomes the
# leading segment. This lets users who already had a custom statusline keep
# it while composing syntaur's extra info on the right.
#
# Never fails the terminal — always exits 0.

set -o pipefail 2>/dev/null || true

INPUT=$(cat)

# Degrade cleanly if jq is unavailable. Emit just the marker so users notice.
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

[ -z "$CWD" ] && CWD="$PWD"

# --- Optional wrap: compose with an existing user script ---
WRAP_PATH="${SYNTAUR_STATUSLINE_WRAP:-}"
if [ -z "$WRAP_PATH" ] && [ -f "$HOME/.syntaur/statusline.conf" ]; then
  # First non-empty, non-comment line is the wrap path.
  WRAP_PATH=$(awk 'NF && !/^#/{print; exit}' "$HOME/.syntaur/statusline.conf" 2>/dev/null)
fi
WRAPPED_OUT=""
if [ -n "$WRAP_PATH" ] && [ -r "$WRAP_PATH" ]; then
  # Run the wrapped script with the same stdin and a 2-second timeout (best-effort).
  if command -v timeout >/dev/null 2>&1; then
    WRAPPED_OUT=$(printf '%s' "$INPUT" | timeout 2 bash "$WRAP_PATH" 2>/dev/null)
  else
    WRAPPED_OUT=$(printf '%s' "$INPUT" | bash "$WRAP_PATH" 2>/dev/null)
  fi
  # Collapse any trailing newlines so the composed line stays single-row.
  WRAPPED_OUT=$(printf '%s' "$WRAPPED_OUT" | tr -d '\r' | awk 'NF{line=$0} END{print line}' 2>/dev/null)
fi

# --- Segment: git repo:branch ---
GIT_SEG=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  GIT_ROOT=$(git --no-optional-locks -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$GIT_ROOT" ]; then
    REPO=$(basename "$GIT_ROOT")
    BRANCH=$(git --no-optional-locks -C "$CWD" symbolic-ref --short HEAD 2>/dev/null)
    if [ -z "$BRANCH" ]; then
      SHORT=$(git --no-optional-locks -C "$CWD" rev-parse --short HEAD 2>/dev/null)
      [ -n "$SHORT" ] && BRANCH="detached@$SHORT"
    fi
    if [ -n "$BRANCH" ]; then
      GIT_SEG="$REPO:$BRANCH"
    else
      GIT_SEG="$REPO"
    fi
  fi
fi

# --- Segment: active syntaur assignment ---
ASSIGNMENT_SEG=""
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
    LABEL="standalone/${ASSIGNMENT_SLUG:0:8}"
  fi

  if [ -n "$LABEL" ] && [ -n "$TITLE" ]; then
    ASSIGNMENT_SEG="$LABEL — $TITLE"
  elif [ -n "$LABEL" ]; then
    ASSIGNMENT_SEG="$LABEL"
  fi
fi

# --- Segment: session id suffix ---
SESSION_SEG=""
if [ -n "$SESSION_ID" ]; then
  LEN=${#SESSION_ID}
  if [ "$LEN" -gt 8 ]; then
    SESSION_SEG="…${SESSION_ID: -8}"
  else
    SESSION_SEG="$SESSION_ID"
  fi
fi

# --- Compose. Wrapped output (if any) leads; syntaur segments trail. ---
SYNTAUR_PARTS=""
for seg in "$GIT_SEG" "$ASSIGNMENT_SEG" "$SESSION_SEG"; do
  if [ -n "$seg" ]; then
    if [ -z "$SYNTAUR_PARTS" ]; then
      SYNTAUR_PARTS="$seg"
    else
      SYNTAUR_PARTS="$SYNTAUR_PARTS · $seg"
    fi
  fi
done

if [ -n "$WRAPPED_OUT" ] && [ -n "$SYNTAUR_PARTS" ]; then
  printf '%s · %s' "$WRAPPED_OUT" "$SYNTAUR_PARTS"
elif [ -n "$WRAPPED_OUT" ]; then
  printf '%s' "$WRAPPED_OUT"
else
  printf '%s' "$SYNTAUR_PARTS"
fi
exit 0

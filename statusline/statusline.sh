#!/usr/bin/env bash
# Syntaur statusline for Claude Code.
#
# Reads JSON from stdin per Claude Code's statusLine contract and renders a
# user-configurable single line composed of the segments listed in
#   $HOME/.syntaur/statusline.config.json
# with shape:
#   { "segments": ["wrap","git","assignment","model","ctx","session"],
#     "separator": " · ",
#     "wrap": "/optional/path/to/inner-statusline.sh" }
#
# Available segments:
#   wrap       stdout of an external script (composes another statusline)
#   git        repo:branch (+ dirty marker + ahead/behind counts)
#   assignment active syntaur assignment (project/slug or standalone/uuid — title)
#   session    Claude session id, last 8 chars prefixed by "…"
#   model      Claude model display name
#   ctx        context window fill bar, e.g. "ctx:[####------] 42%"
#   cwd        basename of the current working directory
#
# If the config file is absent, falls back to a sensible default set.
# Never fails the terminal — always exits 0.

set -o pipefail 2>/dev/null || true

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  printf '%s' '(syntaur: jq missing)'
  exit 0
fi

CONFIG_FILE="$HOME/.syntaur/statusline.config.json"
# Fall back to a simple one-line conf file for backward compat with earlier
# install-statusline versions that only stored a wrap target.
LEGACY_CONF="$HOME/.syntaur/statusline.conf"

# --- Load config ---
SEGMENTS_RAW=""
SEPARATOR=" · "
WRAP_PATH=""

if [ -f "$CONFIG_FILE" ]; then
  SEGMENTS_RAW=$(jq -r '(.segments // []) | join(",")' "$CONFIG_FILE" 2>/dev/null)
  SEP_FROM_CONF=$(jq -r '.separator // empty' "$CONFIG_FILE" 2>/dev/null)
  [ -n "$SEP_FROM_CONF" ] && SEPARATOR="$SEP_FROM_CONF"
  WRAP_PATH=$(jq -r '.wrap // empty' "$CONFIG_FILE" 2>/dev/null)
fi

# Env var always takes precedence for wrap (useful for testing).
[ -n "$SYNTAUR_STATUSLINE_WRAP" ] && WRAP_PATH="$SYNTAUR_STATUSLINE_WRAP"

# Legacy conf: first non-empty, non-comment line is wrap path.
if [ -z "$WRAP_PATH" ] && [ -f "$LEGACY_CONF" ]; then
  WRAP_PATH=$(awk 'NF && !/^#/{print; exit}' "$LEGACY_CONF" 2>/dev/null)
fi

# Default segment set if none configured.
if [ -z "$SEGMENTS_RAW" ]; then
  # Default: include wrap as leading segment only if a wrap path is set.
  if [ -n "$WRAP_PATH" ]; then
    SEGMENTS_RAW="wrap,git,assignment,session"
  else
    SEGMENTS_RAW="git,assignment,session"
  fi
fi

# --- Extract stdin fields ---
SESSION_ID=""
CWD=""
MODEL=""
USED_PCT=""

if [ -n "$INPUT" ]; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  CWD=$(printf '%s' "$INPUT" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
  MODEL=$(printf '%s' "$INPUT" | jq -r '.model.display_name // empty' 2>/dev/null)
  USED_PCT=$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
fi

[ -z "$CWD" ] && CWD="$PWD"

# --- Compute each available segment value (cheap, unconditional). ---

# wrap
WRAP_SEG=""
if [ -n "$WRAP_PATH" ] && [ -r "$WRAP_PATH" ]; then
  if command -v timeout >/dev/null 2>&1; then
    WRAP_SEG=$(printf '%s' "$INPUT" | timeout 2 bash "$WRAP_PATH" 2>/dev/null)
  else
    WRAP_SEG=$(printf '%s' "$INPUT" | bash "$WRAP_PATH" 2>/dev/null)
  fi
  # Take last non-empty line (collapse to single row).
  WRAP_SEG=$(printf '%s' "$WRAP_SEG" | tr -d '\r' | awk 'NF{line=$0} END{print line}' 2>/dev/null)
fi

# git — repo:branch[*] +ahead -behind
GIT_SEG=""
if [ -d "$CWD" ]; then
  GIT_ROOT=$(git --no-optional-locks -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$GIT_ROOT" ]; then
    REPO=$(basename "$GIT_ROOT")
    BRANCH=$(git --no-optional-locks -C "$CWD" symbolic-ref --short HEAD 2>/dev/null)
    if [ -z "$BRANCH" ]; then
      SHORT=$(git --no-optional-locks -C "$CWD" rev-parse --short HEAD 2>/dev/null)
      [ -n "$SHORT" ] && BRANCH="detached@$SHORT"
    fi

    DIRTY=""
    if ! git --no-optional-locks -C "$CWD" diff --quiet 2>/dev/null \
       || ! git --no-optional-locks -C "$CWD" diff --cached --quiet 2>/dev/null; then
      DIRTY="*"
    fi

    AHEAD_BEHIND=""
    UPSTREAM=$(git --no-optional-locks -C "$CWD" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)
    if [ -n "$UPSTREAM" ]; then
      AHEAD=$(git --no-optional-locks -C "$CWD" rev-list --count "$UPSTREAM..HEAD" 2>/dev/null)
      BEHIND=$(git --no-optional-locks -C "$CWD" rev-list --count "HEAD..$UPSTREAM" 2>/dev/null)
      [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null  && AHEAD_BEHIND=" +${AHEAD}"
      [ "${BEHIND:-0}" -gt 0 ] 2>/dev/null && AHEAD_BEHIND="${AHEAD_BEHIND} -${BEHIND}"
    fi

    if [ -n "$BRANCH" ]; then
      GIT_SEG="${REPO}:${BRANCH}${DIRTY}${AHEAD_BEHIND}"
    else
      GIT_SEG="$REPO"
    fi
  fi
fi

# assignment — project/slug — title  (or standalone/uuid-prefix — title)
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

# session — last 8 chars
SESSION_SEG=""
if [ -n "$SESSION_ID" ]; then
  LEN=${#SESSION_ID}
  if [ "$LEN" -gt 8 ]; then
    SESSION_SEG="…${SESSION_ID: -8}"
  else
    SESSION_SEG="$SESSION_ID"
  fi
fi

# model
MODEL_SEG=""
[ -n "$MODEL" ] && MODEL_SEG="$MODEL"

# ctx — fill bar
CTX_SEG=""
if [ -n "$USED_PCT" ]; then
  USED_INT=$(printf "%.0f" "$USED_PCT" 2>/dev/null || echo "$USED_PCT")
  if [ -n "$USED_INT" ] && [ "$USED_INT" -ge 0 ] 2>/dev/null; then
    FILLED=$(( USED_INT / 10 ))
    [ "$FILLED" -gt 10 ] && FILLED=10
    EMPTY=$(( 10 - FILLED ))
    BAR=""
    i=0
    while [ "$i" -lt "$FILLED" ]; do BAR="${BAR}#"; i=$((i+1)); done
    i=0
    while [ "$i" -lt "$EMPTY" ];  do BAR="${BAR}-"; i=$((i+1)); done
    CTX_SEG="ctx:[${BAR}] ${USED_INT}%"
  fi
fi

# cwd — basename
CWD_SEG=""
[ -n "$CWD" ] && CWD_SEG=$(basename "$CWD")

# --- Emit the selected segments in order ---
OUT=""
# Split SEGMENTS_RAW on commas using IFS.
OLD_IFS="$IFS"
IFS=','
for name in $SEGMENTS_RAW; do
  IFS="$OLD_IFS"
  # Trim whitespace
  name=$(printf '%s' "$name" | awk '{$1=$1; print}')
  value=""
  case "$name" in
    wrap)       value="$WRAP_SEG" ;;
    git)        value="$GIT_SEG" ;;
    assignment) value="$ASSIGNMENT_SEG" ;;
    session)    value="$SESSION_SEG" ;;
    model)      value="$MODEL_SEG" ;;
    ctx)        value="$CTX_SEG" ;;
    cwd)        value="$CWD_SEG" ;;
    *)          value="" ;;
  esac
  if [ -n "$value" ]; then
    if [ -z "$OUT" ]; then
      OUT="$value"
    else
      OUT="${OUT}${SEPARATOR}${value}"
    fi
  fi
  IFS=','
done
IFS="$OLD_IFS"

printf '%s' "$OUT"
exit 0

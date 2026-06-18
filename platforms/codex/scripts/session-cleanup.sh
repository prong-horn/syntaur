#!/usr/bin/env bash
# Syntaur SessionEnd hook for Codex plugins.
# Marks the ENDING agent session as stopped when a Codex session exits.
#
# Identity rule: resolve the ending session's id EXACTLY, from a capture-at-birth
# runtime marker stamped by a session-start/boundary hook (keyed by the Codex
# process pid). We deliberately do NOT read .sessionId from context.json — that
# shared scalar is clobbered when two sessions share a workspace, so trusting it
# would mark the WRONG session stopped. Codex has no SessionStart hook and its
# SessionEnd stdin carries no id, so when no exact marker resolves we SKIP the
# PATCH and let the dashboard liveness reaper mark the dead session stopped.

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

# Keep derived status fresh on session end — CLI-direct (NO dashboard
# dependency, unlike the session-stop PATCH below), migration-gated, and bounded
# (~3s; no `timeout` on stock macOS). Best-effort; never blocks teardown.
if command -v syntaur >/dev/null 2>&1; then
  ( cd "$CWD" 2>/dev/null && syntaur recompute --if-migrated >/dev/null 2>&1 ) &
  syntaur_rc_pid=$!
  ( sleep 3; kill -KILL "$syntaur_rc_pid" 2>/dev/null ) >/dev/null 2>&1 &
  syntaur_rc_killer=$!
  wait "$syntaur_rc_pid" 2>/dev/null || true
  kill -KILL "$syntaur_rc_killer" 2>/dev/null
  wait "$syntaur_rc_killer" 2>/dev/null || true
fi

RUNTIME_DIR="${SYNTAUR_RUNTIME_SESSIONS_DIR:-$HOME/.syntaur/runtime/sessions}"

# Walk the ancestor-pid chain reading runtime markers. Returns the nearest
# marker's sessionId on stdout (and success), pid-reuse-guarded by procStart.
resolve_session_from_markers() {
  local pid="$PPID"
  local depth=0
  while [ "$depth" -lt 12 ]; do
    case "$pid" in
      '' | *[!0-9]*) break ;;
    esac
    [ "$pid" -le 1 ] && break
    local marker="$RUNTIME_DIR/$pid.json"
    if [ -f "$marker" ]; then
      local sid procstart actual
      sid=$(jq -r '.sessionId // empty' "$marker" 2>/dev/null)
      procstart=$(jq -r '.procStart // empty' "$marker" 2>/dev/null)
      if [ -n "$sid" ]; then
        if [ -n "$procstart" ]; then
          # Fail CLOSED: require a readable, exactly-matching live start time;
          # if ps can't prove the pid wasn't recycled, skip this marker.
          actual=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')
          if [ -n "$actual" ] && [ "$actual" = "$procstart" ]; then
            printf '%s' "$sid"
            return 0
          fi
          # else: cannot prove pid identity — skip this marker, keep walking
        else
          printf '%s' "$sid"
          return 0
        fi
      fi
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    depth=$((depth + 1))
  done
  return 1
}

SESSION_ID=$(resolve_session_from_markers || true)
MISSION_SLUG=$(jq -r '.projectSlug // empty' "$CONTEXT_FILE" 2>/dev/null)

# No EXACT id — do not risk stopping the wrong co-tenant session.
[ -z "$SESSION_ID" ] && exit 0

# Defensive: the id becomes a URL path segment — reject anything that isn't a
# plain id (UUID/ULID charset). Real ids never trip this.
case "$SESSION_ID" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac

PORT=$(cat "$HOME/.syntaur/dashboard-port" 2>/dev/null || echo "4800")
if [ -n "$MISSION_SLUG" ]; then
  BODY="{\"status\": \"stopped\", \"projectSlug\": \"${MISSION_SLUG}\"}"
else
  BODY="{\"status\": \"stopped\"}"
fi
curl -sf -X PATCH "http://localhost:${PORT}/api/agent-sessions/${SESSION_ID}/status" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -o /dev/null 2>/dev/null || true

exit 0

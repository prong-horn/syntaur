#!/usr/bin/env bash
# Syntaur SessionStart Hook — thin wrapper around `syntaur session register`.
#
# Registers EVERY session (standalone sessions included — no context.json
# required). The CLI does the deterministic work: parses the stdin payload,
# merges session fields into an EXISTING .syntaur/context.json (never creates
# one), and writes the session row directly to the sessions DB. No dashboard
# required.
#
# Reads JSON from stdin per Claude Code SessionStart contract:
#   { "session_id": "...", "transcript_path": "...", "cwd": "...", ... }
#
# Always exits 0.

set -o pipefail 2>/dev/null || true

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Run a syntaur CLI invocation with a PORTABLE SIGKILL watchdog (background +
# kill) so it is bounded even where `timeout`/`gtimeout` are absent (stock
# macOS). $1 = deadline in seconds; remaining args = the syntaur subcommand.
# Stdin is forwarded; stdout is captured to a temp file and printed on success.
# Returns non-zero if the CLI is absent, hangs past the deadline, or fails —
# including a stale installed CLI that predates the subcommand.
syntaur_bounded() {
  command -v syntaur >/dev/null 2>&1 || return 1
  local deadline out cpid kpid rc
  deadline=$1
  shift
  out="${TMPDIR:-/tmp}/syntaur-hook.$$"
  # `<&0` forwards the caller's stdin explicitly — background commands default
  # to stdin-from-/dev/null in non-interactive shells, which would silently
  # drop the piped hook payload.
  syntaur "$@" <&0 >"$out" 2>/dev/null &
  cpid=$!
  # Hard deadline via SIGKILL (uncatchable — a TERM-ignoring or hung CLI cannot
  # block us), guaranteeing the `wait` below returns.
  ( sleep "$deadline"; kill -KILL "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  kpid=$!
  wait "$cpid" 2>/dev/null
  rc=$?
  # Stop the watchdog early on the fast path (and reap it).
  kill -KILL "$kpid" 2>/dev/null
  wait "$kpid" 2>/dev/null
  if [ "$rc" -eq 0 ]; then
    cat "$out" 2>/dev/null
    rm -f "$out"
    return 0
  fi
  rm -f "$out"
  return 1
}

# --- Best-effort, non-blocking: warn when the installed plugin is stale vs the
# running CLI (the CLI updates via npm; the marketplace plugin copy does not).
# Any failure → do nothing. NEVER changes the exit status (always exits 0).
syntaur_plugin_drift_warn() {
  local marker marker_ver cli_ver msg
  marker="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/syntaur}/.syntaur-install.json"
  [ -f "$marker" ] || return 0
  marker_ver=$(jq -r '.packageVersion // empty' "$marker" 2>/dev/null)
  [ -n "$marker_ver" ] || return 0
  cli_ver=$(syntaur_bounded 1 --version | tr -d '[:space:]') || return 0
  [ -n "$cli_ver" ] || return 0
  [ "$marker_ver" = "$cli_ver" ] && return 0
  msg="Syntaur plugin v${marker_ver} differs from the installed CLI v${cli_ver} — run \`syntaur install-plugin --force\` to refresh."
  jq -cn --arg c "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}' 2>/dev/null || true
}
syntaur_plugin_drift_warn || true

# Capture the terminal-session PID that owns this Claude process. Claude
# Code's SessionStart payload does NOT include a parent PID, so we approximate
# by walking up one level from the hook's own PID — the shell that owns claude.
PID="$(ps -o ppid= -p $$ 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$PID" ] && ! printf '%s' "$PID" | grep -q '^[0-9]\+$'; then
  PID=""
fi

# Register EVERY session via the CLI (context.json merge + direct DB write).
# ~4s deadline stays under the hook's `timeout: 5` budget. A stale CLI without
# the subcommand exits non-zero — swallowed; the scanner is the safety net.
if [ -n "$PID" ]; then
  printf '%s' "$INPUT" | syntaur_bounded 4 session register --from-hook --pid "$PID" >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | syntaur_bounded 4 session register --from-hook >/dev/null 2>&1 || true
fi

exit 0

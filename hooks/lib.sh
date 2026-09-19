#!/usr/bin/env bash
# Shared hook helpers for Syntaur Claude Code hooks.

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

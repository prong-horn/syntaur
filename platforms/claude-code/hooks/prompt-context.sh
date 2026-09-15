#!/usr/bin/env bash
# Syntaur UserPromptSubmit prompt-context hook — thin wrapper around
# `syntaur session context --from-hook`.
#
# Pipes the hook JSON payload straight through to the CLI (no jq gate).
# Always exits 0.

set -o pipefail 2>/dev/null || true

syntaur_bounded() {
  command -v syntaur >/dev/null 2>&1 || return 1
  local deadline out cpid kpid rc
  deadline=$1
  shift
  out="${TMPDIR:-/tmp}/syntaur-hook.$$"
  syntaur "$@" <&0 >"$out" 2>/dev/null &
  cpid=$!
  ( sleep "$deadline"; kill -KILL "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  kpid=$!
  wait "$cpid" 2>/dev/null
  rc=$?
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

syntaur_bounded 4 session context --from-hook || true

exit 0

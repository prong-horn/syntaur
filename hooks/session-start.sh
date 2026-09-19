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

. "${BASH_SOURCE[0]%/*}/lib.sh"

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Register EVERY session via the CLI (context.json merge + direct DB write).
# ~4s deadline stays under the hook's `timeout: 5` budget. A stale CLI without
# the subcommand exits non-zero — swallowed; the row simply is not tracked.
#
# The owning terminal PID used to be captured here and passed as `--pid`, for a
# liveness probe that no longer exists: `sessions.pid` was dropped in schema v11
# and liveness is now `status === 'active'` plus the stale sweep (Decision 4).
#
# A chat session the broker spawned at the home tier carries
# SYNTAUR_SKIP_CONTEXT_MERGE=1; the CLI honours it (and never treats
# ~/.syntaur/context.json as a workspace marker), so the session is still
# registered — only the context.json merge is skipped. Nothing to do here.
printf '%s' "$INPUT" | syntaur_bounded 4 session register --from-hook >/dev/null 2>&1 || true

exit 0

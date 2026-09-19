#!/usr/bin/env bash
# Syntaur UserPromptSubmit prompt-context hook — thin wrapper around
# `syntaur session context --from-hook`.
#
# Pipes the hook JSON payload straight through to the CLI (no jq gate).
# Always exits 0.

set -o pipefail 2>/dev/null || true

. "${BASH_SOURCE[0]%/*}/lib.sh"

syntaur_bounded 4 session context --from-hook || true

exit 0

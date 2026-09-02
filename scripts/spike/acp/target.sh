#!/usr/bin/env bash
# Creates (or resets) a disposable target checkout the adapters operate in, so edit
# scenarios never dirty the spike branch. One target per adapter lets both suites run
# at once. Always reset to the source repo's current HEAD (tracked, untracked and
# ignored files alike); prints "<path> <commit>".
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
name="${1:-target}"
target="$here/out/$name"
src="$(git -C "$repo" rev-parse HEAD)"
mkdir -p "$here/out"
if [ ! -d "$target/.git" ]; then
  git clone -q --shared --no-hardlinks "$repo" "$target"
  git -C "$target" checkout -q -b spike/acp-target
fi
git -C "$target" fetch -q "$repo" "$src"
git -C "$target" reset -q --hard "$src"
git -C "$target" clean -qfdx
echo "$target $src"

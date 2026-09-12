#!/usr/bin/env bash
#
# Pull upstream changes while keeping the KFUPM fixes, then rebuild.
#
# The fixes live as commits on the `kfupm-fixes` branch. Rebasing onto
# upstream/main replays them on top of the latest code. If upstream touches the
# same lines, git will pause and ask you to resolve the conflict; edit the
# files, `git add` them, then `git rebase --continue`.
#
set -euo pipefail
cd "$(dirname "$0")"

echo "Fetching upstream..."
git fetch upstream

echo "Rebasing kfupm-fixes onto upstream/main..."
git rebase upstream/main

echo "Installing dependencies..."
npm install --no-fund --no-audit

echo "Building..."
npm run build

echo
echo "Done. Restart your AI client to load the rebuilt server."

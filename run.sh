#!/bin/bash
# Launch the Blackboard MCP server over stdio.
#
# Bakes in the state directory and an absolute node path, so launchers that do
# not inherit your shell PATH (GUI apps, agents) still work.
set -euo pipefail

export BLACKBOARD_MCP_HOME="${BLACKBOARD_MCP_HOME:-/home/jack/.blackboard-mcp}"

NODE_BIN="${BLACKBOARD_MCP_NODE:-/home/jack/.nvm/versions/node/v24.14.0/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE_BIN" "$HERE/dist/cli.js" "$@"

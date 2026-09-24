#!/usr/bin/env bash
# Shared build verification — single source of truth for what "the build
# passes" means. Invoked by:
#   - a deploy job on the production server (over SSH)
#   - local `npm run ci-build` from web/
#   - .git/hooks/pre-push (if you wire one up)
#
# Cannot drift between local and CI because there's only ONE copy.
#
# Optional env knobs (caller sets only when memory-constrained, e.g. a small VM):
#   WEB_INSTALL_NODE_OPTIONS  — passed to web/  `npm ci`
#   WEB_BUILD_NODE_OPTIONS    — passed to web/  `npm run build`
#   MCP_INSTALL_NODE_OPTIONS  — passed to mcp-server/ `npm install`

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/web"
echo "→ web: npm ci"
NODE_OPTIONS="${WEB_INSTALL_NODE_OPTIONS:-}" npm ci --silent 2>&1 | tail -3

echo "→ web: next build"
NODE_OPTIONS="${WEB_BUILD_NODE_OPTIONS:-}" npm run build 2>&1 | tail -3

if [[ -d "$ROOT/mcp-server" && -f "$ROOT/mcp-server/package.json" ]]; then
  cd "$ROOT/mcp-server"
  echo "→ mcp-server: npm install"
  NODE_OPTIONS="${MCP_INSTALL_NODE_OPTIONS:-}" npm install --silent 2>&1 | tail -3
  echo "→ mcp-server: build"
  npm run build 2>&1 | tail -3
  if [[ ! -f dist/server.js ]]; then
    echo "ERROR: mcp-server/dist/server.js missing after build" >&2
    exit 1
  fi
fi

echo "✓ build verified"

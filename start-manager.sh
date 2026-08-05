#!/bin/bash
#
# HTTP Server Manager — start script.
#
# Self-contained launcher: verifies Node, installs npm dependencies on first run,
# creates the projects folder, then starts the manager. Downloading the repo (git
# clone or "Download ZIP") and running this script is the whole install.
#
# Everything is derived from where this script lives, so the checkout can sit
# anywhere and be owned by any user. Override any of these by exporting them
# before running:
#
#   PORT                 listen port                     (default 3000)
#   CONFIG_FILE          program config                  (default <install>/config.json)
#   PROJECTS_DIR         where programs live             (default <install>/projects)
#   MANAGER_API_TOKEN    access token; required before exposing beyond this machine
#
# Without a token the manager binds to 127.0.0.1 only, so a default run is never
# reachable off-box. See the README "Security" section.

set -euo pipefail

# Resolve the install directory, following a symlinked script back to the real
# file so `ln -s .../start-manager.sh ~/bin/` keeps working.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

usage() {
  cat <<EOF
Usage: ./start-manager.sh [options]

Options:
  --skip-install    Don't install/refresh npm dependencies before starting.
  -h, --help        Show this help.

Environment overrides: PORT, CONFIG_FILE, PROJECTS_DIR, MANAGER_API_TOKEN.
To start the manager automatically on boot, run ./install-service.sh instead.
EOF
}

SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Run from the install directory so a relative CONFIG_FILE resolves next to the
# manager rather than against the caller's working directory — otherwise
# `~ $ HTTP_Server/start-manager.sh` would look for the config in $HOME and
# silently start with an empty one.
cd "$SCRIPT_DIR"

# --- Preflight: Node -------------------------------------------------------
# Required Node major, kept in sync with the "engines" field in package.json.
REQUIRED_NODE_MAJOR=14

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<EOF
❌ Node.js is not installed (or not on your PATH).

   Install Node.js v${REQUIRED_NODE_MAJOR} or later, then run this script again:
     https://nodejs.org/en/download
     Debian/Ubuntu: sudo apt install nodejs npm
     macOS:         brew install node
EOF
  exit 1
fi

NODE_VERSION="$(node --version)"                 # e.g. v22.22.2
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
  echo "❌ Node.js ${NODE_VERSION} is too old — v${REQUIRED_NODE_MAJOR} or later is required." >&2
  exit 1
fi

# --- Preflight: dependencies ----------------------------------------------
# Install on first run, and refresh when package.json is newer than the installed
# tree (i.e. after a `git pull` that changed dependencies).
needs_install() {
  [ ! -d "$SCRIPT_DIR/node_modules" ] && return 0
  [ ! -d "$SCRIPT_DIR/node_modules/express" ] && return 0
  [ ! -d "$SCRIPT_DIR/node_modules/ws" ] && return 0
  [ "$SCRIPT_DIR/package.json" -nt "$SCRIPT_DIR/node_modules" ] && return 0
  return 1
}

if [ "$SKIP_INSTALL" -eq 0 ] && needs_install; then
  if ! command -v npm >/dev/null 2>&1; then
    cat >&2 <<EOF
❌ Dependencies are not installed and npm is not available to install them.

   npm normally ships with Node.js. Install it, then run this script again:
     Debian/Ubuntu: sudo apt install npm
     macOS:         brew install node
EOF
    exit 1
  fi

  if [ -d "$SCRIPT_DIR/node_modules" ]; then
    echo "📦 Dependencies changed — refreshing them..."
  else
    echo "📦 Installing dependencies (first run only)..."
  fi
  if ! npm install --no-audit --no-fund; then
    cat >&2 <<EOF

❌ npm install failed. This usually means no internet connection, or no write
   permission in $SCRIPT_DIR.

   Fix the cause and re-run, or install dependencies manually with:
     cd "$SCRIPT_DIR" && npm install
EOF
    exit 1
  fi
  # Mark the tree as newer than package.json so the next run skips reinstalling.
  touch "$SCRIPT_DIR/node_modules"
  echo
fi

# --- Defaults --------------------------------------------------------------
export PORT="${PORT:-3000}"
export CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/config.json}"
export PROJECTS_DIR="${PROJECTS_DIR:-$SCRIPT_DIR/projects}"

# Create the projects folder up front. It's gitignored (imported programs are
# their own repos), so a fresh download doesn't have one — and without it
# "Rediscover" in the UI fails with "Projects directory not found" before you've
# imported anything.
if ! mkdir -p "$PROJECTS_DIR" 2>/dev/null; then
  echo "❌ Could not create the projects directory: $PROJECTS_DIR" >&2
  echo "   Check permissions, or set PROJECTS_DIR to a writable path." >&2
  exit 1
fi

echo "Starting HTTP Server Manager..."
echo "Node:               $NODE_VERSION"
echo "Port:               $PORT"
echo "Config:             $CONFIG_FILE"
echo "Projects Directory: $PROJECTS_DIR"
echo

# exec so the manager becomes this process: signals (Ctrl-C, systemd's SIGINT)
# reach Node directly, which runs its shutdown handler and stops every child
# program instead of orphaning them.
exec node "$SCRIPT_DIR/server.js"

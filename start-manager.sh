#!/bin/bash

# HTTP Server Manager Start Script
# This script starts the HTTP Server Manager with sensible defaults

# Set default port if not specified
export PORT="${PORT:-3000}"

# Set config file if not specified
export CONFIG_FILE="${CONFIG_FILE:-./config.json}"

# Set default projects directory for auto-discovery.
# Defaults to a `projects/` folder next to this script so it works wherever the
# manager is installed. Override by exporting PROJECTS_DIR before running.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECTS_DIR="${PROJECTS_DIR:-$SCRIPT_DIR/projects}"

# Optional: Set API token for authentication
# export MANAGER_API_TOKEN="your-secret-token"

echo "Starting HTTP Server Manager..."
echo "Port: $PORT"
echo "Config: $CONFIG_FILE"
echo "Projects Directory: $PROJECTS_DIR"

# Start the server
node server.js

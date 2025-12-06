#!/bin/bash

# HTTP Server Manager Start Script
# This script starts the HTTP Server Manager with sensible defaults

# Set default port if not specified
export PORT="${PORT:-3000}"

# Set config file if not specified
export CONFIG_FILE="${CONFIG_FILE:-./config.json}"

# Set default projects directory for auto-discovery
export PROJECTS_DIR="${PROJECTS_DIR:-/home/jupyter-tj/projects}"

# Optional: Set API token for authentication
# export MANAGER_API_TOKEN="your-secret-token"

echo "Starting HTTP Server Manager..."
echo "Port: $PORT"
echo "Config: $CONFIG_FILE"
echo "Projects Directory: $PROJECTS_DIR"

# Start the server
node server.js

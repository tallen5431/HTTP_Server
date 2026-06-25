#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# CodeSmith — AI-assisted code modification UI
# Pulls the latest from github.com/tallen5431/CodeSmith and runs it.
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BRANCH="claude/zealous-babbage-4m10qp"
REPO_HTTPS="https://github.com/tallen5431/CodeSmith.git"

# ── Git: clone or update ──────────────────────────────────────────────────────
# Use HTTPS with a GitHub token if GITHUB_TOKEN is set, otherwise plain HTTPS.
# Set GITHUB_TOKEN in the manager card's env vars (Edit card in the web UI).
if [ -n "${GITHUB_TOKEN:-}" ]; then
    REPO_URL="https://oauth2:${GITHUB_TOKEN}@github.com/tallen5431/CodeSmith.git"
else
    REPO_URL="$REPO_HTTPS"
fi

if [ -d "$SRC_DIR/.git" ]; then
    echo "[codesmith] Updating from branch $BRANCH…"
    # Rewrite remote URL in case token changed
    git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
    git -C "$SRC_DIR" fetch --quiet origin
    git -C "$SRC_DIR" checkout --quiet "$BRANCH"
    git -C "$SRC_DIR" pull --quiet --ff-only origin "$BRANCH"
else
    echo "[codesmith] Cloning branch $BRANCH…"
    git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$SRC_DIR"
fi

# ── Python venv ───────────────────────────────────────────────────────────────
VENV="$SRC_DIR/venv"
if [ ! -d "$VENV" ]; then
    echo "[codesmith] Creating Python virtual environment…"
    python3 -m venv "$VENV"
fi

echo "[codesmith] Installing/updating dependencies…"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$SRC_DIR/requirements.txt"

# ── Network defaults (overridden by server manager env) ──────────────────────
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8050}"

# ── AI backend — desktop via Tailscale ───────────────────────────────────────
# desktop-glpggos Tailscale IP is 100.98.112.1; Ollama listens on 11434.
# Override CODESMITH_LLM_BASE_URL in the manager card env to change providers.
export CODESMITH_LLM_BASE_URL="${CODESMITH_LLM_BASE_URL:-http://100.98.112.1:11434/v1}"
export CODESMITH_LLM_API_KEY="${CODESMITH_LLM_API_KEY:-not-needed}"
export CODESMITH_LLM_MODEL="${CODESMITH_LLM_MODEL:-qwen2.5-coder:7b}"

echo "[codesmith] LLM backend: $CODESMITH_LLM_BASE_URL  model: $CODESMITH_LLM_MODEL"
echo "[codesmith] Starting on $HOST:$PORT…"

cd "$SRC_DIR"
exec "$VENV/bin/python" app.py

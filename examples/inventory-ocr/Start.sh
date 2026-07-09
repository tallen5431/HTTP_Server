#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Inventory OCR — snap phone photos to organize & categorize your stuff
# Pulls the latest from github.com/tallen5431/InventoryOCR and runs it.
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BRANCH="${INVENTORY_OCR_BRANCH:-main}"
REPO_HTTPS="https://github.com/tallen5431/InventoryOCR.git"

# ── Git: clone or update ──────────────────────────────────────────────────────
# Use HTTPS with a GitHub token if GITHUB_TOKEN is set, otherwise plain HTTPS.
# Set GITHUB_TOKEN in the manager card's env vars (Edit card in the web UI) if
# the repository is private.
if [ -n "${GITHUB_TOKEN:-}" ]; then
    REPO_URL="https://oauth2:${GITHUB_TOKEN}@github.com/tallen5431/InventoryOCR.git"
else
    REPO_URL="$REPO_HTTPS"
fi

if [ -d "$SRC_DIR/.git" ]; then
    echo "[inventory-ocr] Updating from branch $BRANCH…"
    git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
    git -C "$SRC_DIR" fetch --quiet origin
    git -C "$SRC_DIR" checkout --quiet "$BRANCH"
    git -C "$SRC_DIR" pull --quiet --ff-only origin "$BRANCH"
else
    echo "[inventory-ocr] Cloning branch $BRANCH…"
    git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$SRC_DIR"
fi

# ── Python venv ───────────────────────────────────────────────────────────────
VENV="$SRC_DIR/.venv"
if [ ! -d "$VENV" ]; then
    echo "[inventory-ocr] Creating Python virtual environment…"
    python3 -m venv "$VENV"
fi

echo "[inventory-ocr] Installing/updating dependencies…"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$SRC_DIR/requirements.txt"

# ── Network defaults (overridden by server manager env) ──────────────────────
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8001}"

# Serve at the site root (http://<host>:<port>/) so the manager's generated URL
# opens straight into the app. Set URL_PREFIX=/inventory only if you put this
# behind a reverse proxy at that path.
export URL_PREFIX="${URL_PREFIX:-}"

# "Identify from photo" uses a local Ollama vision model. Defaults match the
# other cards (desktop Ollama via Tailscale). Pull a vision model first, e.g.
#   ollama pull llama3.2-vision
export OLLAMA_HOST="${OLLAMA_HOST:-http://100.98.112.1:11434}"
export OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-llama3.2-vision}"

# Optional: automatic web identification during "Identify from photo". Leave the
# keys empty to stay fully local. A request only goes out when you press Identify
# and a provider is configured.
#   SERPAPI_KEY           Free web lookup (SerpApi — 100/mo, no credit card).
#                         Real product name, tags, links, and price. Recommended.
#   GOOGLE_VISION_API_KEY Alternative reverse-image (Google Vision; free tier
#                         needs billing enabled).
#   WEB_DETECT_PROVIDER   auto | serpapi | google_vision | none  (default auto)
export SERPAPI_KEY="${SERPAPI_KEY:-}"
export GOOGLE_VISION_API_KEY="${GOOGLE_VISION_API_KEY:-}"
export WEB_DETECT_PROVIDER="${WEB_DETECT_PROVIDER:-auto}"

# Optional: text extraction from photos needs the Tesseract binary on PATH.
# Inventory management works fine without it (OCR just returns empty text).
if ! command -v tesseract >/dev/null 2>&1; then
    echo "[inventory-ocr] Note: 'tesseract' not found — OCR text extraction will be disabled."
    echo "[inventory-ocr]       Install it with: sudo apt-get install -y tesseract-ocr"
fi

echo "[inventory-ocr] Starting on $HOST:$PORT (URL_PREFIX='${URL_PREFIX}')…"

cd "$SRC_DIR"
exec "$VENV/bin/python" app.py

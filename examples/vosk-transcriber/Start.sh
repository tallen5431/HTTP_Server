#!/usr/bin/env bash
set -euo pipefail

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8090}"
export VOSK_MODEL_PATH="${VOSK_MODEL_PATH:-$(pwd)/model}"

python3 app.py

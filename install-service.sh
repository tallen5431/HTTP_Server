#!/bin/bash
#
# Install the HTTP Server Manager as a systemd service so it starts on boot.
#
# Renders http-server-manager.service.template for THIS machine — detecting the
# install directory, the user to run as, and the node binary — then installs,
# enables and starts it. Nothing about the unit is hardcoded, so it works from
# whatever directory and account the manager was downloaded into.
#
#   ./install-service.sh                  # install, enable at boot, start now
#   ./install-service.sh --with-token     # also generate an access token (needed
#                                         #   to reach the manager from other devices)
#   ./install-service.sh --port 8000      # listen on a different port
#   ./install-service.sh --uninstall      # stop, disable and remove the service
#
# Run it as the normal user that owns the checkout (it calls sudo where needed),
# NOT as root — the manager launches arbitrary programs, so it must not run as
# root itself.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="http-server-manager"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_PATH="/etc/${SERVICE_NAME}.env"
TEMPLATE="$SCRIPT_DIR/${SERVICE_NAME}.service.template"

usage() {
  cat <<EOF
Usage: ./install-service.sh [options]

Options:
  --port <n>       Port for the service to listen on (default: \$PORT or 3000).
  --user <name>    Account to run the manager as (default: the invoking user).
  --with-token     Generate an access token in $ENV_PATH, enabling access from
                   other devices. Without it the service stays loopback-only.
  --no-start       Install and enable for boot, but don't start it now.
  --dry-run        Print the unit that would be installed, and change nothing.
  --uninstall      Stop, disable and remove the service.
  -h, --help       Show this help.
EOF
}

PORT_ARG="${PORT:-3000}"
RUN_USER=""
WITH_TOKEN=0
NO_START=0
UNINSTALL=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT_ARG="${2:-}"; shift ;;
    --user) RUN_USER="${2:-}"; shift ;;
    --with-token) WITH_TOKEN=1 ;;
    --no-start) NO_START=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --- Preflight -------------------------------------------------------------
# A dry run only renders the unit to stdout, so it needs neither systemd nor sudo.
if [ "$DRY_RUN" -eq 0 ] && { ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; }; then
  cat >&2 <<EOF
❌ systemd isn't available on this machine, so there's no service to install.

   The manager still runs fine in the foreground:
     $SCRIPT_DIR/start-manager.sh

   On macOS, use launchd; in WSL or a container, start it from your shell.
EOF
  exit 1
fi

# We need root to write into /etc, but the SERVICE must not run as root.
if [ "$(id -u)" -eq 0 ] || [ "$DRY_RUN" -eq 1 ]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "❌ This needs sudo (or root) to install into /etc/systemd/system." >&2
    exit 1
  fi
  SUDO="sudo"
fi

# Which account should the manager run as? Prefer an explicit --user, then the
# account that invoked sudo, then the current one. Never root: the manager starts
# arbitrary programs and clones and runs git repos.
if [ -z "$RUN_USER" ]; then
  RUN_USER="${SUDO_USER:-$(id -un)}"
fi
if [ "$RUN_USER" = "root" ]; then
  cat >&2 <<EOF
❌ Refusing to install a unit that runs as root.

   This manager starts arbitrary programs and clones and runs git repos, so
   running it as root turns any of that into full host compromise.

   Re-run as your normal user, or pass one explicitly:
     ./install-service.sh --user <account-that-owns-this-folder>
EOF
  exit 1
fi
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "❌ No such user: $RUN_USER" >&2
  exit 1
fi
RUN_GROUP="$(id -gn "$RUN_USER")"

# --- Uninstall -------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  echo "Removing the ${SERVICE_NAME} service..."
  $SUDO systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  $SUDO systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  $SUDO rm -f "$UNIT_PATH"
  $SUDO systemctl daemon-reload
  echo "✅ Service removed. The manager itself is untouched — run it any time with:"
  echo "     $SCRIPT_DIR/start-manager.sh"
  if [ -f "$ENV_PATH" ]; then
    echo
    echo "ℹ️  Left $ENV_PATH in place (it holds your access token)."
    echo "   Delete it with: sudo rm $ENV_PATH"
  fi
  exit 0
fi

# --- Validate inputs -------------------------------------------------------
if [ ! -f "$TEMPLATE" ]; then
  echo "❌ Template not found: $TEMPLATE" >&2
  exit 1
fi

case "$PORT_ARG" in
  ''|*[!0-9]*) echo "❌ --port must be a number, got: $PORT_ARG" >&2; exit 1 ;;
esac
if [ "$PORT_ARG" -lt 1 ] || [ "$PORT_ARG" -gt 65535 ]; then
  echo "❌ --port must be between 1 and 65535, got: $PORT_ARG" >&2
  exit 1
fi
# Ports below 1024 need privileges the unit deliberately doesn't grant.
if [ "$PORT_ARG" -lt 1024 ]; then
  cat >&2 <<EOF
❌ Port $PORT_ARG is privileged and the service runs as a normal user, so it
   would fail to bind. Pick a port above 1024 (the default 3000 is fine) and put
   a reverse proxy in front if you need :80 or :443.
EOF
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js isn't on your PATH. Install it first: https://nodejs.org/en/download" >&2
  exit 1
fi
# Resolve symlinks so the unit points at a stable path.
if command -v readlink >/dev/null 2>&1; then
  NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
fi
case "$NODE_BIN" in
  */.nvm/*|*/.volta/*|*/.asdf/*|*/.fnm/*)
    cat <<EOF
⚠️  Node lives in a version manager: $NODE_BIN
   That path changes when you upgrade Node, which would break the service at the
   next boot. Consider a system-wide Node (e.g. 'sudo apt install nodejs'), then
   re-run this script.

EOF
    ;;
esac

if [ "$DRY_RUN" -eq 0 ]; then
  # Dependencies must exist before boot — the service runs server.js directly and
  # won't npm install for itself the way start-manager.sh does.
  if [ ! -d "$SCRIPT_DIR/node_modules/express" ] || [ ! -d "$SCRIPT_DIR/node_modules/ws" ]; then
    echo "📦 Installing dependencies first..."
    (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund)
    echo
  fi

  # The projects folder must exist and be owned by the run user, since the service
  # clones imported programs into it.
  mkdir -p "$SCRIPT_DIR/projects" 2>/dev/null || $SUDO mkdir -p "$SCRIPT_DIR/projects"
fi

# --- Render the unit -------------------------------------------------------
# Escape the sed replacement metacharacters (\ & and the | delimiter) so paths
# containing them can't corrupt the rendered unit.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

RENDERED="$(sed \
  -e "s|__RUN_USER__|$(sed_escape "$RUN_USER")|g" \
  -e "s|__RUN_GROUP__|$(sed_escape "$RUN_GROUP")|g" \
  -e "s|__INSTALL_DIR__|$(sed_escape "$SCRIPT_DIR")|g" \
  -e "s|__NODE_BIN__|$(sed_escape "$NODE_BIN")|g" \
  -e "s|__PORT__|$(sed_escape "$PORT_ARG")|g" \
  "$TEMPLATE")"

# Never install a half-rendered unit: an unsubstituted placeholder would leave
# systemd with a nonsense path or user. Comments are excluded — the template
# documents its own placeholders in prose, and a comment is not a directive.
UNFILLED="$(printf '%s\n' "$RENDERED" | grep -v '^[[:space:]]*#' | grep -o '__[A-Z_]*__' | sort -u || true)"
if [ -n "$UNFILLED" ]; then
  echo "❌ The template still has unfilled placeholders — refusing to install:" >&2
  printf '%s\n' "$UNFILLED" >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$RENDERED"
  echo "# --- dry run: nothing was installed. It would go to $UNIT_PATH ---" >&2
  exit 0
fi

echo "Installing the ${SERVICE_NAME} service:"
echo "  Install dir: $SCRIPT_DIR"
echo "  Run as:      ${RUN_USER}:${RUN_GROUP}"
echo "  Node:        $NODE_BIN"
echo "  Port:        $PORT_ARG"
echo

printf '%s\n' "$RENDERED" | $SUDO tee "$UNIT_PATH" >/dev/null
$SUDO chmod 644 "$UNIT_PATH"

# --- Optional access token -------------------------------------------------
GENERATED_TOKEN=""
if [ "$WITH_TOKEN" -eq 1 ]; then
  if [ -f "$ENV_PATH" ]; then
    echo "ℹ️  $ENV_PATH already exists — keeping the token that's already in it."
    echo
  else
    if command -v openssl >/dev/null 2>&1; then
      GENERATED_TOKEN="$(openssl rand -hex 32)"
    else
      GENERATED_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    fi
    # 600 and root-owned: anyone who reads this token can run programs on this box.
    printf '# Generated by install-service.sh\nMANAGER_API_TOKEN=%s\n' "$GENERATED_TOKEN" \
      | $SUDO tee "$ENV_PATH" >/dev/null
    $SUDO chmod 600 "$ENV_PATH"
    $SUDO chown root:root "$ENV_PATH" 2>/dev/null || true
  fi
fi

# --- Enable and start ------------------------------------------------------
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null
echo "✅ Enabled at boot."

if [ "$NO_START" -eq 1 ]; then
  echo "   Not starting now (--no-start). Start it with: sudo systemctl start $SERVICE_NAME"
  exit 0
fi

$SUDO systemctl restart "$SERVICE_NAME"

# Give it a moment to bind (or fail) before reporting.
sleep 2
if $SUDO systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "✅ Running. It will now start automatically on boot."
  echo
  echo "   Web interface:  http://localhost:${PORT_ARG}"
  if [ -n "$GENERATED_TOKEN" ]; then
    echo
    echo "   🔑 Access token (needed to sign in, and to reach the manager from"
    echo "      other devices — save it somewhere safe):"
    echo
    echo "      $GENERATED_TOKEN"
    echo
    echo "      Stored in $ENV_PATH (root-only). Anyone with this token can run"
    echo "      programs on this machine, so treat it like a password."
  else
    echo
    echo "   🔒 No access token set, so the manager is bound to 127.0.0.1 and is"
    echo "      reachable from this machine only. To use it from other devices:"
    echo "        ./install-service.sh --with-token"
  fi
  echo
  echo "   Status:  sudo systemctl status $SERVICE_NAME"
  echo "   Logs:    sudo journalctl -u $SERVICE_NAME -f"
  echo "   Remove:  ./install-service.sh --uninstall"
else
  echo "❌ The service failed to start. Recent logs:" >&2
  echo >&2
  $SUDO journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
  exit 1
fi

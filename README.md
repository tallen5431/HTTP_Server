# HTTP Server Manager

A simple, self-configuring HTTP server manager that automatically detects your network configuration and manages multiple applications. Perfect for hosting web applications over LAN with zero manual configuration.

## Features

- **🔍 Auto-Discovery**: Automatically scans projects folder and generates configuration - zero manual setup!
- **🎯 Automatic IP Detection**: Zero-configuration setup - automatically detects your server's network IP
- **⚡ Process Management**: Start, stop, and restart programs with a single click
- **📡 Real-time Updates**: WebSocket-based live status updates
- **📋 Log Viewing**: View and search program logs directly in the web interface
- **🔗 Smart URL Generation**: Automatic URL generation that works from anywhere (localhost, LAN)
- **🎨 Clean Web UI**: Modern, responsive interface that works on desktop and mobile
- **🌐 Multi-program Support**: Manage multiple applications from a single interface
- **🧠 Framework Detection**: Intelligently detects Flask, Django, FastAPI, Node.js, Streamlit and configures accordingly
- **📥 Import from Git**: Clone any repository straight into your projects folder from the web UI
- **🔐 Token Login**: Optional access token with an in-UI sign-in (stored per device) — required before exposing the manager beyond your machine
- **🌍 Remote Access**: Tailscale-aware URLs so you can manage the server and reach your programs from anywhere, privately
- **❤️ Health Checks**: Live TCP port probing shows *listening* vs *running-but-not-serving* vs *crashed (exit code)* — not just "process alive"
- **⏻ Autostart Toggle**: Flip autostart-on-boot per program right from its card
- **🗂️ Persistent Logs**: Program output is mirrored to disk, so history survives a manager restart
- **🖥️ Tailnet SSH Terminal**: Lists every device on your tailnet and opens an SSH terminal to one in the browser (see [SSH Terminal](#ssh-terminal-for-tailnet-devices))

## Prerequisites

- **Node.js** (v14 or later) and **npm** — [nodejs.org/en/download](https://nodejs.org/en/download),
  or `sudo apt install nodejs npm` / `brew install node`
- That's it. Everything else the manager needs, it sets up on first run.

## Quick Start

Download the project (clone it, or **Code → Download ZIP** on GitHub and unzip
it), then run:

```bash
./start-manager.sh
```

That's the whole install. On first run the script checks your Node version,
installs the npm dependencies, creates the `projects/` folder, and starts the
manager — then open **http://localhost:3000**.

Nothing is tied to a particular machine or account: every path is derived from
wherever you put the folder, and the network address is detected at runtime. You
can move or rename the folder and it keeps working.

> If you get `Permission denied`, the executable bit didn't survive the ZIP:
> run `chmod +x start-manager.sh install-service.sh` (or just `bash start-manager.sh`).

To keep it running across reboots, see
[Auto-Launch Manager on Boot](#auto-launch-manager-on-boot-systemd).

### Adding Your Programs

You have two options:

#### Option A: Auto-Discovery (Recommended)

Drop projects (each with a `Start.sh` in its root) into the `projects/` folder
next to this install, then hit **Rediscover** in the web UI — or use **Import
from Git** to clone one straight in. You can also point the manager at a
different folder:

```bash
PROJECTS_DIR=/path/to/your/projects ./start-manager.sh
```

The manager will:
- Scan the directory for projects with `Start.sh` files
- Auto-generate `config.json` with intelligent defaults
- Detect framework types and PORT configurations
- Set up environment variables automatically
- Default to the `projects/` folder next to this install if not specified

#### Option B: Manual Configuration

Create a `config.json` file (use `config.example.json` as a template):

```json
{
  "hostname": "auto",
  "programs": [
    {
      "id": "my-app",
      "name": "My Application",
      "path": "/path/to/your/app",
      "env": {
        "PORT": "8080"
      }
    }
  ]
}
```

### Accessing the Web Interface

The manager listens on port 3000 by default (`PORT=8080 ./start-manager.sh` to
change it):
- `http://localhost:3000` (local)
- `http://YOUR_IP:3000` (from other devices on your network — requires an access
  token, see [Security](#security))

### Start Script Options

```bash
./start-manager.sh                  # install deps if needed, then start
./start-manager.sh --skip-install   # start without touching npm
./start-manager.sh --help           # list options
PORT=8080 ./start-manager.sh        # any of the environment variables below
```

`npm start` also works if the dependencies are already installed; the shell
script is the one that bootstraps them for you.

> **Heads-up on remote use:** this manager can start programs and clone-and-run
> git repos, so reaching it over a network is effectively remote command access
> to this machine. By default, **if no access token is set the manager binds to
> `127.0.0.1` only** (local access), so it is never exposed unauthenticated.
> Setting `MANAGER_API_TOKEN` enables binding on all interfaces. See
> [Security](#security) and [Remote Access](#remote-access-manage-from-anywhere).

## Security

Read this before exposing the manager beyond your own machine.

1. **Set an access token.** Export `MANAGER_API_TOKEN` (e.g. `openssl rand -hex 32`).
   Every API request and the WebSocket then require it. The web UI shows a
   **Sign in** screen the first time and stores the token on that device. By
   default, with no token the manager binds to loopback only and refuses remote
   connections (unless you override that with `MANAGER_HOST` or
   `MANAGER_ALLOW_NO_AUTH` — see point 5).
2. **Don't run it as root.** The shipped `systemd` unit runs as a non-root user.
   Because the manager launches arbitrary programs and clones/runs repos, running
   as root turns any of that into full host compromise.
3. **Prefer a private network over a public port.** Tailscale (recommended),
   WireGuard, or a VPN keep the manager off the public internet entirely. If you
   must publish it, put an authenticating reverse proxy / Cloudflare Access in
   front — never port-forward `:3000` directly.
4. **Programs stay inside your projects folder.** Adding/updating a program with a
   `path` outside `PROJECTS_DIR` is rejected (override with
   `MANAGER_ALLOW_EXTERNAL_PATHS=1` only if you trust every caller).
5. **Running without a token? Bind to Tailscale only, not `0.0.0.0`.** Two knobs
   disable the fail-closed loopback default and expose the manager **unauthenticated**:
   `MANAGER_ALLOW_NO_AUTH=1` binds all interfaces (LAN *and* Tailscale), and a
   non-loopback `MANAGER_HOST` binds whatever you point it at. If you want
   no-token convenience, set `MANAGER_HOST` to your Tailscale IP (`100.x.y.z`) so
   the manager is reachable over Tailscale but **not** on your home Wi-Fi. Prefer a
   token whenever the manager can be reached from the LAN.

What the app does for you: token auth on **all** endpoints (reads included) and
the WebSocket, constant-time token comparison, no token in query strings (HTTP
*or* WebSocket), a brute-force throttle on failed auth, a **Host-header allowlist**
that blocks DNS-rebinding (loopback / IP literals / `*.ts.net` are allowed; add
others via `MANAGER_ALLOWED_HOSTS`), basic security headers, and a loud startup
banner telling you exactly what's exposed.

## Remote Access (manage from anywhere)

The goal — reach the manager (and your programs) from your phone or laptop while
away from home — without publishing a root-capable control panel to the internet.

### Recommended: Tailscale

Tailscale puts your devices on a private WireGuard network (a "tailnet"). Nothing
is exposed publicly; only your own authorized devices can connect. This code is
already Tailscale-aware, so program cards render correct `*.ts.net` URLs.

1. Install Tailscale on the server and sign in:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Install the Tailscale app on your phone/laptop and sign in to the same account.
3. Set a token and start the manager (see [Security](#security)); it will bind on
   all interfaces so the tailnet can reach it.
4. From anywhere, open `http://<your-server>.<your-tailnet>.ts.net:3000`, enter
   your token once, and manage everything.

For a clean HTTPS name with no port and no cert wrangling, use Tailscale Serve:
```bash
sudo tailscale serve --bg 3000        # serves the manager at https://<host>.<tailnet>.ts.net
```
You can also give a program an HTTPS Tailscale URL with `preferTailscale` /
`omitPortInUrl` (see [Programs](#programs)).

### Other options

- **Cloudflare Tunnel + Access** — reach a custom `https://` domain with browser
  SSO/MFA at the edge. Good if you want a public URL, but **only safe with an
  Access policy in front** (the tunnel itself is public).
- **WireGuard (self-hosted VPN)** — like Tailscale but fully self-hosted; more
  manual to set up and add devices.
- **Reverse proxy + port-forward** — weakest option here and easiest to get
  wrong; only with full app auth *and* proxy-level auth (basic-auth/mTLS) on top.

Whichever transport you pick, still set a token — a single compromised device on
your private network should not inherit command access to this machine.

### SSH Terminal for tailnet devices

The **>_ Devices** button lists every device on this machine's tailnet (read from
`tailscale status`, so there is nothing to configure) with its online state,
MagicDNS name and Tailscale IP. **Connect** opens an SSH terminal to that device
in the browser; it works on phones too.

How it works: the manager runs the system `ssh` client, as the user the manager
runs as, inside a pseudo-terminal, and streams it over a WebSocket to
[xterm.js](https://xtermjs.org). So it behaves exactly like typing
`ssh <device>` on the manager's machine: your `~/.ssh/config`, keys, agent and
`known_hosts` all apply, and host-key or password prompts appear in the terminal.
Closing the terminal or losing the connection ends the SSH session.

Requirements and setup:

- **An access token (`MANAGER_API_TOKEN`) is required.** A terminal is a shell, so
  it stays off on an unauthenticated manager, even with `MANAGER_ALLOW_NO_AUTH`.
  Set `MANAGER_SSH_TERMINAL=0` to turn it off with a token set too.
- `ssh`, `python3` (for the pseudo-terminal) and the `tailscale` CLI on the manager
  machine.
- A way to log in to each device, either of:
  - **Tailscale SSH** (simplest): run `sudo tailscale set --ssh` on the device.
    Tailscale signs you in with your tailnet identity, so there are no keys to
    manage. Devices with it on show a *Tailscale SSH* badge.
  - **Regular OpenSSH with a key**, as the manager's user:
    ```bash
    ssh-keygen -t ed25519                # if you don't have a key yet
    ssh-copy-id pi@raspberrypi           # once per device
    ```
- Set the login name with the **⚙** button next to **Connect** (remembered per
  device in this browser), or leave it blank to use `~/.ssh/config` / the manager's
  own user name.

On a phone:

- A row of extra keys sits under the terminal: **Esc**, **Tab**, **Ctrl**, **Alt**,
  arrows, Home/End, PgUp/PgDn and a few symbols. Ctrl and Alt latch for the next
  key you type: tap **Ctrl**, then `c` sends Ctrl+C. Arrows repeat while held.
  **⌨** shows or hides the row (shown by default on touch screens).
- **A−** / **A+** change the text size, remembered per device.
- The terminal shrinks to stay above the on-screen keyboard.
- **Keep session (tmux)** (under **⚙**) runs the shell inside `tmux` on the device,
  so it keeps running when the phone locks or you switch apps. Coming back to the
  page reconnects to the same session automatically; **↻ Reconnect** does it by
  hand. The device needs tmux (`sudo apt install tmux`); without it you get a
  normal shell and a note saying so. Every keep-session connection to a device
  joins the same tmux session (`manager`), so two tabs see the same screen.
- **Recent** at the top of the Devices list reconnects to your last few devices
  in one tap.

The browser only ever sends a device's Tailscale node ID; the manager connects to
the address Tailscale reports for it, so the terminal can't be pointed at hosts
outside your tailnet. Terminal connections must also come from the manager's own
page (same-origin check), and each session's open and close are logged.

## Configuration

### Auto-Discovery

**Automatic Discovery on Startup:**
```bash
# Set PROJECTS_DIR and the manager will auto-generate config.json on first run
PROJECTS_DIR=/path/to/your/projects node server.js
```

**Manual Discovery:**
```bash
# Scan projects directory and generate config.json
node discover-projects.js /path/to/your/projects

# Dry run (preview without saving)
node discover-projects.js /path/to/your/projects --dry-run

# Specify output file
node discover-projects.js /path/to/your/projects --output my-config.json
```

**Web UI Rediscovery:**
- Click the "🔍 Rediscover" button in the web interface
- Enter the projects directory path when prompted (defaults to the `projects/` folder next to this manager install, or whatever `PROJECTS_DIR` is set to)
- Scans the specified directory and regenerates config.json
- Automatically backs up existing config
- Preserves existing program URL overrides/options when a rediscovered program matches the old ID
- All changes take effect immediately

### Importing a Program from Git

The fastest way to add a program from another repository:

- Click the **"📥 Import from Git"** button in the web interface
- Paste a repository URL (`https://`, `git://`, `ssh://`, or `git@host:user/repo`)
- Optionally set a branch and/or the folder name it lands in

The manager will:
1. Clone the repository into your projects folder (`PROJECTS_DIR`, default `projects/` next to the manager)
2. If the repo has no `Start.sh`, generate a working launcher — it detects the real runtime (a venv-safe Python launcher using the right command for Flask/FastAPI/Streamlit/Django/gunicorn, or `node`/`npm start` for Node projects) and falls back to an editable placeholder when it can't tell, rather than emitting a command that would crash on start
3. Rediscover projects so the new program appears immediately (existing config is backed up first, and per-program settings like `autostart`, custom names, and env overrides are preserved)

Re-importing the same repository **updates it to the latest upstream** (`git fetch` + `git reset --hard` onto the tracked branch), so pulling a new version keeps working even when the upstream was force-pushed/rebased or when a generated `Start.sh` would otherwise collide — cases a plain `git pull --ff-only` used to abort on. Local edits to tracked files are discarded (these clones are deployment copies of upstream); untracked files such as a generated `.venv` are kept. If the program is running, it is stopped before the update and **automatically restarted on the new code** afterward, so an update-and-retest is a single action. The scaffolded launchers reinstall dependencies when `package.json`/`requirements.txt` changed, so updated dependencies are picked up on the next start. Passing a different branch on re-import switches to it. If the folder name already holds a *different* repository, the import is refused rather than silently updating the wrong one (delete the existing program with "remove files" first, or choose a different name). If a scaffolded `Start.sh` was generated, review it — and set the right `PORT`/env — before starting the program. Cloning runs `git` directly with argument arrays (never a shell string) and validates the URL, so pasted URLs can't inject shell commands.

**What Gets Auto-Detected:**
- ✅ All directories with `Start.sh` files
- ✅ PORT from Start.sh (supports multiple patterns)
- ✅ HOST configuration
- ✅ Environment variables (from `export` statements)
- ✅ Framework detection (Flask, Django, FastAPI, Node.js, Streamlit)
- ✅ Project metadata from package.json, README.md

### Hostname Configuration

At the root level of `config.json`, you can optionally specify a hostname for URL generation:

- **hostname**: Hostname to use for auto-generated program URLs (optional)
  - `"auto"` (default): Automatically detects the server's primary network IP address
  - Specific IP/hostname: Use a custom value (e.g., `"192.168.1.100"` or `"myserver.local"`)
- **tailscaleHostname**: Optional Tailscale MagicDNS hostname for HTTPS program URLs (for example, `"my-host.my-tailnet.ts.net"`). When omitted, programs with `preferTailscale: true` try `TAILSCALE_HOSTNAME`, `TS_CERT_DOMAIN`, then `tailscale status --json`.
- **urlProtocol**: Default protocol for generated program URLs (defaults to `"http"`).

The hostname is used when auto-generating URLs from PORT environment variables. The manager intelligently detects your server's network IP (prioritizing eth0, en0, wlan0) so that URLs work whether you access the manager from:
- The local machine: `http://localhost:3000`
- Other devices on your network: `http://192.168.1.100:3000`

### Programs

Each program in the `programs` array has the following fields:

- **id** (required): Unique identifier for the program (lowercase, no spaces)
- **name** (required): Display name shown in the UI
- **path** (required): Absolute path to the program directory (must contain `Start.sh`)
- **env** (optional): Environment variables to pass to the program
  - Set `PORT` here to auto-generate URLs
- **url** (optional): Manual URL override
  - If not provided, automatically generated from `PORT` environment variable
  - Useful for external domains or custom configurations
- **urlProtocol** (optional): Per-program protocol for generated URLs, such as `"https"`.
- **hostname** (optional): Per-program hostname override.
- **preferTailscale** (optional): When `true`, generated URLs prefer the configured/detected Tailscale MagicDNS hostname.
- **omitPortInUrl** (optional): When `true`, generated URLs omit `:PORT`; useful for Tailscale Serve HTTPS endpoints that proxy port 443 to the local app.
- **autostart** (optional): When `true`, the program will automatically start when the manager starts. Useful for services that should always be running.

### Autostart on Boot

You can configure programs to start automatically when the manager starts by setting `autostart: true` in your config:

```json
{
  "hostname": "auto",
  "programs": [
    {
      "id": "inventory",
      "name": "InventoryOCR",
      "path": "/home/user/HTTP_Server/projects/InventoryOCR",
      "env": { "PORT": "8080" },
      "autostart": true
    },
    {
      "id": "api-server",
      "name": "API Server",
      "path": "/home/user/HTTP_Server/projects/api-server",
      "env": { "PORT": "8081" },
      "autostart": true
    }
  ]
}
```

When the manager starts, any programs with `autostart: true` will launch automatically. This is useful for services that should always be available (e.g., inventory management, APIs, monitoring dashboards).

#### Auto-Launch Manager on Boot (systemd)

To have the HTTP Server Manager itself start automatically after a reboot, run:

```bash
./install-service.sh
```

That's all — it renders `http-server-manager.service.template` for your machine
(detecting the install directory, your user account, and your `node` binary),
installs it to `/etc/systemd/system/`, enables it at boot and starts it. It calls
`sudo` where it needs to, so run it as your **normal user**, not as root — it
refuses to install a unit that would run the manager as root.

**Options:**

```bash
./install-service.sh --with-token   # also generate an access token, so you can
                                    #   reach the manager from other devices
./install-service.sh --port 8080    # listen on a different port
./install-service.sh --user someone # run as a different account
./install-service.sh --dry-run      # print the unit it would install, change nothing
./install-service.sh --no-start     # enable at boot, but don't start it now
./install-service.sh --uninstall    # stop, disable and remove the service
```

Without `--with-token` the service stays loopback-only (reachable from that
machine only) — the same fail-closed default as running it by hand. Use
`--with-token` when you want to reach it from your phone or another computer; it
writes a generated token to a root-only `/etc/http-server-manager.env` and prints
it once so you can sign in.

**Managing it afterwards:**

```bash
sudo systemctl status http-server-manager     # is it running?
sudo journalctl -u http-server-manager -f     # follow its logs
sudo systemctl restart http-server-manager    # restart it
```

The service restarts the manager automatically if it crashes, and starts it on
every boot. Combined with per-program `autostart: true` flags, this ensures your
services are always running after a reboot.

> **Not on systemd?** macOS (launchd), WSL, and containers don't use it — the
> installer will tell you so and change nothing. Run `./start-manager.sh`
> directly there.

### Environment Variables

You can configure the server using these environment variables:

- `PORT`: Server port (default: 3000)
- `CONFIG_FILE`: Path to config file (default: ./config.json)
- `PROJECTS_DIR`: Auto-discover projects from this directory (default: `projects/` next to the install)
- `MANAGER_API_TOKEN`: Access token for authentication. **When unset, the manager
  binds to `127.0.0.1` only** (local-only, fail-closed). Set it to enable auth and
  remote access.
- `MANAGER_HOST`: Explicit bind address (overrides the token-based default; e.g.
  set to your Tailscale `100.x.y.z` to listen on Tailscale only). ⚠️ A
  non-loopback value with **no** `MANAGER_API_TOKEN` exposes the manager
  **unauthenticated** on that address — set a token too unless it's a trusted
  private interface.
- `MANAGER_ALLOW_NO_AUTH`: Set to `1`/`true`/`yes` to bind on **all** interfaces
  (LAN *and* Tailscale) **without** a token. ⚠️ Anyone who can reach the port can
  run programs on this machine — only on a fully trusted network. Prefer a token,
  or `MANAGER_HOST=<tailscale-ip>` to keep it off the LAN.
- `MANAGER_ALLOWED_HOSTS`: Comma-separated extra `Host` header values to accept
  (e.g. a reverse-proxy domain). Loopback, raw IP literals, and `*.ts.net` are
  always allowed; everything else is rejected as a DNS-rebinding guard.
- `MANAGER_ALLOW_EXTERNAL_PATHS`: Set to `1` to allow program paths outside
  `PROJECTS_DIR` (off by default as a safety guard)
- `MANAGER_TRUST_PROXY`: Set to `1` only when the manager sits behind a trusted
  reverse proxy, so `X-Forwarded-For` is used for the rate-limit client IP.
  Leave unset otherwise (the header would be spoofable)
- `MANAGER_SSH_TERMINAL`: Set to `0` to disable the browser SSH terminal. It is
  only ever enabled when `MANAGER_API_TOKEN` is set.
- `MANAGER_LOG_DIR`: Where per-program logs are mirrored to disk (default: `logs/`)
- `TAILSCALE_HOSTNAME` / `TS_CERT_DOMAIN`: Tailscale MagicDNS hostname for HTTPS
  program URLs when the `tailscale` CLI isn't available to the manager

Example:
```bash
PORT=4000 MANAGER_API_TOKEN="$(openssl rand -hex 32)" ./start-manager.sh
```

## Project Structure

Your projects should follow this structure:

```
/path/to/your/project/
├── Start.sh          # Required: Script to start your application
├── package.json      # Optional: For Node.js projects
├── requirements.txt  # Optional: For Python projects
└── ...
```

### Start.sh Example

For a Node.js app:
```bash
#!/bin/bash
export PORT=8080
npm start
```

For a Python/Flask app:
```bash
#!/bin/bash
export PORT=8081
python app.py
```

### Adding Your Own Programs

The manager is driven entirely by the `projects/` folder. To add a program:

- **Import from Git** (easiest): use the **"📥 Import from Git"** button in the web
  UI to clone a repository straight into `projects/` (see above).
- **Drop it in**: copy or clone your project into `projects/<name>/`, make sure it
  has an executable `Start.sh` that sets `PORT`, then click **🔍 Rediscover**.

Either way the new program appears as a card with an auto-generated URL. Nothing
is bundled into this repository — your projects and their data live under
`projects/`, which is ignored by git so it persists across manager updates.

## API Endpoints

The manager provides a REST API. **When `MANAGER_API_TOKEN` is set, every
endpoint below requires the `Authorization: Bearer` header** — only
`GET /api/health` stays open. `GET /api/programs` also returns each program's
`health` (`listening` / `starting` / `running` / `crashed` / `stopped`),
`reachable`, `exitCode`, and `autostart`.

**Program Control:**
- `GET /api/programs` - List all programs and their status
- `POST /api/programs/:id/start` - Start a program
- `POST /api/programs/:id/stop` - Stop a program
- `POST /api/programs/:id/restart` - Restart a program (waits for the real exit, then starts)
- `GET /api/programs/:id/logs` - Get program logs

**Program Management:**
- `POST /api/programs` - Add a new program
- `PUT /api/programs/:id` - Update a program (name, path, url, env, `autostart`)
- `DELETE /api/programs/:id` - Remove a program (add `?removeFiles=1` to also delete its folder from disk, confined to the projects directory; default keeps the files)

**Configuration:**
- `GET /api/config` - Get current configuration
- `POST /api/rediscover` - Rediscover projects and regenerate config (requires auth)
- `POST /api/import-repo` - Clone a git repo into the projects folder, scaffold a `Start.sh` if needed, and rediscover (requires auth). Body: `{ "repoUrl": "...", "branch": "optional", "name": "optional-folder-name" }`

**Remote Hosts:**
- `GET /api/remote-hosts` - Devices on this machine's tailnet and whether the SSH terminal is enabled (`?refresh=1` skips the 10 s cache)
- `WS /ws/terminal?device=<node id>&user=<optional>&persist=1&rows=&cols=` - SSH terminal to a device (requires the token and a same-origin page)

**System:**
- `GET /api/stats` - Get statistics
- `GET /api/health` - Health check
- `POST /api/restart-manager` - Restart the manager process (requires auth)

### Authentication

If you set `MANAGER_API_TOKEN`, **every** API endpoint (reads included) and the
WebSocket require the token.

- **In the web UI:** a **Sign in** screen appears; enter the token once and it's
  stored on that device (localStorage). A **Sign out** button clears it.
- **For API clients:** send the token in the `Authorization` header. (The
  query-string `?token=` form was removed — query strings leak into logs and
  browser history.)

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  -X POST http://localhost:3000/api/programs/my-app/start
```

The token is compared in constant time, and repeated auth failures from one IP
are throttled. `GET /api/health` stays open (no token) so uptime monitors can
poll liveness; it reports `authEnabled` so the UI knows to prompt.

## Web Interface Features

- **Real-time Status**: See which programs are running/stopped with live updates
- **One-Click Controls**: Start, stop, or restart any program with a single click
- **Bulk Operations**: Start/stop/restart all programs at once
- **Program Editor**: Edit program settings directly in the web interface
  - Edit program name, path, and URL
  - Modify environment variables (PORT, HOST, etc.)
  - Add/remove environment variables dynamically
- **Add/Remove Programs**: Add new programs or delete existing ones
- **Log Viewer**: View and search program logs in real-time
- **Search**: Quickly find programs by name, ID, path, or URL (Ctrl+F or Ctrl+K)
- **Responsive Design**: Works on desktop, tablet, and mobile devices

### Editing Programs

1. Click the ✏️ **Edit** button on any program card
2. Modify settings:
   - **Name**: Display name in the UI
   - **Path**: Absolute path to the program directory (must contain Start.sh)
   - **URL**: Optional manual URL override
   - **Environment Variables**: Add, edit, or remove variables like PORT, HOST, etc.
3. Click **Save** to apply changes
4. The config is automatically backed up before saving

### Adding Programs

1. Click the ➕ **Add Program** button in the header
2. Fill in the required fields:
   - **ID**: Unique identifier (lowercase, hyphens allowed)
   - **Name**: Display name
   - **Path**: Path to the program directory
3. Add environment variables as needed
4. Click **Save**

### Removing Programs

1. Click the 🗑️ **Delete** button on any program card
2. Confirm the deletion
3. The program will be stopped if running and removed from the config

## Keyboard Shortcuts

- `Ctrl/Cmd + F` or `Ctrl/Cmd + K`: Focus search
- `Escape`: Close modal or clear search

## Troubleshooting

### Invalid PORT errors (ValueError: invalid literal for int)?

This happens when PORT is set to a non-numeric value like "HOST" or "$HOST". To fix:

1. **Validate and fix your config:**
   ```bash
   node validate-config.js
   ```
   This will automatically detect and fix invalid PORT/HOST values.

2. **Or rediscover with fixed validation:**
   - Click the 🔍 Rediscover button in the web interface
   - Enter your projects directory path
   - The improved discovery script will now skip invalid PORT values

3. **Or manually edit config.json:**
   - Open `config.json`
   - Find programs with `"PORT": "HOST"` or similar
   - Change to a valid port number like `"PORT": "8080"` or remove the PORT field

### Missing "Open" buttons?

The Open button only appears when a program has a valid URL. To see Open buttons:
- Make sure the program has a `PORT` environment variable in config.json
- Ensure PORT is a valid number (not "HOST" or variable references)
- Or manually set a `url` field in the program configuration

### The manager itself won't start?

- **`Permission denied`** — the executable bit was lost (common when the ZIP is
  unzipped by a GUI tool): `chmod +x start-manager.sh install-service.sh`, or run
  it as `bash start-manager.sh`.
- **`Node.js is not installed`** — install Node v14+ from
  [nodejs.org](https://nodejs.org/en/download), then re-run the script.
- **`npm install failed`** — usually no internet connection, or the folder isn't
  writable by your user. Fix that and re-run; the script retries the install
  itself on the next start.
- **`EADDRINUSE` / port already in use** — something else has port 3000. Start on
  another one: `PORT=8080 ./start-manager.sh`.

### Programs not starting?

1. Check that `Start.sh` exists and is executable:
   ```bash
   chmod +x /path/to/your/project/Start.sh
   ```

2. View the program logs in the web interface for error messages

3. Make sure the program's dependencies are installed

4. Validate your config for common issues:
   ```bash
   node validate-config.js
   ```

### Can't access from other devices?

1. **Set `MANAGER_API_TOKEN`.** With no token the manager binds to `127.0.0.1`
   only (by design), so it's unreachable from other devices until you set one.
   The startup banner tells you exactly what's exposed.
2. Check your firewall settings - port 3000 needs to be accessible
3. Verify the server is listening on all interfaces — the banner shows the bind
   address (`0.0.0.0:3000` once a token is set)
4. For access away from home, use Tailscale — see
   [Remote Access](#remote-access-manage-from-anywhere)
5. Use the IP address shown in the console output when starting the manager

### WebSocket disconnecting?

- This is normal if the manager restarts
- The client will automatically reconnect within 3 seconds
- Check network connectivity if reconnection fails repeatedly

## Development

To run in development mode:

```bash
npm run dev
```

To run the test suite (uses the built-in `node:test` runner — no extra deps):

```bash
npm test
```

The tests cover the security- and correctness-critical helpers: git-URL
validation, repo-folder sanitizing, the projects-folder path guard, port
detection (including the "don't latch onto a logged dependency address" case),
and `Start.sh` parsing (including the `${PORT:-8080}` default form).

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

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

## Prerequisites

- **Node.js** (v14 or later)
- **npm** (comes with Node.js)
- Projects with `Start.sh` scripts in their root directories

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Your Programs

You have two options:

#### Option A: Auto-Discovery (Recommended)

Let the manager automatically find all your projects:

```bash
# The manager defaults to the `projects/` folder next to this install
# Just run:
npm start

# Or specify a custom projects directory:
PROJECTS_DIR=/path/to/your/projects npm start
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

### 3. Start the Manager

```bash
npm start
```

The server will start on port 3000 by default. Access the web interface at:
- `http://localhost:3000` (local)
- `http://YOUR_IP:3000` (from other devices on your network)

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
2. If the repo has no `Start.sh`, generate one — a venv-safe launcher for Python projects, `npm install && npm start` for Node projects, or an editable placeholder otherwise
3. Rediscover projects so the new program appears immediately (existing config is backed up first)

Re-importing the same repository fast-forwards it (`git pull --ff-only`) instead of failing. If a scaffolded `Start.sh` was generated, review it — and set the right `PORT`/env — before starting the program. Cloning runs `git` directly with argument arrays (never a shell string) and validates the URL, so pasted URLs can't inject shell commands.

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

### Environment Variables

You can configure the server using these environment variables:

- `PORT`: Server port (default: 3000)
- `CONFIG_FILE`: Path to config file (default: ./config.json)
- `PROJECTS_DIR`: Auto-discover projects from this directory
- `MANAGER_API_TOKEN`: Optional API token for authentication

Example:
```bash
PORT=4000 CONFIG_FILE=./my-config.json npm start
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

The manager provides a REST API:

**Program Control:**
- `GET /api/programs` - List all programs and their status
- `POST /api/programs/:id/start` - Start a program
- `POST /api/programs/:id/stop` - Stop a program
- `POST /api/programs/:id/restart` - Restart a program
- `GET /api/programs/:id/logs` - Get program logs

**Program Management:**
- `POST /api/programs` - Add a new program (requires auth)
- `PUT /api/programs/:id` - Update a program (requires auth)
- `DELETE /api/programs/:id` - Remove a program (requires auth)

**Configuration:**
- `GET /api/config` - Get current configuration
- `POST /api/rediscover` - Rediscover projects and regenerate config (requires auth)
- `POST /api/import-repo` - Clone a git repo into the projects folder, scaffold a `Start.sh` if needed, and rediscover (requires auth). Body: `{ "repoUrl": "...", "branch": "optional", "name": "optional-folder-name" }`

**System:**
- `GET /api/stats` - Get statistics
- `GET /api/health` - Health check
- `POST /api/restart-manager` - Restart the manager process (requires auth)

### Authentication

If you set `MANAGER_API_TOKEN`, write operations require authentication:

```bash
# Using Authorization header
curl -H "Authorization: Bearer YOUR_TOKEN" \
  -X POST http://localhost:3000/api/programs/my-app/start

# Using query parameter
curl -X POST "http://localhost:3000/api/programs/my-app/start?token=YOUR_TOKEN"
```

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

1. Check your firewall settings - port 3000 needs to be accessible
2. Verify the server is listening on all interfaces (0.0.0.0)
3. Use the IP address shown in the console output when starting the manager

### WebSocket disconnecting?

- This is normal if the manager restarts
- The client will automatically reconnect within 3 seconds
- Check network connectivity if reconnection fails repeatedly

## Development

To run in development mode:

```bash
npm run dev
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

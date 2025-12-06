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
# Set PROJECTS_DIR to your projects folder
PROJECTS_DIR=/path/to/your/projects npm start
```

The manager will:
- Scan the directory for projects with `Start.sh` files
- Auto-generate `config.json` with intelligent defaults
- Detect framework types and PORT configurations
- Set up environment variables automatically

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
- Scans projects directory and regenerates config.json
- Automatically backs up existing config
- All changes take effect immediately

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

## API Endpoints

The manager provides a REST API:

- `GET /api/programs` - List all programs and their status
- `POST /api/programs/:id/start` - Start a program
- `POST /api/programs/:id/stop` - Stop a program
- `POST /api/programs/:id/restart` - Restart a program
- `GET /api/programs/:id/logs` - Get program logs
- `GET /api/config` - Get current configuration
- `GET /api/stats` - Get statistics
- `GET /api/health` - Health check
- `POST /api/rediscover` - Rediscover projects and regenerate config
- `POST /api/restart-manager` - Restart the manager process

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
- **Log Viewer**: View and search program logs in real-time
- **Search**: Quickly find programs by name, ID, path, or URL (Ctrl+F or Ctrl+K)
- **Responsive Design**: Works on desktop, tablet, and mobile devices

## Keyboard Shortcuts

- `Ctrl/Cmd + F` or `Ctrl/Cmd + K`: Focus search
- `Escape`: Clear search

## Troubleshooting

### Programs not starting?

1. Check that `Start.sh` exists and is executable:
   ```bash
   chmod +x /path/to/your/project/Start.sh
   ```

2. View the program logs in the web interface for error messages

3. Make sure the program's dependencies are installed

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

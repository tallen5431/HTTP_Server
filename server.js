#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const express = require('express');
const WebSocket = require('ws');

// Configuration
const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/jupyter-tj/projects'; // Default projects directory
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.MANAGER_API_TOKEN || null;

// Process registry
const processes = new Map();
const processLogs = new Map();

// Load configuration (cached with mtime check)
let cachedConfig = null;
let cachedConfigMtimeMs = null;

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      // If we have a cached config, keep using it even if the file disappears.
      if (cachedConfig) {
        return cachedConfig;
      }

      // Auto-discover projects if PROJECTS_DIR is set
      if (PROJECTS_DIR && fs.existsSync(PROJECTS_DIR)) {
        console.log(`\n🔍 Config file not found. Auto-discovering projects from: ${PROJECTS_DIR}`);
        try {
          const { discoverProjects, generateConfig } = require('./discover-projects');
          const projects = discoverProjects(PROJECTS_DIR);
          const autoConfig = generateConfig(projects);

          // Save the auto-generated config
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(autoConfig, null, 2), 'utf8');
          console.log(`✅ Auto-generated config.json with ${projects.length} project(s)\n`);

          cachedConfig = autoConfig;
          cachedConfigMtimeMs = null;
          return autoConfig;
        } catch (err) {
          console.error('❌ Auto-discovery failed:', err.message);
          console.log('   Falling back to empty config. You can manually create config.json\n');
        }
      }

      // Fallback default config so the UI can still start.
      const defaultConfig = {
        hostname: 'auto',
        programs: []
      };
      cachedConfig = defaultConfig;
      cachedConfigMtimeMs = null;
      return defaultConfig;
    }

    const stats = fs.statSync(CONFIG_FILE);
    if (!cachedConfig || stats.mtimeMs !== cachedConfigMtimeMs) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(data);
      validateConfig(config);
      cachedConfig = config;
      cachedConfigMtimeMs = stats.mtimeMs;
    }

    return cachedConfig;
  } catch (err) {
    console.error('Error loading config:', err.message);
    throw err;
  }
}

// Validate configuration
function validateConfig(config) {
  if (!config.programs || !Array.isArray(config.programs)) {
    throw new Error('Config must have a "programs" array');
  }

  const seenIds = new Set();

  config.programs.forEach((program, index) => {
    // Check required fields
    if (!program.id) {
      throw new Error(`Program at index ${index} is missing required field: "id"`);
    }
    if (!program.name) {
      throw new Error(`Program "${program.id}" is missing required field: "name"`);
    }
    if (!program.path) {
      throw new Error(`Program "${program.id}" is missing required field: "path"`);
    }

    // Check for duplicate IDs
    if (seenIds.has(program.id)) {
      throw new Error(`Duplicate program ID found: "${program.id}"`);
    }
    seenIds.add(program.id);

    // Ensure env object exists
    if (!program.env || typeof program.env !== 'object') {
      program.env = {};
    }

    // If url is provided but not a string, warn
    if (program.url && typeof program.url !== 'string') {
      console.warn(`Program "${program.id}" has a non-string url; this will be ignored.`);
      delete program.url;
    }
  });

  return true;
}

// Get primary network IP address
function getPrimaryIpAddress() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  // Prioritize common network interface names
  const preferredInterfaces = ['eth0', 'en0', 'wlan0'];

  for (const ifaceName of preferredInterfaces) {
    if (nets[ifaceName]) {
      for (const net of nets[ifaceName]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  }

  // Fallback: iterate through all interfaces
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }

  return 'localhost';
}

// Program management
function getProgramConfig(programId, config) {
  const program = config.programs.find(p => p.id === programId);
  if (!program) {
    throw new Error(`Program not found: ${programId}`);
  }
  return program;
}

function getProgramStatus(programId, config) {
  const program = config.programs.find(p => p.id === programId);
  if (!program) {
    return {
      id: programId,
      name: programId,
      status: 'missing',
      url: null,
      pid: null
    };
  }

  const proc = processes.get(programId);
  const isRunning = proc && !proc.killed;

  return {
    id: program.id,
    name: program.name,
    status: isRunning ? 'running' : 'stopped',
    url: generateProgramUrl(program, config),
    pid: isRunning ? proc.pid : null,
    uptime: isRunning && proc.spawnDate ? Date.now() - proc.spawnDate : 0
  };
}

function generateProgramUrl(program, config) {
  // If a URL is explicitly provided, use it
  if (program.url) {
    return program.url;
  }

  // Otherwise, attempt to generate from PORT
  const port = program.env && (program.env.PORT || program.env.port);
  if (port) {
    // Use configured hostname or auto-detected IP
    const hostname = (config && config.hostname && config.hostname !== 'auto')
      ? config.hostname
      : getPrimaryIpAddress();
    return `http://${hostname}:${port}`;
  }

  return null;
}

function getAllProgramsStatus(config) {
  return config.programs.map(p => getProgramStatus(p.id, config));
}

function getProgramLogs(programId, lines = 100) {
  const logs = processLogs.get(programId) || [];
  return logs.slice(-lines);
}

// WebSocket broadcast
const wsClients = new Set();

function broadcastStatus() {
  const config = loadConfig();
  const status = getAllProgramsStatus(config);
  const message = JSON.stringify({ type: 'status', data: status });

  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Express app
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Simple token-based authentication for write APIs.
// If MANAGER_API_TOKEN is not set, auth is effectively disabled and all requests are allowed.
function getRequestToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  if (req.query && typeof req.query.token === 'string') {
    return req.query.token;
  }
  if (req.body && typeof req.body.token === 'string') {
    return req.body.token;
  }
  return null;
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return next();
  }
  const token = getRequestToken(req);
  if (token === API_TOKEN) {
    return next();
  }
  res.status(401).json({ success: false, error: 'Unauthorized' });
}

// API Routes
app.get('/api/programs', (req, res) => {
  const config = loadConfig();
  const status = getAllProgramsStatus(config);
  res.json(status);
});

app.post('/api/programs/:id/start', requireApiToken, (req, res) => {
  try {
    const config = loadConfig();
    const result = startProgram(req.params.id, config);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/programs/:id/stop', requireApiToken, (req, res) => {
  try {
    const result = stopProgram(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/programs/:id/restart', requireApiToken, (req, res) => {
  try {
    const config = loadConfig();
    stopProgram(req.params.id);

    // Wait a bit before restarting
    setTimeout(() => {
      const result = startProgram(req.params.id, config);
      res.json({ success: true, data: result });
    }, 1000);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/programs/:id/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  const logs = getProgramLogs(req.params.id, lines);
  res.json(logs);
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const config = loadConfig();
  const programs = getAllProgramsStatus(config);

  const stats = {
    total: programs.length,
    running: programs.filter(p => p.status === 'running').length,
    stopped: programs.filter(p => p.status === 'stopped').length,
    uptime: programs
      .filter(p => p.status === 'running')
      .reduce((sum, p) => sum + (p.uptime || 0), 0)
  };

  res.json(stats);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Start programs and manage processes
function startProgram(programId, config) {
  const program = getProgramConfig(programId, config);
  const existingProcess = processes.get(programId);

  if (existingProcess && !existingProcess.killed) {
    throw new Error('Program is already running');
  }

  const startScript = path.join(program.path, 'Start.sh');

  if (!fs.existsSync(startScript)) {
    console.warn(`Start script not found for program: ${programId}`);
  }

  const env = {
    ...process.env,
    ...program.env
  };

  const proc = spawn('bash', [startScript], {
    cwd: program.path,
    env
  });

  const logs = [];
  processLogs.set(programId, logs);

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => {
      logs.push({ time: new Date().toISOString(), text: line });
      if (logs.length > 1000) {
        logs.shift();
      }
    });
    broadcastStatus();
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => {
      logs.push({ time: new Date().toISOString(), text: `[ERR] ${line}` });
      if (logs.length > 1000) {
        logs.shift();
      }
    });
    broadcastStatus();
  });

  proc.on('exit', (code) => {
    const line = `[system] Process exited with code ${code}`;
    logs.push({ time: new Date().toISOString(), text: line });
    broadcastStatus();
  });

  // Track spawn time for uptime calculation
  proc.spawnDate = Date.now();

  processes.set(programId, proc);

  return {
    id: programId,
    name: program.name,
    status: 'running',
    pid: proc.pid
  };
}

function stopProgram(programId) {
  const proc = processes.get(programId);
  if (!proc || proc.killed) {
    throw new Error('Program is not running');
  }

  proc.kill('SIGTERM');

  // Force kill after 10 seconds if still running
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 10000);

  return {
    id: programId,
    status: 'stopping'
  };
}

// Rediscover projects and regenerate config
app.post('/api/rediscover', requireApiToken, (req, res) => {
  console.log('[manager] Rediscovery requested via /api/rediscover');

  try {
    const projectsDir = req.body.projectsDir || PROJECTS_DIR;

    if (!projectsDir) {
      return res.status(400).json({
        success: false,
        error: 'No projects directory specified. Set PROJECTS_DIR environment variable or provide projectsDir in request body.'
      });
    }

    if (!fs.existsSync(projectsDir)) {
      return res.status(404).json({
        success: false,
        error: `Projects directory not found: ${projectsDir}`
      });
    }

    // Backup existing config
    if (fs.existsSync(CONFIG_FILE)) {
      const backupFile = CONFIG_FILE + '.backup.' + Date.now();
      fs.copyFileSync(CONFIG_FILE, backupFile);
      console.log(`[manager] Backed up config to: ${backupFile}`);
    }

    // Run discovery
    const { discoverProjects, generateConfig } = require('./discover-projects');
    const projects = discoverProjects(projectsDir);
    const newConfig = generateConfig(projects);

    // Save new config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    console.log(`[manager] Regenerated config with ${projects.length} project(s)`);

    // Clear cache to force reload
    cachedConfig = null;
    cachedConfigMtimeMs = null;

    res.json({
      success: true,
      message: `Rediscovered ${projects.length} project(s)`,
      projectCount: projects.length
    });

    // Broadcast updated status to all clients
    setTimeout(() => broadcastStatus(), 500);
  } catch (err) {
    console.error('[manager] Rediscovery failed:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Restart manager endpoint
app.post('/api/restart-manager', requireApiToken, (req, res) => {
  console.log('[manager] Restart requested via /api/restart-manager');

  res.json({
    success: true,
    message: 'HTTP Server Manager restarting…'
  });

  // Give the HTTP response a moment to flush, then exit.
  setTimeout(() => {
    console.log('[manager] Exiting process for restart');
    process.exit(0);
  }, 1000);
});

// Config editing endpoints
app.put('/api/programs/:id', requireApiToken, (req, res) => {
  try {
    const programId = req.params.id;
    const updates = req.body;

    console.log(`[manager] Updating program: ${programId}`);

    const config = loadConfig();
    const programIndex = config.programs.findIndex(p => p.id === programId);

    if (programIndex === -1) {
      return res.status(404).json({
        success: false,
        error: `Program not found: ${programId}`
      });
    }

    // Update program with new values
    const program = config.programs[programIndex];
    if (updates.name !== undefined) program.name = updates.name;
    if (updates.path !== undefined) program.path = updates.path;
    if (updates.url !== undefined) program.url = updates.url;
    if (updates.env !== undefined) program.env = updates.env;

    // Validate the updated config
    validateConfig(config);

    // Backup existing config
    if (fs.existsSync(CONFIG_FILE)) {
      const backupFile = CONFIG_FILE + '.backup.' + Date.now();
      fs.copyFileSync(CONFIG_FILE, backupFile);
    }

    // Save updated config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[manager] Updated program: ${programId}`);

    // Clear cache
    cachedConfig = null;
    cachedConfigMtimeMs = null;

    res.json({
      success: true,
      message: `Program ${programId} updated successfully`
    });

    // Broadcast updated status
    setTimeout(() => broadcastStatus(), 500);
  } catch (err) {
    console.error('[manager] Failed to update program:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/programs', requireApiToken, (req, res) => {
  try {
    const newProgram = req.body;

    console.log(`[manager] Adding new program: ${newProgram.id}`);

    // Validate required fields
    if (!newProgram.id || !newProgram.name || !newProgram.path) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, name, path'
      });
    }

    const config = loadConfig();

    // Check for duplicate ID
    if (config.programs.find(p => p.id === newProgram.id)) {
      return res.status(400).json({
        success: false,
        error: `Program with ID "${newProgram.id}" already exists`
      });
    }

    // Ensure env object exists
    if (!newProgram.env) {
      newProgram.env = {};
    }

    // Add new program
    config.programs.push(newProgram);

    // Validate the updated config
    validateConfig(config);

    // Backup existing config
    if (fs.existsSync(CONFIG_FILE)) {
      const backupFile = CONFIG_FILE + '.backup.' + Date.now();
      fs.copyFileSync(CONFIG_FILE, backupFile);
    }

    // Save updated config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[manager] Added new program: ${newProgram.id}`);

    // Clear cache
    cachedConfig = null;
    cachedConfigMtimeMs = null;

    res.json({
      success: true,
      message: `Program ${newProgram.id} added successfully`,
      program: newProgram
    });

    // Broadcast updated status
    setTimeout(() => broadcastStatus(), 500);
  } catch (err) {
    console.error('[manager] Failed to add program:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.delete('/api/programs/:id', requireApiToken, (req, res) => {
  try {
    const programId = req.params.id;

    console.log(`[manager] Removing program: ${programId}`);

    const config = loadConfig();
    const programIndex = config.programs.findIndex(p => p.id === programId);

    if (programIndex === -1) {
      return res.status(404).json({
        success: false,
        error: `Program not found: ${programId}`
      });
    }

    // Stop the program if it's running
    const proc = processes.get(programId);
    if (proc && !proc.killed) {
      console.log(`[manager] Stopping program before removal: ${programId}`);
      proc.kill('SIGTERM');
    }

    // Remove from config
    config.programs.splice(programIndex, 1);

    // Backup existing config
    if (fs.existsSync(CONFIG_FILE)) {
      const backupFile = CONFIG_FILE + '.backup.' + Date.now();
      fs.copyFileSync(CONFIG_FILE, backupFile);
    }

    // Save updated config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[manager] Removed program: ${programId}`);

    // Clear cache
    cachedConfig = null;
    cachedConfigMtimeMs = null;

    // Clean up process logs
    processLogs.delete(programId);
    processes.delete(programId);

    res.json({
      success: true,
      message: `Program ${programId} removed successfully`
    });

    // Broadcast updated status
    setTimeout(() => broadcastStatus(), 500);
  } catch (err) {
    console.error('[manager] Failed to remove program:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Start server
async function startServer() {
  const config = loadConfig();

  console.log('HTTP Server Manager');
  console.log('==================');

  const server = http.createServer(app);
  console.log('✓ Running in HTTP mode');

  // WebSocket server
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    // Optional auth: require MANAGER_API_TOKEN for WebSocket clients when set.
    if (API_TOKEN) {
      try {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');
        if (token !== API_TOKEN) {
          ws.close(1008, 'Unauthorized');
          return;
        }
      } catch (err) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    wsClients.add(ws);
    console.log('WebSocket client connected');

    // Send initial status with the latest config
    const status = getAllProgramsStatus(loadConfig());
    ws.send(JSON.stringify({ type: 'status', data: status }));

    ws.on('close', () => {
      wsClients.delete(ws);
      console.log('WebSocket client disconnected');
    });
  });

  server.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    const activeConfig = loadConfig();
    console.log(`✓ Loaded ${activeConfig.programs.length} program(s)`);
    console.log('\nAccess the web interface at:');
    console.log(`  http://localhost:${PORT}`);

    // Get local IP addresses
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();

    Object.keys(nets).forEach((name) => {
      nets[name].forEach((net) => {
        // Skip internal and non-IPv4
        if (net.internal || net.family !== 'IPv4') return;

        console.log(`  http://${net.address}:${PORT}`);
      });
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down server...');

    server.close(() => {
      console.log('Server stopped');
      process.exit(0);
    });

    // Kill all running child processes
    for (const [id, proc] of processes.entries()) {
      if (!proc.killed) {
        console.log(`Stopping ${id}...`);
        proc.kill('SIGTERM');
      }
    }
  });
}

// Start the server
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

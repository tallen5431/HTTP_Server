#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const express = require('express');
const WebSocket = require('ws');

// Configuration
const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/opt/http-server-manager/projects';
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.MANAGER_API_TOKEN || null;

function getBundledVoskTranscriberProgram() {
  const programPath = path.join(__dirname, 'examples', 'vosk-transcriber');
  return {
    id: 'vosk-transcriber',
    name: 'Vosk Voice Transcriber',
    path: programPath,
    env: {
      HOST: '0.0.0.0',
      PORT: '8090',
      VOSK_MODEL_PATH: path.join(programPath, 'model')
    },
    urlProtocol: 'https',
    preferTailscale: true,
    omitPortInUrl: true,
    comment: 'Bundled sample card for local voice transcription with a Vosk model. Install requirements and place a model at VOSK_MODEL_PATH before starting.'
  };
}

function getBundledQwenSystemAssistantProgram() {
  const programPath = path.join(__dirname, 'examples', 'qwen-system-assistant');
  return {
    id: 'qwen-system-assistant',
    name: 'Qwen System Assistant',
    path: programPath,
    env: {
      HOST: '0.0.0.0',
      PORT: '8091',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      OLLAMA_MODEL: 'qwen2.5-coder:1.5b',
      OLLAMA_NUM_CTX: '4096',
      OLLAMA_NUM_PREDICT: '512'
    },
    comment: 'Bundled local AI assistant card. Connects to Ollama qwen2.5-coder:1.5b and gathers read-only Linux system context for analysis.'
  };
}

function isQwenSystemAssistantProgram(program) {
  return program && (
    program.id === 'qwen-system-assistant' ||
    /qwen system assistant/i.test(program.name || '') ||
    /qwen-system-assistant/.test(program.path || '')
  );
}

function ensureBundledPrograms(config) {
  if (!config.programs.some(program => isVoskProgram(program))) {
    config.programs.push(getBundledVoskTranscriberProgram());
  }
  if (!config.programs.some(program => isQwenSystemAssistantProgram(program))) {
    config.programs.push(getBundledQwenSystemAssistantProgram());
  }
  return config;
}

function ensureBundledVoskProgram(config) {
  if (!config.programs.some(program => isVoskProgram(program))) {
    config.programs.push(getBundledVoskTranscriberProgram());
  }
  return config;
}

function mergeExistingProgramUrlOptions(newProgram, existingProgram) {
  if (!existingProgram) return;

  const urlOptionKeys = [
    'url',
    'urlProtocol',
    'hostname',
    'host',
    'preferTailscale',
    'omitPortInUrl'
  ];

  for (const key of urlOptionKeys) {
    if (existingProgram[key] !== undefined && newProgram[key] === undefined) {
      newProgram[key] = existingProgram[key];
    }
  }
}

function preserveExistingProgramUrlOptions(newConfig, existingConfig) {
  if (!existingConfig || !Array.isArray(existingConfig.programs)) {
    return newConfig;
  }

  for (const newProgram of newConfig.programs) {
    const existingProgram = existingConfig.programs.find(program =>
      program.id === newProgram.id ||
      (isVoskProgram(program) && isVoskProgram(newProgram))
    );
    mergeExistingProgramUrlOptions(newProgram, existingProgram);
  }

  return newConfig;
}

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
          const autoConfig = ensureBundledPrograms(generateConfig(projects));

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
        programs: [getBundledVoskTranscriberProgram(), getBundledQwenSystemAssistantProgram()]
      };
      cachedConfig = defaultConfig;
      cachedConfigMtimeMs = null;
      return defaultConfig;
    }

    const stats = fs.statSync(CONFIG_FILE);
    if (!cachedConfig || stats.mtimeMs !== cachedConfigMtimeMs) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = ensureBundledPrograms(JSON.parse(data));
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


function isVoskProgram(program) {
  return program && (
    program.id === 'vosk-transcriber' ||
    /vosk/i.test(program.name || '') ||
    /vosk-transcriber/.test(program.path || '')
  );
}

function applyDefaultProgramUrlOptions(program) {
  // Keep existing user-provided values, but make legacy Vosk entries generate
  // the intended Tailscale HTTPS card URL even when config.json predates these
  // options and was not copied from config.example.json.
  if (isVoskProgram(program) && !program.url) {
    if (program.urlProtocol === undefined) program.urlProtocol = 'https';
    if (program.preferTailscale === undefined) program.preferTailscale = true;
    if (program.omitPortInUrl === undefined) program.omitPortInUrl = true;
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

    applyDefaultProgramUrlOptions(program);
  });

  return true;
}

// Get the current machine's Tailscale HTTPS hostname when available.
function getTailscaleHostname(config) {
  const configuredHostname = config && (config.tailscaleHostname || config.tailscaleHost);
  if (configuredHostname && configuredHostname !== 'auto') {
    return String(configuredHostname).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }

  const envHostname = process.env.TAILSCALE_HOSTNAME || process.env.TS_CERT_DOMAIN;
  if (envHostname) {
    return envHostname.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }

  try {
    const status = JSON.parse(execSync('tailscale status --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const dnsName = status && status.Self && status.Self.DNSName;
    if (dnsName) {
      return dnsName.replace(/\.$/, '');
    }
  } catch (err) {
    // Tailscale is optional; fall back to the normal hostname/IP path below.
  }

  return null;
}


function stripPortFromHost(host) {
  return String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/:\d+$/, '');
}

function getRequestUrlContext(req) {
  if (!req || !req.headers) return null;

  const forwardedHost = req.headers['x-forwarded-host'];
  const hostHeader = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.headers.host || '');
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocolHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = (protocolHeader || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const hostname = stripPortFromHost(String(hostHeader).split(',')[0].trim());

  if (!hostname) return null;

  return { hostname, protocol };
}

// Get primary network IP address
function getPrimaryIpAddress() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  // Prioritize Tailscale, then common LAN interfaces
  const preferredInterfaces = ['tailscale0', 'eth0', 'en0', 'wlan0'];

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


function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.startsWith('127.');
}

function isTailscaleDnsHostname(hostname) {
  return /\.ts\.net$/i.test(String(hostname || ''));
}

function getProgramStatus(programId, config, urlContext = null) {
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
  const isRunning = proc && proc.isRunning;

  return {
    id: program.id,
    name: program.name,
    status: isRunning ? 'running' : 'stopped',
    url: generateProgramUrl(program, config, proc && proc.actualPort, urlContext),
    pid: isRunning ? proc.pid : null,
    uptime: isRunning && proc.spawnDate ? Date.now() - proc.spawnDate : 0
  };
}

function generateProgramUrl(program, config, runtimePort = null, urlContext = null) {
  // If a URL is explicitly provided, use it
  if (program.url) {
    return program.url;
  }

  // Otherwise, attempt to generate from PORT
  const port = runtimePort || (program.env && (program.env.PORT || program.env.port));
  if (port) {
    const preferTailscale = program.preferTailscale || (config && config.preferTailscale);
    const requestHostname = urlContext && urlContext.hostname;
    const requestProtocol = urlContext && urlContext.protocol;
    const protocol = program.urlProtocol || (preferTailscale && requestProtocol === 'https' ? 'https' : null) || (config && config.urlProtocol) || 'http';
    const programHostname = program.hostname || program.host;
    const configuredHostname = programHostname || (config && config.hostname);
    const tailscaleHostname = preferTailscale ? getTailscaleHostname(config) : null;

    // If a browser reached the manager through a public HTTPS/Tailscale host,
    // use that same host for Tailscale-preferred program cards. This covers
    // systems where the tailscale CLI/env hostname is unavailable to Node and
    // prevents WebSocket status refreshes from reverting cards to local IPs.
    const requestIsPublicHttps = requestHostname &&
      !isLoopbackHostname(requestHostname) &&
      (requestProtocol === 'https' || isTailscaleDnsHostname(requestHostname));
    const requestPublicHostname = preferTailscale && requestIsPublicHttps
      ? requestHostname
      : null;

    // Use program/config hostname when provided, otherwise prefer the request's
    // public host, then Tailscale MagicDNS, then the primary local/LAN address.
    const hostname = (configuredHostname && configuredHostname !== 'auto')
      ? configuredHostname
      : (requestPublicHostname || tailscaleHostname || getPrimaryIpAddress());

    const cleanHostname = String(hostname).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const shouldOmitPort = Boolean(program.omitPortInUrl || (config && config.omitPortInUrl));
    const portSegment = shouldOmitPort ? '' : `:${port}`;

    return `${protocol}://${cleanHostname}${portSegment}`;
  }

  return null;
}

function getAllProgramsStatus(config, urlContext = null) {
  return config.programs.map(p => getProgramStatus(p.id, config, urlContext));
}

function getProgramLogs(programId, lines = 100) {
  const logs = processLogs.get(programId) || [];
  return logs.slice(-lines);
}

function appendProgramLog(programId, text) {
  const logs = processLogs.get(programId) || [];
  logs.push({ time: new Date().toISOString(), text });
  while (logs.length > 1000) {
    logs.shift();
  }
  processLogs.set(programId, logs);
}

// WebSocket broadcast
const wsClients = new Set();

function broadcastStatus() {
  const config = loadConfig();

  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const status = getAllProgramsStatus(config, client.urlContext || null);
      const message = JSON.stringify({ type: 'status', data: status });
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
  const status = getAllProgramsStatus(config, getRequestUrlContext(req));
  res.json(status);
});

app.post('/api/programs/:id/start', requireApiToken, (req, res) => {
  try {
    const config = loadConfig();
    const result = startProgram(req.params.id, config);
    res.json({ success: true, data: result });
  } catch (err) {
    appendProgramLog(req.params.id, `[system] Start failed: ${err.message}`);
    broadcastStatus();
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/programs/:id/stop', requireApiToken, (req, res) => {
  try {
    const result = stopProgram(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    appendProgramLog(req.params.id, `[system] Stop failed: ${err.message}`);
    broadcastStatus();
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/programs/:id/restart', requireApiToken, (req, res) => {
  try {
    const programId = req.params.id;
    const config = loadConfig();

    stopProgram(programId);

    // Wait a bit for the process to fully exit before restarting
    setTimeout(() => {
      try {
        const result = startProgram(programId, config);
        res.json({ success: true, data: result });
      } catch (startErr) {
        appendProgramLog(programId, `[system] Restart failed: ${startErr.message}`);
        broadcastStatus();
        res.status(500).json({ success: false, error: `Restart failed: ${startErr.message}` });
      }
    }, 1500);
  } catch (err) {
    appendProgramLog(req.params.id, `[system] Restart failed: ${err.message}`);
    broadcastStatus();
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
  res.json({ ...config, projectsDir: PROJECTS_DIR });
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

function parseListeningPortFromLog(line) {
  const match = String(line).match(/listening\s+on\s+https?:\/\/[^:\s]+:(\d+)/i);
  return match ? match[1] : null;
}

// Start programs and manage processes
function startProgram(programId, config) {
  const program = getProgramConfig(programId, config);
  const existingProcess = processes.get(programId);

  // Clean up exited processes before starting
  if (existingProcess && !existingProcess.isRunning) {
    processes.delete(programId);
  } else if (existingProcess && existingProcess.isRunning) {
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
      const actualPort = parseListeningPortFromLog(line);
      if (actualPort) {
        proc.actualPort = actualPort;
      }
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

  proc.on('error', (err) => {
    appendProgramLog(programId, `[system] Process failed to start: ${err.message}`);
    proc.isRunning = false;
    processes.delete(programId);
    broadcastStatus();
  });

  proc.on('exit', (code) => {
    const line = `[system] Process exited with code ${code}`;
    logs.push({ time: new Date().toISOString(), text: line });

    // Mark as no longer running and clean up the registry
    proc.isRunning = false;
    processes.delete(programId);

    broadcastStatus();
  });

  // Track liveness explicitly (proc.killed only reflects signal delivery,
  // not actual process exit) and spawn time for uptime calculation.
  proc.isRunning = true;
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
  if (!proc || !proc.isRunning) {
    throw new Error('Program is not running');
  }

  proc.kill('SIGTERM');

  // Force kill after 10 seconds if it hasn't exited yet
  setTimeout(() => {
    if (proc.isRunning) {
      proc.kill('SIGKILL');
    }
  }, 10000);

  return {
    id: programId,
    status: 'stopping'
  };
}

// Browse a directory and return discovered projects (without modifying config)
app.get('/api/browse-projects', (req, res) => {
  const dir = req.query.dir || PROJECTS_DIR;

  if (!dir) {
    return res.status(400).json({ success: false, error: 'No directory specified' });
  }

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ success: false, error: `Directory not found: ${dir}` });
  }

  try {
    const { parseStartScript, discoverProjects } = require('./discover-projects');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(dir, entry.name);
      const startScriptPath = path.join(projectPath, 'Start.sh');
      if (!fs.existsSync(startScriptPath)) continue;

      const { env } = parseStartScript(startScriptPath);
      if (!env.HOST) env.HOST = '0.0.0.0';

      // Build display name from folder name
      const displayName = entry.name
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      const id = entry.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      // Check if already in config
      const config = loadConfig();
      const alreadyAdded = config.programs.some(p => p.path === projectPath);

      results.push({ id, name: displayName, path: projectPath, env, alreadyAdded });
    }

    res.json({ success: true, projects: results, dir });
  } catch (err) {
    console.error('[manager] Browse projects failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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

    const existingConfig = fs.existsSync(CONFIG_FILE) ? loadConfig() : null;

    // Backup existing config
    if (fs.existsSync(CONFIG_FILE)) {
      const backupFile = CONFIG_FILE + '.backup.' + Date.now();
      fs.copyFileSync(CONFIG_FILE, backupFile);
      console.log(`[manager] Backed up config to: ${backupFile}`);
    }

    // Run discovery
    const { discoverProjects, generateConfig } = require('./discover-projects');
    const projects = discoverProjects(projectsDir);
    const newConfig = ensureBundledPrograms(
      preserveExistingProgramUrlOptions(generateConfig(projects), existingConfig)
    );
    validateConfig(newConfig);

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
    if (proc && proc.isRunning) {
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

    ws.urlContext = getRequestUrlContext(req);
    wsClients.add(ws);
    console.log('WebSocket client connected');

    // Send initial status with the latest config using this client's public host.
    const status = getAllProgramsStatus(loadConfig(), ws.urlContext);
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
      if (proc.isRunning) {
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

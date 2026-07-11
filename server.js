#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const express = require('express');
const WebSocket = require('ws');

// Configuration
const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';
// Default the projects directory to a `projects/` folder next to this manager
// install, so Rediscover and Import always target a path that exists wherever the
// manager is checked out (override with the PROJECTS_DIR environment variable).
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(__dirname, 'projects');
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.MANAGER_API_TOKEN || null;

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
      program.id === newProgram.id
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

      // Fallback empty config so the UI can still start. Add programs by
      // dropping them into PROJECTS_DIR and hitting Rediscover, or Import from Git.
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

// Keep at most this many config.json.backup.* files so they don't pile up.
const MAX_CONFIG_BACKUPS = 5;

// Back up the current config (if any) to config.json.backup.<timestamp>, then
// prune the oldest backups beyond MAX_CONFIG_BACKUPS. Returns the backup path,
// or null when there was nothing to back up.
function backupConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }

  const backupFile = `${CONFIG_FILE}.backup.${Date.now()}`;
  fs.copyFileSync(CONFIG_FILE, backupFile);

  // Prune old backups, keeping the most recent MAX_CONFIG_BACKUPS.
  try {
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE) + '.backup.';
    const backups = fs.readdirSync(dir)
      .filter(name => name.startsWith(base))
      .sort(); // timestamp suffix sorts chronologically
    const excess = backups.length - MAX_CONFIG_BACKUPS;
    for (let i = 0; i < excess; i++) {
      fs.unlinkSync(path.join(dir, backups[i]));
    }
  } catch (err) {
    console.warn(`[manager] Could not prune old config backups: ${err.message}`);
  }

  return backupFile;
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

    // Validate autostart if present (should be boolean)
    if (program.autostart !== undefined && typeof program.autostart !== 'boolean') {
      console.warn(`Program "${program.id}" has a non-boolean autostart; this will be ignored.`);
      delete program.autostart;
    }
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

  // Tailscale first (its address is reachable from anywhere the tailnet spans).
  if (nets['tailscale0']) {
    for (const net of nets['tailscale0']) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }

  // Otherwise the best LAN address — wired preferred over Wi-Fi (see
  // getLanIpAddress) — falling back to localhost if nothing qualifies.
  return getLanIpAddress() || 'localhost';
}

// Tailscale hands out addresses in the 100.64.0.0/10 CGNAT range (second octet
// 64–127). Used to tell a Tailscale address apart from a normal LAN address.
function isTailscaleIpv4(address) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(address || ''));
}

// The machine's Tailscale IPv4 (e.g. 100.92.90.118), or null if Tailscale is
// not up. Reads the tailscale0 interface first, then falls back to scanning for
// any CGNAT-range address.
function getTailscaleIpAddress() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  if (nets['tailscale0']) {
    for (const net of nets['tailscale0']) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && isTailscaleIpv4(net.address)) {
        return net.address;
      }
    }
  }

  return null;
}

// Classify an interface name so we can prefer the address other LAN devices can
// actually reach us on. Wired Ethernet (en*/eth*) beats Wi-Fi (wl*), and both
// beat virtual bridges (docker/veth/virbr/tun…). This matters when a machine is
// on Wi-Fi AND Ethernet at once: some routers isolate Wi-Fi clients from each
// other, so the wired address is the reachable one and must win.
function isVirtualInterface(name) {
  return /^(docker|br-|veth|virbr|vmnet|vboxnet|zt|utun|llw|awdl|tun|tap)/i.test(name);
}

function rankLanInterface(name) {
  if (/^(en|eth)/i.test(name)) return 3;   // wired ethernet (eth0, en0, enp3s0, eno1…)
  if (/^wl/i.test(name)) return 2;          // wireless (wlan0, wlp1s0…)
  if (isVirtualInterface(name)) return 0;   // docker/vm/tunnel bridges — last resort
  return 1;                                 // anything else
}

// The machine's primary LAN IPv4 (e.g. 192.168.1.199), excluding Tailscale.
// This is the address other devices on the same home/office network use. When
// several interfaces qualify (e.g. Wi-Fi + Ethernet), the highest-ranked one
// wins so we advertise the wired, reachable address rather than the first found.
function getLanIpAddress() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  let best = null;
  let bestRank = -1;
  for (const name of Object.keys(nets)) {
    if (name === 'tailscale0') continue;
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (isTailscaleIpv4(net.address)) continue;
      const r = rankLanInterface(name);
      if (r > bestRank) {
        bestRank = r;
        best = net.address;
      }
    }
  }

  return best;
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
    urls: generateProgramUrls(program, config, proc && proc.actualPort),
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

// Build the full set of addresses a program can be reached at — typically a
// Local (LAN) URL and a Tailscale URL — so the UI can show both instead of
// guessing one. Returns an array of { label, url, kind }. An explicit
// program.url override collapses this to a single entry.
function generateProgramUrls(program, config, runtimePort = null) {
  if (program.url) {
    return [{ label: 'URL', url: program.url, kind: 'custom' }];
  }

  const port = runtimePort || (program.env && (program.env.PORT || program.env.port));
  if (!port) return [];

  const protocol = program.urlProtocol || (config && config.urlProtocol) || 'http';
  const shouldOmitPort = Boolean(program.omitPortInUrl || (config && config.omitPortInUrl));
  const portSegment = shouldOmitPort ? '' : `:${port}`;

  const urls = [];
  const seen = new Set();
  const add = (label, kind, host) => {
    const clean = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!clean || isLoopbackHostname(clean)) return;
    const url = `${protocol}://${clean}${portSegment}`;
    if (seen.has(url)) return;
    seen.add(url);
    urls.push({ label, url, kind });
  };

  // A configured, non-"auto" hostname (per-program or global) is the operator's
  // explicit choice — list it first.
  const configuredHostname = program.hostname || program.host || (config && config.hostname);
  if (configuredHostname && configuredHostname !== 'auto') {
    add('Custom', 'configured', configuredHostname);
  }

  // Local LAN address — what other devices on the same Wi-Fi/Ethernet use.
  add('Local', 'local', getLanIpAddress());

  // Remote access over Tailscale — prefer the MagicDNS name, else the 100.x IP.
  add('Tailscale', 'tailscale', getTailscaleHostname(config) || getTailscaleIpAddress());

  return urls;
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
    throw new Error(`Start.sh not found at ${startScript}`);
  }

  const env = {
    ...process.env,
    ...program.env
  };

  // detached:true makes the child its own process-group leader so we can later
  // signal the WHOLE group (see signalProcessTree). Many Start.sh scripts don't
  // exec their app — "npm start" forks node, a bare "python app.py" forks python —
  // so killing only bash would orphan the real process and leave its port bound.
  const proc = spawn('bash', [startScript], {
    cwd: program.path,
    env,
    detached: true
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

// Signal the child's entire process group (negative PID). Because programs are
// spawned detached, the bash child leads its own group, so this reaches whatever
// the Start.sh forked (node under npm, python, a waitress worker…) instead of
// leaving it orphaned and holding the port. Falls back to signalling just the
// child, and swallows ESRCH when the group is already gone.
function signalProcessTree(proc, signal) {
  if (!proc || proc.pid == null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch (err) {
    try { proc.kill(signal); } catch (_) { /* already exited */ }
  }
}

function stopProgram(programId) {
  const proc = processes.get(programId);
  if (!proc || !proc.isRunning) {
    throw new Error('Program is not running');
  }

  signalProcessTree(proc, 'SIGTERM');

  // Force kill the whole group after 10 seconds if it hasn't exited yet
  setTimeout(() => {
    if (proc.isRunning) {
      signalProcessTree(proc, 'SIGKILL');
    }
  }, 10000);

  return {
    id: programId,
    status: 'stopping'
  };
}

// Launch all programs marked with autostart: true
function launchAutostart(config) {
  if (!config || !Array.isArray(config.programs)) return;

  const autostartPrograms = config.programs.filter(p => p.autostart === true);
  if (autostartPrograms.length === 0) return;

  console.log(`\n📦 Autostarting ${autostartPrograms.length} program(s)...`);
  autostartPrograms.forEach(program => {
    try {
      const result = startProgram(program.id, config);
      console.log(`  ✓ ${program.name} (${program.id}) started [PID ${result.pid}]`);
    } catch (err) {
      console.error(`  ✗ ${program.name} (${program.id}) failed to start: ${err.message}`);
    }
  });
  console.log();
}

// Browse a directory and return discovered projects (without modifying config)
// ---------------------------------------------------------------------------
// Project import / discovery helpers
// ---------------------------------------------------------------------------

// Regenerate config.json from a projects directory, preserving per-program URL
// overrides for programs matched by ID. Shared by /api/rediscover and /api/import-repo.
function runRediscovery(projectsDir) {
  if (!projectsDir) {
    throw new Error('No projects directory specified. Set PROJECTS_DIR or pass projectsDir.');
  }
  if (!fs.existsSync(projectsDir)) {
    throw new Error(`Projects directory not found: ${projectsDir}`);
  }

  const existingConfig = fs.existsSync(CONFIG_FILE) ? loadConfig() : null;

  // Backup existing config before we overwrite it.
  const backupFile = backupConfigFile();
  if (backupFile) {
    console.log(`[manager] Backed up config to: ${backupFile}`);
  }

  const { discoverProjects, generateConfig } = require('./discover-projects');
  const projects = discoverProjects(projectsDir);
  const newConfig = preserveExistingProgramUrlOptions(generateConfig(projects), existingConfig);
  validateConfig(newConfig);

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
  console.log(`[manager] Regenerated config with ${projects.length} project(s)`);

  // Clear cache so the next read reloads.
  cachedConfig = null;
  cachedConfigMtimeMs = null;

  return projects;
}

// Derive a safe folder name from a git URL (or an explicit override).
function deriveRepoFolderName(repoUrl, override) {
  let name = (override || '').trim();
  if (!name) {
    // Strip query/fragment and trailing slashes, drop a ".git" suffix, then take
    // the last path segment. Handles both URL and scp-like (git@host:owner/repo).
    let u = String(repoUrl || '').trim().replace(/[#?].*$/, '').replace(/\/+$/, '');
    u = u.replace(/\.git$/i, '');
    name = u.split(/[/:]/).filter(Boolean).pop() || '';
  }
  // Sanitize to a safe directory name.
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

// Basic allowlist validation so we never hand arbitrary/option-like strings to git.
// Returns an error message string, or null when the URL looks acceptable.
function validateGitUrl(repoUrl) {
  const url = String(repoUrl || '').trim();
  if (!url) return 'Repository URL is required.';
  if (url.startsWith('-')) return 'Invalid repository URL.';
  const ok =
    /^https?:\/\/\S+$/i.test(url) ||
    /^git:\/\/\S+$/i.test(url) ||
    /^ssh:\/\/\S+$/i.test(url) ||
    /^[a-z0-9._-]+@[a-z0-9._-]+:\S+$/i.test(url); // scp-like git@host:owner/repo
  if (!ok) {
    return 'Unsupported repository URL. Use https://, git://, ssh://, or git@host:owner/repo.';
  }
  return null;
}

// Clone (or, if the folder is already a git repo, fast-forward) a repository into
// destPath. Uses spawn with an args array (never a shell string) to avoid command
// injection, and enforces a timeout so a hung clone can't wedge the manager.
function cloneOrUpdateRepo(repoUrl, destPath, branch) {
  return new Promise((resolve, reject) => {
    const exists = fs.existsSync(destPath);
    const isGitRepo = exists && fs.existsSync(path.join(destPath, '.git'));

    if (exists && !isGitRepo) {
      return reject(new Error(
        `A non-git folder already exists at ${destPath}. Remove it or choose a different name.`
      ));
    }

    let args;
    if (isGitRepo) {
      args = ['-C', destPath, 'pull', '--ff-only'];
    } else {
      args = ['clone', '--depth', '1'];
      if (branch) args.push('--branch', branch);
      args.push('--', repoUrl, destPath);
    }

    const git = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    let out = '';
    git.stdout.on('data', d => { out += d.toString(); });
    git.stderr.on('data', d => { out += d.toString(); });

    const timer = setTimeout(() => {
      git.kill('SIGKILL');
      reject(new Error('git operation timed out after 180s.'));
    }, 180000);

    git.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to run git: ${err.message}. Is git installed?`));
    });

    git.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ updated: isGitRepo, output: out.trim() });
      } else {
        reject(new Error(`git exited with code ${code}: ${out.trim().slice(-500)}`));
      }
    });
  });
}

// If a freshly cloned project has no Start.sh, scaffold a sensible one so the
// manager can launch it. Detection mirrors discover-projects.js (Node vs Python
// vs generic). The Python variant uses a venv-safe launcher pattern.
function scaffoldStartScript(projectPath) {
  const startPath = path.join(projectPath, 'Start.sh');
  if (fs.existsSync(startPath)) {
    return { created: false };
  }

  const has = (f) => fs.existsSync(path.join(projectPath, f));
  let body;
  let kind;

  if (has('package.json')) {
    kind = 'node';
    body = [
      '#!/usr/bin/env bash',
      '# Auto-generated by HTTP Server Manager on import. Edit as needed.',
      'set -euo pipefail',
      'cd "$(dirname "${BASH_SOURCE[0]}")"',
      '',
      'export HOST="${HOST:-0.0.0.0}"',
      '# Default off 3000 — that is the manager\'s own port. Change to suit your app.',
      'export PORT="${PORT:-8080}"',
      '',
      '[ -d node_modules ] || npm install',
      'npm start',
      ''
    ].join('\n');
  } else if (has('requirements.txt') || has('app.py') || has('run.py') || has('main.py')) {
    kind = 'python';
    const entry = has('app.py') ? 'app.py'
      : has('run.py') ? 'run.py'
      : has('main.py') ? 'main.py'
      : 'app.py';
    body = [
      '#!/usr/bin/env bash',
      '# Auto-generated by HTTP Server Manager on import. Edit as needed.',
      'set -euo pipefail',
      'APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'cd "$APP_DIR"',
      '',
      'VENV_PY="$APP_DIR/.venv/bin/python"',
      'if [[ ! -x "$VENV_PY" ]]; then',
      '  SYS_PY="$(command -v python3 || true)"',
      '  [[ -n "$SYS_PY" ]] || { echo "[ERROR] python3 not found"; exit 1; }',
      '  echo "[SETUP] Creating virtualenv at .venv..."',
      '  "$SYS_PY" -m venv "$APP_DIR/.venv"',
      'fi',
      '',
      'if [[ -f requirements.txt ]]; then',
      '  echo "[SETUP] Installing requirements..."',
      '  "$VENV_PY" -m pip install --upgrade pip >/dev/null',
      '  "$VENV_PY" -m pip install -r requirements.txt',
      'fi',
      '',
      'export HOST="${HOST:-0.0.0.0}"',
      'export PORT="${PORT:-8000}"',
      '',
      `echo "[RUN] Starting ${entry} (HOST=$HOST PORT=$PORT)"`,
      `exec "$VENV_PY" "${entry}"`,
      ''
    ].join('\n');
  } else {
    kind = 'placeholder';
    body = [
      '#!/usr/bin/env bash',
      '# Auto-generated placeholder — EDIT THIS before starting the program.',
      '# The manager could not detect how to launch this project. Replace the',
      '# command below with the one that starts your app, and set PORT to the',
      '# port it listens on.',
      'set -euo pipefail',
      'cd "$(dirname "${BASH_SOURCE[0]}")"',
      '',
      'export HOST="${HOST:-0.0.0.0}"',
      'export PORT="${PORT:-8080}"',
      '',
      'echo "[manager] Start.sh for this project is not configured yet." >&2',
      'echo "[manager] Edit $(pwd)/Start.sh to launch your app." >&2',
      'exit 1',
      ''
    ].join('\n');
  }

  fs.writeFileSync(startPath, body, { mode: 0o755 });
  return { created: true, kind };
}

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
    const projects = runRediscovery(projectsDir);

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

// Import a program from a git repository: clone it into the projects folder,
// scaffold a Start.sh if the repo doesn't ship one, then rediscover so it shows
// up in the manager. Cloning uses spawn(git, [...]) — never a shell string.
app.post('/api/import-repo', requireApiToken, async (req, res) => {
  try {
    const { repoUrl, branch, name } = req.body || {};

    const urlError = validateGitUrl(repoUrl);
    if (urlError) {
      return res.status(400).json({ success: false, error: urlError });
    }

    const folderName = deriveRepoFolderName(repoUrl, name);
    if (!folderName) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine a folder name from the URL. Provide a name explicitly.'
      });
    }

    const cleanBranch = (branch || '').trim();
    if (cleanBranch && !/^[A-Za-z0-9._\/-]+$/.test(cleanBranch)) {
      return res.status(400).json({ success: false, error: 'Invalid branch name.' });
    }

    // Ensure the projects directory exists, then resolve the destination and
    // guard against a name that would escape the projects folder.
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const resolvedRoot = path.resolve(PROJECTS_DIR);
    const resolvedDest = path.resolve(path.join(PROJECTS_DIR, folderName));
    if (resolvedDest !== resolvedRoot && !resolvedDest.startsWith(resolvedRoot + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid destination path.' });
    }

    console.log(`[manager] Importing ${repoUrl} -> ${resolvedDest}`);
    const cloneResult = await cloneOrUpdateRepo(String(repoUrl).trim(), resolvedDest, cleanBranch);

    // Make sure the manager can actually launch it.
    const scaffold = scaffoldStartScript(resolvedDest);

    // Regenerate config so the new project appears in the UI.
    const projects = runRediscovery(PROJECTS_DIR);
    const imported = projects.find(p => path.resolve(p.path) === resolvedDest) || null;

    const bits = [`${cloneResult.updated ? 'Updated' : 'Cloned'} ${folderName}`];
    if (scaffold.created) {
      bits.push(scaffold.kind === 'placeholder'
        ? 'no launch command detected — edit the generated Start.sh before starting'
        : `generated a ${scaffold.kind} Start.sh — review it before starting`);
    }
    if (!imported) {
      bits.push('not yet runnable (no Start.sh detected)');
    }

    res.json({
      success: true,
      action: cloneResult.updated ? 'updated' : 'cloned',
      folderName,
      path: resolvedDest,
      program: imported,
      scaffolded: scaffold.created ? scaffold.kind : null,
      message: bits.join(' — ')
    });

    setTimeout(() => broadcastStatus(), 500);
  } catch (err) {
    console.error('[manager] Import failed:', err);
    res.status(500).json({ success: false, error: err.message });
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
    backupConfigFile();

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
    backupConfigFile();

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
      signalProcessTree(proc, 'SIGTERM');
    }

    // Remove from config
    config.programs.splice(programIndex, 1);

    // Backup existing config
    backupConfigFile();

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

    // Launch any programs marked with autostart: true
    launchAutostart(activeConfig);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down server...');

    server.close(() => {
      console.log('Server stopped');
      process.exit(0);
    });

    // Kill all running child processes (whole group each, so nothing is orphaned)
    for (const [id, proc] of processes.entries()) {
      if (proc.isRunning) {
        console.log(`Stopping ${id}...`);
        signalProcessTree(proc, 'SIGTERM');
      }
    }
  });
}

// Start the server only when run directly, so the module can be required for
// testing without opening a listening socket.
if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// Exported for tests / external callers.
module.exports = {
  runRediscovery,
  deriveRepoFolderName,
  validateGitUrl,
  cloneOrUpdateRepo,
  scaffoldStartScript,
  getLanIpAddress,
  getPrimaryIpAddress,
  generateProgramUrls,
  rankLanInterface
};

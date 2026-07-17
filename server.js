#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
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

// Because the manager can start programs and clone-and-run arbitrary git repos,
// reaching a write endpoint is effectively remote command execution. So we FAIL
// CLOSED: with no token configured, bind to loopback only (local access still
// works; nothing is reachable off-box). Setting a token — required before any
// remote/Tailscale exposure — enables binding on all interfaces. An explicit
// MANAGER_HOST always wins; MANAGER_ALLOW_NO_AUTH=1 opts back into the old
// bind-everywhere-without-a-token behavior for trusted private setups.
const ALLOW_NO_AUTH = /^(1|true|yes)$/i.test(String(process.env.MANAGER_ALLOW_NO_AUTH || ''));
// By default a program's path must live inside PROJECTS_DIR (defense in depth so
// a leaked token can't register /etc or /home as a "program" and run it). Set
// MANAGER_ALLOW_EXTERNAL_PATHS=1 to allow programs outside the projects folder.
const ALLOW_EXTERNAL_PATHS = /^(1|true|yes)$/i.test(String(process.env.MANAGER_ALLOW_EXTERNAL_PATHS || ''));
// Only trust X-Forwarded-For (for client-IP / rate-limit keying) when explicitly
// told we sit behind a proxy. Otherwise the header is attacker-controlled and
// would let the brute-force throttle be both evaded and abused for lockout.
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.MANAGER_TRUST_PROXY || ''));
const BIND_HOST = process.env.MANAGER_HOST ||
  ((API_TOKEN || ALLOW_NO_AUTH) ? '0.0.0.0' : '127.0.0.1');

// Extra Host header values to accept, comma-separated (e.g. a reverse-proxy
// domain like manager.example.com). Loopback, raw IP literals, and *.ts.net
// (Tailscale MagicDNS) are always allowed; see hostIsAllowed().
const ALLOWED_HOSTS = new Set(
  String(process.env.MANAGER_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Per-program output is mirrored to disk here so log history survives a manager
// restart (the in-memory ring buffer is just a fast cache). Override with
// MANAGER_LOG_DIR; defaults to a `logs/` folder next to this install.
const LOG_DIR = process.env.MANAGER_LOG_DIR || path.resolve(__dirname, 'logs');
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // rotate a program log once it passes 5 MB

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
// Why each program last stopped, so the UI can tell a clean stop from a crash.
const lastExit = new Map(); // programId -> { code, signal, time, clean }

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
    // Degrade gracefully: a hand-edit that produces invalid JSON or a duplicate
    // id should not take down the read/start/restart endpoints when we still hold
    // a valid last-known-good config (broadcastStatus/getConfigSafe already do
    // this). Only surface the error when there is nothing cached to fall back to.
    if (cachedConfig) {
      return cachedConfig;
    }
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

// Memoized result of `tailscale status --json`. This lookup shells out to a
// subprocess, and it is called for every program on every status broadcast
// (which fire on each health-probe reachability flip, ~every few seconds). Doing
// it synchronously and uncached meant N subprocesses per broadcast, and — worse —
// if `tailscaled` was slow or wedged the untimed execSync blocked the event loop
// and froze the whole manager. Cache the DNS name for TS_LOOKUP_TTL_MS and bound
// the subprocess with a hard timeout so it can never wedge the server.
const TS_LOOKUP_TTL_MS = 60 * 1000;
let tsHostnameCache = { value: null, at: 0 };

function resolveTailscaleDnsName() {
  const now = Date.now();
  if (tsHostnameCache.at && (now - tsHostnameCache.at) < TS_LOOKUP_TTL_MS) {
    return tsHostnameCache.value;
  }
  let value = null;
  try {
    const status = JSON.parse(execSync('tailscale status --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,        // never let a hung `tailscale` CLI block the event loop
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024
    }));
    const dnsName = status && status.Self && status.Self.DNSName;
    if (dnsName) value = dnsName.replace(/\.$/, '');
  } catch (err) {
    // Tailscale is optional (not installed / not up / timed out) — cache the miss
    // too so we don't re-spawn the CLI on every broadcast while it's unavailable.
    value = null;
  }
  tsHostnameCache = { value, at: now };
  return value;
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

  return resolveTailscaleDnsName();
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
  const exit = lastExit.get(programId) || null;

  // Richer health state than plain running/stopped:
  //   listening -> process alive AND its port accepts connections
  //   starting  -> process alive but port not yet reachable
  //   running   -> process alive, port unknown (no PORT / not detected)
  //   crashed   -> exited non-zero and not via a user-initiated stop
  //   stopped   -> cleanly stopped or never started
  let health;
  if (isRunning) {
    health = proc.reachable === true ? 'listening'
      : proc.reachable === false ? 'starting'
      : 'running';
  } else if (exit && !exit.clean) {
    health = 'crashed';
  } else {
    health = 'stopped';
  }

  return {
    id: program.id,
    name: program.name,
    status: isRunning ? 'running' : 'stopped',
    health,
    reachable: isRunning ? (proc.reachable === undefined ? null : proc.reachable) : null,
    exitCode: !isRunning && exit ? (exit.signal ? `signal ${exit.signal}` : exit.code) : null,
    autostart: Boolean(program.autostart),
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

// ---------------------------------------------------------------------------
// Log persistence — mirror program output to disk so history survives a manager
// restart. All disk I/O here is best-effort and fully guarded: logging must
// never be able to crash the manager.
// ---------------------------------------------------------------------------
function sanitizeLogName(programId) {
  return String(programId).replace(/[^a-zA-Z0-9._-]/g, '_') || 'program';
}

function rotateLogIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_LOG_FILE_BYTES) {
      fs.renameSync(file, file + '.1'); // keep one previous generation
    }
  } catch (_) {
    // File may not exist yet — nothing to rotate.
  }
}

function appendLogToFile(programId, lines) {
  if (!lines || !lines.length) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${sanitizeLogName(programId)}.log`);
    rotateLogIfNeeded(file);
    const now = new Date().toISOString();
    const payload = lines.map(l => `${now} ${l}`).join('\n') + '\n';
    fs.appendFile(file, payload, () => {});
  } catch (_) {
    // Never let logging crash the manager.
  }
}

// On startup, seed the in-memory ring buffer from the tail of each program's log
// file so recent history is visible even after the manager was restarted.
function preloadProgramLogs(config) {
  if (!config || !Array.isArray(config.programs)) return;
  for (const program of config.programs) {
    try {
      const file = path.join(LOG_DIR, `${sanitizeLogName(program.id)}.log`);
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500);
      const logs = lines.map(line => {
        const sp = line.indexOf(' ');
        return sp > 0 ? { time: line.slice(0, sp), text: line.slice(sp + 1) } : { time: '', text: line };
      });
      if (logs.length) processLogs.set(program.id, logs);
    } catch (_) {
      // Ignore unreadable/oversized files.
    }
  }
}

function appendProgramLog(programId, text) {
  const logs = processLogs.get(programId) || [];
  logs.push({ time: new Date().toISOString(), text });
  while (logs.length > 1000) {
    logs.shift();
  }
  processLogs.set(programId, logs);
  appendLogToFile(programId, [text]);
}

// ---------------------------------------------------------------------------
// Health probing — a program can be "running" (process alive) yet not actually
// serving (crashed after fork, wrong port, still starting up). A TCP connect to
// its port tells us whether it is really listening.
// ---------------------------------------------------------------------------
function getConfigSafe() {
  try {
    return loadConfig();
  } catch (_) {
    return cachedConfig;
  }
}

function probePort(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(Number(port), host);
    } catch (_) {
      finish(false);
    }
  });
}

async function probeAndUpdate(programId) {
  const proc = processes.get(programId);
  if (!proc || !proc.isRunning) return;
  const config = getConfigSafe();
  const program = config && config.programs.find(p => p.id === programId);
  const port = proc.actualPort || (program && program.env && (program.env.PORT || program.env.port));
  if (!port) {
    proc.reachable = null;
    return;
  }
  const ok = await probePort(port);
  const changed = proc.reachable !== ok;
  proc.reachable = ok;
  if (changed) scheduleBroadcast();
}

let healthProbeTimer = null;
function startHealthProbes() {
  if (healthProbeTimer) return;
  healthProbeTimer = setInterval(() => {
    for (const [id, proc] of processes.entries()) {
      if (proc.isRunning) probeAndUpdate(id);
    }
  }, 5000);
  if (healthProbeTimer.unref) healthProbeTimer.unref();
}

// WebSocket broadcast
const wsClients = new Set();

function broadcastStatus() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // A hand-edited, currently-invalid config must never crash the log pipeline
    // or a timer callback — fall back to the last known-good config.
    console.error(`[manager] broadcastStatus: config load failed (${err.message}); using last known good.`);
    config = cachedConfig;
    if (!config) return;
  }

  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        const status = getAllProgramsStatus(config, client.urlContext || null);
        client.send(JSON.stringify({ type: 'status', data: status }));
      } catch (err) {
        console.error(`[manager] broadcastStatus: send failed: ${err.message}`);
      }
    }
  });
}

// Coalesce bursts of status broadcasts into at most one per interval. Status
// rarely changes and never carries log lines, so broadcasting on every child
// output chunk was pure noise (and re-stat'd config each time).
let broadcastTimer = null;
function scheduleBroadcast(delay = 300) {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastStatus();
  }, delay);
  if (broadcastTimer.unref) broadcastTimer.unref();
}

// Is the request's Host header one we're willing to serve? This is the primary
// defense against DNS-rebinding: an attacker page at evil.example whose domain
// has been rebound to our IP still sends `Host: evil.example`, which is rejected
// here — so it can never become same-origin with the manager and drive the
// (possibly unauthenticated) control plane. Raw IP literals are allowed because
// rebinding fundamentally needs a *domain name*; loopback and *.ts.net (Tailscale
// MagicDNS) are always fine; anything else must be listed in MANAGER_ALLOWED_HOSTS.
function hostIsAllowed(req) {
  const raw = (req.headers && req.headers.host) || '';
  if (!raw) return false;
  // Strip the port. IPv6 literals arrive bracketed: "[::1]:3000".
  let host = String(raw).trim().toLowerCase();
  if (host.startsWith('[')) {
    host = host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'));
  } else {
    host = host.replace(/:\d+$/, '');
  }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host)) return true;              // raw IPv4/IPv6 — not a rebinding vector
  if (host.endsWith('.ts.net')) return true;    // Tailscale MagicDNS
  return ALLOWED_HOSTS.has(host);
}

// Express app
const app = express();

// Reject requests whose Host header we don't recognize (DNS-rebinding defense).
app.use((req, res, next) => {
  if (!hostIsAllowed(req)) {
    return res.status(403).type('text/plain')
      .send('Forbidden: unrecognized Host header. Set MANAGER_ALLOWED_HOSTS if this host is legitimate.');
  }
  next();
});

// CSRF defense for state-changing requests. A cross-origin browser form/fetch
// carries an Origin (or Referer) whose host won't match ours, so reject it — this
// closes the CSRF hole even when auth is disabled (a malicious page you browse to
// can otherwise POST start/stop/delete to the manager on your LAN). Non-browser
// clients (curl, scripts) send no Origin/Referer and are unaffected.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
app.use((req, res, next) => {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  const source = req.headers.origin || req.headers.referer;
  if (!source) return next(); // non-browser client — not a CSRF vector
  let sourceHost;
  try { sourceHost = new URL(source).host.toLowerCase(); } catch (_) { sourceHost = null; }
  const ownHost = String(req.headers.host || '').toLowerCase();
  if (!sourceHost || sourceHost !== ownHost) {
    return res.status(403).type('text/plain').send('Forbidden: cross-origin request rejected.');
  }
  next();
});

// Baseline security headers (defense in depth; cheap and dependency-free).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'; object-src 'none'");
  next();
});

app.use(express.json());
app.use(express.static('public'));

// Gate the whole API behind the token — reads included. /api/config and the log
// endpoints leak filesystem paths, env-var secrets, and program output, so
// "reads are harmless" does not hold here. /api/health stays open so an external
// uptime monitor can poll liveness without a credential.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return requireApiToken(req, res, next);
});

// ---------------------------------------------------------------------------
// Authentication & rate limiting
// ---------------------------------------------------------------------------
// The manager can start programs and clone-and-run arbitrary repos, so the token
// effectively guards remote command execution. We compare it in constant time,
// never accept it in the query string (query-string secrets leak into access
// logs, proxy logs, and browser history), and throttle failed attempts.

// Constant-time comparison that also hides length differences by comparing
// fixed-size SHA-256 digests of both sides.
function tokenMatches(candidate) {
  if (!API_TOKEN) return true; // auth disabled (loopback-only unless opted out)
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function getRequestToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  // Deliberately NOT read from req.query — query-string secrets leak into logs.
  if (req.body && typeof req.body.token === 'string') {
    return req.body.token;
  }
  return null;
}

// Minimal in-memory brute-force throttle keyed by client IP. No dependency,
// which is proportionate for a personal tool reached over a private network:
// after AUTH_MAX_FAILURES failures within AUTH_WINDOW_MS an IP is blocked for
// AUTH_BLOCK_MS.
const AUTH_MAX_FAILURES = 8;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_BLOCK_MS = 5 * 60 * 1000;
const authFailures = new Map(); // ip -> { count, first, blockedUntil }

function clientIp(req) {
  // X-Forwarded-For is honored only when MANAGER_TRUST_PROXY is set. When trusted,
  // take the rightmost entry — the one appended by the closest (trusted) proxy —
  // rather than the leftmost, which the client can spoof.
  if (TRUST_PROXY) {
    const fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) {
      const parts = String(Array.isArray(fwd) ? fwd[0] : fwd)
        .split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function authIsBlocked(ip) {
  const rec = authFailures.get(ip);
  return Boolean(rec && rec.blockedUntil && rec.blockedUntil > Date.now());
}

function recordAuthFailure(ip) {
  const now = Date.now();
  let rec = authFailures.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) {
    rec = { count: 0, first: now, blockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= AUTH_MAX_FAILURES) {
    rec.blockedUntil = now + AUTH_BLOCK_MS;
  }
  authFailures.set(ip, rec);
}

// Browsers cannot set an Authorization header on a WebSocket, so the client
// passes the token as a subprotocol named `bearer.<base64url(token)>` (the same
// approach the Kubernetes API server uses). Returns the decoded token or null.
function decodeBearerSubprotocol(headerValue) {
  const parts = String(headerValue || '').split(',').map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith('bearer.')) {
      const b64 = p.slice('bearer.'.length).replace(/-/g, '+').replace(/_/g, '/');
      try {
        return Buffer.from(b64, 'base64').toString('utf8');
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return next();
  }
  const ip = clientIp(req);
  if (authIsBlocked(ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }
  const token = getRequestToken(req);
  if (tokenMatches(token)) {
    authFailures.delete(ip);
    return next();
  }
  recordAuthFailure(ip);
  console.warn(`[manager] Auth failure from ${ip} on ${req.method} ${req.path}`);
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

app.post('/api/programs/:id/restart', requireApiToken, async (req, res) => {
  const programId = req.params.id;
  try {
    const config = loadConfig();

    // Restart should end with the program RUNNING whether it was up, stopped, or
    // crashed. Wait for the real exit (not a fixed delay) so a slow graceful
    // shutdown can't make us throw "already running" and leave it down.
    await stopProgramAndWait(programId);

    // Give the OS a beat to release the port after the group exits, then confirm
    // the port is actually free before relaunching. bash exiting doesn't guarantee
    // a server it backgrounded (e.g. `python app.py &`) has released its listening
    // socket yet; relaunching too early hits EADDRINUSE and the new process crashes
    // while we've already reported success. Poll (bounded) until the port is free.
    await new Promise(r => setTimeout(r, 300));
    const program = getProgramConfig(programId, config);
    const expectedPort = program && program.env && (program.env.PORT || program.env.port);
    if (expectedPort) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && await probePort(expectedPort)) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const result = startProgram(programId, config);
    res.json({ success: true, data: result });
  } catch (err) {
    appendProgramLog(programId, `[system] Restart failed: ${err.message}`);
    broadcastStatus();
    res.status(500).json({ success: false, error: `Restart failed: ${err.message}` });
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

// Health check endpoint. Reflects real readiness: returns 503 when the config
// can't be loaded so an uptime monitor actually alerts. `authEnabled` lets the
// web UI know whether it needs to prompt for a token.
app.get('/api/health', (req, res) => {
  let configOk = true;
  try {
    loadConfig();
  } catch (_) {
    configOk = false;
  }
  res.status(configOk ? 200 : 503).json({
    status: configOk ? 'ok' : 'degraded',
    configOk,
    authEnabled: Boolean(API_TOKEN),
    timestamp: new Date().toISOString()
  });
});

// werkzeug/Flask, uvicorn, Dash and many frameworks colorize their startup
// output and announce the address they bound to. Strip ANSI codes first.
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

// Extract the listening port from a single log line, or null if none is found.
// Conservative on purpose: a line only counts as an address announcement when
// it references a local bind address or looks like a "server is up" message,
// so unrelated URLs printed in the logs don't get mistaken for the bind port.
function parseListeningPortFromLog(line) {
  const clean = String(line).replace(ANSI_PATTERN, '').trim();

  const looksLikeStartup = /\b(run(?:ning|s)?|listen(?:ing)?|serv(?:e|ing|er)|start(?:ed|ing)?|bound|binding|available)\b/i.test(clean);

  const isLocalBind = (host) => {
    const h = host.toLowerCase();
    return h === '0.0.0.0' || h === '127.0.0.1' || h === 'localhost' ||
      h === '[::]' || h === '[::1]' || /^(?:10|127|192|172)\./.test(h);
  };

  // 1. A full URL is the most reliable signal: http(s)://host:PORT
  const urlMatch = clean.match(/https?:\/\/([^\s/]+?):(\d{2,5})\b/i);
  if (urlMatch && (looksLikeStartup || isLocalBind(urlMatch[1]))) {
    return urlMatch[2];
  }

  // 2. A bare bind-all address (0.0.0.0 / [::]) is almost always the server's own
  //    listen address, so accept it on any line.
  const bindAllMatch = clean.match(/\b(?:0\.0\.0\.0|\[::\]):(\d{2,5})\b/);
  if (bindAllMatch) {
    return bindAllMatch[1];
  }

  // 3. A loopback bind address (127.0.0.1 / localhost / [::1]) is ambiguous — it
  //    also shows up in "Connected to <dependency> at 127.0.0.1:6379" lines — so
  //    only trust it on a line that looks like a startup/serving announcement.
  const loopbackMatch = clean.match(/\b(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b/i);
  if (loopbackMatch && looksLikeStartup) {
    return loopbackMatch[1];
  }

  // 4. An explicit "port 8059" / "port: 8059", only on a startup-looking line.
  if (looksLikeStartup) {
    const portMatch = clean.match(/\bport[:=\s]+(\d{2,5})\b/i);
    if (portMatch) {
      return portMatch[1];
    }
  }

  return null;
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
  // Fresh run — clear any prior exit record and reset reachability/bookkeeping.
  lastExit.delete(programId);
  proc.reachable = undefined;
  proc.killTimer = null;
  proc.stoppedByUser = false;

  const startMarker = `[system] --- started ${new Date().toISOString()} (PID ${proc.pid}) ---`;
  logs.push({ time: new Date().toISOString(), text: startMarker });
  appendLogToFile(programId, [startMarker]);

  // Shared handler for stdout/stderr: buffer lines in memory (capped), mirror
  // them to disk, and detect the bind port. Status is broadcast ONLY when the
  // detected port changes — status carries no log lines, so a per-chunk broadcast
  // was wasted work and could flood clients under a chatty program. (The log
  // panel polls its own endpoint.)
  const handleOutput = (data, isErr) => {
    const lines = data.toString().split('\n').filter(Boolean);
    if (!lines.length) return;
    let portJustDetected = false;
    const rendered = [];
    for (const line of lines) {
      const text = isErr ? `[ERR] ${line}` : line;
      rendered.push(text);
      logs.push({ time: new Date().toISOString(), text });
      // First detected port wins so noisier later lines can't clobber the
      // address the server actually bound to at startup.
      if (!proc.actualPort) {
        const actualPort = parseListeningPortFromLog(line);
        if (actualPort) {
          proc.actualPort = actualPort;
          portJustDetected = true;
        }
      }
      if (logs.length > 1000) logs.shift();
    }
    appendLogToFile(programId, rendered);
    if (portJustDetected) {
      probeAndUpdate(programId); // confirm it is actually listening
      scheduleBroadcast();
    }
  };

  proc.stdout.on('data', (data) => handleOutput(data, false));
  proc.stderr.on('data', (data) => handleOutput(data, true));

  proc.on('error', (err) => {
    appendProgramLog(programId, `[system] Process failed to start: ${err.message}`);
    proc.isRunning = false;
    if (proc.killTimer) { clearTimeout(proc.killTimer); proc.killTimer = null; }
    // Only mutate shared state if this proc is still the registered one (see the
    // exit handler below for the delete/re-add race this guards against).
    if (processes.get(programId) !== proc) return;
    lastExit.set(programId, { code: null, signal: null, time: Date.now(), clean: false });
    processes.delete(programId);
    broadcastStatus();
  });

  proc.on('exit', (code, signal) => {
    const desc = signal ? `signal ${signal}` : `code ${code}`;
    appendProgramLog(programId, `[system] Process exited with ${desc}`);

    // proc-local bookkeeping is always safe.
    proc.isRunning = false;
    if (proc.killTimer) { clearTimeout(proc.killTimer); proc.killTimer = null; }

    // But only touch the shared registry/lastExit if THIS proc is still the one
    // registered for the id. After a delete-then-re-add (same folder → same id),
    // a slow old process exiting late must not evict or overwrite the newer live
    // process — otherwise the manager would think the running program is gone.
    if (processes.get(programId) !== proc) return;

    // A code-0 exit, or one we initiated via Stop, is clean; anything else is a
    // crash the UI should surface.
    lastExit.set(programId, {
      code,
      signal,
      time: Date.now(),
      clean: code === 0 || proc.stoppedByUser === true
    });
    processes.delete(programId);

    broadcastStatus();
  });

  // Track liveness explicitly (proc.killed only reflects signal delivery,
  // not actual process exit) and spawn time for uptime calculation.
  proc.isRunning = true;
  proc.spawnDate = Date.now();

  processes.set(programId, proc);

  // Push the running-state transition to clients now. (We no longer broadcast on
  // every log chunk, so without this the card would stay "stopped" until a port
  // is detected in the logs or the ~5s health probe runs — and never, for a
  // program with no detectable/configured port.)
  scheduleBroadcast();

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

  proc.stoppedByUser = true;
  signalProcessTree(proc, 'SIGTERM');

  // Force-kill the whole group after 10s if it hasn't exited. Keep the handle so
  // the exit/error handler can clear it — otherwise every stop leaked a 10s timer.
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = setTimeout(() => {
    if (proc.isRunning) {
      signalProcessTree(proc, 'SIGKILL');
    }
  }, 10000);
  if (proc.killTimer.unref) proc.killTimer.unref();

  return {
    id: programId,
    status: 'stopping'
  };
}

// Stop a program and resolve once it has actually exited (or after a bounded
// wait). Restart uses this instead of a fixed delay so it never races a slow
// graceful shutdown and ends up failing while leaving the program stopped.
function stopProgramAndWait(programId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const proc = processes.get(programId);
    if (!proc || !proc.isRunning) {
      return resolve(); // already stopped — nothing to wait for
    }
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    proc.once('exit', done);
    // Safety net: SIGKILL lands at 10s, so exit should fire well before this.
    const t = setTimeout(done, timeoutMs);
    if (t.unref) t.unref();
    try {
      stopProgram(programId);
    } catch (_) {
      done();
    }
  });
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

// Resolve a path and confirm it is inside PROJECTS_DIR (or equal to it). Used to
// keep browse / add / update from ranging over the whole filesystem, matching the
// guard the git-import flow already applies to clone destinations.
function isInsideProjectsDir(targetPath) {
  try {
    const root = path.resolve(PROJECTS_DIR);
    const resolved = path.resolve(targetPath);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch (_) {
    return false;
  }
}

app.get('/api/browse-projects', (req, res) => {
  const dir = req.query.dir || PROJECTS_DIR;

  if (!dir) {
    return res.status(400).json({ success: false, error: 'No directory specified' });
  }

  // Confine browsing to the projects folder so this can't enumerate arbitrary
  // host directories (e.g. ?dir=/etc, /root, /home).
  if (!isInsideProjectsDir(dir)) {
    return res.status(403).json({ success: false, error: 'Directory is outside the projects folder' });
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

  // Signal every child process group before exiting so they aren't orphaned.
  // Orphans keep holding their ports and can no longer be managed; the SIGINT
  // shutdown path does the same. Programs marked autostart come back on relaunch.
  for (const [id, proc] of processes.entries()) {
    if (proc.isRunning) {
      console.log(`[manager] Stopping ${id} before restart...`);
      signalProcessTree(proc, 'SIGTERM');
    }
  }

  // Give the HTTP response and the SIGTERMs a moment to land, then exit.
  setTimeout(() => {
    console.log('[manager] Exiting process for restart');
    process.exit(0);
  }, 1200);
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
    if (updates.path !== undefined) {
      if (!ALLOW_EXTERNAL_PATHS && !isInsideProjectsDir(updates.path)) {
        return res.status(400).json({
          success: false,
          error: 'Program path must be inside the projects folder (set MANAGER_ALLOW_EXTERNAL_PATHS=1 to override)'
        });
      }
      program.path = updates.path;
    }
    if (updates.url !== undefined) program.url = updates.url;
    if (updates.env !== undefined) program.env = updates.env;
    // Allow toggling autostart from the UI.
    if (updates.autostart !== undefined) program.autostart = Boolean(updates.autostart);

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

    if (!ALLOW_EXTERNAL_PATHS && !isInsideProjectsDir(newProgram.path)) {
      return res.status(400).json({
        success: false,
        error: 'Program path must be inside the projects folder (set MANAGER_ALLOW_EXTERNAL_PATHS=1 to override)'
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

    // Stop the program if it's running. Use stopProgram() so we get the SIGTERM +
    // 10s SIGKILL escalation, and DON'T drop the registry entry here while the
    // child may still be alive: doing so would orphan the process (no handle left
    // to force-kill it) and let a re-add of the same id race its exit handler. The
    // identity-guarded exit handler removes the entry once the group truly exits.
    const proc = processes.get(programId);
    const stoppingRunning = Boolean(proc && proc.isRunning);
    if (stoppingRunning) {
      console.log(`[manager] Stopping program before removal: ${programId}`);
      try { stopProgram(programId); } catch (_) { /* already gone */ }
    } else {
      processes.delete(programId);
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

    // Clean up process logs (keep the process entry if it's still shutting down;
    // its exit handler will clean it up).
    processLogs.delete(programId);

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

  // Seed in-memory log buffers from disk so recent history survives a manager
  // restart (the buffers are otherwise empty until a program prints again).
  preloadProgramLogs(config);

  // Backstops: a stray throw in a stream 'data' handler or timer callback (e.g.
  // loadConfig on a hand-broken config) must not take the whole manager — and
  // everything it manages — down. Log it and stay up.
  process.on('uncaughtException', (err) => {
    console.error('[manager] Uncaught exception (kept alive):', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[manager] Unhandled rejection (kept alive):', reason);
  });

  console.log('HTTP Server Manager');
  console.log('==================');

  const server = http.createServer(app);
  console.log('✓ Running in HTTP mode');

  // WebSocket server. handleProtocols echoes back a client-offered subprotocol
  // so browsers are satisfied while we smuggle the auth token in via another one.
  const wss = new WebSocket.Server({
    server,
    handleProtocols: (protocols) => {
      for (const p of protocols) {
        if (!String(p).startsWith('bearer.')) return p; // prefer the plain 'manager' marker
      }
      const first = protocols.values().next().value;
      return first || false;
    }
  });

  wss.on('connection', (ws, req) => {
    // The WS upgrade bypasses the Express middleware stack, so apply the same
    // Host-header allowlist here (DNS-rebinding defense) — otherwise a rebound
    // page could open a socket and read status even in no-auth mode.
    if (!hostIsAllowed(req)) {
      ws.close(1008, 'Forbidden host');
      return;
    }

    // Require the token for WebSocket clients when auth is enabled. The token is
    // read ONLY from the `bearer.<base64url(token)>` subprotocol — never the query
    // string, which would leak the secret into reverse-proxy/access logs (the HTTP
    // path refuses ?token= for the same reason). Same constant-time compare and
    // brute-force throttle as the HTTP path.
    if (API_TOKEN) {
      const ip = clientIp(req);
      const token = decodeBearerSubprotocol(req.headers['sec-websocket-protocol']);
      if (authIsBlocked(ip) || !tokenMatches(token)) {
        if (!authIsBlocked(ip)) recordAuthFailure(ip);
        ws.close(1008, 'Unauthorized');
        return;
      }
      authFailures.delete(ip);
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

  server.listen(PORT, BIND_HOST, () => {
    const activeConfig = loadConfig();

    console.log(`✓ Server listening on ${BIND_HOST}:${PORT}`);
    console.log(`✓ Loaded ${activeConfig.programs.length} program(s)`);

    // Auth / exposure status. This is a remote-capable control plane, so make the
    // security posture obvious at startup.
    if (API_TOKEN) {
      console.log('🔒 API token set — auth is ENABLED for the API and WebSocket.');
    } else if (BIND_HOST === '127.0.0.1') {
      console.log('🔒 No API token set — bound to loopback only (local access).');
      console.log('   To reach this from another device, set MANAGER_API_TOKEN and put it on a');
      console.log('   private network (Tailscale recommended). See the README "Remote access".');
    } else {
      const cause = process.env.MANAGER_HOST
        ? `MANAGER_HOST=${process.env.MANAGER_HOST}`
        : 'MANAGER_ALLOW_NO_AUTH';
      console.log(`⚠️  No API token set but bound to ${BIND_HOST} (${cause}).`);
      console.log('   Anyone who can reach this address can run programs on this machine.');
      if (BIND_HOST === '0.0.0.0') {
        console.log('   0.0.0.0 is ALL interfaces — this includes your LAN, not just Tailscale.');
        console.log('   To restrict to Tailscale only, set MANAGER_HOST to your 100.x.y.z address.');
      }
    }

    console.log('\nAccess the web interface at:');
    console.log(`  http://localhost:${PORT}`);

    if (BIND_HOST !== '127.0.0.1') {
      const { networkInterfaces } = require('os');
      const nets = networkInterfaces();
      Object.keys(nets).forEach((name) => {
        nets[name].forEach((net) => {
          // Skip internal and non-IPv4
          if (net.internal || net.family !== 'IPv4') return;
          console.log(`  http://${net.address}:${PORT}`);
        });
      });
    }

    // Begin probing running programs' ports so cards can show listening vs
    // running-but-not-serving.
    startHealthProbes();

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
  rankLanInterface,
  parseListeningPortFromLog,
  isInsideProjectsDir,
  decodeBearerSubprotocol,
  hostIsAllowed,
  sanitizeLogName
};

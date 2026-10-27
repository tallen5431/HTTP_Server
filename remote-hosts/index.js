'use strict';

// Remote hosts: find the devices on this machine's tailnet and open an SSH
// terminal to one of them from the browser.
//
// Discovery reads `tailscale status --json`, so there is nothing to configure:
// every device on the tailnet shows up. The terminal runs the system `ssh`
// client as the manager's user inside a pseudo-terminal (see pty-bridge.py), so
// it uses that user's ~/.ssh/config, keys, agent and known_hosts exactly as a
// shell would. Host-key prompts and password prompts appear in the terminal.
//
// The browser never names a host. It sends a device's Tailscale node ID, and the
// manager connects to the address Tailscale reported for that node, so the
// endpoint cannot be used to reach arbitrary machines or inject ssh options.

const path = require('path');
const { spawn, execFile } = require('child_process');

const PTY_BRIDGE = path.join(__dirname, 'pty-bridge.py');
const DEVICE_CACHE_MS = 10 * 1000;
const MAX_SESSIONS = 6;
const MAX_INPUT_MESSAGE_BYTES = 64 * 1024;
const OUTPUT_HIGH_WATER = 1024 * 1024; // pause ssh output while the socket is this far behind

// Login names are passed to `ssh -l`, after option parsing would still see them,
// so keep them to what Linux accepts for a user name (and never a leading '-').
function isValidSshUser(user) {
  return typeof user === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user);
}

// Turn `tailscale status --json` into the device list the UI shows. Pure, so it
// is unit-tested against captured output.
function parseTailscaleDevices(status) {
  if (!status || typeof status !== 'object') return [];
  const nodes = [];
  if (status.Self) nodes.push({ node: status.Self, self: true });
  for (const node of Object.values(status.Peer || {})) nodes.push({ node, self: false });

  const devices = [];
  for (const { node, self } of nodes) {
    if (!node || typeof node !== 'object') continue;
    const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : [];
    const address = ips.find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || ips[0];
    const id = node.ID || node.PublicKey;
    if (!id || !address) continue;
    const dnsName = typeof node.DNSName === 'string' ? node.DNSName.replace(/\.$/, '') : '';
    devices.push({
      id: String(id),
      name: node.HostName || dnsName.split('.')[0] || address,
      dnsName,
      address,
      os: node.OS || '',
      online: self ? true : Boolean(node.Online),
      self,
      // Present when the device runs Tailscale SSH (`tailscale up --ssh`), which
      // authenticates by tailnet identity instead of keys.
      tailscaleSsh: Array.isArray(node.sshHostKeys) && node.sshHostKeys.length > 0,
      lastSeen: node.LastSeen && !String(node.LastSeen).startsWith('0001-') ? node.LastSeen : null
    });
  }

  // This machine first, then online devices, then by name.
  devices.sort((a, b) =>
    (b.self - a.self) || (b.online - a.online) || a.name.localeCompare(b.name));
  return devices;
}

let deviceCache = { at: 0, value: null, pending: null };

// Async (unlike the URL helpers in server.js) because this backs an HTTP request
// rather than every status broadcast, and a slow tailscaled must not block the
// event loop. Rejects with a readable message when Tailscale is unavailable.
function listTailscaleDevices({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && deviceCache.value && now - deviceCache.at < DEVICE_CACHE_MS) {
    return Promise.resolve(deviceCache.value);
  }
  if (deviceCache.pending) return deviceCache.pending;

  deviceCache.pending = new Promise((resolve, reject) => {
    execFile('tailscale', ['status', '--json'], {
      timeout: 4000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout) => {
      deviceCache.pending = null;
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'Tailscale is not installed on this machine.'
          : 'Could not read Tailscale status. Is tailscaled running and logged in?';
        return reject(new Error(msg));
      }
      let devices;
      try {
        devices = parseTailscaleDevices(JSON.parse(stdout));
      } catch (_) {
        return reject(new Error('Tailscale returned status the manager could not parse.'));
      }
      deviceCache = { at: Date.now(), value: devices, pending: null };
      resolve(devices);
    });
  });
  return deviceCache.pending;
}

function __setDeviceCacheForTests(devices) {
  deviceCache = { at: devices ? Date.now() : 0, value: devices, pending: null };
}

// Whether the browser terminal may be used. It hands out a shell (on other
// machines, as this machine's user, with this machine's keys), so it needs the
// access token: there is no way to turn it on for an unauthenticated manager.
// MANAGER_SSH_TERMINAL=0 turns it off even with a token.
function terminalPolicy({ apiToken, setting }) {
  if (/^(0|false|no|off)$/i.test(String(setting || '').trim())) {
    return { enabled: false, reason: 'The SSH terminal is disabled (MANAGER_SSH_TERMINAL=0).' };
  }
  if (!apiToken) {
    return {
      enabled: false,
      reason: 'The SSH terminal requires an access token. Set MANAGER_API_TOKEN to enable it.'
    };
  }
  return { enabled: true, reason: null };
}

// "Keep session": run the shell inside tmux on the device, so a dropped
// connection (a phone locking or switching apps) leaves it running and the next
// connect re-attaches. Falls back to a plain login shell where tmux is missing.
// A fixed string: nothing from the browser is ever part of the remote command.
const TMUX_SESSION_NAME = 'manager';
const PERSISTENT_SHELL_COMMAND =
  `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${TMUX_SESSION_NAME}; ` +
  'else echo "tmux is not installed here, so this session will not be kept (sudo apt install tmux)."; ' +
  'exec "${SHELL:-/bin/sh}" -l; fi';

// The ssh invocation for a device. `--` ends option parsing, so neither the
// user nor the address can be read as an ssh option.
function buildSshArgs(device, user, { persist = false } = {}) {
  const args = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];
  if (persist) args.push('-t'); // ssh only allocates a terminal for a command when asked
  if (user) args.push('-l', user);
  args.push('--', device.address);
  if (persist) args.push(PERSISTENT_SHELL_COMMAND);
  return args;
}

function clampDimension(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

const sessions = new Set();

// Bridge an accepted WebSocket to `ssh <device>` running in a pseudo-terminal.
// Browser -> server: text frames of JSON, {type:'input', data} or
// {type:'resize', rows, cols}. Server -> browser: binary frames are terminal
// output; text frames are JSON {type:'exit', code} or {type:'error', message}.
function startTerminalSession(ws, { device, user, persist = false, rows, cols, log = () => {} }) {
  const sendControl = (msg) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  if (sessions.size >= MAX_SESSIONS) {
    sendControl({ type: 'error', message: `Too many open terminals (limit ${MAX_SESSIONS}).` });
    ws.close(1013, 'Too many terminals');
    return null;
  }

  const r = clampDimension(rows, 24);
  const c = clampDimension(cols, 80);
  const child = spawn('python3', [PTY_BRIDGE, String(r), String(c), '--', 'ssh', ...buildSshArgs(device, user, { persist })], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  const control = child.stdio[3];
  const session = { child, device, user };
  sessions.add(session);
  log(`opened SSH terminal to ${device.name} (${device.address})${user ? ` as ${user}` : ''}` +
    (persist ? ' in tmux' : ''));

  let ended = false;
  const end = (code, message) => {
    if (ended) return;
    ended = true;
    sessions.delete(session);
    if (message) sendControl({ type: 'error', message });
    sendControl({ type: 'exit', code });
    if (ws.readyState === 1) ws.close(1000, 'Session ended');
    log(`closed SSH terminal to ${device.name} (exit ${code})`);
  };

  child.on('error', (err) => {
    const message = err.code === 'ENOENT'
      ? 'python3 is required for the SSH terminal but was not found on this machine.'
      : `Could not start the terminal: ${err.message}`;
    end(-1, message);
  });

  let resumeTimer = null;
  child.stdout.on('data', (chunk) => {
    if (ws.readyState !== 1) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > OUTPUT_HIGH_WATER && !resumeTimer) {
      child.stdout.pause();
      resumeTimer = setInterval(() => {
        if (ws.readyState !== 1 || ws.bufferedAmount < OUTPUT_HIGH_WATER / 4) {
          clearInterval(resumeTimer);
          resumeTimer = null;
          child.stdout.resume();
        }
      }, 50);
    }
  });
  // The bridge itself only writes to stderr when it cannot start the command.
  child.stderr.on('data', (chunk) => {
    if (ws.readyState === 1) ws.send(chunk, { binary: true });
  });
  // Swallow EPIPE once the bridge has exited; 'close' reports the outcome.
  child.stdin.on('error', () => {});
  if (control) control.on('error', () => {});

  child.on('close', (code, signal) => {
    if (resumeTimer) clearInterval(resumeTimer);
    end(code === null ? (signal ? 128 : -1) : code);
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_INPUT_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      if (child.stdin.writable) child.stdin.write(msg.data);
    } else if (msg.type === 'resize' && control && control.writable) {
      control.write(`${clampDimension(msg.rows, r)} ${clampDimension(msg.cols, c)}\n`);
    }
  });

  // Closing the tab or losing the connection hangs up the SSH session, the same
  // as closing a terminal window.
  ws.on('close', () => {
    if (!ended && child.exitCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  });

  return session;
}

function closeAllTerminalSessions() {
  for (const s of sessions) {
    try { s.child.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
}

module.exports = {
  parseTailscaleDevices,
  listTailscaleDevices,
  __setDeviceCacheForTests,
  terminalPolicy,
  isValidSshUser,
  buildSshArgs,
  PERSISTENT_SHELL_COMMAND,
  startTerminalSession,
  closeAllTerminalSessions,
  MAX_SESSIONS
};

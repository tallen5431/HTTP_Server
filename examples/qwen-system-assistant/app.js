#!/usr/bin/env node

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8091);
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_HOST = OLLAMA_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder:30b';
const OLLAMA_REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
const LLM_CONTEXT_SIZE = Number(process.env.LLM_CONTEXT_SIZE || process.env.OLLAMA_NUM_CTX || 8192);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.2);
const OLLAMA_NUM_CTX = LLM_CONTEXT_SIZE;
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 512);
const DEFAULT_SYSTEM_PROMPT = process.env.LLM_SYSTEM_PROMPT || 'You are a concise local coding assistant. Use the provided JSON context only. Identify concrete issues, propose exact commands or patches, avoid speculation, and keep answers actionable.';
const MAX_OUTPUT = 4000;
const MAX_MODEL_CONTEXT_CHARS = Number(process.env.MAX_MODEL_CONTEXT_CHARS || 24000);
const MAX_FILE_SCAN_DEPTH = 8;
const MAX_FILE_SCAN_ENTRIES = 500;
const MAX_FILE_SCAN_VISITED = 5000;

const SSH_USER = process.env.SSH_USER || 'tj';
const SSH_KEY = process.env.SSH_KEY || '';
const SSH_BATCH_MODE = process.env.SSH_BATCH_MODE !== '0';

const DEVICES = [
  { id: 'local', name: 'Local (this machine)', host: null, platform: 'linux' },
  {
    id: 'desktop-glpggos',
    name: 'desktop-glpggos (Windows)',
    host: '100.98.112.1',
    platform: 'windows',
    sshUser: process.env.WINDOWS_SSH_USER || 'tjing',
    sshKey: process.env.WINDOWS_SSH_KEY || '~/.ssh/id_ed25519_windows',
    fileRoot: process.env.WINDOWS_FILE_ROOT || 'C:\\Users\\tjing'
  },
  { id: 'pi5', name: 'pi5 (Raspberry Pi)', host: '100.64.69.114', platform: 'linux' },
  { id: 'tj-jetson-desktop', name: 'tj-jetson-desktop (Jetson)', host: '100.83.4.72', platform: 'linux' },
  { id: 'tj-nucboxg3-plus', name: 'tj-nucboxg3-plus (NucBox)', host: '100.92.90.118', platform: 'linux' },
  { id: 'thomass-z-fold6', name: 'thomass-z-fold6 (Android)', host: '100.75.197.117', platform: 'android' }
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function command(label, file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
      resolve({
        label,
        command: [file, ...args].join(' '),
        ok: !error,
        output: String(stdout || stderr || error?.message || '').slice(0, MAX_OUTPUT)
      });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function getSshSettings(device) {
  return {
    sshUser: device.sshUser || SSH_USER,
    sshKey: expandHome(device.sshKey || SSH_KEY),
    host: device.host
  };
}

function buildSshArgs(device, remoteCmd) {
  const { sshUser, sshKey, host } = getSshSettings(device);
  const opts = [
    ...(SSH_BATCH_MODE ? ['-o', 'BatchMode=yes'] : []),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    ...(sshKey ? ['-i', sshKey] : [])
  ];
  return { args: [...opts, `${sshUser}@${host}`, remoteCmd], sshUser, sshKey, host };
}

function sshPermissionHelp(output, settings) {
  if (!/Permission denied|Authentication failed|Could not resolve|Connection timed out|No route to host|Connection refused/i.test(output || '')) return null;
  const keyText = settings.sshKey ? ` using key ${settings.sshKey}` : '';
  return [
    `SSH connection failed for ${settings.sshUser}@${settings.host}${keyText}.`,
    'Tailscale provides network reachability, but SSH still requires a valid account and SSH credentials on the target device.',
    "Verify the device SSH username/key settings, install this server\'s public key in the target account authorized_keys when using Linux, or set SSH_BATCH_MODE=0 if you intentionally want interactive password prompts in a terminal-run instance."
  ].join(' ');
}

function sshDeviceCommand(label, device, remoteCmd, timeout = 10000, outputLimit = MAX_OUTPUT) {
  return new Promise((resolve) => {
    const settings = buildSshArgs(device, remoteCmd);
    execFile('ssh', settings.args, { timeout, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
      const output = String(stdout || stderr || error?.message || '').slice(0, outputLimit);
      resolve({
        label,
        command: remoteCmd,
        ok: !error,
        output,
        help: sshPermissionHelp(output, settings)
      });
    });
  });
}

async function collectSshSystemContext(device) {
  const checks = await Promise.all([
    sshDeviceCommand('Disk usage', device, 'df -h -x tmpfs -x devtmpfs 2>/dev/null', 8000),
    sshDeviceCommand('Block devices', device, 'lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS,MODEL 2>/dev/null || echo "lsblk unavailable"', 8000),
    sshDeviceCommand('Top memory processes', device, "ps -eo pid,ppid,comm,%mem,%cpu,args --sort=-%mem 2>/dev/null | head -40 || ps aux 2>/dev/null | head -40", 8000),
    sshDeviceCommand('Network addresses', device, 'ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | head -60', 8000),
    sshDeviceCommand('Listening TCP/UDP services', device, 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null | head -40', 8000),
    sshDeviceCommand('Recent journal errors', device, 'journalctl -p 3 -n 50 --no-pager 2>/dev/null || dmesg --level=err,crit,alert,emerg 2>/dev/null | tail -50', 10000),
    sshDeviceCommand('System info', device, 'uname -a && uptime && free -h 2>/dev/null', 8000)
  ]);
  return { collectedAt: new Date().toISOString(), remoteHost: device.host, platform: 'linux', checks };
}

function powershellString(value) {
  return `'${String(value).replace(/'/g, `''`)}'`;
}

function powershellCommand(command) {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, 'utf16le').toString('base64')}`;
}

async function collectWindowsSystemContext(device) {
  const checks = await Promise.all([
    sshDeviceCommand('Windows identity', device, powershellCommand('hostname; whoami'), 8000),
    sshDeviceCommand('OS info', device, powershellCommand('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime | Format-List'), 10000),
    sshDeviceCommand('Disk usage', device, powershellCommand('Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free,Root | Format-Table -AutoSize'), 10000),
    sshDeviceCommand('Top memory processes', device, powershellCommand('Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 25 Id,ProcessName,CPU,WorkingSet64 | Format-Table -AutoSize'), 10000),
    sshDeviceCommand('Network addresses', device, powershellCommand('Get-NetIPAddress | Select-Object InterfaceAlias,IPAddress,AddressFamily,PrefixLength | Format-Table -AutoSize'), 10000),
    sshDeviceCommand('Listening TCP ports', device, powershellCommand('Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize'), 10000)
  ]);
  return { collectedAt: new Date().toISOString(), remoteHost: device.host, platform: 'windows', checks };
}

function windowsDefaultPath(device) {
  return device.fileRoot || `C:\\Users\\${device.sshUser || SSH_USER}`;
}

function normalizeWindowsPath(device, remotePath) {
  const value = String(remotePath || '').trim();
  if (!value || /^\/(home|root)(\/|$)/i.test(value)) return windowsDefaultPath(device);
  return value.replace(/\//g, '\\');
}

function parseJsonLines(output) {
  return output.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      return [];
    }
  });
}

async function browseWindowsDirectories(device, remotePath) {
  const root = normalizeWindowsPath(device, remotePath);
  const cmd = [
    `$root = ${powershellString(root)}`,
    '$parent = Split-Path -LiteralPath $root -Parent',
    `Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction Stop | Sort-Object Name | Select-Object -First 200 @{Name='name';Expression={$_.Name}},@{Name='path';Expression={$_.FullName}} | ConvertTo-Json -Compress`,
    `Write-Output (@{__parent=$parent} | ConvertTo-Json -Compress)`
  ].join('; ');
  const raw = await sshDeviceCommand('Windows directory browse', device, powershellCommand(cmd), 15000);
  const items = raw.ok ? parseJsonLines(raw.output) : [];
  const parentItem = items.find(item => item && Object.prototype.hasOwnProperty.call(item, '__parent'));
  const directories = items.filter(item => item && item.name && item.path).map(item => ({ name: item.name, path: item.path }));
  return {
    root,
    remoteHost: device.host,
    platform: 'windows',
    parent: parentItem?.__parent || null,
    directories,
    errors: raw.ok ? [] : [{ message: raw.output, help: raw.help }]
  };
}

async function collectWindowsFileScan(device, remotePath, depth) {
  const root = normalizeWindowsPath(device, remotePath);
  const safeDepth = clampDepth(depth);
  const psMaxEntries = MAX_FILE_SCAN_VISITED;
  const cmd = [
    `$root = ${powershellString(root)}`,
    `$maxDepth = ${safeDepth}`,
    `$maxEntries = ${psMaxEntries}`,
    '$rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop',
    '$results = New-Object System.Collections.Generic.List[object]',
    `function Add-Entry($item, [int]$depth) { if ($results.Count -ge $maxEntries) { return }; $rel = if ($item.FullName -eq $rootItem.FullName) { '.' } else { $item.FullName.Substring($rootItem.FullName.TrimEnd('\\').Length).TrimStart('\\') }; $type = if ($item.PSIsContainer) { 'directory' } else { 'file' }; $results.Add([pscustomobject]@{path=$rel; type=$type; depth=$depth; sizeBytes=if ($item.PSIsContainer) { 0 } else { $item.Length }; modifiedAt=$item.LastWriteTimeUtc.ToString('o'); mode=$item.Mode}) }`,
    'function Walk($item, [int]$depth) { Add-Entry $item $depth; if (-not $item.PSIsContainer -or $depth -ge $maxDepth -or $results.Count -ge $maxEntries) { return }; Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object { Walk $_ ($depth + 1) } }',
    'Walk $rootItem 0',
    '$results | ConvertTo-Json -Compress'
  ].join('; ');
  const raw = await sshDeviceCommand('Windows file scan', device, powershellCommand(cmd), 30000, 1024 * 512);
  const entries = raw.ok ? parseJsonLines(raw.output) : [];
  let files = 0, directories = 0, totalFileBytes = 0;
  for (const entry of entries) {
    if (entry.type === 'file') { files++; totalFileBytes += Number(entry.sizeBytes) || 0; }
    if (entry.type === 'directory') directories++;
  }
  const fileEntries = entries.filter(entry => entry.type === 'file');
  return {
    root,
    remoteHost: device.host,
    platform: 'windows',
    maxDepth: safeDepth,
    collectedAt: new Date().toISOString(),
    limits: { maxDepth: MAX_FILE_SCAN_DEPTH, maxEntries: MAX_FILE_SCAN_ENTRIES, maxVisited: MAX_FILE_SCAN_VISITED },
    summary: { files, directories, totalFileBytes, visited: entries.length, truncated: entries.length >= MAX_FILE_SCAN_VISITED },
    entries: entries.slice(0, MAX_FILE_SCAN_ENTRIES),
    largestFiles: [...fileEntries].sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0)).slice(0, 20),
    recentlyModified: [...fileEntries].sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, 20),
    errors: raw.ok ? [] : [{ message: raw.output, help: raw.help }]
  };
}

async function collectSshFileScan(device, remotePath, depth) {
  const safeDepth = clampDepth(depth);
  const findCmd = `find ${shellQuote(remotePath)} -maxdepth ${safeDepth} -printf '%P\\t%y\\t%s\\t%T@\\t%#m\\n' 2>/dev/null | head -600`;
  const raw = await sshDeviceCommand('File scan', device, findCmd, 20000);

  const entries = [];
  let files = 0, directories = 0, totalFileBytes = 0;
  for (const line of raw.output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [relPath, typeChar, sizeStr, mtimeStr, mode] = parts;
    const type = typeChar === 'd' ? 'directory' : typeChar === 'f' ? 'file' : typeChar === 'l' ? 'symlink' : 'other';
    const sizeBytes = Number(sizeStr) || 0;
    const modifiedAt = mtimeStr ? new Date(Number(mtimeStr) * 1000).toISOString() : null;
    if (type === 'file') { files++; totalFileBytes += sizeBytes; }
    if (type === 'directory') directories++;
    entries.push({ path: relPath || '.', type, sizeBytes, modifiedAt, mode: (mode || '').trim() });
  }

  const fileEntries = entries.filter(e => e.type === 'file');
  return {
    root: remotePath,
    remoteHost: device.host,
    maxDepth: safeDepth,
    collectedAt: new Date().toISOString(),
    summary: { files, directories, totalFileBytes, visited: entries.length, truncated: entries.length >= 500 },
    entries: entries.slice(0, MAX_FILE_SCAN_ENTRIES),
    largestFiles: [...fileEntries].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 20),
    recentlyModified: [...fileEntries].sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, 20),
    errors: raw.ok ? [] : [{ message: raw.output, help: raw.help }]
  };
}

function clampDepth(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  return Math.min(parsed, MAX_FILE_SCAN_DEPTH);
}

function rememberTop(list, entry, scoreKey, limit = 20) {
  list.push(entry);
  list.sort((a, b) => b[scoreKey] - a[scoreKey]);
  if (list.length > limit) list.length = limit;
}


async function browseSshDirectories(device, remotePath) {
  const root = remotePath || '/';
  const cmd = `find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\t%p\n' 2>/dev/null | sort | head -200`;
  const raw = await sshDeviceCommand('Directory browse', device, cmd, 10000);
  const directories = raw.output.split('\n').filter(Boolean).map((line) => {
    const [name, fullPath] = line.split('\t');
    return { name, path: fullPath || name };
  });
  return {
    root,
    remoteHost: device.host,
    parent: root === '/' ? null : path.posix.dirname(root.replace(/\/+$/, '') || '/'),
    directories,
    errors: raw.ok ? [] : [{ message: raw.output, help: raw.help }]
  };
}

async function browseLocalDirectories(rootPath) {
  const root = path.resolve(rootPath || os.homedir());
  const directories = [];
  const errors = [];
  try {
    const children = await fs.readdir(root, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory()) directories.push({ name: child.name, path: path.join(root, child.name) });
    }
    directories.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    errors.push({ path: root, message: error.message });
  }
  return { root, parent: path.dirname(root) === root ? null : path.dirname(root), directories: directories.slice(0, 200), errors };
}

async function scanFiles(rootPath, requestedDepth = 2) {
  const root = path.resolve(rootPath || os.homedir());
  const maxDepth = clampDepth(requestedDepth);
  const result = {
    root,
    maxDepth,
    collectedAt: new Date().toISOString(),
    limits: {
      maxDepth: MAX_FILE_SCAN_DEPTH,
      maxEntries: MAX_FILE_SCAN_ENTRIES,
      maxVisited: MAX_FILE_SCAN_VISITED
    },
    summary: {
      files: 0,
      directories: 0,
      symlinks: 0,
      other: 0,
      totalFileBytes: 0,
      visited: 0,
      truncated: false
    },
    entries: [],
    largestFiles: [],
    recentlyModified: [],
    errors: []
  };

  const queue = [{ fullPath: root, relativePath: '.', depth: 0 }];

  while (queue.length) {
    if (result.summary.visited >= MAX_FILE_SCAN_VISITED) {
      result.summary.truncated = true;
      break;
    }

    const current = queue.shift();
    result.summary.visited += 1;
    let stat;
    try {
      stat = await fs.lstat(current.fullPath);
    } catch (error) {
      result.errors.push({ path: current.relativePath, message: error.message });
      continue;
    }

    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    if (type === 'file') {
      result.summary.files += 1;
      result.summary.totalFileBytes += stat.size;
    } else if (type === 'directory') {
      result.summary.directories += 1;
    } else if (type === 'symlink') {
      result.summary.symlinks += 1;
    } else {
      result.summary.other += 1;
    }

    const entry = {
      path: current.relativePath,
      type,
      depth: current.depth,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      mode: `0${(stat.mode & 0o777).toString(8)}`
    };

    if (result.entries.length < MAX_FILE_SCAN_ENTRIES) {
      result.entries.push(entry);
    } else {
      result.summary.truncated = true;
    }

    if (type === 'file') {
      rememberTop(result.largestFiles, entry, 'sizeBytes');
      rememberTop(result.recentlyModified, { ...entry, modifiedMs: stat.mtimeMs }, 'modifiedMs');
    }

    if (type !== 'directory' || current.depth >= maxDepth) continue;

    let children;
    try {
      children = await fs.readdir(current.fullPath);
    } catch (error) {
      result.errors.push({ path: current.relativePath, message: error.message });
      continue;
    }

    children.sort((a, b) => a.localeCompare(b));
    for (const child of children) {
      queue.push({
        fullPath: path.join(current.fullPath, child),
        relativePath: current.relativePath === '.' ? child : path.join(current.relativePath, child),
        depth: current.depth + 1
      });
    }
  }

  result.recentlyModified = result.recentlyModified.map(({ modifiedMs, ...entry }) => entry);
  return result;
}

async function collectSystemContext() {
  const staticInfo = {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    loadAverage: os.loadavg(),
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem()
    },
    cpus: os.cpus().map(cpu => cpu.model)
  };

  const checks = await Promise.all([
    command('Disk usage', 'df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs']),
    command('Block devices', 'lsblk', ['-o', 'NAME,SIZE,FSTYPE,MOUNTPOINTS,MODEL']),
    command('Top memory processes', 'ps', ['-eo', 'pid,ppid,comm,%mem,%cpu,args', '--sort=-%mem']),
    command('Network addresses', 'ip', ['-brief', 'addr']),
    command('Listening TCP/UDP services', 'ss', ['-tulpn']),
    command('Recent journal errors', 'journalctl', ['-p', '3', '-n', '50', '--no-pager'], 7000),
    command('Large files under home', 'find', [os.homedir(), '-xdev', '-type', 'f', '-size', '+500M', '-printf', '%s %p\n'], 7000)
  ]);

  return { staticInfo, checks };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function html() {
  const defaultFilePath = escapeHtml(os.homedir());
  const ollamaModel = escapeHtml(OLLAMA_MODEL);
  const ollamaHost = escapeHtml(OLLAMA_BASE_URL);
  const llmTemperature = escapeHtml(LLM_TEMPERATURE);
  const llmContextSize = escapeHtml(LLM_CONTEXT_SIZE);
  const systemPrompt = escapeHtml(DEFAULT_SYSTEM_PROMPT);
  const devicesJson = JSON.stringify(DEVICES);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qwen System Assistant</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#111827;color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:24px}.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin:16px 0}button{background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}input,select{border-radius:10px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;padding:10px}input[type=text]{min-width:280px}select{min-width:280px;cursor:pointer}textarea{width:100%;min-height:130px;border-radius:10px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;padding:12px}pre{white-space:pre-wrap;overflow:auto;background:#0b1020;border-radius:10px;padding:14px}.muted{color:#9ca3af}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.badge{background:#374151;border-radius:6px;padding:2px 8px;font-size:.8em;color:#9ca3af}.browser{margin-top:12px;border:1px solid #374151;border-radius:10px;padding:10px;max-height:220px;overflow:auto}.dir{display:block;width:100%;text-align:left;background:#374151;margin:6px 0}.help{color:#fbbf24}</style>
</head>
<body><main>
<h1>Qwen System Assistant</h1>
<p class="muted">Collect read-only system context and ask <code>${ollamaModel}</code> through Ollama at <code>${ollamaHost}</code>. Prompts are compacted for smaller local models.</p>
<div class="card">
  <h2 style="margin-top:0">Device</h2>
  <div class="row">
    <select id="device"></select>
    <span id="deviceInfo" class="muted"></span>
  </div>
  <p class="muted" style="margin-bottom:0">Select a Tailscale device to scan via SSH, or scan the local machine directly.</p>
</div>
<div class="card">
  <div class="row"><button id="scan">Scan System</button><button id="ask">Send to AI</button><span id="status" class="muted">Idle</span></div>
  <p class="muted">Gathers disk, process, network, journal, and system info. Remote devices are scanned via SSH.</p>
</div>
<div class="card">
  <h2>Local LLM Settings</h2>
  <div class="row"><label>Endpoint <input id="ollamaEndpoint" type="text" value="${ollamaHost}"></label><button id="testOllama">Test Connection</button><button id="ensureDesktopOllama">Start Desktop Ollama via SSH</button></div>
  <div class="row"><label>Preset <select id="modelPreset"><option value="">Custom</option><option value="fast">Fast/small model</option><option value="coding">Coding model</option><option value="reasoning">Large reasoning model</option><option value="visionOff">Vision disabled fallback</option></select></label><label>Active model <select id="ollamaModel"><option value="${ollamaModel}">${ollamaModel}</option></select></label><button id="refreshModels">Refresh Models</button><button id="deleteModel">Delete Selected</button></div>
  <div class="row"><label>Context <input id="llmContextSize" type="number" min="1024" step="1024" value="${llmContextSize}"></label><label>Temperature <input id="llmTemperature" type="number" min="0" max="2" step="0.1" value="${llmTemperature}"></label></div>
  <label>System prompt<textarea id="systemPrompt">${systemPrompt}</textarea></label>
  <div class="row"><label>Pull model <input id="pullModelName" type="text" placeholder="llama3.1:8b"></label><button id="pullModel">Pull Model</button></div>
  <pre id="modelList">Click Refresh Models to list Ollama models on ${ollamaHost}.</pre>
  <p class="muted">Supports Ollama-compatible endpoints such as localhost or a LAN/Tailscale URL. Use SSH start for desktop-glpggos if Ollama is not already serving.</p>
</div>
<div class="card">
  <h2>File Scan</h2>
  <div class="row"><label>Path <input id="filePath" type="text" value="${defaultFilePath}"></label><label>Depth <input id="fileDepth" type="number" min="0" max="${MAX_FILE_SCAN_DEPTH}" value="2"></label><button id="browseFiles">Browse</button><button id="fileUp">Up</button><button id="fileHome">Home</button><button id="fileScan">Scan Files</button></div>
  <div id="fileBrowser" class="browser muted">Click Browse to list child folders for the selected path.</div>
  <p class="muted">Scans file names and metadata only. For Linux remote devices, uses SSH + <code>find</code>. For Windows, uses PowerShell over OpenSSH. Depth 0 = selected path only; up to ${MAX_FILE_SCAN_DEPTH} levels.</p>
</div>
<div class="card"><h2>Question</h2><textarea id="prompt">Review this compact Linux system summary. List the top 3 risks or issues and give safe next-step commands. Be concise.</textarea></div>
<div class="card"><h2>Collected Context</h2><pre id="context">No scan yet.</pre></div>
<div class="card"><h2>AI Analysis</h2><pre id="answer">No analysis yet.</pre></div>
<script>
const DEVICES=${devicesJson};
let context=null;
let fileScan=null;
const statusEl=document.getElementById('status');
const deviceSel=document.getElementById('device');
const deviceInfo=document.getElementById('deviceInfo');

DEVICES.forEach(d=>{const opt=document.createElement('option');opt.value=d.id;opt.textContent=d.name;deviceSel.appendChild(opt);});
function getDevice(){return DEVICES.find(d=>d.id===deviceSel.value)||DEVICES[0];}
function deviceParam(){const d=getDevice();return d.id==='local'?'':'&device='+encodeURIComponent(d.id);}
deviceSel.onchange=()=>{const d=getDevice();deviceInfo.textContent=d.host?'SSH: '+d.host:'';if(d.fileRoot)document.getElementById('filePath').value=d.fileRoot;if(d.platform==='android')statusEl.textContent='Android not supported for scanning';};

async function api(path,body){const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await res.text();let data;try{data=text?JSON.parse(text):{};}catch(e){data={error:text||res.statusText};}if(!res.ok)throw new Error(data.error||text||res.statusText);return data;}
const ollamaModelSel=document.getElementById('ollamaModel');
function llmSettings(){return{baseUrl:document.getElementById('ollamaEndpoint').value.trim(),model:ollamaModelSel.value,contextSize:Number(document.getElementById('llmContextSize').value)||8192,temperature:Number(document.getElementById('llmTemperature').value)||0,systemPrompt:document.getElementById('systemPrompt').value};}
function renderModels(data){const models=data.models||[];const active=ollamaModelSel.value||data.defaultModel||'${ollamaModel}';ollamaModelSel.innerHTML='';if(!models.some(m=>m.name===active)){const opt=document.createElement('option');opt.value=active;opt.textContent=active;ollamaModelSel.appendChild(opt);}models.forEach(m=>{const opt=document.createElement('option');opt.value=m.name;opt.textContent=m.name+(m.size?' ('+formatBytes(m.size)+')':'');ollamaModelSel.appendChild(opt);});ollamaModelSel.value=active;document.getElementById('modelList').textContent=JSON.stringify(data,null,2);}
function formatBytes(bytes){const n=Number(bytes)||0;if(!n)return '';const units=['B','KB','MB','GB','TB'];let value=n;let i=0;while(value>=1024&&i<units.length-1){value/=1024;i++;}return value.toFixed(value>=10||i===0?0:1)+' '+units[i];}
function selectModel(name){if(!name)return;if(![...ollamaModelSel.options].some(opt=>opt.value===name)){const opt=document.createElement('option');opt.value=name;opt.textContent=name;ollamaModelSel.appendChild(opt);}ollamaModelSel.value=name;}
async function refreshModels(){statusEl.textContent='Refreshing Ollama models…';try{const data=await api('/api/ollama/models?baseUrl='+encodeURIComponent(llmSettings().baseUrl));renderModels(data);statusEl.textContent='Model list refreshed';}catch(e){statusEl.textContent='Model refresh failed';document.getElementById('modelList').textContent=e.message;}}
document.getElementById('refreshModels').onclick=refreshModels;
document.getElementById('testOllama').onclick=async()=>{statusEl.textContent='Testing Ollama connection…';try{const data=await api('/api/ollama/test',{...llmSettings()});document.getElementById('modelList').textContent=JSON.stringify(data,null,2);statusEl.textContent=data.warning||'Ollama connection OK';}catch(e){statusEl.textContent='Ollama test failed';document.getElementById('modelList').textContent=e.message;}};
document.getElementById('ensureDesktopOllama').onclick=async()=>{statusEl.textContent='Starting desktop Ollama over SSH…';try{const data=await api('/api/ollama/ensure-desktop',{});document.getElementById('modelList').textContent=JSON.stringify(data,null,2);await refreshModels();statusEl.textContent='Desktop Ollama start/check complete';}catch(e){statusEl.textContent='Desktop Ollama SSH start failed';document.getElementById('modelList').textContent=e.message;}};
document.getElementById('modelPreset').onchange=()=>{const p=document.getElementById('modelPreset').value;if(p==='fast')selectModel('deepseek-r1:1.5b');if(p==='coding')selectModel('qwen3-coder:30b');if(p==='reasoning')selectModel('deepseek-r1:8b');if(p==='visionOff')selectModel('qwen2.5-coder:14b');};
document.getElementById('pullModel').onclick=async()=>{const name=document.getElementById('pullModelName').value.trim();if(!name){statusEl.textContent='Enter a model name to pull';return;}statusEl.textContent='Pulling '+name+'…';try{const data=await api('/api/ollama/pull',{name,baseUrl:llmSettings().baseUrl});document.getElementById('modelList').textContent=JSON.stringify(data,null,2);await refreshModels();statusEl.textContent='Pulled '+name;}catch(e){statusEl.textContent='Pull failed';document.getElementById('modelList').textContent=e.message;}};
document.getElementById('deleteModel').onclick=async()=>{const name=ollamaModelSel.value;if(!name){statusEl.textContent='Select a model to delete';return;}if(!confirm('Delete Ollama model '+name+' from the selected endpoint?'))return;statusEl.textContent='Deleting '+name+'…';try{const data=await api('/api/ollama/delete',{name,baseUrl:llmSettings().baseUrl});document.getElementById('modelList').textContent=JSON.stringify(data,null,2);await refreshModels();statusEl.textContent='Deleted '+name;}catch(e){statusEl.textContent='Delete failed';document.getElementById('modelList').textContent=e.message;}};
refreshModels();
async function browseFiles(pathOverride){const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH browsing not supported';return;}const input=document.getElementById('filePath');const root=encodeURIComponent(pathOverride||input.value);statusEl.textContent='Browsing folders'+(d.id!=='local'?' on '+d.name+' via SSH':'')+'…';try{const data=await api('/api/file-browse?path='+root+deviceParam());input.value=data.root;renderBrowser(data);statusEl.textContent='Folder browse complete';}catch(e){statusEl.textContent='Folder browse failed';document.getElementById('fileBrowser').textContent=e.message;}}
function renderBrowser(data){const box=document.getElementById('fileBrowser');box.innerHTML='';if(data.errors&&data.errors.length){const p=document.createElement('p');p.className='help';p.textContent=(data.errors[0].help||data.errors[0].message);box.appendChild(p);}const meta=document.createElement('p');meta.className='muted';meta.textContent=(data.directories||[]).length+' folders under '+data.root;box.appendChild(meta);(data.directories||[]).forEach(dir=>{const b=document.createElement('button');b.className='dir';b.textContent='📁 '+dir.name;b.onclick=()=>browseFiles(dir.path);box.appendChild(b);});box.dataset.parent=data.parent||'';}
document.getElementById('browseFiles').onclick=()=>browseFiles();
document.getElementById('fileUp').onclick=()=>{const parent=document.getElementById('fileBrowser').dataset.parent;if(parent)browseFiles(parent);};
document.getElementById('fileHome').onclick=()=>{document.getElementById('filePath').value='${defaultFilePath}';browseFiles('${defaultFilePath}');};
document.getElementById('scan').onclick=async()=>{const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH scanning not supported';return;}statusEl.textContent='Scanning'+(d.id!=='local'?' '+d.name+' via SSH':'')+'…';try{context=await api('/api/scan?'+deviceParam());document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='Scan complete';}catch(e){statusEl.textContent='Scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('fileScan').onclick=async()=>{const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH scanning not supported';return;}const root=encodeURIComponent(document.getElementById('filePath').value);const depth=encodeURIComponent(document.getElementById('fileDepth').value);statusEl.textContent='Scanning files'+(d.id!=='local'?' on '+d.name+' via SSH':'')+'…';try{fileScan=await api('/api/file-scan?path='+root+'&depth='+depth+deviceParam());document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='File scan complete';}catch(e){statusEl.textContent='File scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('ask').onclick=async()=>{const askButton=document.getElementById('ask');askButton.disabled=true;statusEl.textContent='Asking AI… this can take several minutes on local models';document.getElementById('answer').textContent='Waiting for model response…';try{if(!context&&!fileScan)context=await api('/api/scan?'+deviceParam());const result=await api('/api/analyze',{prompt:document.getElementById('prompt').value,context:{system:context,fileScan},...llmSettings()});document.getElementById('answer').textContent=result.response||JSON.stringify(result,null,2);statusEl.textContent='Analysis complete';}catch(e){statusEl.textContent='AI request failed';document.getElementById('answer').textContent=e.message;}finally{askButton.disabled=false;}};
</script></main></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function getAbortSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  if (AbortSignal.timeout) return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function normalizeOllamaBaseUrl(value) {
  return String(value || OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
}

function ollamaErrorMessage(error, baseUrl = OLLAMA_BASE_URL) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `Ollama request to ${baseUrl} timed out after ${Math.round(OLLAMA_REQUEST_TIMEOUT_MS / 1000)} seconds. Confirm Ollama is running, use a smaller model, or increase OLLAMA_REQUEST_TIMEOUT_MS.`;
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network/i.test(error?.message || '')) {
    return `Could not reach Ollama at ${baseUrl}. Start it with "ollama serve", verify the endpoint URL, and ensure the firewall allows connections to port 11434.`;
  }
  return `Ollama request to ${baseUrl} failed: ${error.message}`;
}

async function ollamaJson(pathname, options = {}, baseUrl = OLLAMA_BASE_URL) {
  const target = normalizeOllamaBaseUrl(baseUrl);
  let response;
  try {
    response = await fetch(`${target}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      signal: options.signal || getAbortSignal(OLLAMA_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(ollamaErrorMessage(error, target));
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch (_) { throw new Error(`Malformed Ollama response from ${target}${pathname}: ${text.slice(0, 300)}`); }
  }
  if (!response.ok) {
    const detail = data.error || text || response.statusText;
    if (response.status === 404 && /model/i.test(detail)) throw new Error(`Ollama model is not installed or not available at ${target}: ${detail}`);
    throw new Error(`Ollama returned HTTP ${response.status} from ${target}${pathname}: ${detail}`);
  }
  return data;
}

async function listOllamaModels(baseUrl = OLLAMA_BASE_URL) {
  const target = normalizeOllamaBaseUrl(baseUrl);
  const tags = await ollamaJson('/api/tags', {}, target);
  let running = [];
  try {
    const ps = await ollamaJson('/api/ps', {}, target);
    running = Array.isArray(ps.models) ? ps.models : [];
  } catch (_) {
    running = [];
  }
  return { provider: LLM_PROVIDER, host: target, defaultModel: OLLAMA_MODEL, contextSize: LLM_CONTEXT_SIZE, temperature: LLM_TEMPERATURE, systemPrompt: DEFAULT_SYSTEM_PROMPT, models: Array.isArray(tags.models) ? tags.models : [], running };
}

async function testOllamaConnection(baseUrl = OLLAMA_BASE_URL, model = OLLAMA_MODEL) {
  const models = await listOllamaModels(baseUrl);
  const installed = models.models.some(item => item.name === model);
  return { ...models, ok: true, selectedModel: model, installed, warning: installed ? null : `Model ${model} is not installed at ${models.host}. Pull it before using it, or choose an installed model.` };
}

async function pullOllamaModel(name, baseUrl = OLLAMA_BASE_URL) {
  if (!name || !String(name).trim()) throw new Error('Model name is required');
  return ollamaJson('/api/pull', { method: 'POST', body: JSON.stringify({ name: String(name).trim(), stream: false }) }, baseUrl);
}

async function deleteOllamaModel(name, baseUrl = OLLAMA_BASE_URL) {
  if (!name || !String(name).trim()) throw new Error('Model name is required');
  return ollamaJson('/api/delete', { method: 'DELETE', body: JSON.stringify({ name: String(name).trim() }) }, baseUrl);
}

async function ensureDesktopOllama() {
  const device = DEVICES.find(d => d.id === 'desktop-glpggos');
  if (!device) throw new Error('desktop-glpggos device is not configured');
  const cmd = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$existing = Get-Process ollama -ErrorAction SilentlyContinue',
    'if (-not $existing) { Start-Process -FilePath ollama -ArgumentList "serve" -WindowStyle Hidden; Start-Sleep -Seconds 2 }',
    '$running = Get-Process ollama -ErrorAction SilentlyContinue',
    '[pscustomobject]@{running=[bool]$running; processes=@($running | Select-Object -ExpandProperty Id)} | ConvertTo-Json -Compress'
  ].join('; ');
  const raw = await sshDeviceCommand('Ensure desktop Ollama is running', device, powershellCommand(cmd), 15000);
  return { ok: raw.ok, remoteHost: device.host, output: raw.output, help: raw.help };
}

async function findInstalledModel(requestedModel, baseUrl = OLLAMA_BASE_URL) {
  try {
    const data = await ollamaJson('/api/tags', {}, baseUrl);
    const models = Array.isArray(data.models) ? data.models : [];
    const exact = models.find(model => model.name === requestedModel);
    if (exact) return exact.name;
    const taggedMatch = models.find(model => model.name && model.name.startsWith(`${requestedModel}:`));
    return taggedMatch ? taggedMatch.name : null;
  } catch (error) {
    return null;
  }
}

function truncateString(value, maxLength) {
  const text = String(value || '');
  if (!Number.isFinite(maxLength) || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n… truncated ${text.length - maxLength} characters …`;
}

function compactSystemContext(system) {
  if (!system) return null;
  return {
    staticInfo: system.staticInfo,
    checks: Array.isArray(system.checks) ? system.checks.map(check => ({
      label: check.label,
      command: check.command,
      ok: check.ok,
      output: truncateString(check.output, 1500)
    })) : []
  };
}

function compactFileScan(fileScan) {
  if (!fileScan) return null;
  return {
    root: fileScan.root,
    maxDepth: fileScan.maxDepth,
    collectedAt: fileScan.collectedAt,
    limits: fileScan.limits,
    summary: fileScan.summary,
    largestFiles: Array.isArray(fileScan.largestFiles) ? fileScan.largestFiles.slice(0, 10) : [],
    recentlyModified: Array.isArray(fileScan.recentlyModified) ? fileScan.recentlyModified.slice(0, 10) : [],
    errors: Array.isArray(fileScan.errors) ? fileScan.errors.slice(0, 10) : [],
    entries: Array.isArray(fileScan.entries) ? fileScan.entries.slice(0, 80) : []
  };
}

function compactContextForModel(context) {
  const compacted = {
    system: compactSystemContext(context?.system || context),
    fileScan: compactFileScan(context?.fileScan)
  };
  let serialized = JSON.stringify(compacted, null, 2);
  if (Number.isFinite(MAX_MODEL_CONTEXT_CHARS) && serialized.length > MAX_MODEL_CONTEXT_CHARS) {
    serialized = `${serialized.slice(0, MAX_MODEL_CONTEXT_CHARS)}\n… context truncated for smaller local model …`;
  }
  return serialized;
}

function buildChatMessages(prompt, context, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const compactContext = compactContextForModel(context);
  return [
    { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: ['Task:', prompt, '', 'Relevant compact JSON context:', compactContext, '', 'Respond with concise findings and exact next steps. If code changes are needed, provide concrete file paths and patch-style edits.'].join('\n') }
  ];
}

async function generateWithModel(model, prompt, context, settings = {}) {
  const baseUrl = normalizeOllamaBaseUrl(settings.baseUrl || OLLAMA_BASE_URL);
  const selectedModel = model || OLLAMA_MODEL;
  const fallbackModel = settings.fallbackModel || OLLAMA_MODEL;
  const body = {
    model: selectedModel,
    stream: true,
    messages: buildChatMessages(prompt, context, settings.systemPrompt),
    options: {
      num_ctx: Number(settings.contextSize || LLM_CONTEXT_SIZE),
      temperature: Number(settings.temperature ?? LLM_TEMPERATURE),
      num_predict: OLLAMA_NUM_PREDICT
    }
  };

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: getAbortSignal(OLLAMA_REQUEST_TIMEOUT_MS),
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(ollamaErrorMessage(error, baseUrl));
  }

  if (!response.ok) {
    const errorText = await response.text();
    const installedModel = response.status === 404 ? await findInstalledModel(selectedModel, baseUrl) : null;
    if (!installedModel && fallbackModel && fallbackModel !== selectedModel) {
      return { ...(await generateWithModel(fallbackModel, prompt, context, { ...settings, fallbackModel: null, baseUrl })), fallbackFrom: selectedModel };
    }
    throw new Error(`Ollama chat failed for model ${selectedModel} at ${baseUrl}: HTTP ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await readOllamaChatStream(response);
  return selectedModel === OLLAMA_MODEL ? data : { ...data, model: selectedModel };
}

async function readOllamaChatStream(response) {
  const decoder = new TextDecoder();
  let buffered = '';
  let fullResponse = '';
  let finalData = null;
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.content) fullResponse += data.message.content;
      if (data.response) fullResponse += data.response;
      if (data.done) finalData = data;
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    const data = JSON.parse(buffered);
    if (data.error) throw new Error(data.error);
    if (data.message?.content) fullResponse += data.message.content;
    if (data.response) fullResponse += data.response;
    if (data.done) finalData = data;
  }
  return { ...(finalData || {}), response: fullResponse };
}

async function analyze(prompt, context, settings = {}) {
  return generateWithModel(settings.model || OLLAMA_MODEL, prompt, context, settings);
}

function resolveDevice(deviceId) {
  if (!deviceId || deviceId === 'local') return null;
  const device = DEVICES.find(d => d.id === deviceId);
  if (!device) throw new Error(`Unknown device: ${deviceId}`);
  if (device.platform === 'android') throw new Error(`Android device ${device.name} is not supported for SSH scanning`);
  if (!device.host) return null;
  return device;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }
    if (req.method === 'GET' && req.url === '/api/devices') {
      sendJson(res, 200, { devices: DEVICES });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/scan')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/scan') { sendJson(res, 404, { error: 'Not found' }); return; }
      const device = resolveDevice(url.searchParams.get('device'));
      sendJson(res, 200, device ? (device.platform === 'windows' ? await collectWindowsSystemContext(device) : await collectSshSystemContext(device)) : await collectSystemContext());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/file-browse')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/file-browse') { sendJson(res, 404, { error: 'Not found' }); return; }
      const device = resolveDevice(url.searchParams.get('device'));
      const browsePath = url.searchParams.get('path') || os.homedir();
      sendJson(res, 200, device ? (device.platform === 'windows' ? await browseWindowsDirectories(device, browsePath) : await browseSshDirectories(device, browsePath)) : await browseLocalDirectories(browsePath));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/file-scan')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/file-scan') { sendJson(res, 404, { error: 'Not found' }); return; }
      const device = resolveDevice(url.searchParams.get('device'));
      const scanPath = url.searchParams.get('path') || os.homedir();
      const depth = url.searchParams.get('depth') || 2;
      sendJson(res, 200, device ? (device.platform === 'windows' ? await collectWindowsFileScan(device, scanPath, depth) : await collectSshFileScan(device, scanPath, depth)) : await scanFiles(scanPath, depth));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/ollama/models')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/ollama/models') { sendJson(res, 404, { error: 'Not found' }); return; }
      sendJson(res, 200, await listOllamaModels(url.searchParams.get('baseUrl') || OLLAMA_BASE_URL));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ollama/test') {
      const body = await readBody(req);
      sendJson(res, 200, await testOllamaConnection(body.baseUrl, body.model || OLLAMA_MODEL));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ollama/ensure-desktop') {
      sendJson(res, 200, await ensureDesktopOllama());
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ollama/pull') {
      const body = await readBody(req);
      sendJson(res, 200, await pullOllamaModel(body.name, body.baseUrl));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ollama/delete') {
      const body = await readBody(req);
      sendJson(res, 200, await deleteOllamaModel(body.name, body.baseUrl));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/analyze') {
      const body = await readBody(req);
      sendJson(res, 200, await analyze(body.prompt || 'Analyze this system.', body.context || await collectSystemContext(), body));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.requestTimeout = OLLAMA_REQUEST_TIMEOUT_MS + 30000;
server.headersTimeout = Math.max(server.headersTimeout, OLLAMA_REQUEST_TIMEOUT_MS + 35000);
server.timeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`Qwen System Assistant listening on http://${HOST}:${PORT}`);
  console.log(`Using Ollama model ${OLLAMA_MODEL} at ${OLLAMA_HOST}`);
  console.log(`Ollama request timeout: ${OLLAMA_REQUEST_TIMEOUT_MS}ms`);
});

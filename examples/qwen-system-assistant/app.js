#!/usr/bin/env node

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8091);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://100.98.112.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:0.5b';
const OLLAMA_REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 512);
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
    sshKey: process.env.WINDOWS_SSH_KEY || '~/.ssh/id_ed25519_windows'
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

function sshDeviceCommand(label, device, remoteCmd, timeout = 10000) {
  return new Promise((resolve) => {
    const settings = buildSshArgs(device, remoteCmd);
    execFile('ssh', settings.args, { timeout, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
      const output = String(stdout || stderr || error?.message || '').slice(0, MAX_OUTPUT);
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

function powershellCommand(command) {
  return `powershell -NoProfile -NonInteractive -Command ${shellQuote(command)}`;
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

function windowsFileUnsupported(device) {
  return {
    error: 'Windows file browsing/scanning is not implemented yet. System scan is supported.',
    remoteHost: device.host,
    platform: 'windows'
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
  const ollamaHost = escapeHtml(OLLAMA_HOST);
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
  <h2>File Scan</h2>
  <div class="row"><label>Path <input id="filePath" type="text" value="${defaultFilePath}"></label><label>Depth <input id="fileDepth" type="number" min="0" max="${MAX_FILE_SCAN_DEPTH}" value="2"></label><button id="browseFiles">Browse</button><button id="fileUp">Up</button><button id="fileHome">Home</button><button id="fileScan">Scan Files</button></div>
  <div id="fileBrowser" class="browser muted">Click Browse to list child folders for the selected path.</div>
  <p class="muted">Scans file names and metadata only. For Linux remote devices, uses SSH + <code>find</code>. Windows file browsing/scanning is not implemented yet. Depth 0 = selected path only; up to ${MAX_FILE_SCAN_DEPTH} levels.</p>
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
deviceSel.onchange=()=>{const d=getDevice();deviceInfo.textContent=d.host?'SSH: '+d.host:'';if(d.platform==='android')statusEl.textContent='Android not supported for scanning';};

async function api(path,body){const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await res.text();let data;try{data=text?JSON.parse(text):{};}catch(e){data={error:text||res.statusText};}if(!res.ok)throw new Error(data.error||text||res.statusText);return data;}
async function browseFiles(pathOverride){const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH browsing not supported';return;}const input=document.getElementById('filePath');const root=encodeURIComponent(pathOverride||input.value);statusEl.textContent='Browsing folders'+(d.id!=='local'?' on '+d.name+' via SSH':'')+'…';try{const data=await api('/api/file-browse?path='+root+deviceParam());input.value=data.root;renderBrowser(data);statusEl.textContent='Folder browse complete';}catch(e){statusEl.textContent='Folder browse failed';document.getElementById('fileBrowser').textContent=e.message;}}
function renderBrowser(data){const box=document.getElementById('fileBrowser');box.innerHTML='';if(data.errors&&data.errors.length){const p=document.createElement('p');p.className='help';p.textContent=(data.errors[0].help||data.errors[0].message);box.appendChild(p);}const meta=document.createElement('p');meta.className='muted';meta.textContent=(data.directories||[]).length+' folders under '+data.root;box.appendChild(meta);(data.directories||[]).forEach(dir=>{const b=document.createElement('button');b.className='dir';b.textContent='📁 '+dir.name;b.onclick=()=>browseFiles(dir.path);box.appendChild(b);});box.dataset.parent=data.parent||'';}
document.getElementById('browseFiles').onclick=()=>browseFiles();
document.getElementById('fileUp').onclick=()=>{const parent=document.getElementById('fileBrowser').dataset.parent;if(parent)browseFiles(parent);};
document.getElementById('fileHome').onclick=()=>{document.getElementById('filePath').value='${defaultFilePath}';browseFiles('${defaultFilePath}');};
document.getElementById('scan').onclick=async()=>{const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH scanning not supported';return;}statusEl.textContent='Scanning'+(d.id!=='local'?' '+d.name+' via SSH':'')+'…';try{context=await api('/api/scan?'+deviceParam());document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='Scan complete';}catch(e){statusEl.textContent='Scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('fileScan').onclick=async()=>{const d=getDevice();if(d.platform==='android'){statusEl.textContent='Android SSH scanning not supported';return;}const root=encodeURIComponent(document.getElementById('filePath').value);const depth=encodeURIComponent(document.getElementById('fileDepth').value);statusEl.textContent='Scanning files'+(d.id!=='local'?' on '+d.name+' via SSH':'')+'…';try{fileScan=await api('/api/file-scan?path='+root+'&depth='+depth+deviceParam());document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='File scan complete';}catch(e){statusEl.textContent='File scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('ask').onclick=async()=>{const askButton=document.getElementById('ask');askButton.disabled=true;statusEl.textContent='Asking AI… this can take several minutes on local models';document.getElementById('answer').textContent='Waiting for model response…';try{if(!context&&!fileScan)context=await api('/api/scan?'+deviceParam());const result=await api('/api/analyze',{prompt:document.getElementById('prompt').value,context:{system:context,fileScan}});document.getElementById('answer').textContent=result.response||JSON.stringify(result,null,2);statusEl.textContent='Analysis complete';}catch(e){statusEl.textContent='AI request failed';document.getElementById('answer').textContent=e.message;}finally{askButton.disabled=false;}};
</script></main></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function findInstalledModel(requestedModel) {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!response.ok) return null;
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const exact = models.find(model => model.name === requestedModel);
    if (exact) return exact.name;

    // If "qwen2.5-coder" is configured but "qwen2.5-coder:0.5b" is installed,
    // retry with the tagged name so existing cards keep working.
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

function getAbortSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  if (AbortSignal.timeout) return AbortSignal.timeout(timeoutMs);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function describeFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `Ollama request timed out after ${Math.round(OLLAMA_REQUEST_TIMEOUT_MS / 1000)} seconds. Increase OLLAMA_REQUEST_TIMEOUT_MS or use a smaller/faster model.`;
  }
  return `Could not reach Ollama at ${OLLAMA_HOST}: ${error.message}. If the model is still running, check that OLLAMA_HOST is reachable from this process and try increasing OLLAMA_REQUEST_TIMEOUT_MS.`;
}

async function readOllamaStream(response) {
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
      if (data.response) fullResponse += data.response;
      if (data.done) finalData = data;
    }
  }

  buffered += decoder.decode();
  if (buffered.trim()) {
    const data = JSON.parse(buffered);
    if (data.error) throw new Error(data.error);
    if (data.response) fullResponse += data.response;
    if (data.done) finalData = data;
  }

  return { ...(finalData || {}), response: fullResponse };
}

async function generateWithModel(model, prompt, context) {
  const compactContext = compactContextForModel(context);
  let response;
  try {
    response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: getAbortSignal(OLLAMA_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: true,
        options: {
          num_ctx: OLLAMA_NUM_CTX,
          num_predict: OLLAMA_NUM_PREDICT
        },
        prompt: `${prompt}\n\nUse only this compact JSON context. If details are missing, say what to inspect next.\n${compactContext}`
      })
    });
  } catch (error) {
    throw new Error(describeFetchError(error));
  }

  if (!response.ok) {
    const errorText = await response.text();
    const installedModel = response.status === 404 ? await findInstalledModel(model) : null;
    if (installedModel && installedModel !== model) {
      console.log(`Ollama model ${model} was not found; retrying with installed model ${installedModel}`);
      return generateWithModel(installedModel, prompt, context);
    }

    throw new Error(`Ollama returned HTTP ${response.status}: ${errorText}. Check OLLAMA_MODEL; Ollama model names include tags such as qwen2.5-coder:0.5b.`);
  }

  const data = await readOllamaStream(response);
  return model === OLLAMA_MODEL ? data : { ...data, model };
}

async function analyze(prompt, context) {
  return generateWithModel(OLLAMA_MODEL, prompt, context);
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
      sendJson(res, 200, device ? (device.platform === 'windows' ? windowsFileUnsupported(device) : await browseSshDirectories(device, browsePath)) : await browseLocalDirectories(browsePath));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/file-scan')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/file-scan') { sendJson(res, 404, { error: 'Not found' }); return; }
      const device = resolveDevice(url.searchParams.get('device'));
      const scanPath = url.searchParams.get('path') || os.homedir();
      const depth = url.searchParams.get('depth') || 2;
      sendJson(res, 200, device ? (device.platform === 'windows' ? windowsFileUnsupported(device) : await collectSshFileScan(device, scanPath, depth)) : await scanFiles(scanPath, depth));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/analyze') {
      const body = await readBody(req);
      sendJson(res, 200, await analyze(body.prompt || 'Analyze this system.', body.context || await collectSystemContext()));
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

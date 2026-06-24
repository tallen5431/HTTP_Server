#!/usr/bin/env node

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8091);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const MAX_OUTPUT = 12000;
const MAX_FILE_SCAN_DEPTH = 8;
const MAX_FILE_SCAN_ENTRIES = 500;
const MAX_FILE_SCAN_VISITED = 5000;

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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qwen System Assistant</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#111827;color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:24px}.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin:16px 0}button{background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}input{border-radius:10px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;padding:10px}input[type=text]{min-width:320px}textarea{width:100%;min-height:130px;border-radius:10px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;padding:12px}pre{white-space:pre-wrap;overflow:auto;background:#0b1020;border-radius:10px;padding:14px}.muted{color:#9ca3af}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}</style>
</head>
<body><main>
<h1>Qwen System Assistant</h1>
<p class="muted">Collect read-only Linux context and ask <code>${OLLAMA_MODEL}</code> through Ollama at <code>${OLLAMA_HOST}</code>.</p>
<div class="card">
  <div class="row"><button id="scan">Scan System</button><button id="ask">Send to AI</button><span id="status" class="muted">Idle</span></div>
  <p class="muted">The scan gathers disk, process, network, journal, and large-file summaries using allow-listed commands.</p>
</div>
<div class="card">
  <h2>File Scan</h2>
  <div class="row"><label>Path <input id="filePath" type="text" value="${defaultFilePath}"></label><label>Depth <input id="fileDepth" type="number" min="0" max="${MAX_FILE_SCAN_DEPTH}" value="2"></label><button id="fileScan">Scan Files</button></div>
  <p class="muted">Scans file names and metadata only. Depth 0 scans just the selected path; higher depths include child directories up to ${MAX_FILE_SCAN_DEPTH} levels.</p>
</div>
<div class="card"><h2>Question</h2><textarea id="prompt">Review this Linux system context and any file scan context. Identify operational risks, storage or process issues, and useful next steps. Keep commands safe and explain why.</textarea></div>
<div class="card"><h2>Collected Context</h2><pre id="context">No scan yet.</pre></div>
<div class="card"><h2>AI Analysis</h2><pre id="answer">No analysis yet.</pre></div>
<script>
let context=null;
let fileScan=null;
const statusEl=document.getElementById('status');
async function api(path, body){const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!res.ok)throw new Error(await res.text());return res.json();}
document.getElementById('scan').onclick=async()=>{statusEl.textContent='Scanning…';try{context=await api('/api/scan');document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='Scan complete';}catch(e){statusEl.textContent='Scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('fileScan').onclick=async()=>{const root=encodeURIComponent(document.getElementById('filePath').value);const depth=encodeURIComponent(document.getElementById('fileDepth').value);statusEl.textContent='Scanning files…';try{fileScan=await api('/api/file-scan?path='+root+'&depth='+depth);document.getElementById('context').textContent=JSON.stringify({system:context,fileScan},null,2);statusEl.textContent='File scan complete';}catch(e){statusEl.textContent='File scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('ask').onclick=async()=>{statusEl.textContent='Asking AI…';try{if(!context&&!fileScan)context=await api('/api/scan');const result=await api('/api/analyze',{prompt:document.getElementById('prompt').value,context:{system:context,fileScan}});document.getElementById('answer').textContent=result.response;statusEl.textContent='Analysis complete';}catch(e){statusEl.textContent='AI request failed';document.getElementById('answer').textContent=e.message;}};
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

    // Ollama model names are tag-sensitive. If the saved manager config says
    // "qwen2.5-coder" but the installed model is "qwen2.5-coder:7b",
    // retry with the installed tag so existing cards keep working.
    const taggedMatch = models.find(model => model.name && model.name.startsWith(`${requestedModel}:`));
    return taggedMatch ? taggedMatch.name : null;
  } catch (error) {
    return null;
  }
}

async function generateWithModel(model, prompt, context) {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      prompt: `${prompt}\n\nSystem context JSON:\n${JSON.stringify(context, null, 2)}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const installedModel = response.status === 404 ? await findInstalledModel(model) : null;
    if (installedModel && installedModel !== model) {
      console.log(`Ollama model ${model} was not found; retrying with installed model ${installedModel}`);
      return generateWithModel(installedModel, prompt, context);
    }

    throw new Error(`Ollama returned HTTP ${response.status}: ${errorText}. Check OLLAMA_MODEL; Ollama model names include tags such as qwen2.5-coder:7b.`);
  }

  const data = await response.json();
  return model === OLLAMA_MODEL ? data : { ...data, model };
}

async function analyze(prompt, context) {
  return generateWithModel(OLLAMA_MODEL, prompt, context);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }
    if (req.method === 'GET' && req.url === '/api/scan') {
      sendJson(res, 200, await collectSystemContext());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/file-scan')) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/file-scan') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, await scanFiles(url.searchParams.get('path') || os.homedir(), url.searchParams.get('depth') || 2));
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

server.listen(PORT, HOST, () => {
  console.log(`Qwen System Assistant listening on http://${HOST}:${PORT}`);
  console.log(`Using Ollama model ${OLLAMA_MODEL} at ${OLLAMA_HOST}`);
});

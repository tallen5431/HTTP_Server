#!/usr/bin/env node

const http = require('http');
const { execFile } = require('child_process');
const os = require('os');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8091);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder';
const MAX_OUTPUT = 12000;

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

function html() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qwen System Assistant</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#111827;color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:24px}.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin:16px 0}button{background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}textarea{width:100%;min-height:130px;border-radius:10px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;padding:12px}pre{white-space:pre-wrap;overflow:auto;background:#0b1020;border-radius:10px;padding:14px}.muted{color:#9ca3af}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}</style>
</head>
<body><main>
<h1>Qwen System Assistant</h1>
<p class="muted">Collect read-only Linux context and ask <code>${OLLAMA_MODEL}</code> through Ollama at <code>${OLLAMA_HOST}</code>.</p>
<div class="card">
  <div class="row"><button id="scan">Scan System</button><button id="ask">Send to AI</button><span id="status" class="muted">Idle</span></div>
  <p class="muted">The scan gathers disk, process, network, journal, and large-file summaries using allow-listed commands.</p>
</div>
<div class="card"><h2>Question</h2><textarea id="prompt">Review this Linux system context. Identify operational risks, storage or process issues, and useful next steps. Keep commands safe and explain why.</textarea></div>
<div class="card"><h2>Collected Context</h2><pre id="context">No scan yet.</pre></div>
<div class="card"><h2>AI Analysis</h2><pre id="answer">No analysis yet.</pre></div>
<script>
let context=null;
const statusEl=document.getElementById('status');
async function api(path, body){const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!res.ok)throw new Error(await res.text());return res.json();}
document.getElementById('scan').onclick=async()=>{statusEl.textContent='Scanning…';try{context=await api('/api/scan');document.getElementById('context').textContent=JSON.stringify(context,null,2);statusEl.textContent='Scan complete';}catch(e){statusEl.textContent='Scan failed';document.getElementById('context').textContent=e.message;}};
document.getElementById('ask').onclick=async()=>{if(!context)document.getElementById('scan').click();statusEl.textContent='Asking AI…';try{const result=await api('/api/analyze',{prompt:document.getElementById('prompt').value,context});document.getElementById('answer').textContent=result.response;statusEl.textContent='Analysis complete';}catch(e){statusEl.textContent='AI request failed';document.getElementById('answer').textContent=e.message;}};
</script></main></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function analyze(prompt, context) {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      prompt: `${prompt}\n\nSystem context JSON:\n${JSON.stringify(context, null, 2)}`
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
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

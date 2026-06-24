#!/usr/bin/env python3
"""Browser UI for real-time microphone + WAV file transcription with a local Vosk model."""

import base64
import hashlib
import html
import json
import os
import struct
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8090"))
MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", os.path.join(os.getcwd(), "model"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from vosk import Model
                if not os.path.isdir(MODEL_PATH):
                    raise RuntimeError(f"Vosk model directory not found: {MODEL_PATH}")
                print(f"Loading Vosk model from {MODEL_PATH}…", flush=True)
                _model = Model(MODEL_PATH)
                print("Model loaded.", flush=True)
    return _model


INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vosk Voice Transcriber</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; background: #f7f7fb; color: #222; }
    main { max-width: 760px; margin: auto; background: white; border-radius: 16px; padding: 2rem; box-shadow: 0 8px 30px #0001; }
    button { padding: .7rem 1.5rem; border: 0; border-radius: 8px; color: white; cursor: pointer; font-size: 1rem; margin-block: .5rem; }
    #startBtn  { background: #16a34a; }
    #stopBtn   { background: #dc2626; display: none; }
    .file-btn  { background: #2563eb; }
    pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 1rem; border-radius: 8px; min-height: 5rem; }
    .hint { color: #4b5563; font-size: .9rem; }
    .warn { color: #92400e; background: #fef3c7; border-radius: 8px; padding: .75rem 1rem; font-size: .9rem; display: none; margin-bottom: 1rem; }
    .section { border-top: 1px solid #e5e7eb; margin-top: 1.5rem; padding-top: 1.5rem; }
    #statusLine { color: #6b7280; font-size: .9rem; min-height: 1.4em; }
    input[type=file] { display: block; margin-block: .75rem; }
  </style>
</head>
<body>
<main>
  <h1>🎙️ Vosk Voice Transcriber</h1>

  <div id="httpsWarn" class="warn">
    ⚠️ Microphone access requires HTTPS. On Tailscale, run
    <code>tailscale serve PORT</code> to get a secure HTTPS URL, then open that instead.
  </div>

  <h2>Live Microphone</h2>
  <p class="hint">Streams audio from your microphone and transcribes in real-time.</p>
  <p id="statusLine">Ready</p>
  <button id="startBtn">🎙️ Start Recording</button>
  <button id="stopBtn">⏹ Stop</button>
  <h3>Live Transcript</h3>
  <pre id="liveResult">Press Start to begin…</pre>

  <div class="section">
    <h2>Upload WAV File</h2>
    <p class="hint">Upload a mono 16-bit PCM WAV file as a fallback.</p>
    <form id="uploadForm">
      <input id="audio" name="audio" type="file" accept="audio/wav,.wav" required>
      <button type="submit" class="file-btn">Transcribe File</button>
    </form>
    <h3>Result</h3>
    <pre id="fileResult">Waiting for audio…</pre>
  </div>
</main>
<script>
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  document.getElementById('httpsWarn').style.display = 'block';
}

// File upload
const uploadForm = document.getElementById('uploadForm');
const fileResult = document.getElementById('fileResult');
uploadForm.addEventListener('submit', async e => {
  e.preventDefault();
  fileResult.textContent = 'Transcribing…';
  const r = await fetch('/api/transcribe', { method: 'POST', body: new FormData(uploadForm) });
  const p = await r.json();
  fileResult.textContent = p.text || p.error || JSON.stringify(p, null, 2);
});

// Live mic
const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const liveResult = document.getElementById('liveResult');
const statusLine = document.getElementById('statusLine');
let ws, audioCtx, source, processor, stream;

function setStatus(msg) { statusLine.textContent = msg; }

startBtn.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    setStatus('Mic error: ' + err.message);
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/transcribe`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    source    = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = e => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++)
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      ws.send(i16.buffer);
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
    liveResult.dataset.confirmed = '';
    liveResult.textContent = '';
    setStatus('🔴 Recording…');
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'inline-block';
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    const confirmed = liveResult.dataset.confirmed || '';
    if (msg.partial) {
      liveResult.textContent = confirmed + (confirmed ? ' ' : '') + msg.partial + '…';
    } else if (msg.text) {
      liveResult.dataset.confirmed = confirmed + (confirmed ? ' ' : '') + msg.text;
      liveResult.textContent = liveResult.dataset.confirmed;
    }
  };

  ws.onclose = ws.onerror = () => stopRecording();
});

stopBtn.addEventListener('click', stopRecording);

function stopRecording() {
  processor?.disconnect();
  source?.disconnect();
  audioCtx?.close();
  stream?.getTracks().forEach(t => t.stop());
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  setStatus('Ready');
  startBtn.style.display = 'inline-block';
  stopBtn.style.display  = 'none';
}
</script>
</body>
</html>
"""


def _read_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _ws_recv(sock):
    header = _read_exact(sock, 2)
    if not header:
        return None, None
    opcode = header[0] & 0x0f
    masked = (header[1] & 0x80) != 0
    length = header[1] & 0x7f
    if length == 126:
        b = _read_exact(sock, 2)
        if not b:
            return None, None
        length = struct.unpack('>H', b)[0]
    elif length == 127:
        b = _read_exact(sock, 8)
        if not b:
            return None, None
        length = struct.unpack('>Q', b)[0]
    mask = _read_exact(sock, 4) if masked else None
    data = _read_exact(sock, length)
    if data is None:
        return None, None
    if masked and mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def _ws_send(sock, text):
    data = text.encode('utf-8') if isinstance(text, str) else text
    length = len(data)
    header = bytearray([0x81])  # FIN + text opcode
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack('>H', length))
    else:
        header.append(127)
        header.extend(struct.pack('>Q', length))
    sock.sendall(bytes(header) + data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/', '') or self.path.startswith('/?'):
            body = INDEX_HTML.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == '/ws/transcribe':
            self._ws_upgrade()
        else:
            self.send_error(404)

    def _ws_upgrade(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(
            hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()
        ).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self._ws_loop()

    def _ws_loop(self):
        from vosk import KaldiRecognizer
        sock = self.connection
        try:
            rec = KaldiRecognizer(get_model(), 16000)
            while True:
                opcode, data = _ws_recv(sock)
                if opcode is None or opcode == 0x8:  # connection closed
                    break
                if opcode == 0x2:  # binary: Int16 LE PCM @ 16 kHz
                    if rec.AcceptWaveform(data):
                        text = json.loads(rec.Result()).get('text', '')
                        if text:
                            _ws_send(sock, json.dumps({'text': text}))
                    else:
                        partial = json.loads(rec.PartialResult()).get('partial', '')
                        if partial:
                            _ws_send(sock, json.dumps({'partial': partial}))
        except Exception:
            pass

    def do_POST(self):
        if self.path != '/api/transcribe':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_UPLOAD_BYTES:
                raise RuntimeError(f'Upload size out of range (max {MAX_UPLOAD_BYTES} bytes)')
            ct = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in ct:
                raise RuntimeError('Expected multipart/form-data')
            boundary = ct.split('boundary=', 1)[-1].encode()
            body = self.rfile.read(length)
            parts = body.split(b'--' + boundary)
            part = next((p for p in parts if b'name="audio"' in p), None)
            if not part:
                raise RuntimeError('Missing form field: audio')
            _, file_bytes = part.split(b'\r\n\r\n', 1)
            file_bytes = file_bytes.rsplit(b'\r\n', 1)[0]
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                f.write(file_bytes)
                tmp = f.name
            try:
                text = _transcribe_file(tmp)
            finally:
                os.unlink(tmp)
            self._json(200, {'text': text})
        except Exception as exc:
            self._json(400, {'error': html.escape(str(exc))})


def _transcribe_file(filename):
    from vosk import KaldiRecognizer
    with wave.open(filename, 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getcomptype() != 'NONE':
            raise RuntimeError(
                'Audio must be mono 16-bit PCM WAV. '
                'Convert with: ffmpeg -i input -ac 1 -ar 16000 output.wav'
            )
        rec = KaldiRecognizer(get_model(), w.getframerate())
        chunks = []
        while True:
            data = w.readframes(4000)
            if not data:
                break
            if rec.AcceptWaveform(data):
                chunks.append(json.loads(rec.Result()).get('text', ''))
        chunks.append(json.loads(rec.FinalResult()).get('text', ''))
    return ' '.join(p for p in chunks if p).strip()


if __name__ == '__main__':
    port = PORT
    while True:
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError as e:
            if e.errno == 98:  # Address already in use
                print(f'Port {port} in use, trying {port + 1}…', flush=True)
                port += 1
            else:
                raise
    print(f'Vosk transcriber listening on http://{HOST}:{port}', flush=True)
    print(f'Model path: {MODEL_PATH}', flush=True)
    server.serve_forever()

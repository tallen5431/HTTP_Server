#!/usr/bin/env python3
"""Minimal browser UI for transcribing WAV audio with a local Vosk model."""

import html
import json
import os
import tempfile
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8090"))
MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", os.path.join(os.getcwd(), "model"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vosk Voice Transcriber</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; background: #f7f7fb; color: #222; }
    main { max-width: 760px; margin: auto; background: white; border-radius: 16px; padding: 2rem; box-shadow: 0 8px 30px #0001; }
    label, input, button { display: block; margin-block: .75rem; }
    button { padding: .7rem 1rem; border: 0; border-radius: 8px; background: #2563eb; color: white; cursor: pointer; }
    pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 1rem; border-radius: 8px; min-height: 6rem; }
    .hint { color: #4b5563; }
  </style>
</head>
<body>
  <main>
    <h1>🎙️ Vosk Voice Transcriber</h1>
    <p class="hint">Upload a mono PCM WAV file. The app uses the local model configured by <code>VOSK_MODEL_PATH</code>.</p>
    <form id="transcribe-form">
      <label for="audio">Audio file</label>
      <input id="audio" name="audio" type="file" accept="audio/wav,.wav" required>
      <button type="submit">Transcribe</button>
    </form>
    <h2>Result</h2>
    <pre id="result">Waiting for audio…</pre>
  </main>
  <script>
    const form = document.getElementById('transcribe-form');
    const result = document.getElementById('result');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      result.textContent = 'Transcribing…';
      const response = await fetch('/api/transcribe', { method: 'POST', body: new FormData(form) });
      const payload = await response.json();
      result.textContent = payload.text || payload.error || JSON.stringify(payload, null, 2);
    });
  </script>
</body>
</html>
"""


def transcribe_wav(filename):
  try:
    from vosk import KaldiRecognizer, Model
  except ImportError as exc:
    raise RuntimeError("Python package 'vosk' is not installed. Run: python3 -m pip install -r requirements.txt") from exc

  if not os.path.isdir(MODEL_PATH):
    raise RuntimeError(f"Vosk model directory not found: {MODEL_PATH}")

  with wave.open(filename, "rb") as audio:
    if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
      raise RuntimeError("Audio must be mono PCM WAV. Convert with: ffmpeg -i input -ac 1 -ar 16000 output.wav")

    model = Model(MODEL_PATH)
    recognizer = KaldiRecognizer(model, audio.getframerate())
    chunks = []

    while True:
      data = audio.readframes(4000)
      if not data:
        break
      if recognizer.AcceptWaveform(data):
        chunks.append(json.loads(recognizer.Result()).get("text", ""))

    chunks.append(json.loads(recognizer.FinalResult()).get("text", ""))
    return " ".join(part for part in chunks if part).strip()


class Handler(BaseHTTPRequestHandler):
  def _send_json(self, status, payload):
    body = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    if self.path == "/" or self.path.startswith("/?"):
      body = INDEX_HTML.encode("utf-8")
      self.send_response(200)
      self.send_header("Content-Type", "text/html; charset=utf-8")
      self.send_header("Content-Length", str(len(body)))
      self.end_headers()
      self.wfile.write(body)
      return

    self.send_error(404)

  def do_POST(self):
    if self.path != "/api/transcribe":
      self.send_error(404)
      return

    try:
      content_length = int(self.headers.get("Content-Length", "0"))
      if content_length <= 0 or content_length > MAX_UPLOAD_BYTES:
        raise RuntimeError(f"Upload must be between 1 byte and {MAX_UPLOAD_BYTES} bytes")

      content_type = self.headers.get("Content-Type", "")
      if "multipart/form-data" not in content_type:
        raise RuntimeError("Expected multipart/form-data upload")

      boundary = content_type.split("boundary=", 1)[-1].encode("utf-8")
      body = self.rfile.read(content_length)
      parts = body.split(b"--" + boundary)
      audio_part = next((part for part in parts if b'name="audio"' in part), None)
      if not audio_part:
        raise RuntimeError("Missing form field: audio")

      _, file_bytes = audio_part.split(b"\r\n\r\n", 1)
      file_bytes = file_bytes.rsplit(b"\r\n", 1)[0]
      with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
        temp_file.write(file_bytes)
        temp_name = temp_file.name

      try:
        text = transcribe_wav(temp_name)
      finally:
        os.unlink(temp_name)

      self._send_json(200, {"text": text})
    except Exception as exc:  # Return UI-friendly errors for missing deps/model/audio format.
      self._send_json(400, {"error": html.escape(str(exc))})


if __name__ == "__main__":
  print(f"Vosk transcriber listening on http://{HOST}:{PORT}", flush=True)
  print(f"Using Vosk model path: {MODEL_PATH}", flush=True)
  ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

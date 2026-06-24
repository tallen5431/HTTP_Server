# Vosk Voice Transcriber

A small local web app managed by HTTP Server Manager. It accepts mono PCM WAV audio and transcribes it with a local [Vosk](https://alphacephei.com/vosk/) model.

## Setup

1. Install Python dependencies:
   ```bash
   python3 -m pip install -r requirements.txt
   ```
2. Download and unpack a Vosk model into `./model`, or set `VOSK_MODEL_PATH` to an unpacked model directory.
3. Start the program from the manager card, then open the generated URL.

The default service port is `8090` and the default host is `0.0.0.0`.

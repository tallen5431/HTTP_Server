# Qwen System Assistant

A bundled HTTP Server Manager program that connects to an Ollama-compatible local LLM endpoint such as `qwen3-coder:30b` and gathers read-only system context for analysis. Linux devices use normal Linux shell commands over SSH, while Windows system scanning uses PowerShell over OpenSSH.

## Requirements

- Ollama running on the host, usually at `http://127.0.0.1:11434`
- A pulled model, for example:

```bash
ollama pull qwen3-coder:30b
```

## Environment

- `HOST` - bind address, default `0.0.0.0`
- `PORT` - web UI port, default `8091`
- `LLM_PROVIDER` - LLM provider, currently `ollama`
- `DESKTOP_OLLAMA_BASE_URL` - Ollama URL for the desktop-glpggos AI worker, default `http://100.98.112.1:11434`
- `OLLAMA_BASE_URL` - Ollama-compatible API URL, defaulting to `DESKTOP_OLLAMA_BASE_URL`; override with `http://localhost:11434` or a LAN URL such as `http://192.168.x.x:11434` for another worker
- `OLLAMA_HOST` - backwards-compatible alias for `OLLAMA_BASE_URL`
- `OLLAMA_MODEL` - default model name, default `qwen3-coder:30b`
- `OLLAMA_REQUEST_TIMEOUT_MS` - maximum time to wait for one Ollama request, default `600000` (10 minutes)
- `LLM_CONTEXT_SIZE` - chat context size sent as Ollama `num_ctx`, default `8192`
- `LLM_TEMPERATURE` - generation temperature, default `0.2`
- `LLM_SYSTEM_PROMPT` - optional reusable system prompt override
- `OLLAMA_NUM_CTX` - backwards-compatible alias for `LLM_CONTEXT_SIZE`
- `OLLAMA_NUM_PREDICT` - maximum generated tokens for concise analysis, default `512`
- `MAX_MODEL_CONTEXT_CHARS` - maximum compacted JSON context sent to the model, default `24000`

- `SSH_USER` - SSH username for Linux remote device scanning, default `tj`
- `SSH_KEY` - optional default SSH identity key for remote device scanning. Leave empty to use the SSH client defaults.
- `SSH_BATCH_MODE` - keep SSH non-interactive by default (`1`). Set to `0` only when you run the app in a terminal and want SSH to prompt for a password.
- `WINDOWS_SSH_USER` - SSH username for the Windows desktop, default `tjing`
- `WINDOWS_SSH_KEY` - SSH identity key for the Windows desktop, default `$HOME/.ssh/id_ed25519_windows`
- `WINDOWS_FILE_ROOT` - default Windows file browser root, default `C:\Users\tjing`

Example LLM and SSH environment:

```bash
LLM_PROVIDER=ollama
DESKTOP_OLLAMA_BASE_URL=http://100.98.112.1:11434
OLLAMA_BASE_URL=$DESKTOP_OLLAMA_BASE_URL
OLLAMA_MODEL=qwen3-coder:30b
LLM_TEMPERATURE=0.2
LLM_CONTEXT_SIZE=8192
WINDOWS_SSH_USER=tjing
WINDOWS_SSH_KEY=$HOME/.ssh/id_ed25519_windows
SSH_USER=tj
SSH_KEY=
SSH_BATCH_MODE=1
WINDOWS_FILE_ROOT=C:\Users\tjing
```

The app is organized around a **Work Target Device** (the device to scan/analyze/work on) and an **AI Worker** (desktop-glpggos Ollama by default). The Local LLM Settings card lists models available from desktop-glpggos, lets you choose the endpoint URL, active model, context size, temperature, and system prompt for **Send to AI**, pull a new model by name, delete a selected local model, test the connection, and start desktop-glpggos Ollama over SSH. The system scan endpoint runs an allow-listed set of read-only commands with short timeouts. It does not make filesystem changes. AI analysis compacts scan results before sending them to Ollama, caps generated output for concise responses, and uses Ollama's streaming API internally so the app receives model output incrementally instead of waiting silently for a single long response. If a local model is still too slow, raise `OLLAMA_REQUEST_TIMEOUT_MS`, lower `MAX_MODEL_CONTEXT_CHARS`, or choose a smaller installed model.

## Local LLM and Ollama model management

Use the **Local LLM Settings** card to manage the **desktop-glpggos AI worker**. The default endpoint is `http://100.98.112.1:11434`; localhost and other LAN/Tailscale Ollama-compatible endpoints remain supported for overrides.

- **Endpoint** controls the Ollama-compatible base URL used by model listing, pull/delete, test connection, and chat; **Use Desktop Endpoint** restores desktop-glpggos.
- **Start Desktop Ollama via SSH** uses the existing `desktop-glpggos` SSH settings to run `ollama serve` on the Windows desktop if no Ollama process is running.
- **Test Connection** calls `GET /api/tags` and reports whether the selected model is installed.
- **Refresh Models** lists installed models from `GET /api/tags` and currently running models when Ollama supports `/api/ps`.
- **Preset** quickly selects common use cases: fast/small, coding, large reasoning, or a non-vision fallback.
- **Active model**, **Context**, **Temperature**, and **System prompt** are sent to `POST /api/chat` for analysis.
- **Pull Model** downloads a model by name, for example `llama3.1:8b` or `qwen3-coder:30b`.
- **Delete Selected** removes the selected model from the endpoint's local Ollama store after confirmation.

The app sends structured chat messages with a coding-focused system prompt and compact JSON context instead of dumping the whole repo blindly. If the selected model is not available and the configured default differs, the app falls back to the default model once and reports which model failed.

## Running Ollama

Install Ollama from <https://ollama.com/download>, then pull and serve a model:

```bash
ollama pull qwen3-coder:30b
ollama serve
```

For desktop-glpggos, you can either run `ollama serve` manually in PowerShell or click **Start Desktop Ollama via SSH** in the app. Configure the desktop worker endpoint with `DESKTOP_OLLAMA_BASE_URL` / `OLLAMA_BASE_URL`, for example:

```bash
DESKTOP_OLLAMA_BASE_URL=http://100.98.112.1:11434
OLLAMA_BASE_URL=$DESKTOP_OLLAMA_BASE_URL
# or override for a same-machine Ollama worker
OLLAMA_BASE_URL=http://localhost:11434
```

Recommended starting points:

- **3090 Ti / high VRAM desktop:** `qwen3-coder:30b`, `qwen2.5-coder:14b`, or similar larger coding models.
- **Jetson:** small models only, such as 1.5B-3B class models.
- **CPU fallback:** small/fast models; reduce `LLM_CONTEXT_SIZE` and keep `LLM_TEMPERATURE=0.2`.

## Remote device scanning

A device selector at the top of the UI lets you pick from your Tailscale devices. Selecting a remote device runs system scans and file scans via SSH using `BatchMode` (no password prompts). Linux devices continue to use the Linux SSH user (`SSH_USER`, default `tj`) and read-only commands such as `df`, `lsblk`, `ip`, `ss`, and `journalctl`. The Windows desktop uses its own username/key and read-only PowerShell commands over OpenSSH for system scans and file browsing/scanning. The current manual Windows SSH command is:

```bash
ssh -i ~/.ssh/id_ed25519_windows tjing@100.98.112.1
```

The NucBox server must have SSH access to the target device (key-based auth). Android devices are listed but not supported for scanning. If a scan returns `Permission denied (publickey,password)`, Tailscale is routing to the device but SSH authentication failed: verify the reported username, host, and key path. For Linux targets, make sure the target account exists and install the server's public key in that account's `~/.ssh/authorized_keys`.


## File scan

Use the **File Scan** card to collect read-only file and directory metadata for a selected path before asking the AI. Click **Browse** to list child folders for the current path, click a folder to navigate into it, or use **Up** / **Home** to move around before scanning. Set the depth to control how far below the selected path the scan walks:

- `0` scans only the selected path.
- `1` includes direct children.
- Higher values include deeper child directories, up to the built-in depth safety limit of `8`.

The file scan records names, types, sizes, modification times, modes, largest files, recently modified files, and access errors. It does not read file contents or follow symlinks, and it caps traversal at 5,000 visited entries to avoid runaway scans. Linux remote file scans use `find`; Windows remote file scans use read-only PowerShell `Get-ChildItem` metadata collection over OpenSSH.


## Quick manual tests

From the NucBox, verify Windows SSH and PowerShell first:

```bash
ssh -i ~/.ssh/id_ed25519_windows tjing@100.98.112.1 powershell -NoProfile -NonInteractive -Command "hostname; whoami"
```

Then start the app:

```bash
cd ~/Jetson_VR
./Start.sh
```

In the browser, select **desktop-glpggos (Windows)**, click **Scan System**, and confirm the response includes the Windows hostname, `whoami`, OS info, disks, processes, network addresses, and listening ports. Then set the endpoint, click **Start Desktop Ollama via SSH** if needed, click **Test Connection**, click **Refresh Models**, and confirm the Ollama list includes models such as `deepseek-r1:8b`, `llama3.1:8b`, and `qwen3-coder:30b`. Choose a model in **Active model** and click **Send to AI** to run analysis with that model. Then use **Browse** and **Scan Files** with a Windows path such as `C:\Users\tjing` to confirm file metadata is visible from the desktop.

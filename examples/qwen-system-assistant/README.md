# Qwen System Assistant

A bundled HTTP Server Manager program that connects to a local Ollama model such as `qwen2.5-coder:0.5b` and gathers read-only system context for analysis. Linux devices use normal Linux shell commands over SSH, while Windows system scanning uses PowerShell over OpenSSH.

## Requirements

- Ollama running on the host, usually at `http://127.0.0.1:11434`
- A pulled model, for example:

```bash
ollama pull qwen2.5-coder:0.5b
```

## Environment

- `HOST` - bind address, default `0.0.0.0`
- `PORT` - web UI port, default `8091`
- `OLLAMA_HOST` - Ollama API URL, default `http://100.98.112.1:11434` (desktop-glpggos via Tailscale)
- `OLLAMA_MODEL` - model name, default `qwen2.5-coder:0.5b`
- `OLLAMA_REQUEST_TIMEOUT_MS` - maximum time to wait for one Ollama generation, default `600000` (10 minutes)
- `OLLAMA_NUM_CTX` - Ollama context window used for analysis, default `8192`
- `OLLAMA_NUM_PREDICT` - maximum generated tokens for concise analysis, default `512`
- `MAX_MODEL_CONTEXT_CHARS` - maximum compacted JSON context sent to the model, default `24000`

- `SSH_USER` - SSH username for Linux remote device scanning, default `tj`
- `SSH_KEY` - optional default SSH identity key for remote device scanning. Leave empty to use the SSH client defaults.
- `SSH_BATCH_MODE` - keep SSH non-interactive by default (`1`). Set to `0` only when you run the app in a terminal and want SSH to prompt for a password.
- `WINDOWS_SSH_USER` - SSH username for the Windows desktop, default `tjing`
- `WINDOWS_SSH_KEY` - SSH identity key for the Windows desktop, default `$HOME/.ssh/id_ed25519_windows`

Example SSH environment:

```bash
WINDOWS_SSH_USER=tjing
WINDOWS_SSH_KEY=$HOME/.ssh/id_ed25519_windows
SSH_USER=tj
SSH_KEY=
SSH_BATCH_MODE=1
```

The system scan endpoint runs an allow-listed set of read-only commands with short timeouts. It does not make filesystem changes. AI analysis compacts scan results before sending them to Ollama, caps generated output for concise responses, and uses Ollama's streaming API internally so the app receives model output incrementally instead of waiting silently for a single long response. If a local model is still too slow, raise `OLLAMA_REQUEST_TIMEOUT_MS`, lower `MAX_MODEL_CONTEXT_CHARS`, or choose a smaller installed model.

## Remote device scanning

A device selector at the top of the UI lets you pick from your Tailscale devices. Selecting a remote device runs system scans via SSH using `BatchMode` (no password prompts). Linux devices continue to use the Linux SSH user (`SSH_USER`, default `tj`) and read-only commands such as `df`, `lsblk`, `ip`, `ss`, and `journalctl`. The Windows desktop uses its own username/key and read-only PowerShell commands over OpenSSH. The current manual Windows SSH command is:

```bash
ssh -i ~/.ssh/id_ed25519_windows tjing@100.98.112.1
```

The NucBox server must have SSH access to the target device (key-based auth). Android devices are listed but not supported for scanning. If a scan returns `Permission denied (publickey,password)`, Tailscale is routing to the device but SSH authentication failed: verify the reported username, host, and key path. For Linux targets, make sure the target account exists and install the server's public key in that account's `~/.ssh/authorized_keys`.


## File scan

Use the **File Scan** card to collect read-only file and directory metadata for a selected path before asking the AI. Click **Browse** to list child folders for the current path, click a folder to navigate into it, or use **Up** / **Home** to move around before scanning. Set the depth to control how far below the selected path the scan walks:

- `0` scans only the selected path.
- `1` includes direct children.
- Higher values include deeper child directories, up to the built-in depth safety limit of `8`.

The file scan records names, types, sizes, modification times, modes, largest files, recently modified files, and access errors. It does not read file contents or follow symlinks, and it caps traversal at 5,000 visited entries to avoid runaway scans.


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

In the browser, select **desktop-glpggos (Windows)**, click **Scan System**, and confirm the response includes the Windows hostname, `whoami`, OS info, disks, processes, network addresses, and listening ports. Windows file browsing and file scanning are not implemented yet; those endpoints return a clear JSON error while Windows system scanning remains supported.

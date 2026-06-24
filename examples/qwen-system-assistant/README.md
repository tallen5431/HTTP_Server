# Qwen System Assistant

A bundled HTTP Server Manager program that connects to a local Ollama model such as `qwen2.5-coder:1.5b` and gathers read-only Linux system context for analysis.

## Requirements

- Ollama running on the host, usually at `http://127.0.0.1:11434`
- A pulled model, for example:

```bash
ollama pull qwen2.5-coder:1.5b
```

## Environment

- `HOST` - bind address, default `0.0.0.0`
- `PORT` - web UI port, default `8091`
- `OLLAMA_HOST` - Ollama API URL, default `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - model name, default `qwen2.5-coder:1.5b`
- `OLLAMA_NUM_CTX` - context window sent to Ollama, default `4096` for CPU-friendly prompt evaluation
- `OLLAMA_NUM_PREDICT` - response token cap, default `512` to keep CPU responses bounded
- `SCAN_COMMAND_MAX_OUTPUT` - max characters retained from each system command, default `4000`
- `FILE_SCAN_MAX_DEPTH` - maximum file scan depth accepted by the UI/API, default `4`
- `FILE_SCAN_MAX_ENTRIES` - max file entries returned to the browser/model, default `200`
- `FILE_SCAN_MAX_VISITED` - max filesystem entries visited during a file scan, default `2000`

The system scan endpoint runs an allow-listed set of read-only commands with short timeouts. It does not make filesystem changes. The defaults intentionally use `qwen2.5-coder:1.5b`, a smaller context window, and shorter responses because CPU-only Ollama inference can be slow. For slower machines, try `ollama pull qwen2.5-coder:0.5b` and set `OLLAMA_MODEL=qwen2.5-coder:0.5b`.


## File scan

Use the **File Scan** card to collect read-only file and directory metadata for a selected path before asking the AI. Set the depth to control how far below the selected path the scan walks:

- `0` scans only the selected path.
- `1` includes direct children.
- Higher values include deeper child directories, up to the configured depth safety limit, default `4`.

The file scan records names, types, sizes, modification times, modes, largest files, recently modified files, and access errors. It does not read file contents or follow symlinks, and it caps traversal at 2,000 visited entries by default to avoid runaway scans.

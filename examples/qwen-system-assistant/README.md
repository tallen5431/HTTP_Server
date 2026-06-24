# Qwen System Assistant

A bundled HTTP Server Manager program that connects to a local Ollama model such as `qwen2.5-coder:7b` and gathers read-only Linux system context for analysis.

## Requirements

- Ollama running on the host, usually at `http://127.0.0.1:11434`
- A pulled model, for example:

```bash
ollama pull qwen2.5-coder:7b
```

## Environment

- `HOST` - bind address, default `0.0.0.0`
- `PORT` - web UI port, default `8091`
- `OLLAMA_HOST` - Ollama API URL, default `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - model name, default `qwen2.5-coder:7b`

The system scan endpoint runs an allow-listed set of read-only commands with short timeouts. It does not make filesystem changes.


## File scan

Use the **File Scan** card to collect read-only file and directory metadata for a selected path before asking the AI. Set the depth to control how far below the selected path the scan walks:

- `0` scans only the selected path.
- `1` includes direct children.
- Higher values include deeper child directories, up to the built-in depth safety limit of `8`.

The file scan records names, types, sizes, modification times, modes, largest files, recently modified files, and access errors. It does not read file contents or follow symlinks, and it caps traversal at 5,000 visited entries to avoid runaway scans.

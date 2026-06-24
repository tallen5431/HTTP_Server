# Qwen System Assistant

A bundled HTTP Server Manager program that connects to a local Ollama model such as `qwen2.5-coder` and gathers read-only Linux system context for analysis.

## Requirements

- Ollama running on the host, usually at `http://127.0.0.1:11434`
- A pulled model, for example:

```bash
ollama pull qwen2.5-coder
```

## Environment

- `HOST` - bind address, default `0.0.0.0`
- `PORT` - web UI port, default `8091`
- `OLLAMA_HOST` - Ollama API URL, default `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - model name, default `qwen2.5-coder`

The scan endpoint runs an allow-listed set of read-only commands with short timeouts. It does not make filesystem changes.

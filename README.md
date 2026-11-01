<p align="center">
  <img src="https://cdn.quantdense.com/tenkstack/tenkstack-banner.png"
       alt="TenkStack" width="820">
</p>

# TenkStack

TenkStack is a self-hosted control panel for a single GPU machine that runs
language models and generates images. It installs and drives
[llama.cpp](https://github.com/ggml-org/llama.cpp),
[vLLM](https://github.com/vllm-project/vllm) and
[SGLang](https://github.com/sgl-project/sglang) through
[llama-swap](https://github.com/mostlygeek/llama-swap), and
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) for images. Everything
sits behind one web console with accounts and one OpenAI- and
Anthropic-compatible API.

It is one binary with the web interface built in. The interface is in
Traditional Chinese.

## Features

- **Dashboard**: live power, VRAM, clock and tokens/sec for every card, plus
  host CPU, memory and disk.
- **Chat with an agent**: streaming chat with image input. The agent can run
  Python in a gVisor sandbox and search the web through SearXNG. HTML, SVG,
  React and Markdown replies open as live previews.
- **Model catalog**: search Hugging Face and download GGUF files or
  safetensors folders, with resumable segmented downloads and checksum checks.
  It estimates how fast a GGUF will run on your card before you download it.
- **Models and engines**: install llama.cpp, vLLM or SGLang from the official
  images and add, edit or remove models from the browser. Quantise a bf16
  model to FP8, Int8 or Int4 for vLLM.
- **ComfyUI**: one instance per card, behind the console's sign-in. The
  console frees GPU memory between language models and ComfyUI when they share
  a card.
- **Benchmark**: time to first token, prompt and generation speed, and how
  they change with longer context or more users. Compare up to three runs.
- **Files, logs, users**: a file browser, one log view for every service,
  accounts and API keys, and one-click updates.
- **API**: `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), so
  Claude Code, Codex and other tools can use your models.

## Supported hardware

| GPU | Status |
|---|---|
| Intel Arc (tested on the Arc Pro B70) | Used daily |
| NVIDIA | Used daily |
| AMD | Written from the documentation, not yet run on a card. Reports welcome |

Cards from different vendors can share one machine. Each card can run
language models, ComfyUI, both, or neither.

## Install

On Ubuntu 24.04:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/NoobBandi/TenkStack/main/install.sh)
```

Run it as written, not as `curl | bash`, so it can ask you questions. The
installer:

1. asks where to install (default `~/tenkstack`), which engines to install,
   which cards run ComfyUI, and how the console is reached;
2. shows its plan and waits for your yes;
3. runs as your user, using `sudo` only for packages, groups, the NVIDIA
   driver and TLS setup. It never reboots on its own.

When it finishes it prints the console's address with `?setup=<token>` at the
end. **Open that link to create the first account**, which becomes the
administrator. Until that account exists, nobody without the link can get in.
If you lose the link:

```bash
journalctl --user -u tenkstack-console | grep -o "setup=[0-9a-f]*" | tail -1
```

### How the console is reached

| Flag | Result |
|---|---|
| *(none)* | Plain HTTP on port 8443. Use it behind something that already provides TLS (Cloudflare Tunnel, Tailscale Serve) or on a network you trust |
| `--tls internal` | HTTPS with Caddy's own certificate authority. Each device imports one root certificate |
| `--tls CERT,KEY` | HTTPS with a certificate you already have |
| `--domain NAME` | HTTPS with a Let's Encrypt certificate. Ports 80 and 443 must be reachable from the internet |

Other useful flags: `--dir PATH`, `--engines llamacpp,vllm`, `--searxng`,
`--yes` (accept every default), `--dry-run`, and `--lang en|zh-TW`.
`install.sh --help` lists them all.

### Update and uninstall

The console checks GitHub for new releases. The administrator updates from
the 關於 (About) page with one click; the downloaded binary is checked against
the release's SHA256SUMS first.

To uninstall, run the install command again and choose uninstall, or pass
`--uninstall`. This removes TenkStack's services, containers and programs but
keeps your models, settings and chat history. `--purge` deletes those too.

## Requirements

- Ubuntu 24.04 (the tested system)
- A GPU with its vendor's tools: `xpu-smi` for Intel, `nvidia-smi` for NVIDIA,
  `amd-smi` or `rocm-smi` for AMD. The installer sets up NVIDIA drivers; Intel
  and AMD need their compute stack installed first.
- Docker. The installer installs it if missing. Engines and ComfyUI run in
  containers from the official images.
- Optional: [gVisor](https://gvisor.dev/) (`runsc`) to run the agent's Python
  on the server. Without it, Python runs in the browser.

The installer also sets up llama-swap, [Caddy](https://caddyserver.com/) and,
if you ask for it, [SearXNG](https://github.com/searxng/searxng).

## Using the API

Create an API key under 使用者 (Users). The 連線 (Connections) page shows
ready-to-paste settings for Claude Code, Codex and other clients.

```bash
curl https://your-host:8443/v1/chat/completions \
  -H "Authorization: Bearer $TENKSTACK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "your-model", "messages": [{"role": "user", "content": "Hello"}]}'
```

For Claude Code, set `ANTHROPIC_BASE_URL=https://your-host:8443` (without
`/v1`) and `ANTHROPIC_AUTH_TOKEN` to the key.

API keys work only on `/v1`. They cannot sign in to the console.

## How it fits together

```
Caddy ──┬── :8443  console and /v1
        ├── :8000  /v1 only, plain HTTP
        └── :8444  ComfyUI, behind the console's sign-in
                │
        tenkstack ──┬── llama-swap ──> llama.cpp, vLLM or SGLang, per model
                    ├── ComfyUI, one container per card
                    ├── SearXNG, for the agent's searches
                    ├── the agent's Python, in a gVisor container
                    └── PostgreSQL, in a container on a unix socket
```

Everything except Caddy listens only on loopback, so nothing is reachable
without signing in.

## Documentation

- [docs/configuration.md](docs/configuration.md): paths, ports, environment
  variables and database backups
- [docs/design-notes.md](docs/design-notes.md): why things are built the way
  they are
- [SECURITY.md](SECURITY.md): the security model and how to report a
  vulnerability
- [CONTRIBUTING.md](CONTRIBUTING.md): building from source and sending changes

## License

[Apache License 2.0](LICENSE).

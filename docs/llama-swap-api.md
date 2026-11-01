# llama-swap API surface (v247)

Probed against the running instance on 2026-08-08. This is what the console's
backend talks to, so it is written from observation rather than from the docs.

## HTTP endpoints

| Method | Path | Result |
|---|---|---|
| GET | `/v1/models` | OpenAI listing; includes `name`/`description` from config |
| POST | `/v1/chat/completions` | Inference; loads the model on demand |
| GET | `/running` | Currently loaded models, with `cmd` and `proxy` |
| GET | `/unload` | Unloads everything. **GET only — POST returns 405** |
| GET | `/health` | Plain text `OK`, not JSON |
| GET | `/logs` | Buffered log history |
| GET | `/api/events` | SSE stream, see below |
| GET | `/ui` | 307 to the bundled web UI |
| GET | `/upstream` | 302 to the active upstream |

Paths that did **not** exist in v247, despite being plausible: `/api/models`,
`/api/metrics`, `/api/status`, `/api/running`, `/api/config`, `/api/unload`,
`/api/activity`. Later releases added `POST /api/models/unload/<id>`, which
unloads one model and leaves the others resident; the console uses it, and
`GET /unload` for everything.

`/running` example:

```json
{"running":[{"model":"qwen3-4b","state":"ready",
  "cmd":"...\n--model /home/someone/models/qwen3-4b-q4.gguf\n--host 127.0.0.1 --port 5801\n...",
  "proxy":"http://localhost:5801","ttl":1800,
  "name":"Qwen3 4B (Q4_K_M)","description":"..."}]}
```

## SSE: `GET /api/events`

Frames are `event:message` with `data:{"type":"<type>","data":"<json string>"}`.
Note the **double encoding** — the inner `data` is a JSON *string* that has to be
parsed again. Six types observed:

### `modelStatus` — the Models page, live

Full array on every change, not a delta:

```json
[{"id":"qwen3-4b","name":"Qwen3 4B (Q4_K_M)","description":"...",
  "state":"ready","unlisted":false,"peerID":""}]
```

States seen: `stopped`, `starting`, `ready`, `stopping`.

### `inflight` — per-request monitoring

```json
{"operation":"upsert","request":{
  "id":"3","timestamp":"2026-08-08T18:28:43.670862059+08:00",
  "model":"qwen3-4b","req_path":"/v1/chat/completions","method":"POST",
  "req_headers":{...},"remote_ip":"127.0.0.1",
  "resp_headers":{},"resp_bytes":0,"elapsed_ms":0}}
```

`operation` is `snapshot` or `upsert`. **`remote_ip` is what makes per-person
usage visible** once several users are on the box.

### `logData`

```json
{"data":"<raw log lines>","source":"proxy"}
```

`source` is `proxy` or the upstream process. Upstream frames carry llama-server's
own timing lines, which is where real throughput comes from:

```
eval time = 427.28 ms / 55 tokens ( 7.77 ms per token, 128.72 tokens per second)
```

### `activity`, `uiConfig`, `profileChanged`

`{"id":3}` — pointer into the persisted activity store (`store.path`).
`{"activity":{"session_id":[...]}}` and `{"active":null}` are UI plumbing.

## The gap the console has to fill

On startup llama-swap logs:

```
[INFO] GPU monitoring not available: no GPU monitoring tool available
```

It probes for `nvidia-smi`/`rocm-smi` and does not know `xpu-smi`, so **its GPU
panel is empty on this machine**. GPU telemetry has to come from our own backend
via `xpu-smi stats -d 0 -j`:

- `power.gpu_power_w.tile_0.current`
- `memory.used_mib.tile_0.current`
- `frequency.gpu_frequency_mhz.tile_0.current`

Idle baseline on the B70 is ~46 W at 400 MHz.

## Consequences for the console design

- The event stream covers models, requests and logs. The backend holds one
  subscription to it, reconnecting with backoff, for llama-server's timing
  lines and request progress; which models are loaded it asks instead: the
  backend calls `GET /running` whenever it needs that answer — the model list
  (which the browser refreshes every 15 seconds), the VRAM check before a
  load, the card page's occupants, the connections page. The client is
  `internal/llamaswap/client.go`.
- `-watch-config` means the backend can manage models by **rewriting
  `config.yaml`**, with no IPC to build. Config is the single source of truth.
- `n_slots = 4` in llama-server means one loaded model already serves four
  concurrent requests, which is what covers several users at once.

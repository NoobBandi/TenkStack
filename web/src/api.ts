export interface GpuSample {
  index: number;
  name: string;
  power_w: number | null;
  memory_used_mib: number | null;
  memory_total_mib: number | null;
  memory_util_percent: number | null;
  frequency_mhz: number | null;
  temperature_c: number | null;
  /** Limits the card reports for itself; null when the kernel exposes none. */
  power_cap_w: number | null;
  frequency_max_mhz: number | null;
  temperature_crit_c: number | null;
  /** Which telemetry provider produced this reading. Present on every sample so
   *  a mixed machine can label its cards without a second request. */
  vendor: string;
  busy: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  running: boolean;
  state: 'stopped' | 'starting' | 'ready' | 'stopping' | string;
  proxy?: string | null;
  ttl?: number | null;
  /** --ctx-size from the config; the real ceiling for context usage. */
  ctx_size?: number | null;
  capabilities?: ModelCapabilities;
  /** The sampling flags this model's llama-swap entry carries. Only defaults on
   *  the server -- a request with its own values overrides them, which is what
   *  this console does -- so the panel seeds itself from these instead, and the
   *  config and the interface cannot say different things. */
  sampling?: Partial<ChatParams> | null;
  /** The files this entry is made of. Two entries differing only in
   *  quantisation carry the same name and the same everything else, so this is
   *  what tells them apart -- and what says how much of the card each wants. */
  weights?: ModelWeight[];
}

export interface ModelWeight {
  /** Relative to the models directory: `<owner>/<repo>/<name>`. */
  filename: string;
  basename: string;
  repo: string;
  /** From the flag it appears under, not from the name. `mmproj` in a filename
   *  is a convention that holds until somebody renames a file. */
  role: 'model' | 'mmproj';
  exists: boolean;
  size_bytes: number;
  /** Other entries pointing at this same file. Not a problem: one BF16
   *  projector serves every quantisation of its model, so two entries sharing
   *  one is the design rather than a collision. */
  shared_with: string[];
}

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  tools: boolean;
  /** 'live' when read from llama-server's /props, 'config' when only declared
   *  in the command line because the model is not running. */
  source: 'live' | 'config';
}

export interface ComfyDevice {
  name: string;
  type: string;
  index: number;
  vram_total: number;
  vram_free: number;
}

/**
 * One running ComfyUI.
 *
 * There is a list of these rather than a single status because the card an
 * instance uses is fixed at launch -- so more than one card means more than one
 * instance, and picking a card means picking which one to open.
 */
/** ComfyUI-Manager's task queue, or null when the node is not installed. */
export interface ComfyManagerState {
  processing: boolean;
  done: number;
  total: number;
}

export interface ComfyInstance {
  port: number;
  /** Where Caddy republishes it behind the console's login, or null when no
   *  site block has been written for it yet. */
  public_port: number | null;
  version: string | null;
  python: string;
  torch: string | null;
  device: ComfyDevice | null;
  queue_running: number;
  queue_pending: number;
  manager: ComfyManagerState | null;
  /** The instance stopped answering and these numbers are the last ones it
   *  gave. ComfyUI serves nothing while a sampling step runs, so this is the
   *  normal state during a generation rather than a fault. */
  stale: boolean;
}

export interface Throughput {
  eval_ms: number;
  tokens: number;
  tokens_per_second: number;
}

export interface InflightRequest {
  id: string;
  timestamp: string;
  model: string;
  req_path: string;
  method: string;
  remote_ip: string;
  resp_bytes: number;
  elapsed_ms: number;
  /** When this entry last changed, in browser time. llama-swap never deletes a
   *  finished request, so staleness is the only signal that it ended. */
  updated_at: number;
}

export interface LogLine {
  text: string;
  source: 'proxy' | 'upstream';
  level: 'info' | 'warn' | 'error';
}

/** llama-server prefixes with a single letter (I/W/E); llama-swap's own lines
 *  use bracketed words. Both are matched so colour means the same thing
 *  regardless of which process emitted the line. */
export function logLevel(text: string): LogLine['level'] {
  if (/\[ERROR\]|\bE \w|error|failed|panic/i.test(text)) return 'error';
  if (/\[WARN\]|\bW \w|warn/i.test(text)) return 'warn';
  return 'info';
}

/**
 * The dev server proxies /api to the backend (see vite.config.ts), and in
 * production the UI is served from the same origin, so a relative base works in
 * both without a build-time switch.
 */
const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    // The backend's `detail` says what actually went wrong -- which directory
    // is off limits, which permission is missing. Dropping it for the status
    // code alone turns every refusal into the same unhelpful sentence.
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const fetchGpu = () => get<GpuSample[]>('/gpu');

// ---------------------------------------------------------------------------
// Web search
//
// On the backend because the sandbox cannot: its frame has no origin, so every
// request it makes carries `Origin: null`, and search engines -- like almost
// everything -- do not allow that. These go out from the server, which is not
// a browser and not subject to CORS.
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engines found it. Two agreeing is a different fact from one. */
  engines: string[];
  published: string | null;
}

export const webSearch = (query: string, limit = 8) =>
  get<{ query: string; results: SearchResult[]; answers: string[] }>(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`);

export const webRead = (url: string, query = '') =>
  get<{
    url: string; title?: string; content_type: string;
    text: string; truncated?: boolean; note?: string;
    /** Present when a query was given: which passages came back, and whether
     *  any of them matched it at all. */
    query?: string; matched?: boolean;
    /** Why nothing was selected: 'absent' if the page never says it,
     *  'everywhere' if every passage does. */
    reason?: string;
    passages_used?: number; passages_total?: number; chars_total?: number;
  }>(`/search/read?url=${encodeURIComponent(url)}`
    + (query ? `&query=${encodeURIComponent(query)}` : ''));

export const searchAvailable = () =>
  get<{ available: boolean }>('/search/available');
export const fetchModels = () => get<ModelInfo[]>('/models');

export async function unloadAll(): Promise<boolean> {
  const res = await fetch(`${BASE}/models/unload`, { method: 'POST' });
  return res.ok;
}

export type StreamEvent =
  | { type: 'gpu'; data: GpuSample[] }
  | { type: 'journal'; data: JournalLine }
  | { type: 'modelStatus'; data: ModelInfo[] }
  | { type: 'throughput'; data: Throughput }
  | { type: 'inflight'; data: { operation: string; request?: InflightRequest } }
  | { type: 'logData'; data: { data: string; source: string } }
  | { type: string; data: unknown };

/**
 * Subscribe to the merged event stream.
 *
 * EventSource reconnects on its own, but only for transport-level drops; the
 * backend restarting mid-stream surfaces as an error event, so `onError` exists
 * to let the UI show a disconnected state rather than silently going stale --
 * a dashboard that stops updating without saying so is worse than one that
 * admits it is offline.
 */
export function subscribe(
  onEvent: (event: StreamEvent) => void,
  onError?: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${BASE}/stream`);

  source.onopen = () => onError?.(true);
  source.onerror = () => onError?.(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as StreamEvent);
    } catch {
      // A malformed frame should not take the stream down.
    }
  };

  return () => source.close();
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export interface ModelFile {
  /** Relative to the models directory. Downloads land under `<owner>/<repo>/`,
   *  so this is a path; files predating that layout are bare names. */
  filename: string;
  /** The repo it came from, empty for a file put there by hand or downloaded
   *  before the layout existed. Two repos ship the same quant under the same
   *  filename often enough that the name alone does not identify one. */
  repo: string;
  size_bytes: number;
  size_gib: number;
  modified: number;
  is_mmproj: boolean;
  /** Model IDs pointing at this file. Empty means it is an orphan. */
  used_by: string[];
}

export interface ModelFileRef {
  filename: string;
  exists: boolean;
  size_bytes: number;
  /** Other model IDs using the same file; deleting it would break them. */
  shared_with: string[];
}

export interface PartialFile {
  filename: string;
  size_bytes: number;
  size_gib: number;
}

export interface DeleteResult {
  ok: boolean;
  deleted: { filename: string; size_bytes: number }[];
  kept: { filename: string; reason: string }[];
}

export interface ModelSpec {
  id: string;
  name: string;
  description: string;
  model_file: string;
  ctx_size: number;
  n_gpu_layers: number;
  ttl: number;
  group: string | null;
  extra?: string;
  mmproj?: string | null;
}

export const fetchModelFiles = () => get<ModelFile[]>('/models/files');
export const fetchConfig = () => get<{ raw: string; models: Record<string, unknown>; groups: Record<string, unknown> }>('/config');

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(detail.detail ?? `${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const saveModel = (spec: ModelSpec) => send<{ ok: boolean }>('/models', 'POST', spec);
export const modelFileRefs = (id: string) =>
  get<ModelFileRef[]>(`/models/${encodeURIComponent(id)}/files`);
export const deleteModel = (id: string, deleteFiles = false) =>
  send<DeleteResult>(
    `/models/${encodeURIComponent(id)}?delete_files=${deleteFiles}`, 'DELETE',
  );
export const deleteFile = (filename: string) =>
  send<{ ok: boolean }>(`/files/${encodeURIComponent(filename)}`, 'DELETE');
export const fetchPartials = () => get<PartialFile[]>('/files/partials');
export const deletePartial = (filename: string) =>
  send<{ ok: boolean }>(`/files/partials/${encodeURIComponent(filename)}`, 'DELETE');
export const loadModel = (id: string) => send<{ ok: boolean }>(`/models/${encodeURIComponent(id)}/load`, 'POST');
export const saveConfigRaw = (raw: string) => send<{ ok: boolean }>('/config', 'PUT', { raw });

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogRepo {
  repo_id: string;
  downloads: number;
  likes: number;
  last_modified: string;
  tags: string[];
}

export interface CatalogFile {
  /** The first part. A model entry pointing at any other one fails to load. */
  filename: string;
  /** Every file this model is made of. One unless it was uploaded split. */
  parts: string[];
  part_count: number;
  /** Across all parts, which is what has to fit on disk and on the card. */
  size_bytes: number;
  size_gib: number;
  is_mmproj: boolean;
  /** True only when every part is present. Two of three is not a model.
   *  Checked under this repo's own directory, so another repo's file of the
   *  same name no longer reads as this one already being here. */
  on_disk: boolean;
  /** Where it will land, relative to the models directory. Also what a model
   *  entry's --model has to point at. */
  local_path: string;
  /** Copies of this filename already on disk from somewhere else. Not a
   *  refusal -- they cannot collide any more -- but downloading a second copy
   *  of something you have is usually a mistake and occasionally the point. */
  elsewhere: string[];
}

export interface DownloadStatus {
  repo_id: string;
  filename: string;
  total_bytes: number;
  downloaded_bytes: number;
  percent: number;
  state: string;
  error: string | null;
  mib_per_second: number;
}

export const searchCatalog = (q: string) =>
  get<CatalogRepo[]>(`/catalog/search?q=${encodeURIComponent(q)}&limit=20`);
export const catalogFiles = (repoId: string) =>
  get<CatalogFile[]>(`/catalog/files?repo_id=${encodeURIComponent(repoId)}`);
export const startDownload = (repo_id: string, filename: string) =>
  send<DownloadStatus>('/catalog/download', 'POST', { repo_id, filename });
export const cancelDownload = (repo_id: string, filename: string) =>
  send<{ ok: boolean }>('/catalog/cancel', 'POST', { repo_id, filename });
export const fetchDownloads = () => get<DownloadStatus[]>('/catalog/downloads');

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

export interface ComfyHistoryItem {
  prompt_id: string;
  status: string | null;
  images: { filename: string; subfolder: string; type: string }[];
}

export const fetchComfyInstances = () => get<ComfyInstance[]>('/comfyui/instances');
export const fetchComfyHistory = (port: number) =>
  get<ComfyHistoryItem[]>(`/comfyui/history?port=${port}&limit=12`);
export const interruptComfy = (port: number) =>
  send<{ ok: boolean }>(`/comfyui/interrupt?port=${port}`, 'POST');

// The image track (PyTorch, oneAPI, Python) is not here: replacing it means
// replacing the container this would be running inside, so it stays a shell
// operation. These drive the other track -- ComfyUI and its custom nodes, which
// are git checkouts in the instance's own storage and are untouched by an image
// change.
export const checkComfyUpdates = (port: number) =>
  send<{ available: boolean }>(`/comfyui/update/check?port=${port}`, 'POST');
export const updateComfy = (port: number) =>
  send<{ ok: boolean }>(`/comfyui/update?port=${port}`, 'POST');
export const restartComfy = (port: number) =>
  send<{ ok: boolean }>(`/comfyui/restart?port=${port}`, 'POST');
// Proxied through the console so the images stay on one origin -- and so the
// port travels with them, because with more than one instance the filename
// alone no longer says which machine-side queue produced it.
export const comfyImageUrl = (
  port: number,
  img: { filename: string; subfolder: string; type: string },
) =>
  `${BASE}/comfyui/image?port=${port}&filename=${encodeURIComponent(img.filename)}` +
  `&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`;

// ---------------------------------------------------------------------------
// Users and API keys
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: string;
  created_at: number;
  key_count: number;
}

export interface ApiKey {
  id: number;
  user_id: number;
  username: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

export const fetchUsers = () => get<User[]>('/users');
export const createUser = (payload: { username: string; password: string; display_name: string; role: string }) =>
  send<User>('/users', 'POST', payload);
export const deleteUser = (id: number) => send<{ ok: boolean }>(`/users/${id}`, 'DELETE');
export const setPassword = (id: number, password: string) =>
  send<{ ok: boolean }>(`/users/${id}/password`, 'POST', { password });
export const fetchApiKeys = () => get<ApiKey[]>('/api-keys');
export const createApiKey = (user_id: number, name: string) =>
  send<ApiKey & { secret: string }>('/api-keys', 'POST', { user_id, name });
export const deleteApiKey = (id: number) => send<{ ok: boolean }>(`/api-keys/${id}`, 'DELETE');

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface Identity {
  user_id: number;
  username: string;
  role: string;
  via: 'session' | 'api-key';
}

export interface AuthState {
  identity: Identity | null;
  /** False only before the first account exists; it flips on by itself then. */
  enforcement: boolean;
}

export const fetchAuth = () => get<AuthState>('/auth/me');
export const login = (username: string, password: string) =>
  send<{ id: number; username: string; role: string }>('/auth/login', 'POST', { username, password });
export const logout = () => send<{ ok: boolean }>('/auth/logout', 'POST');

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Qwen-style thinking, streamed separately from the answer. */
  reasoning?: string;
  /** Data URIs. Only sent to models whose /props reports vision support. */
  images?: string[];
  /** What the model asked to run. Present on an assistant turn that ended in
   *  `finish_reason: 'tool_calls'` rather than in an answer. */
  tool_calls?: ToolCall[];
  /** Which call this result answers. Required on a `tool` message; the server
   *  matches it back to the request that asked for it. */
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A tool the model may call, in the OpenAI schema llama-server accepts. */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Sampling controls, named as llama.cpp's server accepts them. */
export interface ChatParams {
  temperature: number;
  max_tokens: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repeat_penalty: number;
  presence_penalty: number;
  frequency_penalty: number;
  /** -1 lets the server's own seed apply; anything else is reproducible. */
  seed: number;
  /** Template-level: whether a <think> block is opened at all. */
  thinking: boolean;
  /** Sampling-level cap on thinking tokens. -1 defers to the server default,
   *  0 ends thinking immediately, N>0 allows that many. */
  reasoning_budget_tokens: number;
  system: string;
}

export const DEFAULT_PARAMS: ChatParams = {
  temperature: 0.6,
  // Higher than any single reply needs, on purpose: this is a ceiling, not a
  // target. llama.cpp clamps n_predict to whatever context is left after the
  // prompt, so a model with a smaller window stops at its own limit rather
  // than erroring -- which is what makes one default safe across models.
  max_tokens: 65536,
  // Qwen's own generation_config; llama.cpp picks these up from the GGUF, and
  // repeating them here keeps the panel honest about what is in effect.
  top_p: 0.95,
  top_k: 20,
  min_p: 0.05,
  repeat_penalty: 1.0,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: -1,
  thinking: true,
  reasoning_budget_tokens: -1,
  system: '',
};

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  params: ChatParams;
  signal?: AbortSignal;
  /** Offered to the model, or omitted entirely. An empty array is not the same
   *  as absent: some templates render a "you have no tools" preamble for it. */
  tools?: ToolSpec[];
}

/**
 * llama-server's own measurements. These are the authoritative numbers: they
 * are taken inside the inference loop, so unlike anything timed in the browser
 * they exclude network transit, proxy hops and queue time.
 */
export interface Timings {
  /** Prompt tokens served from cache rather than recomputed. */
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_second: number;
}

export interface Usage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatDelta {
  content?: string;
  reasoning?: string;
  done?: boolean;
  usage?: Usage;
  timings?: Timings;
  /** 'stop' when the model finished, 'length' when it hit max tokens mid-answer,
   *  'tool_calls' when it stopped to ask for something to be run. */
  finish_reason?: string;
  /** Assembled so far. Rebuilt on every frame rather than sent as fragments,
   *  because the arguments arrive a few characters at a time and half a JSON
   *  object is not something a caller can do anything with. */
  tool_calls?: ToolCall[];
}

/**
 * Stream a chat completion.
 *
 * Uses fetch rather than EventSource because EventSource cannot issue a POST,
 * and the request body is the whole conversation. The SSE framing is therefore
 * parsed here by hand.
 */
export async function* chatStream(options: ChatOptions): AsyncGenerator<ChatDelta> {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      ...(({ thinking, reasoning_budget_tokens, system, max_tokens, ...rest }) => ({
        ...rest,
        max_tokens,
        // Only sent when set: a -1 budget means "use whatever the server was
        // started with", and passing it explicitly would say the same thing
        // more confusingly.
        ...(reasoning_budget_tokens >= 0 ? { reasoning_budget_tokens } : {}),
        chat_template_kwargs: { enable_thinking: thinking },
      }))(options.params),
      // A message with images has to use the content-parts form; plain text
      // stays a plain string, because some servers reject the array form when
      // no mmproj is loaded.
      messages: ([
        ...(options.params.system.trim()
          ? [{ role: 'system' as const, content: options.params.system.trim() }]
          : []),
        ...options.messages,
      ] as ChatMessage[]).map(({ role, content, images }) =>
        images?.length
          ? {
              role,
              content: [
                ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
                { type: 'text', text: content },
              ],
            }
          : { role, content },
      ),
      // Omitted rather than sent empty: some chat templates render a "you have
      // no tools" preamble for an empty array, which is worse than silence.
      ...(options.tools?.length ? { tools: options.tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      // Makes llama-server attach its own timings to the final chunk.
      timings_per_token: true,
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(detail.slice(0, 300) || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * Tool calls arrive in pieces and have to be sewn back together here.
   *
   * Measured against this llama-server: the name and id come whole in the first
   * frame, then the arguments follow a few characters at a time -- `{`,
   * `"index":`, `0`, `}` across four frames for one two-field object. Nothing
   * downstream can use half of a JSON literal, so the accumulator lives here
   * and every frame yields the whole of what is known so far.
   *
   * Keyed by the delta's own `index`, not by position: a model may open a
   * second call before finishing the first, and the fragments are labelled for
   * exactly that reason.
   */
  const building = new Map<number, ToolCall>();

  const absorb = (fragments: unknown): ToolCall[] | undefined => {
    if (!Array.isArray(fragments)) return undefined;
    for (const piece of fragments) {
      const at = typeof piece?.index === 'number' ? piece.index : 0;
      const call = building.get(at) ?? {
        id: '', type: 'function' as const, function: { name: '', arguments: '' },
      };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.function.name = piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
      building.set(at, call);
    }
    return [...building.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; a partial frame stays in the
    // buffer until its terminator arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        yield { done: true };
        continue;
      }
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta ?? {};
        yield {
          content: delta.content ?? undefined,
          reasoning: delta.reasoning_content ?? delta.reasoning ?? undefined,
          usage: parsed.usage ?? undefined,
          timings: parsed.timings ?? undefined,
          finish_reason: parsed.choices?.[0]?.finish_reason ?? undefined,
          tool_calls: absorb(delta.tool_calls),
        };
      } catch {
        // A malformed frame should not abort the stream.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface Endpoint {
  key: string;
  label: string;
  scheme: 'http' | 'https';
  port: number;
  path: string;
  note: string;
  encrypted: boolean;
  /** Probed server-side, so a listed endpoint is one that answers. */
  listening: boolean;
}

export const fetchEndpoints = () => get<Endpoint[]>('/endpoints');

export interface NetworkHost {
  key: string;
  label: string;
  host: string;
  note: string;
  tailscale?: boolean;
  /** True when a publicly trusted certificate is obtainable for this name. */
  cert_available?: boolean;
}

export interface NetworkInfo {
  hosts: NetworkHost[];
  tailscale: {
    running: boolean;
    ip: string | null;
    dns_name: string | null;
    cert_domains: string[];
  } | null;
}

export const fetchNetwork = () => get<NetworkInfo>('/network');

export interface SystemSample {
  cpu: {
    /** null until two /proc/stat readings exist -- utilisation is a rate. */
    percent: number | null;
    cores: number | null;
    model: string | null;
    load: number[];
  };
  memory: { total_bytes: number; available_bytes: number; used_bytes: number; percent: number };
  swap: { total_bytes: number; used_bytes: number; percent: number };
  disks: {
    path: string;
    total_bytes: number;
    used_bytes: number;
    /** What an ordinary process may write. */
    free_bytes: number;
    /** Root-reserved blocks. used + free + reserved === total. */
    reserved_bytes: number;
    percent: number;
  }[];
  uptime_seconds: number | null;
}

export const fetchSystem = () => get<SystemSample>('/system');

// ---------------------------------------------------------------------------
// GPU history and devices
// ---------------------------------------------------------------------------

export interface GpuPoint {
  /** Unix seconds. Absolute, not "seconds since page load", so the chart can
   *  show history collected before this browser connected. */
  t: number;
  power: number | null;
  vram: number | null;
  freq: number | null;
  temp: number | null;
  util: number | null;
}

export interface GpuDeviceGroup {
  title: string;
  rows: { key: string; label: string; value: string }[];
}

export interface GpuDevice {
  index: number;
  name: string;
  drm_device: string;
  pci_bdf_address: string;
  state: string;
  /** Which telemetry provider produced this card. Every vendor that finds
   *  hardware contributes now, so on a mixed machine "device 1" says nothing
   *  useful without it. */
  vendor: 'intel' | 'nvidia' | 'amd' | string;
  groups: GpuDeviceGroup[];
  live: GpuSample | null;
}

/** Series keyed by device index. JSON object keys arrive as strings. */
export const fetchGpuHistory = (seconds = 900, points = 600) =>
  get<{ interval: number; devices: Record<string, GpuPoint[]> }>(
    `/gpu/history?seconds=${seconds}&points=${points}`);
export const fetchGpuDevices = () => get<GpuDevice[]>('/gpu/devices');

export interface Channel {
  key: string;
  label: string;
  port: number;
  encrypted: boolean;
  note: string;
  enabled: boolean;
  /** False when the .caddy file is missing altogether. */
  present: boolean;
  /** Networks allowed to reach it. 'wan' means every interface. */
  scopes: string[];
}

export interface ChannelState {
  channels: Channel[];
  addresses: { lan: string | null; tailscale: string | null; wan: string };
}

export const fetchChannels = () => get<ChannelState>('/channels');

export interface JournalLine {
  /** Unix seconds, from the journal's own clock. */
  t: number;
  unit: string;
  /** Human name for the unit, resolved by the backend. */
  label: string;
  level: 'info' | 'warn' | 'error';
  /** The readable part: a structured line's message, or the whole line. */
  text: string;
  /** Key/value pairs behind an expander, for lines that carried structure.
   *  Null when there is nothing more than the text itself. */
  fields: [string, string][] | null;
}

export const fetchLogs = (limit = 400) =>
  get<{ lines: JournalLine[]; units: Record<string, string> }>(`/logs?limit=${limit}`);

/**
 * Open or close one channel.
 *
 * The failure detail is unwrapped rather than swallowed: when the backend rolls
 * a change back it explains why in `detail`, and that sentence is the only
 * account the user gets of what happened to their proxy.
 */
export async function setChannel(key: string, enabled: boolean) {
  const res = await fetch(`${BASE}/channels/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail ?? `切換失敗（${res.status}）`);
  return body as { changed: boolean } & ChannelState;
}

/** Which networks may reach a channel. Same rollback semantics as above. */
export async function setChannelScopes(key: string, scopes: string[]) {
  const res = await fetch(`${BASE}/channels/${key}/scopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail ?? `套用失敗（${res.status}）`);
  return body as { changed: boolean } & ChannelState;
}

export interface VersionGroup {
  title: string;
  rows: { label: string; value: string }[];
}

export const fetchVersions = () => get<VersionGroup[]>('/versions');

export const fetchModelSpec = (id: string) =>
  get<ModelSpec>(`/models/${encodeURIComponent(id)}/spec`);
export const unloadModel = (id: string) =>
  send<{ ok: boolean }>(`/models/${encodeURIComponent(id)}/unload`, 'POST');

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

export interface ChatSummary {
  id: number;
  title: string;
  model: string;
  pinned: number;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface StoredChat {
  id: number;
  title: string;
  model: string;
  params: Partial<ChatParams>;
  messages: (ChatMessage & Record<string, unknown>)[];
}

export const fetchChats = (q = '') =>
  get<ChatSummary[]>(`/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const fetchChat = (id: number) => get<StoredChat>(`/chats/${id}`);
export const saveChat = (payload: {
  id: number | null; model: string; params: ChatParams;
  messages: unknown[]; title?: string;
}) => send<{ id: number }>('/chats', 'POST', payload);
export const patchChat = (id: number, patch: { title?: string; pinned?: boolean }) =>
  send<{ ok: boolean }>(`/chats/${id}`, 'PATCH', patch);
export const deleteChat = (id: number) => send<{ ok: boolean }>(`/chats/${id}`, 'DELETE');

// ---------------------------------------------------------------------------
// The filesystem
//
// Started as ComfyUI's model folders, which have no API of their own: ComfyUI
// can list what it found but has no way to be given anything, so a checkpoint
// meant a shell on the machine. It now reaches whatever the backend is
// configured to expose, which by default is those folders plus the home
// directory.
//
// These routes take a session cookie only -- an API key is refused with 403.
// The key is meant to be pasted into a chat client and travels; one that also
// opened a file browser would hand out more than whoever minted it intended.
// ---------------------------------------------------------------------------

export interface FsRoot {
  key: string;
  label: string;
  note: string;
  path: string;
  exists: boolean;
  /** Not assumed: ComfyUI's directories are created by a container running as
   *  root while the console is not, and a root may be declared read-only. An
   *  interface that offers an upload button over a directory it cannot write
   *  is worse than one that explains itself. */
  writable: boolean;
}

export interface FsEntry {
  name: string;
  /** `other` is a device, socket or broken symlink. Listed rather than hidden,
   *  so the view agrees with `ls`, but nothing will open it. */
  kind: 'dir' | 'file' | 'other';
  /** What the preview panel should draw, decided by the server so that one
   *  list of extensions governs both this and which files get a thumbnail.
   *  Null means there is nothing to show. */
  media: 'image' | 'video' | 'audio' | 'text' | 'model' | null;
  /** Null for a directory. Its size on disk is its own inode, which is never
   *  what anybody means; the real number is a separate request. */
  size: number | null;
  modified: number;
  /** An upload that has not finished. Listed rather than hidden, so a transfer
   *  interrupted yesterday is visible today. */
  partial: boolean;
  hidden: boolean;
}

export interface FsListing {
  entries: FsEntry[];
  /** How many matched, which is not how many were sent. Always present, so the
   *  count can be shown when nothing was truncated too. */
  total: number;
  truncated: boolean;
  /** Whether this exact directory takes writes, which is not the same as the
   *  root taking them -- ComfyUI creates subdirectories as root. */
  writable: boolean;
  free: number;
  readonly_root: boolean;
}

/** What a file says about itself without being read: a model header, the first
 *  page of text, or an honest nothing for a 20 GB video. */
export type FsPeek =
  | {
      kind: 'model'; size: number; format: 'safetensors';
      tensors: { name: string; dtype: string; shape: number[] }[];
      truncated: boolean; count: number; parameters: number;
      metadata: Record<string, unknown> | null;
    }
  | {
      kind: 'model'; size: number; format: 'gguf'; version: number;
      count: number; metadata: Record<string, unknown>;
    }
  | { kind: 'text'; size: number; text: string; truncated: boolean; language: string }
  | { kind: 'binary'; size: number }
  | { kind: 'unreadable'; size: number; detail: string };

const fsQuery = (root: string, path: string, name?: string) =>
  `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
  + (name === undefined ? '' : `&name=${encodeURIComponent(name)}`);

export const fetchFsRoots = () => get<{ roots: FsRoot[] }>('/fs/roots');

/**
 * One directory.
 *
 * `query` filters on the server rather than here, which matters exactly when
 * the directory is big enough for the listing to be truncated: a name that
 * sorts at position 19000 of 20000 is still findable, and filtering what
 * arrived would only ever search the first three thousand.
 */
export const fetchFsListing = (root: string, path: string, hidden = false, query = '') =>
  get<FsListing>(
    `/fs?${fsQuery(root, path)}&hidden=${hidden}&query=${encodeURIComponent(query)}`);

/** Recursive size of one directory, asked for one at a time. The listing used
 *  to answer this for every subdirectory at once, which over a home directory
 *  walks the whole disk on every navigation step. */
/**
 * Where an absolute path lands: which root, and where inside it.
 *
 * Resolved on the server rather than by matching prefixes here, because what
 * the address bar submits is whatever was pasted out of a terminal: `~` has to
 * expand against the backend's user, `..` has to collapse before anything is
 * compared, and a symlink has to be followed before the deny list applies.
 *
 * `name` is empty for a directory and set when the path named a file, so that
 * typing a checkpoint's full path lands on its folder with it ready to open.
 */
export const locateFsPath = (path: string) =>
  get<{ root: string; path: string; name: string }>(
    `/fs/locate?path=${encodeURIComponent(path)}`);

export const fetchFsSize = (root: string, path: string, name: string) =>
  get<{ files: number; bytes: number }>(`/fs/size?${fsQuery(root, path, name)}`);

export const fetchFsPeek = (root: string, path: string, name: string) =>
  get<FsPeek>(`/fs/peek?${fsQuery(root, path, name)}`);

/**
 * URL for the bytes themselves.
 *
 * A URL rather than a fetch because this is what goes into `src` on an `<img>`
 * or a `<video>`: the browser does its own ranged requests from there, which is
 * the only way a scrubber works. `download` forces an attachment for the types
 * the server would otherwise serve inline.
 */
export const fsRawUrl = (root: string, path: string, name: string, download = false) =>
  `${BASE}/fs/raw?${fsQuery(root, path, name)}&download=${download}`;

/**
 * URL for a 320 px WebP of an image, made once on the server and cached.
 *
 * A grid of ComfyUI's outputs is forty 1 MB PNGs; the thumbnails are 3-4 KB
 * each. Over the LAN that is a nicety, over Tailscale it is the difference
 * between a gallery and a progress bar.
 */
export const fsThumbUrl = (root: string, path: string, name: string) =>
  `${BASE}/fs/thumb?${fsQuery(root, path, name)}`;

export const createFsFolder = (root: string, path: string, name: string) =>
  send<{ ok: boolean }>(`/fs/folder?${fsQuery(root, path, name)}`, 'POST');

export const renameFsEntry = (root: string, path: string, name: string, to: string) =>
  send<{ ok: boolean; name: string }>(
    `/fs/rename?${fsQuery(root, path, name)}&to=${encodeURIComponent(to)}`, 'POST');

export const moveFsEntry = (
  root: string, path: string, name: string, toRoot: string, toPath: string,
) =>
  send<{ ok: boolean; name: string }>(
    `/fs/move?${fsQuery(root, path, name)}`
    + `&to_root=${encodeURIComponent(toRoot)}&to_path=${encodeURIComponent(toPath)}`, 'POST');

export const deleteFsEntry = (root: string, path: string, name: string, partial = false) =>
  send<{ ok: boolean; freed: number }>(
    `/fs?${fsQuery(root, path, name)}&partial=${partial}`, 'DELETE');

/**
 * Chunk size. Large enough that a 20 GB model is ~1250 requests rather than
 * 20000, small enough that a dropped connection costs a second of transfer
 * rather than a minute.
 */
const UPLOAD_CHUNK = 16 * 1024 * 1024;

/**
 * Send one file, resuming whatever the server already holds.
 *
 * Chunked rather than one long PUT for two reasons, and progress is only the
 * second of them. A single streamed body gives no way back from a dropped
 * connection: an upload that dies at 19 GB starts again at zero. Here the
 * server owns the count -- every chunk carries the offset it believes it is
 * writing at, and a mismatch comes back as a 409 carrying the true length, so
 * recovery is an ordinary request rather than a special case.
 */
export async function uploadFsFile(
  root: string,
  path: string,
  file: File,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const query = fsQuery(root, path, file.name);

  const head = await get<{ offset: number; exists: boolean }>(`/fs/offset?${query}`);
  if (head.exists) throw new Error('同名檔案已存在');

  let offset = head.offset;
  onProgress(offset);

  while (offset < file.size) {
    const end = Math.min(offset + UPLOAD_CHUNK, file.size);
    const res = await fetch(
      `${BASE}/fs/upload?${query}&offset=${offset}&total=${file.size}`,
      { method: 'PUT', body: file.slice(offset, end), signal },
    );

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      // The server disagrees about how much it has. Its number is the true
      // one; adopting it is the whole recovery path.
      if (typeof body.expected === 'number') {
        offset = body.expected;
        onProgress(offset);
        continue;
      }
      throw new Error(body.detail ?? '同名檔案已存在');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(body.detail ?? `上傳失敗（${res.status}）`);
    }

    const body = await res.json();
    offset = typeof body.offset === 'number' ? body.offset : end;
    onProgress(offset);
  }
}

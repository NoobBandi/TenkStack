export interface GpuSample {
  index: number;
  name: string;
  power_w: number | null;
  memory_used_mib: number | null;
  memory_total_mib: number | null;
  memory_util_percent: number | null;
  frequency_mhz: number | null;
  temperature_c: number | null;
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
}

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  tools: boolean;
  /** 'live' when read from llama-server's /props, 'config' when only declared
   *  in the command line because the model is not running. */
  source: 'live' | 'config';
}

export interface ComfyStatus {
  reachable: boolean;
  version?: string;
  python?: string;
  devices?: { name?: string; type?: string; vram_total?: number; vram_free?: number }[];
  queue_running?: number;
  queue_pending?: number;
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
}

/**
 * The dev server proxies /api to the backend (see vite.config.ts), and in
 * production the UI is served from the same origin, so a relative base works in
 * both without a build-time switch.
 */
const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchGpu = () => get<GpuSample>('/gpu');
export const fetchModels = () => get<ModelInfo[]>('/models');
export const fetchComfy = () => get<ComfyStatus>('/comfyui');

export async function unloadAll(): Promise<boolean> {
  const res = await fetch(`${BASE}/models/unload`, { method: 'POST' });
  return res.ok;
}

export type StreamEvent =
  | { type: 'gpu'; data: GpuSample }
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
  filename: string;
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
  filename: string;
  size_bytes: number;
  size_gib: number;
  is_mmproj: boolean;
  on_disk: boolean;
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

export const fetchComfyHistory = () => get<ComfyHistoryItem[]>('/comfyui/history?limit=12');
export const interruptComfy = () => send<{ ok: boolean }>('/comfyui/interrupt', 'POST');
export const comfyImageUrl = (img: { filename: string; subfolder: string; type: string }) =>
  `${BASE}/comfyui/image?filename=${encodeURIComponent(img.filename)}` +
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
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Qwen-style thinking, streamed separately from the answer. */
  reasoning?: string;
  /** Data URIs. Only sent to models whose /props reports vision support. */
  images?: string[];
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Qwen3 burns the whole budget on thinking unless this is off. */
  thinking?: boolean;
  signal?: AbortSignal;
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
  /** 'stop' when the model finished, 'length' when it hit max tokens mid-answer. */
  finish_reason?: string;
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
      // A message with images has to use the content-parts form; plain text
      // stays a plain string, because some servers reject the array form when
      // no mmproj is loaded.
      messages: options.messages.map(({ role, content, images }) =>
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
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
      stream_options: { include_usage: true },
      // Makes llama-server attach its own timings to the final chunk.
      timings_per_token: true,
      chat_template_kwargs: { enable_thinking: options.thinking ?? false },
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(detail.slice(0, 300) || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
  disks: { path: string; total_bytes: number; used_bytes: number; free_bytes: number; percent: number }[];
  uptime_seconds: number | null;
}

export const fetchSystem = () => get<SystemSample>('/system');

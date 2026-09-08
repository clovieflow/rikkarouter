// Shared fetch + SSE parsing for executors.
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
export interface SseMessage {
  event?: string;
  data: string;
}

/** Split a byte stream body into SSE messages (async iterable of parsed data lines). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of readChunks(body)) {
    buf += chunk;
    let sep: number;
    // message separator: blank line (\n\n), tolerant of \r\n
    while ((sep = findSeparator(buf)) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n/, "");
      const msg = parseMessage(raw);
      if (msg) yield msg;
    }
  }
  const last = parseMessage(buf.replace(/\r/g, ""));
  if (last) yield last;
}

function findSeparator(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b === -1 ? -1 : b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseMessage(raw: string): SseMessage | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment/keepalive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  return { ...(event ? { event } : {}), data: dataLines.join("\n") };
}

async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export interface UpstreamCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** HTTP(S) proxy URL (e.g. per-connection proxy_url). */
  proxyUrl?: string;
}

const proxyAgents = new Map<string, ProxyAgent>();

function dispatcherFor(proxyUrl: string): Dispatcher {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

/** Drop (+close) a cached proxy agent — call on remove/prune so dead proxies release sockets. */
export async function evictProxyAgent(proxyUrl: string): Promise<void> {
  const agent = proxyAgents.get(proxyUrl);
  if (!agent) return;
  proxyAgents.delete(proxyUrl);
  try {
    await agent.close();
  } catch {}
}

function effectiveSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  // A passed client signal used to disable the server-side ceiling entirely
  // (hung proxy = hung request). Compose both so aborts propagate either way.
  if (signal) return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return AbortSignal.timeout(timeoutMs);
}

export async function upstreamFetch({ url, body, headers, signal, timeoutMs = 300_000, proxyUrl }: UpstreamCall): Promise<Response> {
  if (proxyUrl) {
    // undici and DOM Response diverge on iterator disposal typing — normalize at the edge
    return undiciFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream, application/json", ...headers },
      body: JSON.stringify(body),
      signal: effectiveSignal(signal, timeoutMs),
      dispatcher: dispatcherFor(proxyUrl),
    }) as unknown as Response;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream, application/json", ...headers },
    body: JSON.stringify(body),
    signal: effectiveSignal(signal, timeoutMs),
  });
  return res;
}

/** Plain GET/any-method fetch honoring an optional proxy URL (admin probes). */
export async function proxiedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  proxyUrl?: string,
): Promise<Response> {
  if (proxyUrl) {
    return undiciFetch(url, { ...init, dispatcher: dispatcherFor(proxyUrl) }) as unknown as Response;
  }
  return fetch(url, init);
}

/** Copy upstream Retry-After (seconds or HTTP date, capped at 10 min) onto the error. */
export function withRetry<T extends { retryAfterMs?: number | undefined }>(err: T, res: Response): T {
  try {
    const raw = res.headers?.get?.("retry-after");
    if (!raw) return err;
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs > 0) {
      err.retryAfterMs = Math.min(Math.ceil(secs * 1000), 600_000);
      return err;
    }
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      const ms = at - Date.now();
      if (ms > 0) err.retryAfterMs = Math.min(ms, 600_000);
    }
  } catch {}
  return err;
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return (j.error?.message ?? j.message ?? text).slice(0, 800);
    } catch {
      return text.slice(0, 800);
    }
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** Case-insensitive dedup: later layers win; keys lowercased at the edge. */
export function mergeHeaders(...layers: Array<Record<string, string> | undefined>): Record<string, string> {
  const m = new Map<string, string>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) m.set(k.toLowerCase(), v);
  }
  return Object.fromEntries(m);
}

import { mergeHeaders, parseSse, readErrorBody, upstreamFetch, withRetry } from "./sse.ts";
import type { CanonicalEvent, ExecuteInput, Executor } from "../types.ts";
import { UpstreamError } from "../types.ts";
import type { ProviderDef } from "../providers/registry.ts";
import { canonicalToOpenAI, openaiStreamToCanonical } from "../translate/openai.ts";

export class OpenAICompatibleExecutor implements Executor {
  readonly id: string;
  private readonly provider: ProviderDef;
  constructor(id: string, provider: ProviderDef) {
    this.id = id;
    this.provider = provider;
  }

  private url(cred: ExecuteInput["credential"]): string {
    const base = (cred.baseUrlOverride ?? this.provider.baseUrl).replace(/\/*$/, "");
    // base may already end at the full path (registry convention) — don't duplicate.
    if (base.endsWith("/chat/completions")) return base;
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    const q = base.indexOf("?");
    const pathPart = q === -1 ? base : base.slice(0, q);
    const queryPart = q === -1 ? "" : base.slice(q);
    if (pathPart.endsWith("/chat/completions")) return base;
    if (pathPart.endsWith("/v1")) return `${pathPart}/chat/completions${queryPart}`;
    return `${base}/v1/chat/completions`;
  }

  private headers(cred: ExecuteInput["credential"]): Record<string, string> {
    const h: Record<string, string> = mergeHeaders(this.provider.headers, cred.headers);
    if (cred.apiKey) {
      h.authorization = this.provider.authStyle === "combined" ? cred.apiKey : `Bearer ${cred.apiKey}`;
    }
    return h;
  }

  async execute({ request, credential, signal }: ExecuteInput): Promise<AsyncIterable<CanonicalEvent>> {
    const provider = this.provider;
    const wire = canonicalToOpenAI({ ...request, stream: true });
    const url = this.url(credential);
    let host = "";
    try {
      host = new URL(url).host;
    } catch {}
    const res = await upstreamFetch({
      url,
      body: wire,
      headers: this.headers(credential),
      ...(signal ? { signal } : {}),
      ...(credential.proxyUrl ? { proxyUrl: credential.proxyUrl } : {}),
    }).catch((e: unknown) => {
      throw new UpstreamError(502, `network error${host ? ` reaching ${host}` : ""}: ${(e as Error).message}`, provider.id, true);
    });

    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      throw withRetry(new UpstreamError(res.status, msg, provider.id, res.status === 429 || res.status >= 500), res);
    }

    return streamToCanonical(res.body, provider.id);
  }
}

async function* streamToCanonical(body: ReadableStream<Uint8Array>, providerId: string): AsyncGenerator<CanonicalEvent> {
  const map = openaiStreamToCanonical();
  let sawDone = false;
  for await (const msg of parseSse(body)) {
    if (msg.data === "[DONE]") break;
    let json: unknown;
    try {
      json = JSON.parse(msg.data);
    } catch {
      continue; // tolerate keepalive/garbage lines
    }
    for (const ev of map(json)) {
      if (ev.type === "done") sawDone = true;
      yield ev;
    }
  }
  if (!sawDone) yield { type: "done", finish: "stop" };
}

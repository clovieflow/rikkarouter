// derived from 9router (MIT) — open-sse/executors/{default,gemini-cli}.js URL and auth handling
import { mergeHeaders, parseSse, readErrorBody, upstreamFetch, withRetry } from "./sse.ts";
import type { CanonicalEvent, ExecuteInput, Executor } from "../types.ts";
import { UpstreamError } from "../types.ts";
import type { ProviderDef } from "../providers/registry.ts";
import { canonicalToGemini, geminiStreamToCanonical } from "../translate/gemini.ts";

export class GeminiCompatibleExecutor implements Executor {
  readonly id: string;
  private readonly provider: ProviderDef;
  constructor(id: string, provider: ProviderDef) {
    this.id = id;
    this.provider = provider;
  }

  private urlFor(model: string, cred: ExecuteInput["credential"], stream: boolean): string {
    const rawBase = cred.baseUrlOverride ?? this.provider.baseUrl;
    const base = rawBase.replace(/\/*$/, "");
    // Support both plain host (https://generativelanguage.googleapis.com) and full prefix
    // Normal base for Gemini is https://generativelanguage.googleapis.com; we need /v1beta/models/{model}:action
    // If base already contains /v1beta or /models, don't duplicate.
    let prefix: string;
    if (base.includes("/v1beta")) {
      prefix = base;
      // ensure it ends without trailing slash before we append /models
      if (prefix.endsWith("/models")) {
        // base is .../v1beta/models
      } else if (!prefix.endsWith("/v1beta")) {
        // already has /v1beta/xxx
      }
    } else if (base.endsWith("/models")) {
      prefix = base;
    } else {
      prefix = `${base}/v1beta`;
    }

    let path: string;
    if (prefix.endsWith("/models")) {
      path = `${prefix}/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    } else {
      path = `${prefix}/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }

    // Query-param auth: ?key=API_KEY or &key= if alt=sse already adds ?
    if (this.provider.authStyle !== "bearer" && cred.apiKey) {
      const sep = path.includes("?") ? "&" : "?";
      path = `${path}${sep}key=${encodeURIComponent(cred.apiKey)}`;
    }
    return path;
  }

  private headersFor(cred: ExecuteInput["credential"]): Record<string, string> {
    const h: Record<string, string> = mergeHeaders(this.provider.headers, cred.headers);
    if (cred.apiKey && this.provider.authStyle === "bearer") {
      h.authorization = `Bearer ${cred.apiKey}`;
    }
    return h;
  }

  async execute({ request, credential, signal }: ExecuteInput): Promise<AsyncIterable<CanonicalEvent>> {
    const provider = this.provider;
    const wire = canonicalToGemini({ ...request, stream: true });
    const url = this.urlFor(request.model, credential, true);
    const headers = this.headersFor(credential);
    const res = await upstreamFetch({
      url,
      body: wire,
      headers,
      ...(signal ? { signal } : {}),
      ...(credential.proxyUrl ? { proxyUrl: credential.proxyUrl } : {}),
    }).catch((e: unknown) => {
      throw new UpstreamError(502, `network error: ${(e as Error).message}`, provider.id, true);
    });

    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      throw withRetry(new UpstreamError(res.status, msg, provider.id, res.status === 429 || res.status >= 500), res);
    }

    return streamToCanonical(res.body, provider.id);
  }
}

async function* streamToCanonical(body: ReadableStream<Uint8Array>, _providerId: string): AsyncGenerator<CanonicalEvent> {
  const map = geminiStreamToCanonical();
  let sawDone = false;
  for await (const msg of parseSse(body)) {
    if (msg.data === "[DONE]") break;
    if (!msg.data) continue;
    // Gemini streams line-delimited JSON objects; some providers emit JSON arrays or bare objects per SSE block.
    let json: unknown;
    try {
      json = JSON.parse(msg.data);
    } catch {
      continue;
    }
    // Handle array of chunks (some proxies wrap)
    const chunks: unknown[] = Array.isArray(json) ? (json as unknown[]) : [json];
    for (const chunk of chunks) {
      for (const ev of map(chunk)) {
        if (ev.type === "done") sawDone = true;
        yield ev;
      }
    }
  }
  if (!sawDone) yield { type: "done", finish: "stop" };
}

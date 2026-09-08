// derived from 9router (MIT) — Responses executor; see NOTICE
import { mergeHeaders, parseSse, readErrorBody, upstreamFetch, withRetry } from "./sse.ts";
import type { CanonicalEvent, ExecuteInput, Executor } from "../types.ts";
import { UpstreamError } from "../types.ts";
import type { ProviderDef } from "../providers/registry.ts";
import { canonicalToResponses, responsesStreamToCanonical } from "../translate/responses.ts";

export class ResponsesCompatibleExecutor implements Executor {
  readonly id: string;
  private readonly provider: ProviderDef;
  constructor(id: string, provider: ProviderDef) {
    this.id = id;
    this.provider = provider;
  }

  private url(cred: ExecuteInput["credential"]): string {
    const base = (cred.baseUrlOverride ?? this.provider.baseUrl).replace(/\/*$/, "");
    if (base.endsWith("/v1/responses")) return base;
    if (base.endsWith("/responses")) return base;
    if (base.endsWith("/v1")) return `${base}/responses`;
    const q = base.indexOf("?");
    const pathPart = q === -1 ? base : base.slice(0, q);
    const queryPart = q === -1 ? "" : base.slice(q);
    if (pathPart.endsWith("/v1/responses") || pathPart.endsWith("/responses")) return base;
    if (pathPart.endsWith("/v1")) return `${pathPart}/responses${queryPart}`;
    return `${base}/v1/responses`;
  }

  private headers(cred: ExecuteInput["credential"]): Record<string, string> {
    const h: Record<string, string> = mergeHeaders(this.provider.headers, cred.headers);
    if (cred.apiKey) {
      h.authorization = `Bearer ${cred.apiKey}`;
    }
    return h;
  }

  async execute({ request, credential, signal }: ExecuteInput): Promise<AsyncIterable<CanonicalEvent>> {
    const provider = this.provider;
    const wire = canonicalToResponses({ ...request, stream: true });

    let res: Response;
    try {
      res = await upstreamFetch({
        url: this.url(credential),
        body: wire,
        headers: this.headers(credential),
        ...(signal ? { signal } : {}),
        ...(credential.proxyUrl ? { proxyUrl: credential.proxyUrl } : {}),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new UpstreamError(502, `network error: ${msg}`, provider.id, true);
    }

    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      throw withRetry(new UpstreamError(res.status, msg, provider.id, res.status === 429 || res.status >= 500), res);
    }

    const contentType = res.headers.get("content-type") ?? "";

    // Non-stream JSON fallback (provider returned application/json despite stream:true, or caller used non-stream path)
    if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        const msg = await readErrorBody(res);
        throw new UpstreamError(502, msg, provider.id, true);
      }
      return nonStreamToCanonical(json);
    }

    return streamToCanonical(res.body, provider.id);
  }
}

async function* nonStreamToCanonical(json: unknown): AsyncGenerator<CanonicalEvent> {
  const obj = json as {
    id?: string;
    output?: Array<Record<string, unknown>>;
    usage?: Record<string, unknown>;
    error?: unknown;
    status?: string;
  };

  if (obj.error) {
    const err = obj.error as Record<string, unknown>;
    const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
    yield { type: "error", status: 502, message, provider: "responses" };
    yield { type: "done", finish: "error" };
    return;
  }

  for (const item of obj.output ?? []) {
    const t = item.type as string | undefined;
    if (t === "message") {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const c of content) {
          const ct = c.type as string | undefined;
          if (ct === "output_text" && typeof c.text === "string" && c.text) {
            yield { type: "text_delta", text: c.text };
          } else if (ct === "text" && typeof c.text === "string" && c.text) {
            yield { type: "text_delta", text: c.text };
          } else if (ct === "summary_text" && typeof c.text === "string" && c.text) {
            yield { type: "reasoning_delta", text: c.text };
          }
        }
      }
    } else if (t === "function_call" || t === "custom_tool_call") {
      const id = (item.call_id as string | undefined) ?? (item.id as string | undefined) ?? "";
      const name = (item.name as string | undefined) ?? "";
      const argsRaw = (item.arguments as unknown) ?? (item as { input?: unknown }).input ?? "";
      const args = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);
      yield { type: "tool_call_delta", id, name, ...(args ? { argsChunk: args } : {}) };
    } else if (t === "reasoning") {
      // collect reasoning summary if present
      const summary = item.summary as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(summary)) {
        for (const s of summary) {
          if (s.type === "summary_text" && typeof s.text === "string" && s.text) {
            yield { type: "reasoning_delta", text: s.text };
          }
        }
      }
    }
  }

  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage) {
    const input = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
    const output = (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0;
    let cached: number | undefined;
    if (usage.input_tokens_details && typeof usage.input_tokens_details === "object" && "cached_tokens" in (usage.input_tokens_details as Record<string, unknown>)) {
      const v = (usage.input_tokens_details as Record<string, unknown>).cached_tokens;
      if (typeof v === "number") cached = v;
    }
    let reasoning: number | undefined;
    if (usage.output_tokens_details && typeof usage.output_tokens_details === "object" && "reasoning_tokens" in (usage.output_tokens_details as Record<string, unknown>)) {
      const v = (usage.output_tokens_details as Record<string, unknown>).reasoning_tokens;
      if (typeof v === "number") reasoning = v;
    }
    yield { type: "usage", input, output, ...(cached !== undefined ? { cached } : {}), ...(reasoning !== undefined ? { reasoning } : {}) };
  }

  yield { type: "done", finish: obj.status === "failed" ? "error" : obj.output?.some((o) => (o.type as string) === "function_call") ? "tool_calls" : "stop" };
}

async function* streamToCanonical(body: ReadableStream<Uint8Array>, _providerId: string): AsyncGenerator<CanonicalEvent> {
  const map = responsesStreamToCanonical();
  let sawDone = false;
  for await (const msg of parseSse(body)) {
    if (msg.data === "[DONE]") break;
    let parsed: unknown = msg;
    // parseSse already gives us {event, data}; map will parse JSON inside data
    for (const ev of map(parsed)) {
      if (ev.type === "done") sawDone = true;
      yield ev;
    }
  }
  if (!sawDone) yield { type: "done", finish: "stop" };
}

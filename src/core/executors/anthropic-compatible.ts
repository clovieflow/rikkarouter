import { mergeHeaders, parseSse, readErrorBody, upstreamFetch, withRetry } from "./sse.ts";
import type { CanonicalEvent, ExecuteInput, Executor } from "../types.ts";
import { UpstreamError } from "../types.ts";
import type { ProviderDef } from "../providers/registry.ts";
import { canonicalToAnthropic, anthropicStreamToCanonical } from "../translate/anthropic.ts";

export class AnthropicCompatibleExecutor implements Executor {
  readonly id: string;
  private readonly provider: ProviderDef;
  constructor(id: string, provider: ProviderDef) {
    this.id = id;
    this.provider = provider;
  }

  private url(cred: ExecuteInput["credential"]): string {
    const base = (cred.baseUrlOverride ?? this.provider.baseUrl).replace(/\/*$/, "");
    // base may already end at /v1 or full /v1/messages — normalize
    const qs = base.indexOf("?");
    const pathPart = qs === -1 ? base : base.slice(0, qs);
    if (/\/messages$/.test(pathPart)) return base;
    if (/\/v1$/.test(pathPart)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  private headers(cred: ExecuteInput["credential"]): Record<string, string> {
    const h = mergeHeaders({ "anthropic-version": "2023-06-01" }, this.provider.headers, cred.headers);
    if (cred.apiKey) {
      const style = this.provider.authStyle;
      if (style === "bearer") h.authorization = `Bearer ${cred.apiKey}`;
      else h["x-api-key"] = cred.apiKey; // combined/raw both carry a raw key on x-api-key
    }
    return h;
  }

  async execute({ request, credential, signal }: ExecuteInput): Promise<AsyncIterable<CanonicalEvent>> {
    const provider = this.provider;
    const wire = canonicalToAnthropic({ ...request, stream: true });
    const res = await upstreamFetch({
      url: this.url(credential),
      body: wire,
      headers: this.headers(credential),
      ...(signal ? { signal } : {}),
      ...(credential.proxyUrl ? { proxyUrl: credential.proxyUrl } : {}),
    }).catch((e: unknown) => {
      throw new UpstreamError(502, `network error: ${(e as Error).message}`, provider.id, true);
    });

    if (!res.ok || !res.body) {
      const msg = await readErrorBody(res);
      const status = res.status;
      // anthropic 529 overloaded = transient
      throw withRetry(new UpstreamError(status, msg, provider.id, status === 429 || status === 529 || status >= 500), res);
    }

    return streamToCanonical(res.body, provider.id);
  }
}

async function* streamToCanonical(body: ReadableStream<Uint8Array>, _providerId: string): AsyncGenerator<CanonicalEvent> {
  let sawDone = false;
  let outputSeen = 0;
  const toCanonical = anthropicStreamToCanonical();
  for await (const msg of parseSse(body)) {
    if (!msg.data) continue;
    for (const ev of toCanonical({ ...(msg.event ? { event: msg.event } : {}), data: msg.data })) {
      if (ev.type === "done") sawDone = true;
      // message_start may precede message_delta usage; output must never regress
      if (ev.type === "usage") {
        if (ev.output < outputSeen && ev.input === 0) continue;
        outputSeen = Math.max(outputSeen, ev.output);
      }
      yield ev;
    }
  }
  if (!sawDone) yield { type: "done", finish: "stop" };
}

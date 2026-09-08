import type { MiddlewareHandler } from "hono";
import type { CanonicalEvent, CanonicalRequest, Credential, OpenAIChatRequest } from "./types.ts";
import { UpstreamError } from "./types.ts";
import type { Candidate, Resolved } from "./routing.ts";
import { credentialFor, newId, resolveChat, resolveGemini, resolveMessages, resolveResponses, RouteError } from "./routing.ts";
import { collectOpenAI, openaiEncoder } from "./translate/openai.ts";
import { collectAnthropic, claudeEncoder, estimateTokens, type AnthropicRequest } from "./translate/anthropic.ts";
import { canonicalToGemini, collectGemini, geminiEncoder, type GeminiRequest } from "./translate/gemini.ts";
import { canonicalToResponses, collectResponses, responsesEncoder, type ResponsesRequest } from "./translate/responses.ts";
import { AnthropicCompatibleExecutor } from "./executors/anthropic-compatible.ts";
import { GeminiCompatibleExecutor } from "./executors/gemini-compatible.ts";
import { ResponsesCompatibleExecutor } from "./executors/responses-compatible.ts";
import { OpenAICompatibleExecutor } from "./executors/openai-compatible.ts";
import type { ProviderDef } from "./providers/registry.ts";
import { modelFormat } from "./providers/registry.ts";
import { markProxyBad, pickProxy } from "./proxypool.ts";
import { deductBalance, keyAllowsModel, keyBalance, keyControls, costOf, getKeyIdForSecret, logRequestFull, markActive, markCooldown, recordUsage } from "../shared/db.ts";
import { note429 } from "../server/notify.ts";
import { recordChatTurn, type AttemptEntry } from "./chatlog.ts";
import { compressToolResults } from "./rtk/index.ts";
import { OAUTH_PROVIDERS } from "./oauth/index.ts";
import { ensureFresh } from "./oauth/fresh.ts";
import type { ConnectionRow } from "../shared/db.ts";
import { OAuthError, type OAuthProviderDef } from "./oauth/types.ts";
const openaiExecutors = new Map<string, OpenAICompatibleExecutor>();
const anthropicExecutors = new Map<string, AnthropicCompatibleExecutor>();
const geminiExecutors = new Map<string, GeminiCompatibleExecutor>();
const responsesExecutors = new Map<string, ResponsesCompatibleExecutor>();

function executorFor(provider: ProviderDef, model?: string) {
  const override = model !== undefined ? modelFormat(provider, model) : undefined;
  const wantsResponses =
    override === "responses" ||
    (override === undefined &&
      ((provider.format as string) === "responses" ||
        (provider as unknown as { transport?: { format?: string } }).transport?.format === "openai-responses"));
  if (provider.format === "anthropic") {
    let ex = anthropicExecutors.get(provider.id);
    if (!ex) {
      ex = new AnthropicCompatibleExecutor(provider.id, provider);
      anthropicExecutors.set(provider.id, ex);
    }
    return ex;
  }
  if (provider.format === "gemini") {
    let ex = geminiExecutors.get(provider.id);
    if (!ex) {
      ex = new GeminiCompatibleExecutor(provider.id, provider);
      geminiExecutors.set(provider.id, ex);
    }
    return ex;
  }
  if (wantsResponses) {
    let ex = responsesExecutors.get(provider.id);
    if (!ex) {
      ex = new ResponsesCompatibleExecutor(provider.id, provider);
      responsesExecutors.set(provider.id, ex);
    }
    return ex;
  }
  let ex = openaiExecutors.get(provider.id);
  if (!ex) {
    ex = new OpenAICompatibleExecutor(provider.id, provider);
    openaiExecutors.set(provider.id, ex);
  }
  return ex;
}

function maybeCompress(req: CanonicalRequest): CanonicalRequest {
  return process.env.RTK_ENABLED === "1" ? compressToolResults(req) : req;
}

export class WaitForProxy extends UpstreamError {
  constructor(provider: string) {
    super(503, `auto proxy pool is empty (no healthy proxy right now) — pool refreshes in the background, retry in a bit`, provider, true);
    this.name = "WaitForProxy";
  }
}

/** Host portion of a proxy URL (never userinfo/credentials). */
export function egressHost(proxyUrl: string | null | undefined): string | null {
  if (!proxyUrl) return null;
  try {
    return new URL(proxyUrl).host;
  } catch {
    return "proxy";
  }
}

/** Wait for a healthy pool proxy (bounded, abort-aware). Null on timeout. */
export async function waitForHealthyProxy(signal: AbortSignal, timeoutMs = 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return null;
    const picked = pickProxy();
    if (picked) return picked;
    if (Date.now() >= deadline) return null;
    // One live abort listener at a time — detached on every wakeup.
    await new Promise<void>((r) => {
      const wait = Math.min(2000, Math.max(0, deadline - Date.now()));
      const onAbort = () => {
        clearTimeout(t);
        r();
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        r();
      }, wait);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function freshCredential(cand: Candidate): Promise<Credential> {
  const base = credentialFor(cand);
  let withAutoProxy = base;
  if (cand.connection.proxy_mode === "auto") {
    const picked = pickProxy();
    // Pool kosong = JANGAN diam-diam direct: IP rumah yang kena limit ikut kebakar.
    if (!picked) throw new WaitForProxy(cand.provider.id);
    withAutoProxy = { ...base, proxyUrl: picked, proxyAuto: true };
  }
  const row: Record<string, unknown> = cand.connection as unknown as Record<string, unknown>;
  if (row.auth_kind !== "oauth") return withAutoProxy;
  const def = (OAUTH_PROVIDERS as Record<string, unknown>)[cand.provider.id] as unknown as OAuthProviderDef | undefined;
  if (!def) return withAutoProxy;
  const conn = cand.connection as unknown as ConnectionRow;
  try {
    const fresh = await ensureFresh(conn, def);
    return { ...withAutoProxy, apiKey: fresh.accessToken };
  } catch (e) {
    if (e instanceof OAuthError) {
      throw new UpstreamError(
        401,
        `${e.message} — re-auth required for provider "${cand.provider.id}" (connection "${conn.id}")`,
        cand.provider.id,
        false,
      );
    }
    throw e;
  }
}

interface AttemptStats {
  start: number;
  ttft: number;
  input: number;
  output: number;
  cached: number;
  recorded: boolean;
  committed: boolean;
  /** egress proxy host (null = direct) for the attempt that produced events */
  egress: string | null;
  text: string;
  reasoning: string;
  tools: Array<{ id?: string; name?: string; args?: string }>;
  finish: string | null;
}

function newStats(): AttemptStats {
  return { start: Date.now(), ttft: 0, input: 0, output: 0, cached: 0, recorded: false, committed: false, egress: null, text: "", reasoning: "", tools: [], finish: null };
}

function noteEvent(st: AttemptStats, ev: CanonicalEvent): void {
  if (st.ttft === 0 && (ev.type === "text_delta" || ev.type === "tool_call_delta")) {
    st.ttft = Date.now() - st.start;
  }
  if (ev.type === "text_delta") st.text += ev.text;
  else if (ev.type === "reasoning_delta") st.reasoning += ev.text;
  else if (ev.type === "tool_call_delta") {
    const last = st.tools[st.tools.length - 1];
    if (last && (ev.id === undefined || last.id === ev.id)) {
      if (ev.name) last.name = ev.name;
      if (ev.argsChunk) last.args = `${last.args ?? ""}${ev.argsChunk}`;
    } else {
      const entry: { id?: string; name?: string; args?: string } = {};
      if (ev.id !== undefined) entry.id = ev.id;
      if (ev.name !== undefined) entry.name = ev.name;
      if (ev.argsChunk !== undefined) entry.args = ev.argsChunk;
      st.tools.push(entry);
    }
  } else if (ev.type === "done") st.finish = ev.finish;
  else if (ev.type === "usage") {
    st.input = ev.input;
    st.output = ev.output;
    st.cached = ev.cached ?? 0;
  }
}

const PATH_BY_FORMAT: Record<string, string> = {
  anthropic: "/v1/messages",
  responses: "/v1/responses",
};

export interface ReqCapture {
  id: string;
  attempts: AttemptEntry[];
  last: { res: Resolved; cand: Candidate; st: AttemptStats; ok: boolean; status: number; error?: string; fallbackFrom?: string; keyId?: string } | null;
  done: boolean;
}

export function newCapture(_res: Resolved): ReqCapture {
  return { id: `ct_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, attempts: [], last: null, done: false };
}

/** Visibility for pre-flight rejections (no candidate attempted): log the 4xx, no usage row. */
function logBlocked(res: Resolved, status: number, message: string, keyId?: string): void {
  try {
    logRequestFull({
      method: "POST",
      path: res.format === "gemini" ? `/v1beta/models/${res.requested}:generateContent` : (PATH_BY_FORMAT[res.format] ?? "/v1/chat/completions"),
      status,
      durMs: 0,
      provider: res.candidates[0]?.provider.id ?? null,
      model: res.requested,
      ...(res.combo ? { combo: res.combo } : {}),
      ...(keyId ? { keyId } : {}),
      error: message,
    });
  } catch {}
}

function record(res: Resolved, cand: Candidate, st: AttemptStats, ok: boolean, status: number, error?: string, fallbackFrom?: string, keyId?: string, rc?: ReqCapture): void {
  if (st.recorded) return;
  st.recorded = true;
  const latency = Date.now() - st.start;
  const cost = costOf(cand.provider.id, cand.model, st.input, st.output, st.cached);
  // usage row per attempt is intended; balance deducts once per request in
  // finishChatTurn (failover would otherwise double-charge). recordUsage is
  // guarded so a DB fault can't escape into the streaming run loop.
  try {
    recordUsage({
      connectionId: cand.connection.id,
      provider: cand.provider.id,
      model: cand.model,
      requested: res.requested,
      ok,
      status,
      input: st.input,
      output: st.output,
      cached: st.cached,
      latencyMs: latency,
      ttftMs: st.ttft,
      ...(error !== undefined ? { error } : {}),
      ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
      ...(cost ? { costUsd: cost } : {}),
      ...(res.combo ? { combo: res.combo } : {}),
      ...(keyId ? { keyId } : {}),
    });
  } catch {}
  if (status === 429) {
    try {
      note429(cand.provider.id);
    } catch {}
  }
  if (rc && !rc.done) {
    const attempt: AttemptEntry = {
      connection: cand.connection.id,
      provider: cand.provider.id,
      model: cand.model,
      proxy: st.egress,
      status,
      latencyMs: latency,
      ...(error !== undefined ? { error: error.slice(0, 300) } : {}),
    };
    rc.attempts.push(attempt);
    rc.last = { res, cand, st, ok, status, ...(error !== undefined ? { error } : {}), ...(fallbackFrom !== undefined ? { fallbackFrom } : {}), ...(keyId ? { keyId } : {}) };
  }
  try {
    const path =
      res.format === "gemini"
        ? `/v1beta/models/${res.requested}:generateContent`
        : (PATH_BY_FORMAT[res.format] ?? "/v1/chat/completions");
    logRequestFull({
      method: "POST",
      path,
      status,
      durMs: latency,
      provider: cand.provider.id,
      model: cand.model,
      ...(res.combo ? { combo: res.combo } : {}),
      ...(keyId ? { keyId } : {}),
      tokensIn: st.input,
      tokensOut: st.output,
      costUsd: cost,
      ...(error !== undefined ? { error } : {}),
      ...(st.egress ? { egress: st.egress } : {}),
    });
  } catch {
    // logging must never break a response
  }
}
/** Write the single per-request chat_turn row from accumulated attempts. */
export function finishChatTurn(rc: ReqCapture): void {
  if (rc.done) return;
  rc.done = true;
  const last = rc.last;
  if (!last) return;
  try {
    const { res, cand, st, ok, status, error, keyId } = last;
    const req = res.request as { messages?: unknown[]; tools?: unknown };
    const messages = Array.isArray(req.messages) ? (req.messages as unknown[]) : [];
    const cost = costOf(cand.provider.id, cand.model, st.input, st.output, st.cached);
    // Single prepaid deduction per request (attempt usage rows stay per-attempt).
    try {
      if (keyId && cost > 0) deductBalance(keyId, cost);
    } catch {}
    recordChatTurn({
      id: rc.id,
      keyId: keyId ?? null,
      provider: cand.provider.id,
      model: cand.model,
      requested: res.requested,
      format: res.format,
      connectionId: cand.connection.id,
      egress: st.egress,
      ok,
      status,
      finish: st.finish,
      latencyMs: Date.now() - st.start,
      ttftMs: st.ttft,
      input: st.input,
      output: st.output,
      cached: st.cached,
      costUsd: cost,
      ...(error !== undefined ? { error } : {}),
      attempts: rc.attempts,
      request: { messages, ...(req.tools ? { tools: req.tools } : {}) },
      response: st.text || null,
      reasoning: st.reasoning || null,
      ...(st.tools.length ? { toolCalls: st.tools } : {}),
    });
  } catch {}
}

function retryAfterMsOf(err: UpstreamError): number | null {
  if (!(err instanceof Error) || !("retryAfterMs" in err)) return null;
  const holder = err as unknown as { retryAfterMs: unknown }; // executors attach Retry-After here on 429s
  const v: unknown = holder.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function cooldownMsFor(status: number, retryAfterMs?: number | null): number {
  if (status === 429) {
    const base = 60_000;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.max(base, Math.min(Math.ceil(retryAfterMs), 600_000));
    }
    return base;
  }
  if (status === 401 || status === 403) return 300_000;
  return 15_000;
}

function shouldSwitch(err: UpstreamError): boolean {
  return err.retryable || err.status === 401 || err.status === 403;
}

function httpStatusOf(err: UpstreamError): number {
  return err.status >= 400 && err.status <= 599 ? err.status : 502;
}

function errorResponse(status: number, message: string, format: string = "openai"): Response {
  const body =
    format === "anthropic"
      ? { type: "error", error: { type: status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error", message } }
      : { error: { message, type: "provider_error", code: status, param: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Injected rate-limit check (wired by app.ts; null/undefined = disabled). */
export interface RateLimitCheck {
  connectionId: string;
  keyId?: string;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit?: number;
}

export type RateLimitFn = (info: RateLimitCheck) => RateLimitVerdict;

function verdictOf(raw: unknown): RateLimitVerdict {
  const r = (raw ?? {}) as Partial<RateLimitVerdict>;
  const remaining = typeof r.remaining === "number" && Number.isFinite(r.remaining) ? Math.max(0, Math.floor(r.remaining)) : 0;
  const resetMs = typeof r.resetMs === "number" && Number.isFinite(r.resetMs) && r.resetMs > 0 ? r.resetMs : 60_000;
  const limit = typeof r.limit === "number" && Number.isFinite(r.limit) ? Math.max(0, Math.floor(r.limit)) : undefined;
  return { allowed: r.allowed !== false, remaining, resetMs, ...(limit === undefined ? {} : { limit }) };
}

/** Connection-scope check, fail-open: a throwing limiter must never break the gateway. */
function checkConnLimit(rateLimit: RateLimitFn | undefined, connectionId: string): RateLimitVerdict | null {
  if (!rateLimit) return null;
  try {
    return verdictOf(rateLimit({ connectionId }));
  } catch {
    return null;
  }
}

function rateLimitHeaders(rl: RateLimitVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    "Retry-After": String(Math.max(1, Math.ceil(rl.resetMs / 1000))),
    "X-RateLimit-Remaining": String(rl.remaining),
    "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000 + rl.resetMs / 1000)),
  };
  if (rl.limit !== undefined) headers["X-RateLimit-Limit"] = String(rl.limit);
  return headers;
}

function rateLimitExceeded(codec: ClientCodec, message: string, rl: RateLimitVerdict): Response {
  return new Response(JSON.stringify(codec.errorBody(429, message)), {
    status: 429,
    headers: { "content-type": "application/json", ...rateLimitHeaders(rl) },
  });
}

function toUpstreamError(e: unknown, providerId: string): UpstreamError {
  if (e instanceof UpstreamError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new UpstreamError(502, `network error: ${msg}`, providerId, true);
}

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (e instanceof Error && e.name === "AbortError");
}

function errorFromEvent(ev: Extract<CanonicalEvent, { type: "error" }>, providerId: string): UpstreamError {
  const retryable = ev.status === 429 || ev.status >= 500;
  return new UpstreamError(ev.status, ev.message, ev.provider ?? providerId, retryable);
}

class SwitchCandidate {
  err: UpstreamError;
  st: AttemptStats;
  constructor(err: UpstreamError, st: AttemptStats) {
    this.err = err;
    this.st = st;
  }
}

async function* tracked(st: AttemptStats, events: AsyncIterable<CanonicalEvent>, providerId: string): AsyncGenerator<CanonicalEvent> {
  for await (const ev of events) {
    noteEvent(st, ev);
    if (ev.type === "error") throw errorFromEvent(ev, providerId);
    yield ev;
  }
}


// ---------- client codecs ----------

interface ClientCodec {
  begin(): string[];
  encode(ev: CanonicalEvent): string[];
  close(): string[];
  doneFrame(): string;
  collect(model: string, events: AsyncIterable<CanonicalEvent>): Promise<unknown>;
  errorBody(status: number, message: string): unknown;
}

function openAICodec(model: string, id: string): ClientCodec {
  const enc = openaiEncoder(model, id);
  return {
    begin: (): string[] => [],
    encode: (ev: CanonicalEvent): string[] => enc.encode(ev).map((line) => `data: ${line}\n\n`),
    close: (): string[] => enc.close().map((line) => `data: ${line}\n\n`),
    doneFrame: (): string => "data: [DONE]\n\n",
    collect: (m: string, evs: AsyncIterable<CanonicalEvent>): Promise<unknown> => collectOpenAI(m, evs),
    errorBody: (status: number, message: string): unknown => ({ error: { message, type: "provider_error", code: status, param: null } }),
  };
}

function geminiCodec(model: string, id: string): ClientCodec {
  const enc = geminiEncoder(model, id);
  return {
    begin: (): string[] => (enc as unknown as { begin?: () => string[] }).begin?.() ?? [],
    encode: (ev: CanonicalEvent): string[] => enc.encode(ev),
    close: (): string[] => (enc as unknown as { close?: () => string[] }).close?.() ?? [],
    doneFrame: (): string => "",
    collect: (m: string, evs: AsyncIterable<CanonicalEvent>): Promise<unknown> => collectGemini(m, evs),
    errorBody: (status: number, message: string): unknown => ({ error: { message, code: status } }),
  };
}

function responsesCodec(model: string, id: string): ClientCodec {
  const enc = responsesEncoder(id, model);
  return {
    begin: (): string[] => (enc as unknown as { begin?: () => string[] }).begin?.() ?? [],
    encode: (ev: CanonicalEvent): string[] => enc.encode(ev),
    close: (): string[] => (enc as unknown as { close?: () => string[] }).close?.() ?? [],
    doneFrame: (): string => "data: [DONE]\n\n",
    collect: (m: string, evs: AsyncIterable<CanonicalEvent>): Promise<unknown> => collectResponses(m, evs),
    errorBody: (status: number, message: string): unknown => ({ error: { message, type: "invalid_request_error", code: status } }),
  };
}

function anthropicCodec(model: string, id: string): ClientCodec {
  const enc = claudeEncoder(model, id);
  return {
    begin: () => enc.begin(),
    encode: (ev) => enc.encode(ev),
    close: () => enc.close(),
    doneFrame: () => "",
    collect: (m, evs) => collectAnthropic(m, evs),
    errorBody: (status, message) => ({
      type: "error",
      error: { type: status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error", message },
    }),
  };
}

function codecFor(format: string, model: string, id: string): ClientCodec {
  if (format === "anthropic") return anthropicCodec(model, id);
  if (format === "gemini") return geminiCodec(model, id);
  if (format === "responses") return responsesCodec(model, id);
  return openAICodec(model, id);
}

// ---------- stream per candidate ----------

async function attemptStream(
  res: Resolved,
  cand: Candidate,
  st: AttemptStats,
  signal: AbortSignal,
  fallbackFrom: string | undefined,
  commit: () => void,
  push: (frame: string) => void,
  codec: ClientCodec,
  keyId?: string,
  rc?: ReqCapture,
): Promise<void> {
  let events: AsyncIterable<CanonicalEvent>;
  let cred: Credential | null = null;
  try {
    cred = await freshCredential(cand);
    st.egress = egressHost(cred.proxyUrl);
    events = await executorFor(cand.provider, cand.model).execute({
      request: maybeCompress({ ...res.request, model: cand.model }),
      credential: cred,
      signal,
    });
  } catch (e) {
    // proxy_wait: queue behind the pool once, then retry the same candidate
    if (e instanceof WaitForProxy && cand.connection.proxy_wait && !signal.aborted) {
      const waited = await waitForHealthyProxy(signal, 90_000);
      if (waited) return attemptStream(res, cand, st, signal, fallbackFrom, commit, push, codec, keyId, rc);
    }
    const up = toUpstreamError(e, cand.provider.id);
    if (cred?.proxyAuto && cred.proxyUrl && (up.status === 429 || up.status >= 500)) markProxyBad(cred.proxyUrl, { prune: up.message.startsWith("network error") });
    throw new SwitchCandidate(up, st);
  }

  let terminalError: UpstreamError | null = null;
  try {
    for await (const ev of events) {
      noteEvent(st, ev);
      if (ev.type === "error") {
        const err = errorFromEvent(ev, cand.provider.id);
        if (!st.committed) throw new SwitchCandidate(err, st);
        terminalError = err;
        break;
      }
      for (const frame of codec.encode(ev)) {
        push(frame);
        if (!st.committed) {
          st.committed = true;
          commit();
        }
      }
      if (ev.type === "done") break;
    }
    if (signal.aborted) {
      record(res, cand, st, false, 499, "client disconnected", fallbackFrom, keyId, rc);
      return;
    }
    if (!st.committed) {
      // Empty/garbage stream: never synthesize a fake 200 — fail over instead.
      if (!st.text && !st.tools.length && !st.reasoning) {
        throw new SwitchCandidate(new UpstreamError(502, `empty response from ${cand.provider.id}`, cand.provider.id, true), st);
      }
      st.committed = true;
      commit();
      for (const frame of codec.begin()) push(frame);
    }
    if (!terminalError) {
      markActive(cand.connection.id);
      record(res, cand, st, true, 200, undefined, fallbackFrom, keyId, rc);
    }
  } catch (e) {
    if (e instanceof SwitchCandidate) throw e;
    if (isAbort(e, signal)) {
      if (st.committed) record(res, cand, st, false, 499, "client disconnected", fallbackFrom, keyId, rc);
      else throw new SwitchCandidate(new UpstreamError(502, "request aborted", cand.provider.id, false), st);
      return;
    }
    const err = toUpstreamError(e, cand.provider.id);
    if (!st.committed) throw new SwitchCandidate(err, st);
    terminalError = err;
  } finally {
    if (st.committed) {
      if (terminalError) {
        for (const frame of codec.encode({ type: "error", status: httpStatusOf(terminalError), message: terminalError.message })) push(frame);
      }
      for (const frame of codec.close()) push(frame);
      const done = codec.doneFrame();
      if (done) push(done);
      if (terminalError) {
        record(res, cand, st, false, httpStatusOf(terminalError), terminalError.message, fallbackFrom, keyId, rc);
      }
    }
  }
}

async function handleNonStream(res: Resolved, clientSignal: AbortSignal, keyId?: string, rateLimit?: RateLimitFn): Promise<Response> {
  const rc = newCapture(res);
  try {
    let fallbackFrom: string | undefined;
    let last = { status: 502, message: "all providers failed" };
    const codec = codecFor(res.format, res.requested, newId(res.format === "anthropic" ? "msg" : "chatcmpl"));
    // per-key model scopes: shrink candidates before spending anything
    if (keyId) {
      const { keyControls } = await import("../shared/db.ts");
      const allow = keyControls(keyId)?.allowModels ?? null;
      if (allow) {
        res = { ...res, candidates: res.candidates.filter((c) => keyAllowsModel(allow, c.provider.id, c.model)) };
        if (!res.candidates.length) {
          // blocked pre-flight: HTTP layer still logs the 403; nothing billable happened
          logBlocked(res, 403, "key is not allowed to use this model", keyId);
          return errorResponse(403, "key is not allowed to use this model", res.format);
        }
      }
    }
    // budget + prepaid balance short-circuit
    if (keyId) {
      const { monthSpendFor, keyBudget } = await import("../shared/db.ts");
      const b = keyBudget(keyId);
      if (b?.budget != null && monthSpendFor(keyId) >= b.budget) {
        logBlocked(res, 429, "monthly budget exceeded", keyId);
      return new Response(JSON.stringify(codec.errorBody(429, "monthly budget exceeded")), { status: 429, headers: { "content-type": "application/json" } });
      }
      const bal = keyBalance(keyId);
      if (bal != null && bal <= 0) {
        logBlocked(res, 402, "prepaid balance exhausted", keyId);
      return new Response(JSON.stringify(codec.errorBody(402, "prepaid balance exhausted — top up this key")), { status: 402, headers: { "content-type": "application/json" } });
      }
    }
    let lastRl: RateLimitVerdict | null = null;
    for (const cand of res.candidates) {
      const st = newStats();
      const rl = checkConnLimit(rateLimit, cand.connection.id);
      if (rl && !rl.allowed) {
        const msg = "connection rate limit exceeded";
        record(res, cand, st, false, 429, msg, fallbackFrom, keyId, rc);
        last = { status: 429, message: msg };
        lastRl = rl;
        markCooldown(cand.connection.id, Math.max(cooldownMsFor(429), rl.resetMs), msg);
        fallbackFrom = `${cand.provider.id}/${cand.model}`;
        continue;
      }
      let cred: Credential | null = null;
      try {
        try {
          cred = await freshCredential(cand);
        } catch (e) {
          // proxy_wait: queue behind the pool instead of failing fast
          if (e instanceof WaitForProxy && cand.connection.proxy_wait && !clientSignal.aborted) {
            const waited = await waitForHealthyProxy(clientSignal, 90_000);
            if (waited) cred = await freshCredential(cand);
            else throw e;
          } else throw e;
        }
        st.egress = egressHost(cred.proxyUrl);
        const events = await executorFor(cand.provider, cand.model).execute({
          request: maybeCompress({ ...res.request, model: cand.model }),
          credential: cred,
          signal: clientSignal,
        });
        const json = await codec.collect(res.requested, tracked(st, events, cand.provider.id)) as Record<string, unknown>;
        if (!st.text && !st.tools.length && !st.reasoning) {
          throw new UpstreamError(502, `empty response from ${cand.provider.id}`, cand.provider.id, true);
        }
        markActive(cand.connection.id);
        record(res, cand, st, true, 200, undefined, fallbackFrom, keyId, rc);
        return Response.json(json);
      } catch (e) {
        if (isAbort(e, clientSignal)) {
          record(res, cand, st, false, 499, "client disconnected", fallbackFrom, keyId, rc);
          return errorResponse(499, "request aborted", res.format);
        }
        const err = toUpstreamError(e, cand.provider.id);
        const status = httpStatusOf(err);
        if (cred?.proxyAuto && cred.proxyUrl && (status === 429 || status >= 500)) markProxyBad(cred.proxyUrl, { prune: err.message.startsWith("network error") });
        record(res, cand, st, false, status, err.message, fallbackFrom, keyId, rc);
        last = { status, message: err.message };
        lastRl = null;
        if (!shouldSwitch(err)) break;
        markCooldown(cand.connection.id, cooldownMsFor(err.status, retryAfterMsOf(err)), err.message);
        fallbackFrom = `${cand.provider.id}/${cand.model}`;
      }
    }
    if (last.status === 429 && lastRl) return rateLimitExceeded(codec, last.message, lastRl);
    return errorResponse(last.status, last.message, res.format);
  } finally {
    finishChatTurn(rc);
  }
}

async function handleStream(res: Resolved, clientSignal: AbortSignal, keyId?: string, rateLimit?: RateLimitFn): Promise<Response> {
  const rc = newCapture(res);
  if (keyId) {
    // Gate order is scope -> budget -> balance everywhere (matches non-stream).
    const { keyControls } = await import("../shared/db.ts");
    const allow = keyControls(keyId)?.allowModels ?? null;
    if (allow) {
      res = { ...res, candidates: res.candidates.filter((c) => keyAllowsModel(allow, c.provider.id, c.model)) };
      if (!res.candidates.length) {
        logBlocked(res, 403, "key is not allowed to use this model", keyId);
        return errorResponse(403, "key is not allowed to use this model", res.format);
      }
    }
    const { monthSpendFor, keyBudget } = await import("../shared/db.ts");
    const b = keyBudget(keyId);
    if (b?.budget != null && monthSpendFor(keyId) >= b.budget) {
      const codec = codecFor(res.format, res.requested, newId(res.format === "anthropic" ? "msg" : "chatcmpl"));
      logBlocked(res, 429, "monthly budget exceeded", keyId);
      return new Response(JSON.stringify(codec.errorBody(429, "monthly budget exceeded")), { status: 429, headers: { "content-type": "application/json" } });
    }
    const bal = keyBalance(keyId);
    if (bal != null && bal <= 0) {
      const codec = codecFor(res.format, res.requested, newId(res.format === "anthropic" ? "msg" : "chatcmpl"));
      logBlocked(res, 402, "prepaid balance exhausted", keyId);
      return new Response(JSON.stringify(codec.errorBody(402, "prepaid balance exhausted — top up this key")), { status: 402, headers: { "content-type": "application/json" } });
    }
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let resolveSettled!: () => void;
  const settledP = new Promise<void>((r) => {
    resolveSettled = r;
  });
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>((r) => {
    resolveFirst = r;
  });
  let commitFired = false;
  const commit = () => {
    if (commitFired) return;
    commitFired = true;
    resolveFirst();
  };
  const push = (frame: string) => {
    queue.push(frame);
    wake?.();
    wake = null;
  };

  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  clientSignal.addEventListener("abort", onClientAbort, { once: true });

  let failure: { status: number; message: string } | null = null;
  let lastFailure: { status: number; message: string } | null = null;
  let failureRl: RateLimitVerdict | null = null;
  const codec = codecFor(res.format, res.requested, newId(res.format === "anthropic" ? "msg" : "chatcmpl"));

  const run = async (): Promise<void> => {
    let fallbackFrom: string | undefined;
    try {
      for (const cand of res.candidates) {
        const st = newStats();
        const rl = checkConnLimit(rateLimit, cand.connection.id);
        if (rl && !rl.allowed) {
          const msg = "connection rate limit exceeded";
          record(res, cand, st, false, 429, msg, fallbackFrom, keyId, rc);
          lastFailure = { status: 429, message: msg };
          failureRl = rl;
          markCooldown(cand.connection.id, Math.max(cooldownMsFor(429), rl.resetMs), msg);
          fallbackFrom = `${cand.provider.id}/${cand.model}`;
          continue;
        }
        try {
          await attemptStream(res, cand, st, ac.signal, fallbackFrom, commit, push, codec, keyId, rc);
          return;
        } catch (e) {
          if (e instanceof SwitchCandidate) {
            const status = httpStatusOf(e.err);
            record(res, cand, e.st, false, status, e.err.message, fallbackFrom, keyId, rc);
            lastFailure = { status, message: e.err.message };
            failureRl = null;
            if (!shouldSwitch(e.err)) {
              failure = lastFailure;
              return;
            }
            markCooldown(cand.connection.id, cooldownMsFor(e.err.status, retryAfterMsOf(e.err)), e.err.message);
            fallbackFrom = `${cand.provider.id}/${cand.model}`;
            continue;
          }
          if (isAbort(e, ac.signal)) return;
          const err = toUpstreamError(e, cand.provider.id);
          failure = { status: 500, message: err.message };
          failureRl = null;
          record(res, cand, st, false, 500, err.message, fallbackFrom, keyId, rc);
          return;
        }
      }
      failure = lastFailure ?? { status: 502, message: "all providers failed" };
    } finally {
      finishChatTurn(rc);
      clientSignal.removeEventListener("abort", onClientAbort);
      ended = true;
      commit();
      wake?.();
      wake = null;
      resolveSettled();
    }
  };
  void run();

  await firstFrame;
  if (!queue.length) {
    if (!ended) await settledP;
    const info = failure ?? lastFailure ?? { status: 502, message: "all providers failed" };
    if (info.status === 429 && failureRl) return rateLimitExceeded(codec, info.message, failureRl);
    return errorResponse(info.status, info.message, res.format);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        while (queue.length) controller.enqueue(enc.encode(queue.shift()!));
        if (ended && !queue.length) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      controller.close();
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}


export async function handleChatCompletion(c: { json: () => Promise<unknown>; signal?: AbortSignal; keyId?: string; rateLimit?: RateLimitFn }): Promise<Response> {
  let body: OpenAIChatRequest;
  try {
    body = (await c.json()) as OpenAIChatRequest;
  } catch {
    return errorResponse(400, "invalid JSON body", "openai");
  }
  if (typeof body !== "object" || body === null || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return errorResponse(400, "missing `model` or `messages` in request body", "openai");
  }

  let res: Resolved;
  try {
    res = resolveChat(body);
  } catch (e) {
    if (e instanceof RouteError) return errorResponse(e.status, e.message, "openai");
    return errorResponse(400, e instanceof Error ? e.message : String(e), "openai");
  }

  const clientSignal = c.signal ?? new AbortController().signal;
  if (clientSignal.aborted) return errorResponse(499, "request aborted", "openai");

  if (res.request.stream) return handleStream(res, clientSignal, c.keyId, c.rateLimit);
  return handleNonStream(res, clientSignal, c.keyId, c.rateLimit);
}

export async function handleMessagesCompletion(c: { json: () => Promise<unknown>; signal?: AbortSignal; keyId?: string; rateLimit?: RateLimitFn }): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await c.json()) as AnthropicRequest;
  } catch {
    return errorResponse(400, "invalid JSON body", "anthropic");
  }
  if (typeof body !== "object" || body === null || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return errorResponse(400, "missing `model` or `messages` in request body", "anthropic");
  }

  let res: Resolved;
  try {
    res = resolveMessages(body);
  } catch (e) {
    if (e instanceof RouteError) return errorResponse(e.status, e.message, "anthropic");
    return errorResponse(400, e instanceof Error ? e.message : String(e), "anthropic");
  }

  const clientSignal = c.signal ?? new AbortController().signal;
  if (clientSignal.aborted) return errorResponse(499, "request aborted", "anthropic");
  const stream = (body as unknown as { stream?: boolean }).stream === true;
  res = { ...res, request: { ...res.request, stream } };
  if (stream) return handleStream(res, clientSignal, c.keyId, c.rateLimit);
  return handleNonStream(res, clientSignal, c.keyId, c.rateLimit);
}

export async function handleGeminiGenerate(c: { json: () => Promise<unknown>; model?: string; signal?: AbortSignal; keyId?: string; rateLimit?: RateLimitFn }): Promise<Response> {
  let body: GeminiRequest;
  try {
    body = (await c.json()) as GeminiRequest;
  } catch {
    return errorResponse(400, "invalid JSON body", "gemini");
  }
  if (typeof body !== "object" || body === null) {
    return errorResponse(400, "invalid request body", "gemini");
  }
  let res: Resolved;
  try {
    res = resolveGemini(body, c.model);
  } catch (e) {
    if (e instanceof RouteError) return errorResponse(e.status, e.message, "gemini");
    return errorResponse(400, e instanceof Error ? e.message : String(e), "gemini");
  }
  const clientSignal = c.signal ?? new AbortController().signal;
  if (clientSignal.aborted) return errorResponse(499, "request aborted", "gemini");
  const stream = (body as unknown as { stream?: boolean }).stream === true;
  res = { ...res, request: { ...res.request, stream } };
  if (stream) return handleStream(res, clientSignal, c.keyId, c.rateLimit);
  return handleNonStream(res, clientSignal, c.keyId, c.rateLimit);
}

export async function handleResponsesCompletion(c: { json: () => Promise<unknown>; signal?: AbortSignal; keyId?: string; rateLimit?: RateLimitFn }): Promise<Response> {
  let body: import("./translate/responses.ts").ResponsesRequest;
  try {
    body = (await c.json()) as import("./translate/responses.ts").ResponsesRequest;
  } catch {
    return errorResponse(400, "invalid JSON body", "responses");
  }
  if (typeof body !== "object" || body === null || typeof body.model !== "string") {
    return errorResponse(400, "missing `model` in request body", "responses");
  }
  let res: Resolved;
  try {
    res = resolveResponses(body);
  } catch (e) {
    if (e instanceof RouteError) return errorResponse(e.status, e.message, "responses");
    return errorResponse(400, e instanceof Error ? e.message : String(e), "responses");
  }
  const clientSignal = c.signal ?? new AbortController().signal;
  if (clientSignal.aborted) return errorResponse(499, "request aborted", "responses");
  const stream = body.stream === true;
  res = { ...res, request: { ...res.request, stream } };
  if (stream) return handleStream(res, clientSignal, c.keyId, c.rateLimit);
  return handleNonStream(res, clientSignal, c.keyId, c.rateLimit);
}

export async function handleCountTokens(c: { json: () => Promise<unknown> }): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await c.json()) as AnthropicRequest;
  } catch {
    return errorResponse(400, "invalid JSON body", "anthropic");
  }
  return Response.json({ input_tokens: estimateTokens(body) });
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const headers = c.req.raw.headers;
  const bearer = headers.get("authorization");
  const apiKey = headers.get("x-api-key");
  const secret = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : (apiKey ?? undefined);
  const keyId = secret ? getKeyIdForSecret(secret) : null;
  if (!keyId) {
    return c.json({ error: { message: "invalid api key", type: "authentication_error", code: "invalid_api_key", param: null } }, 401);
  }
  const { keyControls } = await import("../shared/db.ts");
  const ctl = keyControls(keyId);
  if (ctl?.disabled) {
    return c.json({ error: { message: "api key is disabled", type: "authentication_error", code: "key_disabled", param: null } }, 403);
  }
  if (ctl && ctl.ipAllowlist.length) {
    const ip = clientIp(c);
    if (!ip || !ctl.ipAllowlist.some((a) => ipMatches(a, ip))) {
      return c.json({ error: { message: "api key is not allowed from this IP", type: "authentication_error", code: "ip_forbidden", param: null } }, 403);
    }
  }
  // budget enforcement for dashboard clients is handled in gateway per-request; here just gate
  c.set("keyId" as never, keyId as never);
  // expose for handlers that receive raw context-less calls? handlers check c.keyId param; this covers Hono-routed calls
  (c as unknown as Record<string, unknown>).keyId = keyId;
  await next();
};

function clientIp(c: { req: { header: (n: string) => string | undefined }; env?: unknown }): string | null {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  try {
    const env = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env;
    const ra = env?.incoming?.socket?.remoteAddress;
    if (ra) return ra.replace(/^::ffff:/, "");
  } catch {}
  return null;
}

function ipMatches(pattern: string, ip: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === ip) return true;
  // 192.168.1.* style prefix
  if (p.endsWith("*") && ip.startsWith(p.slice(0, -1))) return true;
  // CIDR (v4 only)
  const slash = p.indexOf("/");
  if (slash > 0) {
    const bits = Number(p.slice(slash + 1));
    if (Number.isInteger(bits) && bits >= 0 && bits <= 32) {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const toN = (s: string) => s.split(".").reduce((a, o) => (a << 8) + (Number(o) || 0), 0) >>> 0;
      return (toN(p.slice(0, slash)) & mask) === (toN(ip) & mask);
    }
  }
  return false;
}

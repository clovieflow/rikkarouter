import { createHash } from "node:crypto";
import { all, get, run } from "../shared/db.ts";

// Full conversation capture for multi-tenant serving: bodies per request,
// per-key toggles, retention, training export (OpenAI JSONL / ShareGPT / raw).

export interface AttemptEntry {
  connection: string;
  provider: string;
  model: string;
  proxy: string | null;
  status: number;
  latencyMs: number;
  error?: string;
}

export interface ChatTurn {
  id: string;
  ts: number;
  key_id: string | null;
  provider: string;
  model: string;
  requested: string;
  connection_id: string | null;
  egress: string | null;
  format: string;
  ok: number;
  status: number;
  finish: string | null;
  latency_ms: number;
  ttft_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  quality: number | null;
  content_hash: string | null;
  error: string | null;
  attempts: AttemptEntry[];
  request: { messages: unknown[]; tools?: unknown } | null;
  response: string | null;
  reasoning: string | null;
  toolCalls: Array<{ id?: string; name?: string; args?: string }> | null;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function bodiesGloballyEnabled(): boolean {
  return (process.env.RIKKA_LOG_BODIES ?? "1") !== "0";
}

export function keyAllowsBodies(keyId: string | null | undefined): boolean {
  if (!keyId) return true;
  try {
    const row = get("SELECT log_bodies FROM api_keys WHERE id = ?", keyId) as { log_bodies: number | null } | undefined;
    return (row?.log_bodies ?? 1) !== 0;
  } catch {
    return true;
  }
}

export function bodiesAllowed(keyId: string | null | undefined): boolean {
  return bodiesGloballyEnabled() && keyAllowsBodies(keyId);
}

function cap(s: string | null | undefined): string | null {
  if (s == null) return null;
  const max = envNum("RIKKA_CHAT_MAX_CHARS", 100_000);
  return s.length > max ? s.slice(0, max) : s;
}

export function contentHash(request: unknown, response: string | null, tools: unknown): string | null {
  if (response == null) return null;
  try {
    return createHash("sha256").update(JSON.stringify([request, response, tools ?? null])).digest("hex");
  } catch {
    return null;
  }
}

/** Heuristic quality 1-5 (no external calls): errors sink, substance floats. */
export function qualityScore(ok: boolean, outputChars: number, toolCalls: number): number {
  let q = ok ? 3 : 1;
  if (ok && outputChars >= 200) q += 1;
  if (ok && toolCalls <= 3) q += 1;
  if (outputChars < 20) q -= 1;
  if (!ok) q = Math.min(q, 2);
  return Math.max(1, Math.min(5, q));
}

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\bsk-[A-Za-z0-9-_]{10,}\b/g, "[api-key]"],
  [/\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{12,}/gi, "$1[token]"],
  [/\b[0-9a-f]{32,}\b/gi, "[secret]"],
  [/"api_?key"\s*:\s*"[^"]+"/gi, '"api_key":"[redacted]"'],
];

/** Scrub likely secrets before export/training. Raw rows stay untouched. */
export function scrubPII(text: string): string {
  let out = text;
  for (const [re, rep] of PII_PATTERNS) out = out.replace(re, rep);
  return out;
}

export interface ChatTurnInput {
  id: string;
  keyId?: string | null;
  provider: string;
  model: string;
  requested: string;
  format: string;
  connectionId?: string | null;
  egress?: string | null;
  ok: boolean;
  status: number;
  finish?: string | null;
  latencyMs: number;
  ttftMs: number;
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  error?: string;
  attempts: AttemptEntry[];
  request?: { messages: unknown[]; tools?: unknown } | null;
  response?: string | null;
  reasoning?: string | null;
  toolCalls?: Array<{ id?: string; name?: string; args?: string }>;
}

export function recordChatTurn(t: ChatTurnInput): void {
  const allowed = bodiesAllowed(t.keyId ?? null);
  const req = allowed ? t.request ?? null : null;
  const res = allowed ? (t.response ?? null) : null;
  const tools = allowed ? (t.toolCalls?.length ? t.toolCalls : null) : null;
  const reason = allowed ? (t.reasoning ?? null) : null;
  const outChars = res?.length ?? 0;
  try {
    run(
      `INSERT INTO chat_turns(id,ts,key_id,provider,model,requested,connection_id,egress,format,ok,status,finish,
        latency_ms,ttft_ms,input_tokens,output_tokens,cached_tokens,cost_usd,quality,content_hash,error,
        attempts_json,request_json,response_text,reasoning_text,tool_calls_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id,
      Date.now(),
      t.keyId ?? null,
      t.provider,
      t.model,
      t.requested,
      t.connectionId ?? null,
      t.egress ?? null,
      t.format,
      t.ok ? 1 : 0,
      t.status,
      t.finish ?? null,
      t.latencyMs,
      t.ttftMs,
      t.input,
      t.output,
      t.cached,
      t.costUsd,
      qualityScore(t.ok, outChars, tools?.length ?? 0),
      allowed ? contentHash(req?.messages ?? null, res, tools) : null,
      t.error?.slice(0, 500) ?? null,
      JSON.stringify(t.attempts).slice(0, 20_000),
      req ? cap(JSON.stringify(req)) : null,
      cap(res),
      cap(reason),
      tools ? cap(JSON.stringify(tools)) : null,
    );
  } catch (e) {
    // logging must never break a response — but never fail silently either
    try {
      console.warn("chatlog insert failed:", e instanceof Error ? e.message : String(e));
    } catch {}
  }
  if (Math.random() < 0.02) {
    try {
      pruneChatTurns();
    } catch {}
  }
}

export function pruneChatTurns(): { deleted: number } {
  const days = envNum("RIKKA_CHAT_RETENTION_DAYS", 90);
  const maxRows = envNum("RIKKA_CHAT_MAX_ROWS", 200_000);
  let deleted = 0;
  if (days > 0) {
    const r = get("SELECT COUNT(*) AS n FROM chat_turns WHERE ts < ?", Date.now() - days * 86_400_000) as { n: number };
    run("DELETE FROM chat_turns WHERE ts < ?", Date.now() - days * 86_400_000);
    deleted += r?.n ?? 0;
  }
  if (maxRows > 0) {
    const total = (get("SELECT COUNT(*) AS n FROM chat_turns") as { n: number })?.n ?? 0;
    if (total > maxRows) {
      const over = total - maxRows;
      run("DELETE FROM chat_turns WHERE id IN (SELECT id FROM chat_turns ORDER BY ts ASC LIMIT ?)", over);
      deleted += over;
    }
  }
  return { deleted };
}

export interface ChatFilters {
  keyId?: string;
  provider?: string;
  model?: string;
  ok?: boolean;
  minQuality?: number;
  q?: string;
  since?: number;
  limit?: number;
  offset?: number;
  ids?: string[];
}

function chatWhere(f: ChatFilters): { where: string; params: Array<string | number> } {
  const w: string[] = [];
  const p: Array<string | number> = [];
  if (f.keyId !== undefined) {
    w.push("key_id = ?");
    p.push(f.keyId);
  }
  if (f.provider !== undefined) {
    w.push("provider = ?");
    p.push(f.provider);
  }
  if (f.model !== undefined) {
    w.push("model = ?");
    p.push(f.model);
  }
  if (f.ok !== undefined) {
    w.push("ok = ?");
    p.push(f.ok ? 1 : 0);
  }
  if (f.minQuality !== undefined) {
    w.push("quality >= ?");
    p.push(f.minQuality);
  }
  if (f.since !== undefined) {
    w.push("ts >= ?");
    p.push(f.since);
  }
  if (f.q !== undefined && f.q !== "") {
    w.push("(request_json LIKE ? OR response_text LIKE ?)");
    p.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.ids !== undefined && f.ids.length) {
    const clean = f.ids.filter((id) => typeof id === "string" && id.length && id.length <= 64).slice(0, 500);
    if (clean.length) {
      w.push(`id IN (${clean.map(() => "?").join(",")})`);
      p.push(...clean);
    }
  }
  return { where: w.length ? `WHERE ${w.join(" AND ")}` : "", params: p };
}

const CHAT_COLS =
  "id,ts,key_id,provider,model,requested,connection_id,egress,format,ok,status,finish,latency_ms,ttft_ms," +
  "input_tokens,output_tokens,cached_tokens,cost_usd,quality,content_hash,error,attempts_json,request_json," +
  "response_text,reasoning_text,tool_calls_json";

function parseRow(r: Record<string, string | number | null | undefined>): ChatTurn {
  const j = (v: unknown) => {
    if (typeof v !== "string" || !v) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  return {
    id: String(r.id),
    ts: Number(r.ts),
    key_id: (r.key_id as string) ?? null,
    provider: String(r.provider),
    model: String(r.model),
    requested: String(r.requested),
    connection_id: (r.connection_id as string) ?? null,
    egress: (r.egress as string) ?? null,
    format: String(r.format ?? "openai"),
    ok: Number(r.ok),
    status: Number(r.status),
    finish: (r.finish as string) ?? null,
    latency_ms: Number(r.latency_ms),
    ttft_ms: Number(r.ttft_ms),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cached_tokens: Number(r.cached_tokens),
    cost_usd: Number(r.cost_usd),
    quality: r.quality == null ? null : Number(r.quality),
    content_hash: (r.content_hash as string) ?? null,
    error: (r.error as string) ?? null,
    attempts: (j(r.attempts_json) as AttemptEntry[]) ?? [],
    request: j(r.request_json) as ChatTurn["request"],
    response: (r.response_text as string) ?? null,
    reasoning: (r.reasoning_text as string) ?? null,
    toolCalls: j(r.tool_calls_json) as ChatTurn["toolCalls"],
  };
}

export function queryChats(f: ChatFilters = {}): ChatTurn[] {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 5000);
  const offset = Math.max(f.offset ?? 0, 0);
  const { where, params } = chatWhere(f);
  return all(`SELECT ${CHAT_COLS} FROM chat_turns ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`, ...params, limit, offset).map(
    (r) => parseRow(r as unknown as Record<string, string | number | null | undefined>),
  );
}

export function countChats(f: ChatFilters = {}): number {
  const { where, params } = chatWhere(f);
  return ((get(`SELECT COUNT(*) AS n FROM chat_turns ${where}`, ...params) as { n: number } | undefined)?.n ?? 0);
}

export function getChat(id: string): ChatTurn | null {
  const r = get(`SELECT ${CHAT_COLS} FROM chat_turns WHERE id = ?`, id) as unknown as Record<string, string | number | null | undefined> | undefined;
  return r ? parseRow(r) : null;
}

export function deleteChat(id: string): boolean {
  const before = (get("SELECT COUNT(*) AS n FROM chat_turns WHERE id = ?", id) as { n: number } | undefined)?.n ?? 0;
  run("DELETE FROM chat_turns WHERE id = ?", id);
  return before > 0;
}

export function chatStatsByKey(sinceMs: number): Array<Record<string, unknown>> {
  return all(
    `SELECT key_id, COUNT(*) n, SUM(ok) ok_n, SUM(input_tokens) inp, SUM(output_tokens) outp,
            SUM(cost_usd) cost, AVG(latency_ms) avg_ms, COUNT(DISTINCT model) models
     FROM chat_turns WHERE ts >= ? GROUP BY key_id ORDER BY n DESC`,
    sinceMs,
  );
}

/** 429 heatmap: hour-of-day (UTC) → attempts/result counts for one provider. */
export function heat429(provider: string, days = 7): Array<{ hour: number; n: number; r429: number }> {
  const rows = all(
    `SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) h, COUNT(*) n,
            SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) r
     FROM chat_turns WHERE provider = ? AND ts >= ? GROUP BY h ORDER BY h`,
    provider,
    Date.now() - days * 86_400_000,
  ) as Array<{ h: number; n: number; r: number }>;
  return rows.map((r) => ({ hour: Number(r.h), n: Number(r.n), r429: Number(r.r) }));
}

function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (o.type === "image_url" || o.type === "image") return "[image]";
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

export interface ExportFilters extends ChatFilters {
  dedup?: boolean;
  scrub?: boolean;
}

export type ExportFormat = "openai" | "sharegpt" | "raw";

/** Build training-ready lines. Tool history is preserved; export decides the shape. */
export function exportChats(f: ExportFilters, format: ExportFormat): { lines: string[]; count: number; skipped: number } {
  // Default training export = only ok turns; explicit ok filter OR explicit
  // id batch (user ticked exact rows, incl. failures) wins when provided.
  const turns = queryChats({ ...f, ...(f.ok === undefined && !f.ids?.length ? { ok: true } : {}), limit: 5000 });
  const { lines, skipped } = buildExportLines(turns, f, format, new Set<string>());
  return { lines, count: lines.length, skipped };
}

/** Per-page training-export builder (shares dedup state across pages). */
function buildExportLines(turns: ChatTurn[], f: ExportFilters, format: ExportFormat, seen: Set<string>): { lines: string[]; skipped: number } {
  const lines: string[] = [];
  let skipped = 0;
for (const t of turns) {
  if (!t.request) {
    skipped += 1;
    continue;
  }
  // thinking models answer in the reasoning channel — still trainable text
  const body = t.response ?? t.reasoning;
  if (body == null) {
    // Raw batch export keeps failed turns (error instead of response) so
    // "export selected" is exact; training formats can't use body-less turns.
    if (format === "raw" && f.ids?.length) {
      lines.push(JSON.stringify({ id: t.id, ts: t.ts, key: t.key_id, provider: t.provider, model: t.model, request: t.request, response: null, error: t.error, status: t.status, tools: t.toolCalls, quality: t.quality }));
      continue;
    }
    skipped += 1;
    continue;
  }
  if (f.dedup && t.content_hash) {
    if (seen.has(t.content_hash)) {
      skipped += 1;
      continue;
    }
    seen.add(t.content_hash);
  }
  const clean = (s: string) => (f.scrub === false ? s : scrubPII(s));
  if (format === "raw") {
    lines.push(JSON.stringify({ id: t.id, ts: t.ts, key: t.key_id, provider: t.provider, model: t.model, request: t.request, response: clean(body), tools: t.toolCalls, quality: t.quality }));
    continue;
  }
  const messages: Array<Record<string, unknown>> = [];
  for (const m of t.request.messages) {
    const msg = m as { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string; name?: string };
    const role = msg.role ?? "user";
    if (format === "openai") {
      if (role === "tool") {
        messages.push({ role: "tool", tool_call_id: msg.tool_call_id ?? "", content: clean(textOf(msg.content)) });
      } else if (role === "assistant" || role === "user" || role === "system") {
        const out: Record<string, unknown> = { role, content: clean(textOf(msg.content)) };
        if (msg.tool_calls) out.tool_calls = msg.tool_calls;
        if (msg.name) out.name = msg.name;
        messages.push(out);
      }
    } else {
      // sharegpt: human/gpt (+system); tool traffic folds into human turns
      if (role === "system") messages.push({ from: "system", value: clean(textOf(msg.content)) });
      else if (role === "assistant") {
        const gpt: Record<string, unknown> = { from: "gpt", value: clean(textOf(msg.content)) };
        if (msg.tool_calls) gpt.tool_calls = msg.tool_calls;
        messages.push(gpt);
      } else if (role === "tool") {
        messages.push({ from: "human", value: `[tool ${msg.name ?? msg.tool_call_id ?? "result"}]: ${clean(textOf(msg.content))}` });
      } else messages.push({ from: "human", value: clean(textOf(msg.content)) });
    }
  }
  const finalText = clean(body);
  if (format === "openai") {
    const last: Record<string, unknown> = { role: "assistant", content: finalText };
    if (t.toolCalls?.length) {
      last.tool_calls = t.toolCalls.map((tc, i) => ({ id: tc.id ?? `call_${i}`, type: "function", function: { name: tc.name ?? "tool", arguments: tc.args ?? "{}" } }));
    }
    messages.push(last);
    lines.push(JSON.stringify({ messages }));
  } else {
    messages.push({ from: "gpt", value: finalText });
    lines.push(JSON.stringify({ conversations: messages }));
  }
  }
  return { lines, skipped };
}

/** Paged training-export primitive for streaming responses. */
export function exportChatsPage(f: ExportFilters, format: ExportFormat, offset: number, seen: Set<string>): { lines: string[]; skipped: number; done: boolean } {
  const turns = queryChats({ ...f, ...(f.ok === undefined && !f.ids?.length ? { ok: true } : {}), limit: 500, offset });
  const r = buildExportLines(turns, f, format, seen);
  return { ...r, done: turns.length < 500 };
}


export function recordDatasetExport(format: string, filters: ChatFilters, count: number): string {
  const id = `ds_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  run("INSERT INTO dataset_exports(id,ts,format,filters_json,count) VALUES(?,?,?,?,?)", id, Date.now(), format, JSON.stringify(filters).slice(0, 2000), count);
  return id;
}

export function listDatasetExports(limit = 20): Array<Record<string, unknown>> {
  return all("SELECT id,ts,format,filters_json,count FROM dataset_exports ORDER BY ts DESC LIMIT ?", Math.min(Math.max(limit, 1), 100));
}

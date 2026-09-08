import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { dbFile } from "./config.ts";

// node:sqlite ships without TS defs in some @types/node versions — narrow locally.
type Row = Record<string, string | number | null | Uint8Array>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL,
  base_url TEXT,
  headers TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | cooldown | disabled
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  priority INTEGER NOT NULL DEFAULT 100,      -- lower = tried first within provider
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conn_provider ON connections(provider, status);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'default',
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,                       -- e.g. "coding"
  target TEXT NOT NULL,                         -- "openrouter/claude-sonnet-4.5" or combo spec
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  connection_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requested TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER NOT NULL DEFAULT 0,
  fallback_from TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE TABLE IF NOT EXISTS request_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  dur_ms INTEGER NOT NULL,
  line TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  combo TEXT,
  key_id TEXT,
  tokens_in INT,
  tokens_out INT,
  cost_usd REAL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT 'priority',   -- priority | weighted
  steps TEXT NOT NULL,                         -- JSON [{model:"prov/model", weight?:number}]
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_usd REAL NOT NULL,                     -- USD per 1M input tokens
  output_usd REAL NOT NULL,                    -- USD per 1M output tokens
  cache_read_usd REAL,                         -- per 1M cached input
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS proxy_pool (
  url TEXT PRIMARY KEY,
  source TEXT,
  last_check INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_turns (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  key_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requested TEXT NOT NULL,
  connection_id TEXT,
  egress TEXT,
  format TEXT NOT NULL DEFAULT 'openai',
  ok INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  finish TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  quality INTEGER,
  content_hash TEXT,
  error TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  request_json TEXT,
  response_text TEXT,
  reasoning_text TEXT,
  tool_calls_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_ts ON chat_turns(ts);
CREATE INDEX IF NOT EXISTS idx_chats_key ON chat_turns(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_chats_model ON chat_turns(model, ts);
CREATE INDEX IF NOT EXISTS idx_chats_hash ON chat_turns(content_hash);
CREATE TABLE IF NOT EXISTS dataset_exports (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  format TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS provider_health (
  target TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  status INTEGER,
  error TEXT
);
`;

// Idempotent column migrations (SQLite has no IF NOT EXISTS for ADD COLUMN).
const MIGRATIONS: string[] = [
  "ALTER TABLE connections ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'apikey'",
  "ALTER TABLE connections ADD COLUMN refresh_token TEXT",
  "ALTER TABLE connections ADD COLUMN expires_at INTEGER",
  "ALTER TABLE connections ADD COLUMN scope TEXT",
  "ALTER TABLE connections ADD COLUMN email TEXT",
  "ALTER TABLE connections ADD COLUMN extra TEXT",
  "ALTER TABLE api_keys ADD COLUMN budget_usd_monthly REAL",
  "ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0",
  "ALTER TABLE usage ADD COLUMN combo TEXT",
  "ALTER TABLE usage ADD COLUMN key_id TEXT",
  "ALTER TABLE request_log ADD COLUMN provider TEXT",
  "ALTER TABLE request_log ADD COLUMN model TEXT",
  "ALTER TABLE request_log ADD COLUMN combo TEXT",
  "ALTER TABLE request_log ADD COLUMN key_id TEXT",
  "ALTER TABLE request_log ADD COLUMN tokens_in INT",
  "ALTER TABLE request_log ADD COLUMN tokens_out INT",
  "ALTER TABLE request_log ADD COLUMN cost_usd REAL",
  "ALTER TABLE request_log ADD COLUMN error TEXT",
  "ALTER TABLE request_log ADD COLUMN egress TEXT",
  "ALTER TABLE connections ADD COLUMN models_cache TEXT",
  "ALTER TABLE connections ADD COLUMN models_cached_at INTEGER",
  "ALTER TABLE connections ADD COLUMN proxy_url TEXT",
  "ALTER TABLE connections ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'off'",
  "ALTER TABLE connections ADD COLUMN proxy_wait INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE api_keys ADD COLUMN log_bodies INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE api_keys ADD COLUMN balance_usd REAL",
  "ALTER TABLE api_keys ADD COLUMN allow_models TEXT",
  "ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT",
  "ALTER TABLE api_keys ADD COLUMN contact TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE api_keys ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE proxy_pool ADD COLUMN label TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE proxy_pool ADD COLUMN priority INTEGER NOT NULL DEFAULT 100",
  "ALTER TABLE proxy_pool ADD COLUMN quarantined_until INTEGER NOT NULL DEFAULT 0",
];

/** Bump this EVERY time a statement is appended to MIGRATIONS. Boot asserts it. */
export const SCHEMA_VERSION = 8;

function migrate(d: InstanceType<typeof DatabaseSync>): void {
  for (const sql of MIGRATIONS) {
    try {
      d.exec(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only "duplicate column" is an acceptable no-op here.
      if (!msg.includes("duplicate column")) throw e;
    }
  }
  // Backfill: connections that already had a proxy_url were manual by definition.
  d.exec("UPDATE connections SET proxy_mode='manual' WHERE proxy_mode='off' AND proxy_url IS NOT NULL AND proxy_url != ''");
  d.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(SCHEMA_VERSION),
  );
  const stored = (d.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
  if (stored !== String(SCHEMA_VERSION)) {
    throw new Error(`schema_version mismatch after migrate: stored=${stored ?? "missing"} expected=${SCHEMA_VERSION}`);
  }
}

let _db: InstanceType<typeof DatabaseSync> | null = null;

export function db(): InstanceType<typeof DatabaseSync> {
  if (!_db) {
    _db = new DatabaseSync(dbFile());
    _db.exec("PRAGMA journal_mode = WAL;");
    _db.exec(SCHEMA);
    migrate(_db);
  }
  return _db;
}

type SqlParam = string | number | null;

export function all(sql: string, ...params: SqlParam[]): Row[] {
  return db().prepare(sql).all(...params) as Row[];
}
export function get(sql: string, ...params: SqlParam[]): Row | undefined {
  return db().prepare(sql).get(...params) as Row | undefined;
}
export function run(sql: string, ...params: SqlParam[]): void {
  db().prepare(sql).run(...params);
}

export function setting(key: string): string | undefined {
  return get("SELECT value FROM meta WHERE key = ?", key)?.value as string | undefined;
}
export function setSetting(key: string, value: string): void {
  run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
}
export interface ConnectionRow {
  id: string;
  provider: string;
  name: string;
  api_key: string;
  base_url: string | null;
  headers: string | null;
  proxy_url: string | null;
  proxy_mode: string;
  proxy_wait: number;
  status: string;
  cooldown_until: number;
  last_error: string | null;
  priority: number;
  auth_kind: string;
  refresh_token: string | null;
  expires_at: number | null;
  models_cache: string | null;
  models_cached_at: number | null;
  scope: string | null;
  email: string | null;
  extra: string | null;
}
export function listConnections(provider?: string): ConnectionRow[] {
  const rows = (provider
    ? all("SELECT * FROM connections WHERE provider = ? ORDER BY priority, created_at", provider)
    : all("SELECT * FROM connections ORDER BY provider, priority, created_at")) as unknown as ConnectionRow[];
  const now = Date.now();
  // An expired cooldown already routes traffic (see usableConnections) — never
  // report a stale "cooldown" pill for a connection the router treats as live.
  // last_error is kept as history until the next attempt overwrites it.
  return rows.map((c) => (c.status === "cooldown" && c.cooldown_until <= now ? { ...c, status: "active", cooldown_until: 0 } : c));
}

export function usableConnections(provider: string): ConnectionRow[] {
  const now = Date.now();
  return listConnections(provider).filter(
    (c) => c.status === "active" || (c.status === "cooldown" && c.cooldown_until <= now),
  );
}

export function putConnection(c: {
  id: string;
  provider: string;
  name?: string;
  apiKey: string;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
  priority?: number;
  proxyUrl?: string | null;
  proxyMode?: string;
}): void {
  const now = Date.now();
  run(
    `INSERT INTO connections(id,provider,name,api_key,base_url,headers,priority,proxy_url,proxy_mode,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, api_key=excluded.api_key, base_url=excluded.base_url,
       headers=excluded.headers, priority=excluded.priority, proxy_url=excluded.proxy_url, proxy_mode=excluded.proxy_mode, status='active',
       cooldown_until=0, last_error=NULL, updated_at=excluded.updated_at`,
    c.id,
    c.provider,
    c.name ?? "",
    c.apiKey,
    c.baseUrl ?? null,
    c.headers ? JSON.stringify(c.headers) : null,
    c.priority ?? 100,
    c.proxyUrl ?? null,
    c.proxyMode ?? "off",
    now,
    now,
  );
}

export function deleteConnection(id: string): void {
  run("DELETE FROM connections WHERE id = ?", id);
}

export function markCooldown(id: string, ms: number, err: string): void {
  run(
    "UPDATE connections SET status='cooldown', cooldown_until=?, last_error=?, updated_at=? WHERE id=?",
    Date.now() + ms,
    err.slice(0, 500),
    Date.now(),
    id,
  );
}

export function markActive(id: string): void {
  run("UPDATE connections SET status='active', cooldown_until=0, last_error=NULL, updated_at=? WHERE id=?", Date.now(), id);
}


// ---------- api keys ----------

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createApiKey(name: string): { id: string; secret: string } {
  const id = randomBytes(6).toString("hex");
  const secret = `rk_${randomBytes(24).toString("base64url")}`;
  run("INSERT INTO api_keys(id,name,key_hash,created_at) VALUES(?,?,?,?)", id, name, sha256(secret), Date.now());
  return { id, secret };
}

export function getKeyIdForSecret(secret: string): string | null {
  const row = get("SELECT id FROM api_keys WHERE key_hash = ?", sha256(secret));
  if (!row) return null;
  run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", Date.now(), row.id as string);
  return row.id as string;
}

export function verifyApiKey(secret: string): boolean {
  return getKeyIdForSecret(secret) !== null;
}
export function ensureDefaultKey(): { id: string; secret: string } | null {
  const n = get("SELECT COUNT(*) AS n FROM api_keys") as { n: number };
  if (n.n > 0) return null;
  return createApiKey("default");
}


export function listApiKeys(): Array<Record<string, string | number | null>> {
  return all("SELECT id,name,created_at,last_used_at,budget_usd_monthly,log_bodies,balance_usd,allow_models,ip_allowlist,contact,disabled FROM api_keys ORDER BY created_at") as unknown as Array<Record<string, string | number | null>>;
}

export function deleteApiKey(id: string): void {
  run("DELETE FROM api_keys WHERE id = ?", id);
}

export function rotateApiKey(id: string): { secret: string } | null {
  const exists = get("SELECT id FROM api_keys WHERE id = ?", id);
  if (!exists) return null;
  const secret = `rk_${randomBytes(24).toString("base64url")}`;
  run("UPDATE api_keys SET key_hash = ? WHERE id = ?", sha256(secret), id);
  return { secret };
}
export function getAlias(alias: string): string | undefined {
  const row = get("SELECT target FROM model_aliases WHERE alias = ?", alias) as { target: string } | undefined;
  return row?.target;
}

export function putAlias(alias: string, target: string): void {
  run(
    "INSERT INTO model_aliases(alias,target,created_at) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET target=excluded.target",
    alias,
    target,
    Date.now(),
  );
}
export function deleteAlias(alias: string): void {
  run("DELETE FROM model_aliases WHERE alias = ?", alias);
}
export function listAliases(): Array<{ alias: string; target: string }> {
  return all("SELECT alias,target FROM model_aliases ORDER BY alias") as never;
}

// ---------- usage ----------

export function recordUsage(u: {
  connectionId?: string;
  provider: string;
  model: string;
  requested: string;
  ok: boolean;
  status: number;
  input: number;
  output: number;
  cached: number;
  latencyMs: number;
  ttftMs: number;
  fallbackFrom?: string;
  error?: string;
  costUsd?: number;
  combo?: string;
  keyId?: string;
}): void {
  run(
    `INSERT INTO usage(ts,connection_id,provider,model,requested,ok,status,input_tokens,output_tokens,cached_tokens,latency_ms,ttft_ms,fallback_from,error,cost_usd,combo,key_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    Date.now(),
    u.connectionId ?? null,
    u.provider,
    u.model,
    u.requested,
    u.ok ? 1 : 0,
    u.status,
    u.input,
    u.output,
    u.cached,
    u.latencyMs,
    u.ttftMs,
    u.fallbackFrom ?? null,
    u.error?.slice(0, 500) ?? null,
    u.costUsd ?? 0,
    u.combo ?? null,
    u.keyId ?? null,
  );
}

export function usageSummary(sinceMs: number): Row[] {
  return all(
    `SELECT provider, model, COUNT(*) n, SUM(input_tokens) inp, SUM(output_tokens) outp,
            SUM(ok) ok_n, AVG(latency_ms) avg_ms, SUM(cost_usd) cost
     FROM usage WHERE ts >= ? GROUP BY provider, model ORDER BY n DESC`,
    sinceMs,
  );
}

// ---------- request_log ----------

export interface RequestLogRow {
  seq: number;
  ts: number;
  method: string;
  path: string;
  status: number;
  dur_ms: number;
  line: string;
  provider: string | null;
  model: string | null;
  combo: string | null;
  key_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  error: string | null;
  egress: string | null;
}

const REQUEST_LOG_COLS =
  "seq,ts,method,path,status,dur_ms,line,provider,model,combo,key_id,tokens_in,tokens_out,cost_usd,error,egress";

export function logRequestFull(row: {
  method: string;
  path: string;
  status: number;
  durMs: number;
  line?: string;
  ts?: number;
  provider?: string | null;
  model?: string | null;
  combo?: string | null;
  keyId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  error?: string | null;
  egress?: string | null;
}): void {
  run(
    `INSERT INTO request_log(ts,method,path,status,dur_ms,line,provider,model,combo,key_id,tokens_in,tokens_out,cost_usd,error,egress)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.ts ?? Date.now(),
    row.method,
    row.path,
    row.status,
    row.durMs,
    row.line ?? `${row.method} ${row.path} -> ${row.status} ${row.durMs}ms`,
    row.provider ?? null,
    row.model ?? null,
    row.combo ?? null,
    row.keyId ?? null,
    row.tokensIn ?? null,
    row.tokensOut ?? null,
    row.costUsd ?? null,
    row.error ?? null,
    row.egress ?? null,
  );
}

export function queryLogs(opts: { limit?: number; offset?: number; keyId?: string; provider?: string; status?: number } = {}): RequestLogRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.keyId !== undefined) {
    where.push("key_id = ?");
    params.push(opts.keyId);
  }
  if (opts.provider !== undefined) {
    where.push("provider = ?");
    params.push(opts.provider);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    params.push(opts.status);
  }
  return all(
    `SELECT ${REQUEST_LOG_COLS} FROM request_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  ) as unknown as RequestLogRow[];
}

export interface UsageSummaryRow {
  provider: string;
  model: string;
  n: number;
  inp: number;
  outp: number;
  ok_n: number;
  avg_ms: number;
  cost: number;
}

const USAGE_SUMMARY_COLS =
  "provider, model, COUNT(*) n, SUM(input_tokens) inp, SUM(output_tokens) outp, SUM(ok) ok_n, AVG(latency_ms) avg_ms, SUM(cost_usd) cost";

export function queryUsage(opts: { hours: number; keyId?: string }): UsageSummaryRow[] {
  const since = Date.now() - opts.hours * 3_600_000;
  if (opts.keyId !== undefined) {
    return all(
      `SELECT ${USAGE_SUMMARY_COLS} FROM usage WHERE ts >= ? AND key_id = ? GROUP BY provider, model ORDER BY n DESC`,
      since,
      opts.keyId,
    ) as unknown as UsageSummaryRow[];
  }
  return all(
    `SELECT ${USAGE_SUMMARY_COLS} FROM usage WHERE ts >= ? GROUP BY provider, model ORDER BY n DESC`,
    since,
  ) as unknown as UsageSummaryRow[];
}
export interface DailyUsageRow {
  day: string;
  n: number;
  cost: number;
}

export function dailyUsage(opts: { days: number; keyId?: string }): DailyUsageRow[] {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days) || 7));
  const since = Date.now() - days * 86_400_000;
  const rows = (
    opts.keyId !== undefined
      ? all(
          `SELECT date(ts/1000,'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE ts >= ? AND key_id = ? GROUP BY day ORDER BY day`,
          since,
          opts.keyId,
        )
      : all(
          `SELECT date(ts/1000,'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE ts >= ? GROUP BY day ORDER BY day`,
          since,
        )
  ) as unknown as Array<{ day: string; n: number; cost: number }>;
  return rows.map((r) => ({ day: r.day, n: r.n, cost: r.cost }));
}

export interface ComboRow {
  id: string;
  name: string;
  description: string;
  strategy: string;
  steps: string;
  enabled: number;
}

export function listCombos(): ComboRow[] {
  return all("SELECT * FROM combos ORDER BY created_at") as unknown as ComboRow[];
}
export function getCombo(name: string): ComboRow | undefined {
  return get("SELECT * FROM combos WHERE name = ?", name) as unknown as ComboRow | undefined;
}
export function putCombo(c: { id: string; name: string; description?: string; strategy?: string; steps: unknown[]; enabled?: boolean }): void {
  const now = Date.now();
  run(
    `INSERT INTO combos(id,name,description,strategy,steps,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, strategy=excluded.strategy,
       steps=excluded.steps, enabled=excluded.enabled, updated_at=excluded.updated_at`,
    c.id,
    c.name,
    c.description ?? "",
    c.strategy ?? "priority",
    JSON.stringify(c.steps),
    c.enabled === false ? 0 : 1,
    now,
    now,
  );
}
export function deleteCombo(id: string): void {
  run("DELETE FROM combos WHERE id = ?", id);
}

// ---------- pricing ----------

export function upsertPricing(rows: Array<{ provider: string; model: string; input: number; output: number; cacheRead?: number }>): number {
  const now = Date.now();
  for (const r of rows) {
    run(
      `INSERT INTO pricing(provider,model,input_usd,output_usd,cache_read_usd,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(provider,model) DO UPDATE SET input_usd=excluded.input_usd, output_usd=excluded.output_usd,
         cache_read_usd=excluded.cache_read_usd, updated_at=excluded.updated_at`,
      r.provider,
      r.model,
      r.input,
      r.output,
      r.cacheRead ?? null,
      now,
    );
  }
  return rows.length;
}

export function priceFor(provider: string, model: string): { in: number; out: number; cache?: number } | null {
  let row = get("SELECT input_usd,output_usd,cache_read_usd FROM pricing WHERE provider=? AND model=?", provider, model) as
    | { input_usd: number; output_usd: number; cache_read_usd: number | null }
    | undefined;
  if (!row) {
    // prefix-tolerant lookup: routers expose "prov/sub-model" ids; try exact, then provider default wildcard
    row = get("SELECT input_usd,output_usd,cache_read_usd FROM pricing WHERE provider=? AND model='*'", provider) as never;
  }
  if (!row) return null;
  return { in: row.input_usd, out: row.output_usd, ...(row.cache_read_usd != null ? { cache: row.cache_read_usd } : {}) };
}

export function flatRateUsdPerM(): number | null {
  const raw = (process.env.RIKKA_FLAT_PRICING_USD_PER_M ?? "0.2").trim();
  if (raw === "") return null; // legacy: per-model pricing table
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 0.2;
}

export function costOf(provider: string, model: string, input: number, output: number, cached: number): number {
  const flat = flatRateUsdPerM();
  if (flat !== null) {
    // Flat rate for everything: no per-model rows, nothing ever unpriced.
    // Cached input bills at full rate (CACHED_FLAT_MULT = 1) — unlike the
    // per-model table which honors cache_read_usd. Lower the multiplier to
    // pass cache savings to users; 1 keeps flat billing predictable.
    const CACHED_FLAT_MULT = 1;
    const billableIn = Math.max(0, input - cached) + Math.max(0, cached) * CACHED_FLAT_MULT;
    return (billableIn + Math.max(0, output)) * flat / 1_000_000;
  }
  const p = priceFor(provider, model);
  if (!p) return 0;
  const billableIn = Math.max(0, input - cached);
  const cacheRate = p.cache ?? p.in;
  return (billableIn * p.in + cached * cacheRate + output * p.out) / 1_000_000;
}

// ---------- oauth connections ----------

export function putOAuthConnection(c: {
  id: string;
  provider: string;
  name?: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  email?: string | null;
  extra?: Record<string, unknown> | null;
}): void {
  const now = Date.now();
  run(
    `INSERT INTO connections(id,provider,name,api_key,auth_kind,refresh_token,expires_at,scope,email,extra,priority,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,100,?,?)
     ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
       scope=excluded.scope, email=excluded.email, extra=excluded.extra, status='active', cooldown_until=0, last_error=NULL, updated_at=excluded.updated_at`,
    c.id,
    c.provider,
    c.name ?? "",
    c.accessToken,
    "oauth",
    c.refreshToken ?? null,
    c.expiresAt ?? null,
    c.scope ?? null,
    c.email ?? null,
    c.extra ? JSON.stringify(c.extra) : null,
    now,
    now,
  );
}

export function updateConnectionTokens(id: string, accessToken: string, refreshToken?: string | null, expiresAt?: number | null): void {
  run(
    // refresh_token keeps COALESCE (rotation preserved when the refresh body
    // omits it); expires_at is written as-is so NULL stays NULL honestly.
    "UPDATE connections SET api_key=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, status='active', cooldown_until=0, updated_at=? WHERE id=?",
    accessToken,
    refreshToken ?? null,
    expiresAt ?? null,
    Date.now(),
    id,
  );
}
export function getModelsCache(id: string): { models: Array<{ id: string; name: string }>; at: number | null } {
  const row = (get("SELECT models_cache, models_cached_at FROM connections WHERE id = ?", id) ?? {}) as {
    models_cache?: string | null;
    models_cached_at?: number | null;
  };
  let models: Array<{ id: string; name: string }> = [];
  try {
    const raw: unknown = row.models_cache ? JSON.parse(row.models_cache) : [];
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (m && typeof m === "object" && "id" in m && typeof m.id === "string" && m.id.trim()) {
          const nm = "name" in m && typeof m.name === "string" && m.name.trim() ? m.name.trim() : m.id.trim();
          models.push({ id: m.id.trim(), name: nm });
        }
      }
    }
  } catch {}
  return { models, at: row.models_cached_at ?? null };
}

export function setModelsCache(id: string, models: Array<{ id: string; name?: string }>): void {
  const seen = new Set<string>();
  const clean: Array<{ id: string; name: string }> = [];
  for (const m of models) {
    if (!m || typeof m.id !== "string") continue;
    const mid = m.id.trim();
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    clean.push({ id: mid, name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : mid });
  }
  run("UPDATE connections SET models_cache = ?, models_cached_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(clean), Date.now(), Date.now(), id);
}

export interface OAuthStatusRow {
  provider: string;
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
}

export function oauthStatus(): OAuthStatusRow[] {
  const rows = all(
    "SELECT provider,email,expires_at,status FROM connections WHERE auth_kind='oauth' ORDER BY provider, updated_at DESC",
  ) as unknown as Array<{ provider: string; email: string | null; expires_at: number | null; status: string }>;
  const seen: Record<string, OAuthStatusRow> = {};
  for (const r of rows) {
    if (seen[r.provider] === undefined) {
      seen[r.provider] = {
        provider: r.provider,
        connected: r.status !== "disabled",
        email: r.email,
        expiresAt: r.expires_at,
      };
    }
  }
  return Object.values(seen);
}

// ---------- budgets ----------

export function monthSpendFor(keyId: string): number {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const row = get("SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE key_id=? AND ts>=?", keyId, startOfMonth.getTime()) as { s: number };
  return row.s;
}

export function setKeyBudget(id: string, usd: number | null): void {
  run("UPDATE api_keys SET budget_usd_monthly=? WHERE id=?", usd, id);
}

export function keyBudget(id: string): { budget: number | null } | undefined {
  return get("SELECT budget_usd_monthly AS budget FROM api_keys WHERE id=?", id) as { budget: number | null } | undefined;
}

// ---------- client-key controls: access, scopes, prepaid, logging ----------

export interface KeyControls {
  logBodies: boolean;
  balance: number | null;
  allowModels: string[] | null;
  ipAllowlist: string[];
  contact: string;
  disabled: boolean;
}

export function keyControls(id: string): KeyControls | undefined {
  const row = get("SELECT log_bodies,balance_usd,allow_models,ip_allowlist,contact,disabled FROM api_keys WHERE id=?", id) as
    | { log_bodies: number | null; balance_usd: number | null; allow_models: string | null; ip_allowlist: string | null; contact: string | null; disabled: number | null }
    | undefined;
  if (!row) return undefined;
  let allow: string[] | null = null;
  if (row.allow_models) {
    try {
      const p: unknown = JSON.parse(row.allow_models);
      if (Array.isArray(p)) allow = p.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  let ips: string[] = [];
  if (row.ip_allowlist) {
    try {
      const p: unknown = JSON.parse(row.ip_allowlist);
      if (Array.isArray(p)) ips = p.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  return {
    logBodies: (row.log_bodies ?? 1) !== 0,
    balance: row.balance_usd,
    allowModels: allow,
    ipAllowlist: ips,
    contact: row.contact ?? "",
    disabled: (row.disabled ?? 0) !== 0,
  };
}

export function setKeyControls(id: string, c: Partial<{ logBodies: boolean; balance: number | null; allowModels: string[] | null; ipAllowlist: string[]; contact: string; disabled: boolean }>): void {
  if (c.logBodies !== undefined) run("UPDATE api_keys SET log_bodies=? WHERE id=?", c.logBodies ? 1 : 0, id);
  if (c.balance !== undefined) run("UPDATE api_keys SET balance_usd=? WHERE id=?", c.balance, id);
  if (c.allowModels !== undefined) run("UPDATE api_keys SET allow_models=? WHERE id=?", c.allowModels ? JSON.stringify(c.allowModels) : null, id);
  if (c.ipAllowlist !== undefined) run("UPDATE api_keys SET ip_allowlist=? WHERE id=?", JSON.stringify(c.ipAllowlist), id);
  if (c.contact !== undefined) run("UPDATE api_keys SET contact=? WHERE id=?", c.contact, id);
  if (c.disabled !== undefined) run("UPDATE api_keys SET disabled=? WHERE id=?", c.disabled ? 1 : 0, id);
}

export function keyBalance(id: string): number | null {
  const row = get("SELECT balance_usd FROM api_keys WHERE id=?", id) as { balance_usd: number | null } | undefined;
  return row?.balance_usd ?? null;
}

/** Deduct prepaid balance (null balance = unlimited, untouched). */
export function deductBalance(id: string, usd: number): void {
  if (!(usd > 0)) return;
  try {
    run("UPDATE api_keys SET balance_usd = balance_usd - ? WHERE id = ? AND balance_usd IS NOT NULL", usd, id);
  } catch {}
}

/** Model allowlist check: entries are `provider/*`, `provider/model`, `*` or bare model. */
export function keyAllowsModel(allow: string[] | null, provider: string, model: string): boolean {
  if (!allow || !allow.length) return true;
  const m = model.toLowerCase();
  for (const raw of allow) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a === "*") return true;
    if (a.endsWith("/*") && provider.toLowerCase() === a.slice(0, -2)) return true;
    const slash = a.indexOf("/");
    if (slash > 0) {
      const [ap, am] = [a.slice(0, slash), a.slice(slash + 1)];
      if (ap === provider.toLowerCase() && (am === "*" || am === m || model.toLowerCase().endsWith(`/${am}`))) return true;
      continue;
    }
    if (a === m || a === provider.toLowerCase()) return true;
  }
  return false;
}

export function audit(action: string, detail?: string, actor = "dashboard"): void {
  try {
    run("INSERT INTO admin_audit(ts,actor,action,detail) VALUES(?,?,?,?)", Date.now(), actor, action, detail ?? null);
  } catch {}
}

export function queryAudit(limit = 100): Array<Record<string, string | number | null>> {
  return all("SELECT seq,ts,actor,action,detail FROM admin_audit ORDER BY seq DESC LIMIT ?", Math.min(Math.max(limit, 1), 500)) as unknown as Array<Record<string, string | number | null>>;
}
// ---------- rate limits ----------
// Config lives in meta (0 = disabled); per-minute counters live in meta too
// under rl:key:<keyId>:<minute> and rl:conn:<connectionId>:<minute>.

export interface RateLimits {
  rpmPerKey: number;
  rpmPerConnection: number;
}

const RL_KEY = "rl_rpm_per_key";
const RL_CONN = "rl_rpm_per_connection";

function clampRpm(n: number): number {
  return Math.max(0, Math.floor(n));
}

export function getRateLimits(): RateLimits {
  const k = setting(RL_KEY);
  const c = setting(RL_CONN);
  return {
    rpmPerKey: k === undefined ? 0 : clampRpm(Number(k) || 0),
    rpmPerConnection: c === undefined ? 0 : clampRpm(Number(c) || 0),
  };
}

export function setRateLimits(patch: { rpmPerKey?: number; rpmPerConnection?: number }): RateLimits {
  if (patch.rpmPerKey !== undefined) setSetting(RL_KEY, String(clampRpm(patch.rpmPerKey)));
  if (patch.rpmPerConnection !== undefined) setSetting(RL_CONN, String(clampRpm(patch.rpmPerConnection)));
  return getRateLimits();
}

// NOTE: the per-minute limiter lives in src/server/middleware/ratelimit.ts
// (backed by getRateLimits/setSetting here). Do NOT re-add a second
// implementation in this file — one limiter, one place.

export function closeDb(): void {
  _db?.close();
  _db = null;
}

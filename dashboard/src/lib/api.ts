// Typed client for the rikka server — shapes match src/server/app.ts exactly.

export interface RegistryProvider {
  id: string;
  name: string;
  alias: string;
  format: string;
  baseUrl: string;
  authType: string;
  priority: number;
  free: boolean;
  experimental: boolean;
  requiresMitm?: boolean;
  website?: string;
  apiKeyUrl?: string;
  models: { id: string; name: string }[];
}

export interface Connection {
  id: string;
  provider: string;
  name: string;
  api_key: string;
  base_url: string | null;
  proxy_url: string | null;
  proxy_mode: string | null;
  proxy_wait?: number | null;
  status: "active" | "cooldown" | "disabled";
  cooldown_until: number;
  last_error: string | null;
  priority: number;
  created_at: number;
}

export interface UsageRow {
  provider: string;
  model: string;
  n: number;
  inp: number | null;
  outp: number | null;
  ok_n: number | null;
  avg_ms: number | null;
  /** summed cost_usd over the window — matches the server's USAGE_SUMMARY_COLS */
  cost?: number | null;
}

export interface LogRow {
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
  egress?: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  budget_usd_monthly?: number | null;
  log_bodies?: number | null;
  balance_usd?: number | null;
  allow_models?: string | null;
  ip_allowlist?: string | null;
  contact?: string | null;
  disabled?: number | null;
}

export interface AliasRow {
  alias: string;
  target: string;
}

export interface Health {
  ok: boolean;
  name: string;
  version: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Session died (server restart / password change / expiry): don't strand
    // the user on cryptic 401s — reload into the lock page exactly once.
    if (res.status === 401 && text.includes('"auth_error"') && !sessionStorage.getItem("rikka:lock-reload")) {
      try {
        sessionStorage.setItem("rikka:lock-reload", "1");
      } catch {}
      location.reload();
      await new Promise<never>(() => {});
    }
    throw new Error(`${res.status} ${text.slice(0, 160)}`);
  }
  try {
    sessionStorage.removeItem("rikka:lock-reload");
  } catch {}
  return (await res.json()) as T;
}

export const api = {
  health: () => req<Health>("/health"),
  registry: () => req<{ providers: RegistryProvider[]; count: number }>("/api/registry"),
  connections: () => req<{ providers: Connection[] }>("/api/providers"),
  getConnection: (id: string) => req<{ connection: Connection; provider: RegistryProvider | null; detectedModels?: Array<{ id: string; name: string }>; modelsCachedAt?: number | null }>(`/api/providers/${id}`),
  detectModels: (id: string) =>
    req<{ ok: boolean; models?: Array<{ id: string; name: string }>; count?: number; error?: string | null; latencyMs?: number }>(`/api/providers/${id}/detect-models`, {
      method: "POST",
    }),
  addConnection: (body: { provider: string; apiKey: string; name?: string; baseUrl?: string; proxyUrl?: string; proxyMode?: string }) =>
    req<{ ok: boolean; id: string }>("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateConnection: (id: string, body: { name?: string; baseUrl?: string | null; headers?: Record<string, string> | null; priority?: number; apiKey?: string; proxyUrl?: string | null; proxyMode?: string }) =>
    req<{ ok: boolean; connection: Connection }>(`/api/providers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  testConnection: (id: string) =>
    req<{ ok: boolean; valid: boolean; status?: number; error?: string | null; latencyMs?: number }>(`/api/providers/${id}/test`, {
      method: "POST",
    }),
  removeConnection: (id: string) => req<{ ok: boolean }>(`/api/providers/${id}`, { method: "DELETE" }),
  keys: () => req<{ keys: ApiKeyRow[] }>("/api/keys"),
  addKey: (name: string) =>
    req<{ id: string; name: string; secret: string }>("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  removeKey: (id: string) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" }),
  usage: (hours: number, opts?: { keyId?: string; provider?: string; status?: number }) => {
    const p = new URLSearchParams({ hours: String(hours) });
    if (opts?.keyId) p.set("keyId", opts.keyId);
    if (opts?.provider) p.set("provider", opts.provider);
    if (opts?.status !== undefined) p.set("status", String(opts.status));
    return req<{ hours: number; rows: UsageRow[] }>(`/api/usage?${p}`);
  },
  dailyUsage: (days: number, keyId?: string) => {
    const p = new URLSearchParams({ days: String(days) });
    if (keyId) p.set("keyId", keyId);
    return req<{ days: number; rows: Array<{ day: string; n: number; cost: number }> }>(`/api/usage/daily?${p}`);
  },
  proxyPool: () =>
    req<{ total: number; healthy: number; checkedAt: number | null; proxies: Array<{ url: string; ok: number; latency_ms: number | null; fails: number }> }>("/api/proxy/pool"),
  refreshProxyPool: () =>
    req<{ ok: boolean; total: number; healthy: number; added: number; sources: number; checked: number }>("/api/proxy/refresh", { method: "POST" }),
  logs: (limit: number, opts?: { keyId?: string; provider?: string; status?: number }) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (opts?.keyId) p.set("keyId", opts.keyId);
    if (opts?.provider) p.set("provider", opts.provider);
    if (opts?.status !== undefined) p.set("status", String(opts.status));
    return req<{ limit: number; rows: LogRow[] }>(`/api/logs?${p}`);
  },
  aliases: () => req<{ aliases: AliasRow[] }>("/api/aliases"),
  setAlias: (alias: string, target: string) =>
    req<{ ok: boolean }>(`/api/aliases/${alias}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    }),
  removeAlias: (alias: string) => req<{ ok: boolean }>(`/api/aliases/${alias}`, { method: "DELETE" }),
  models: () => req<{ object: string; data: { id: string; owned_by: string }[] }>("/v1/models"),
  listCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  getPricing,
  getBudget,
  setBudget,
  changePassword,
  beginOAuth,
  exchangeOAuth,
  exportLogsUrl,
  oauthStatus,
  revokeOAuth,
  getLimits,
  setLimits,
  changeKeyControls,
  rotateKey,
  keyStats,
  keyInvoiceUrl,
  margin,
  setConnectionStatus,
  setConnectionWait,
  chats,
  getChat,
  deleteChat,
  chatHeatmap,
  chatsByKey,
  chatExportUrl,
  chatExports,
  addProxies,
  removeProxy,
  setProxyMeta,
  probeProxy,
  auditRows,
  upstreamHealth,
  checkUpstreams,
  notifySettings,
  setNotifySettings,
  testNotify,
  publicStatus,
};

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
  error: string | null;
  attempts: AttemptEntry[];
  request: { messages: Array<{ role?: string; content?: unknown }> ; tools?: unknown } | null;
  response: string | null;
  reasoning: string | null;
  toolCalls: Array<{ id?: string; name?: string; args?: string }> | null;
}

export interface KeyControls {
  logBodies: boolean;
  balance: number | null;
  allowModels: string[] | null;
  ipAllowlist: string[];
  contact: string;
  disabled: boolean;
}

export interface ProxyRow {
  url: string;
  source: string | null;
  last_check: number | null;
  ok: number;
  latency_ms: number | null;
  fails: number;
  label: string | null;
  priority: number;
  quarantined_until: number;
}

export function changeKeyControls(id: string, body: Partial<{ logBodies: boolean; balance: number | null; allowModels: string[] | null; ipAllowlist: string[]; contact: string; disabled: boolean }>): Promise<{ ok: boolean; controls: KeyControls }> {
  return req(`/api/keys/${id}/controls`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function rotateKey(id: string): Promise<{ ok: boolean; id: string; secret: string }> {
  return req(`/api/keys/${id}/rotate`, { method: "POST" });
}

export function keyStats(id: string, days = 30): Promise<{ id: string; days: number; usage: Record<string, number | null>; chats: Record<string, number | null>; byModel: Array<{ model: string; n: number; cost: number }>; balance: number | null; spentMonth: number }> {
  return req(`/api/keys/${id}/stats?days=${days}`);
}

export function keyInvoiceUrl(id: string, month: string): string {
  return `/api/keys/${id}/invoice?month=${encodeURIComponent(month)}`;
}

export function margin(days = 30): Promise<{ days: number; byKey: Array<{ key_id: string; name: string; n: number; revenue: number }>; totalRevenue: number; note: string }> {
  return req(`/api/costs/margin?days=${days}`);
}

export function setConnectionStatus(id: string, status: "active" | "disabled"): Promise<{ ok: boolean }> {
  return req(`/api/providers/${id}/status`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
}

export function setConnectionWait(id: string, proxyWait: boolean): Promise<{ ok: boolean }> {
  return req(`/api/providers/${id}/wait`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ proxyWait }) });
}

export function chats(params: { keyId?: string; provider?: string; model?: string; ok?: boolean; minQuality?: number; q?: string; limit?: number; offset?: number }): Promise<{ turns: ChatTurn[]; total: number }> {
  const p = new URLSearchParams();
  if (params.keyId) p.set("keyId", params.keyId);
  if (params.provider) p.set("provider", params.provider);
  if (params.model) p.set("model", params.model);
  if (params.ok !== undefined) p.set("ok", params.ok ? "1" : "0");
  if (params.minQuality !== undefined) p.set("minQuality", String(params.minQuality));
  if (params.q) p.set("q", params.q);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.offset !== undefined) p.set("offset", String(params.offset));
  return req(`/api/chats?${p}`);
}

export function getChat(id: string): Promise<{ turn: ChatTurn }> {
  return req(`/api/chats/${id}`);
}

export function deleteChat(id: string): Promise<{ ok: boolean }> {
  return req(`/api/chats/${id}`, { method: "DELETE" });
}

export function chatHeatmap(provider: string, days = 7): Promise<{ provider: string; days: number; hours: Array<{ hour: number; n: number; r429: number }> }> {
  return req(`/api/chats/heatmap?provider=${encodeURIComponent(provider)}&days=${days}`);
}

export function chatsByKey(days = 30): Promise<{ stats: Array<{ key_id: string; n: number; ok_n: number; inp: number; outp: number; cost: number; avg_ms: number; models: number }> }> {
  return req(`/api/chats/by-key?days=${days}`);
}

export function chatExportUrl(params: { format: string; keyId?: string; provider?: string; model?: string; minQuality?: number; dedup?: boolean; scrub?: boolean; q?: string; ok?: boolean; ids?: string[] }): string {
  const p = new URLSearchParams({ format: params.format });
  if (params.keyId) p.set("keyId", params.keyId);
  if (params.provider) p.set("provider", params.provider);
  if (params.model) p.set("model", params.model);
  if (params.minQuality !== undefined) p.set("minQuality", String(params.minQuality));
  if (params.dedup === false) p.set("dedup", "0");
  if (params.scrub === false) p.set("scrub", "0");
  if (params.q) p.set("q", params.q);
  if (params.ok !== undefined) p.set("ok", params.ok ? "1" : "0");
  if (params.ids?.length) p.set("ids", params.ids.join(","));
  return `/api/chats/export?${p}`;
}

export function chatExports(): Promise<{ exports: Array<{ id: string; ts: number; format: string; filters_json: string; count: number }> }> {
  return req(`/api/chats/exports`);
}

export function addProxies(body: { text?: string; urls?: string[]; label?: string }): Promise<{ ok: boolean; added: number; total: number }> {
  return req(`/api/proxy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function removeProxy(url: string): Promise<{ ok: boolean }> {
  return req(`/api/proxy`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
}

export function setProxyMeta(url: string, meta: { label?: string; priority?: number }): Promise<{ ok: boolean }> {
  return req(`/api/proxy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, ...meta }) });
}

export function probeProxy(url: string): Promise<{ ok: boolean; latencyMs: number | null }> {
  return req(`/api/proxy/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
}

export function auditRows(limit = 100): Promise<{ rows: Array<{ seq: number; ts: number; actor: string; action: string; detail: string | null }> }> {
  return req(`/api/audit?limit=${limit}`);
}

export function upstreamHealth(): Promise<{ targets: Array<{ target: string; ts: number; ok: number; latency_ms: number | null; status: number | null; error: string | null }> }> {
  return req(`/api/health/upstreams`);
}

export function checkUpstreams(): Promise<{ ok: boolean; checked: number; targets: unknown[] }> {
  return req(`/api/health/check`, { method: "POST" });
}

export function notifySettings(): Promise<{ configured: boolean }> {
  return req(`/api/notify/settings`);
}

export function setNotifySettings(body: { botToken?: string; chatId?: string }): Promise<{ ok: boolean; configured: boolean }> {
  return req(`/api/notify/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function testNotify(to?: string): Promise<{ ok: boolean; error?: string }> {
  return req(`/api/notify/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to ? { to } : {}) });
}

export function publicStatus(): Promise<{ name: string; time: number; pool: { total: number; healthy: number }; upstreams: Array<{ target: string; ok: number; latencyMs: number | null }> }> {
  return req(`/api/public/status`);
}

// ── combos / pricing / budgets / oauth (Phase 7+) ─────────────────────────

export interface Combo {
  id: string;
  name: string;
  description: string;
  strategy: string;
  steps: unknown[];
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface PricingRow {
  provider: string;
  model: string;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number | null;
}

export interface BudgetInfo {
  id: string;
  budget: number | null;
  spent: number;
}

export interface OAuthBeginResult {
  flow: string;
  url?: string;
  state?: string;
  session?: unknown;
  [k: string]: unknown;
}

export function listCombos(): Promise<{ combos: Combo[] }> {
  return req<{ combos: Combo[] }>("/api/combos");
}

export function createCombo(body: {
  name: string;
  description?: string;
  strategy?: string;
  steps: unknown[];
  enabled?: boolean;
}): Promise<{ ok: boolean; id: string; name: string }> {
  return req<{ ok: boolean; id: string; name: string }>("/api/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateCombo(
  id: string,
  body: { name?: string; description?: string; strategy?: string; steps?: unknown[]; enabled?: boolean },
): Promise<{ ok: boolean; id: string }> {
  return req<{ ok: boolean; id: string }>(`/api/combos/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteCombo(id: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>(`/api/combos/${id}`, { method: "DELETE" });
}

export function getPricing(): Promise<{ pricing: PricingRow[] }> {
  return req<{ pricing: PricingRow[] }>("/api/pricing");
}

export function getBudget(keyId: string): Promise<BudgetInfo> {
  return req<BudgetInfo>(`/api/keys/${keyId}/budget`);
}

export function setBudget(keyId: string, budget: number | null): Promise<{ ok: boolean; id: string; budget: number | null }> {
  return req<{ ok: boolean; id: string; budget: number | null }>(`/api/keys/${keyId}/budget`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget }),
  });
}
export function changePassword(body: { current: string; next: string }): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>(`/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function beginOAuth(provider: string, redirectUri?: string): Promise<OAuthBeginResult> {
  return req<OAuthBeginResult>(`/api/oauth/${provider}/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(redirectUri ? { redirectUri } : {}),
  });
}

export function exchangeOAuth(
  provider: string,
  body: { code?: string; session?: unknown },
): Promise<{ ok: boolean; id: string; provider: string } | { status: string; [k: string]: unknown }> {
  return req<{ ok: boolean; id: string; provider: string } | { status: string; [k: string]: unknown }>(
    `/api/oauth/${provider}/exchange`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

// ── request-log filters / export / rate limits / oauth status ──────────────

export interface OAuthStatusRow {
  provider: string;
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
}

export interface RateLimits {
  rpmPerKey: number;
  rpmPerConnection: number;
}


/** Download link (not fetch): the server replies with Content-Disposition attachment. */
export function exportLogsUrl(params: { format: "jsonl" | "csv"; keyId?: string; provider?: string; status?: number }): string {
  const p = new URLSearchParams({ format: params.format });
  if (params.keyId) p.set("keyId", params.keyId);
  if (params.provider) p.set("provider", params.provider);
  if (params.status !== undefined) p.set("status", String(params.status));
  return `/api/logs/export?${p}`;
}

export function oauthStatus(): Promise<{ providers: OAuthStatusRow[] }> {
  return req<{ providers: OAuthStatusRow[] }>("/api/oauth/status");
}

export function revokeOAuth(provider: string): Promise<{ ok: boolean; provider: string; revoked: number }> {
  return req<{ ok: boolean; provider: string; revoked: number }>(`/api/oauth/${provider}`, { method: "DELETE" });
}

export function getLimits(): Promise<RateLimits> {
  return req<RateLimits>("/api/settings/limits");
}

export function setLimits(patch: { rpmPerKey?: number; rpmPerConnection?: number }): Promise<RateLimits> {
  return req<RateLimits>("/api/settings/limits", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}


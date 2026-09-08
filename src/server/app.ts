// HTTP surface: OpenAI-compatible gateway (/v1/*), /health, admin API (/api/*),
// and a request log in sqlite. Core logic lives in src/core/*; this file is wiring only.
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { PROVIDERS, modelFormat, providerById } from "../core/providers/registry.ts";
import { authMiddleware, handleChatCompletion, handleCountTokens, handleGeminiGenerate, handleMessagesCompletion, handleResponsesCompletion } from "../core/gateway.ts";
import { proxiedFetch } from "../core/executors/sse.ts";
import { listPool, maskProxyUrl, poolStats, probePool, refreshPool, addProxies, removeProxy, setProxyMeta, probeOne, parseProxyList, resolveProxyUrl } from "../core/proxypool.ts";
import { countChats, queryChats, getChat, deleteChat, heat429, chatStatsByKey, exportChats, exportChatsPage, recordDatasetExport, listDatasetExports } from "../core/chatlog.ts";
import { checkUpstreams, listHealth } from "../core/health.ts";
import { notify, telegramConfigured, telegramTest } from "./notify.ts";
import { audit, queryAudit, keyControls, setKeyControls, rotateApiKey, keyBalance, setSetting, setting } from "../shared/db.ts";
import { beginAuth, completeCode, OAUTH_PROVIDERS, pollDevice } from "../core/oauth/index.ts";
import type { OAuthProviderDef } from "../core/oauth/types.ts";
import { newId } from "../core/routing.ts";
import {
  all,
  createApiKey,
  deleteAlias,
  deleteApiKey,
  deleteCombo,
  deleteConnection,
  get,
  getAlias,
  listAliases,
  listApiKeys,
  listCombos,
  listConnections,
  monthSpendFor,
  putAlias,
  putCombo,
  putConnection,
  putOAuthConnection,
  run,
} from "../shared/db.ts";
import { dailyUsage, getModelsCache, getRateLimits, oauthStatus, queryLogs, queryUsage, setModelsCache, setRateLimits } from "../shared/db.ts";
import { checkRateLimit } from "./middleware/ratelimit.ts";
import { adminGuard, warnIfWildcardBind } from "./middleware/adminGuard.ts";
import { ssrfErrorForBaseUrl, ssrfErrorForProxyUrl } from "./middleware/ssrf.ts";
import { checkPassword, createSession, dashLock, isDashLocked, setDashPassword } from "./middleware/dashLock.ts";
import type { Context, Next } from "hono";

// tsconfig has no resolveJsonModule — read version without an import attribute.
const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

const SENSITIVE_HEADER_KEY = /api.?key|token|secret|authorization|auth|password|cookie|session/i;

/** Mask secret-looking entries of a stored headers JSON blob; never throws. */
function maskHeaders(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = SENSITIVE_HEADER_KEY.test(k) ? "••••" : String(v);
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a combo's stored steps JSON; throws a clean Error when corrupt. */
function parseStoredSteps(raw: string, what: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`stored steps for ${what} are corrupt JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`stored steps for ${what} are not an array`);
  return parsed;
}
export interface AppOptions {
  /** absolute path to built dashboard assets; SPA is disabled when absent */
  staticRoot?: string | null;
}

export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  warnIfWildcardBind(process.env.HOST);
  // ---- request log (skips /health + static asset noise) ----
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = c.req.path;
    if (path === "/health" || isStaticAsset(path)) return;
    const dur = Date.now() - started;
    try {
      run(
        "INSERT INTO request_log(ts,method,path,status,dur_ms,line) VALUES(?,?,?,?,?,?)",
        started,
        c.req.method,
        path,
        c.res.status,
        dur,
        `${c.req.method} ${path} -> ${c.res.status} ${dur}ms`,
      );
    } catch {
      // logging must never break a response
    }
  });

  // ---- dashboard lock (RIKKA_DASH_PASSWORD): gate browsers before anything else ----
  app.use("*", dashLock);

  // ---- health (public) ----
  app.get("/health", (c) => c.json({ ok: true, name: "rikka", version: VERSION }));
  // Brute-force throttle: 10 failures per 10 minutes per process (lock is
  // local-only by default; this keeps LAN-exposed instances from silent
  // password grinding, and failures are audited for visibility).
  const unlockHits: number[] = [];
  app.post("/api/auth/unlock", async (c) => {
    const now = Date.now();
    while (unlockHits.length && unlockHits[0]! < now - 600_000) unlockHits.shift();
    if (unlockHits.length >= 10) {
      return c.json({ error: { message: "too many attempts — try again later", type: "auth_error" } }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const pw = typeof body?.password === "string" ? body.password : "";
    if (!checkPassword(pw)) {
      unlockHits.push(now);
      audit("auth.unlock-failed", "wrong dashboard password");
      return c.json({ error: { message: "wrong password", type: "auth_error" } }, 401);
    }
    const s = createSession((c.req.header("x-forwarded-proto") ?? "").toLowerCase() === "https");
    c.header("Set-Cookie", s.cookie);
    return c.json({ ok: true });
  });
  app.post("/api/auth/change-password", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { current?: unknown; next?: unknown } | null;
    const cur = typeof body?.current === "string" ? body.current : "";
    const nxt = typeof body?.next === "string" ? body.next : "";
    if (nxt.length < 4) return c.json({ error: { message: "new password must be at least 4 characters", type: "invalid_request_error" } }, 400);
    // Must already hold a valid session when a password is active (dashLock
    // runs before this route). First-time set from an open dashboard needs
    // no current password.
    if (isDashLocked() && !checkPassword(cur)) {
      audit("auth.password-rejected", "wrong current password");
      return c.json({ error: { message: "current password is wrong", type: "auth_error" } }, 401);
    }
    setDashPassword(nxt);
    audit("auth.password-change", "dashboard password updated");
    return c.json({ ok: true });
  });
  // ---- gateway: auth on /v1* and /v1beta* ----
  app.use("/v1/*", async (c, next) => {
    const res = await authMiddleware(c, next);
    if (res instanceof Response) return res;
  });
  app.use("/v1beta/*", async (c, next) => {
    const res = await authMiddleware(c, next);
    if (res instanceof Response) return res;
  });
  // ---- rate limits: per-key gate here (post-auth); per-connection is enforced
  // inside the gateway via the injected checker on each handler call below. ----
  async function rateLimitGate(c: Context, next: Next): Promise<Response | void> {
    // Hono context carries keyId via c.set plus a plain property (authMiddleware sets both).
    const ctx = c as unknown as Record<string, unknown>;
    const stored: unknown = c.get("keyId" as never);
    const keyId = typeof stored === "string" ? stored : typeof ctx["keyId"] === "string" ? (ctx["keyId"] as string) : undefined;
    const r = checkRateLimit({ ...(keyId ? { keyId } : {}) });
    const retry = Math.max(1, Math.ceil(r.resetMs / 1000));
    if (!r.allowed) {
      return c.json(
        { error: { message: "rate limit exceeded, retry later", code: "rate_limited" } },
        429,
        {
          "Retry-After": String(retry),
          "X-RateLimit-Limit": String(r.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(retry),
        },
      );
    }
    await next();
    if (r.limit > 0) {
      c.header("X-RateLimit-Limit", String(r.limit));
      c.header("X-RateLimit-Remaining", String(r.remaining));
      c.header("X-RateLimit-Reset", String(retry));
    }
  }
  app.use("/v1/*", rateLimitGate);
  app.use("/v1beta/*", rateLimitGate);
  // Connection-scoped checker handed to the gateway (boundary BEGate): per-key is
  // already counted by rateLimitGate above, so only the connection scope applies here.
  const connRateLimit = (info: { keyId?: string; connectionId?: string }) =>
    checkRateLimit({ ...(info.connectionId ? { connectionId: info.connectionId } : {}) });
  app.post("/v1/chat/completions", (c) => {
    const req = c.req;
    const signal = req.raw.signal;
    const keyId = (c as unknown as { keyId?: string }).keyId ?? (c.get("keyId" as never) as unknown as string | undefined);
    return handleChatCompletion({
      json: () => req.json(),
      ...(signal ? { signal } : {}),
      ...(keyId ? { keyId } : {}),
      rateLimit: connRateLimit,
    });
  });

  app.post("/v1/messages", (c) => {
    const req = c.req;
    const signal = req.raw.signal;
    const keyId = (c as unknown as { keyId?: string }).keyId ?? (c.get("keyId" as never) as unknown as string | undefined);
    return handleMessagesCompletion({
      json: () => req.json(),
      ...(signal ? { signal } : {}),
      ...(keyId ? { keyId } : {}),
      rateLimit: connRateLimit,
    });
  });
  app.post("/v1/responses", (c) => {
    const keyId = (c as unknown as { keyId?: string }).keyId ?? (c.get("keyId" as never) as unknown as string | undefined);
    return handleResponsesCompletion({ json: () => c.req.json(), signal: c.req.raw.signal, ...(keyId ? { keyId } : {}), rateLimit: connRateLimit });
  });
  app.post("/v1beta/*", async (c) => {
    const keyId = (c as unknown as { keyId?: string }).keyId ?? (c.get("keyId" as never) as unknown as string | undefined);
    const path = c.req.path;
    const m = path.match(/\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)/);
    if (!m) return c.json({ error: { message: `unsupported v1beta path: ${path}`, type: "not_found_error" } }, 404);
    const model = decodeURIComponent(m[1]!);
    const isStream = m[2] === "streamGenerateContent";
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (isStream) raw.stream = true;
    return handleGeminiGenerate({ json: async () => raw, model, signal: c.req.raw.signal, ...(keyId ? { keyId } : {}), rateLimit: connRateLimit });
  });
  app.get("/v1/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const connected = new Set(listConnections().map((r) => r.provider));
    const data: Array<{ id: string; object: "model"; created: number; owned_by: string }> = [];
    const seen = new Set<string>();
    const push = (id: string, owner: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      data.push({ id, object: "model", created, owned_by: owner });
    };
    for (const p of PROVIDERS) {
      if (!connected.has(p.id)) continue;
      for (const m of p.models) push(`${p.id}/${m.id}`, p.id);
      // custom + live-detected models are not in the static registry
      for (const conn of listConnections(p.id)) {
        for (const m of getModelsCache(conn.id).models) push(`${p.id}/${m.id}`, p.id);
      }
    }
    for (const pid of connected) {
      if (PROVIDERS.some((p) => p.id === pid)) continue;
      const def = providerById(pid);
      if (!def) continue;
      for (const m of def.models) push(`${def.id}/${m.id}`, def.id);
      for (const conn of listConnections(pid)) {
        for (const m of getModelsCache(conn.id).models) push(`${def.id}/${m.id}`, def.id);
      }
    }
    for (const a of listAliases()) {
      data.push({ id: a.alias, object: "model", created, owned_by: "rikka" });
    }
    return c.json({ object: "list", data });
  });
  // Anthropic-compatible token counting (auth + rate limiting via /v1/* middleware above).
  app.post("/v1/messages/count_tokens", (c) => handleCountTokens({ json: () => c.req.json() }));

  // ---- admin API ----
  // /api/* is open on loopback so the local dashboard/CLI work without setup.
  // When reached via a non-loopback Host while RIKKA_API_KEY is unset the
  // guard below rejects the request (accidental-exposure trip-wire, not a
  // login gate). Keep HOST bound to 127.0.0.1 (default) or front this router
  // with an authenticating proxy before exposing it on a network.
  app.use("/api/*", adminGuard);
  app.get("/api/providers", (c) => {
    const providers = listConnections().map((r) => ({ ...r, api_key: maskKey(r.api_key), headers: maskHeaders(r.headers) }));
    return c.json({ providers });
  });

 app.post("/api/providers", async (c) => {
 const body = (await c.req.json().catch(() => null)) as {
 provider?: unknown;
 apiKey?: unknown;
 api_key?: unknown;
 name?: unknown;
 baseUrl?: unknown;
 base_url?: unknown;
 headers?: unknown;
 proxyUrl?: unknown;
 proxy_url?: unknown;
 proxyMode?: unknown;
 proxy_mode?: unknown;
 } | null;
 const provider = typeof body?.provider === "string" ? body.provider : "";
 const apiKeyRaw = typeof body?.apiKey === "string" ? body.apiKey : typeof (body as Record<string, unknown>)?.api_key === "string" ? String((body as Record<string, unknown>).api_key) : "";
 const apiKey = apiKeyRaw;
    const baseUrlRaw = typeof body?.baseUrl === "string" && body.baseUrl ? body.baseUrl.trim() : "";
    const isCustom = provider.startsWith("custom-");
    if (!provider || (!apiKey && !isCustom)) {
      return c.json(
        { error: { message: "provider and apiKey are required", type: "invalid_request_error" } },
        400,
      );
    }
    if (isCustom && !baseUrlRaw) {
      return c.json(
        { error: { message: "custom providers need a base URL (e.g. https://my-host:11434/v1)", type: "invalid_request_error" } },
        400,
      );
    }
    if (!providerById(provider)) {
      return c.json(
        { error: { message: `unknown provider: ${provider}`, type: "invalid_request_error" } },
        400,
      );
    }
    // SSRF guard: a stored baseUrl becomes a server-side fetch target (test,
    // detect-models, gateway). Non-public hosts are rejected here, at write time.
    const baseUrlForCheck = typeof body?.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : typeof body?.base_url === "string" && body.base_url.trim() ? body.base_url.trim() : "";
    if (baseUrlForCheck) {
      const blocked = ssrfErrorForBaseUrl(baseUrlForCheck);
      if (blocked) {
        return c.json({ error: { message: blocked, type: "invalid_request_error" } }, 400);
      }
    }
    const proxyRaw = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    const modeRaw = typeof body?.proxyMode === "string" ? body.proxyMode.trim() : "";
    const proxyMode = modeRaw === "auto" || modeRaw === "manual" || modeRaw === "off" ? modeRaw : proxyRaw ? "manual" : "off";
    if (proxyRaw) {
      const proxyBlocked = ssrfErrorForProxyUrl(proxyRaw);
      if (proxyBlocked) return c.json({ error: { message: proxyBlocked, type: "invalid_request_error" } }, 400);
    }
    const id = newId();
    putConnection({
      id,
      provider,
      apiKey,
      ...(typeof body?.name === "string" && body.name ? { name: body.name } : {}),
      ...((typeof body?.baseUrl === "string" && body.baseUrl) || (typeof body?.base_url === "string" && String(body.base_url)) ? { baseUrl: (typeof body?.baseUrl === "string" && body.baseUrl ? String(body.baseUrl) : String(body.base_url)) } : {}),
      ...(proxyRaw ? { proxyUrl: proxyRaw } : {}),
      proxyMode,
      ...(body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
        ? { headers: body.headers as Record<string, string> }
        : {}),
    });
    const row = listConnections(provider).find((r) => r.id === id);
    audit("connection.add", `${provider} id=${id}`);
    return c.json(
      { ok: true, id, connection: row ? { ...row, api_key: maskKey(row.api_key), headers: maskHeaders(row.headers) } : null },
      201,
    );
  });
  app.get("/api/providers/:id", (c) => {
    const id = c.req.param("id");
    const row = listConnections().find((r) => r.id === id);
    if (!row) return c.json({ error: { message: `unknown connection: ${id}`, type: "not_found_error" } }, 404);
    const prov = providerById(row.provider);
    const cache = getModelsCache(id);
    return c.json({ connection: { ...row, api_key: maskKey(row.api_key), headers: maskHeaders(row.headers) }, provider: prov ?? null, detectedModels: cache.models, modelsCachedAt: cache.at });
  });

  app.put("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    const existing = listConnections().find((r) => r.id === id);
    if (!existing) return c.json({ error: { message: `unknown connection: ${id}`, type: "not_found_error" } }, 404);
 const body = (await c.req.json().catch(() => null)) as {
 name?: unknown; baseUrl?: unknown; base_url?: unknown; headers?: unknown; priority?: unknown; apiKey?: unknown; api_key?: unknown; proxyUrl?: unknown; proxy_url?: unknown; proxyMode?: unknown; proxy_mode?: unknown;
 } | null;
 const hasName = body !== null && ("name" in (body as Record<string, unknown>));
 const hasBaseUrl = body !== null && ("baseUrl" in (body as Record<string, unknown>) || "base_url" in (body as Record<string, unknown>));
const rawBaseUrl = hasBaseUrl ? (typeof body?.baseUrl === "string" ? body.baseUrl : typeof (body as Record<string, unknown>)?.base_url === "string" ? String((body as Record<string, unknown>).base_url) : (body?.baseUrl as string | null) ?? (body as Record<string, unknown>)?.base_url as string | null) : undefined;
const nextBaseUrl = hasBaseUrl ? (rawBaseUrl == null ? null : String(rawBaseUrl).trim() || null) : existing.base_url;
if (typeof nextBaseUrl === "string" && nextBaseUrl) {
  const blocked = ssrfErrorForBaseUrl(nextBaseUrl);
  if (blocked) {
    return c.json({ error: { message: blocked, type: "invalid_request_error" } }, 400);
  }
}
let carriedHeaders: Record<string, string> | null | undefined;
if (body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
  carriedHeaders = body.headers as Record<string, string>;
} else if (existing.headers) {
  try {
    const parsed: unknown = JSON.parse(existing.headers);
    carriedHeaders = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : null;
  } catch {
    return c.json({ error: { message: "stored headers for this connection are corrupt — overwrite them via PUT headers", type: "server_error" } }, 500);
  }
}
if (body !== null && body.headers !== undefined && (typeof body.headers !== "object" || Array.isArray(body.headers))) {
  return c.json({ error: { message: "headers must be an object when provided", type: "invalid_request_error" } }, 400);
}
if (body !== null && "priority" in (body as Record<string, unknown>) && (typeof (body as Record<string, unknown>).priority !== "number" || !Number.isFinite((body as Record<string, unknown>).priority))) {
  return c.json({ error: { message: "priority must be a number when provided", type: "invalid_request_error" } }, 400);
}
const hasProxy = body !== null && ("proxyUrl" in (body as Record<string, unknown>) || "proxy_url" in (body as Record<string, unknown>));
const rawProxy = hasProxy
  ? (typeof body?.proxyUrl === "string" ? body.proxyUrl : typeof (body as Record<string, unknown>)?.proxy_url === "string" ? String((body as Record<string, unknown>).proxy_url) : "")
  : undefined;
const nextProxy = hasProxy ? (typeof rawProxy === "string" && rawProxy.trim() ? rawProxy.trim() : null) : existing.proxy_url;
if (typeof nextProxy === "string" && nextProxy) {
  const proxyBlocked = ssrfErrorForProxyUrl(nextProxy);
  if (proxyBlocked) return c.json({ error: { message: proxyBlocked, type: "invalid_request_error" } }, 400);
}
const hasProxyMode = body !== null && ("proxyMode" in (body as Record<string, unknown>) || "proxy_mode" in (body as Record<string, unknown>));
const rawMode = hasProxyMode
  ? (typeof body?.proxyMode === "string" ? body.proxyMode : typeof (body as Record<string, unknown>)?.proxy_mode === "string" ? String((body as Record<string, unknown>).proxy_mode) : "")
  : undefined;
const nextMode = !hasProxyMode ? existing.proxy_mode ?? "off" : rawMode === "auto" || rawMode === "manual" || rawMode === "off" ? rawMode : null;
if (hasProxyMode && nextMode == null) {
  return c.json({ error: { message: "proxyMode must be off, manual, or auto", type: "invalid_request_error" } }, 400);
}
const patch: { id: string; provider: string; apiKey: string; name?: string; baseUrl?: string | null; headers?: Record<string, string> | null; priority?: number; proxyUrl?: string | null; proxyMode?: string } = {
id,
provider: existing.provider,
apiKey: (typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : typeof (body as Record<string, unknown>)?.api_key === "string" && String((body as Record<string, unknown>).api_key).trim() ? String((body as Record<string, unknown>).api_key).trim() : existing.api_key),
...(hasName ? { name: typeof body?.name === "string" ? (body.name as string).trim() : body?.name == null ? "" : String(body.name).trim() } : { name: existing.name }),
...(hasBaseUrl ? { baseUrl: nextBaseUrl } : { baseUrl: existing.base_url }),
...(carriedHeaders !== undefined ? { headers: carriedHeaders } : {}),
 ...(typeof body?.priority === "number" && Number.isFinite(body.priority) ? { priority: body.priority } : { priority: existing.priority }),
 ...(hasProxy ? { proxyUrl: nextProxy } : { proxyUrl: existing.proxy_url }),
 proxyMode: (nextMode ?? existing.proxy_mode ?? "off") as string,
};
    putConnection(patch);
    const row = listConnections().find((r) => r.id === id);
    return c.json({ ok: true, connection: row ? { ...row, api_key: maskKey(row.api_key), headers: maskHeaders(row.headers) } : null });
  });

  app.delete("/api/providers/:id", (c) => {
    if (!listConnections().some((r) => r.id === c.req.param("id"))) return c.json({ error: { message: "unknown connection", type: "not_found_error" } }, 404);
    deleteConnection(c.req.param("id"));
    audit("connection.delete", c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/keys", (c) => c.json({ keys: listApiKeys() }));

  app.post("/api/keys", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" && body.name ? body.name : "default";
    const k = createApiKey(name);
    audit("key.create", `${k.id} name=${name}`);
    // The full secret is returned exactly once — only its sha256 hash is stored.
    return c.json({ id: k.id, name, secret: k.secret }, 201);
  });

  app.delete("/api/keys/:id", (c) => {
    if (!keyControls(c.req.param("id"))) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    deleteApiKey(c.req.param("id"));
    audit("key.delete", c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/aliases", (c) => c.json({ aliases: listAliases() }));

  app.get("/api/aliases/:name", (c) => {
    const name = c.req.param("name");
    const target = getAlias(name);
    if (target === undefined) {
      return c.json({ error: { message: `unknown alias: ${name}`, type: "not_found_error" } }, 404);
    }
    return c.json({ alias: name, target });
  });

  app.put("/api/aliases/:name", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as { target?: unknown } | null;
    const target = typeof body?.target === "string" ? body.target : "";
    if (!target) {
      return c.json(
        { error: { message: "body.target is required", type: "invalid_request_error" } },
        400,
      );
    }
    if (target.length > 500) return c.json({ error: { message: "target too long (max 500 chars)", type: "invalid_request_error" } }, 400);
    audit("alias.put", `${name} -> ${target.slice(0, 120)}`);
    putAlias(name, target);
    return c.json({ ok: true, alias: name, target });
  });
  app.delete("/api/aliases/:name", (c) => {
    if (getAlias(c.req.param("name")) === undefined) return c.json({ error: { message: "unknown alias", type: "not_found_error" } }, 404);
    deleteAlias(c.req.param("name"));
    audit("alias.delete", c.req.param("name"));
    return c.json({ ok: true });
  });

  app.get("/api/usage", (c) => {
    const hours = intParam(c.req.query("hours"), 24, 1, 24 * 365);
    const keyId = c.req.query("keyId");
    return c.json({ hours, rows: queryUsage({ hours, ...(keyId ? { keyId } : {}) }) });
  });
  app.get("/api/usage/daily", (c) => {
    const days = intParam(c.req.query("days"), 30, 1, 90);
    const keyId = c.req.query("keyId");
    return c.json({ days, rows: dailyUsage({ days, ...(keyId ? { keyId } : {}) }) });
  });


  app.get("/api/logs", (c) => {
    const limit = intParam(c.req.query("limit"), 100, 1, 1000);
    const keyId = c.req.query("keyId");
    const provider = c.req.query("provider");
    const statusRaw = c.req.query("status");
    const status = statusRaw == null || statusRaw === "" ? undefined : Number.parseInt(statusRaw, 10);
    return c.json({
      limit,
      rows: queryLogs({
        limit,
        ...(keyId ? { keyId } : {}),
        ...(provider ? { provider } : {}),
        ...(status !== undefined && Number.isFinite(status) ? { status } : {}),
      }),
    });
  });

  app.get("/api/registry", (c) => {
    // Catalog metadata only; static per-provider `headers` are omitted.
    const providers = PROVIDERS.map((p) => {
      const seen = new Set(p.models.map((m) => m.id));
      const extra: Array<{ id: string; name: string }> = [];
      for (const conn of listConnections(p.id)) {
        for (const m of getModelsCache(conn.id).models) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            extra.push(m);
          }
        }
      }
      // zed's OAuth needs IDE-side MITM token capture — not offered via connect.
      // Forced here (not in src/core) so the API never pretends otherwise.
      return {
        id: p.id,
        name: p.name,
        alias: p.alias,
        format: p.format,
        baseUrl: p.baseUrl,
        authType: p.authType,
        authStyle: p.authStyle,
        priority: p.priority,
        free: p.free,
        experimental: p.id === "zed" ? true : p.experimental === true,
        ...(p.requiresMitm || p.id === "zed" ? { requiresMitm: true } : {}),
        ...(p.website ? { website: p.website } : {}),
        ...(p.apiKeyUrl ? { apiKeyUrl: p.apiKeyUrl } : {}),
        models: [...p.models, ...extra],
      };
    });
    for (const pid of new Set(listConnections().map((r) => r.provider))) {
      if (providers.some((p) => p.id === pid)) continue;
      const def = providerById(pid);
      if (!def) continue;
      const seen = new Set<string>();
      const models: Array<{ id: string; name: string }> = [];
      for (const conn of listConnections(pid)) {
        for (const m of getModelsCache(conn.id).models) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push(m);
          }
        }
      }
      providers.push({
        id: def.id,
        name: def.name,
        alias: def.alias,
        format: def.format,
        baseUrl: "",
        authType: def.authType,
        authStyle: def.authStyle,
        priority: def.priority,
        free: def.free,
        experimental: false,
        models,
      });
    }
    return c.json({ providers, count: providers.length });
  });

  app.post("/api/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const row = listConnections().find((r) => r.id === id);
    if (!row) return c.json({ error: { message: `unknown connection: ${id}`, type: "not_found_error" } }, 404);
    const prov = providerById(row.provider);
    if (!prov) return c.json({ error: { message: `unknown provider: ${row.provider}`, type: "invalid_request_error" } }, 400);
    const t0 = Date.now();
    // OAuth: check token validity and refresh if needed
    if (row.auth_kind === "oauth") {
      const { OAUTH_PROVIDERS } = await import("../core/oauth/providers/index.ts");
      const def = (OAUTH_PROVIDERS as Record<string, OAuthProviderDef | undefined>)[row.provider];
      if (!row.api_key) return c.json({ ok: false, valid: false, error: "missing access token — re-auth required", status: 401, latencyMs: Date.now() - t0 }, 200);
      if (row.expires_at && row.expires_at < Date.now() + 60_000 && row.refresh_token && def) {
        const beforeToken = row.api_key;
        try {
          const { ensureFresh } = await import("../core/oauth/fresh.ts");
          const fresh = await ensureFresh(row, def);
          // ensureFresh resolves without refreshing when the token is still
          // valid; report refreshed only when the stored token actually rotated.
          const rotated = fresh.accessToken !== beforeToken;
          return c.json({ ok: true, valid: true, status: 200, latencyMs: Date.now() - t0, refreshed: rotated }, 200);
        } catch (e) {
          return c.json({ ok: false, valid: false, error: `refresh failed: ${errMsg(e)}`, status: 401, latencyMs: Date.now() - t0 }, 200);
        }
      }
      // For OAuth, a successful token presence (and refresh) is enough; do a lightweight probe if config has a userinfo URL
      return c.json({ ok: true, valid: true, status: 200, latencyMs: Date.now() - t0, refreshed: false }, 200);
    }
    // API-key: try /v1/models first (no quota), then minimal chat
    try {
      const headers: Record<string, string> = {};
      if (row.api_key) {
        if (prov.authStyle === "combined") headers["x-api-key"] = row.api_key;
        else if (prov.authStyle === "bearer") headers.authorization = `Bearer ${row.api_key}`;
        else headers["x-api-key"] = row.api_key;
      }
      if (row.headers) {
        try { Object.assign(headers, JSON.parse(row.headers as string)); } catch {}
      }
      const base = (row.base_url || prov.baseUrl).replace(/\/+$/, "");
      const body: unknown = await c.req.json().catch(() => ({}));
      const wantModel = body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model.trim() : "";
      if (wantModel) {
        // Per-model test with exactly this model. Responses-only models
        // (e.g. Muse Spark) are probed via the Responses API instead.
        const tR0 = Date.now();
        const done = (ok: boolean, valid: boolean, status: number, extra: Record<string, unknown>, latencyMs = Date.now() - tR0) =>
          c.json({ ok, valid, status, latencyMs, model: wantModel, ...extra }, 200);
        if (modelFormat(prov, wantModel) === "responses") {
          try {
            const rRes = await proxiedFetch(`${base}/responses`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ model: wantModel, input: "hi" }),
              signal: AbortSignal.timeout(15000),
            }, row.proxy_url ?? undefined);
            const text = await rRes.text().catch(() => "");
            if (rRes.ok) return done(true, true, rRes.status, {});
            if (rRes.status === 401 || rRes.status === 403) {
              return done(false, false, rRes.status, { error: text.slice(0, 300) || `auth failed ${rRes.status}` });
            }
            return done(false, false, rRes.status, { error: text.slice(0, 300) || `test failed ${rRes.status}` });
          } catch (e) {
            return done(false, false, 0, { error: (e as Error).message.slice(0, 300) });
          }
        }
        const chatUrl = `${base}/chat/completions`;
        const t1 = Date.now();
        try {
          const chatRes = await proxiedFetch(chatUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ model: wantModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
            signal: AbortSignal.timeout(15000),
          }, row.proxy_url ?? undefined);
          const text = await chatRes.text().catch(() => "");
          const latencyMs = Date.now() - t1;
          if (chatRes.ok) return c.json({ ok: true, valid: true, status: chatRes.status, latencyMs, model: wantModel }, 200);
          if (chatRes.status === 401 || chatRes.status === 403) {
            return c.json({ ok: false, valid: false, status: chatRes.status, error: text.slice(0, 300) || `auth failed ${chatRes.status}`, latencyMs, model: wantModel }, 200);
          }
          if (chatRes.status === 400 && text.includes("model")) {
            return c.json({ ok: true, valid: true, status: chatRes.status, latencyMs, model: wantModel }, 200);
          }
          return c.json({ ok: false, valid: false, status: chatRes.status, error: text.slice(0, 300) || `test failed ${chatRes.status}`, latencyMs, model: wantModel }, 200);
        } catch (e) {
          return c.json({ ok: false, valid: false, error: (e as Error).message.slice(0, 300), latencyMs: Date.now() - t1, model: wantModel }, 200);
        }
      }
      // Try 1: GET /models (most OpenAI-compatible providers)
      const modelsUrl = `${base.replace(/\/(chat\/completions|responses|messages)$/, "")}/models`;
      let res: Response | null = null;
      try {
        res = await proxiedFetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) }, row.proxy_url ?? undefined);
      } catch {}
      if (res && res.ok) {
        return c.json({ ok: true, valid: true, status: res.status, latencyMs: Date.now() - t0 }, 200);
      }
      if (res && (res.status === 401 || res.status === 403)) {
        const text = await res.text().catch(() => "");
        return c.json({ ok: false, valid: false, status: res.status, error: text.slice(0, 300) || `auth failed ${res.status}`, latencyMs: Date.now() - t0 }, 200);
      }
      // Try 2: minimal chat completion (fallback for providers without /models)
      const chatUrl = `${base}/chat/completions`;
      const model = prov.models[0]?.id ?? "gpt-4o";
      const chatRes = await proxiedFetch(chatUrl, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(10000),
      }, row.proxy_url ?? undefined);
      const text = await chatRes.text().catch(() => "");
      if (chatRes.ok) return c.json({ ok: true, valid: true, status: chatRes.status, latencyMs: Date.now() - t0 }, 200);
      if (chatRes.status === 401 || chatRes.status === 403) {
        return c.json({ ok: false, valid: false, status: chatRes.status, error: text.slice(0, 300) || `auth failed ${chatRes.status}`, latencyMs: Date.now() - t0 }, 200);
      }
      // 400 with auth success (e.g. Codex) counts as valid
      if (chatRes.status === 400 && text.includes("model")) {
        return c.json({ ok: true, valid: true, status: chatRes.status, latencyMs: Date.now() - t0 }, 200);
      }
      return c.json({ ok: false, valid: false, status: chatRes.status, error: text.slice(0, 300) || `test failed ${chatRes.status}`, latencyMs: Date.now() - t0 }, 200);
    } catch (e) {
      return c.json({ ok: false, valid: false, error: (e as Error).message.slice(0, 300), latencyMs: Date.now() - t0 }, 200);
    }
  });

  app.post("/api/providers/:id/detect-models", async (c) => {
    const id = c.req.param("id");
    const row = listConnections().find((r) => r.id === id);
    if (!row) return c.json({ error: { message: `unknown connection: ${id}`, type: "not_found_error" } }, 404);
    const prov = providerById(row.provider);
    if (!prov) return c.json({ error: { message: `unknown provider: ${row.provider}`, type: "invalid_request_error" } }, 400);
    const base = (row.base_url || prov.baseUrl).replace(/\/*$/, "");
    if (!base) {
      return c.json({ error: { message: "no base URL for this connection — set one first", type: "invalid_request_error" } }, 400);
    }
    const headers: Record<string, string> = {};
    if (row.api_key) {
      if (prov.authStyle === "combined") headers["x-api-key"] = row.api_key;
      else headers.authorization = `Bearer ${row.api_key}`;
    }
    if (row.headers) {
      try {
        Object.assign(headers, JSON.parse(row.headers));
      } catch {}
    }
    const t0 = Date.now();
    try {
      const modelsUrl = `${base.replace(/\/(chat\/completions|responses|messages)$/, "")}/models`;
      const res = await proxiedFetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) }, row.proxy_url ?? undefined);
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return c.json({ ok: false, error: text.slice(0, 300) || `list failed ${res.status}`, status: res.status, latencyMs: Date.now() - t0 }, 200);
      }
      let data: unknown = null;
      try {
        data = JSON.parse(text);
      } catch {
        return c.json({ ok: false, error: "upstream did not return JSON", status: res.status, latencyMs: Date.now() - t0 }, 200);
      }
      const list: unknown = data && typeof data === "object" && "data" in data && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      const seen = new Set<string>();
      const models: Array<{ id: string }> = [];
      if (!Array.isArray(list)) {
        return c.json({ ok: false, error: "upstream returned no usable models — cache left unchanged", status: res.status, latencyMs: Date.now() - t0 }, 200);
      }
      for (const m of list) {
        if (!m || typeof m !== "object" || !("id" in m)) continue;
        const mid: unknown = m.id;
        if (typeof mid !== "string") continue;
        const trimmed = mid.trim().slice(0, 200);
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        models.push({ id: trimmed });
        if (models.length >= 500) break;
      }
      if (models.length === 0) {
        // Never cache an empty list silently: an empty /models answer means the
        // key lacks model visibility or the endpoint is wrong — say so loudly.
        return c.json({ ok: false, error: "upstream returned no usable models — cache left unchanged", status: res.status, latencyMs: Date.now() - t0 }, 200);
      }
      setModelsCache(id, models);
      const cached = getModelsCache(id);
      return c.json({ ok: true, models: cached.models, count: cached.models.length, latencyMs: Date.now() - t0 }, 200);
    } catch (e) {
      return c.json({ ok: false, error: errMsg(e).slice(0, 300), latencyMs: Date.now() - t0 }, 200);
    }
  });

  // ---- combos ----
  app.get("/api/combos", (c) => {
    try {
      return c.json({ combos: listCombos().map((r) => ({ ...r, steps: parseStoredSteps(r.steps, `combo "${r.name}"`) })) });
    } catch (e) {
      return c.json({ error: { message: errMsg(e), type: "server_error" } }, 500);
    }
  });
  app.post("/api/combos", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown; strategy?: unknown; steps?: unknown; enabled?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || !Array.isArray(body?.steps) || !body.steps.length) {
      return c.json({ error: { message: "name and non-empty steps[] required", type: "invalid_request_error" } }, 400);
    }
    if (body.strategy !== undefined && body.strategy !== "priority" && body.strategy !== "weighted") {
      return c.json({ error: { message: "strategy must be priority or weighted", type: "invalid_request_error" } }, 400);
    }
    if ((body.steps as unknown[]).some((s) => typeof s !== "object" || s === null || typeof (s as Record<string, unknown>).model !== "string")) {
      return c.json({ error: { message: "each step needs a model string", type: "invalid_request_error" } }, 400);
    }
    audit("combo.create", name);
    const id = `cmb_${name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 24)}_${Date.now().toString(36)}`;
    putCombo({ id, name, description: typeof body.description === "string" ? body.description : "", strategy: typeof body.strategy === "string" ? body.strategy : "priority", steps: body.steps as unknown[], enabled: body.enabled !== false });
    return c.json({ ok: true, id, name }, 201);
  });
  app.put("/api/combos/:id", async (c) => {
    const id = c.req.param("id");
    const existing = listCombos().find((r) => r.id === id);
    if (!existing) return c.json({ error: { message: `unknown combo: ${id}`, type: "not_found_error" } }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
    if (body?.steps !== undefined && !Array.isArray(body.steps)) {
      return c.json({ error: { message: "steps must be an array when provided", type: "invalid_request_error" } }, 400);
    }
    let steps: unknown[];
    try {
      steps = Array.isArray(body?.steps) ? body.steps : parseStoredSteps(existing.steps, `combo "${existing.name}"`);
    } catch (e) {
      return c.json({ error: { message: errMsg(e), type: "server_error" } }, 500);
    }
    const description = typeof body?.description === "string" ? body.description : existing.description;
    const strategy = typeof body?.strategy === "string" ? body.strategy : existing.strategy;
    const enabled = typeof body?.enabled === "boolean" ? body.enabled : !!existing.enabled;
    putCombo({ id, name, description, strategy, steps, enabled });
    return c.json({ ok: true, id });
  });
  app.delete("/api/combos/:id", (c) => {
    if (!listCombos().some((r) => r.id === c.req.param("id"))) return c.json({ error: { message: "unknown combo", type: "not_found_error" } }, 404);
    deleteCombo(c.req.param("id"));
    audit("combo.delete", c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- OAuth (Phase 4) ----
  app.post("/api/oauth/:provider/begin", async (c) => {
    const provider = c.req.param("provider");
    const def = (OAUTH_PROVIDERS as Record<string, { id: string }>)[provider];
    if (!def) return c.json({ error: { message: `unknown oauth provider: ${provider}`, type: "not_found_error" } }, 404);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { redirectUri?: string; meta?: Record<string, unknown>; options?: Record<string, unknown> };
      const meta = (body.meta ?? body.options) as Record<string, unknown> | undefined;
      // For code-flow providers without a built-in redirectPort (claude etc) the engine
      // requires an explicit redirectUri. Provide a loopback placeholder so dashboard
      // callers that send {} (no redirectUri) still get a usable authorize URL.
      if (body.redirectUri !== undefined) {
        let u: URL;
        try {
          u = new URL(body.redirectUri);
        } catch {
          return c.json({ error: { message: "redirectUri must be a valid URL", type: "invalid_request_error" } }, 400);
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return c.json({ error: { message: "redirectUri must be http(s)", type: "invalid_request_error" } }, 400);
        }
      }
      const redirectUri = body.redirectUri ?? "http://127.0.0.1:9784/callback";
      const result = await beginAuth(def as never, redirectUri, meta);
      return c.json(result);
    } catch (e) {
      return c.json({ error: { message: (e as Error).message, type: "oauth_error" } }, 500);
    }
  });
  app.post("/api/oauth/:provider/exchange", async (c) => {
    const provider = c.req.param("provider");
    const def = (OAUTH_PROVIDERS as Record<string, { id: string }>)[provider];
    if (!def) return c.json({ error: { message: `unknown oauth provider: ${provider}`, type: "not_found_error" } }, 404);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { code?: string; session?: unknown };
      const session = body.session as never;
      let tokens;
      if (body.code) {
        tokens = await completeCode(def as never, body.code as string, session);
      } else {
        const res = await pollDevice(def as never, session);
        if (res === "pending") return c.json({ status: "pending" });
        tokens = res;
      }
      const id = `oauth_${provider}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      putOAuthConnection({ id, provider, accessToken: (tokens as { accessToken: string }).accessToken, refreshToken: (tokens as { refreshToken?: string }).refreshToken ?? null, expiresAt: (tokens as { expiresAt?: number | null }).expiresAt ?? null, scope: (tokens as { scope?: string }).scope ?? null, email: (tokens as { email?: string }).email ?? null, extra: (tokens as { extra?: Record<string, unknown> }).extra ?? null });
      audit("oauth.connect", `${provider} id=${id}`);
      return c.json({ ok: true, id, provider });
    } catch (e) {
      return c.json({ error: { message: (e as Error).message, type: "oauth_error" } }, 400);
    }
  });

  // ---- pricing & budgets ----
  app.get("/api/pricing", (c) => {
    const rows = all("SELECT provider,model,input_usd,output_usd,cache_read_usd FROM pricing ORDER BY provider,model") as Array<Record<string, unknown>>;
    return c.json({ pricing: rows });
  });
  app.get("/api/keys/:id/budget", (c) => {
    const id = c.req.param("id");
    const row = get("SELECT budget_usd_monthly AS budget FROM api_keys WHERE id=?", id) as { budget: number | null } | undefined;
    if (!row) return c.json({ error: { message: `unknown key: ${id}`, type: "not_found_error" } }, 404);
    return c.json({ id, budget: row.budget, spent: monthSpendFor(id) });
  });
  app.put("/api/keys/:id/budget", async (c) => {
    const id = c.req.param("id");
    if (!keyControls(id)) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    const body = (await c.req.json().catch(() => null)) as { budget?: unknown } | null;
    const budget = body?.budget == null ? null : Number(body.budget);
    if (budget != null && (!Number.isFinite(budget) || budget < 0)) return c.json({ error: { message: "budget must be null or non-negative number", type: "invalid_request_error" } }, 400);
    run("UPDATE api_keys SET budget_usd_monthly=? WHERE id=?", budget, id);
    audit("key.budget", `${id} budget=${budget}`);
    return c.json({ ok: true, id, budget });
  });
  // ---- request log export (download as file) ----
  app.get("/api/logs/export", (c) => {
    const format = (c.req.query("format") ?? "jsonl").toLowerCase();
    if (format !== "jsonl" && format !== "csv") {
      return c.json(
        { error: { message: "format must be jsonl or csv", type: "invalid_request_error" } },
        400,
      );
    }
    const keyId = c.req.query("keyId");
    const provider = c.req.query("provider");
    const statusRaw = c.req.query("status");
    const status = statusRaw == null || statusRaw === "" ? undefined : Number.parseInt(statusRaw, 10);
    const base = {
      ...(keyId ? { keyId } : {}),
      ...(provider ? { provider } : {}),
      ...(status !== undefined && Number.isFinite(status) ? { status } : {}),
    };
    const ts = Date.now();
    // Paginated streaming: 100k rows must not sit in RAM at once or block the
    // event loop in one giant string build. Pages of 1000 keep each sqlite
    // round-trip short; setTimeout(0) between pages yields to the loop.
    const PAGE = 1000;
    const pump = (ctrl: ReadableStreamDefaultController, write: (rows: Array<Record<string, unknown>>) => void): void => {
      let offset = 0;
      const step = (): void => {
        let rows: Array<Record<string, unknown>>;
        try {
          rows = queryLogs({ ...base, limit: PAGE, offset }) as unknown as Array<Record<string, unknown>>;
        } catch (e) {
          ctrl.error(e);
          return;
        }
        write(rows);
        if (rows.length < PAGE) {
          ctrl.close();
          return;
        }
        offset += rows.length;
        setTimeout(step, 0);
      };
      step();
    };
    const enc = new TextEncoder();
    if (format === "csv") {
      const esc = (v: unknown): string => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      let cols: string[] | null = null;
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="rikka-logs-${ts}.csv"`);
      return c.body(
        new ReadableStream({
          start(ctrl) {
            pump(ctrl, (rows) => {
              if (!cols) {
                cols = rows.length > 0 ? Object.keys(rows[0] as object) : ["seq", "ts", "method", "path", "status"];
                ctrl.enqueue(enc.encode(`${cols.join(",")}\n`));
              }
              const active: string[] = cols;
              for (const r of rows) ctrl.enqueue(enc.encode(`${active.map((k) => esc(r[k])).join(",")}\n`));
            });
          },
        }),
      );
    }
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="rikka-logs-${ts}.jsonl"`);
    return c.body(
      new ReadableStream({
        start(ctrl) {
          pump(ctrl, (rows) => {
            for (const r of rows) ctrl.enqueue(enc.encode(`${JSON.stringify(r)}\n`));
          });
        },
      }),
    );
  });

  // ---- OAuth status & revoke ----
  app.get("/api/oauth/status", (c) => {
    return c.json({ providers: oauthStatus() });
  });
  app.delete("/api/oauth/:provider", (c) => {
    const provider = c.req.param("provider");
    const owned = listConnections(provider).filter((r) => r.auth_kind === "oauth");
    if (owned.length === 0) {
      return c.json(
        { error: { message: `no oauth connection for provider: ${provider}`, type: "not_found_error" } },
        404,
      );
    }
    for (const r of owned) deleteConnection(r.id);
    return c.json({ ok: true, provider, revoked: owned.length });
  });

  // ---- rate-limit settings ----
  app.get("/api/settings/limits", (c) => c.json(getRateLimits()));
  app.put("/api/settings/limits", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      rpmPerKey?: unknown;
      rpmPerConnection?: unknown;
    } | null;
    if (!body || (body.rpmPerKey === undefined && body.rpmPerConnection === undefined)) {
      return c.json(
        { error: { message: "rpmPerKey and/or rpmPerConnection (>= 0) required", type: "invalid_request_error" } },
        400,
      );
    }
    const patch: { rpmPerKey?: number; rpmPerConnection?: number } = {};
    for (const k of ["rpmPerKey", "rpmPerConnection"] as const) {
      const v: unknown = body[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return c.json(
          { error: { message: `${k} must be a non-negative number`, type: "invalid_request_error" } },
          400,
        );
      }
      patch[k] = v;
    }
    setRateLimits(patch);
    return c.json(getRateLimits());
  });

  // ---- auto proxy pool ----
  app.get("/api/proxy/pool", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10) || 50));
    const proxies = listPool(limit).map((p) => ({ ...p, url: maskProxyUrl(p.url) }));
    return c.json({ ...poolStats(), proxies });
  });
  app.post("/api/proxy/refresh", async (c) => {
    const refreshed = await refreshPool();
    const probed = await probePool();
    return c.json({ ok: true, ...poolStats(), added: refreshed.added, sources: refreshed.sources, checked: probed.checked });
  });

  // ---- chat turns: per-user conversation capture, viewer, training export ----
  app.get("/api/chats", (c) => {
    const q = c.req.query();
    const f = {
      ...(q.keyId ? { keyId: q.keyId } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.ok === "1" ? { ok: true } : q.ok === "0" ? { ok: false } : {}),
      ...(q.minQuality ? { minQuality: Number(q.minQuality) || 0 } : {}),
      ...(q.q ? { q: q.q.slice(0, 200) } : {}),
      ...(q.since ? { since: Number(q.since) || 0 } : {}),
      limit: Math.min(200, Math.max(1, Number.parseInt(q.limit ?? "50", 10) || 50)),
      offset: Math.max(0, Number.parseInt(q.offset ?? "0", 10) || 0),
    };
    return c.json({ turns: queryChats(f), total: countChats(f) });
  });
  app.get("/api/chats/heatmap", (c) => {
    const provider = c.req.query("provider") || "opencode-zen";
    const days = Math.min(30, Math.max(1, Number.parseInt(c.req.query("days") ?? "7", 10) || 7));
    return c.json({ provider, days, hours: heat429(provider, days) });
  });
  app.get("/api/chats/by-key", (c) => {
    const days = Math.min(90, Math.max(1, Number.parseInt(c.req.query("days") ?? "30", 10) || 30));
    return c.json({ stats: chatStatsByKey(Date.now() - days * 86_400_000) });
  });
  app.get("/api/chats/export", (c) => {
    const q = c.req.query();
    const format = q.format === "sharegpt" || q.format === "raw" ? q.format : "openai";
    const ids = q.ids ? q.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500) : undefined;
    const f = {
      ...(q.keyId ? { keyId: q.keyId } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.ok === "1" ? { ok: true } : q.ok === "0" ? { ok: false } : {}),
      ...(q.minQuality ? { minQuality: Number(q.minQuality) || 0 } : {}),
      ...(q.q ? { q: q.q.slice(0, 200) } : {}),
      ...(q.since ? { since: Number(q.since) || 0 } : {}),
      ...(ids?.length ? { ids } : {}),
      dedup: q.dedup !== "0",
      scrub: q.scrub !== "0",
    };
    // Stream in 500-row pages (shared dedup state) so a 5000-turn export
    // never sits fully materialized in RAM. x-export-count = matched rows.
    const feff = { ...f, ...(f.ok === undefined && !f.ids?.length ? { ok: true } : {}) };
    const total = Math.min(countChats(feff), 5000);
    const id = recordDatasetExport(format, f, total);
    audit("dataset.export", `${format} matched=${total} id=${id}`);
    const seen = new Set<string>();
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= total) {
          controller.close();
          return;
        }
        try {
          const page = exportChatsPage(f, format, offset, seen);
          offset += 500;
          const chunk = page.lines.length ? (offset > 500 ? "\n" : "") + page.lines.join("\n") : "";
          if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
          if (page.done || offset >= total) controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/jsonl", "content-disposition": `attachment; filename="rikka-${format}-${id}.jsonl"`, "x-export-id": id, "x-export-count": String(total) },
    });
  });
  app.get("/api/chats/exports", (c) => c.json({ exports: listDatasetExports() }));
  app.get("/api/chats/:id", (c) => {
    const t = getChat(c.req.param("id"));
    if (!t) return c.json({ error: { message: "unknown chat turn", type: "not_found_error" } }, 404);
    return c.json({ turn: t });
  });
  app.delete("/api/chats/:id", (c) => {
    const ok = deleteChat(c.req.param("id"));
    if (ok) audit("chat.delete", c.req.param("id"));
    return c.json({ ok });
  });

  // ---- proxy management: private lists, labels, priority, manual probe ----
  app.post("/api/proxy", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; urls?: unknown; label?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label.slice(0, 60) : "";
    let urls: string[] = [];
    if (typeof body?.text === "string") urls = parseProxyList(body.text);
    else if (Array.isArray(body?.urls)) urls = (body.urls as unknown[]).filter((u): u is string => typeof u === "string").flatMap((u) => parseProxyList(u));
    urls = [...new Set(urls)].slice(0, 500);
    const added = addProxies(urls, label);
    if (added) audit("proxy.add", `${added} proxies label=${label || "-"}`);
    return c.json({ ok: true, added, total: urls.length }, added ? 201 : 200);
  });
  app.delete("/api/proxy", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    const ok = url ? removeProxy(url) : false;
    if (ok) audit("proxy.remove", maskProxyUrl(url));
    return c.json({ ok });
  });
  app.put("/api/proxy", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown; label?: unknown; priority?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    if (!url) return c.json({ error: { message: "url is required", type: "invalid_request_error" } }, 400);
    const meta: { label?: string; priority?: number } = {};
    if (typeof body?.label === "string") meta.label = body.label.slice(0, 60);
    if (typeof body?.priority === "number") meta.priority = body.priority;
    const ok = setProxyMeta(url, meta);
    if (ok) audit("proxy.meta", `${maskProxyUrl(url)} ${JSON.stringify(meta).slice(0, 120)}`);
    return c.json({ ok });
  });
  app.post("/api/proxy/probe", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const raw = typeof body?.url === "string" ? body.url : "";
    if (!raw) return c.json({ error: { message: "url is required", type: "invalid_request_error" } }, 400);
    const blocked = ssrfErrorForProxyUrl(resolveProxyUrl(raw));
    if (blocked) return c.json({ error: { message: blocked, type: "invalid_request_error" } }, 400);
    const ms = await probeOne(resolveProxyUrl(raw));
    return c.json({ ok: ms != null, latencyMs: ms });
  });
  // ---- client-key controls: access, scopes, prepaid, logging ----
  app.put("/api/keys/:id/controls", async (c) => {
    const id = c.req.param("id");
    if (!keyControls(id)) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      logBodies?: unknown; balance?: unknown; allowModels?: unknown; ipAllowlist?: unknown; contact?: unknown; disabled?: unknown;
    } | null;
    const patch: Parameters<typeof setKeyControls>[1] = {};
    if (typeof body?.logBodies === "boolean") patch.logBodies = body.logBodies;
    if (body?.balance === null || typeof body?.balance === "number") patch.balance = body.balance;
    if (body?.allowModels === null || Array.isArray(body?.allowModels)) {
      patch.allowModels = body.allowModels === null ? null : (body.allowModels as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100);
    }
    if (Array.isArray(body?.ipAllowlist)) {
      patch.ipAllowlist = (body.ipAllowlist as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    }
    if (typeof body?.contact === "string") patch.contact = body.contact.slice(0, 120);
    if (typeof body?.disabled === "boolean") patch.disabled = body.disabled;
    setKeyControls(id, patch);
    audit("key.controls", `${id} ${Object.keys(patch).join(",")}`);
    return c.json({ ok: true, controls: keyControls(id) });
  });
  app.post("/api/keys/:id/rotate", (c) => {
    const r = rotateApiKey(c.req.param("id"));
    if (!r) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    audit("key.rotate", c.req.param("id"));
    // full secret returned exactly once — only its hash is stored
    return c.json({ ok: true, id: c.req.param("id"), secret: r.secret });
  });
  app.get("/api/keys/:id/stats", (c) => {
    const id = c.req.param("id");
    if (!keyControls(id)) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    const days = Math.min(90, Math.max(1, Number.parseInt(c.req.query("days") ?? "30", 10) || 30));
    const since = Date.now() - days * 86_400_000;
    const usage = all("SELECT COUNT(*) n, SUM(ok) ok_n, SUM(input_tokens) inp, SUM(output_tokens) outp, SUM(cost_usd) cost FROM usage WHERE key_id = ? AND ts >= ?", id, since) as Array<Record<string, number | null>>;
    const chats = all("SELECT COUNT(*) n, SUM(ok) ok_n, SUM(cost_usd) cost, AVG(latency_ms) avg_ms FROM chat_turns WHERE key_id = ? AND ts >= ?", id, since) as Array<Record<string, number | null>>;
    const byModel = all("SELECT model, COUNT(*) n, SUM(cost_usd) cost FROM chat_turns WHERE key_id = ? AND ts >= ? GROUP BY model ORDER BY n DESC LIMIT 20", id, since);
    return c.json({ id, days, usage: usage[0] ?? null, chats: chats[0] ?? null, byModel, balance: keyBalance(id), spentMonth: monthSpendFor(id) });
  });
  app.get("/api/keys/:id/invoice", (c) => {
    const id = c.req.param("id");
    if (!keyControls(id)) return c.json({ error: { message: "unknown key", type: "not_found_error" } }, 404);
    const m = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return c.json({ error: { message: "month must be YYYY-MM", type: "invalid_request_error" } }, 400);
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    if (!Number.isInteger(y) || !Number.isInteger(mo) || mo < 1 || mo > 12) {
      return c.json({ error: { message: "month must be YYYY-MM", type: "invalid_request_error" } }, 400);
    }
    const from = Date.UTC(y, mo - 1, 1);
    const to = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1);
    const rows = all("SELECT ts,provider,model,input_tokens,output_tokens,cost_usd,status FROM usage WHERE key_id = ? AND ts >= ? AND ts < ? ORDER BY ts", id, from, to) as Array<Record<string, string | number | null>>;
    const total = rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
    // Quote like the logs exporter + neutralize formula injection (=+-@).
    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = ["ts,provider,model,input_tokens,output_tokens,cost_usd,status", ...rows.map((r) => [r.ts, r.provider, r.model, r.input_tokens, r.output_tokens, r.cost_usd, r.status].map(cell).join(",")), `total,,,,,${total.toFixed(6)},`].join("\n");
    audit("key.invoice", `${id} ${m} n=${rows.length}`);
    return new Response(csv, { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="rikka-invoice-${id}-${m}.csv"` } });
  });
  app.get("/api/costs/margin", (c) => {
    const days = Math.min(365, Math.max(1, Number.parseInt(c.req.query("days") ?? "30", 10) || 30));
    const since = Date.now() - days * 86_400_000;
    const rows = all("SELECT u.key_id, k.name, COUNT(*) n, SUM(u.cost_usd) revenue FROM usage u LEFT JOIN api_keys k ON k.id = u.key_id WHERE u.ts >= ? GROUP BY u.key_id ORDER BY revenue DESC", since);
    const total = rows.reduce((a, r) => a + (Number((r as Record<string, unknown>).revenue) || 0), 0);
    return c.json({ days, byKey: rows, totalRevenue: total, note: "upstream cost is tracked as $0 (own keys / free tiers); revenue is internal charges at the flat rate" });
  });
  app.put("/api/providers/:id/status", async (c) => {
    const id = c.req.param("id");
    if (!listConnections().some((r) => r.id === id)) return c.json({ error: { message: "unknown connection", type: "not_found_error" } }, 404);
    const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
    const status = body?.status === "disabled" ? "disabled" : body?.status === "active" ? "active" : null;
    if (!status) return c.json({ error: { message: "status must be active or disabled", type: "invalid_request_error" } }, 400);
    run("UPDATE connections SET status = ?, cooldown_until = 0, updated_at = ? WHERE id = ?", status, Date.now(), id);
    audit("connection.status", `${id} ${status}`);
    return c.json({ ok: true });
  });
  app.put("/api/providers/:id/wait", async (c) => {
    const id = c.req.param("id");
    if (!listConnections().some((r) => r.id === id)) return c.json({ error: { message: "unknown connection", type: "not_found_error" } }, 404);
    const body = (await c.req.json().catch(() => null)) as { proxyWait?: unknown } | null;
    if (typeof body?.proxyWait !== "boolean") return c.json({ error: { message: "proxyWait must be boolean", type: "invalid_request_error" } }, 400);
    run("UPDATE connections SET proxy_wait = ?, updated_at = ? WHERE id = ?", body.proxyWait ? 1 : 0, Date.now(), id);
    audit("connection.wait", `${id} proxyWait=${body.proxyWait}`);
    return c.json({ ok: true });
  });
  // ---- ops: audit, health radar, telegram ----
  app.get("/api/audit", (c) => c.json({ rows: queryAudit(Math.min(500, Math.max(1, Number.parseInt(c.req.query("limit") ?? "100", 10) || 100))) }));
  app.get("/api/health/upstreams", (c) => c.json({ targets: listHealth() }));
  app.post("/api/health/check", async (c) => {
    const r = await checkUpstreams();
    return c.json({ ok: true, ...r, targets: listHealth() });
  });
  app.get("/api/notify/settings", (c) => c.json({ configured: telegramConfigured() }));
  app.put("/api/notify/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { botToken?: unknown; chatId?: unknown } | null;
    if (typeof body?.botToken === "string" && body.botToken) setSetting("telegram_bot_token", body.botToken);
    if (typeof body?.chatId === "string" && body.chatId) setSetting("telegram_chat_id", body.chatId);
    audit("notify.settings", "telegram credentials updated");
    return c.json({ ok: true, configured: telegramConfigured() });
  });
  app.post("/api/notify/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { to?: unknown } | null;
    const r = await telegramTest(typeof body?.to === "string" ? body.to : "");
    return c.json(r, r.ok ? 200 : 400);
  });
  // ---- public status (no lock, no secrets) ----
  app.get("/api/public/status", (c) => {
    const pool = poolStats();
    return c.json({ name: "rikka", time: Date.now(), pool: { total: pool.total, healthy: pool.healthy }, upstreams: listHealth().map((t) => ({ target: t.target, ok: t.ok, latencyMs: t.latency_ms })) });
  });
  app.get("/public-status", (c) => c.html(PUBLIC_STATUS_HTML));

const PUBLIC_STATUS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Rikka — Status</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050507;color:#f5f5f7;font:14px/1.5 "Inter Variable","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{width:min(520px,94vw);background:#0d0d13;border:1px solid #1b1b27;border-radius:12px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.dot{width:10px;height:10px;border-radius:50%;background:#ff168c;box-shadow:0 0 24px rgba(255,22,140,.18)}
.brand b{font-size:14px;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:20px;margin:12px 0 4px}.sub{color:#8a8a99;font-size:12px;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:7px 4px;border-top:1px solid #1b1b27}
.ok{color:#2ee6a8}.bad{color:#ff4d5e}.dim{color:#5c5c6b}
.r{text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
</style></head><body><div class="card">
<div class="brand"><span class="dot"></span><b>Rikka</b></div>
<h1>Status</h1><p class="sub" id="sub">checking…</p>
<table><tbody id="rows"></tbody></table>
<script>
fetch('/api/public/status').then(r=>r.json()).then(d=>{
  document.getElementById('sub').textContent='updated '+new Date(d.time).toLocaleTimeString()+' · pool '+d.pool.healthy+'/'+d.pool.total+' healthy';
  document.getElementById('rows').innerHTML=d.upstreams.map(u=>'<tr><td>'+u.target+'</td><td class="r '+(u.ok?'ok':'bad')+'">'+(u.ok?'operational':'down'+(u.latencyMs!=null?' · '+u.latencyMs+'ms':''))+'</td></tr>').join('')||'<tr><td class="dim">no data yet</td><td></td></tr>';
}).catch(()=>{document.getElementById('sub').textContent='unreachable';});
setTimeout(()=>location.reload(),60000);
</script></div></body></html>`;
  // ---- built dashboard SPA (enabled when dist assets exist) ----
  if (opts.staticRoot) {
    const root = opts.staticRoot;
    app.use(
      "/*",
      serveStatic({
        root,
        rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
      }),
    );
    app.get("*", (c) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p.startsWith("/v1") || p.startsWith("/health")) {
        return c.json({ error: { message: `no route: ${p}`, type: "not_found_error" } }, 404);
      }
      // SPA fallback: client-side hash routing means any unknown path serves the shell.
      try {
        return c.html(readFileSync(`${root}/index.html`, "utf8"));
      } catch {
        return c.text("dashboard not built — run: npm --prefix dashboard run build", 503);
      }
    });
  }

  // Global contract: every error leaves as JSON {error:{message,type}} —
  // never Hono's default plain-text 500/404.
  app.notFound((c) => c.json({ error: { message: `no route: ${c.req.path}`, type: "not_found_error" } }, 404));
  app.onError((err, c) => c.json({ error: { message: err.message.slice(0, 300) || "internal error", type: "server_error" } }, 500));

  return app;
}

function isStaticAsset(path: string): boolean {
  return path.startsWith("/assets/") || /\.(?:js|css|svg|png|ico|woff2?|json|txt|map)$/.test(path);
}

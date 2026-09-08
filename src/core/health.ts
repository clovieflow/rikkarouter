import { all, listConnections, run } from "../shared/db.ts";
import { providerById } from "./providers/registry.ts";
import { notify } from "../server/notify.ts";

// Upstream health radar: lightweight liveness per provider base URL.
// Read-only probes (GET {base}/models) — never marks cooldowns, only records.

export interface HealthRow {
  target: string;
  ts: number;
  ok: number;
  latency_ms: number | null;
  status: number | null;
  error: string | null;
}

async function probeTarget(target: string, base: string, apiKey?: string): Promise<void> {
  const t0 = Date.now();
  let ok = 0;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const url = `${base.replace(/\/*$/, "")}/models`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    status = r.status;
    await r.body?.cancel().catch(() => {});
    // reachable + speaking HTTP = healthy enough for routing (401 still counts:
    // the host is up and the API shape answers)
    ok = r.status < 500 ? 1 : 0;
    if (!ok) error = `http ${r.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 200);
  }
  const prev = (all("SELECT ok FROM provider_health WHERE target = ?", target) as Array<{ ok: number }>)[0]?.ok;
  run(
    "INSERT INTO provider_health(target,ts,ok,latency_ms,status,error) VALUES(?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET ts=excluded.ts,ok=excluded.ok,latency_ms=excluded.latency_ms,status=excluded.status,error=excluded.error",
    target,
    Date.now(),
    ok,
    ok ? Date.now() - t0 : null,
    status,
    error,
  );
  if (prev === 1 && !ok) void notify(`health:${target}`, `upstream DOWN: ${target} (${error ?? "no response"})`, 900_000);
  if (prev === 0 && ok) void notify(`health:${target}`, `upstream recovered: ${target}`, 900_000);
}

export async function checkUpstreams(): Promise<{ checked: number }> {
  const seen = new Set<string>();
  let checked = 0;
  for (const conn of listConnections()) {
    if (conn.status === "disabled") continue;
    const prov = providerById(conn.provider);
    const base = (conn.base_url || prov?.baseUrl || "").trim();
    if (!base || !/^https?:\/\//i.test(base) || seen.has(base)) continue;
    seen.add(base);
    await probeTarget(`provider:${conn.provider}`, base, conn.api_key || undefined);
    checked += 1;
  }
  // the proxy pool itself is an upstream for auto-mode connections
  try {
    const { poolStats } = await import("./proxypool.ts");
    const s = poolStats();
    const target = "pool:auto";
    const prev = (all("SELECT ok FROM provider_health WHERE target = ?", target) as Array<{ ok: number }>)[0]?.ok;
    const ok = s.healthy > 0 ? 1 : 0;
    run("INSERT INTO provider_health(target,ts,ok,latency_ms,status,error) VALUES(?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET ts=excluded.ts,ok=excluded.ok,latency_ms=excluded.latency_ms,status=excluded.status,error=excluded.error", target, Date.now(), ok, null, null, ok ? null : "pool empty");
    if (prev === 1 && !ok) void notify("health:pool", "auto proxy pool is EMPTY (no healthy proxy)", 900_000);
  } catch {}
  return { checked };
}

export function listHealth(): HealthRow[] {
  return all("SELECT target,ts,ok,latency_ms,status,error FROM provider_health ORDER BY target") as unknown as HealthRow[];
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Background radar. Safe to call once at boot; no-ops afterwards. */
export function startHealthRadar(intervalMs = 5 * 60_000): void {
  if (timer) return;
  void checkUpstreams().catch(() => {});
  timer = setInterval(() => {
    void checkUpstreams().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

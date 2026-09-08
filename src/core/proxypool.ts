// Automatic free-proxy pool: fetch public lists, probe liveness, rotate per
// request. Opt-in per connection (proxy_mode='auto'). Our upstreams are all
// HTTPS, so a proxy only ever sees the destination hostname (CONNECT) plus
// timing/size — never request bodies or API keys. Free proxies are still
// slow and flaky; the pool health-checks and demotes aggressively.
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { all, run } from "../shared/db.ts";
export const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
];

/** Generic lightweight probe target (captive-portal check, tiny body). */
export const PROBE_URL = "https://www.google.com/generate_204";
export const PROBE_TIMEOUT_MS = 8000;
const MAX_FAILS = 3;
const PRUNE_FAILS = 8;
const STALE_MS = 10 * 60_000;
// 120 sequential probes fit inside the 10min loop with headroom (typical
// probe settles in <2s; hung ones are cut by the fetch timeout).
const CHECK_BATCH = 120;
/** Unlabeled rows dead this long are reaped even below PRUNE_FAILS. */
const REAP_DEAD_MS = 7 * 24 * 3600_000;

export interface PoolRow {
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

export function parseProxyList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string) => {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  const HOST = "(?:\\d{1,3}(?:\\.\\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)";
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/^https?:\/\//i, "");
    // ip:port:user:pass (private lists, e.g. Webshare) — creds stay in the URL
    const auth = t.match(new RegExp(`^(${HOST}):(\\d{1,5}):([^:\\s]+):([^:\\s]+)$`));
    if (auth) {
      const [, host, port, user, pass] = auth;
      const p = Number(port);
      if (p >= 1 && p <= 65535) push(`http://${encodeURIComponent(user ?? "")}:${encodeURIComponent(pass ?? "")}@${host}:${p}`);
      continue;
    }
    // [user:pass@]host:port
    const m = t.match(new RegExp(`^(?:([^:\\s]+):([^@\\s]+)@)?(${HOST}):(\\d{1,5})$`));
    if (!m) continue;
    const p = Number(m[4]);
    if (p < 1 || p > 65535) continue;
    push(m[1] !== undefined ? `http://${encodeURIComponent(m[1])}:${encodeURIComponent(m[2] ?? "")}@${m[3]}:${p}` : `http://${m[3]}:${p}`);
  }
  return out;
}

export function poolSize(): number {
  try {
    return (all("SELECT COUNT(*) AS n FROM proxy_pool") as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Free-list refresh must not grow the pool without bound. */
export const MAX_POOL_ROWS = 20_000;

/**
 * Make room for fresh candidates by evicting the worst dead weight first:
 * unlabeled, unhealthy, most-failed, stalest-checked. Labeled (private) and
 * healthy rows are never touched. Returns rows freed.
 */
export function evictDeadWeight(room = 1000): number {
  try {
    const size = poolSize();
    if (size < MAX_POOL_ROWS) return 0;
    const need = size - MAX_POOL_ROWS + room;
    // SQLite has no LIMIT on DELETE directly — select then delete.
    const victims = all("SELECT url FROM proxy_pool WHERE ok = 0 AND (label IS NULL OR label = '') ORDER BY fails DESC, last_check ASC LIMIT ?", need) as unknown as Array<{ url: string }>;
    for (const { url } of victims) {
      try {
        run("DELETE FROM proxy_pool WHERE url = ?", url);
      } catch {}
    }
    return victims.length;
  } catch {
    return 0;
  }
}
export async function refreshPool(sources: string[] = PROXY_SOURCES): Promise<{ added: number; sources: number }> {
  const before = (all("SELECT COUNT(*) AS n FROM proxy_pool") as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  let okSources = 0;
  for (const src of sources) {
    // At cap: evict worst dead weight for fresh candidates. If nothing could
    // be freed (pool is all labeled/healthy), stop instead of growing.
    if (poolSize() >= MAX_POOL_ROWS && evictDeadWeight() === 0) break;
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      okSources += 1;
      const text = await res.text();
      for (const url of parseProxyList(text)) {
        run("INSERT OR IGNORE INTO proxy_pool(url, source, last_check, ok, latency_ms, fails) VALUES(?,?,?,?,?,?)", url, src, null, 0, null, 0);
      }
    } catch {
      // a dead list source must not break the refresh
    }
  }
  const after = (all("SELECT COUNT(*) AS n FROM proxy_pool") as unknown as Array<{ n: number }>)[0]?.n ?? before;
  return { added: Math.max(0, after - before), sources: okSources };
}
export function listPool(limit = 100): PoolRow[] {
  return all("SELECT url, source, last_check, ok, latency_ms, fails, label, priority, quarantined_until FROM proxy_pool ORDER BY priority ASC, ok DESC, latency_ms ASC LIMIT ?", limit) as unknown as PoolRow[];
}

// Never leak proxy credentials to API/dashboard consumers — the pool needs
// the full URL, display only needs host:port.
export function maskProxyUrl(url: string): string {
  const m = url.match(/^(https?:\/\/)([^@/\s]+)@(.+)$/i);
  if (!m) return url;
  return `${m[1]}***@${m[3]}`;
}

export function poolStats(): { total: number; healthy: number; checkedAt: number | null } {
  const total = (all("SELECT COUNT(*) AS n FROM proxy_pool") as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  const healthy = (all("SELECT COUNT(*) AS n FROM proxy_pool WHERE ok = 1") as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  const checkedAt = (all("SELECT MAX(last_check) AS m FROM proxy_pool") as unknown as Array<{ m: number | null }>)[0]?.m ?? null;
  return { total, healthy, checkedAt };
}


export async function probeOne(url: string): Promise<number | null> {
  const t0 = Date.now();
  let agent: ProxyAgent | null = null;
  try {
    agent = new ProxyAgent(url);
    // 1) generic tunnel check (tiny, fast)
    const g = await undiciFetch(PROBE_URL, {
      method: "GET",
      dispatcher: agent,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    } as never);
    await g.body?.cancel().catch(() => {});
    // 2) real upstream path: full HTTPS CONNECT + TLS + HTTP to an API host.
    // Free proxies often pass (1) yet die here — only (2) marks healthy.
    // No key is sent; any HTTP status (even 401) proves the tunnel works.
    const z = await undiciFetch("https://opencode.ai/zen/go/v1/models", {
      method: "GET",
      dispatcher: agent,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    } as never);
    await z.body?.cancel().catch(() => {});
    return Date.now() - t0;
  } catch {
    return null;
  } finally {
    await agent?.close().catch(() => {});
  }
}

let inflightProbe: Promise<{ checked: number; healthy: number }> | null = null;

export async function probePool(limit = CHECK_BATCH): Promise<{ checked: number; healthy: number }> {
  // Overlap guard: background loop + admin refresh share one run.
  if (inflightProbe) return inflightProbe;
  inflightProbe = (async () => {
    const stale = Date.now() - STALE_MS;
    const rows = all("SELECT url FROM proxy_pool WHERE last_check IS NULL OR last_check < ? ORDER BY last_check ASC LIMIT ?", stale, limit) as unknown as Array<{ url: string }>;
    let healthy = 0;
    for (const { url } of rows) {
      const ms = await probeOne(url);
      if (ms == null) {
        run("UPDATE proxy_pool SET last_check = ?, ok = 0, fails = fails + 1 WHERE url = ?", Date.now(), url);
      } else {
        healthy += 1;
        run("UPDATE proxy_pool SET last_check = ?, ok = 1, latency_ms = ?, fails = 0, quarantined_until = 0 WHERE url = ?", Date.now(), ms, url);
      }
    }
    // Never auto-prune labeled (private) proxies — the owner removes them by hand.
    const { evictProxyAgent } = await import("./executors/sse.ts");
    const dead = all("SELECT url FROM proxy_pool WHERE fails >= ? AND (label IS NULL OR label = '')", PRUNE_FAILS) as unknown as Array<{ url: string }>;
    for (const { url } of dead) {
      try {
        await evictProxyAgent(url);
      } catch {}
    }
    run("DELETE FROM proxy_pool WHERE fails >= ? AND (label IS NULL OR label = '')", PRUNE_FAILS);
    // Reap long-dead free rows below the prune threshold: a week of ok=0
    // means the IP is gone, not flaky. Labeled rows still never auto-delete.
    const ancient = Date.now() - REAP_DEAD_MS;
    const staleDead = all("SELECT url FROM proxy_pool WHERE ok = 0 AND fails >= ? AND last_check IS NOT NULL AND last_check < ? AND (label IS NULL OR label = '')", MAX_FAILS, ancient) as unknown as Array<{ url: string }>;
    for (const { url } of staleDead) {
      try {
        await evictProxyAgent(url);
      } catch {}
    }
    run("DELETE FROM proxy_pool WHERE ok = 0 AND fails >= ? AND last_check IS NOT NULL AND last_check < ? AND (label IS NULL OR label = '')", MAX_FAILS, ancient);
    return { checked: rows.length, healthy };
  })();
  try {
    return await inflightProbe;
  } finally {
    inflightProbe = null;
  }
}

let roundRobin = 0;

/** Pick a healthy proxy: priority first (private beats free), measured latency next, rotating. Null = pool empty. */
export function pickProxy(): string | null {
  const now = Date.now();
  const rows = all("SELECT url FROM proxy_pool WHERE ok = 1 AND quarantined_until <= ? ORDER BY priority ASC, (latency_ms IS NULL), latency_ms ASC LIMIT 16", now) as unknown as Array<{ url: string }>;
  if (!rows.length) return null;
  const pick = rows[roundRobin % rows.length]?.url ?? null;
  roundRobin += 1;
  return pick;
}

/**
 * Blame a proxy for a failed attempt. Provider-side 429/5xx only quarantine
 * (the tunnel worked; the IP may just be rate-limited) without counting
 * toward prune/death. Transport failures count fully.
 */
export function markProxyBad(url: string, opts?: { prune?: boolean }): void {
  const countTowardPrune = opts?.prune !== false;
  try {
    const row = all("SELECT fails FROM proxy_pool WHERE url = ?", url) as unknown as Array<{ fails: number }>;
    const fails = (row[0]?.fails ?? 0) + (countTowardPrune ? 1 : 0);
    const quarantineMs = Math.min(300_000 * (fails + 1), 7_200_000);
    run("UPDATE proxy_pool SET fails = ?, quarantined_until = ?, ok = CASE WHEN ? >= ? THEN 0 ELSE ok END WHERE url = ?", fails, Date.now() + quarantineMs, fails, MAX_FAILS, url);
  } catch {}
}

export function addProxies(urls: string[], label = ""): number {
  let n = 0;
  for (const url of urls) {
    try {
      run("INSERT INTO proxy_pool(url, source, last_check, ok, latency_ms, fails, label, priority, quarantined_until) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET label=COALESCE(NULLIF(excluded.label,''),label), priority=CASE WHEN excluded.label != '' THEN MIN(priority, 10) ELSE priority END", url, "manual", null, 1, null, 0, label, label ? 10 : 100, 0);
      n += 1;
    } catch {}
  }
  return n;
}
export function removeProxy(url: string): boolean {
  const real = resolveProxyUrl(url);
  try {
    const before = (all("SELECT COUNT(*) AS n FROM proxy_pool WHERE url = ?", real) as unknown as Array<{ n: number }>)[0]?.n ?? 0;
    run("DELETE FROM proxy_pool WHERE url = ?", real);
    if (before > 0) {
      // Release cached sockets; never let eviction failure block removal.
      void import("./executors/sse.ts").then((m) => m.evictProxyAgent(real)).catch(() => {});
    }
    return before > 0;
  } catch {
    return false;
  }
}

/** Map a masked display URL (`http://***@host:port`) back to the stored full URL. */
export function resolveProxyUrl(input: string): string {
  if (!input.includes("***@")) return input;
  const host = input.split("@")[1] ?? "";
  if (!host) return input;
  try {
    const rows = all("SELECT url FROM proxy_pool") as unknown as Array<{ url: string }>;
    const hit = rows.find((r) => r.url.endsWith(`@${host}`));
    return hit?.url ?? input;
  } catch {
    return input;
  }
}
export function setProxyMeta(url: string, meta: { label?: string; priority?: number }): boolean {
  const real = resolveProxyUrl(url);
  try {
    const exists = (all("SELECT COUNT(*) AS n FROM proxy_pool WHERE url = ?", real) as unknown as Array<{ n: number }>)[0]?.n ?? 0;
    if (!exists) return false;
    if (meta.label !== undefined) run("UPDATE proxy_pool SET label = ? WHERE url = ?", meta.label, real);
    if (meta.priority !== undefined && Number.isFinite(meta.priority)) {
      run("UPDATE proxy_pool SET priority = ? WHERE url = ?", Math.max(0, Math.min(1000, Math.floor(meta.priority))), real);
    }
    return true;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Background refresh+probe loop. Safe to call once at boot; no-ops afterwards. */
export function startProxyPool(intervalMs = STALE_MS): void {
  if (timer) return;
  void (async () => {
    try {
      await refreshPool();
      await probePool();
    } catch {
      // pool maintenance must never crash the server
    }
  })();
  timer = setInterval(() => {
    void (async () => {
      try {
        await refreshPool();
        await probePool();
      } catch {
        // ignore
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

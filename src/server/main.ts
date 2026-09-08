// Boot: create default API key if none exists, start the HTTP server, shut down cleanly.
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { DATA_DIR, HOST, PORT } from "../shared/config.ts";
import { closeDb, ensureDefaultKey, upsertPricing } from "../shared/db.ts";
import { startProxyPool } from "../core/proxypool.ts";
import { startHealthRadar } from "../core/health.ts";
const created = ensureDefaultKey();
if (created) {
  process.stderr.write(`rikka master key: ${created.secret}\n`);
  process.stderr.write("  (only its sha256 hash is stored — save the value above now)\n");
}

// Flat-rate pricing (RIKKA_FLAT_PRICING_USD_PER_M, default 0.2): per-model
// rows are ignored entirely — no seed, no lookup. Empty string = legacy table.
import { flatRateUsdPerM } from "../shared/db.ts";
const flat = flatRateUsdPerM();
if (flat !== null) console.log(`pricing: flat $${flat}/1M tokens (per-model rows ignored)`);
else try {
  const ppath = fileURLToPath(new URL("../core/providers/pricing.json", import.meta.url));
  if (existsSync(ppath)) {
    const raw: unknown = JSON.parse(readFileSync(ppath, "utf8"));
    if (Array.isArray(raw)) {
      const rows = raw as Array<{ provider: string; model: string; input: number; output: number; cacheRead?: number }>;
      const n = upsertPricing(rows);
      console.log(`pricing synced: ${n} rows`);
    } else {
      console.warn("pricing seed skipped: pricing.json is not an array");
    }
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("pricing seed skipped:", msg);
}

// Built dashboard: try src/../dist (source layout) then package root dist.
function findStaticRoot(): string | null {
  const candidates = [
    new URL("../../dist/dashboard", import.meta.url),
    new URL("../dist/dashboard", import.meta.url),
  ];
  for (const u of candidates) {
    const dir = fileURLToPath(u);
    if (existsSync(`${dir}/index.html`)) return dir;
  }
  return null;
}
const staticRoot = findStaticRoot();

const server = serve({ fetch: createApp({ staticRoot }).fetch, port: PORT, hostname: HOST });
// Free-proxy pool maintenance (best-effort, never blocks boot).
startProxyPool();
// Upstream health radar (best-effort, never blocks boot).
startHealthRadar();
server.on("listening", () => {
  console.log(`rikka listening on http://${HOST}:${PORT}`);
  console.log(staticRoot ? `dashboard: http://${HOST}:${PORT}/` : "dashboard: not built (npm --prefix dashboard run build)");
  console.log(`rikka data dir: ${DATA_DIR}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`rikka: port ${PORT} already in use — set PORT or stop the other instance`);
  } else {
    console.error(`rikka: server error: ${err.message}`);
  }
  process.exit(1);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`rikka: ${signal} received, shutting down`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Never let a wedged connection keep the process alive.
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

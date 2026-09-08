#!/usr/bin/env node
// rikka CLI — `start` boots the server; data subcommands talk straight to the
// sqlite file via src/shared/db.ts (single schema lives there — this file
// MUST NOT duplicate DDL; it imports db helpers + dbFile() so the CLI and the
// server always use the same database).
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as readline from "node:readline";
import {
  all,
  closeDb,
  createApiKey,
  db,
  deleteAlias,
  deleteApiKey,
  deleteCombo,
  deleteConnection,
  get,
  getCombo,
  keyBudget,
  listAliases,
  listApiKeys,
  listCombos,
  listConnections,
  monthSpendFor,
  putAlias,
  putCombo,
  putConnection,
  run,
  setKeyBudget,
  usageSummary,
} from "../src/shared/db.ts";
import { dbFile } from "../src/shared/config.ts";
import { providerById } from "../src/core/providers/registry.ts";

const DB_FILE = dbFile();
const PORT = Number(process.env.RIKKA_PORT ?? process.env.PORT ?? 20200);

const mask = (k) => {
  const s = String(k ?? "");
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
};
const ts = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") : "-");

function dbMissing() {
  return !existsSync(DB_FILE);
}

function table(header, lines) {
  if (lines.length === 0) {
    console.log("(none)");
    return;
  }
  console.log(header.join("  "));
  for (const l of lines) console.log(l.join("  "));
}

const pad = (v, w) => String(v ?? "-").padEnd(w);
const money = (v) => `$${Number(v ?? 0).toFixed(4)}`;

export function cmdStart() {
  const mainTs = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", mainTs], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

export function cmdProviders(rest) {
  const sub = rest[0];
  if (sub === "list") {
    if (dbMissing()) return console.log(`no database at ${DB_FILE} — run: rikka providers add <provider> <apiKey>`);
    const rs = listConnections();
    table(
      ["ID".padEnd(38), "PROVIDER".padEnd(16), "NAME".padEnd(16), "KEY".padEnd(12), "STATUS".padEnd(9), "PRIO", "COOLDOWN_UNTIL"],
      rs.map((r) => [
        pad(r.id, 38),
        pad(r.provider, 16),
        pad(r.name, 16),
        pad(mask(String(r.api_key)), 12),
        pad(r.status, 9),
        pad(r.priority, 4),
        r.cooldown_until && r.cooldown_until > Date.now() ? ts(r.cooldown_until) : "-",
      ]),
    );
    closeDb();
    return;
  }
  if (sub === "add") {
    const [, provider, apiKey, name] = rest;
    if (!provider || !apiKey) {
      console.error("usage: rikka providers add <provider> <apiKey> [name]");
      process.exit(2);
    }
    const id = randomUUID();
    putConnection({ id, provider, apiKey, name: name ?? "" });
    console.log(`added ${provider} connection ${id} (key ${mask(apiKey)})`);
    closeDb();
    return;
  }
  if (sub === "rm") {
    const id = rest[1];
    if (!id) return console.error("usage: rikka providers rm <id>"), process.exit(2);
    deleteConnection(id);
    console.log(`removed ${id}`);
    closeDb();
    return;
  }
  if (sub === "test") {
    const id = rest[1];
    if (!id) return console.error("usage: rikka providers test <id>"), process.exit(2);
    if (dbMissing()) {
      console.error(`no database at ${DB_FILE} — run: rikka providers add <provider> <apiKey>`);
      process.exit(1);
    }
    const row = get("SELECT id,provider,name,api_key,base_url,status,cooldown_until,last_error FROM connections WHERE id = ?", id);
    if (!row) {
      console.error(`unknown connection: ${id}`);
      process.exit(1);
    }
    console.log(`connection : ${row.id}`);
    console.log(`provider   : ${row.provider}${row.name ? ` (${row.name})` : ""}`);
    console.log(`key        : ${mask(String(row.api_key))}`);
    console.log(`status     : ${row.status}`);
    if (row.cooldown_until && Number(row.cooldown_until) > Date.now()) console.log(`cooldown   : until ${ts(Number(row.cooldown_until))}`);
    if (row.last_error) console.log(`last error : ${row.last_error}`);
    if (row.status === "disabled") {
      console.log("result     : FAIL — connection is disabled");
      closeDb();
      process.exit(1);
    }
    if (!row.base_url) {
      console.log("result     : OK — configured (no base_url to probe for this connection)");
      closeDb();
      return;
    }
    return cmdProvidersTestProbe(String(row.base_url), String(row.api_key ?? ""), String(row.provider));
  }
  console.error("usage: rikka providers <list|add|rm|test>");
  process.exit(2);
}

async function cmdProvidersTestProbe(baseUrl, apiKey, provider) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/models`;
  // Same credential shape as the server-side test route: without auth every
  // probe is meaningless (401 looks like failure either way).
  const headers = {};
  if (apiKey) {
    const style = providerById(provider)?.authStyle;
    if (style === "bearer") headers.authorization = `Bearer ${apiKey}`;
    else headers["x-api-key"] = apiKey;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    console.log(`probe      : GET ${url} -> HTTP ${res.status}`);
    if (res.ok) {
      console.log("result     : OK — reachable and authorized");
    } else if (res.status === 401 || res.status === 403) {
      console.log(`result     : DENIED — reachable but unauthorized (HTTP ${res.status} — check API key)`);
    } else {
      console.log(`result     : WARN — reachable, unexpected HTTP ${res.status} (config kept)`);
    }
  } catch (e) {
    console.log(`probe      : GET ${url} -> unreachable (${e.cause?.message ?? e.message})`);
    console.log("result     : WARN — could not reach endpoint (config kept)");
  } finally {
    clearTimeout(t);
    closeDb();
  }
}

export function cmdKeys(rest) {
  const sub = rest[0];
  if (sub === "add") {
    const name = rest[1] ?? "default";
    const { id, secret } = createApiKey(name);
    console.log(`key id: ${id} (name: ${name})`);
    console.log(`secret: ${secret}`);
    console.log("  store it now — only the sha256 hash is kept in the db");
    closeDb();
    return;
  }
  if (sub === "list") {
    if (dbMissing()) return console.log("(none)");
    const rs = listApiKeys();
    table(
      ["ID".padEnd(14), "NAME".padEnd(12), "CREATED".padEnd(17), "LAST_USED"],
      rs.map((r) => [pad(r.id, 14), pad(r.name, 12), pad(ts(r.created_at), 17), ts(r.last_used_at)]),
    );
    closeDb();
    return;
  }
  if (sub === "rm") {
    const id = rest[1];
    if (!id) return console.error("usage: rikka keys rm <id>"), process.exit(2);
    deleteApiKey(id);
    console.log(`removed ${id}`);
    closeDb();
    return;
  }
  console.error("usage: rikka keys <add|list|rm>");
  process.exit(2);
}

export function cmdAliases(rest) {
  const sub = rest[0];
  if (sub === "list") {
    if (dbMissing()) return console.log("(none)");
    const rs = listAliases();
    table(
      ["ALIAS".padEnd(16), "TARGET"],
      rs.map((r) => [pad(r.alias, 16), r.target]),
    );
    closeDb();
    return;
  }
  if (sub === "set") {
    const [, alias, target] = rest;
    if (!alias || !target) {
      console.error("usage: rikka aliases set <alias> <target>   e.g. rikka aliases set coding deepseek/deepseek-chat");
      process.exit(2);
    }
    putAlias(alias, target);
    console.log(`${alias} -> ${target}`);
    closeDb();
    return;
  }
  if (sub === "rm") {
    const alias = rest[1];
    if (!alias) return console.error("usage: rikka aliases rm <alias>"), process.exit(2);
    deleteAlias(alias);
    console.log(`removed ${alias}`);
    closeDb();
    return;
  }
  console.error("usage: rikka aliases <list|set|rm>");
  process.exit(2);
}

export function cmdCombos(rest) {
  const sub = rest[0];
  if (sub === "list") {
    if (dbMissing()) return console.log("(none)");
    const rs = listCombos();
    table(
      ["NAME".padEnd(20), "STRATEGY".padEnd(10), "ENABLED".padEnd(8), "STEPS"],
      rs.map((r) => {
        let steps = r.steps;
        try {
          const parsed = JSON.parse(String(r.steps));
          steps = Array.isArray(parsed) ? parsed.map((s) => s?.model ?? JSON.stringify(s)).join(", ") : String(r.steps);
        } catch {
          // keep raw
        }
        return [pad(r.name, 20), pad(r.strategy, 10), pad(r.enabled ? "yes" : "no", 8), steps];
      }),
    );
    closeDb();
    return;
  }
  if (sub === "add") {
    // rikka combos add <name> <provider/model> [more...] [--strategy pri|weighted] [--description text]
    const args = rest.slice(1);
    const strategyFlag = args.indexOf("--strategy");
    const descFlag = args.indexOf("--description");
    const strategy = strategyFlag >= 0 ? args[strategyFlag + 1] : "priority";
    const description = descFlag >= 0 ? args[descFlag + 1] ?? "" : "";
    const models = args.filter((a, i) => {
      if (a.startsWith("--")) return false;
      if (strategyFlag >= 0 && (i === strategyFlag + 1)) return false;
      if (descFlag >= 0 && (i === descFlag + 1)) return false;
      return true;
    });
    const name = models[0];
    const picks = models.slice(1);
    if (!name || picks.length === 0) {
      console.error("usage: rikka combos add <name> <provider/model> [more...] [--strategy priority|weighted] [--description text]");
      process.exit(2);
    }
    putCombo({
      id: randomUUID(),
      name,
      description,
      strategy: strategy ?? "priority",
      steps: picks.map((model) => ({ model })),
    });
    console.log(`combo ${name}: ${picks.join(", ")}`);
    closeDb();
    return;
  }
  if (sub === "rm") {
    const ref = rest[1];
    if (!ref) return console.error("usage: rikka combos rm <name|id>"), process.exit(2);
    const found = get("SELECT id FROM combos WHERE id = ? OR name = ?", ref, ref);
    if (!found) {
      console.error(`unknown combo: ${ref}`);
      process.exit(1);
    }
    deleteCombo(String(found.id));
    console.log(`removed ${ref}`);
    closeDb();
    return;
  }
  console.error("usage: rikka combos <list|add|rm>");
  process.exit(2);
}

export function cmdBudget(rest) {
  const sub = rest[0];
  if (sub === "get") {
    const id = rest[1];
    if (!id) return console.error("usage: rikka budget get <keyId>"), process.exit(2);
    if (dbMissing()) {
      console.error(`no database at ${DB_FILE}`);
      process.exit(1);
    }
    const b = keyBudget(id);
    if (!b) {
      console.error(`unknown key: ${id}`);
      process.exit(1);
    }
    const spend = monthSpendFor(id);
    console.log(`key     : ${id}`);
    console.log(`budget  : ${b.budget == null ? "(none)" : money(b.budget)} / month`);
    console.log(`spent   : ${money(spend)} (this month)`);
    if (b.budget != null) console.log(`remain  : ${money(Number(b.budget) - spend)}`);
    closeDb();
    return;
  }
  if (sub === "set") {
    const [, id, raw] = rest;
    if (!id || raw === undefined) {
      console.error("usage: rikka budget set <keyId> <usd|none>");
      process.exit(2);
    }
    const usd = /^(none|null|clear)$/i.test(raw) ? null : Number(raw);
    if (usd !== null && !(Number.isFinite(usd) && usd >= 0)) {
      console.error("budget must be a non-negative number of USD, or 'none' to clear");
      process.exit(2);
    }
    setKeyBudget(id, usd);
    console.log(usd === null ? `cleared budget for ${id}` : `budget for ${id}: ${money(usd)} / month`);
    closeDb();
    return;
  }
  console.error("usage: rikka budget <get|set> <keyId> [usd]");
  process.exit(2);
}

export function cmdUsage(rest) {
  const hi = rest.indexOf("--hours");
  const hours = hi >= 0 && Number(rest[hi + 1]) > 0 ? Number(rest[hi + 1]) : 24;
  if (dbMissing()) return console.log("(no data yet)");
  const since = Date.now() - hours * 3_600_000;
  const t = all(
    `SELECT COUNT(*) n, COALESCE(SUM(ok),0) ok_n, COALESCE(SUM(input_tokens),0) inp,
            COALESCE(SUM(output_tokens),0) outp, COALESCE(SUM(cached_tokens),0) cached,
            COALESCE(SUM(cost_usd),0) cost
     FROM usage WHERE ts >= ?`,
    since,
  )[0] ?? {};
  console.log(`usage — last ${hours}h`);
  console.log(`  requests : ${t.n ?? 0}  (ok ${t.ok_n ?? 0} / fail ${(t.n ?? 0) - (t.ok_n ?? 0)})`);
  console.log(`  tokens   : in ${t.inp ?? 0}  out ${t.outp ?? 0}  cached ${t.cached ?? 0}`);
  console.log(`  cost     : ${money(t.cost ?? 0)}`);
  const byP = usageSummary(since);
  if (byP.length > 0) {
    console.log("  by model:");
    for (const r of byP) {
      console.log(`    ${pad(`${r.provider}/${r.model}`, 40)} n=${pad(r.n, 6)} in=${pad(r.inp, 9)} out=${pad(r.outp, 9)} cost=${money(r.cost ?? 0)}`);
    }
  }
  closeDb();
}

function requestLogColumns() {
  const cols = new Set();
  for (const r of all("PRAGMA table_info(request_log)")) cols.add(String(r.name));
  return cols;
}

export function cmdLogs(rest) {
  const ki = rest.indexOf("--key");
  const keyId = ki >= 0 ? rest[ki + 1] : null;
  const li = rest.indexOf("--limit");
  const limit = li >= 0 && Number(rest[li + 1]) > 0 ? Math.floor(Number(rest[li + 1])) : 100;
  const di = rest.indexOf("--download");
  const outFile = di >= 0 ? rest[di + 1] : null;
  if (di >= 0 && !outFile) {
    console.error("usage: rikka logs [--key ID] [--limit N] [--download out.jsonl]");
    process.exit(2);
  }
  if (dbMissing()) return console.log("(no data yet)");
  const cols = requestLogColumns();
  const hasKey = cols.has("key_id");
  const extra = ["provider", "model", "combo", "key_id", "tokens_in", "tokens_out", "cost_usd", "error"].filter((c) => cols.has(c));
  let where = "";
  const params = [];
  if (keyId) {
    if (hasKey) {
      where = "WHERE key_id = ?";
      params.push(keyId);
    } else {
      // pre-migration schema has no key column — match the raw line instead
      where = "WHERE line LIKE ?";
      params.push(`%${keyId}%`);
    }
  }
  const rows = all(`SELECT * FROM request_log ${where} ORDER BY seq DESC LIMIT ?`, ...params, limit);
  if (outFile) {
    if (String(outFile).endsWith(".csv")) {
      const heads = rows.length > 0 ? Object.keys(rows[0]) : ["seq", "ts", "method", "path", "status", "dur_ms", "line", ...extra];
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      writeFileSync(outFile, [heads.join(","), ...rows.map((r) => heads.map((h) => esc(r[h])).join(","))].join("\n") + "\n");
    } else {
      writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""));
    }
    console.log(`wrote ${rows.length} rows to ${outFile}`);
    closeDb();
    return;
  }
  if (rows.length === 0) return console.log("(no data yet)"), closeDb();
  const head = ["SEQ".padEnd(6), "TIME".padEnd(17), "METHOD".padEnd(7), "PATH".padEnd(32), "STATUS".padEnd(7), "MS".padEnd(7)];
  if (extra.includes("provider")) head.push("PROVIDER".padEnd(14));
  if (extra.includes("model")) head.push("MODEL".padEnd(24));
  if (extra.includes("key_id")) head.push("KEY".padEnd(14));
  table(
    head,
    rows.map((r) => {
      const line = [pad(r.seq, 6), pad(ts(Number(r.ts)), 17), pad(r.method, 7), pad(String(r.path).slice(0, 32), 32), pad(r.status, 7), pad(r.dur_ms, 7)];
      if (extra.includes("provider")) line.push(pad(r.provider, 14));
      if (extra.includes("model")) line.push(pad(String(r.model ?? "-").slice(0, 24), 24));
      if (extra.includes("key_id")) line.push(pad(r.key_id ?? "-", 14));
      return line;
    }),
  );
  closeDb();
}

export async function cmdStatus() {
  const dbExists = existsSync(DB_FILE);
  console.log(`db      : ${DB_FILE} ${dbExists ? "(found)" : "(missing — run: rikka providers add …)"}`);
  let health = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) health = await res.json();
  } catch {
    // down
  }
  if (health?.ok) {
    console.log(`server  : up — rikka ${health.version ?? "?"} @ http://127.0.0.1:${PORT}`);
  } else {
    console.log(`server  : down (nothing answering on 127.0.0.1:${PORT})`);
  }
}
export async function cmdConnect(rest) {
  const provider = rest[0];
  if (!provider) {
    console.error("usage: rikka connect <provider>\n  e.g. rikka connect claude   — opens browser for OAuth\n       rikka connect github   — device code flow");
    process.exit(2);
  }
  if (provider === "-h" || provider === "--help" || provider === "help") {
    console.log("usage: rikka connect <provider>\n  e.g. rikka connect claude   — opens browser for OAuth\n       rikka connect github   — device code flow\n  Provider ids live on the dashboard Providers page (OAuth-capable only).");
    return;
  }
  const base = `http://127.0.0.1:${PORT}`;
  // check server health first
  try {
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error();
  } catch {
    console.error(`rikka server not running on ${base} — run: rikka start`);
    process.exit(1);
  }
  // check provider exists in registry. /api/registry needs dashboard auth, so
  // an unreadable registry must NOT block: the server re-validates on begin.
  let connectable = [];
  try {
    const reg = await fetch(`${base}/api/registry`).then((r) => r.json());
    if (Array.isArray(reg.providers)) {
      const found = reg.providers.find((p) => p.id === provider);
      connectable = reg.providers.filter((p) => !p.requiresMitm).map((p) => p.id);
      if (!found) {
        console.error(`unknown provider: ${provider}\navailable: ${connectable.slice(0, 12).join(", ")} …`);
        process.exit(2);
      }
      if (found.requiresMitm) {
        // MITM-gated providers (cursor/windsurf/trae/zed) are hidden from the
        // connect list: offering OAuth for them would pretend it can work.
        console.error(`provider "${provider}" requires MITM proxy capture — not supported via OAuth. Use API key: rikka providers add ${provider} <apiKey>`);
        process.exit(2);
      }
    }
  } catch {}
  try {
    // For code-flow providers without a built-in redirectPort (claude etc) the
    // server requires an explicit redirectUri; use a loopback placeholder that
    // the user can copy back as a full redirect URL (paste-code flow).
    const redirectUri = "http://127.0.0.1:9784/callback";
    const r = await fetch(`${base}/api/oauth/${provider}/begin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirectUri }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message ?? JSON.stringify(j));
    begin = j;
  } catch (e) {
    const msg = (e).message;
    const hint = msg.includes("unknown oauth provider") ? (connectable.length ? `\navailable: ${connectable.slice(0, 12).join(", ")} …` : "\n(valid OAuth provider ids are listed on the dashboard Providers page)") : "";
    console.error(`begin failed: ${msg}${hint}`);
    process.exit(1);
  }
  if (begin.flow === "device") {
    const uri = begin.verificationUri ?? begin.verificationUriComplete ?? begin.url ?? "";
    const code = begin.userCode ?? "";
    console.log(`\nDevice flow — open this URL and enter code:\n  ${uri}\n  code: ${code}\n`);
    // try to open browser
    try {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawnSync(cmd, [uri], { stdio: "ignore" });
    } catch {}
    console.log("Polling for completion (Ctrl+C to cancel)...");
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, (begin.interval ?? 5) * 1000));
      try {
        const pr = await fetch(`${base}/api/oauth/${provider}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: begin.session }) });
        const pj = await pr.json();
        if (pj.status === "pending") {
          process.stdout.write(".");
          continue;
        }
        if (pr.ok && pj.ok) {
          console.log(`\n✓ connected ${provider} as ${pj.id}`);
          return;
        }
        throw new Error(pj.error?.message ?? JSON.stringify(pj));
      } catch (e) {
        if (String(e.message).includes("pending")) continue;
        console.error(`\npoll failed: ${e.message}`);
        process.exit(1);
      }
    }
    console.error("\ntimed out — run again");
    process.exit(1);
  } else {
    const url = begin.url;
    console.log(`\nOpen this URL in your browser to authorize:\n  ${url}\n`);
    try {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawnSync(cmd, [url], { stdio: "ignore" });
      console.log("(tried to open browser automatically)");
    } catch {}
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise((resolve) => rl.question("Paste the authorization code (or full redirect URL) here: ", (ans) => { rl.close(); resolve(ans.trim()); }));
    if (!code) { console.error("no code provided"); process.exit(2); }
    // extract code param if user pasted full URL
    let authCode = code;
    try {
      if (code.includes("code=")) {
        const u = new URL(code);
        authCode = u.searchParams.get("code") ?? code;
      }
    } catch {}
    try {
      const er = await fetch(`${base}/api/oauth/${provider}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: authCode, session: begin.session }) });
      const ej = await er.json();
      if (!er.ok) throw new Error(ej.error?.message ?? JSON.stringify(ej));
      console.log(`✓ connected ${provider} as ${ej.id}${ej.email ? ` (${ej.email})` : ""}`);
    } catch (e) {
      console.error(`exchange failed: ${e.message}`);
      process.exit(1);
    }
  }
}

export function usage() {
  console.log(`rikka — local AI router

usage:
  rikka start                                boot gateway on :${PORT}
  rikka providers <list|add|rm|test>         manage provider connections (test <id> probes it)
  rikka keys <add|list|rm>                   manage client API keys (rk_…)
  rikka aliases <list|set|rm>                manage model aliases
  rikka combos <list|add|rm>                 manage combos (add <name> <provider/model> […])
  rikka budget <get|set> <keyId> [usd]       per-key monthly budget (set … none clears)
  rikka usage [--hours N]                    token + success + cost totals
  rikka logs [--key ID] [--limit N] [--download out.jsonl|.csv]
                                             query request log (newest first)
  rikka status                               db + server health
  rikka connect <provider>                   OAuth browser/device flow (19 providers)
`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "start":
      cmdStart();
      break;
    case "providers":
      await cmdProviders(rest);
      break;
    case "keys":
      cmdKeys(rest);
      break;
    case "aliases":
      cmdAliases(rest);
      break;
    case "combos":
      cmdCombos(rest);
      break;
    case "budget":
      cmdBudget(rest);
      break;
    case "usage":
      cmdUsage(rest);
      break;
    case "logs":
      cmdLogs(rest);
      break;
    case "status":
      await cmdStatus();
      break;
    case "connect":
      await cmdConnect(rest);
      break;
    case undefined:
    case "help":
    case "--help":
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

const invokedAsMain =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) await main(process.argv.slice(2));

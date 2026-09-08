<script lang="ts">
  // SCREEN — Status (§34). Global state from health() + live connections; the uptime
  // strip renders only real request-log data (§38 honesty): no fabricated percentages,
  // no invented history. Longer history arrives with usage rollups (Phase 6).
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, type Connection, type Health, type UsageRow, type LogRow, type RegistryProvider } from "../lib/api.ts";
  import { compact, pct, time, timeShort } from "../lib/format.ts";
  import { go } from "../lib/nav.ts";

  let hb = $state<Health | null>(null);
  let conns = $state<Connection[]>([]);
  let usages = $state<UsageRow[]>([]);
  let logs = $state<LogRow[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let upstreams = $state<Array<{ target: string; ts: number; ok: number; latency_ms: number | null; status: number | null; error: string | null }>>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);
  let now = $state(Date.now());

  const byId = $derived(new Map(registry.map((p) => [p.id, p])));

  const totalReqs = $derived(usages.reduce((s, u) => s + u.n, 0));
  const okReqs = $derived(usages.reduce((s, u) => s + (u.ok_n ?? 0), 0));
  const activeN = $derived(conns.filter((c) => c.status === "active").length);

  // Global line: Operational / Degraded / Standby (offline when the server is unreachable).
  const global = $derived.by(() => {
    if (err || !hb?.ok) return { cls: "bad" as const, label: "Offline", note: err ? `server unreachable: ${err}` : "health endpoint reported failure" };
    if (conns.length === 0) return { cls: "muted" as const, label: "Standby", note: "router running · no providers connected" };
    if (activeN === conns.length) return { cls: "ok" as const, label: "Operational", note: `${conns.length} connections active` };
    if (activeN > 0) return { cls: "warn" as const, label: "Degraded", note: `${conns.length - activeN} of ${conns.length} connections impaired` };
    return { cls: "bad" as const, label: "Degraded", note: "no connection is currently active" };
  });

  // Provider matrix: one row per connected provider, worst connection status wins.
  const matrix = $derived.by(() => {
    const map = new Map<string, Connection[]>();
    for (const c of conns) {
      const list = map.get(c.provider);
      if (list) list.push(c);
      else map.set(c.provider, [c]);
    }
    return [...map.entries()]
      .map(([id, list]) => {
        const status = list.some((c) => c.status === "active")
          ? "active"
          : list.some((c) => c.status === "cooldown")
            ? "cooldown"
            : "disabled";
        const withErr = list.filter((c) => c.last_error);
        const cdUntil = status === "cooldown" ? Math.max(...list.map((c) => c.cooldown_until)) : 0;
        const u = usages.filter((x) => x.provider === id);
        const n = u.reduce((s, x) => s + x.n, 0);
        const ok = u.reduce((s, x) => s + (x.ok_n ?? 0), 0);
        return {
          id,
          name: byId.get(id)?.name ?? id,
          priority: byId.get(id)?.priority ?? 999,
          count: list.length,
          status,
          lastError: withErr.length ? withErr[0]!.last_error : null,
          cooldownMs: Math.max(0, cdUntil - now),
          n,
          okRatio: n ? ok / n : null,
        };
      })
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  });

  // Real-traffic "uptime" strip: last 6h of /v1 requests bucketed by hour.
  const bars = $derived.by(() => {
    const hour = 3_600_000;
    const out = Array.from({ length: 6 }, (_, i) => ({
      ts: now - (5 - i) * hour,
      n: 0,
      bad: 0,
    }));
    for (const l of logs) {
      if (!l.path.startsWith("/v1")) continue;
      const back = Math.floor((now - l.ts) / hour);
      if (back >= 0 && back < 6) {
        const b = out[5 - back]!;
        b.n += 1;
        if (l.status >= 400) b.bad += 1;
      }
    }
    const max = Math.max(1, ...out.map((b) => b.n));
    return { cells: out.map((b) => ({ ...b, h: b.n ? Math.max(14, Math.round((b.n / max) * 100)) : 6 })), traffic: out.some((b) => b.n > 0) };
  });
  // Uptime SLA from the request log only: share of /v1 without a 5xx/499.
  // 4xx counts as served (client error, not an outage). No synthetic probing.
  const sla = $derived.by(() => {
    const rows = logs.filter((l) => l.path.startsWith("/v1"));
    const bad = rows.filter((l) => l.status >= 500 || l.status === 499).length;
    return { n: rows.length, bad, ratio: rows.length ? (rows.length - bad) / rows.length : null };
  });
  // Incident history = ERROR-level entries in the current buffer, newest first.
  const incidents = $derived(
    logs
      .filter((l) => l.status >= 500 || l.status === 499)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20),
  );

  function cdLabel(msLeft: number): string {
    if (msLeft <= 0) return "—";
    const s = Math.ceil(msLeft / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  async function refresh() {
    try {
      const [h, c, u, l, r] = await Promise.all([api.health(), api.connections(), api.usage(24), api.logs(400), api.registry()]);
      hb = h;
      try {
        upstreams = (await api.upstreamHealth()).targets;
      } catch {}
      conns = c.providers;
      usages = u.rows;
      logs = l.rows;
      registry = r.providers;
      err = null;
      now = Date.now();
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }
  async function checkNow() {
    try {
      upstreams = (await api.checkUpstreams()).targets as typeof upstreams;
    } catch {}
  }
  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    refresh();
    timer = setInterval(refresh, 4000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Status</h1>
    <p class="sub">
      {#if !booted}
        querying router…
      {:else}
        {hb?.name ?? "rikka router"} · polled every 4s · {totalReqs ? `${compact(totalReqs)} requests routed in 24h` : "no traffic in 24h"}
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton sk-top"></div>
{:else}
  <div class="top-row">
    <Panel class="global">
      <div class="up">
        <span class="upv" class:ok={global.cls === "ok"} class:warn={global.cls === "warn"} class:bad={global.cls === "bad"} class:muted={global.cls === "muted"}>{global.label}</span>
        <span class="upl">{global.note}</span>
      </div>
      <div class="meta">
        <span class="vchip" title="server version">v{hb?.version ?? "—"}</span>
        <span class="m-item"><Icon name="providers" size={12} /> {matrix.length ? `${activeN}/${conns.length} connections active` : "0 connections"}</span>
        <span class="m-item"><Icon name="requests" size={12} /> {totalReqs ? `${compact(totalReqs)} req · ${pct(totalReqs ? okReqs / totalReqs : null)} ok · 24h` : "0 req · 24h"}</span>
      </div>
    </Panel>
    <Panel title="Failover" sub="routing policy">
      <div class="fo">
        <StatusPill tone="ok" label="automatic failover armed" pulse={activeN > 0} />
        <p>Impaired connections cool down and traffic reroutes to the next healthy provider without operator action.</p>
      </div>
    </Panel>
  </div>

  <Panel title="Upstream Radar" sub="read-only liveness probes · refreshes every 5 min">
    {#if !upstreams.length}
      <p class="dim-note">No probe data yet — the radar runs at boot and every 5 minutes.</p>
    {:else}
      <ul class="radar">
        {#each upstreams as u (u.target)}
          <li><span class="mono">{u.target}</span><span class={u.ok ? "ok" : "bad"}>{u.ok ? `up${u.latency_ms != null ? ` · ${u.latency_ms}ms` : ""}` : `down${u.error ? ` · ${u.error}` : ""}`}</span></li>
        {/each}
      </ul>
    {/if}
    <div class="row"><Button variant="secondary" onclick={() => void checkNow()}>Probe now</Button></div>
  </Panel>

  <Panel title="Provider Matrix" sub="one row per connected provider" pad={false}>
    {#if matrix.length === 0}
      <EmptyState
        title="Nothing to report"
        desc="No providers connected, so there is no infrastructure status to show. Connect a provider to bring it online here."
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => go("/providers")}><Icon name="bolt" size={13} /> Connect Provider</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <table class="tbl">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th class="r">Cooldown</th>
            <th class="r">Requests 24h</th>
            <th class="r">Success</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {#each matrix as g (g.id)}
            <tr>
              <td>
                <span class="pname">{g.name}</span>
                {#if g.count > 1}<span class="cnt" title="{g.count} connections">×{g.count}</span>{/if}
              </td>
              <td>
                <StatusPill
                  tone={g.status === "active" ? "ok" : g.status === "cooldown" ? "warn" : "bad"}
                  label={g.status === "cooldown" ? "in cooldown" : g.status}
                />
              </td>
              <td class="r mono {g.cooldownMs ? 'warn-t' : 'dim'}">{cdLabel(g.cooldownMs)}</td>
              <td class="r mono">{g.n ? compact(g.n) : "—"}</td>
              <td class="r mono {g.okRatio == null ? 'dim' : g.okRatio >= 0.99 ? 'ok-t' : g.okRatio >= 0.9 ? 'warn-t' : 'bad-t'}">{pct(g.okRatio)}</td>
              <td>
                {#if g.lastError}
                  <span class="lerr mono" title={g.lastError}>{g.lastError}</span>
                {:else}
                  <span class="dim">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Panel>

  <div class="hist-wrap">
    <Panel title="Request Health" sub="last 6h · logged /v1 requests per hour">
      {#if !bars.traffic}
        <EmptyState
          title="No traffic recorded yet"
          desc="There are no /v1 requests in the log window. Status history can only be built from real traffic — send a routed request and the bars appear."
        >
          {#snippet action()}
            <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Re-check</Button>
          {/snippet}
        </EmptyState>
      {:else}
        <div class="strip" role="img" aria-label="Requests per hour over the last 6 hours, colored by failure rate">
          {#each bars.cells as b (b.ts)}
            {@const badRatio = b.n ? b.bad / b.n : 0}
            <div class="cell">
              <span class="cn">{b.n || ""}</span>
              <span class="bar" class:empty={b.n === 0} class:ok={b.n > 0 && badRatio === 0} class:warn={b.n > 0 && badRatio > 0 && badRatio < 0.1} class:bad={b.n > 0 && badRatio >= 0.1} style="height:{b.h}%" title="{timeShort(b.ts)} · {b.n} req · {b.bad} failed"></span>
              <span class="cl">{timeShort(b.ts)}</span>
            </div>
          {/each}
        </div>
        <p class="foot">
          <span class="lk"><i class="d ok-bg"></i>clean</span>
          <span class="lk"><i class="d warn-bg"></i>some failures</span>
          <span class="lk"><i class="d bad-bg"></i>degraded</span>
          <span class="note">14-day uptime requires persistence — longer history arrives with usage rollups (Phase 6). Bars above reflect only the current request log.</span>
        </p>
      {/if}
    </Panel>
  </div>
  <div class="hist-wrap">
    <Panel title="Uptime SLA" sub="share of /v1 without a 5xx · from the request log buffer">
      {#if sla.ratio == null}
        <EmptyState
          title="No /v1 traffic in the buffer"
          desc="SLA is computed from real logged requests only — send a routed request and the percentage appears. Nothing is estimated or probed."
        />
      {:else}
        <div class="sla">
          <span class="slav">{pct(sla.ratio, 2)}</span>
          <span class="slan">{sla.n - sla.bad} of {sla.n} requests served without a 5xx · {sla.bad} errors in buffer</span>
        </div>
        <p class="foot"><span class="note">4xx counts as served (client error, not an outage). No synthetic probing — longer history arrives with usage rollups (Phase 6).</span></p>
      {/if}
    </Panel>
  </div>

  <div class="hist-wrap">
    <Panel title="Incident history" sub="ERROR-level entries (5xx / 499) · newest first" pad={false}>
      {#if !incidents.length}
        <EmptyState
          title="No incidents in the current buffer"
          desc="Any 5xx or dropped (499) request lands here with its stored line. The buffer is empty of errors right now."
        />
      {:else}
        <table class="tbl">
          <thead><tr><th>Time</th><th>Request</th><th class="r">Status</th><th>Stored line</th></tr></thead>
          <tbody>
            {#each incidents as l (l.seq)}
              <tr>
                <td class="mono dim">{time(l.ts)}</td>
                <td class="mono">{l.method} {l.path}</td>
                <td class="r mono bad-t">{l.status}</td>
                <td><span class="lerr" title={l.line}>{l.line}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </Panel>
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .sub {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--color-ink-muted);
  }
  .hdr-actions {
    display: flex;
    gap: 8px;
  }
  .top-row {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr);
    gap: 12px;
    margin-bottom: 14px;
    align-items: stretch;
  }
  :global(.global) {
    justify-content: center;
  }
  .up {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .upv {
    font-size: 34px;
    font-weight: 700;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    line-height: 1.05;
  }
  .upv.ok { color: var(--color-ok); }
  .upv.warn { color: var(--color-warn); }
  .upv.bad { color: var(--color-bad); }
  .upv.muted { color: var(--color-ink-muted); }
  .upl {
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--color-edge);
  }
  .vchip {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--color-pink-soft);
    border: 1px solid rgba(255, 22, 140, 0.35);
    border-radius: 999px;
    padding: 2px 9px;
  }
  .m-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--color-ink-muted);
  }
  .fo {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .fo p {
    margin: 0;
    font-size: 12px;
    color: var(--color-ink-muted);
    line-height: 1.5;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .tbl th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-ink-faint);
    font-weight: 600;
    padding: 9px 16px;
    border-bottom: 1px solid var(--color-edge);
  }
  .tbl td {
    padding: 7px 16px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
    color: var(--color-ink-soft);
    vertical-align: middle;
  }
  .tbl tr:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .pname {
    color: var(--color-ink);
    font-weight: 600;
    font-size: 12.5px;
  }
  .cnt {
    display: inline-block;
    margin-left: 7px;
    font-size: 10px;
    font-weight: 600;
    color: var(--color-ink-muted);
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    border-radius: 999px;
    padding: 1px 6px;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .r {
    text-align: right;
  }
  .dim {
    color: var(--color-ink-faint);
  }
  .ok-t { color: var(--color-ok); }
  .warn-t { color: var(--color-warn); }
  .bad-t { color: var(--color-bad); }
  .lerr {
    display: block;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-bad);
    opacity: 0.9;
  }
  .sla { display:flex; align-items:baseline; gap:12px; padding:4px 0; }
  .slav { font-size:30px; font-weight:700; letter-spacing:-0.01em; color:var(--color-ok); }
  .slan { font-size:12px; color:var(--color-ink-muted); }
  .hist-wrap {
    margin-top: 14px;
  }
  .strip {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    height: 96px;
    padding-top: 4px;
  }
  .cell {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    min-width: 0;
    gap: 4px;
  }
  .cn {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-ink-faint);
    height: 11px;
  }
  .bar {
    width: 100%;
    max-width: 44px;
    border-radius: var(--radius-ctl);
    transition: height var(--dur-panel) var(--ease-out);
  }
  .bar.empty { background: var(--color-elevated); border: 1px dashed var(--color-edge-strong); }
  .bar.ok { background: var(--color-ok); }
  .bar.warn { background: var(--color-warn); }
  .bar.bad { background: var(--color-bad); }
  .cl {
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--color-ink-faint);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 12px 0 0;
    padding-top: 10px;
    border-top: 1px solid var(--color-edge);
    font-size: 11px;
    color: var(--color-ink-faint);
  }
  .lk {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--color-ink-muted);
  }
  .d {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .ok-bg { background: var(--color-ok); }
  .warn-bg { background: var(--color-warn); }
  .bad-bg { background: var(--color-bad); }
  .note {
    flex: 1;
    min-width: 220px;
  }
  .skeleton {
    background: linear-gradient(180deg, var(--color-raised), var(--color-elevated));
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-panel);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
    margin-bottom: 14px;
  }
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .sk-top {
    height: 150px;
  }
  @media (max-width: 1100px) {
    .top-row { grid-template-columns: 1fr; }
  }
  .radar { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .radar li { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; }
  .ok { color: var(--color-ok); }
  .bad { color: var(--color-bad); }
  .dim-note { font-size: 11px; color: var(--color-ink-faint); }
  .row { display: flex; gap: 8px; margin-top: 10px; }
</style>

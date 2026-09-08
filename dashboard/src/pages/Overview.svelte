<script lang="ts">
  // SCREEN 01 — Overview (§10-§15, §54-§55). Control room, not marketing.
  // Real data only: usage / logs / registry / connections / pricing.
  // Cost = server row cost ?? pricing × tokens. Trends = second half vs first
  // half of the visible window, labelled honestly. Failover is derived from
  // cooldown connection state; per-request tokens/cost columns are omitted
  // because the log API does not expose them — never mocked.
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import KpiCard from "../components/KpiCard.svelte";
  import RouterCore from "../components/RouterCore.svelte";
  import type { FlowProvider, RouterState, FailoverEvent } from "../components/flow-types.ts";
  import LineChart from "../components/LineChart.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Button from "../components/Button.svelte";
  import { api, getPricing, type Connection, type UsageRow, type LogRow, type RegistryProvider, type PricingRow } from "../lib/api.ts";
  import { compact, num, ms, pct, time, timeShort, fmtUSD } from "../lib/format.ts";
  import { rowCost } from "../lib/cost.ts";
  import { go } from "../lib/nav.ts";

  type UsageExt = UsageRow & { cost?: number | null; cost_usd?: number | null };

  let conns = $state<Connection[]>([]);
  let usages = $state<UsageExt[]>([]);
  let logs = $state<LogRow[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let pricing = $state<PricingRow[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);

  const connected = $derived(new Set(conns.map((c) => c.provider)));
  const totalReqs = $derived(usages.reduce((s, u) => s + u.n, 0));
  const totalIn = $derived(usages.reduce((s, u) => s + (u.inp ?? 0), 0));
  const totalOut = $derived(usages.reduce((s, u) => s + (u.outp ?? 0), 0));
  const okReqs = $derived(usages.reduce((s, u) => s + (u.ok_n ?? 0), 0));
  const failedReqs = $derived(Math.max(0, totalReqs - okReqs));
  const avgLat = $derived(
    (() => {
      const withLat = usages.filter((u) => u.avg_ms != null && u.n > 0);
      if (!withLat.length) return null;
      return withLat.reduce((s, u) => s + u.avg_ms! * u.n, 0) / withLat.reduce((s, u) => s + u.n, 0);
    })(),
  );
  const errorRate = $derived(totalReqs ? 1 - okReqs / totalReqs : null);
  const rps = $derived(logs.filter((l) => l.path.startsWith("/v1") && Date.now() - l.ts < 60_000).length);

  // ── cost: shared rowCost (server row cost first, pricing × tokens fallback) ──
  const costRows = $derived(usages.map((u) => rowCost(u, pricing)));
  const costKnown = $derived(costRows.some((c) => c != null));
  const totalCost = $derived(costRows.reduce<number | null>((s, c) => (c == null ? s : (s ?? 0) + c), null));
  const avgCostPerReq = $derived(totalCost != null && totalReqs ? totalCost / totalReqs : null);
  // stable formatters for KpiCard count-ups (stable identity ⇒ tween restarts only on real deltas)
  function fmtCount(n: number): string {
    return compact(Math.round(n));
  }
  function fmtPct1(n: number): string {
    return pct(n);
  }
  // ── spend-pulse: bumped once per poll where the average $/req actually rose ──
  let avgPing = $state(0);
  let prevAvg: number | null = null;
  $effect(() => {
    const a = avgCostPerReq;
    const p = prevAvg;
    prevAvg = a;
    if (a != null && p != null && a > p) avgPing += 1;
  });

  // ── buckets: 12 slots over last 6h, from the request log ──
  const buckets = $derived.by(() => {
    const span = 6 * 3_600_000;
    const slot = span / 12;
    const now = Date.now();
    const labels = Array.from({ length: 12 }, (_, i) => now - span + (i + 0.5) * slot);
    const reqs = new Array<number>(12).fill(0);
    const errN = new Array<number>(12).fill(0);
    const latSum = new Array<number>(12).fill(0);
    const latN = new Array<number>(12).fill(0);
    for (const l of logs) {
      if (!l.path.startsWith("/v1")) continue;
      const back = Math.floor((now - l.ts) / slot);
      if (back >= 0 && back < 12) {
        const i = 11 - back;
        reqs[i] = (reqs[i] ?? 0) + 1;
        if (l.status >= 400) errN[i] = (errN[i] ?? 0) + 1;
        latSum[i] = (latSum[i] ?? 0) + l.dur_ms;
        latN[i] = (latN[i] ?? 0) + 1;
      }
    }
    const lat = latSum.map((s, i) => ((latN[i] ?? 0) ? s / (latN[i] ?? 1) : 0));
    const errR = reqs.map((r, i) => (r ? (errN[i] ?? 0) / r : 0));
    // Cost over time: request volume allocated at the window's average $/req.
    // Stated as allocation, not metering — per-request cost is not in the log API.
    const cost = reqs.map((r) => (avgCostPerReq != null ? r * avgCostPerReq : 0));
    return { labels, reqs, lat, errR, cost };
  });

  // ── trends: second half vs first half, labelled with the range ──
  function halfTrend(a: number[]): number | null {
    const h = Math.floor(a.length / 2);
    const f = a.slice(0, h).reduce((s, v) => s + v, 0);
    const s = a.slice(h).reduce((s, v) => s + v, 0);
    if (!Number.isFinite(f) || !Number.isFinite(s) || f === 0) return null;
    return (s - f) / Math.abs(f);
  }
  function fmtTrend(t: number | null): string | null {
    if (t == null || !Number.isFinite(t)) return null;
    return `${t >= 0 ? "+" : ""}${(t * 100).toFixed(1)}%`;
  }
  const trendReqs = $derived(fmtTrend(halfTrend(buckets.reqs)));
  const trendLat = $derived(fmtTrend(halfTrend(buckets.lat)));
  const trendErr = $derived(fmtTrend(halfTrend(buckets.errR)));
  const trendCost = $derived(costKnown ? fmtTrend(halfTrend(buckets.cost)) : null);
  const trendRange = "vs prior 3h";

  // ── RouterCore nodes: unique providers, traffic weight from 24h usage ──
  const flowProviders = $derived.by<FlowProvider[]>(() => {
    const byProv = new Map<string, { n: number; lat: number | null }>();
    for (const u of usages) {
      const cur = byProv.get(u.provider) ?? { n: 0, lat: null };
      cur.n += u.n;
      cur.lat = u.avg_ms ?? cur.lat;
      byProv.set(u.provider, cur);
    }
    const maxN = Math.max(1, ...[...byProv.values()].map((v) => v.n));
    const seen = new Set<string>();
    return conns
      .filter((c) => (seen.has(c.provider) ? false : (seen.add(c.provider), true)))
      .slice(0, 7)
      .map((c) => {
        const st = byProv.get(c.provider);
        const u = registry.find((r) => r.id === c.provider);
        return {
          id: c.provider,
          name: u?.name ?? c.provider,
          status: c.status === "cooldown" ? "cooldown" : !st ? "idle" : "healthy",
          latency: st?.lat ?? null,
          weight: st ? st.n / maxN : 0,
        } satisfies FlowProvider;
      });
  });

  // ── router state (§11-§12): explicit aggregate of connection health + load ──
  const routerState = $derived.by<RouterState>(() => {
    if (!conns.length) return "normal";
    if (conns.every((c) => c.status !== "active")) return "failure";
    if (conns.some((c) => c.status === "cooldown")) return "degraded";
    if (rps >= 20) return "high-traffic";
    return rps > 0 ? "active" : "normal";
  });

  // ── failover moment: derived from cooldown state, honest when absent ──
  const failover = $derived.by<FailoverEvent | null>(() => {
    const cold = conns.filter((c) => c.status === "cooldown");
    if (!cold.length) return null;
    const from = cold[0]!;
    const to = conns.find((c) => c.status === "active" && c.provider !== from.provider);
    const rn = (id: string) => registry.find((r) => r.id === id)?.name ?? id;
    return {
      from: from.provider,
      fromName: rn(from.provider),
      to: to?.provider ?? "",
      toName: to ? rn(to.provider) : "awaiting fallback",
      atLabel: "in effect now",
      reason: from.last_error?.slice(0, 80) ?? "cooling down",
    };
  });

  // ── health (§13): uptime % = ok ratio over the 24h usage window ──
  const uptime = $derived(totalReqs ? okReqs / totalReqs : null);
  const providerHealth = $derived(
    flowProviders.map((p) => {
      const rows = usages.filter((u) => u.provider === p.id);
      const n = rows.reduce((s, u) => s + u.n, 0);
      const ok = rows.reduce((s, u) => s + (u.ok_n ?? 0), 0);
      return {
        id: p.id,
        name: p.name,
        status: conns.find((c) => c.provider === p.id)?.status ?? "disabled",
        latency: p.latency,
        n,
        err: n ? 1 - ok / n : null,
      };
    }),
  );
  const healthTone = $derived(
    (() => {
      if (!conns.length) return "muted" as const;
      if (routerState === "failure") return "bad" as const;
      if (routerState === "degraded") return "warn" as const;
      return "ok" as const;
    })(),
  );
  const healthLabel = $derived(
    !conns.length ? "standby" : routerState === "failure" ? "offline" : routerState === "degraded" ? "degraded" : "nominal",
  );

  const v1logs = $derived(logs.filter((l) => l.path.startsWith("/v1")).slice(0, 10));

  async function refresh() {
    try {
      const [c, u, l, r, p] = await Promise.all([
        api.connections(),
        api.usage(24),
        api.logs(400),
        api.registry(),
        getPricing().catch(() => ({ pricing: [] as PricingRow[] })),
      ]);
      conns = c.providers;
      usages = (u.rows ?? []) as UsageExt[];
      logs = l.rows;
      registry = r.providers;
      pricing = p.pricing ?? [];
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
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
    <h1>Control Room</h1>
    <p class="sub">
      {#if !booted}
        booting router…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
      {:else}
        {connected.size} providers connected · {errorRate == null ? "no traffic in 24h window" : `${pct(errorRate, 2)} errors · 24h`} · core {routerState === "high-traffic" ? "high traffic" : routerState}{rps > 0 ? ` (${rps} req/min)` : ""}
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Refresh</Button>
    <Button variant="primary" onclick={() => go("/providers")}><Icon name="plus" size={13} /> Connect provider</Button>
  </div>
</div>

{#if !booted}
  <div class="grid">
    {#each [1, 2, 3, 4] as i (i)}<div class="skeleton sk-kpi"></div>{/each}
    <div class="skeleton sk-hero"></div>
  </div>
{:else}
  <div class="kpis">
    <KpiCard
      label="Total requests"
      value={compact(totalReqs)}
      raw={totalReqs}
      format={fmtCount}
      trend={trendReqs}
      trendGood="up"
      spark={buckets.reqs}
      cue={totalReqs ? `${compact(okReqs)} ok · ${compact(failedReqs)} failed · ${trendRange}` : `no traffic in window · ${trendRange}`}
      cueTone={errorRate == null ? null : errorRate === 0 ? "ok" : errorRate < 0.05 ? "warn" : "bad"}
    />
    <KpiCard
      label="Total cost"
      value={totalCost == null ? "—" : fmtUSD(totalCost)}
      raw={totalCost}
      format={fmtUSD}
      ping={avgPing}
      trend={trendCost}
      trendGood="down"
      spark={costKnown ? buckets.cost : []}
      cue={totalCost == null ? "pricing not seeded — cost unavailable" : `${fmtUSD(avgCostPerReq)} / req avg · ${trendRange}`}
      cueTone={totalCost == null ? "warn" : "ok"}
    />
    <KpiCard
      label="Avg latency"
      value={avgLat == null ? "—" : ms(avgLat)}
      raw={avgLat}
      format={ms}
      trend={trendLat}
      trendGood="down"
      spark={buckets.lat}
      cue={avgLat == null ? `no latency samples in window · ${trendRange}` : `across ${compact(v1logs.length)} logged requests · ${trendRange}`}
      cueTone={avgLat == null ? null : "ok"}
    />
    <KpiCard
      label="Error rate"
      value={errorRate == null ? "—" : pct(errorRate)}
      raw={errorRate}
      format={fmtPct1}
      trend={trendErr}
      trendGood="down"
      spark={buckets.errR.map((r) => r * 100)}
      cue={errorRate == null ? `no traffic in window · ${trendRange}` : `${compact(failedReqs)} failed of ${compact(totalReqs)} · 24h window · ${trendRange}`}
      cueTone={errorRate == null ? null : errorRate === 0 ? "ok" : errorRate < 0.05 ? "warn" : "bad"}
    />
  </div>

  <div class="hero-row">
    <Panel class="hero" title="Live request flow" sub="incoming → router core → provider decision · state: {routerState === 'high-traffic' ? 'high traffic' : routerState}">
      {#if conns.length === 0}
        <div class="first-run">
          <div class="fr-core" aria-hidden="true"><span></span></div>
          <h3>No providers connected yet</h3>
          <p>The core has nothing to route to. Connect one API-key provider and the network comes alive.</p>
          <Button variant="primary" onclick={() => go("/providers")}><Icon name="bolt" size={13} /> Connect your first provider</Button>
        </div>
      {:else}
        <RouterCore providers={flowProviders} {rps} flow={routerState} failover={failover} />
        {#if !failover}
          <p class="fo-quiet"><Icon name="policies" size={12} /> no failover in effect — automatic failover armed</p>
        {/if}
      {/if}
    </Panel>

    <Panel title="System health" sub="rolling 24h window · ok / total requests">
      <div class="up">
        <span class="upv" class:ok={healthTone === "ok"} class:warn={healthTone === "warn"} class:bad={healthTone === "bad"}>{uptime == null ? "—" : pct(uptime, 2)}</span>
        <span class="upl">uptime · {totalReqs ? `${compact(okReqs)} / ${compact(totalReqs)} ok` : "no traffic in window"} · {healthLabel}</span>
      </div>
      <ul class="prov-list">
        {#each providerHealth as p (p.id)}
          <li>
            <span class="pn">{p.name}</span>
            <span class="pl">{p.n ? compact(p.n) : "—"}</span>
            <span class="pl">{p.latency != null ? ms(p.latency) : "—"}</span>
            <span class="pl" class:bad={p.err != null && p.err >= 0.05}>{p.err == null ? "—" : pct(p.err)}</span>
            <StatusPill
              tone={p.status === "active" ? "ok" : p.status === "cooldown" ? "warn" : "bad"}
              label={p.status === "cooldown" ? "cooling down" : p.status}
              pulse={p.status === "active" && rps > 0}
            />
          </li>
        {:else}
          <li class="muted-row">waiting for first connection…</li>
        {/each}
      </ul>
      <p class="col-hint">traffic · latency · errors per provider</p>
    </Panel>
  </div>

  <div class="mid-row">
    <Panel title="Requests over time" sub="last 6h · from request log · pink=current, blue=latency">
      {#if v1logs.length === 0}
        <EmptyState title="No requests in the last 6 hours" desc="Send one /v1 request and this chart starts drawing from the request log." />
      {:else}
        <LineChart
          series={[
            { name: "requests", values: buckets.reqs },
            { name: "avg latency", values: buckets.lat, color: "var(--color-blue-bright)", fmt: (v) => ms(v) },
            { name: "cost (allocated)", values: buckets.cost, fmt: (v) => fmtUSD(v), hidden: true },
          ]}
          labels={buckets.labels}
          fmt={(v) => (v >= 10 ? num(v) : v.toFixed(0))}
        />
        {#if avgCostPerReq != null}
          <p class="col-hint">cost allocated at {fmtUSD(avgCostPerReq)}/req average — hover for time · requests · cost · latency</p>
        {/if}
      {/if}
    </Panel>
    <Panel title="Cost over time" sub={costKnown ? "last 6h · allocated by request volume" : "last 6h · pricing not seeded"}>
      {#if !costKnown}
        <EmptyState title="Cost unavailable — pricing not seeded" desc="Usage is flowing but no price matches it. Seed pricing once and spend attribution starts here." />
      {:else}
        <LineChart
          series={[
            { name: "cost", values: buckets.cost, fmt: (v) => fmtUSD(v) },
            { name: "requests", values: buckets.reqs, color: "var(--color-blue-bright)", hidden: true },
            { name: "avg latency", values: buckets.lat, color: "var(--color-blue-bright)", fmt: (v) => ms(v), hidden: true },
          ]}
          labels={buckets.labels}
          fmt={(v) => fmtUSD(v)}
        />
        <p class="col-hint">total {fmtUSD(totalCost)} · {fmtUSD(avgCostPerReq)}/req avg · hover for time · requests · cost · latency</p>
      {/if}
    </Panel>
  </div>

  <div class="mid-row">
    <Panel title="Traffic by model" sub="request share · 24h">
      {#each usages.slice(0, 6) as u, i (u.provider + u.model)}
        {@const share = totalReqs ? u.n / totalReqs : 0}
        <div class="share-row">
          <span class="s-model">{u.model}</span>
          <div class="s-bar"><i style="width:{Math.max(2, share * 100).toFixed(1)}%" class:lead={i === 0}></i></div>
          <span class="s-n">{compact(u.n)} · {pct(share)}</span>
        </div>
      {:else}
        <p class="muted-row">No traffic recorded in the last 24 hours.</p>
      {/each}
    </Panel>
    <Panel title="Failover log" sub="derived from cooldown state">
      {#if failover}
        <div class="fo-row">
          <span class="fo-from">{failover.fromName}</span>
          <span class="fo-arrow" aria-hidden="true">→</span>
          <span class="fo-to">{failover.toName}</span>
          <span class="fo-when">{failover.atLabel}</span>
        </div>
        <p class="fo-reason">{failover.reason}</p>
      {:else}
        <EmptyState title="No failover events" desc="No provider is cooling down, so no traffic has been rerouted. Failover moments appear here the instant a primary drops." />
      {/if}
    </Panel>
  </div>

  <Panel title="Routing activity" sub="{timeShort(Date.now())} · newest first · full history under Observability → Logs" pad={false}>
    <table class="act-table">
      <thead>
        <tr><th>Status</th><th>Time</th><th>Route</th><th class="r">Latency</th></tr>
      </thead>
      <tbody>
        {#each v1logs as l (l.seq)}
          <tr>
            <td>
              {#if l.status < 400}<span class="s-ok"><Icon name="check" size={12} /> SUCCESS</span
              >{:else}<span class="s-bad"><Icon name="bolt" size={12} /> ERR {l.status}</span>{/if}
            </td>
            <td class="mono">{time(l.ts)}</td>
            <td class="path">{l.method} {l.path}</td>
            <td class="r mono">{l.dur_ms}ms</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="muted-row pad">No /v1 traffic yet — send one request and this feed fills up.</td></tr>
        {/each}
      </tbody>
    </table>
  </Panel>
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
  .sub .bad {
    color: var(--color-bad);
  }
  .hdr-actions {
    display: flex;
    gap: 8px;
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 16px;
  }
  .hero-row {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr);
    gap: 14px;
    margin-bottom: 16px;
    align-items: stretch;
  }
  :global(.hero) {
    min-height: 460px;
  }
  .mid-row {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 14px;
    margin-bottom: 16px;
  }
  .up {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-edge);
    margin-bottom: 8px;
  }
  .upv {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }
  .upv.ok { color: var(--color-ok); }
  .upv.warn { color: var(--color-warn); }
  .upv.bad { color: var(--color-bad); }
  .upl {
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .prov-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .prov-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto auto;
    align-items: center;
    gap: 10px;
    padding: 6.5px 0;
    border-bottom: 1px solid rgba(27, 27, 39, 0.55);
    font-size: 12.5px;
  }
  .pn {
    color: var(--color-ink);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pl {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .pl.bad {
    color: var(--color-bad);
  }
  .col-hint {
    margin: 8px 0 0;
    font-size: 10.5px;
    color: var(--color-ink-faint);
    font-family: var(--font-mono);
  }
  .fo-quiet {
    display: flex;
    gap: 7px;
    align-items: center;
    margin: 10px 4px 0;
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .fo-quiet :global(svg) {
    color: var(--color-blue-bright);
  }
  .fo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0 4px;
    font-size: 12.5px;
    font-family: var(--font-mono);
  }
  .fo-from { color: var(--color-bad); font-weight: 600; }
  .fo-arrow { color: var(--color-ink-faint); }
  .fo-to { color: var(--color-ok); font-weight: 600; }
  .fo-when {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-ink-faint);
  }
  .fo-reason {
    margin: 2px 0 0;
    font-size: 11.5px;
    color: var(--color-ink-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .share-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 130px 76px;
    gap: 10px;
    align-items: center;
    padding: 7px 0;
    font-size: 12px;
  }
  .s-model {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink-soft);
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .s-bar {
    height: 6px;
    background: #101018;
    border-radius: 3px;
    overflow: hidden;
  }
  .s-bar i {
    display: block;
    height: 100%;
    background: var(--color-blue);
    border-radius: 3px;
    transition: width var(--dur-panel) var(--ease-out);
  }
  .s-bar i.lead {
    background: var(--color-pink);
    box-shadow: var(--glow-pink);
  }
  .s-n {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-ink-muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .act-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .act-table th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-ink-faint);
    font-weight: 600;
    padding: 9px 16px;
    border-bottom: 1px solid var(--color-edge);
  }
  .act-table td {
    padding: 7px 16px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
    color: var(--color-ink-soft);
  }
  .act-table tr:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .r {
    text-align: right;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-muted);
  }
  .s-ok {
    color: var(--color-ok);
    display: inline-flex;
    gap: 5px;
    align-items: center;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .s-bad {
    color: var(--color-bad);
    display: inline-flex;
    gap: 5px;
    align-items: center;
    font-weight: 600;
    font-size: 11px;
  }
  .muted-row {
    color: var(--color-ink-faint);
  }
  .pad {
    padding: 22px 16px !important;
    text-align: center;
  }
  .first-run {
    height: 100%;
    min-height: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 6px;
  }
  .fr-core {
    width: 74px;
    height: 74px;
    border-radius: 50%;
    border: 1.5px solid var(--color-edge-strong);
    display: grid;
    place-items: center;
    margin: 12px auto 10px;
    position: relative;
  }
  .fr-core::after {
    content: "";
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    border: 1px dashed #1d2c4a;
    animation: spin 9s linear infinite;
    pointer-events: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .fr-core span {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--color-pink);
    box-shadow: var(--glow-pink);
  }
  .first-run h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .first-run p {
    margin: 0 0 14px;
    color: var(--color-ink-muted);
    max-width: 340px;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .skeleton {
    background: linear-gradient(180deg, #0b0b11, #0d0d15);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-panel);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
  }
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .sk-kpi { height: 86px; }
  .sk-hero { height: 460px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }
  @media (max-width: 1100px) {
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hero-row, .mid-row { grid-template-columns: 1fr; }
  }
  @media (max-width: 600px) {
    .kpis { grid-template-columns: 1fr; }
  }
</style>

<script lang="ts">
  // SCREEN: Analytics (§28) — real aggregates only: usage rollup + request log buckets.
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import KpiCard from "../components/KpiCard.svelte";
  import LineChart from "../components/LineChart.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, type UsageRow, type LogRow } from "../lib/api.ts";
  import { compact, ms, num, pct, timeShort, fmtUSD } from "../lib/format.ts";
  import { rowCost } from "../lib/cost.ts";

  /** sentinel for buckets with no requests: outside the 0–100 range, shown as "—" */
  const EMPTY_BUCKET = -1;

  let rangeH = $state(24);
  let usages = $state<UsageRow[]>([]);
  let logs = $state<LogRow[]>([]);
  let booted = $state(false);
  let err = $state<string | null>(null);

  const v1 = $derived(logs.filter((l) => l.path.startsWith("/v1")));
  const totalReqs = $derived(usages.reduce((s, u) => s + u.n, 0));
  const okReqs = $derived(usages.reduce((s, u) => s + (u.ok_n ?? 0), 0));
  const tokensIn = $derived(usages.reduce((s, u) => s + (u.inp ?? 0), 0));
  const tokensOut = $derived(usages.reduce((s, u) => s + (u.outp ?? 0), 0));
  const avgLat = $derived(
    (() => {
      const w = usages.filter((u) => u.avg_ms != null);
      if (!w.length) return null;
      return w.reduce((s, u) => s + u.avg_ms! * u.n, 0) / w.reduce((s, u) => s + u.n, 0);
    })(),
  );
  const failovers = $derived(usages.reduce((s, u) => s + (u.n - (u.ok_n ?? 0)), 0));

  // per-hour buckets across the selected window, from request_log
  const trend = $derived.by(() => {
    const slots = Math.min(24, rangeH * 4);
    const spanMs = rangeH * 3_600_000;
    const slot = spanMs / slots;
    const now = Date.now();
    const labels: number[] = [];
    const reqs = new Array<number>(slots).fill(0);
    const errs = new Array<number>(slots).fill(0);
    const succ = new Array<number>(slots).fill(0);
    const latSum = new Array<number>(slots).fill(0);
    const latN = new Array<number>(slots).fill(0);
    for (let i = slots - 1; i >= 0; i--) labels.push(now - (i + 0.5) * slot);
    for (const l of v1) {
      const back = Math.floor((now - l.ts) / slot);
      if (back < 0 || back >= slots) continue;
      const i = slots - 1 - back;
      reqs[i] = (reqs[i] ?? 0) + 1;
      if (l.status < 400) succ[i] = (succ[i] ?? 0) + 1;
      else errs[i] = (errs[i] ?? 0) + 1;
      latSum[i] = (latSum[i] ?? 0) + l.dur_ms;
      latN[i] = (latN[i] ?? 0) + 1;
    }
    return {
      labels,
      reqs,
      errs,
      successRate: reqs.map((r, i) => (r ? ((succ[i] ?? 0) / r) * 100 : EMPTY_BUCKET)),
      lat: latN.map((n, i) => (n ? (latSum[i] ?? 0) / n : 0)),
    };
  });

  const providerDist = $derived(
    Object.entries(
      usages.reduce<Record<string, { n: number; lat: number }>>((acc, u) => {
        const cur = acc[u.provider] ?? { n: 0, lat: 0 };
        cur.n += u.n;
        cur.lat = Math.max(cur.lat, u.avg_ms ?? 0);
        acc[u.provider] = cur;
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 8),
  );
  // Cost comes from the stored usage rollup only (no pricing fallback here).
  const totalCost = $derived(usages.reduce((s, u) => s + (rowCost(u) ?? 0), 0));
  const costByProvider = $derived.by(() => {
    const m = new Map<string, number>();
    for (const u of usages) {
      const c = rowCost(u) ?? 0;
      if (c > 0) m.set(u.provider, (m.get(u.provider) ?? 0) + c);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  });
  const maxCost = $derived(Math.max(1e-9, ...costByProvider.map(([, v]) => v)));

  async function refresh() {
    try {
      const [u, l] = await Promise.all([api.usage(rangeH), api.logs(1000)]);
      usages = u.rows;
      logs = l.rows;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }
  let timer: ReturnType<typeof setInterval>;
  $effect(() => {
    void rangeH;
    refresh();
    timer = setInterval(refresh, 6000);
    return () => clearInterval(timer);
  });
</script>

<div class="head">
  <div>
    <h1>Analytics</h1>
    <p class="sub">aggregated from the local usage table — no external telemetry</p>
  </div>
  <div class="ranges" role="group" aria-label="Time range">
    {#each [1, 6, 24] as h (h)}
      <button class="rg" class:on={rangeH === h} onclick={() => (rangeH = h)} aria-pressed={rangeH === h}>{h === 24 ? "24h" : `${h}h`}</button>
    {/each}
  </div>
</div>

{#if !booted}
  <p class="loading">loading aggregates…</p>
{:else if err}
  <p class="loading bad">server unreachable: {err}</p>
{:else}
  <div class="kpis">
    <KpiCard label="Requests" value={compact(totalReqs)} spark={trend.reqs} trendGood="up" cue={`${v1.length} in log buffer`} />
    <KpiCard label="Success rate" value={totalReqs ? pct(okReqs / totalReqs) : "—"} spark={trend.successRate} trendGood="up" cue="{failovers} failed attempts" />
    <KpiCard label="Avg latency" value={avgLat == null ? "—" : ms(avgLat)} spark={trend.errs} trendGood="down" cue="weighted by request count" />
    <KpiCard label="Tokens" value={compact(tokensIn + tokensOut)} cue="{compact(tokensIn)} in · {compact(tokensOut)} out" />
    <KpiCard label="Cost (est.)" value={fmtUSD(totalCost)} cue="sums stored usage cost" trendGood="down" />
  </div>

  <div class="row">
    <Panel title="Requests by time" sub="last {rangeH}h · from request log">
      <LineChart series={[{ name: "requests", values: trend.reqs }, { name: "errors", values: trend.errs }]} labels={trend.labels} fmt={(v) => num(v)} />
    </Panel>
    <Panel title="Success rate" sub="% of /v1 requests, per bucket" class="half">
      <LineChart series={[{ name: "success %", values: trend.successRate, color: "var(--color-ok)" }]} labels={trend.labels} fmt={(v) => (v === EMPTY_BUCKET ? "—" : `${v.toFixed(0)}%`)} />
    </Panel>
  </div>
  <div class="row">
    <Panel title="Cost by provider" sub="stored usage cost · {rangeH}h window">
      {#if !costByProvider.length}
        <p class="empty-cell">No billed usage in this window — cost accrues on /v1 traffic with priced models.</p>
      {:else}
        <div class="costbars">
          {#each costByProvider as [prov, cost] ([prov])}
            {@const w = (cost / maxCost) * 100}
            <div class="crow">
              <span class="pn">{prov}</span>
              <div class="track"><div class="fill" style={`width:${w.toFixed(1)}%`}></div></div>
              <span class="mono">{fmtUSD(cost)}</span>
            </div>
          {/each}
        </div>
        <p class="csrc">Sums the stored per-row usage cost — no estimate model, no projection.</p>
      {/if}
    </Panel>
    <Panel title="Latency" sub="avg ms per bucket · from request log" class="half">
      <LineChart series={[{ name: "avg ms", values: trend.lat, color: "var(--color-blue-bright)" }]} labels={trend.labels} fmt={(v) => ms(v)} />
    </Panel>
  </div>


  <Panel title="Provider distribution" sub="requests · {rangeH}h window" pad={false}>
    <table class="tbl">
      <thead>
        <tr><th>Provider</th><th class="r">Requests</th><th>Share</th><th class="r">Peak avg latency</th></tr>
      </thead>
      <tbody>
        {#each providerDist as [prov, v] (prov)}
          {@const share = totalReqs ? v.n / totalReqs : 0}
          <tr>
            <td class="pn"><Icon name="providers" size={13} />{prov}</td>
            <td class="r mono">{num(v.n)}</td>
            <td class="barcell"><i class={share > 0.5 ? "lead" : ""} style="width:{Math.max(2, share * 100).toFixed(1)}%"></i></td>
            <td class="r mono dim">{v.lat ? ms(v.lat) : "—"}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="empty-cell">No {rangeH}h traffic yet — send a request through /v1 and this fills up.</td></tr>
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
  .ranges {
    display: inline-flex;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    overflow: hidden;
  }
  .rg {
    background: var(--color-elevated);
    border: none;
    color: var(--color-ink-muted);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 14px;
    cursor: pointer;
  }
  .rg + .rg {
    border-left: 1px solid var(--color-edge);
  }
  .rg.on {
    background: rgba(255, 22, 140, 0.12);
    color: var(--color-pink);
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 14px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 12px;
    margin-bottom: 14px;
  }
  .loading {
    color: var(--color-ink-faint);
    font-size: 12.5px;
  }
  .loading.bad {
    color: var(--color-bad);
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
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
    padding: 8px 16px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
  }
  .tbl tr:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .pn {
    color: var(--color-ink);
  }
  .pn :global(svg) {
    color: var(--color-blue-bright);
    margin-right: 8px;
    vertical-align: -2px;
  }
  .r {
    text-align: right;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .dim {
    color: var(--color-ink-faint);
  }
  .barcell {
    width: 42%;
  }
  .barcell i {
    display: block;
    height: 6px;
    background: var(--color-blue);
    border-radius: 3px;
  }
  .barcell i.lead {
    background: var(--color-pink);
    box-shadow: var(--glow-pink);
  }
  .costbars { display:flex; flex-direction:column; gap:8px; padding:14px 16px 4px; }
  .crow { display:grid; grid-template-columns:120px 1fr auto; gap:10px; align-items:center; font-size:12px; }
  .crow .track { height:6px; background:var(--color-elevated); border-radius:3px; overflow:hidden; }
  .crow .fill { height:100%; background:var(--color-blue); border-radius:3px; }
  .crow .mono { min-width:64px; text-align:right; }
  .csrc { margin:10px 16px 14px; font-size:11px; color:var(--color-ink-faint); }
  .empty-cell {
    text-align: center;
    color: var(--color-ink-faint);
    padding: 22px 16px !important;
  }
  @media (max-width: 1280px) {
    .row { grid-template-columns: 1fr; }
  }
</style>

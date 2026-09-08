<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import KpiCard from "../components/KpiCard.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, getPricing, type PricingRow, type ApiKeyRow } from "../lib/api.ts";
  import { compact, fmtUSD } from "../lib/format.ts";
  import { rowCost } from "../lib/cost.ts";

  type UsageRowExt = {
    provider: string;
    model: string;
    n: number;
    inp: number | null;
    outp: number | null;
    ok_n: number | null;
    avg_ms: number | null;
    cost?: number | null;
    cost_usd?: number | null;
  };

  let pricing = $state<PricingRow[]>([]);
  let usage30d = $state<UsageRowExt[]>([]);
  let usage24h = $state<UsageRowExt[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);
  let keys = $state<ApiKeyRow[]>([]);
  let budgets = $state<Record<string, { budget: number | null; spent: number }>>({});
  let marginRows = $state<Array<{ key_id: string; name: string; n: number; revenue: number }>>([]);
  let marginTotal = $state(0);


  async function refresh(): Promise<void> {
    try {
      const mg = await api.margin(30);
      marginRows = mg.byKey;
      marginTotal = mg.totalRevenue;
    } catch {}
    try {
      const [p, u30, u24, k] = await Promise.all([getPricing(), api.usage(720), api.usage(24), api.keys()]);
      pricing = p.pricing ?? [];
      usage30d = u30.rows ?? [];
      usage24h = u24.rows ?? [];
      keys = k.keys ?? [];
      const infos = await Promise.all(
        keys.map((kk) => api.getBudget(kk.id).catch(() => ({ id: kk.id, budget: null as number | null, spent: 0 }))),
      );
      const m: Record<string, { budget: number | null; spent: number }> = {};
      for (const info of infos) m[info.id] = { budget: info.budget, spent: info.spent };
      budgets = m;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  const totalCost30d = $derived(usage30d.reduce((s, r) => s + (rowCost(r) ?? 0), 0));
  const totalCost24h = $derived(usage24h.reduce((s, r) => s + (rowCost(r) ?? 0), 0));
  const totalReqs30d = $derived(usage30d.reduce((s, r) => s + (r.n ?? 0), 0));
  const avgCostPerReq = $derived(totalReqs30d ? totalCost30d / totalReqs30d : null);
  // ── spend-pulse: bumped once per poll where the average $/req actually rose ──
  let avgPing = $state(0);
  let prevAvg: number | null = null;
  $effect(() => {
    const a = avgCostPerReq;
    const p = prevAvg;
    prevAvg = a;
    if (a != null && p != null && a > p) avgPing += 1;
  });

  const costByProvider = $derived.by(() => {
    const m = new Map<string, number>();
    for (const r of usage30d) {
      const c = rowCost(r);
      if (!c) continue;
      m.set(r.provider, (m.get(r.provider) ?? 0) + c);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  });

  const topModels = $derived.by(() => {
    const rows = [...usage30d].filter((r) => (rowCost(r) ?? 0) > 0);
    rows.sort((a, b) => (rowCost(b) ?? 0) - (rowCost(a) ?? 0));
    return rows.slice(0, 12);
  });

  const maxProvCost = $derived(Math.max(1e-9, ...costByProvider.map(([, v]) => v)));
  const cappedKeys = $derived(keys.filter((k) => budgets[k.id]?.budget != null));
  const totalCap = $derived(cappedKeys.reduce((s, k) => s + (budgets[k.id]?.budget ?? 0), 0));
  const totalSpentMTD = $derived(keys.reduce((s, k) => s + (budgets[k.id]?.spent ?? 0), 0));
  const capPct = $derived(totalCap > 0 ? Math.min(1, totalSpentMTD / totalCap) : null);
  // Simple linear forecast: month-to-date spend projected to month end.
  const forecast = $derived.by(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const elapsed = Math.max(1, Date.now() - start);
    return {
      projected: (totalSpentMTD / elapsed) * (end - start),
      daysLeft: Math.max(0, Math.ceil((end - Date.now()) / 86_400_000)),
      daily: totalSpentMTD / (elapsed / 86_400_000),
    };
  });
  // Actionable insight from real numbers only — shares, ranks and listed rates.
  const insight = $derived.by(() => {
    if (!totalCost30d) return null;
    const top = costByProvider[0];
    const dear = topModels[0];
    const cheap = [...pricing].sort((a, b) => a.input_usd + a.output_usd - (b.input_usd + b.output_usd))[0];
    return {
      top,
      share: top ? (top[1] / totalCost30d) * 100 : 0,
      dear,
      cheap,
    };
  });

  function fmtRate(n: number | null | undefined): string {
    if (n == null) return "—";
    return `$${n.toFixed(2)}`;
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 10_000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Costs</h1>
    <p class="sub">spend attribution from local pricing + usage cost rollup</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="grid">
    {#each [1, 2, 3] as i (i)}<div class="skeleton sk-kpi"></div>{/each}
    <div class="skeleton sk-chart"></div>
  </div>
{:else if err && !pricing.length && !usage30d.length}
  <Panel><p class="bad">server unreachable: {err}</p></Panel>
{:else}
  <div class="kpis">
    <KpiCard label="Total cost · 30d" value={fmtUSD(totalCost30d)} raw={totalCost30d} format={fmtUSD} cue="{compact(totalReqs30d)} requests" trendGood="down" />
    <KpiCard label="Today · 24h" value={fmtUSD(totalCost24h)} raw={totalCost24h} format={fmtUSD} cue="rolling 24h window" trendGood="down" />
    <KpiCard label="Avg cost / request" value={avgCostPerReq == null ? "—" : fmtUSD(avgCostPerReq)} raw={avgCostPerReq} format={fmtUSD} ping={avgPing} cue={totalReqs30d ? `${totalReqs30d} reqs / 30d` : "no traffic"} trendGood="down" />
  </div>
  {#if keys.length}
    <div class="row">
      <Panel title="Budgets vs caps" sub={cappedKeys.length ? `${cappedKeys.length} of ${keys.length} keys capped · month to date` : `${keys.length} keys · no caps set`}>
        {#if !cappedKeys.length}
          <p class="empty">No monthly caps set — add one per key on <a href="#/policies" class="lnk">Policies</a>, then progress tracks here.</p>
        {:else}
          <div class="capline"><span>Spent {fmtUSD(totalSpentMTD)} of {fmtUSD(totalCap)}</span><span class="pct">{((capPct ?? 0) * 100).toFixed(1)}%</span></div>
          <div class="track big"><div class="fill" style={`width:${((capPct ?? 0) * 100).toFixed(1)}%`}></div></div>
          <div class="keycaps">
            {#each cappedKeys as k (k.id)}
              {@const b = budgets[k.id]!}
              {@const p = b.budget ? Math.min(1, b.spent / b.budget) : 0}
              <div class="keycap"><span class="prov">{k.name}</span><div class="track"><div class="fill" style={`width:${(p * 100).toFixed(1)}%`}></div></div><span class="val">{fmtUSD(b.spent)} / {fmtUSD(b.budget ?? 0)}</span></div>
            {/each}
          </div>
        {/if}
      </Panel>
      <Panel title="Forecast & insights" sub="linear projection · real numbers only">
        <div class="kv2">
          <div><span>Projected month-end</span><strong class="mono">{fmtUSD(forecast.projected)}</strong></div>
          <div><span>Daily burn</span><strong class="mono">{fmtUSD(forecast.daily)}/day</strong></div>
          <div><span>Days left</span><strong class="mono">{forecast.daysLeft}</strong></div>
        </div>
        {#if insight?.top}
          <ul class="insights">
            <li><strong>{insight.top[0]}</strong> is responsible for <strong>{insight.share.toFixed(1)}%</strong> of 30d spend ({fmtUSD(insight.top[1])}).</li>
            {#if insight.dear}<li>Highest-cost model: <span class="mono">{insight.dear.provider}/{insight.dear.model}</span> at <strong>{fmtUSD(rowCost(insight.dear))}</strong> across {compact(insight.dear.n)} requests.</li>{/if}
            {#if insight.cheap}<li>Cheapest listed rate: <span class="mono">{insight.cheap.provider}/{insight.cheap.model}</span> at ${insight.cheap.input_usd.toFixed(2)}/${insight.cheap.output_usd.toFixed(2)} per 1M tokens — compare route candidates against it.</li>{/if}
          </ul>
        {:else}
          <p class="empty">No spend yet — insights appear once billed /v1 traffic lands.</p>
        {/if}
      </Panel>
    </div>
  {/if}


  <div class="row">
    <Panel title="Cost by provider · 30d" sub={costByProvider.length ? "share of spend" : "no billed usage yet"}>
      {#if !costByProvider.length}
        <p class="empty">No cost data yet — send a billed request through /v1 and this fills up.</p>
      {:else}
        <div class="bars">
          {#each costByProvider as [prov, cost] ([prov])}
            {@const w = (cost / maxProvCost) * 100}
            <div class="bar-row">
              <span class="prov">{prov}</span>
              <div class="track"><div class="fill" style={`width:${w.toFixed(1)}%`}></div></div>
              <span class="val">{fmtUSD(cost)}</span>
              <span class="pct">{((cost / Math.max(totalCost30d, 1e-9)) * 100).toFixed(1)}%</span>
            </div>
          {/each}
        </div>
      {/if}
    </Panel>

    <Panel title="Top models by cost · 30d" sub={topModels.length ? "ranked by spend" : "no billed usage yet"} pad={false}>
      {#if !topModels.length}
        <p class="empty pad">No model-level cost yet.</p>
      {:else}
        <table class="tbl mini">
          <thead><tr><th>Provider / Model</th><th class="r">Reqs</th><th class="r">Cost</th></tr></thead>
          <tbody>
            {#each topModels as r (r.provider + "/" + r.model)}
              <tr>
                <td><span class="mono">{r.provider}/{r.model}</span></td>
                <td class="r">{compact(r.n)}</td>
                <td class="r mono">{fmtUSD(rowCost(r))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </Panel>
  </div>

  {#if marginRows.length}
    <Panel title="Revenue by key · 30d" sub="internal charges at the flat rate · upstream cost tracked as $0">
      <table class="tbl mini">
        <thead><tr><th>Key</th><th class="r">Reqs</th><th class="r">Revenue</th></tr></thead>
        <tbody>
          {#each marginRows as r (r.key_id ?? "none")}
            <tr><td class="mono">{r.name ?? "no key"} <span class="dim">({r.key_id ?? "—"})</span></td><td class="r">{r.n}</td><td class="r mono">{fmtUSD(r.revenue)}</td></tr>
          {/each}
          <tr class="total"><td>Total</td><td class="r">{marginRows.reduce((a, r) => a + r.n, 0)}</td><td class="r mono">{fmtUSD(marginTotal)}</td></tr>
        </tbody>
      </table>
    </Panel>
  {/if}
  {#if !pricing.length}
    <Panel>
      <EmptyState title="Pricing not seeded" desc="Pricing not seeded — run once or pricing.json missing">
        {#snippet action()}
          <Button variant="primary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Retry</Button>
        {/snippet}
      </EmptyState>
    </Panel>
  {:else}
    <Panel title="Pricing" sub="{pricing.length} models · reference only — billing uses the flat $0.2/1M rate" pad={false}>
      <div class="scroll">
        <table class="tbl">
          <thead><tr><th>Provider</th><th>Model</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cache</th></tr></thead>
          <tbody>
            {#each pricing as p (p.provider + "/" + p.model)}
              <tr>
                <td>{p.provider}</td>
                <td class="mono">{p.model}</td>
                <td class="r mono">{fmtRate(p.input_usd)}</td>
                <td class="r mono">{fmtRate(p.output_usd)}</td>
                <td class="r mono">{p.cache_read_usd == null ? "—" : fmtRate(p.cache_read_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="foot">{pricing.length} rows · source pricing.json</p>
    </Panel>
  {/if}
{/if}

<style>
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .sub { margin: 3px 0 0; font-size: 12.5px; color: var(--color-ink-muted); }
  .hdr-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 760px) { .kpis { grid-template-columns: 1fr; } }
  .row { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 12px; margin-bottom: 12px; }
  @media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
  .bars { display: flex; flex-direction: column; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 84px 48px; gap: 10px; align-items: center; font-size: 12.5px; }
  @media (max-width: 560px) { .bar-row { grid-template-columns: 96px 1fr 70px 40px; } }
  .prov { font-weight: 600; color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { height: 8px; border-radius: 999px; background: var(--color-elevated); border: 1px solid var(--color-edge); overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; background: var(--color-pink); transition: width var(--dur-panel) var(--ease-out); }
  .val { text-align: right; font-family: var(--font-mono); color: var(--color-ink); font-size: 12px; }
  .pct { text-align: right; color: var(--color-ink-faint); font-size: 11.5px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-faint); padding: 10px 12px; border-bottom: 1px solid var(--color-edge); }
  .tbl td { padding: 9px 12px; border-bottom: 1px solid var(--color-edge); }
  .tbl tr:last-child td { border-bottom: 0; }
  .tbl.mini th, .tbl.mini td { padding: 7px 10px; font-size: 12.5px; }
  .tbl tr.total td { font-weight: 700; border-top: 1px solid var(--color-edge); }
  .r { text-align: right; }
  .mono { font-family: var(--font-mono); }
  .empty { margin: 0; padding: 22px 16px; color: var(--color-ink-muted); font-size: 12.5px; text-align: center; }
  .empty.pad { padding: 18px 16px; }
  .scroll { max-height: 520px; overflow: auto; }
  .foot { margin: 0; padding: 8px 12px; font-size: 11.5px; color: var(--color-ink-faint); border-top: 1px solid var(--color-edge); }
  .bad { color: var(--color-bad); font-size: 13px; padding: 16px; }
  .skeleton { border: 1px solid var(--color-edge); border-radius: var(--radius-panel); background: var(--color-base); }
  .sk-kpi { height: 88px; }
  .sk-chart { height: 180px; grid-column: 1 / -1; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .capline { display:flex; justify-content:space-between; font-size:12.5px; color:var(--color-ink-soft); margin:2px 0 8px; }
  .track.big { height:10px; }
  .keycaps { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
  .keycap { display:grid; grid-template-columns:110px 1fr auto; gap:10px; align-items:center; font-size:12px; }
  .kv2 { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; margin-bottom:10px; }
  .kv2 div { border:1px solid var(--color-edge); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; }
  .kv2 span { font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--color-ink-faint); }
  .kv2 strong { font-size:14px; color:var(--color-ink); }
  .insights { margin:0; padding-left:18px; font-size:12.5px; color:var(--color-ink-soft); line-height:1.6; display:flex; flex-direction:column; gap:6px; }
  .lnk { color:var(--color-blue-bright); text-decoration:none; }
  .lnk:hover { text-decoration:underline; }
</style>

<script lang="ts">
  // SCREEN — Requests (§25-26): /v1 traffic observability. "Live" streams the
  // request ring buffer; "Usage 24h" is a sortable provider×model rollup. The
  // inspector drawer reveals ONLY stored request_log fields — anything the
  // server does not persist renders as "not stored", never a mockup.
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Tabs from "../components/Tabs.svelte";
  import Input from "../components/Input.svelte";
  import DataTable, { type DataColumn } from "../components/DataTable.svelte";
  import Pagination from "../components/Pagination.svelte";
  import LogView from "../components/LogView.svelte";
  import Drawer from "../components/Drawer.svelte";
  import { onMount, onDestroy, untrack } from "svelte";
  import { api, type LogRow, type UsageRow } from "../lib/api.ts";
  import { compact, ms, num, time } from "../lib/format.ts";

  let tab = $state<"live" | "usage">("live");
  let logs = $state<LogRow[]>([]);
  let usages = $state<UsageRow[]>([]);
  let q = $state("");
  let err = $state<string | null>(null);
  let booted = $state(false);
  let selSeq = $state<number | null>(null);
  let inspTab = $state<"summary" | "trace" | "request" | "response" | "meta">("summary");
  const sel = $derived(logs.find((l) => l.seq === selSeq) ?? null);

  const live = $derived.by(() => {
    const v1 = logs.filter((l) => l.path.startsWith("/v1"));
    const needle = q.trim().toLowerCase();
    if (!needle) return v1;
    return v1.filter(
      (r) =>
        r.line.toLowerCase().includes(needle) ||
        r.path.toLowerCase().includes(needle) ||
        String(r.status).includes(needle),
    );
  });
  const v1Failed = $derived(live.filter((l) => l.status >= 400).length);

  type UKey = "provider" | "model" | "n" | "ok_n" | "inp" | "outp" | "avg_ms";
  const COLS: { key: UKey; label: string; r?: boolean }[] = [
    { key: "provider", label: "Provider" },
    { key: "model", label: "Model" },
    { key: "n", label: "Requests", r: true },
    { key: "ok_n", label: "OK", r: true },
    { key: "inp", label: "Tokens in", r: true },
    { key: "outp", label: "Tokens out", r: true },
    { key: "avg_ms", label: "Avg latency", r: true },
  ];
  let sortKey = $state<UKey>("n");
  let asc = $state(false);
  function toggleSort(k: UKey): void {
    if (k === sortKey) asc = !asc;
    else {
      sortKey = k;
      asc = k === "provider" || k === "model";
    }
  }
  const sortedUsage = $derived.by(() => {
    const dir = asc ? 1 : -1;
    return [...usages].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (typeof x === "string" || typeof y === "string") {
        return dir * String(x ?? "").localeCompare(String(y ?? ""));
      }
      return dir * ((x ?? -1) - (y ?? -1));
    });
  });
  const usageTotals = $derived.by(() => ({
    reqs: usages.reduce((s, u) => s + u.n, 0),
    models: usages.length,
  }));
  const liveCols: DataColumn[] = [
    { key: "ts", label: "Time" },
    { key: "method", label: "Method" },
    { key: "path", label: "Path" },
    { key: "status", label: "Status", align: "right" },
    { key: "dur", label: "Duration", align: "right" },
    { key: "egress", label: "Egress" },
  ];
  const usageCols: DataColumn[] = COLS.map((c) => ({
    key: c.key,
    label: c.label,
    align: c.r ? "right" : "left",
    sortable: true,
  }));
  let livePage = $state(1);
  let usagePage = $state(1);
  const LIVE_PER = 50;
  const USAGE_PER = 25;
  const pagedLive = $derived(live.slice((livePage - 1) * LIVE_PER, livePage * LIVE_PER));
  const pagedUsage = $derived(sortedUsage.slice((usagePage - 1) * USAGE_PER, usagePage * USAGE_PER));
  $effect(() => {
    q;
    livePage = 1;
  });
  const maxDurPage = $derived(Math.max(1, ...pagedLive.map((l) => l.dur_ms ?? 0)));
  // ── row-enter: seqs never seen before this poll rise in (max 5 / refresh) ──
  let knownSeqs = new Set<number>();
  let freshSeqs = $state<Set<number>>(new Set());
  let seqsPrimed = false;
  $effect(() => {
    const rows = logs;
    const prev = untrack(() => knownSeqs);
    knownSeqs = new Set(rows.map((r) => r.seq));
    if (!seqsPrimed) {
      seqsPrimed = true;
      return;
    }
    const added = rows
      .filter((r) => !prev.has(r.seq))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 5);
    if (!added.length) return;
    freshSeqs = new Set(added.map((r) => r.seq));
    const t = setTimeout(() => {
      freshSeqs = new Set();
    }, 800);
    return () => clearTimeout(t);
  });
  // ── new-batch pill: fresh arrivals while on page > 1 or filtering. It never
  // auto-scrolls — one click returns to the latest page, nothing moves by itself.
  const freshLive = $derived(live.filter((l) => freshSeqs.has(l.seq)).length);
  const showBatchPill = $derived(tab === "live" && freshLive > 0 && (livePage > 1 || q.trim() !== ""));
  function backToLatest(): void {
    livePage = 1;
  }

  function statusCls(s: number): string {
    return s >= 500 || s === 499 ? "st-bad" : s >= 400 ? "st-warn" : "st-ok";
  }
  function openInspector(seq: number): void {
    selSeq = seq;
    inspTab = "summary";
  }
  function closeInspector(): void {
    selSeq = null;
  }

  async function refresh(): Promise<void> {
    try {
      const [l, u] = await Promise.all([api.logs(400), api.usage(24)]);
      logs = l.rows;
      usages = u.rows;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 5000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Requests</h1>
    <p class="sub">
      {#if !booted}
        loading traffic…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
      {:else}
        /v1 traffic only · {live.length} entries in ring buffer{v1Failed ? ` · ${v1Failed} failed` : " · none failed"} · {usageTotals.models} models active 24h ({compact(usageTotals.reqs)} reqs)
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>
<Tabs tabs={[{ id: "live", label: "Live" }, { id: "usage", label: "Usage 24h" }]} bind:value={tab} label="Requests view" />

{#if !booted}
  <Panel title="Requests" pad={false}>
    <div class="skel">
      {#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}<div class="sk-row"></div>{/each}
    </div>
  </Panel>
{:else if tab === "live"}
  <Panel title="Live /v1 Traffic" sub="request ring buffer · newest first" pad={false}>
    {#if err}
      <div class="errbar">
        <Icon name="bolt" size={13} />
        <span>last refresh failed — server unreachable: {err}</span>
        <Button variant="ghost" onclick={() => void refresh()}>Retry</Button>
      </div>
    {/if}
    <div class="toolbar">
      {#snippet searchIcon()}<Icon name="search" size={13} />{/snippet}
      <Input bind:value={q} placeholder="filter path · line · status" label="Filter live requests" width="220px" icon={searchIcon} />
    </div>
    {#if showBatchPill}
      <div class="batch-pill" role="status">
        <span>{freshLive} new request{freshLive === 1 ? "" : "s"} arrived — still viewing {q.trim() ? "filtered results" : `page ${livePage}`}</span>
        <Button variant="ghost" onclick={backToLatest}>Back to latest</Button>
      </div>
    {/if}
    {#if !logs.filter((l) => l.path.startsWith("/v1")).length && !q}
      {#snippet act()}
        <Button variant="primary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Reload</Button>
      {/snippet}
      <EmptyState
        title="No /v1 traffic yet"
        desc="Requests to chat completions and other /v1 endpoints land here the moment a client key points at this router."
        action={act}
      />
    {:else}
      <DataTable columns={liveCols} label="Live requests">
        <tbody>
          {#each pagedLive as l (l.seq)}
            <tr
              class="row"
              class:fresh={freshSeqs.has(l.seq)}
              tabindex="0"
              role="button"
              aria-expanded={selSeq === l.seq}
              onclick={() => openInspector(l.seq)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInspector(l.seq); } }}
            >
              <td class="mono">{time(l.ts)}</td>
              <td class="mono m-method">{l.method}</td>
              <td class="path">{l.path}</td>
              <td class="r mono {statusCls(l.status)}">{l.status}</td>
              <td class="r mono dim"><span class="lat"><span class="latbar" aria-hidden="true"><i style="width:{((l.dur_ms / maxDurPage) * 100).toFixed(1)}%"></i></span>{ms(l.dur_ms)}</span></td>
              <td class="mono dim">{l.egress ?? "direct"}</td>
            </tr>
          {:else}
            <tr><td colspan="6" class="nomatch">No /v1 entries match “{q}”.</td></tr>
          {/each}
        </tbody>
      </DataTable>
      <Pagination total={live.length} bind:page={livePage} perPage={LIVE_PER} />
    {/if}
  </Panel>
{:else}
  <Panel title="Usage Rollup · 24h" sub="click a column header to sort" pad={false}>
    {#if err}
      <div class="errbar">
        <Icon name="bolt" size={13} />
        <span>last refresh failed — server unreachable: {err}</span>
        <Button variant="ghost" onclick={() => void refresh()}>Retry</Button>
      </div>
    {/if}
    {#if !usages.length}
      {#snippet act2()}
        <Button variant="primary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Reload</Button>
      {/snippet}
      <EmptyState
        title="No usage in the last 24 hours"
        desc="Successful and failed /v1 calls roll up here by provider and model. Send a request to seed the table."
        action={act2}
      />
    {:else}
      <DataTable
        columns={usageCols}
        sortKey={sortKey}
        sortDir={asc ? "asc" : "desc"}
        onSort={(k) => toggleSort(k as typeof sortKey)}
        label="Usage rollup"
      >
        <tbody>
          {#each pagedUsage as u (u.provider + " " + u.model)}
              <tr>
                <td class="prov">{u.provider}</td>
                <td class="path">{u.model}</td>
                <td class="r mono">{num(u.n)}</td>
                <td class="r mono {u.ok_n != null && u.ok_n < u.n ? "st-warn" : "st-ok"}">{u.ok_n == null ? "—" : num(u.ok_n)}</td>
                <td class="r mono dim">{u.inp == null ? "—" : compact(u.inp)}</td>
                <td class="r mono dim">{u.outp == null ? "—" : compact(u.outp)}</td>
                <td class="r mono">{u.avg_ms == null ? "—" : ms(u.avg_ms)}</td>
              </tr>
          {/each}
        </tbody>
      </DataTable>
      <Pagination total={sortedUsage.length} bind:page={usagePage} perPage={USAGE_PER} />
      <p class="foot">Rollup of stored request outcomes · per-request payloads are not retained server-side.</p>
    {/if}
  </Panel>
{/if}

{#if sel}
  <Drawer open={selSeq !== null} title="Request inspector · #{sel.seq}" onClose={closeInspector}>
    <Tabs
      tabs={[
        { id: "summary", label: "Summary" },
        { id: "trace", label: "Route trace" },
        { id: "request", label: "Request" },
        { id: "response", label: "Response" },
        { id: "meta", label: "Metadata" },
      ]}
      bind:value={inspTab}
      label="Inspector sections"
    />
    {#if inspTab === "summary"}
      <div class="kv">
        <span class="k">request</span><span class="v mono">#{num(sel.seq)} · {time(sel.ts)}</span>
        <span class="k">route</span><span class="v mono">{sel.method} {sel.path}</span>
        <span class="k">status</span><span class="v mono {statusCls(sel.status)}">{sel.status}</span>
        <span class="k">duration</span><span class="v mono">{ms(sel.dur_ms)}</span>
        <span class="k">egress</span><span class="v mono">{sel.egress ?? "direct"}</span>
      </div>
      <LogView line={sel.line} label="stored record" />
      <p class="note">Metadata only — full bodies, attempt chains and egress live on the <a class="lnk" href="#/chats">Chats</a> page.</p>
    {:else if inspTab === "trace"}
      <p class="dsub">Each step shows duration · status · metadata where the server actually stored them.</p>
      <ol class="trace">
        <li class="tstep">
          <span class="tdot"></span>
          <div><p class="tt">Incoming Request</p><p class="tm mono">{sel.method} {sel.path} · {time(sel.ts)}</p></div>
        </li>
        <li class="tstep na">
          <span class="tdot"></span>
          <div><p class="tt">Policy Evaluation</p><p class="tm ns">not stored — the gateway does not persist policy decisions per request</p></div>
        </li>
        <li class="tstep na">
          <span class="tdot"></span>
          <div><p class="tt">Provider Selection</p><p class="tm ns">not stored — per-request provider/model is not retained (see Usage 24h for aggregates)</p></div>
        </li>
        <li class="tstep na">
          <span class="tdot"></span>
          <div><p class="tt">Provider Request</p><p class="tm ns">not stored — upstream latency is folded into the total duration below</p></div>
        </li>
        <li class="tstep">
          <span class="tdot"></span>
          <div><p class="tt">Response</p><p class="tm mono">status {sel.status} · {ms(sel.dur_ms)}</p></div>
        </li>
      </ol>
      <LogView line={sel.line} label="stored record" />
    {:else if inspTab === "request"}
      <div class="kv">
        <span class="k">method</span><span class="v mono">{sel.method}</span>
        <span class="k">path</span><span class="v mono">{sel.path}</span>
        <span class="k">headers</span><span class="v ns">not stored</span>
        <span class="k">body</span><span class="v ns">not stored — payloads are never persisted</span>
        <span class="k">parameters</span><span class="v ns">not stored</span>
      </div>
      <LogView line={sel.line} label="stored record" />
    {:else if inspTab === "response"}
      <div class="kv">
        <span class="k">status</span><span class="v mono {statusCls(sel.status)}">{sel.status}</span>
        <span class="k">duration</span><span class="v mono">{ms(sel.dur_ms)}</span>
        <span class="k">body</span><span class="v ns">not stored</span>
        <span class="k">headers</span><span class="v ns">not stored</span>
        <span class="k">usage</span><span class="v ns">not stored — token counts live in the Usage 24h rollup, not per request</span>
      </div>
      <LogView line={sel.line} label="stored record" />
    {:else}
      <div class="kv">
        <span class="k">seq</span><span class="v mono">{num(sel.seq)}</span>
        <span class="k">timestamp</span><span class="v mono">{time(sel.ts)}</span>
        <span class="k">region</span><span class="v ns">not stored</span>
        <span class="k">environment</span><span class="v ns">not stored</span>
        <span class="k">route</span><span class="v ns">not stored</span>
        <span class="k">api key</span><span class="v ns">not stored</span>
        <span class="k">user agent</span><span class="v ns">not stored</span>
      </div>
    {/if}
  </Drawer>
{/if}

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
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
    flex-wrap: wrap;
  }
  .toolbar {
    padding: 12px 16px 0;
  }
  .errbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 16px 0;
    padding: 8px 10px;
    border: 1px solid rgba(255, 77, 94, 0.35);
    border-radius: var(--radius-ctl);
    background: rgba(255, 77, 94, 0.06);
    color: var(--color-bad);
    font-size: 12px;
  }
  .errbar span {
    flex: 1;
  }
  .row {
    cursor: pointer;
  }
  /* row-enter: new seqs rise once over the panel duration (160–300ms band) */
  .row.fresh {
    animation: rise var(--dur-panel) var(--ease-out) 1;
  }
  .row:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  tbody tr:not(.detail):hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .m-method {
    color: var(--color-ink-muted);
  }
  .path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 340px;
  }
  .prov {
    color: var(--color-ink);
    font-weight: 500;
  }
  .r {
    text-align: right;
  }
  .dim {
    color: var(--color-ink-faint);
  }
  .st-ok {
    color: var(--color-ok);
  }
  .st-warn {
    color: var(--color-warn);
  }
  .st-bad {
    color: var(--color-bad);
  }
  /* status hues cross over 160ms (§42 micro) instead of snapping */
  .st-ok, .st-warn, .st-bad {
    transition: color var(--dur-micro) var(--ease-out);
  }
  /* inline latency bar: width ∝ row duration / page max, grows over 300ms */
  .lat {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .latbar {
    width: 44px;
    height: 4px;
    border-radius: 2px;
    background: var(--color-elevated);
    overflow: hidden;
    flex: none;
  }
  .latbar i {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--color-blue);
    border-radius: 2px;
    transition: width var(--dur-panel) var(--ease-out);
  }
  /* new-batch pill: offered, never auto-scrolled */
  .batch-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 16px 0;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-ctl);
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    color: var(--color-ink-soft);
    animation: rise var(--dur-panel) var(--ease-out) 1;
  }
  .batch-pill span {
    flex: 1;
  }
  .trace { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
  .tstep { display:flex; gap:10px; padding:8px 0; border-bottom:1px dashed var(--color-edge); }
  .tstep:last-child { border-bottom:none; }
  .tdot { width:8px; height:8px; border-radius:50%; margin-top:4px; flex:none; background:var(--color-ok); }
  .tstep.na .tdot { background:var(--color-elevated); border:1px solid var(--color-edge-strong); }
  .tt { margin:0; font-size:12.5px; font-weight:600; color:var(--color-ink); }
  .tm { margin:2px 0 0; font-size:11.5px; color:var(--color-ink-muted); }
  .ns { color:var(--color-ink-faint); font-style:italic; }
  .dsub { margin:0 0 10px; font-size:11.5px; color:var(--color-ink-faint); line-height:1.5; }
  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 14px;
    margin-bottom: 8px;
    font-size: 11.5px;
  }
  .kv .k {
    color: var(--color-ink-faint);
    text-transform: uppercase;
    font-size: 9.5px;
    letter-spacing: 0.08em;
    align-self: center;
  }
  .kv .v {
    color: var(--color-ink-soft);
  }
  .note {
    margin: 8px 0 0;
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .note .lnk { color: var(--color-blue-bright); }
  .nomatch {
    color: var(--color-ink-faint);
    text-align: center;
    padding: 22px 16px !important;
  }
  .foot {
    margin: 0;
    padding: 10px 16px 12px;
    border-top: 1px solid var(--color-edge);
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .skel {
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sk-row {
    height: 26px;
    border-radius: var(--radius-ctl);
    background: linear-gradient(180deg, #0b0b11, #0d0d15);
    border: 1px solid var(--color-edge);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
  }
</style>

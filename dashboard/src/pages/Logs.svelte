<script lang="ts">
  // SCREEN — Logs (§30): infrastructure request log. Level chips, text filter,
  // row click reveals the raw stored line. Monospace on technical cells only.
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Input from "../components/Input.svelte";
  import Select from "../components/Select.svelte";
  import Badge from "../components/Badge.svelte";
  import DataTable, { type DataColumn } from "../components/DataTable.svelte";
  import Pagination from "../components/Pagination.svelte";
  import LogView from "../components/LogView.svelte";
  import { onMount, onDestroy } from "svelte";
  import { api, type LogRow } from "../lib/api.ts";
  import { ms, time } from "../lib/format.ts";

  type Level = "INFO" | "WARN" | "ERROR";
  function level(s: number): Level {
    if (s >= 500 || s === 499) return "ERROR";
    if (s >= 400) return "WARN";
    return "INFO";
  }
  function statusCls(s: number): string {
    const l = level(s);
    return l === "ERROR" ? "st-bad" : l === "WARN" ? "st-warn" : "st-ok";
  }

  let rows = $state<LogRow[]>([]);
  let limit = $state(400);
  let q = $state("");
  let fKey = $state("");
  let fProvider = $state("");
  let fStatus = $state("");
  let err = $state<string | null>(null);
  let booted = $state(false);
  let openSeq = $state<number | null>(null);

  function activeOpts(): { keyId?: string; provider?: string; status?: number } {
    const o: { keyId?: string; provider?: string; status?: number } = {};
    const k = fKey.trim();
    const p = fProvider.trim();
    const s = fStatus.trim();
    if (k) o.keyId = k;
    if (p) o.provider = p;
    if (s !== "") {
      const n = Number.parseInt(s, 10);
      if (Number.isFinite(n)) o.status = n;
    }
    return o;
  }
  const hasFilter = $derived(fKey.trim() !== "" || fProvider.trim() !== "" || fStatus.trim() !== "");

  const shown = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.line.toLowerCase().includes(needle) ||
        r.path.toLowerCase().includes(needle) ||
        String(r.status).includes(needle),
    );
  });
  const counts = $derived.by(() => ({
    warn: rows.filter((r) => level(r.status) === "WARN").length,
    err: rows.filter((r) => level(r.status) === "ERROR").length,
  }));
  async function refresh(): Promise<void> {
    try {
      const r = await api.logs(limit, activeOpts());
      rows = r.rows;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }
  function setLimit(v: string): void {
    limit = Number(v);
    openSeq = null;
    page = 1;
    void refresh();
  }
  function toggleRow(seq: number): void {
    openSeq = openSeq === seq ? null : seq;
  }
  function applyFilters(): void {
    openSeq = null;
    page = 1;
    void refresh();
  }
  function clearFilters(): void {
    fKey = "";
    fProvider = "";
    fStatus = "";
    openSeq = null;
    page = 1;
    void refresh();
  }
  /** Real download link — the server streams the file with Content-Disposition. */
  function exportUrl(kind: "jsonl" | "csv"): string {
    return api.exportLogsUrl({ format: kind, ...activeOpts() });
  }
  type LKey = "ts" | "status" | "dur_ms";
  let sortKey = $state<LKey>("ts");
  let asc = $state(false);
  let page = $state(1);
  const PER = 50;
  function toggleSort(k: LKey): void {
    if (k === sortKey) asc = !asc;
    else {
      sortKey = k;
      asc = false;
    }
  }
  const sorted = $derived.by(() => {
    const dir = asc ? 1 : -1;
    return [...shown].sort((a, b) => dir * ((a[sortKey] ?? -1) - (b[sortKey] ?? -1)));
  });
  const paged = $derived(sorted.slice((page - 1) * PER, page * PER));
  const cols: DataColumn[] = [
    { key: "level", label: "Level" },
    { key: "ts", label: "Time", sortable: true },
    { key: "method", label: "Method" },
    { key: "path", label: "Path" },
    { key: "status", label: "Status", align: "right", sortable: true },
    { key: "dur", label: "Duration", align: "right", sortable: true },
  ];
  function badgeTone(s: number): "ok" | "warn" | "bad" {
    const l = level(s);
    return l === "ERROR" ? "bad" : l === "WARN" ? "warn" : "ok";
  }
  $effect(() => {
    q;
    openSeq = null;
    page = 1;
  });

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 4000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Logs</h1>
    <p class="sub">
      {#if !booted}
        loading request log…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
      {:else}
        {shown.length} of {rows.length} entries · {counts.err ? `${counts.err} errors` : "no errors"} · {counts.warn ? `${counts.warn} warnings` : "no warnings"} · newest first
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    {#snippet searchIcon()}<Icon name="search" size={13} />{/snippet}
    <Input bind:value={q} placeholder="filter line · path · status" label="Filter log entries" width="180px" icon={searchIcon} />
    <Input bind:value={fKey} placeholder="key id" label="Filter by client key id" width="110px" onEnter={applyFilters} />
    <Input bind:value={fProvider} placeholder="provider" label="Filter by provider id" width="110px" onEnter={applyFilters} />
    <Input bind:value={fStatus} placeholder="status" label="Filter by exact HTTP status" width="80px" onEnter={applyFilters} />
    <Select
      value={String(limit)}
      options={[{ value: "100", label: "100" }, { value: "400", label: "400" }, { value: "1000", label: "1000" }]}
      label="Log limit"
      prefix="limit"
      compact
      onchange={(v) => setLimit(v)}
    />
    <Button variant="secondary" onclick={applyFilters}>Apply</Button>
    {#if hasFilter}<Button variant="ghost" onclick={clearFilters}>Clear</Button>{/if}
    <a class="dl" href={exportUrl("csv")}>Export CSV</a>
    <a class="dl" href={exportUrl("jsonl")}>Export JSONL</a>
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

{#if !booted}
  <Panel title="Request Log" sub="ring buffer · newest first" pad={false}>
    <div class="skel">
      {#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}<div class="sk-row"></div>{/each}
    </div>
  </Panel>
{:else if !rows.length}
  <Panel title="Request Log" pad={false}>
    <EmptyState
      title={hasFilter ? "No entries match these filters" : "No log entries yet"}
      desc={hasFilter ? "The server returned zero rows for this key / provider / status combination. Loosen the filters and try again." : "The ring buffer fills as soon as the router serves its first request. Nothing has hit this server yet."}
    >
      {#snippet action()}
        {#if hasFilter}
          <Button variant="primary" onclick={clearFilters}>Clear filters</Button>
        {:else}
          <Button variant="primary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Reload</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </Panel>
{:else}
  <Panel title="Request Log" sub="click a row to reveal the raw line" pad={false}>
    {#if err}
      <div class="errbar">
        <Icon name="bolt" size={13} />
        <span>last refresh failed — server unreachable: {err}</span>
        <Button variant="ghost" onclick={() => void refresh()}>Retry</Button>
      </div>
    {/if}
    <DataTable
      columns={cols}
      sortKey={sortKey}
      sortDir={asc ? "asc" : "desc"}
      onSort={(k) => toggleSort(k as LKey)}
      label="Request log"
    >
      <tbody>
        {#each paged as l (l.seq)}
            <tr
              class="row"
              class:open={openSeq === l.seq}
              tabindex="0"
              aria-expanded={openSeq === l.seq}
              onclick={() => toggleRow(l.seq)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(l.seq); } }}
            >
              <td><Badge tone={badgeTone(l.status)} dot={false}>{level(l.status)}</Badge></td>
              <td class="mono">{time(l.ts)}</td>
              <td class="mono m-method">{l.method}</td>
              <td class="path">{l.path}</td>
              <td class="r mono {statusCls(l.status)}">{l.status}</td>
              <td class="r mono dim">{ms(l.dur_ms)}</td>
            </tr>
            {#if openSeq === l.seq}
              <tr class="detail">
                <td colspan="6">
                  <LogView line={l.line} label="raw log line" />
                  {#if l.provider ?? l.model ?? l.combo ?? l.key_id ?? l.error}
                    <dl class="meta">
                      {#if l.provider}<div><dt>provider</dt><dd class="mono">{l.provider}</dd></div>{/if}
                      {#if l.model}<div><dt>model</dt><dd class="mono">{l.model}</dd></div>{/if}
                      {#if l.combo}<div><dt>combo</dt><dd class="mono">{l.combo}</dd></div>{/if}
                      {#if l.key_id}<div><dt>key</dt><dd class="mono">{l.key_id}</dd></div>{/if}
                      {#if l.tokens_in != null || l.tokens_out != null}<div><dt>tokens</dt><dd class="mono">{l.tokens_in ?? 0} in · {l.tokens_out ?? 0} out</dd></div>{/if}
                      {#if l.cost_usd != null}<div><dt>cost</dt><dd class="mono">${l.cost_usd.toFixed(6)}</dd></div>{/if}
                      {#if l.error}<div><dt>error</dt><dd>{l.error}</dd></div>{/if}
                    </dl>
                  {/if}
                </td>
              </tr>
            {/if}
          {:else}
            <tr><td colspan="6" class="nomatch">No entries match “{q}” — try a path fragment or a status code.</td></tr>
          {/each}
        </tbody>
    </DataTable>
    <Pagination total={sorted.length} bind:page={page} perPage={PER} />
    <p class="foot">Levels are derived from HTTP status (≥500 or 499 → ERROR · ≥400 → WARN · else INFO) — the log stores no level, service, route or request-id columns, and DEBUG is never emitted. Export links download the active server-side filters (key / provider / status) straight from the server.</p>
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
    align-items: center;
    flex-wrap: wrap;
  }
  .dl {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 11px;
    border-radius: var(--radius-ctl);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 28px;
    white-space: nowrap;
    text-decoration: none;
    background: var(--color-elevated);
    color: var(--color-ink);
    border: 1px solid var(--color-edge-strong);
  }
  .dl:hover {
    border-color: #34344c;
    background: #16161f;
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 6px 16px;
    margin: 8px 0 0;
    padding: 8px 10px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
  }
  .meta div { display: flex; gap: 8px; align-items: baseline; }
  .meta dt { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-ink-faint); }
  .meta dd { margin: 0; font-size: 11.5px; color: var(--color-ink-soft); overflow-wrap: anywhere; }
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
  .row:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .row.open td {
    background: rgba(255, 255, 255, 0.028);
    border-bottom-color: transparent;
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
    max-width: 420px;
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
  .detail td {
    padding: 0 16px 12px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
    background: rgba(255, 255, 255, 0.028);
  }
  .nomatch {
    color: var(--color-ink-faint);
    text-align: center;
    padding: 22px 16px !important;
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
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .foot {
    margin: 0;
    padding: 10px 16px 12px;
    border-top: 1px solid var(--color-edge);
    font-size: 11.5px;
    color: var(--color-ink-faint);
    line-height: 1.5;
  }
  @media (max-width: 900px) {
    .path {
      max-width: 180px;
    }
  }
</style>

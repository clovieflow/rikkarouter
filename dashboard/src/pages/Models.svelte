<script lang="ts">
  // SCREEN — Model Catalog (§24). Derived from registry() only — /v1/models needs an
  // Authorization header and is not called from the dashboard. No capabilities or
  // pricing columns: the server does not expose them yet, so we do not fake them.
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Input from "../components/Input.svelte";
  import Select from "../components/Select.svelte";
  import FilterChip from "../components/FilterChip.svelte";
  import Badge from "../components/Badge.svelte";
  import DataTable, { type DataColumn } from "../components/DataTable.svelte";
  import Pagination from "../components/Pagination.svelte";
  import { onMount, onDestroy } from "svelte";
  import { api, type RegistryProvider, type Connection } from "../lib/api.ts";
  import { num } from "../lib/format.ts";

  interface FlatModel {
    key: string;
    id: string;
    name: string;
    providerId: string;
    providerName: string;
    priority: number;
    free: boolean;
    experimental: boolean;
  }

  let registry = $state<RegistryProvider[]>([]);
  let conns = $state<Connection[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);

  let q = $state("");
  let prov = $state("");
  let onlyFree = $state(false);
  let onlyConn = $state(false);

  const connectedIds = $derived(new Set(conns.map((c) => c.provider)));

  const all = $derived<FlatModel[]>(
    registry.flatMap((p) =>
      p.models.map((m) => ({
        key: `${p.id}:${m.id}`,
        id: m.id,
        name: m.name,
        providerId: p.id,
        providerName: p.name,
        priority: p.priority,
        free: p.free,
        experimental: p.experimental,
      })),
    ),
  );

  const provOrder = $derived([...registry].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)));

  const filtered = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((m) => {
        if (prov && m.providerId !== prov) return false;
        if (onlyFree && !m.free) return false;
        if (onlyConn && !connectedIds.has(m.providerId)) return false;
        if (needle && !m.id.toLowerCase().includes(needle) && !m.name.toLowerCase().includes(needle) && !m.providerName.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  });

  type MSort = "id" | "providerName";
  let mSortKey = $state<MSort | null>(null);
  let mAsc = $state(true);
  let page = $state(1);
  const PER = 50;
  function toggleModelSort(k: MSort): void {
    if (k === mSortKey) mAsc = !mAsc;
    else {
      mSortKey = k;
      mAsc = true;
    }
    page = 1;
  }
  const sortedModels = $derived.by(() => {
    if (!mSortKey) return filtered;
    const dir = mAsc ? 1 : -1;
    return [...filtered].sort((a, b) =>
      mSortKey === "id" ? dir * a.id.localeCompare(b.id) : dir * a.providerName.localeCompare(b.providerName),
    );
  });
  const paged = $derived(sortedModels.slice((page - 1) * PER, page * PER));
  const cols: DataColumn[] = [
    { key: "id", label: "Model", sortable: true },
    { key: "providerName", label: "Provider", sortable: true },
    { key: "avail", label: "Availability" },
  ];
  $effect(() => {
    q;
    prov;
    onlyFree;
    onlyConn;
    page = 1;
  });
  const filtering = $derived(!!q.trim() || !!prov || onlyFree || onlyConn);

  function clearFilters() {
    q = "";
    prov = "";
    onlyFree = false;
    onlyConn = false;
  }

  async function refresh() {
    try {
      const [r, c] = await Promise.all([api.registry(), api.connections()]);
      registry = r.providers;
      conns = c.providers;
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
    timer = setInterval(refresh, 5000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Models</h1>
    <p class="sub">
      {#if !booted}
        loading catalog…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
      {:else}
        {num(all.length)} models · {registry.length} providers · {connectedIds.size} connected
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

<div class="filters" role="search">
  {#snippet searchIcon()}<Icon name="search" size={13} />{/snippet}
  <Input bind:value={q} type="search" placeholder="Search model, alias, provider…" label="Search models" roomy icon={searchIcon} />
  <Select
    bind:value={prov}
    options={[{ value: "", label: "All providers" }, ...provOrder.map((p) => ({ value: p.id, label: `${p.name}${connectedIds.has(p.id) ? "" : " (not connected)"}` }))]}
    label="Filter by provider"
  />
  <FilterChip active={onlyFree} label="Free only" onclick={() => (onlyFree = !onlyFree)} />
  <FilterChip active={onlyConn} label="With connection" onclick={() => (onlyConn = !onlyConn)} />
  {#if filtering}
    <Button variant="ghost" onclick={clearFilters}><Icon name="x" size={12} /> Clear</Button>
  {/if}
  <span class="fcount" aria-live="polite">{num(filtered.length)} shown</span>
</div>

{#if !booted}
  <div class="skeleton sk-table"></div>
{:else if all.length === 0}
  <Panel pad={false}>
    <EmptyState
      title="Registry is empty"
      desc="The server returned no providers. Check that the rikka process is running and its registry directory is populated."
    >
      {#snippet action()}
        <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Retry</Button>
      {/snippet}
    </EmptyState>
  </Panel>
{:else if filtered.length === 0}
  <Panel pad={false}>
    <EmptyState
      title="No models match"
      desc="Nothing in the catalog satisfies the current search and filters. Widen the query or clear the filters to see all {num(all.length)} models."
    >
      {#snippet action()}
        <Button variant="primary" onclick={clearFilters}>Clear filters</Button>
      {/snippet}
    </EmptyState>
  </Panel>
{:else}
  <Panel title="Catalog" sub="provider priority, then model id" pad={false}>
    <DataTable
      columns={cols}
      sortKey={mSortKey}
      sortDir={mAsc ? "asc" : "desc"}
      onSort={(k) => toggleModelSort(k as MSort)}
      label="Model catalog"
    >
      <tbody>
        {#each paged as m (m.key)}
          <tr>
            <td class="mid">
              <span class="mid-id">{m.id}</span>
              {#if m.name && m.name !== m.id}<span class="mid-name">{m.name}</span>{/if}
            </td>
            <td>
              <span class="pdot" class:live={connectedIds.has(m.providerId)} aria-hidden="true"></span>
              <span class="pn">{m.providerName}</span>
            </td>
            <td class="chips">
              {#if m.free}<Badge tone="ok">free</Badge>{/if}
              {#if m.experimental}<Badge tone="warn">experimental</Badge>{/if}
              {#if !m.free && !m.experimental}<Badge tone="muted">standard</Badge>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </DataTable>
    <Pagination total={sortedModels.length} bind:page={page} perPage={PER} />
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
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
    background: var(--color-base);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-panel);
    margin-bottom: 14px;
  }
  .filters :global(.field) {
    flex: 1 1 240px;
    min-width: 200px;
  }
  .fcount {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-faint);
  }
  .mid {
    max-width: 420px;
  }
  .mid-id {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--color-ink);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mid-name {
    font-size: 11px;
    color: var(--color-ink-faint);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pdot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-edge-strong);
    margin-right: 7px;
  }
  .pdot.live {
    background: var(--color-blue);
    box-shadow: var(--glow-blue);
  }
  .pn {
    color: var(--color-ink-soft);
    font-weight: 500;
  }
  .chips {
    white-space: nowrap;
  }
  .chips :global(.badge + .badge) {
    margin-left: 5px;
  }
  .skeleton {
    background: linear-gradient(180deg, var(--color-raised), var(--color-elevated));
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-panel);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
  }
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .sk-table {
    height: 320px;
  }
</style>

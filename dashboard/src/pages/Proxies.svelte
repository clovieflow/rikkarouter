<script lang="ts">
  // Proxies — pool management: private lists, labels, priority, quarantine, manual probe.
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Input from "../components/Input.svelte";
  import DataTable from "../components/DataTable.svelte";
  import { api, type ProxyRow } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";

  let pool = $state<{ total: number; healthy: number; checkedAt: number | null } | null>(null);
  let rows = $state<ProxyRow[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);
  let busy = $state(false);

  let addText = $state("");
  let addLabel = $state("");
  let addMsg = $state<string | null>(null);
  let addErr = $state<string | null>(null);

  let probeBusy = $state<string | null>(null);
  let probeRes = $state<Record<string, string>>({});

  async function refresh() {
    try {
      const p = await api.proxyPool();
      pool = { total: p.total, healthy: p.healthy, checkedAt: p.checkedAt };
      rows = (p as unknown as { proxies: ProxyRow[] }).proxies ?? [];
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  async function add() {
    if (!addText.trim() || busy) return;
    busy = true;
    addErr = null;
    addMsg = null;
    try {
      const r = await api.addProxies({ text: addText, label: addLabel.trim() || undefined });
      addMsg = `Pool accepted ${r.added} of ${r.total} parsed. Probing runs in the background.`;
      addText = "";
      await refresh();
    } catch (e) {
      addErr = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove(url: string) {
    try {
      await api.removeProxy(url);
      await refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }

  async function setPrio(url: string, priority: number) {
    try {
      await api.setProxyMeta(url, { priority });
      await refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }

  async function probe(url: string) {
    probeBusy = url;
    try {
      const r = await api.probeProxy(url);
      probeRes = { ...probeRes, [url]: r.ok ? `ok ${r.latencyMs}ms` : "failed — unreachable or blocked" };
      await refresh();
    } catch (e) {
      probeRes = { ...probeRes, [url]: (e as Error).message };
    } finally {
      probeBusy = null;
    }
  }

  function quarantined(r: ProxyRow) {
    return r.quarantined_until > Date.now();
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    refresh();
    timer = setInterval(refresh, 10000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <p class="crumb">rikka / Proxies</p>
    <h1>Proxies</h1>
    <p class="sub">Auto pool for per-IP limits. Lower priority number wins — keep private lists at 10, free lists at 100+. Quarantined proxies sit out automatically.</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={refresh}>Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton" style="height:220px"></div>
{:else if err && !rows.length}
  <Panel><p class="form-err">{err}</p><Button variant="secondary" onclick={refresh}>Retry</Button></Panel>
{:else}
  <Panel title="Pool" sub="{pool?.healthy ?? 0} healthy / {pool?.total ?? 0} known{pool?.checkedAt ? ` · checked ${ago(pool.checkedAt)}` : ''}">
    <p class="dim-note">Traffic stays HTTPS end-to-end — a proxy only ever sees the destination hostname. URLs with credentials are masked everywhere outside the server.</p>
  </Panel>

  <Panel title="Add proxies" sub="host:port, user:pass@host:port, or ip:port:user:pass — one per line">
    <div class="frow">
      <Input bind:value={addLabel} label="Label (e.g. webshare-private)" width="220px" />
    </div>
    <textarea bind:value={addText} placeholder={"proxy.webshare.io:8080:user:pass\nuser:pass@45.38.107.97:6014\n31.59.20.176:6754"} rows={4} class="ta"></textarea>
    <div class="row">
      <Button variant="primary" onclick={add} disabled={busy || !addText.trim()}>{busy ? "Adding…" : "Add to pool"}</Button>
    </div>
    {#if addMsg}<p class="okmsg">{addMsg}</p>{/if}
    {#if addErr}<p class="form-err">{addErr}</p>{/if}
  </Panel>

  <Panel title="Known proxies" sub="{rows.length} shown">
    <DataTable columns={[{ key: "url", label: "Proxy" }, { key: "label", label: "Label" }, { key: "prio", label: "Prio", align: "right" }, { key: "st", label: "Status" }, { key: "lat", label: "Latency", align: "right" }, { key: "fails", label: "Fails", align: "right" }, { key: "act", label: "Actions", align: "right" }]} label="Proxy pool">
      <tbody>
        {#each rows as r (r.url)}
          <tr>
            <td class="mono">{r.url}</td>
            <td class="dim">{r.label || "—"}</td>
            <td class="r mono">
              <button class="mini" onclick={() => setPrio(r.url, r.priority - 10)} title="higher priority">−</button>
              {r.priority}
              <button class="mini" onclick={() => setPrio(r.url, r.priority + 10)} title="lower priority">+</button>
            </td>
            <td>
              {#if quarantined(r)}<span class="warn" title="sits out until {new Date(r.quarantined_until).toLocaleTimeString()}">quarantined</span>
              {:else if r.ok}<span class="ok">healthy</span>
              {:else}<span class="dim">unchecked/dead</span>{/if}
              {#if probeRes[r.url]} <span class="dim mono">{probeRes[r.url]}</span>{/if}
            </td>
            <td class="r mono dim">{r.latency_ms != null ? `${r.latency_ms}ms` : "—"}</td>
            <td class="r mono dim">{r.fails}</td>
            <td class="r">
              <button class="mini" onclick={() => probe(r.url)} disabled={probeBusy === r.url}>{probeBusy === r.url ? "…" : "Probe"}</button>
              <button class="mini danger" onclick={() => remove(r.url)}>Remove</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </DataTable>
  </Panel>
{/if}

<style>
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; }
  .crumb { font-size: 12px; color: var(--color-ink-faint); margin: 0; }
  .sub { font-size: 12.5px; color: var(--color-ink-muted); margin: 4px 0 0; max-width: 760px; }
  .hdr-actions { display: flex; gap: 8px; }
  .frow { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 10px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .ta { width: 100%; min-height: 90px; padding: 8px; border: 1px solid var(--color-edge); border-radius: 6px; background: var(--color-bg); color: var(--color-ink); font-family: ui-monospace, monospace; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; font-size: 11.5px; }
  .dim { color: var(--color-ink-muted); }
  .r { text-align: right; }
  .ok { color: var(--color-ok); }
  .warn { color: var(--color-warn); }
  .form-err { color: var(--color-bad); font-size: 12px; }
  .okmsg { color: var(--color-ok); font-size: 12px; }
  .dim-note { font-size: 11px; color: var(--color-ink-faint); }
  .mini { border: 1px solid var(--color-edge); background: var(--color-bg); color: var(--color-ink-muted); border-radius: 6px; font-size: 11px; padding: 2px 8px; cursor: pointer; margin-left: 4px; }
  .mini:hover:not(:disabled) { border-color: var(--color-pink); color: var(--color-pink); }
  .mini.danger:hover { border-color: var(--color-bad); color: var(--color-bad); }
  .skeleton { border-radius: 10px; background: var(--color-panel); min-height: 220px; }
</style>

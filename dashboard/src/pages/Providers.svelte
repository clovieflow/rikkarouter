<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, type Connection, type RegistryProvider } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { go } from "../lib/nav.ts";

  let conns = $state<Connection[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);

  let adding = $state(false);
  let fProvider = $state("");
  let fKey = $state("");
  let fName = $state("");
  let fUrl = $state("");
  let fProxy = $state("");
  let fSlug = $state("");
  let fProxyMode = $state<"off" | "manual" | "auto">("off");
  let pool = $state<{ total: number; healthy: number; checkedAt: number | null } | null>(null);
  let poolBusy = $state(false);
  let formErr = $state<string | null>(null);
  let busy = $state(false);
  let flashId = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout>;


  const byId = $derived(new Map(registry.map((p) => [p.id, p])));
  const connectedIds = $derived(new Set(conns.map((c) => c.provider)));
  const selProv = $derived(byId.get(fProvider));

  function getGroups() {
    const map = new Map<string, Connection[]>();
    for (const c of conns) {
      const list = map.get(c.provider);
      if (list) list.push(c);
      else map.set(c.provider, [c]);
    }
    return [...map.entries()]
      .map(([id, list]) => ({
        id,
        prov: byId.get(id),
        name: byId.get(id)?.name ?? id,
        conns: [...list].sort((a, b) => b.created_at - a.created_at),
      }))
      .sort((a, b) => (a.prov?.priority ?? 999) - (b.prov?.priority ?? 999) || a.name.localeCompare(b.name));
  }
  const groups = $derived.by(() => getGroups());

  const formGroups = $derived.by(() => {
    const connected: RegistryProvider[] = [];
    const free: RegistryProvider[] = [];
    const exp: RegistryProvider[] = [];
    const rest: RegistryProvider[] = [];
    for (const p of registry) {
      if (p.authType === "oauth") continue; // API-key providers only
      if (connectedIds.has(p.id)) connected.push(p);
      else if (p.free) free.push(p);
      else if (p.experimental) exp.push(p);
      else rest.push(p);
    }
    return [
      { label: "Connected", items: connected },
      { label: "Free tier", items: free },
      { label: "Experimental", items: exp },
      { label: "Available", items: rest },
    ].filter((g) => g.items.length);
  });

  // (OAuth catalog hidden from display — API-key providers only.)

  async function refresh() {
    try {
      const [c, r] = await Promise.all([api.connections(), api.registry()]);
      conns = c.providers;
      registry = r.providers;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
    try {
      pool = await api.proxyPool();
    } catch {
      pool = null;
    }
  }
  async function refreshPoolNow() {
    poolBusy = true;
    try {
      const r = await api.refreshProxyPool();
      pool = { total: r.total, healthy: r.healthy, checkedAt: Date.now() };
    } catch (e) {
      err = (e as Error).message;
    } finally {
      poolBusy = false;
    }
  }
  const isCustom = $derived(fProvider === "__custom__");
  function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "endpoint";
  }
  async function add() {
    formErr = null;
    const provider = isCustom ? `custom-${slugify(fSlug || fName)}` : fProvider;
    if (!provider || (!fKey.trim() && !isCustom)) {
      formErr = "Provider and API key are required.";
      return;
    }
    if (isCustom && !fUrl.trim()) {
      formErr = "Custom endpoints need a base URL (e.g. https://my-host:11434/v1).";
      return;
    }
    busy = true;
    try {
      const res = await api.addConnection({ provider, apiKey: fKey.trim(), name: fName.trim() || undefined, baseUrl: fUrl.trim() || undefined, proxyUrl: fProxy.trim() || undefined, proxyMode: fProxyMode });
      flashId = res.id;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (flashId = null), 3000);
      adding = false;
      fProvider = "";
      fKey = "";
      fName = "";
      fUrl = "";
      fProxy = "";
      fProxyMode = "off";
      await refresh();
    } catch (e) {
      formErr = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function del(id: string) {
    try {
      await api.removeConnection(id);
      pendingDel = null;
      clearTimeout(delTimer);
      await refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }
  function requestDel(id: string) {
    pendingDel = id;
    clearTimeout(delTimer);
    delTimer = setTimeout(() => (pendingDel = null), 4000);
  }
  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    refresh();
    timer = setInterval(refresh, 5000);
  });
  onDestroy(() => clearInterval(timer));

  let pendingDel: string | null = $state(null);
  let delTimer: ReturnType<typeof setTimeout>;
  let keyFor: string | null = $state(null);
  let keyVal = $state("");
  let keyBusy = $state(false);
  let keyErr = $state<Record<string, string>>({});
  async function addKey(pid: string) {
    if (!keyVal.trim() || keyBusy) return;
    keyBusy = true;
    keyErr = { ...keyErr, [pid]: "" };
    try {
      const res = await api.addConnection({ provider: pid, apiKey: keyVal.trim() });
      flashId = res.id;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (flashId = null), 3000);
      keyFor = null;
      keyVal = "";
      await refresh();
    } catch (e) {
      keyErr = { ...keyErr, [pid]: (e as Error).message };
    } finally {
      keyBusy = false;
    }
  }
</script>

{#if !booted}
  <div class="skeleton sk-table"></div>
{:else if err}
  <Panel><p class="form-err">{err}</p><Button variant="secondary" onclick={refresh}>Retry</Button></Panel>
{:else}
  <Panel title="Connect API-key providers" sub="Credentials stay in ~/.rikka/rikka.db · {conns.length} connections · {connectedIds.size} providers">
    <p class="o-desc">Add one API key per connection — multiple keys per provider are allowed.</p>
    <div class="row" style="margin-top:10px">
      <Button variant="primary" onclick={() => (adding = !adding)}><Icon name="plus" size={13} /> {adding ? "Close" : "Connect Provider"}</Button>
      <Button variant="secondary" onclick={refresh}><Icon name="refresh" size={13} /> Refresh</Button>
    </div>
  </Panel>

  {#if adding}
    <Panel title="Connect Provider" sub="one API key per connection · multiple keys per provider allowed">
      <form onsubmit={(e) => { e.preventDefault(); add(); }} class="form">
        <label>Provider
          <select bind:value={fProvider} required>
            <option value="" disabled>Select provider</option>
            <option value="__custom__">Custom endpoint… (any OpenAI-compatible URL)</option>
            {#each formGroups as g}
              <optgroup label={g.label}>
                {#each g.items as p (p.id)}
                  <option value={p.id}>{p.name} · {p.models.length} models</option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>
        {#if fProvider && connectedIds.has(fProvider)}
          <p class="dim-note">Already connected — this adds another key. Requests round-robin across keys and fail over on 429.</p>
        {/if}
        {#if isCustom}
          <label>Endpoint ID (slug)
            <input bind:value={fSlug} placeholder="my-llama" />
          </label>
          <p class="dim-note">Models are addressed verbatim: <span class="mono">custom-{slugify(fSlug || fName)}/any-model-name</span>. Auth is Bearer; leave the key empty for keyless local servers.</p>
        {/if}
        <label>API Key {isCustom ? "(optional — leave empty for keyless local servers)" : ""}
          <input bind:value={fKey} type="password" placeholder="sk-..." required={!isCustom} />
        </label>
        <label>Label (optional)
          <input bind:value={fName} placeholder="my key" />
        </label>
        <label>{isCustom ? "Base URL (required)" : "Base URL override (optional)"}
          <input bind:value={fUrl} placeholder={isCustom ? "https://my-host:11434/v1" : (selProv?.baseUrl ?? "https://provider.example/v1")} required={isCustom} />
        </label>
        <label>Proxy
          <select bind:value={fProxyMode}>
            <option value="off">Off (direct connection)</option>
            <option value="manual">Manual proxy URL</option>
            <option value="auto">Auto pool (free proxies, rotated)</option>
          </select>
        </label>
        {#if fProxyMode === "manual"}
          <label>Proxy URL
            <input bind:value={fProxy} placeholder="http://user:pass@proxy-host:8080" />
          </label>
        {:else if fProxyMode === "auto"}
          <p class="dim-note">Server picks a healthy free proxy per request and rotates on failure. Free proxies are slow and untrusted — fine for free tiers, not for sensitive keys.</p>
        {/if}
        {#if formErr}<p class="form-err">{formErr}</p>{/if}
        <div class="row">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</Button>
          <Button variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
        </div>
      </form>
    </Panel>
  {/if}


  {#if conns.length === 0}
    <Panel pad={false}>
      <EmptyState title="No providers connected" desc="The router has nothing to route to yet. Connect one API-key provider and traffic starts flowing immediately.">
        {#snippet action()}
          <Button variant="primary" onclick={() => (adding = true)}><Icon name="bolt" size={13} /> Connect Provider</Button>
        {/snippet}
      </EmptyState>
    </Panel>
  {:else}
    <Panel title="Connections" sub="grouped by provider · newest first" pad={false}>
      <table class="tbl">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Label</th>
            <th>Alias</th>
            <th>Status</th>
            <th class="r">Models</th>
            <th>Endpoint</th>
            <th>Created</th>
            <th class="r"><span class="vh">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each groups as g (g.id)}
            {#each g.conns as c, ci (c.id)}
              <tr class:flash={flashId === c.id} class:start={ci === 0} onclick={() => go(`/providers/${c.id}`)} style="cursor:pointer" title="Open provider detail">
                <td>
                  {#if ci === 0}
                    <div class="prov-cell">
                      <span class="pname">{g.name}</span>
                      {#if g.conns.length > 1}<span class="cnt" title="{g.conns.length} connections">×{g.conns.length}</span>{/if}
                    </div>
                  {/if}
                </td>
                <td class="mono dim">{c.name ? c.name : "—"}</td>
                <td class="mono dim">{g.prov?.alias ?? "—"}</td>
                <td><StatusPill tone={c.status === "active" ? "ok" : c.status === "cooldown" ? "warn" : "bad"} label={c.status === "cooldown" ? "in cooldown" : c.status} /></td>
                <td class="r mono dim">{g.prov?.models.length ?? "—"}</td>
                <td>
                  {#if c.base_url}
                    <span class="ovr" title={c.base_url}><Icon name="external" size={10} /> override</span>
                  {:else}
                    <span class="ep-auto">auto</span>
                  {/if}
                </td>
                <td class="mono dim">{ago(c.created_at)}</td>
                <td class="r">
                  {#if ci === 0}
                    <Button variant="secondary" title="Add another API key to {g.name} — requests round-robin across keys" onclick={(e) => { e.stopPropagation(); keyFor = keyFor === g.id ? null : g.id; keyVal = ""; }}>+ Key</Button>
                  {/if}
                  {#if pendingDel === c.id}
                    <Button variant="danger" title="Click again to remove this connection" onclick={(e) => { e.stopPropagation(); del(c.id); }}><Icon name="trash" size={12} /> Confirm remove</Button>
                  {:else}
                    <Button variant="danger" title="Remove connection" onclick={(e) => { e.stopPropagation(); requestDel(c.id); }}><Icon name="trash" size={12} /></Button>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if keyFor === g.id}
              <tr class="keyrow">
                <td colspan={8}>
                  <div class="form">
                    <div class="row">
                      <input type="password" placeholder="sk-… (new key for {g.name})" bind:value={keyVal} disabled={keyBusy} style="flex:1" onkeydown={(e) => { if (e.key === "Enter") void addKey(g.id); }} />
                      <Button variant="primary" onclick={() => void addKey(g.id)} disabled={keyBusy || !keyVal.trim()}>{keyBusy ? "Adding…" : "Add key"}</Button>
                      <Button variant="secondary" onclick={() => { keyFor = null; keyVal = ""; }}>Cancel</Button>
                    </div>
                    {#if keyErr[g.id]}<p class="form-err">{keyErr[g.id]}</p>{/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </Panel>
  {/if}

  <Panel title="Auto proxy pool" sub="free public proxies · rotated per request · only for connections set to Auto">
    {#if pool == null}
      <p class="dim-note">Pool status unavailable.</p>
    {:else}
      <p class="pool-line"><strong>{pool.healthy}</strong> healthy / {pool.total} known{pool.checkedAt ? ` · checked ${ago(pool.checkedAt)}` : ""}</p>
      <p class="dim-note">Free proxies are slow and untrusted — fine for free tiers, not for sensitive keys. Traffic stays HTTPS end-to-end either way.</p>
    {/if}
    <div class="row" style="margin-top:8px">
      <Button variant="secondary" onclick={() => void refreshPoolNow()} disabled={poolBusy}>{poolBusy ? "Refreshing…" : "Refresh pool now"}</Button>
    </div>
  </Panel>

{/if}

<style>
  .o-desc { font-size: 12px; color: var(--color-ink-muted); margin: 4px 0; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th, .tbl td { padding: 8px 10px; border-bottom: 1px solid var(--color-edge); text-align: left; font-size: 13px; }
  .tbl th { font-weight: 600; color: var(--color-ink-muted); background: var(--color-panel); }
  .tbl tr.flash { animation: flash 1.5s ease; }
  @keyframes flash { 0% { background: rgba(54,197,93,0.15); } 100% { background: transparent; } }
  .pool-line { font-size: 13px; margin: 0 0 4px; }
  .keyrow td { background: var(--color-panel); }
  .cnt { font-size: 11px; color: var(--color-ink-faint); background: var(--color-edge); border-radius: 999px; padding: 1px 6px; }
  .dim-note { margin: 2px 0 0; font-size: 11px; color: var(--color-ink-faint); line-height: 1.5; }
  .dim { color: var(--color-ink-muted); }
  .r { text-align: right; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .sk-table { height: 240px; }
  .ovr { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-ink-muted); border: 1px solid var(--color-edge); border-radius: 4px; padding: 1px 5px; }
  .ep-auto { font-size: 11px; color: var(--color-ink-faint); }
  .form { display: flex; flex-direction: column; gap: 8px; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .form input, .form select { padding: 6px 8px; border: 1px solid var(--color-edge); border-radius: 6px; background: var(--color-bg); color: var(--color-ink); }
  .form-err { color: var(--color-bad); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .pool-line { font-size: 13px; margin: 0 0 4px; }
</style>

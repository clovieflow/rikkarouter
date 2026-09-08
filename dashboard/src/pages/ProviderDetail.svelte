<script lang="ts">
  // Provider Detail (§23) — dedicated page per connection: view · edit · test · remove.
  import { onMount } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, type Connection, type RegistryProvider } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { go, route } from "../lib/nav.ts";

  const id = $derived(($route.split("/")[2] ?? "").split("?")[0]);

  let detail = $state<{ connection: Connection; provider: RegistryProvider | null; detectedModels?: Array<{ id: string; name: string }>; modelsCachedAt?: number | null } | null>(null);
  let err = $state<string | null>(null);
  let busy = $state(true);
  let testBusy = $state(false);
  let testRes = $state<{ ok: boolean; valid: boolean; status?: number; error?: string | null; latencyMs?: number } | null>(null);
  let editName = $state("");
  let editUrl = $state("");
  let editProxy = $state("");
  let editProxyMode = $state("off");
  let editPriority = $state(100);
  let editKey = $state("");
  let saveErr = $state<string | null>(null);
  let saveBusy = $state(false);
  let confirmDel = $state(false);
  let delBusy = $state(false);
  let detectBusy = $state(false);
  let detectErr = $state<string | null>(null);
  let keyTest = $state<Record<string, { busy: boolean; res: { ok: boolean; valid: boolean; status?: number; error?: string | null; latencyMs?: number } | null }>>({});
  let siblings = $state<Connection[]>([]);
  function kt(cid: string) { return keyTest[cid]?.res ?? null; }
  let newKey = $state("");
  let newKeyBusy = $state(false);
  let newKeyErr = $state<string | null>(null);
  async function testKey(cid: string) {
    keyTest = { ...keyTest, [cid]: { busy: true, res: keyTest[cid]?.res ?? null } };
    try {
      const r = await api.testConnection(cid);
      keyTest = { ...keyTest, [cid]: { busy: false, res: r } };
    } catch (e) {
      keyTest = { ...keyTest, [cid]: { busy: false, res: { ok: false, valid: false, error: (e as Error).message } } };
    }
  }
  async function addSiblingKey() {
    if (!detail || !newKey.trim() || newKeyBusy) return;
    newKeyBusy = true;
    newKeyErr = null;
    try {
      await api.addConnection({ provider: detail.connection.provider, apiKey: newKey.trim() });
      newKey = "";
      await load();
    } catch (e) {
      newKeyErr = (e as Error).message;
    } finally {
      newKeyBusy = false;
    }
  }
  async function load() {
    busy = true;
    err = null;
    testRes = null;
    try {
      const d = await api.getConnection(id);
      detail = d;
      editName = d.connection.name ?? "";
      editUrl = d.connection.base_url ?? "";
      editProxy = d.connection.proxy_url ?? "";
      editProxyMode = d.connection.proxy_mode ?? (d.connection.proxy_url ? "manual" : "off");
      editPriority = d.connection.priority ?? 100;
      editStatus = d.connection.status ?? "active";
      editWait = (d.connection.proxy_wait ?? 0) !== 0;
      try {
        const all = await api.connections();
        siblings = all.providers.filter((p) => p.provider === d.connection.provider);
      } catch {
        siblings = [d.connection];
      }
      restoreHealth();
    } catch (e) {
      err = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function detect(auto = false) {
    if (!detail || detectBusy) return;
    detectBusy = true;
    if (!auto) detectErr = null;
    try {
      const r = await api.detectModels(detail.connection.id);
      if (!r.ok) {
        if (!auto) detectErr = r.error ?? "detect failed";
        return;
      }
      await load();
    } catch (e) {
      if (!auto) detectErr = (e as Error).message;
    } finally {
      detectBusy = false;
    }
  }

  let modelBusy = $state<string | null>(null);

  // last test result per model, persisted locally so health survives reloads
  const HEALTH_KEY = "rikka.model-health";
  function readHealth(): Record<string, Record<string, { ok: boolean; latencyMs?: number; at: number }>> {
    try {
      return JSON.parse(localStorage.getItem(HEALTH_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  let modelRes = $state<Record<string, { ok: boolean; latencyMs?: number; error?: string | null; at?: number }>>({});

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  function httpErrorMessage(body: unknown, status: number): string {
    if (isRecord(body)) {
      const e: unknown = body.error;
      if (typeof e === "string" && e) return e;
      if (isRecord(e) && typeof e.message === "string" && e.message) return e.message;
    }
    return `HTTP ${status}`;
  }

  async function testModel(model: string) {
    if (!detail || modelBusy) return;
    modelBusy = model;
    try {
      const r = await fetch(`/api/providers/${detail.connection.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const j: unknown = await r.json();
      if (!r.ok) throw new Error(httpErrorMessage(j, r.status));
      const body = isRecord(j) ? j : null;
      const ok = body?.ok === true && body?.valid === true;
      const latency = body !== null && typeof body.latencyMs === "number" ? body.latencyMs : undefined;
      const errText = body !== null && typeof body.error === "string" ? body.error : null;
      modelRes = { ...modelRes, [model]: { ok, latencyMs: latency, error: errText, at: Date.now() } };
      saveHealth(model);
    } catch (e) {
      modelRes = { ...modelRes, [model]: { ok: false, error: (e as Error).message, at: Date.now() } };
      saveHealth(model);
    } finally {
      modelBusy = null;
    }
  }

  function saveHealth(model: string) {
    if (!detail) return;
    try {
      const all = readHealth();
      const r = modelRes[model];
      if (!r) return;
      all[detail.connection.id] = { ...(all[detail.connection.id] ?? {}), [model]: { ok: r.ok, latencyMs: r.latencyMs, at: r.at ?? Date.now() } };
      localStorage.setItem(HEALTH_KEY, JSON.stringify(all));
    } catch {}
  }

  function restoreHealth() {
    if (!detail) return;
    const mine = readHealth()[detail.connection.id] ?? {};
    const next: typeof modelRes = {};
    for (const [m, h] of Object.entries(mine)) next[m] = { ...h };
    if (Object.keys(next).length) modelRes = { ...modelRes, ...next };
  }

  function healthAge(at?: number): string {
    if (at == null) return "";
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  let editStatus = $state("active");
  let editWait = $state(false);
  async function save() {
    if (!detail) return;
    saveErr = null;
    saveBusy = true;
    try {
      await api.updateConnection(detail.connection.id, { name: editName.trim() || undefined, baseUrl: editUrl.trim() || null, proxyUrl: editProxy.trim() || null, proxyMode: editProxyMode, priority: editPriority, apiKey: editKey.trim() || undefined });
      await api.setConnectionStatus(detail.connection.id, editStatus === "disabled" ? "disabled" : "active");
      await api.setConnectionWait(detail.connection.id, editWait);
      editKey = "";
      await load();
    } catch (e) {
      saveErr = (e as Error).message;
    } finally {
      saveBusy = false;
    }
  }

  async function test() {
    if (!detail) return;
    testBusy = true;
    testRes = null;
    try {
      const r = await fetch(`/api/providers/${detail.connection.id}/test`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      testRes = j;
    } catch (e) {
      testRes = { ok: false, valid: false, error: (e as Error).message };
    } finally {
      testBusy = false;
    }
  }

  async function del() {
    if (!detail) return;
    delBusy = true;
    try {
      await api.removeConnection(detail.connection.id);
      go("/providers");
    } catch (e) {
      saveErr = (e as Error).message;
      confirmDel = false;
    } finally {
      delBusy = false;
    }
  }

  onMount(async () => {
    await load();
    // custom endpoints have no registry catalog — pull the live list once
    if (detail && detail.connection.provider.startsWith("custom-") && !(detail.detectedModels ?? []).length) {
      await detect(true);
    }
  });

  $effect(() => {
    // id changed via in-app nav → reload (component instance persists)
    id;
    void load();
  });
</script>

<div class="head">
  <div>
    <p class="crumb"><button class="link" onclick={() => go("/providers")}>Providers</button> / {detail?.provider?.name ?? detail?.connection.provider ?? id}</p>
    <h1>{detail?.provider?.name ?? detail?.connection.provider ?? "Provider"}</h1>
    {#if detail}
      <p class="sub mono dim">{detail.connection.provider} · connected {ago(detail.connection.created_at)}</p>
    {/if}
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => go("/providers")}><Icon name="back" size={13} /> All providers</Button>
  </div>
</div>

{#if busy}
  <div class="skeleton" style="height:220px"></div>
{:else if err}
  <Panel>
    <EmptyState title="Connection not found" desc={err}>
      {#snippet action()}
        <Button variant="secondary" onclick={() => go("/providers")}>Back to Providers</Button>
      {/snippet}
    </EmptyState>
  </Panel>
{:else if detail}
  <Panel title="Connection" sub="status · priority · endpoint">
    <div class="detail-grid">
      <div><span class="kv">Status</span> <StatusPill tone={detail.connection.status === "active" ? "ok" : detail.connection.status === "cooldown" ? "warn" : "bad"} label={detail.connection.status === "cooldown" ? "in cooldown" : detail.connection.status} /></div>
      <div><span class="kv">Priority</span> {detail.connection.priority}</div>
      <div><span class="kv">Endpoint</span> {detail.connection.base_url ?? "auto"}</div>
      {#if detail.connection.proxy_url}<div><span class="kv">Proxy</span> {detail.connection.proxy_url.replace(/:([^:@/]+)@/, ":•••@")}</div>{/if}
      {#if (detail.connection.proxy_mode ?? "off") === "auto"}<div><span class="kv">Proxy mode</span> auto pool</div>{/if}
      {#if detail.provider?.website}<div><a class="ext" href={detail.provider.website} target="_blank" rel="noreferrer">Website</a></div>{/if}
    </div>
  </Panel>

  <Panel title="API Keys" sub="{siblings.length} connected · requests round-robin · fail over on 429">
    {#if siblings.length}
      <ul class="model-list">
        {#each siblings as s (s.id)}
          {@const r = kt(s.id)}
          <li>
            <span class="mname mono">{s.name ? `${s.name} · ` : ""}{s.api_key}{s.id === detail.connection.id ? " · this" : ""}</span>
            <span class="mres">
              {#if r}
                {#if r.ok && r.valid}
                  <span class="ok" title="Key works"><span class="dot"></span>ok{#if typeof r.latencyMs === "number"} {r.latencyMs}ms{/if}</span>
                {:else}
                  <span class="bad" title={r.error ?? `HTTP ${r.status ?? ""}`}>failed{#if typeof r.status === "number"} {r.status}{/if}</span>
                {/if}
              {/if}
              <button class="tbtn" onclick={() => void testKey(s.id)} disabled={keyTest[s.id]?.busy}>{keyTest[s.id]?.busy ? "…" : "Test"}</button>
              {#if s.id !== detail.connection.id}<button class="tbtn" onclick={() => go(`/providers/${s.id}`)}>Open</button>{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="form" style="margin-top:10px">
      <div class="row">
        <input type="password" placeholder="sk-… (another key for {detail.connection.provider})" bind:value={newKey} disabled={newKeyBusy} style="flex:1;min-width:200px" onkeydown={(e) => { if (e.key === "Enter") void addSiblingKey(); }} />
        <Button variant="primary" onclick={() => void addSiblingKey()} disabled={newKeyBusy || !newKey.trim()}>{newKeyBusy ? "Adding…" : "Add key"}</Button>
      </div>
      {#if newKeyErr}<p class="form-err">{newKeyErr}</p>{/if}
    </div>
  </Panel>

  {#if detail.provider}
    <Panel title="Available Models" sub="{detail.provider.models.length} in registry">
      {#if detail.provider.models.length}
        <ul class="model-list">
          {#each detail.provider.models as m (m.id)}
            <li>
              <span class="mname">{m.name}</span>
              <span class="mono dim">{m.id}</span>
              <span class="mres">
                {#if modelRes[m.id]}
                  {#if modelRes[m.id].ok}
                    <span class="ok"><i class="dot"></i>OK{modelRes[m.id].latencyMs != null ? ` · ${modelRes[m.id].latencyMs}ms` : ""}{modelRes[m.id].at ? ` · ${healthAge(modelRes[m.id].at)}` : ""}</span>
                  {:else}
                    <span class="bad" title={modelRes[m.id].error ?? ""}><i class="dot"></i>FAIL{modelRes[m.id].at ? ` · ${healthAge(modelRes[m.id].at)}` : ""}</span>
                  {/if}
                {/if}
              </span>
              <button class="tbtn" onclick={() => testModel(m.id)} disabled={modelBusy !== null} title="Send a minimal chat with this model">
                {modelBusy === m.id ? "…" : "Test"}
              </button>
            </li>
          {/each}
        </ul>
        <p class="dim-note">Registry exposes id + display name only — context window, pricing and live availability are not exposed server-side, so they are not shown here.</p>
      {:else if (detail.detectedModels ?? []).length}
        <ul class="model-list">
          {#each detail.detectedModels ?? [] as m (m.id)}
            <li>
              <span class="mname">{m.name}</span>
              <span class="mono dim">{m.id}</span>
              <span class="mres">
                {#if modelRes[m.id]}
                  {#if modelRes[m.id].ok}
                    <span class="ok"><i class="dot"></i>OK{modelRes[m.id].latencyMs != null ? ` · ${modelRes[m.id].latencyMs}ms` : ""}{modelRes[m.id].at ? ` · ${healthAge(modelRes[m.id].at)}` : ""}</span>
                  {:else}
                    <span class="bad" title={modelRes[m.id].error ?? ""}><i class="dot"></i>FAIL{modelRes[m.id].at ? ` · ${healthAge(modelRes[m.id].at)}` : ""}</span>
                  {/if}
                {/if}
              </span>
              <button class="tbtn" onclick={() => testModel(m.id)} disabled={modelBusy !== null} title="Send a minimal chat with this model">
                {modelBusy === m.id ? "…" : "Test"}
              </button>
            </li>
          {/each}
        </ul>
        <p class="dim-note">Live list pulled from the endpoint itself — works for any custom URL.</p>
        <div class="row" style="margin-top:8px">
          <Button variant="ghost" onclick={() => detect()} disabled={detectBusy}>{detectBusy ? "Detecting…" : "Re-detect"}</Button>
        </div>
        {#if detectErr}<p class="form-err">{detectErr}</p>{/if}
      {:else}
        <p class="dim-note">No models listed for this provider in the registry.</p>
        <div class="row" style="margin-top:8px">
          <Button variant="secondary" onclick={() => detect()} disabled={detectBusy}>{detectBusy ? "Detecting…" : "Detect live models"}</Button>
        </div>
        {#if detectErr}<p class="form-err">{detectErr}</p>{/if}
      {/if}
    </Panel>
  {/if}

  <Panel title="Edit" sub="label · endpoint · priority · key rotation">
    <div class="form">
      <label>Label <input bind:value={editName} /></label>
      <label>Base URL <input bind:value={editUrl} placeholder="https://..." /></label>
      <label>Proxy URL (optional) <input bind:value={editProxy} placeholder="http://user:pass@proxy-host:8080" /></label>
      <label>Proxy mode
        <select bind:value={editProxyMode}>
          <option value="off">Off (direct connection)</option>
          <option value="manual">Manual proxy URL</option>
          <option value="auto">Auto pool (free proxies, rotated)</option>
        </select>
      </label>
      <label>Priority <input type="number" bind:value={editPriority} /></label>
      <label>Status
        <select bind:value={editStatus}>
          <option value="active">Active (in rotation)</option>
          <option value="disabled">Disabled (skipped)</option>
        </select>
      </label>
      <label class="chk"><input type="checkbox" bind:checked={editWait} /> Queue behind proxy pool when empty (up to 90s) instead of failing fast</label>
      <label>Rotate API Key (leave blank to keep) <input bind:value={editKey} type="password" placeholder="sk-..." /></label>
      {#if saveErr}<p class="form-err">{saveErr}</p>{/if}
      <div class="row">
        <Button variant="primary" onclick={save} disabled={saveBusy}>{saveBusy ? "Saving…" : "Save"}</Button>
        <Button variant="secondary" onclick={test} disabled={testBusy}>{testBusy ? "Testing…" : "Test"}</Button>
        {#if confirmDel}
          <Button variant="danger" onclick={del} disabled={delBusy}>{delBusy ? "Removing…" : "Click again to remove"}</Button>
        {:else}
          <Button variant="danger" onclick={() => (confirmDel = true)}><Icon name="trash" size={12} /></Button>
        {/if}
      </div>
      {#if testRes}
        <p class={testRes.ok && testRes.valid ? "form-ok" : "form-err"}>
          {testRes.ok && testRes.valid ? "OK" : "FAIL"}{testRes.status != null ? ` · status ${testRes.status}` : ""}{testRes.latencyMs != null ? ` · ${testRes.latencyMs}ms` : ""}{testRes.error ? ` · ${testRes.error}` : ""}
        </p>
        {#if !(testRes.ok && testRes.valid) && (testRes.status === 401 || testRes.status === 403)}
          <p class="form-err">Unauthorized — periksa API key provider ini, lalu rotasi di form Edit di atas.</p>
        {/if}
      {/if}
    </div>
  </Panel>
{/if}

<style>
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .head h1 { font-size: 28px; font-weight: 700; margin: 2px 0 0; }
  .crumb { font-size: 12px; color: var(--color-ink-faint); margin: 0; }
  .link { background: none; border: none; padding: 0; color: var(--color-blue-bright); cursor: pointer; font-size: 12px; }
  .link:hover { text-decoration: underline; }
  .sub { font-size: 12px; margin: 4px 0 0; }
  .hdr-actions { display: flex; gap: 8px; }
  .mono { font-family: ui-monospace, monospace; }
  .dim { color: var(--color-ink-muted); }
  .ext { font-size: 12px; color: var(--color-blue-bright); }
  .detail-grid { display: grid; gap: 6px; }
  .kv { font-weight: 600; margin-right: 6px; }
  .model-list { margin: 2px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; border: 1px solid var(--color-edge); border-radius: 6px; }
  .model-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 5px 10px; border-bottom: 1px solid var(--color-edge); font-size: 12px; }
  .model-list li:last-child { border-bottom: none; }
  .mname { color: var(--color-ink); }
  .dim-note { margin: 6px 0 0; font-size: 11px; color: var(--color-ink-faint); line-height: 1.5; }
  .form { display: flex; flex-direction: column; gap: 8px; max-width: 560px; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .form label.chk { flex-direction: row; align-items: center; gap: 8px; }
  .form input { padding: 6px 8px; border: 1px solid var(--color-edge); border-radius: 6px; background: var(--color-bg); color: var(--color-ink); }
  .form-err { color: var(--color-bad); font-size: 12px; }
  .form-ok { color: var(--color-ok); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .skeleton { border-radius: 10px; background: var(--color-panel); min-height: 220px; animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
  .mres { margin-left: auto; font-size: 11px; }
  .mres .ok { color: var(--color-ok); }
  .mres .bad { color: var(--color-bad); cursor: help; }
  .tbtn { border: 1px solid var(--color-edge); background: var(--color-bg); color: var(--color-ink-muted); border-radius: 6px; font-size: 11px; padding: 2px 10px; cursor: pointer; }
  .tbtn:hover:not(:disabled) { border-color: var(--color-pink); color: var(--color-pink); }
  .tbtn:disabled { opacity: 0.5; cursor: wait; }
  .mres .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: baseline; }
  .mres .ok .dot { background: var(--color-ok); box-shadow: 0 0 6px rgba(46, 230, 168, 0.5); }
  .mres .bad .dot { background: var(--color-bad); box-shadow: 0 0 6px rgba(255, 77, 94, 0.5); }
</style>

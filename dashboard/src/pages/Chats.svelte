<script lang="ts">
  // Chats — per-user conversation capture: browse, inspect, export for training.
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Input from "../components/Input.svelte";
  import DataTable from "../components/DataTable.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, type ChatTurn } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { go } from "../lib/nav.ts";

  let turns = $state<ChatTurn[]>([]);
  let total = $state(0);
  let err = $state<string | null>(null);
  let booted = $state(false);
  let fQ = $state("");
  let fKey = $state("");
  let fProv = $state("");
  let fModel = $state("");
  let fOk = $state("");
  let keys = $state<Array<{ id: string; name: string }>>([]);
  let sel = $state<ChatTurn | null>(null);
  let selErr = $state<string | null>(null);

  let xFormat = $state("openai");
  let xDedup = $state(true);
  let xScrub = $state(true);
  let xMinQ = $state("1");
  let exportList = $state<Array<{ id: string; ts: number; format: string; count: number }>>([]);
  let selected = $state<Set<string>>(new Set());
  let heatProv = $state("opencode-zen");
  let heat = $state<Array<{ hour: number; n: number; r429: number }>>([]);
  let heatErr = $state<string | null>(null);

  function filters() {
    return {
      ...(fQ.trim() ? { q: fQ.trim() } : {}),
      ...(fKey ? { keyId: fKey } : {}),
      ...(fProv.trim() ? { provider: fProv.trim() } : {}),
      ...(fModel.trim() ? { model: fModel.trim() } : {}),
      ...(fOk === "1" ? { ok: true } : fOk === "0" ? { ok: false } : {}),
      limit: 50,
    };
  }

  function exportHref(ids?: string[]) {
    return api.chatExportUrl({
      format: xFormat,
      ...(fKey ? { keyId: fKey } : {}),
      ...(fProv.trim() ? { provider: fProv.trim() } : {}),
      ...(fModel.trim() ? { model: fModel.trim() } : {}),
      ...(fQ.trim() ? { q: fQ.trim() } : {}),
      ...(fOk === "1" ? { ok: true } : fOk === "0" ? { ok: false } : {}),
      minQuality: Number(xMinQ) || 0,
      dedup: xDedup,
      scrub: xScrub,
      ...(ids?.length ? { ids } : {}),
    });
  }
  async function refresh() {
    try {
      const r = await api.chats(filters());
      turns = r.turns;
      total = r.total;
      // Drop selections for rows no longer visible
      const visible = new Set(turns.map((t) => t.id));
      selected = new Set([...selected].filter((id) => visible.has(id)));
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
    try {
      keys = (await api.keys()).keys;
    } catch {}
    try {
      exportList = (await api.chatExports()).exports;
    } catch {}
  }

  async function loadHeat() {
    heatErr = null;
    try {
      const r = await api.chatHeatmap(heatProv.trim() || "opencode-zen", 7);
      heat = r.hours;
    } catch (e) {
      heatErr = (e as Error).message;
    }
  }

  async function openTurn(id: string) {
    selErr = null;
    try {
      sel = (await api.getChat(id)).turn;
    } catch (e) {
      selErr = (e as Error).message;
    }
  }

  async function delTurn(id: string) {
    try {
      await api.deleteChat(id);
      sel = null;
      await refresh();
    } catch (e) {
      selErr = (e as Error).message;
    }
  }

  let xBusy = $state(false);
  let xMsg = $state<string | null>(null);
  let xErr = $state<string | null>(null);
  async function downloadUrl(url: string) {
    const r = await fetch(url);
    if (r.status === 401) throw new Error("session expired — reload the page and unlock again, then retry");
    if (!r.ok) throw new Error(`export failed: HTTP ${r.status}`);
    const blob = await r.blob();
    if (!blob.size) throw new Error("export is empty — no turns match these filters");
    const text = await blob.text();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) throw new Error("export is empty — no turns match these filters");
    const out = new Blob([lines.join("\n")], { type: "application/jsonl" });
    const disp = r.headers.get("content-disposition") ?? "";
    const m = disp.match(/filename="([^"]+)"/);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(out);
    a.download = m?.[1] ?? `rikka-${xFormat}.jsonl`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);
    return { count: lines.length };
  }
  async function downloadExport() {
    xBusy = true;
    xMsg = null;
    xErr = null;
    try {
      const { count } = await downloadUrl(exportHref());
      xMsg = `Downloaded ${count} turns.`;
      try {
        exportList = (await api.chatExports()).exports;
      } catch {}
    } catch (e) {
      xErr = (e as Error).message;
    } finally {
      xBusy = false;
    }
  }
  async function downloadSelected() {
    if (!selected.size) return;
    xBusy = true;
    xMsg = null;
    xErr = null;
    try {
      const { count } = await downloadUrl(exportHref([...selected]));
      xMsg = `Downloaded ${count} selected turns.`;
      try {
        exportList = (await api.chatExports()).exports;
      } catch {}
    } catch (e) {
      xErr = (e as Error).message;
    } finally {
      xBusy = false;
    }
  }

  function msgText(content: unknown): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") return (p as Record<string, unknown>).text as string;
          return "[non-text]";
        })
        .join("");
    }
    return String(content);
  }

  function heatMax() {
    return Math.max(1, ...heat.map((h) => h.n));
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    refresh();
    loadHeat();
    timer = setInterval(refresh, 15000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <p class="crumb">rikka / Chats</p>
    <h1>Chats</h1>
    <p class="sub">Full conversation bodies per API key — inspect, analyze, export for training. Bodies are skipped for keys with logging off.</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => { refresh(); loadHeat(); }}>Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton" style="height:220px"></div>
{:else if err}
  <Panel><p class="form-err">{err}</p><Button variant="secondary" onclick={refresh}>Retry</Button></Panel>
{:else}
  <Panel title="Conversations" sub="{total} turns">
    <div class="frow">
      <Input bind:value={fQ} label="Search text" width="200px" />
      <label class="sel">Key
        <select bind:value={fKey}>
          <option value="">all keys</option>
          {#each keys as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
        </select>
      </label>
      <Input bind:value={fProv} label="Provider" width="150px" />
      <Input bind:value={fModel} label="Model" width="150px" />
      <label class="sel">Status
        <select bind:value={fOk}>
          <option value="">all</option>
          <option value="1">ok</option>
          <option value="0">failed</option>
        </select>
      </label>
      <Button variant="primary" onclick={refresh}>Apply</Button>
    </div>
    {#if !turns.length}
      <EmptyState title="No turns captured yet" desc="Make a request through the gateway — bodies land here. Streaming and non-streaming are both captured." />
    {:else}
      <div class="row" style="margin-bottom:8px">
        <label class="chk"><input type="checkbox" checked={turns.length > 0 && turns.every((t) => selected.has(t.id))} onchange={(e) => { const c = (e.target as HTMLInputElement).checked; selected = c ? new Set(turns.map((t) => t.id)) : new Set(); }} /> select page ({selected.size} selected)</label>
        {#if selected.size}<Button variant="ghost" onclick={() => (selected = new Set())}>Clear</Button>{/if}
      </div>
      <DataTable columns={[{ key: "sel", label: "" }, { key: "ts", label: "Time" }, { key: "key", label: "Key" }, { key: "model", label: "Model" }, { key: "ok", label: "OK" }, { key: "tok", label: "Tok in/out", align: "right" }, { key: "cost", label: "Cost", align: "right" }, { key: "q", label: "Q", align: "right" }, { key: "egress", label: "Egress" }]} label="Chat turns">
        <tbody>
          {#each turns as t (t.id)}
            <tr class:selrow={sel?.id === t.id}>
              <td onclick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(t.id)} onchange={(e) => { const c = (e.target as HTMLInputElement).checked; const n = new Set(selected); if (c) n.add(t.id); else n.delete(t.id); selected = n; }} aria-label="select turn" /></td>
              <td class="mono dim" onclick={() => openTurn(t.id)} style="cursor:pointer">{ago(t.ts)}</td>
              <td class="mono dim">{t.key_id ?? "—"}</td>
              <td class="mono">{t.model}</td>
              <td>{#if t.ok}<span class="ok">✓</span>{:else}<span class="bad" title={t.error ?? ""}>✗ {t.status}</span>{/if}</td>
              <td class="r mono dim">{t.input_tokens}/{t.output_tokens}</td>
              <td class="r mono dim">${t.cost_usd.toFixed(6)}</td>
              <td class="r mono dim">{t.quality ?? "—"}</td>
              <td class="mono dim">{t.egress ?? "direct"}</td>
            </tr>
          {/each}
        </tbody>
      </DataTable>
    {/if}
  </Panel>

  {#if sel}
    <Panel title="Turn detail" sub="{sel.provider}/{sel.model} · {ago(sel.ts)}">
      <div class="meta">
        <span>Key <b class="mono">{sel.key_id ?? "—"}</b></span>
        <span>Status <b>{sel.ok ? "ok" : `failed ${sel.status}`}</b></span>
        <span>Egress <b class="mono">{sel.egress ?? "direct"}</b></span>
        <span>Latency <b>{sel.latency_ms}ms</b> TTFT <b>{sel.ttft_ms}ms</b></span>
        {#if sel.error}<span class="bad">{sel.error}</span>{/if}
      </div>
      <h4>Prompt ({sel.request?.messages.length ?? 0} messages)</h4>
      {#if sel.request}
        <div class="msgs">
          {#each sel.request.messages as m, i (i)}
            <div class="msg"><span class="role">{(m as Record<string, unknown>).role ?? "?"}</span><pre>{msgText((m as Record<string, unknown>).content).slice(0, 4000)}</pre></div>
          {/each}
        </div>
      {:else}<p class="dim-note">Body not stored (logging off for this key).</p>{/if}
      <h4>Completion{#if sel.finish} · {sel.finish}{/if}</h4>
      {#if sel.response}<pre class="out">{sel.response.slice(0, 8000)}</pre>
      {:else if sel.reasoning}<p class="dim-note">Answered in reasoning channel:</p><pre class="out">{sel.reasoning.slice(0, 8000)}</pre>
      {:else}<p class="dim-note">Empty completion.</p>{/if}
      {#if sel.toolCalls?.length}
        <h4>Tool calls ({sel.toolCalls.length})</h4>
        {#each sel.toolCalls as tc, i (i)}<div class="msg"><span class="role">{tc.name ?? "tool"}</span><pre>{(tc.args ?? "").slice(0, 2000)}</pre></div>{/each}
      {/if}
      {#if sel.attempts.length > 1}
        <h4>Attempt chain ({sel.attempts.length})</h4>
        <ul class="atts">
          {#each sel.attempts as a, i (i)}<li><span class="mono">{a.connection}</span> via <span class="mono">{a.proxy ?? "direct"}</span> → {a.status} in {a.latencyMs}ms{#if a.error} <span class="bad">{a.error}</span>{/if}</li>{/each}
        </ul>
      {/if}
      {#if selErr}<p class="form-err">{selErr}</p>{/if}
      <div class="row"><Button variant="secondary" onclick={() => (sel = null)}>Close</Button><Button variant="danger" onclick={() => sel && delTurn(sel.id)}>Delete turn</Button></div>
    </Panel>
  {/if}

  <Panel title="Training export" sub="quality-filtered · deduped · PII-scrubbed JSONL">
    <div class="frow">
      <label class="sel">Format
        <select bind:value={xFormat}>
          <option value="openai">OpenAI fine-tune</option>
          <option value="sharegpt">ShareGPT</option>
          <option value="raw">Raw JSONL</option>
        </select>
      </label>
      <label class="chk"><input type="checkbox" bind:checked={xDedup} /> dedup</label>
      <label class="chk"><input type="checkbox" bind:checked={xScrub} /> PII scrub</label>
      <Input bind:value={xMinQ} label="Min quality" width="90px" />
      <Button variant="primary" onclick={downloadExport} disabled={xBusy}>{xBusy ? "Exporting…" : "Download ↓"}</Button>
      <Button variant="secondary" onclick={downloadSelected} disabled={xBusy || !selected.size}>{xBusy ? "Exporting…" : `Export selected (${selected.size}) ↓`}</Button>
    </div>
    {#if xMsg}<p class="okmsg">{xMsg}</p>{/if}
    {#if xErr}<p class="form-err">{xErr}</p>{/if}
    <p class="dim-note">Download = all turns matching the filters above. Or tick checkboxes and Export selected for an exact batch. Tool-call history is preserved; ShareGPT folds tool traffic into human turns. Secrets are scrubbed unless you untick it.</p>
    {#if exportList.length}
      <h4>Recent exports</h4>
      <ul class="atts">{#each exportList as x (x.id)}<li><span class="mono">{x.id}</span> · {x.format} · {x.count} turns · {ago(x.ts)}</li>{/each}</ul>
    {/if}
  </Panel>

  <Panel title="429 heatmap" sub="when is this provider actually usable? (UTC hours, 7d)">
    <div class="frow">
      <Input bind:value={heatProv} label="Provider" width="180px" />
      <Button variant="secondary" onclick={loadHeat}>Load</Button>
    </div>
    {#if heatErr}<p class="form-err">{heatErr}</p>
    {:else if heat.length}
      <div class="heat">{#each heat as h (h.hour)}<div class="bar" title="{h.hour}:00 — {h.n} req, {h.r429}×429"><div class="fill" style="height:{Math.round((h.n / heatMax()) * 100)}%"></div><div class="rfill" style="height:{h.n ? Math.round((h.r429 / h.n) * 100) : 0}%"></div><span>{h.hour}</span></div>{/each}</div>
      <p class="dim-note">Blue = volume, red overlay = 429 share. Tall red = avoid that hour.</p>
    {:else}<p class="dim-note">No data for this provider yet.</p>{/if}
  </Panel>
{/if}

<style>
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; }
  .crumb { font-size: 12px; color: var(--color-ink-faint); margin: 0; }
  .sub { font-size: 12.5px; color: var(--color-ink-muted); margin: 4px 0 0; max-width: 760px; }
  .hdr-actions { display: flex; gap: 8px; }
  .frow { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 10px; }
  .sel { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .sel select { padding: 6px 8px; border: 1px solid var(--color-edge); border-radius: 6px; background: var(--color-bg); color: var(--color-ink); }
  .chk { display: flex; gap: 6px; align-items: center; font-size: 12px; padding-bottom: 8px; }
  .mono { font-family: ui-monospace, monospace; }
  .dim { color: var(--color-ink-muted); }
  .r { text-align: right; }
  .ok { color: var(--color-ok); }
  .bad { color: var(--color-bad); }
  .form-err { color: var(--color-bad); font-size: 12px; }
  .dim-note { font-size: 11px; color: var(--color-ink-faint); }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  tr.selrow { background: rgba(255, 22, 140, 0.06); }
  .meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; margin-bottom: 6px; }
  h4 { font-size: 13px; margin: 14px 0 6px; }
  .msgs { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
  .msg { border: 1px solid var(--color-edge); border-radius: 6px; padding: 6px 8px; }
  .role { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-pink); }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 4px 0 0; font-family: ui-monospace, monospace; }
  .out { background: var(--color-bg); border: 1px solid var(--color-edge); border-radius: 6px; padding: 8px; max-height: 300px; overflow-y: auto; }
  .atts { margin: 4px 0; padding-left: 18px; font-size: 12px; }
  .okmsg { color: var(--color-ok); font-size: 12px; }
  .heat { display: flex; gap: 3px; align-items: flex-end; height: 110px; margin-top: 8px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; position: relative; min-width: 0; }
  .fill { width: 100%; background: rgba(60, 140, 255, 0.5); border-radius: 2px 2px 0 0; }
  .rfill { width: 100%; background: rgba(255, 77, 94, 0.75); }
  .bar span { font-size: 9px; color: var(--color-ink-faint); margin-top: 2px; }
  .skeleton { border-radius: 10px; background: var(--color-panel); min-height: 220px; }
</style>

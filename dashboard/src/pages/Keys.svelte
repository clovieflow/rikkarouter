<script lang="ts">
  // SCREEN — API Keys (§31): client keys gating /v1. Secret is revealed once,
  // masked by default, with copy + explicit "store it now" warning. Revoke is
  // a two-step danger confirm. No rotate endpoint exists server-side yet.
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import PolicyBudget from "../components/PolicyBudget.svelte";
  import Dialog from "../components/Dialog.svelte";
  import Input from "../components/Input.svelte";
  import Badge from "../components/Badge.svelte";
  import DataTable from "../components/DataTable.svelte";
  import { onDestroy, onMount } from "svelte";
  import { api, type ApiKeyRow } from "../lib/api.ts";
  import { copyText } from "../lib/clipboard.ts";
  import { ago } from "../lib/format.ts";

  let keys = $state<ApiKeyRow[]>([]);
  let budgets = $state<Record<string, { budget: number | null; spent: number }>>({});
  let sparks = $state<Record<string, number[]>>({});
  let err = $state<string | null>(null);
  let booted = $state(false);
  let pendingDel = $state<string | null>(null);

  // dialog: closed → create step → one-time reveal step
  let dialogOpen = $state(false);
  let name = $state("");
  let busy = $state(false);
  let actErr = $state<string | null>(null);
  let fresh = $state<{ id: string; name: string; secret: string } | null>(null);
  let revealed = $state(false);
  let copied = $state(false);
  let nameInput = $state<HTMLInputElement | undefined>();
  let copyTimer: ReturnType<typeof setTimeout>;

  async function refresh(): Promise<void> {
    try {
      const r = await api.keys();
      keys = r.keys;
      err = null;
      try {
        const infos = await Promise.all(keys.map((k) => api.getBudget(k.id).catch(() => ({ id: k.id, budget: null as number | null, spent: 0 }))));
        const m: Record<string, { budget: number | null; spent: number }> = {};
        for (const info of infos) m[info.id] = { budget: info.budget, spent: info.spent };
        budgets = m;
        // 30-day daily spend per key (bounded: skip when too many keys)
        if (keys.length <= 12) {
          const series = await Promise.all(keys.map((k) => api.dailyUsage(30, k.id).catch(() => ({ rows: [] as Array<{ day: string; cost: number }> }))));
          const sm: Record<string, number[]> = {};
          const today = new Date();
          const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          series.forEach((s, i) => {
            const byDay = new Map((s.rows ?? []).map((r) => [r.day, r.cost]));
            const arr: number[] = [];
            for (let d = 29; d >= 0; d--) {
              const dt = new Date(today.getTime() - d * 86400000);
              arr.push(byDay.get(dayKey(dt)) ?? 0);
            }
            sm[keys[i]!.id] = arr;
          });
          sparks = sm;
        }
      } catch { /* budgets + sparks optional */ }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  async function onSaveBudget(keyId: string, next: number | null): Promise<void> {
    await api.setBudget(keyId, next);
    const info = await api.getBudget(keyId);
    budgets = { ...budgets, [keyId]: { budget: info.budget, spent: info.spent } };
  }

  // per-key operator controls: prepaid, scopes, access, logging, rotation
  let expanded = $state<string | null>(null);
  let drafts = $state<Record<string, { contact: string; balance: string; allow: string; ips: string; log: boolean; disabled: boolean }>>({});
  let ctlBusy = $state<string | null>(null);
  let ctlMsg = $state<Record<string, string>>({});
  let rotSecret = $state<Record<string, string>>({});
  let stats = $state<Record<string, { n: number; cost: number; balance: number | null; spentMonth: number }>>({});
  let invMonth = $state<Record<string, string>>({});

  function parseAllow(s: string | null | undefined): string {
    if (!s) return "";
    try {
      const p: unknown = JSON.parse(s);
      if (Array.isArray(p)) return (p as unknown[]).filter((x): x is string => typeof x === "string").join("\n");
    } catch {}
    return s;
  }
  function parseIps(s: string | null | undefined): string {
    if (!s) return "";
    try {
      const p: unknown = JSON.parse(s);
      if (Array.isArray(p)) return (p as unknown[]).filter((x): x is string => typeof x === "string").join(", ");
    } catch {}
    return s;
  }
  async function toggleControls(k: ApiKeyRow) {
    if (expanded === k.id) {
      expanded = null;
      return;
    }
    expanded = k.id;
    drafts = {
      ...drafts,
      [k.id]: {
        contact: k.contact ?? "",
        balance: k.balance_usd == null ? "" : String(k.balance_usd),
        allow: parseAllow(k.allow_models),
        ips: parseIps(k.ip_allowlist),
        log: (k.log_bodies ?? 1) !== 0,
        disabled: (k.disabled ?? 0) !== 0,
      },
    };
    invMonth = { ...invMonth, [k.id]: invMonth[k.id] ?? new Date().toISOString().slice(0, 7) };
    try {
      const s = await api.keyStats(k.id, 30);
      stats = { ...stats, [k.id]: { n: Number((s.chats as Record<string, unknown>)?.n ?? 0), cost: Number((s.chats as Record<string, unknown>)?.cost ?? 0), balance: s.balance, spentMonth: s.spentMonth } };
    } catch {}
  }
  async function saveControls(k: ApiKeyRow) {
    const d = drafts[k.id];
    if (!d || ctlBusy) return;
    ctlBusy = k.id;
    ctlMsg = { ...ctlMsg, [k.id]: "" };
    try {
      const bal = d.balance.trim() === "" ? null : Number(d.balance);
      if (bal !== null && (!Number.isFinite(bal) || bal < 0)) throw new Error("balance must be a number ≥ 0 or empty (unlimited)");
      await api.changeKeyControls(k.id, {
        contact: d.contact.trim(),
        balance: bal,
        allowModels: d.allow.trim() === "" ? null : d.allow.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
        ipAllowlist: d.ips.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
        logBodies: d.log,
        disabled: d.disabled,
      });
      ctlMsg = { ...ctlMsg, [k.id]: "saved" };
      await refresh();
    } catch (e) {
      ctlMsg = { ...ctlMsg, [k.id]: (e as Error).message };
    } finally {
      ctlBusy = null;
    }
  }
  async function rotate(k: ApiKeyRow) {
    ctlBusy = k.id;
    try {
      const r = await api.rotateKey(k.id);
      rotSecret = { ...rotSecret, [k.id]: r.secret };
      ctlMsg = { ...ctlMsg, [k.id]: "rotated — old secret is dead" };
    } catch (e) {
      ctlMsg = { ...ctlMsg, [k.id]: (e as Error).message };
    } finally {
      ctlBusy = null;
    }
  }
  function openCreate(): void {
    dialogOpen = true;
    name = "";
    busy = false;
    actErr = null;
    fresh = null;
    revealed = false;
    copied = false;
  }
  function closeDialog(): void {
    if (!dialogOpen) return;
    dialogOpen = false;
    const wasFresh = fresh != null;
    fresh = null;
    if (wasFresh) void refresh();
  }
  const keyCols = [
    { key: "name", label: "Name" },
    { key: "id", label: "Key ID" },
    { key: "created", label: "Created" },
    { key: "used", label: "Last used" },
    { key: "actions", label: "Actions", align: "right" as const },
  ];

  async function createKey(): Promise<void> {
    const n = name.trim();
    if (!n) {
      actErr = "Give the key a name first.";
      return;
    }
    busy = true;
    actErr = null;
    try {
      fresh = await api.addKey(n);
      revealed = false;
      copied = false;
    } catch (e) {
      actErr = `create failed: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  // §31: never plaintext by default — prefix + dots + suffix, like sk_live_••••8f92
  function mask(s: string): string {
    if (s.length <= 12) return "•".repeat(Math.max(8, s.length));
    return `${s.slice(0, 8)}${"•".repeat(Math.min(16, Math.max(8, s.length - 12)))}${s.slice(-4)}`;
  }
  async function copySecret(): Promise<void> {
    if (!fresh) return;
    const ok = await copyText(fresh.secret);
    if (ok) {
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } else {
      actErr = "Clipboard blocked by the browser — reveal the key and copy it manually.";
    }
  }

  async function revoke(id: string): Promise<void> {
    try {
      await api.removeKey(id);
      pendingDel = null;
      await refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 6000);
  });
  onDestroy(() => {
    clearInterval(timer);
    clearTimeout(copyTimer);
  });
  $effect(() => {
    if (dialogOpen && !fresh) queueMicrotask(() => nameInput?.focus());
  });
</script>


<div class="head">
  <div>
    <h1>API Keys</h1>
    <p class="sub">
      {#if !booted}
        loading keys…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
      {:else}
        {keys.length} keys gate access to /v1 · the key powering this dashboard is kept in browser localStorage only, not in this list
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
    <Button variant="primary" onclick={openCreate}><Icon name="plus" size={13} /> Create key</Button>
  </div>
</div>

<Panel title="Client Keys" sub="secrets are shown once at creation · revoke is two-step" pad={false}>
  {#if !booted}
    <div class="skel">
      {#each [0, 1, 2, 3] as i (i)}<div class="sk-row"></div>{/each}
    </div>
  {:else if !keys.length}
    {#snippet act()}
      <Button variant="primary" onclick={openCreate}><Icon name="plus" size={13} /> Create key</Button>
    {/snippet}
    <EmptyState
      title="No API keys yet"
      desc="Every request to /v1 must carry one of these keys. Create one, then point an SDK or curl at this router."
      action={act}
    />
  {:else}
    <DataTable columns={keyCols} label="Client keys">
      <tbody>
        {#each keys as k (k.id)}
          <tr class:disabled={(k.disabled ?? 0) !== 0}>
            <td class="nm">{k.name}{#if (k.disabled ?? 0) !== 0} <Badge tone="bad" dot={false}>disabled</Badge>{/if}</td>
            <td class="mono dim">{k.id}</td>
            <td class="mut">{ago(k.created_at)}</td>
            <td class="mut">{#if k.last_used_at == null}<Badge tone="muted" dot={false}>never</Badge>{:else}{ago(k.last_used_at)}{/if}</td>
            <td class="r acts">
              <Button variant="ghost" onclick={() => toggleControls(k)}>{expanded === k.id ? "Hide" : "Controls"}</Button>
              <a class="explink" href={api.exportLogsUrl({ format: "jsonl", keyId: k.id })} title="Download this key's request log (JSONL)">Logs ↓</a>
              {#if pendingDel === k.id}
                <Button variant="danger" onclick={() => void revoke(k.id)}><Icon name="trash" size={12} /> Confirm revoke</Button>
                <Button variant="ghost" onclick={() => (pendingDel = null)}>Cancel</Button>
              {:else}
                <Button variant="ghost" onclick={() => (pendingDel = k.id)}><Icon name="trash" size={12} /></Button>
              {/if}
            </td>
          </tr>
          {#if expanded === k.id}
            <tr class="ctlrow"><td colspan={5}>
              <div class="ctl">
                <div class="crow">
                  <label>Contact/owner<input bind:value={drafts[k.id].contact} placeholder="who is this key for?" /></label>
                  <label>Prepaid balance USD<input bind:value={drafts[k.id].balance} placeholder="empty = unlimited" inputmode="decimal" /></label>
                  <label class="chk"><input type="checkbox" bind:checked={drafts[k.id].log} /> log chat bodies</label>
                  <label class="chk danger"><input type="checkbox" bind:checked={drafts[k.id].disabled} /> disabled</label>
                </div>
                <div class="crow">
                  <label>Allowed models (blank = all)<textarea bind:value={drafts[k.id].allow} rows={2} placeholder={"opencode-zen/*\none per line or comma"}></textarea></label>
                  <label>IP allowlist (blank = anywhere)<input bind:value={drafts[k.id].ips} placeholder="1.2.3.4, 10.0.0.0/8" /></label>
                </div>
                {#if stats[k.id]}{@const st = stats[k.id]}<p class="dim-note">30d: {st.n} chats · ${st.cost.toFixed(4)} · month spend ${st.spentMonth.toFixed(4)}{st.balance != null ? ` · balance $${st.balance.toFixed(4)}` : ""}</p>{/if}
                <div class="crow">
                  <Button variant="primary" onclick={() => saveControls(k)} disabled={ctlBusy === k.id}>{ctlBusy === k.id ? "Saving…" : "Save controls"}</Button>
                  <Button variant="secondary" onclick={() => rotate(k)} disabled={ctlBusy === k.id}>Rotate secret</Button>
                  <label class="inv">Invoice<input bind:value={invMonth[k.id]} placeholder="YYYY-MM" /></label>
                  <a class="explink" href={api.keyInvoiceUrl(k.id, invMonth[k.id] || "")}>Invoice ↓</a>
                  <a class="explink" href={`#/chats`}>Chats →</a>
                </div>
                {#if rotSecret[k.id]}<p class="secret">new secret (once): <code>{rotSecret[k.id]}</code> <Button variant="ghost" onclick={() => copyText(rotSecret[k.id])}>Copy</Button></p>{/if}
                {#if ctlMsg[k.id]}<p class={ctlMsg[k.id] === "saved" ? "okmsg" : "derr"}>{ctlMsg[k.id]}</p>{/if}
              </div>
            </td></tr>
          {/if}
        {/each}
      </tbody>
    </DataTable>
  {/if}
</Panel>

{#if booted && keys.length}
  <div class="budget-section">
    <h3 class="budget-title">Budgets · per-key monthly caps</h3>
    <p class="budget-sub">Gateway checks the cap before proxying to upstream; over-budget returns 429. <a href="#/policies" class="lnk">Manage all in Policies →</a></p>
    <div class="budget-grid">
      {#each keys as k (k.id)}
        <PolicyBudget
          keyId={k.id}
          budget={budgets[k.id]?.budget ?? null}
          spent={budgets[k.id]?.spent ?? 0}
          spark={sparks[k.id] ?? []}
          onSave={(next) => onSaveBudget(k.id, next)}
        />
      {/each}
    </div>
  </div>
{/if}

<Dialog open={dialogOpen} label={fresh ? "API key created" : "Create API key"} onClose={closeDialog}>
  {#if !fresh}
    <h3 class="dh3">Create API key</h3>
    <p class="dsub">The secret is displayed once and never stored in readable form. Copy it before closing.</p>
    <Input
      block
      bind:el={nameInput}
      bind:value={name}
      maxlength={48}
      placeholder="key name — e.g. laptop-cli"
      label="Key name"
      onEnter={() => void createKey()}
    />
    {#if actErr}<p class="derr"><Icon name="bolt" size={12} /> {actErr}</p>{/if}
    <div class="dact">
      <Button variant="ghost" onclick={closeDialog}>Cancel</Button>
      <Button variant="primary" disabled={busy} onclick={() => void createKey()}><Icon name="keys" size={13} /> {busy ? "Creating…" : "Create key"}</Button>
    </div>
  {:else}
    <h3 class="dh3">Key created</h3>
    <p class="dsub"><span class="fname">{fresh.name}</span> · id <span class="mono">{fresh.id}</span></p>
    <div class="secret" class:rev={revealed}>
      <code>{revealed ? fresh.secret : mask(fresh.secret)}</code>
    </div>
    <div class="drow">
      <Button variant="secondary" onclick={() => (revealed = !revealed)}>
        <Icon name={revealed ? "x" : "keys"} size={13} /> {revealed ? "Hide" : "Reveal"}
      </Button>
      <Button variant="secondary" onclick={() => void copySecret()}>
        <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
      </Button>
    </div>
    <p class="warnrow"><Icon name="policies" size={13} /> shown once — store it now. This dialog cannot show it again.</p>
    {#if actErr}<p class="derr"><Icon name="bolt" size={12} /> {actErr}</p>{/if}
    <div class="dact">
      <Button variant="primary" onclick={closeDialog}>Done</Button>
    </div>
  {/if}
</Dialog>

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
    max-width: 720px;
  }
  .sub .bad {
    color: var(--color-bad);
  }
  .hdr-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .nm {
    color: var(--color-ink);
    font-weight: 500;
  }
  .mut {
    color: var(--color-ink-muted);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .dim {
    color: var(--color-ink-faint);
  }
  .r {
    text-align: right;
  }
  .acts {
    white-space: nowrap;
  }
  .explink {
    font-size: 12px;
    color: var(--color-ink-muted);
    text-decoration: none;
    margin-right: 2px;
  }
  .explink:hover { color: var(--color-ink); text-decoration: underline; }
  .acts :global(.btn) {
    margin-left: 6px;
  }
  .acts :global(.btn.rev) {
    color: var(--color-ink-muted);
  }
  .acts :global(.btn.rev:hover) {
    color: var(--color-bad);
  }
  .skel {
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sk-row {
    height: 28px;
    border-radius: var(--radius-ctl);
    background: linear-gradient(180deg, #0b0b11, #0d0d15);
    border: 1px solid var(--color-edge);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
  }
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .dh3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-ink);
  }
  .dsub {
    margin: 4px 0 12px;
    font-size: 12px;
    color: var(--color-ink-muted);
    line-height: 1.5;
  }
  .fname {
    color: var(--color-ink);
    font-weight: 600;
  }
  .secret {
    background: var(--color-void);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    padding: 11px 12px;
    overflow-wrap: anywhere;
  }
  .secret code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--color-ink-muted);
    letter-spacing: 0.02em;
  }
  .secret.rev code {
    color: var(--color-ink);
  }
  .skel { background: var(--color-raised); border:1px solid var(--color-edge); border-radius:var(--radius-panel); padding:10px; }
  .budget-section { margin-top:20px; }
  .budget-title { margin:0; font-size:14px; font-weight:700; letter-spacing:-0.01em; color:var(--color-ink); }
  .budget-sub { margin:4px 0 12px; font-size:12px; color:var(--color-ink-muted); }
  .budget-sub .lnk { color:var(--color-blue-bright); text-decoration:none; }
  .budget-sub .lnk:hover { text-decoration:underline; }
  .budget-grid { display:flex; flex-direction:column; gap:12px; }
  tr.disabled { opacity: 0.55; }
  .ctlrow td { background: var(--color-raised); }
  .ctl { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
  .crow { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .crow label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--color-ink-muted); min-width: 180px; flex: 1; }
  .crow input, .crow textarea { padding: 6px 8px; border: 1px solid var(--color-edge); border-radius: 6px; background: var(--color-bg); color: var(--color-ink); font: inherit; font-size: 12px; }
  .crow label.chk, .crow label.inv { flex: 0; flex-direction: row; align-items: center; min-width: 0; }
  .crow label.chk.danger { color: var(--color-bad); }
  .secret { font-size: 12px; }
  .secret code { background: var(--color-edge); padding: 2px 6px; border-radius: 4px; }
  .okmsg { color: var(--color-ok); font-size: 12px; }
</style>

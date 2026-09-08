<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import PolicyBudget from "../components/PolicyBudget.svelte";
  import { api, type ApiKeyRow } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";

  let keys = $state<ApiKeyRow[]>([]);
  let budgets = $state<Record<string, { budget: number | null; spent: number }>>({});
  let err = $state<string | null>(null);
  let booted = $state(false);

  async function refresh() {
    try {
      const r = await api.keys();
      keys = r.keys;
      err = null;
      // fetch budgets in parallel
      const infos = await Promise.all(
        keys.map((k) => api.getBudget(k.id).catch(() => ({ id: k.id, budget: null, spent: 0 } as const))),
      );
      const m: Record<string, { budget: number | null; spent: number }> = {};
      for (const info of infos) m[info.id] = { budget: info.budget, spent: info.spent };
      budgets = m;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  async function onSave(keyId: string, next: number | null) {
    await api.setBudget(keyId, next);
    const info = await api.getBudget(keyId);
    budgets = { ...budgets, [keyId]: { budget: info.budget, spent: info.spent } };
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 8000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Policies</h1>
    <p class="sub">
      {#if !booted}loading keys…
      {:else if err}<span class="bad">server unreachable: {err}</span>
      {:else}Per-key monthly spend caps · resets on the 1st · gateway enforces on /v1 · {keys.length} keys{/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton sk-grid"></div>
{:else if !keys.length}
  <Panel pad={false}>
    <EmptyState
      title="No keys to budget"
      desc="Create a client API key first — each key can carry its own monthly USD cap, and rikka will reject traffic over budget before it reaches upstream."
    />
  </Panel>
{:else}
  <div class="grid">
    {#each keys as k (k.id)}
      <PolicyBudget
        keyId={k.id}
        budget={budgets[k.id]?.budget ?? null}
        spent={budgets[k.id]?.spent ?? 0}
        onSave={(next) => onSave(k.id, next)}
      />
      <p class="meta">{k.name} · id {k.id.slice(0, 8)}… · created {ago(k.created_at)} · last used {k.last_used_at ? ago(k.last_used_at) : "never"}</p>
    {/each}
  </div>
  <Panel title="Policy scope" sub="what is enforced today vs what is still ahead">
    <div class="scope">
      <div>
        <p class="sh">Enforced now</p>
        <ul class="sl">
          <li>Per-key monthly spend caps — the gateway rejects /v1 traffic over budget; counters reset on the 1st.</li>
        </ul>
      </div>
      <div>
        <p class="sh">Rules engine — planned</p>
        <ul class="sl">
          <li>Model access · provider access · max cost per request · rate limits · geography · environment · fallback behavior — not enforced yet. Routing priority lives in Routes / Combos.</li>
        </ul>
      </div>
    </div>
  </Panel>
  {#if err}<Panel><p class="bad">{err}</p></Panel>{/if}
{/if}

<style>
  .head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:28px; font-weight:700; letter-spacing:-0.02em; }
  .sub { margin:3px 0 0; font-size:12.5px; color:var(--color-ink-muted); }
  .sub .bad { color:var(--color-bad); }
  .hdr-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .grid { display:flex; flex-direction:column; gap:16px; }
  .meta { margin:6px 2px 0; font-size:11px; color:var(--color-ink-faint); }
  .skeleton { background:linear-gradient(180deg, var(--color-raised), var(--color-elevated)); border:1px solid var(--color-edge); border-radius:var(--radius-panel); animation:breathe 1.6s var(--ease-out) infinite alternate; }
  .scope { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width: 800px) { .scope { grid-template-columns:1fr; } }
  .sh { margin:0 0 6px; font-size:10.5px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--color-ink-faint); }
  .sl { margin:0; padding-left:18px; font-size:12.5px; color:var(--color-ink-soft); line-height:1.6; }
  @keyframes breathe { from{opacity:0.6} to{opacity:1} }
  .sk-grid { height:220px; }
  .bad { color:var(--color-bad); font-size:12px; }
</style>

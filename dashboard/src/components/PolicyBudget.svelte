<script lang="ts">
  // PolicyBudget — inline per-key monthly budget panel.
  // Used on Keys.svelte; self-contained. Shape mirrors GET /api/keys/:id/budget
  //   { id, budget: number|null, spent: number }
  //
  // Usage example:
  //   import PolicyBudget from "../components/PolicyBudget.svelte";
  //   import { getBudget, setBudget } from "../lib/api.ts";
  //   let info = $state<{ budget: number | null; spent: number } | null>(null);
  //   onMount(async () => { info = await getBudget(keyId); });
  //   <PolicyBudget keyId={keyId} budget={info?.budget ?? null} spent={info?.spent ?? 0} onSave={async (b) => { await setBudget(keyId, b); info = await getBudget(keyId); }} />
  //
  import Panel from "./Panel.svelte";
  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";
  import { sparkPath } from "../lib/spark.ts";
  import { fmtUSD } from "../lib/format.ts";

  let {
    keyId,
    budget,
    spent,
    onSave,
    spark = [],
  }: {
    keyId: string;
    budget: number | null;
    spent: number;
    onSave: (budget: number | null) => Promise<void> | void;
    /** 7 daily spend values (USD), oldest → newest; empty = unavailable */
    spark?: number[];
  } = $props();
  let draft = $state<string>("");
  let saving = $state(false);
  let err = $state<string | null>(null);
  let initialized = $state(false);

  $effect(() => {
    if (!saving && (!initialized || budget !== lastKnownBudget)) {
      draft = budget == null ? "" : String(budget);
      lastKnownBudget = budget;
      initialized = true;
    }
  });
  let lastKnownBudget = $state<number | null>(null);
  const budgetNum = $derived(budget);
  const spentNum = $derived(Number.isFinite(spent) ? spent : 0);
  const pct = $derived(budgetNum != null && budgetNum > 0 ? Math.min(100, (spentNum / budgetNum) * 100) : 0);
  const over = $derived(budgetNum != null && spentNum > budgetNum);
  const remaining = $derived(budgetNum == null ? null : budgetNum - spentNum);
  async function save(): Promise<void> {
    const v = draft.trim();
    const next = v === "" ? null : Number(v);
    if (next !== null && !(next >= 0)) {
      err = "budget must be empty (no cap) or a non-negative number (USD).";
      return;
    }
    saving = true;
    err = null;
    try {
      await onSave(next);
      lastKnownBudget = next;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function clear(): Promise<void> {
    draft = "";
    saving = true;
    err = null;
    try {
      await onSave(null);
      lastKnownBudget = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Monthly budget" sub={keyId ? `key ${keyId.slice(0, 8)}… · resets on the 1st` : "per-key spend cap"}>
  {#if spark.length >= 2}
    <svg class="spark" viewBox="0 0 96 26" preserveAspectRatio="none" aria-hidden="true">
      <path d={sparkPath(spark)} fill="none" stroke="var(--color-pink)" stroke-width="1.5" />
    </svg>
  {/if}
  <div class="grid">
    <div class="stat">
      <span class="k">Spent this month</span>
      <span class="v" class:over>{fmtUSD(spentNum)}</span>
    </div>
    <div class="stat">
      <span class="k">Budget</span>
      <span class="v">{budgetNum == null ? "no cap" : fmtUSD(budgetNum)}</span>
    </div>
    {#if budgetNum != null}
      <div class="stat">
        <span class="k">{over ? "Over by" : "Remaining"}</span>
        <span class="v" class:over>{fmtUSD(remaining ?? 0)}</span>
      </div>
    {/if}
  </div>

  {#if budgetNum != null}
    <div class="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="budget used">
      <div class="fill" class:over style={`width:${pct.toFixed(1)}%`}></div>
    </div>
    <p class="hint">{pct.toFixed(1)}% used{over ? " · over budget — requests will be rejected when the gateway enforces caps" : ""}</p>
  {:else}
    <p class="hint">No cap set — set a USD limit to enforce a monthly ceiling for this key.</p>
  {/if}

  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <label class="fld" aria-label="Monthly budget in USD">
      <span class="lbl">Budget USD / month</span>
      <span class="input-wrap">
        <span class="prefix">$</span>
        <input class="inp" type="text" inputmode="decimal" placeholder="e.g. 10 or empty for no cap" bind:value={draft} disabled={saving} />
      </span>
    </label>
    <div class="actions">
      <Button variant="primary" type="submit" disabled={saving}>
        {#if saving}<Icon name="refresh" size={12} /> Saving…{:else}<Icon name="check" size={12} /> Save{/if}
      </Button>
      {#if budgetNum != null}
        <Button variant="ghost" onclick={clear} disabled={saving}><Icon name="x" size={12} /> Clear cap</Button>
      {/if}
    </div>
  </form>
  {#if err}<p class="err" role="alert">{err}</p>{/if}
</Panel>

<style>
  .spark { display: block; width: 100%; height: 26px; margin-bottom: 8px; opacity: 0.9; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  @media (max-width: 560px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .stat {
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    padding: 10px 12px;
  }
  .k {
    display: block;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
  }
  .v {
    display: block;
    margin-top: 4px;
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--color-ink);
  }
  .v.over {
    color: var(--color-bad);
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: 999px;
    background: var(--color-pink);
    transition: width 260ms var(--ease-out);
  }
  .fill.over {
    background: var(--color-bad);
  }
  .hint {
    margin: 7px 0 0;
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .form {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-top: 14px;
    max-width: 520px;
  }
  .fld {
    flex: 1 1 260px;
    min-width: 0;
  }
  .lbl {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    margin-bottom: 6px;
  }
  .input-wrap {
    display: flex;
    align-items: center;
    border: 1px solid var(--color-edge-strong);
    background: var(--color-elevated);
    border-radius: var(--radius-input);
    overflow: hidden;
  }
  .input-wrap:focus-within {
    border-color: var(--color-blue);
    box-shadow: 0 0 0 2px rgba(23, 105, 255, 0.18);
  }
  .prefix {
    padding: 0 8px 0 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-ink-faint);
    user-select: none;
  }
  .inp {
    flex: 1;
    min-width: 0;
    height: 34px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: inherit;
    font-size: 13px;
    padding: 0 10px 0 0;
  }
  .inp::placeholder {
    color: var(--color-ink-faint);
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .err {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--color-bad);
  }
</style>

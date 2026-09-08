<script lang="ts">
  // Routes (§16): combos as ordered fallback chains — name/desc, strategy
  // (gateway vs advisory), primary→fallback chain, usage-attributed reqs /
  // success / latency, ACTIVE status. Click a row → #/routes/:id.
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import StrategyPicker from "../components/route/StrategyPicker.svelte";
  import {
    parseSteps, stepLabel, strategyDef, isGatewayStrategy, routeStatus,
    attributeUsage, primaryOf, fallbacksOf, type Step,
  } from "../components/route/route-data.ts";
  import { api, listCombos, createCombo, updateCombo, deleteCombo, type Combo, type RegistryProvider, type AliasRow, type UsageRow } from "../lib/api.ts";
  import { go } from "../lib/nav.ts";
  import { num, ms, pct } from "../lib/format.ts";

  let combos = $state<Combo[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let aliases = $state<AliasRow[]>([]);
  let usage = $state<UsageRow[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);

  // ── form state ──
  let fName = $state("");
  let fDesc = $state("");
  let fStrategy = $state("priority");
  type StepRow = { model: string; weight: string };
  let steps = $state<StepRow[]>([{ model: "", weight: "1" }]);
  let formErr = $state<string | null>(null);
  let busy = $state(false);
  let showForm = $state(false);

  let pendingDel = $state<string | null>(null);
  let delTimer: ReturnType<typeof setTimeout>;

  const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/i;

  const modelHints = $derived.by(() => {
    const fromReg = registry.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
    const fromAlias = aliases.map((a) => a.alias);
    const set = new Set([...fromReg, ...fromAlias]);
    return [...set].sort().slice(0, 800);
  });

  function normalizeSteps(rows: StepRow[], strategy: string): unknown[] {
    const out: unknown[] = [];
    for (const r of rows) {
      const m = r.model.trim();
      if (!m) continue;
      if (strategy === "weighted") {
        const w = Number(r.weight);
        const weight = Number.isFinite(w) && w > 0 ? w : 1;
        out.push({ model: m, weight });
      } else {
        out.push({ model: m });
      }
    }
    return out;
  }

  function addStep(): void {
    steps = [...steps, { model: "", weight: "1" }];
  }
  function removeStep(idx: number): void {
    if (steps.length === 1) {
      steps = [{ model: "", weight: "1" }];
      return;
    }
    steps = steps.filter((_, i) => i !== idx);
  }

  function stepsOf(c: Combo): Step[] {
    return parseSteps((c as unknown as { steps: unknown }).steps);
  }
  function chainLabel(c: Combo): string {
    const s = stepsOf(c);
    const p = primaryOf(s);
    if (!p) return "—";
    const fb = fallbacksOf(s);
    if (!fb.length) return stepLabel(p);
    if (fb.length === 1) return `${stepLabel(p)} → ${stepLabel(fb[0]!)}`;
    return `${stepLabel(p)} → ${stepLabel(fb[0]!)} → +${fb.length - 1} more`;
  }

  async function refresh(): Promise<void> {
    try {
      const [c, r, a, u] = await Promise.all([listCombos(), api.registry(), api.aliases(), api.usage(168)]);
      combos = (c.combos ?? []) as Combo[];
      registry = r.providers;
      aliases = a.aliases;
      usage = u.rows;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const name = fName.trim();
    if (!NAME_RE.test(name)) {
      formErr = "name must be 2–48 chars, alphanumeric start, then letters/digits . _ -";
      return;
    }
    const built = normalizeSteps(steps, fStrategy);
    if (!built.length) {
      formErr = "add at least one step — a provider/model or alias.";
      return;
    }
    busy = true;
    formErr = null;
    try {
      await createCombo({ name, description: fDesc.trim(), strategy: fStrategy, steps: built, enabled: true });
      fName = "";
      fDesc = "";
      fStrategy = "priority";
      steps = [{ model: "", weight: "1" }];
      showForm = false;
      await refresh();
    } catch (e2) {
      formErr = (e2 as Error).message;
    } finally {
      busy = false;
    }
  }

  async function toggleEnabled(c: Combo): Promise<void> {
    const enabled = !c.enabled;
    try {
      await updateCombo(c.id, { enabled });
      c.enabled = enabled ? 1 : 0;
      combos = [...combos];
    } catch (e2) {
      err = (e2 as Error).message;
    }
  }

  async function del(id: string): Promise<void> {
    if (pendingDel !== id) {
      pendingDel = id;
      clearTimeout(delTimer);
      delTimer = setTimeout(() => (pendingDel = null), 3500);
      return;
    }
    clearTimeout(delTimer);
    pendingDel = null;
    try {
      await deleteCombo(id);
      await refresh();
    } catch (e2) {
      err = (e2 as Error).message;
    }
  }

  function openRow(c: Combo, e: MouseEvent): void {
    // actions inside the row handle themselves — don't navigate
    if ((e.target as HTMLElement | null)?.closest?.("button")) return;
    if (pendingDel === c.id) return;
    go(`#/routes/${c.id}`);
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 5000);
  });
  onDestroy(() => {
    clearInterval(timer);
    clearTimeout(delTimer);
  });
</script>

<div class="head">
  <div>
    <h1>Routes</h1>
    <p class="sub">Combos define ordered fallback chains. Aliases resolve a short name → combo/provider/model; gateway tries steps pre-first-byte. Usage columns match the route's step models over the last 7d.</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
    <Button variant="primary" onclick={() => (showForm = !showForm)}><Icon name={showForm ? "x" : "plus"} size={13} /> {showForm ? "Close" : "New route"}</Button>
  </div>
</div>

{#if showForm}
  <Panel title="New route" sub="name → ordered steps; gateway tries each step until one succeeds pre-first-byte">
    <form class="cform" onsubmit={submit}>
      <div class="frow">
        <label class="fld"><span>Name</span>
          <input class="inp" value={fName} placeholder="coding" maxlength="48" oninput={(e) => (fName = (e.target as HTMLInputElement).value)} />
        </label>
        <label class="fld"><span>Description</span>
          <input class="inp" value={fDesc} placeholder="what this route is for" oninput={(e) => (fDesc = (e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div>
        <div class="lbl">Strategy</div>
        <StrategyPicker bind:value={fStrategy} />
      </div>

      <div class="steps-head">
        <span class="lbl">Steps in failover order</span>
        <Button variant="ghost" onclick={addStep}><Icon name="plus" size={12} /> Add step</Button>
      </div>
      <div class="steps">
        {#each steps as row, i (i)}
          <div class="step-row">
            <span class="idx mono">{i + 1}</span>
            <input class="inp grow" value={row.model} list="rikka-route-hints" placeholder={i === 0 ? "primary — provider/model or alias" : "fallback — provider/model or alias"} aria-label={`step ${i + 1}`}
              oninput={(e) => { steps[i]!.model = (e.target as HTMLInputElement).value; steps = [...steps]; }} />
            {#if fStrategy === "weighted"}
              <input class="inp wgt" type="number" min="0.1" step="0.1" value={row.weight} aria-label={`step ${i + 1} weight`}
                oninput={(e) => { steps[i]!.weight = (e.target as HTMLInputElement).value; steps = [...steps]; }} />
            {/if}
            <Button variant="ghost" onclick={() => removeStep(i)}><Icon name="x" size={12} /></Button>
          </div>
        {/each}
      </div>
      <datalist id="rikka-route-hints">
        {#each modelHints as h (h)}<option value={h}></option>{/each}
      </datalist>
      {#if modelHints.length}
        <p class="fhint">{modelHints.length} suggestions from registry + aliases</p>
      {/if}

      {#if formErr}<p class="ferr" role="alert"><Icon name="bolt" size={12} /> {formErr}</p>{/if}
      <div class="form-actions">
        <Button variant="primary" type="submit" disabled={busy}><Icon name="plus" size={13} /> {busy ? "Creating…" : "Create route"}</Button>
      </div>
    </form>
  </Panel>
{/if}

{#if !booted}
  <div class="skeleton sk-table"></div>
{:else if err && !combos.length}
  <Panel><p class="bad">server unreachable: {err}</p></Panel>
{:else if combos.length === 0}
  <Panel pad={false}>
    <EmptyState title="No routes yet" desc="Create an ordered fallback chain — e.g. openai/gpt-4o → anthropic/claude-sonnet-4 → openai/gpt-4o-mini — and point an alias at it.">
      {#snippet action()}
        <Button variant="primary" onclick={() => (showForm = true)}><Icon name="plus" size={13} /> New route</Button>
      {/snippet}
    </EmptyState>
  </Panel>
{:else}
  <Panel title="Routes" sub="{combos.length} chain{combos.length === 1 ? '' : 's'} · usage 7d · poll every 5s" pad={false}>
    {#if err}<div class="errbar">{err}</div>{/if}
    <table class="tbl">
      <thead>
        <tr><th>Name</th><th>Strategy</th><th>Chain</th><th class="r">Reqs</th><th class="r">Success</th><th class="r">Latency</th><th>Status</th><th class="r">Actions</th></tr>
      </thead>
      <tbody>
        {#each combos as c (c.id)}
          {@const st = attributeUsage(stepsOf(c), usage, aliases)}
          {@const rs = routeStatus(c, stepsOf(c))}
          <tr class="clickable" onclick={(e) => openRow(c, e)}>
            <td>
              <div class="nm">{c.name}</div>
              {#if c.description}<div class="desc">{c.description}</div>{/if}
            </td>
            <td>
              <StatusPill tone={isGatewayStrategy(c.strategy) ? "active" : "muted"} label={strategyDef(c.strategy).name} />
              {#if !isGatewayStrategy(c.strategy)}<div class="adv">advisory</div>{/if}
            </td>
            <td><div class="chain mono" title={stepsOf(c).map(stepLabel).join(" → ")}>{chainLabel(c)}</div></td>
            <td class="r mono" title="usage rows matching this route's step models">{st.matched ? num(st.reqs) : "—"}</td>
            <td class="r mono">{st.success != null ? pct(st.success) : "—"}</td>
            <td class="r mono">{ms(st.avgMs)}</td>
            <td><StatusPill tone={rs.tone} label={rs.label} /></td>
            <td class="r">
              <span class="acts">
                <button class="tog" class:on={!!c.enabled} onclick={() => void toggleEnabled(c)} aria-pressed={!!c.enabled} title={c.enabled ? "pause" : "resume"}>
                  <span class="dot"></span>
                  {c.enabled ? "on" : "off"}
                </button>
                {#if pendingDel === c.id}
                  <Button variant="danger" onclick={() => void del(c.id)}><Icon name="trash" size={12} /> Confirm</Button>
                  <Button variant="ghost" onclick={() => (pendingDel = null)}>Cancel</Button>
                {:else}
                  <Button variant="ghost" onclick={() => void del(c.id)}><Icon name="trash" size={12} /> Delete</Button>
                {/if}
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
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
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .sub { margin: 3px 0 0; font-size: 12.5px; color: var(--color-ink-muted); line-height: 1.5; max-width: 640px; }
  .hdr-actions { display: flex; gap: 8px; }
  .cform { display: flex; flex-direction: column; gap: 12px; }
  .frow { display: grid; grid-template-columns: 240px 1fr; gap: 10px; }
  @media (max-width: 640px) { .frow { grid-template-columns: 1fr; } }
  .fld { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
  .fld span { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-soft); }
  .inp {
    height: 34px;
    border: 1px solid var(--color-edge-strong);
    background: var(--color-elevated);
    border-radius: var(--radius-input);
    color: var(--color-ink);
    font-family: inherit;
    font-size: 13px;
    padding: 0 10px;
    outline: 0;
    min-width: 0;
  }
  .inp:focus { border-color: var(--color-blue); box-shadow: 0 0 0 2px rgba(23,105,255,0.18); }
  .inp::placeholder { color: var(--color-ink-faint); }
  .steps-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
  .lbl { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-soft); margin-bottom: 8px; display: block; }
  .steps { display: flex; flex-direction: column; gap: 8px; }
  .step-row { display: flex; gap: 8px; align-items: center; }
  .idx { color: var(--color-ink-faint); width: 18px; text-align: right; flex-shrink: 0; }
  .grow { flex: 1; }
  .wgt { width: 84px; flex: 0 0 84px; }
  .fhint { margin: 0; font-size: 11px; color: var(--color-ink-faint); }
  .ferr { margin: 0; font-size: 12px; color: var(--color-bad); display: flex; gap: 6px; align-items: center; }
  .form-actions { display: flex; gap: 8px; margin-top: 2px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-faint); padding: 10px 12px; border-bottom: 1px solid var(--color-edge); }
  .tbl td { padding: 11px 12px; border-bottom: 1px solid var(--color-edge); vertical-align: middle; }
  .tbl tr:last-child td { border-bottom: 0; }
  .tbl tr.clickable { cursor: pointer; }
  .tbl tr.clickable:hover td { background: rgba(255,255,255,0.015); }
  .r { text-align: right; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .nm { font-weight: 600; color: var(--color-ink); }
  .desc { font-size: 12px; color: var(--color-ink-muted); margin-top: 2px; }
  .chain { font-size: 11.5px; color: var(--color-ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
  .adv { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-warn); margin-top: 4px; }
  .acts { display: inline-flex; gap: 6px; align-items: center; }
  .bad { color: var(--color-bad); font-size: 13px; padding: 16px; }
  .errbar { padding: 8px 12px; font-size: 12px; color: var(--color-bad); border-bottom: 1px solid var(--color-edge); background: rgba(255,77,94,0.06); }
  .tog {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 10px 0 8px;
    border-radius: 999px;
    border: 1px solid var(--color-edge-strong);
    background: var(--color-elevated);
    color: var(--color-ink-muted);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }
  .tog.on { border-color: rgba(46,230,168,0.35); color: var(--color-ink); background: rgba(46,230,168,0.08); }
  .tog .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-ink-faint); }
  .tog.on .dot { background: var(--color-ok); }
  .skeleton { height: 160px; border: 1px solid var(--color-edge); border-radius: var(--radius-panel); background: var(--color-base); animation: rise var(--dur-panel) var(--ease-out) both; }
</style>

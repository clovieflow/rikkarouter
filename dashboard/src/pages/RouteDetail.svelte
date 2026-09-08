<script lang="ts">
  // Route Detail (§17): header (name/status + Edit/Duplicate/Pause), canvas,
  // rules, provider chain, stats. Every persist goes through /api/combos
  // (updateCombo); rule *sources* stay a local draft (see RuleBuilder).
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import Timeline from "../components/Timeline.svelte";
  import RouteCanvas, { type CanvasNode } from "../components/route/RouteCanvas.svelte";
  import StrategyPicker from "../components/route/StrategyPicker.svelte";
  import RuleBuilder from "../components/route/RuleBuilder.svelte";
  import {
    parseSteps, stepLabel, strategyDef, isGatewayStrategy, routeStatus, attributeUsage,
    compileRules, loadRuleDraft, saveRuleDraft, type Step, type RouteRule,
  } from "../components/route/route-data.ts";
  import { api, listCombos, createCombo, updateCombo, type Combo, type RegistryProvider, type AliasRow, type UsageRow } from "../lib/api.ts";
  import { route, go } from "../lib/nav.ts";
  import { toast } from "../lib/toast.ts";
  import { num, ms, pct } from "../lib/format.ts";
  let aliases = $state<AliasRow[]>([]);
  let usage = $state<UsageRow[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let booted = $state(false);
  let combo = $state<Combo | null>(null);
  const comboId = $derived(($route.split("/")[2] ?? "").split("?")[0]);
  let err = $state<string | null>(null);
  let saving = $state(false);

  // working copy — everything edits this; Save persists via updateCombo
  let wName = $state("");
  let wDesc = $state("");
  let wStrategy = $state("priority");
  let wSteps = $state<Step[]>([]);
  let editingMeta = $state(false);
  let node = $state<CanvasNode | null>(null);
  let rules = $state<RouteRule[]>([]);
  let newStep = $state("");

  const stepsOf = $derived(parseSteps(combo?.steps));
  const dirty = $derived.by(() => {
    if (!combo) return false;
    return (
      wName !== combo.name ||
      wDesc !== (combo.description ?? "") ||
      wStrategy !== (combo.strategy ?? "priority") ||
      JSON.stringify(wSteps) !== JSON.stringify(stepsOf)
    );
  });
  const stats = $derived(attributeUsage(wSteps.length ? wSteps : stepsOf, usage, aliases));
  const status = $derived(combo ? routeStatus(combo, stepsOf) : { tone: "muted" as const, label: "—" });

  const modelHints = $derived.by(() => {
    const fromReg = registry.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
    const fromAlias = aliases.map((a) => a.alias);
    return [...new Set([...fromReg, ...fromAlias])].sort().slice(0, 800);
  });

  function resetWorking(c: Combo): void {
    wName = c.name;
    wDesc = c.description ?? "";
    wStrategy = c.strategy ?? "priority";
    wSteps = parseSteps(c.steps);
  }

  async function refresh(): Promise<void> {
    try {
      const [c, r, a, u] = await Promise.all([listCombos(), api.registry(), api.aliases(), api.usage(168)]);
      const hit = (c.combos ?? []).find((x) => x.id === comboId) ?? null;
      combo = hit
        ? { ...hit, steps: parseSteps((hit as unknown as { steps: unknown }).steps) as unknown as unknown[] } as Combo
        : null;
      if (combo && !dirty) resetWorking(combo);
      if (combo && !booted) {
        resetWorking(combo);
        rules = loadRuleDraft(combo.id);
      }
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

  async function save(): Promise<void> {
    if (!combo || !dirty) return;
    const name = wName.trim();
    if (!name) {
      toast("name is required", "err");
      return;
    }
    if (!wSteps.length) {
      toast("a route needs at least one step", "err");
      return;
    }
    saving = true;
    try {
      await updateCombo(combo.id, {
        name,
        description: wDesc.trim(),
        strategy: wStrategy,
        steps: wSteps.map((s) => (s.weight != null ? { model: s.model, weight: s.weight } : { model: s.model })),
      });
      toast("route saved", "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      saving = false;
    }
  }

  async function togglePause(): Promise<void> {
    if (!combo) return;
    try {
      await updateCombo(combo.id, { enabled: !combo.enabled });
      toast(combo.enabled ? "route paused" : "route resumed", "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  async function duplicate(): Promise<void> {
    if (!combo) return;
    const base = `${combo.name}-copy`;
    try {
      const r = await createCombo({
        name: base,
        description: combo.description ?? "",
        strategy: combo.strategy ?? "priority",
        steps: stepsOf.map((s) => (s.weight != null ? { model: s.model, weight: s.weight } : { model: s.model })),
        enabled: false,
      });
      toast(`duplicated as ${r.name} (paused)`, "ok");
      go(`#/routes/${r.id}`);
      booted = false;
      await refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  function applyCompiled(): void {
    const { steps, notes } = compileRules(wSteps, rules);
    if (!steps.length) {
      toast("compiled order is empty — nothing to apply", "err");
      return;
    }
    wSteps = steps;
    if (combo) saveRuleDraft(combo.id, rules);
    toast(`compiled ${rules.length} rule${rules.length === 1 ? "" : "s"} → ${steps.length} steps${notes.length ? " (see notes)" : ""}`, "ok");
  }

  function moveStep(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= wSteps.length) return;
    const next = [...wSteps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    wSteps = next;
  }
  function dropStep(i: number): void {
    wSteps = wSteps.filter((_, j) => j !== i);
  }
  function addStep(): void {
    const m = newStep.trim();
    if (!m) return;
    wSteps = [...wSteps, wStrategy === "weighted" ? { model: m, weight: 1 } : { model: m }];
    newStep = "";
  }
  function makePrimary(i: number): void {
    if (i <= 0) return;
    const next = [...wSteps];
    const [hit] = next.splice(i, 1);
    wSteps = [hit!, ...next];
  }

  function stepStats(s: Step) {
    return attributeUsage([s], usage, aliases);
  }

  $effect(() => {
    // id changed (duplicate / nav) → reload; also runs on mount
    comboId;
    booted = false;
    void refresh();
  });
  $effect(() => {
    // rule sources are a local draft — persist on change
    if (combo && booted) saveRuleDraft(combo.id, rules);
  });
</script>

<div class="head">
  <button class="back" onclick={() => go("#/routes")}><Icon name="routes" size={13} /> Routes</button>
  {#if combo}
    <div class="title-row">
      <div>
        <h1>{combo.name}</h1>
        {#if combo.description}<p class="sub">{combo.description}</p>{/if}
      </div>
      <div class="hdr-actions">
        <StatusPill tone={status.tone} label={status.label} />
        {#if !isGatewayStrategy(combo.strategy)}<StatusPill tone="warn" label="advisory strategy" />{/if}
        {#if dirty}
          <Button variant="primary" onclick={() => void save()} disabled={saving}><Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}</Button>
        {/if}
        <Button variant="secondary" onclick={() => (editingMeta = !editingMeta)}><Icon name="aliases" size={12} /> {editingMeta ? "Done" : "Edit"}</Button>
        <Button variant="secondary" onclick={() => void duplicate()}><Icon name="copy" size={12} /> Duplicate</Button>
        <Button variant={combo.enabled ? "ghost" : "secondary"} onclick={() => void togglePause()}>
          <Icon name={combo.enabled ? "x" : "check"} size={12} /> {combo.enabled ? "Pause" : "Resume"}
        </Button>
      </div>
    </div>
    {#if editingMeta}
      <Panel title="Edit route" sub="name + description persist to the combo record">
        <div class="meta-form">
          <label class="fld"><span>Name</span>
            <input class="inp" value={wName} oninput={(e) => (wName = (e.target as HTMLInputElement).value)} />
          </label>
          <label class="fld"><span>Description</span>
            <input class="inp" value={wDesc} placeholder="what this route is for" oninput={(e) => (wDesc = (e.target as HTMLInputElement).value)} />
          </label>
        </div>
      </Panel>
    {/if}
  {/if}
</div>

{#if !booted}
  <div class="skeleton"></div>
{:else if err && !combo}
  <Panel><p class="bad">server unreachable: {err}</p></Panel>
{:else if !combo}
  <Panel pad={false}>
    <EmptyState title="Route not found" desc="No combo with this id. It may have been deleted.">
      {#snippet action()}
        <Button variant="primary" onclick={() => go("#/routes")}>Back to Routes</Button>
      {/snippet}
    </EmptyState>
  </Panel>
{:else}
  {#if err}<div class="errbar">{err}</div>{/if}
  <div class="grid">
    <Panel title="Canvas" sub="click a node to edit it">
      <RouteCanvas comboName={wName} strategy={wStrategy} steps={wSteps} selected={node} onselect={(n) => (node = node === n ? null : n)} />
    </Panel>

    <div class="side">
      {#if node === "incoming"}
        <Panel title="Incoming" sub="the model string clients send">
          <p class="explain">Clients address this route as <code class="mono">{wName || "…"}</code> (or via an alias pointing at it). Rename it under Edit — in-flight clients using the old name stop matching.</p>
        </Panel>
      {:else if node === "policy"}
        <Panel title="Policy" sub="strategy preference stored on the combo">
          <StrategyPicker bind:value={wStrategy} />
        </Panel>
      {:else if node === "decision"}
        <Panel title="Decision" sub="how the gateway picks a candidate">
          <Timeline label="Decision trace" items={[
            { title: "Expand steps", desc: "each step resolves to provider connections; steps with none are skipped", tone: "blue" },
            { title: wStrategy === "weighted" ? "Sort by weight desc" : "Keep step order", desc: wStrategy === "weighted" ? "then connection priority" : "priority fallback — first success wins", tone: "blue" },
            { title: "Try pre-first-byte", desc: "failures fall through to the next candidate", tone: "muted" },
          ]} />
        </Panel>
      {:else if node === "primary"}
        <Panel title="Primary" sub="step tried first — pick one">
          {#if wSteps.length}
            <div class="plist">
              {#each wSteps as s, i (i)}
                <button class="prow" class:sel={i === 0} onclick={() => makePrimary(i)} title={i === 0 ? "already primary" : "make primary"}>
                  <span class="mono">{stepLabel(s)}</span>
                  {#if i === 0}<span class="cur">primary</span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="empty">No steps yet — add one below.</p>
          {/if}
        </Panel>
      {:else if node === "fallback"}
        <Panel title="Fallback chain" sub="order is the failover order">
          <div class="steps">
            {#each wSteps as s, i (i)}
              <div class="srow">
                <span class="idx mono">{i + 1}</span>
                <input class="inp grow" value={s.model} list="rd-hints" aria-label={`step ${i + 1} model`}
                  oninput={(e) => { wSteps[i]!.model = (e.target as HTMLInputElement).value; wSteps = [...wSteps]; }} />
                {#if wStrategy === "weighted"}
                  <input class="inp wgt" type="number" min="0.1" step="0.1" value={s.weight ?? 1} aria-label={`step ${i + 1} weight`}
                    oninput={(e) => { const v = Number((e.target as HTMLInputElement).value); wSteps[i]!.weight = Number.isFinite(v) && v > 0 ? v : 1; wSteps = [...wSteps]; }} />
                {/if}
                <button class="mini" onclick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button class="mini" onclick={() => moveStep(i, 1)} disabled={i === wSteps.length - 1} aria-label="Move down">↓</button>
                <button class="mini danger" onclick={() => dropStep(i)} aria-label="Remove step"><Icon name="trash" size={12} /></button>
              </div>
            {/each}
          </div>
          <datalist id="rd-hints">
            {#each modelHints as h (h)}<option value={h}></option>{/each}
          </datalist>
          <div class="addrow">
            <input class="inp grow" value={newStep} list="rd-hints" placeholder="provider/model or alias — Enter to add" aria-label="new step"
              oninput={(e) => (newStep = (e.target as HTMLInputElement).value)}
              onkeydown={(e) => { if (e.key === "Enter") addStep(); }} />
            <Button variant="secondary" onclick={addStep}><Icon name="plus" size={12} /> Add</Button>
          </div>
        </Panel>
      {:else if node === "response"}
        <Panel title="Response" sub="first success wins; usage is recorded">
          <dl class="kv">
            <div><dt>Requests (7d, steps)</dt><dd class="mono">{stats.matched ? num(stats.reqs) : "—"}</dd></div>
            <div><dt>Success</dt><dd class="mono">{stats.success != null ? pct(stats.success) : "—"}</dd></div>
            <div><dt>Avg latency</dt><dd class="mono">{ms(stats.avgMs)}</dd></div>
          </dl>
          {#if !stats.matched}<p class="empty">No usage rows match this route's steps yet.</p>{/if}
        </Panel>
      {:else}
        <Panel title="Inspector" sub="select a canvas node">
          <p class="empty">Click INCOMING, POLICY, DECISION, PRIMARY, FALLBACK, or RESPONSE to edit that part of the route. Unsaved edits are marked in the header.</p>
        </Panel>
      {/if}

      <Panel title="Strategy" sub={strategyDef(wStrategy).gateway ? "executed by the gateway" : "advisory — stored as preference"}>
        <StrategyPicker bind:value={wStrategy} />
      </Panel>
    </div>
  </div>

  <Panel title="Rules" sub="IF/AND/THEN → compiled step order">
    <div class="row" style="margin-bottom:8px">
      <Button variant="secondary" onclick={applyCompiled} disabled={!rules.length}><Icon name="bolt" size={12} /> Apply compiled order</Button>
    </div>
    <RuleBuilder steps={wSteps} bind:rules hints={modelHints} draft={true} />
  </Panel>

  <Panel title="Provider chain" sub="expanded steps with 7d usage" pad={false}>
    <table class="tbl">
      <thead><tr><th>#</th><th>Step</th><th class="r">Reqs</th><th class="r">Success</th><th class="r">Avg latency</th></tr></thead>
      <tbody>
        {#each wSteps as s, i (i)}
          {@const st = stepStats(s)}
          <tr>
            <td class="mono">{i + 1}{i === 0 ? " · primary" : ""}</td>
            <td class="mono">{stepLabel(s)}</td>
            <td class="r mono">{st.matched ? num(st.reqs) : "—"}</td>
            <td class="r mono">{st.success != null ? pct(st.success) : "—"}</td>
            <td class="r mono">{ms(st.avgMs)}</td>
          </tr>
        {/each}
        {#if !wSteps.length}
          <tr><td colspan="5" class="empty-cell">No steps.</td></tr>
        {/if}
      </tbody>
    </table>
  </Panel>
{/if}

<style>
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .head { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
  .back {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
    background: none; border: none; cursor: pointer; font-family: inherit;
    font-size: 12.5px; color: var(--color-ink-muted); padding: 0;
  }
  .back:hover { color: var(--color-ink); }
  .title-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; overflow-wrap: anywhere; }
  .sub { margin: 3px 0 0; font-size: 12.5px; color: var(--color-ink-muted); }
  .hdr-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
  .side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .meta-form { display: grid; grid-template-columns: 240px 1fr; gap: 10px; }
  @media (max-width: 640px) { .meta-form { grid-template-columns: 1fr; } }
  .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .fld span { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-soft); }
  .inp {
    height: 34px; border: 1px solid var(--color-edge-strong); background: var(--color-elevated);
    border-radius: var(--radius-input); color: var(--color-ink);
    font-family: inherit; font-size: 13px; padding: 0 10px; outline: 0; min-width: 0;
  }
  .inp:focus { border-color: var(--color-blue); }
  .grow { flex: 1; }
  .wgt { width: 76px; flex: 0 0 76px; }
  .explain { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--color-ink-muted); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  code.mono { background: var(--color-elevated); border: 1px solid var(--color-edge); border-radius: 4px; padding: 1px 6px; }
  .empty { margin: 0; font-size: 12.5px; color: var(--color-ink-muted); line-height: 1.6; }
  .plist { display: flex; flex-direction: column; gap: 6px; }
  .prow {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    border: 1px solid var(--color-edge); border-radius: var(--radius-card);
    background: var(--color-raised); color: var(--color-ink); font-family: inherit;
    padding: 8px 10px; cursor: pointer; text-align: left;
  }
  .prow:hover { border-color: var(--color-edge-strong); }
  .prow.sel { border-color: var(--color-ok); }
  .cur { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-ok); }
  .steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .srow { display: flex; gap: 6px; align-items: center; }
  .idx { color: var(--color-ink-faint); width: 18px; text-align: right; flex-shrink: 0; }
  .mini {
    border: 1px solid var(--color-edge-strong); background: transparent;
    color: var(--color-ink-muted); border-radius: var(--radius-ctl);
    font-size: 12px; padding: 5px 8px; cursor: pointer; flex-shrink: 0;
    display: inline-flex; align-items: center;
  }
  .mini:hover:not(:disabled) { color: var(--color-ink); border-color: #34344c; }
  .mini:disabled { opacity: 0.35; cursor: default; }
  .mini.danger { color: var(--color-bad); border-color: rgba(255,77,94,0.35); }
  .addrow { display: flex; gap: 8px; }
  .kv { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .kv div { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; }
  .kv dt { color: var(--color-ink-muted); }
  .kv dd { margin: 0; color: var(--color-ink); }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-faint); padding: 10px 12px; border-bottom: 1px solid var(--color-edge); }
  .tbl td { padding: 9px 12px; border-bottom: 1px solid var(--color-edge); }
  .tbl tr:last-child td { border-bottom: 0; }
  .r { text-align: right; }
  .empty-cell { color: var(--color-ink-faint); font-size: 12.5px; }
  .bad { color: var(--color-bad); font-size: 13px; padding: 16px; }
  .errbar { padding: 8px 12px; font-size: 12px; color: var(--color-bad); border: 1px solid var(--color-edge); border-radius: var(--radius-card); background: rgba(255,77,94,0.06); margin-bottom: 12px; }
  .skeleton { height: 220px; border: 1px solid var(--color-edge); border-radius: var(--radius-panel); background: var(--color-base); }
</style>

<script lang="ts">
  // RuleBuilder (§20): IF/AND/THEN rules compiled to the static step order the
  // gateway understands. Conditions are advisory (not evaluated at request
  // time); the compiled steps are what get saved to the combo. Rule sources
  // persist to localStorage per combo ("local draft") — the server stores
  // name/description/strategy/steps/enabled only.
  import Button from "../Button.svelte";
  import Icon from "../Icon.svelte";
  import Select from "../Select.svelte";
  import {
    RULE_FIELDS, RULE_OPS, RULE_ACTIONS, compileRules, newRuleId,
    type RuleCond, type RouteRule, type Step,
  } from "./route-data.ts";

  let {
    steps,
    rules = $bindable<RouteRule[]>([]),
    hints = [],
    draft = false,
  }: {
    steps: Step[];
    rules?: RouteRule[];
    hints?: string[];
    draft?: boolean;
  } = $props();

  const compiled = $derived(compileRules(steps, rules));

  function addRule(): void {
    rules = [
      ...rules,
      {
        id: newRuleId(),
        conds: [{ field: "status", op: "eq", value: "error" }],
        action: "prefer",
        target: steps[0]?.model ?? "",
      },
    ];
  }
  function dropRule(id: string): void {
    rules = rules.filter((r) => r.id !== id);
  }
  function addCond(r: RouteRule): void {
    r.conds = [...r.conds, { field: "latency_ms", op: "gt", value: "2000" }];
    rules = [...rules];
  }
  function dropCond(r: RouteRule, i: number): void {
    r.conds = r.conds.filter((_, j) => j !== i);
    rules = [...rules];
  }

  const dlId = `rb-hints-${Math.floor(Math.random() * 1e6)}`;
</script>

<div class="rb">
  <div class="rb-head">
    <div>
      <span class="lbl">Rules</span>
      {#if draft}<span class="draft">local draft</span>{/if}
    </div>
    <Button variant="secondary" onclick={addRule}><Icon name="plus" size={12} /> Add rule</Button>
  </div>
  {#if draft}
    <p class="draft-note">Rule sources live in this browser only (the server stores compiled steps). Save writes the compiled order to the combo.</p>
  {/if}

  {#if !rules.length}
    <p class="empty">No rules. The gateway executes the step order as-is. Add a rule to pin a step first/last or skip it.</p>
  {:else}
    <div class="rules">
      {#each rules as r (r.id)}
        <div class="rule">
          <div class="row ifrow">
            <span class="kw">IF</span>
            <div class="conds">
              {#each r.conds as c, i (i)}
                <div class="cond">
                  {#if i > 0}<span class="kw and">AND</span>{/if}
                  <Select label="field" compact value={c.field} options={RULE_FIELDS} onchange={(v) => { c.field = v as RuleCond["field"]; rules = [...rules]; }} />
                  <Select label="operator" compact value={c.op} options={RULE_OPS} onchange={(v) => { c.op = v as RuleCond["op"]; rules = [...rules]; }} />
                  <input class="inp" value={c.value} placeholder="value" aria-label="condition value"
                    oninput={(e) => { c.value = (e.target as HTMLInputElement).value; rules = [...rules]; }} />
                  {#if r.conds.length > 1}
                    <button class="mini" onclick={() => dropCond(r, i)} aria-label="Remove condition">×</button>
                  {/if}
                </div>
              {/each}
            </div>
            <button class="mini" onclick={() => addCond(r)} title="Add AND condition">+ AND</button>
          </div>
          <div class="row">
            <span class="kw">THEN</span>
            <Select label="action" compact value={r.action} options={RULE_ACTIONS.map((a) => ({ value: a.action, label: a.label }))} onchange={(v) => { r.action = v as RouteRule["action"]; rules = [...rules]; }} />
            <input class="inp grow" value={r.target} list={dlId} placeholder="provider/model or alias" aria-label="rule target"
              oninput={(e) => { r.target = (e.target as HTMLInputElement).value; rules = [...rules]; }} />
            <button class="mini danger" onclick={() => dropRule(r.id)} aria-label="Delete rule"><Icon name="trash" size={12} /></button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <datalist id={dlId}>
    {#each hints as h (h)}<option value={h}></option>{/each}
  </datalist>

  <div class="compiled">
    <span class="lbl">Compiled order → saved to combo steps</span>
    {#if compiled.steps.length}
      <ol class="mono">
        {#each compiled.steps as s, i (i)}
          <li>{i + 1}. {s.model}{s.weight != null ? ` (w ${s.weight})` : ""}</li>
        {/each}
      </ol>
    {:else}
      <p class="empty">Compiles to an empty chain — the gateway would reject this combo.</p>
    {/if}
    {#if compiled.notes.length}
      <ul class="notes">
        {#each compiled.notes as n (n)}<li>{n}</li>{/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .rb { display: flex; flex-direction: column; gap: 10px; }
  .rb-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .lbl { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-soft); }
  .draft {
    margin-left: 8px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--color-warn); border: 1px solid rgba(255,181,70,0.35);
    border-radius: 999px; padding: 1px 7px;
  }
  .draft-note { margin: 0; font-size: 11.5px; color: var(--color-ink-faint); }
  .empty { margin: 0; font-size: 12.5px; color: var(--color-ink-muted); }
  .rules { display: flex; flex-direction: column; gap: 8px; }
  .rule {
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    padding: 10px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .kw { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--color-blue-bright); }
  .kw.and { color: var(--color-ink-faint); }
  .conds { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
  .cond { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .inp {
    height: 28px; min-width: 0; width: 110px;
    border: 1px solid var(--color-edge-strong); background: var(--color-elevated);
    border-radius: var(--radius-ctl); color: var(--color-ink);
    font-family: inherit; font-size: 12px; padding: 0 8px; outline: 0;
  }
  .inp:focus { border-color: var(--color-blue); }
  .grow { flex: 1; width: auto; }
  .mini {
    border: 1px solid var(--color-edge-strong); background: transparent;
    color: var(--color-ink-muted); border-radius: var(--radius-ctl);
    font-size: 11.5px; padding: 3px 8px; cursor: pointer;
    display: inline-flex; align-items: center;
  }
  .mini:hover { color: var(--color-ink); border-color: #34344c; }
  .mini.danger { color: var(--color-bad); border-color: rgba(255,77,94,0.35); }
  .compiled {
    border-top: 1px solid var(--color-edge);
    padding-top: 10px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .mono { margin: 0; padding-left: 20px; font-family: var(--font-mono); font-size: 12px; color: var(--color-ink); }
  .mono li { margin: 2px 0; }
  .notes { margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--color-ink-faint); }
  .notes li { margin: 2px 0; }
</style>

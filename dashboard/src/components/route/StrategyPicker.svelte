<script lang="ts">
  // StrategyPicker (§19): the 7 routing strategies. Only priority + weighted
  // are executed by the gateway; the rest are stored as a preference and
  // honestly badged "advisory".
  import { STRATEGIES } from "./route-data.ts";

  let { value = $bindable("priority") }: { value?: string } = $props();

  let root: HTMLDivElement | undefined = $state();

  function focusOpt(id: string): void {
    root?.querySelector<HTMLElement>(`[data-opt="${id}"]`)?.focus();
  }
  function choose(id: string, focus: boolean): void {
    value = id;
    if (focus) queueMicrotask(() => focusOpt(id));
  }
  function step(from: string, dir: number): void {
    const i = STRATEGIES.findIndex((s) => s.id === from);
    const n = STRATEGIES.length;
    const next = STRATEGIES[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + n) % n];
    if (next) choose(next.id, true);
  }
  function onOptKey(e: KeyboardEvent, id: string): void {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      step(id, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      step(id, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = STRATEGIES[0];
      if (first) choose(first.id, true);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = STRATEGIES[STRATEGIES.length - 1];
      if (last) choose(last.id, true);
    }
  }
</script>

<div class="strat" role="radiogroup" aria-label="Routing strategy" bind:this={root}>
  {#each STRATEGIES as s (s.id)}
    <button
      type="button"
      role="radio"
      aria-checked={value === s.id}
      tabindex={value === s.id ? 0 : -1}
      data-opt={s.id}
      class="opt"
      class:sel={value === s.id}
      onclick={() => choose(s.id, false)}
      onkeydown={(e) => onOptKey(e, s.id)}
    >
      <span class="top">
        <span class="nm">{s.name}</span>
        {#if s.gateway}
          <span class="badge gw">gateway</span>
        {:else}
          <span class="badge adv">advisory</span>
        {/if}
      </span>
      <span class="ds">{s.desc}</span>
    </button>
  {/each}
</div>
{#if value !== "priority" && value !== "weighted"}
  <p class="note">“{STRATEGIES.find((s) => s.id === value)?.name}” is advisory: the gateway executes priority order. The choice is stored on the combo as a preference.</p>
{/if}

<style>
  .strat {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    text-align: left;
    padding: 10px 11px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    color: var(--color-ink);
    font-family: inherit;
    cursor: pointer;
  }
  .opt:hover { border-color: var(--color-edge-strong); }
  .opt.sel { border-color: var(--color-blue); background: rgba(23, 105, 255, 0.07); }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
  }
  .nm { font-size: 12.5px; font-weight: 600; }
  .badge {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--color-edge-strong);
    white-space: nowrap;
  }
  .badge.gw { color: var(--color-ok); border-color: rgba(46, 230, 168, 0.35); }
  .badge.adv { color: var(--color-warn); border-color: rgba(255, 181, 70, 0.35); }
  .ds { font-size: 11.5px; line-height: 1.5; color: var(--color-ink-muted); }
  .note {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-warn);
  }
</style>

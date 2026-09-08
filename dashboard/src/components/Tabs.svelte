<script lang="ts" generics="T extends string">
  // Tabs (§46): segmented control. Controlled via bind:value.
  let {
    tabs,
    value = $bindable(),
    label = "Views",
  }: {
    tabs: { id: T; label: string }[];
    value: T;
    label?: string;
  } = $props();

  function onKeys(e: KeyboardEvent): void {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === value);
    const d = e.key === "ArrowRight" ? 1 : -1;
    const n = tabs[(i + d + tabs.length) % tabs.length];
    if (n) value = n.id;
  }
</script>

<div class="tabs" role="tablist" aria-label={label} tabindex={0} onkeydown={onKeys}>
  {#each tabs as t (t.id)}
    <button
      class="tab"
      class:on={value === t.id}
      role="tab"
      aria-selected={value === t.id}
      tabindex={value === t.id ? 0 : -1}
      onclick={() => (value = t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    background: var(--color-raised);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    margin-bottom: 12px;
  }
  .tab {
    height: 26px;
    padding: 0 14px;
    background: none;
    border: none;
    border-radius: calc(var(--radius-ctl) - 1px);
    color: var(--color-ink-muted);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: color var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out);
  }
  .tab:hover {
    color: var(--color-ink);
  }
  .tab.on {
    background: var(--color-elevated);
    color: var(--color-pink);
    box-shadow: inset 0 -2px 0 var(--color-pink);
  }
</style>

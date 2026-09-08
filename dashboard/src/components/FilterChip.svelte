<script lang="ts">
  import type { Snippet } from "svelte";
  // FilterChip (§46): pill toggle for filters. Controlled via `active`.
  let {
    active = false,
    label,
    onclick,
    children,
  }: {
    active?: boolean;
    label?: string;
    onclick?: () => void;
    children?: Snippet;
  } = $props();
</script>

<button class="chip" class:on={active} aria-pressed={active} aria-label={label} {onclick}>
  {#if children}{@render children()}{:else}{label}{/if}
</button>

<style>
  .chip {
    height: 30px;
    padding: 0 11px;
    background: transparent;
    border: 1px solid var(--color-edge-strong);
    border-radius: 999px;
    color: var(--color-ink-muted);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out);
  }
  .chip:hover {
    color: var(--color-ink);
  }
  .chip.on {
    color: var(--color-pink-soft);
    border-color: rgba(255, 22, 140, 0.5);
    background: rgba(255, 22, 140, 0.08);
  }
</style>

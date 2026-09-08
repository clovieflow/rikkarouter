<script lang="ts">
  // Select (§46): labeled dropdown. `compact` matches the 28px toolbar size.
  export interface SelOpt {
    value: string;
    label: string;
  }
  let {
    value = $bindable(""),
    options,
    label,
    prefix,
    compact = false,
    onchange,
  }: {
    value?: string;
    options: SelOpt[];
    label: string;
    prefix?: string;
    compact?: boolean;
    onchange?: (v: string) => void;
  } = $props();
</script>

<label class="selw" class:compact>
  {#if prefix}<span class="fl">{prefix}</span>{/if}
  <select bind:value aria-label={label} onchange={() => onchange?.(value)}>
    {#each options as o (o.value)}
      <option value={o.value}>{o.label}</option>
    {/each}
  </select>
</label>

<style>
  .selw {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 10px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-input);
    color: var(--color-ink-soft);
  }
  .selw.compact {
    height: 28px;
    border-color: var(--color-edge-strong);
    border-radius: var(--radius-ctl);
  }
  .fl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-ink-faint);
  }
  .selw select {
    background: none;
    border: none;
    outline: none;
    color: var(--color-ink);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    min-width: 0;
  }
  .selw select option {
    background: var(--color-raised);
    color: var(--color-ink);
  }
</style>

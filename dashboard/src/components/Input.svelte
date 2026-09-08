<script lang="ts">
  import type { Snippet } from "svelte";
  // Input (§46): search / filter / text field with optional leading icon.
  // `roomy` matches the 30px catalog search; `block` matches dialog inputs.
  let {
    value = $bindable(""),
    placeholder = "",
    label,
    type = "text",
    maxlength,
    width,
    roomy = false,
    block = false,
    el = $bindable<HTMLInputElement | undefined>(undefined),
    icon,
    onEnter,
  }: {
    value?: string;
    placeholder?: string;
    label: string;
    type?: string;
    maxlength?: number;
    width?: string;
    roomy?: boolean;
    block?: boolean;
    el?: HTMLInputElement | undefined;
    icon?: Snippet;
    onEnter?: () => void;
  } = $props();
</script>

<label class="field" class:roomy class:block>
  {#if icon}<span class="ic">{@render icon()}</span>{/if}
  <input
    bind:this={el}
    {type}
    {placeholder}
    aria-label={label}
    bind:value
    {maxlength}
    onkeydown={(e) => {
      if (e.key === "Enter") onEnter?.();
    }}
    style={width && !block ? `width:${width}` : undefined}
  />
</label>

<style>
  .field {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 10px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-ctl);
    color: var(--color-ink-faint);
  }
  .field:focus-within {
    color: var(--color-pink);
  }
  .field.roomy {
    height: 30px;
    border-color: var(--color-edge);
    border-radius: var(--radius-input);
  }
  .field.block {
    display: flex;
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 11px;
    border-radius: var(--radius-input);
  }
  .field.block:focus-within {
    border-color: var(--color-pink);
    color: var(--color-ink-faint);
  }
  .ic {
    display: inline-flex;
    flex-shrink: 0;
  }
  .field input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    color: var(--color-ink);
    font-family: inherit;
    font-size: 12px;
  }
  .field.block input {
    font-size: 13px;
  }
  .field input::placeholder {
    color: var(--color-ink-faint);
  }
  .field input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }
</style>

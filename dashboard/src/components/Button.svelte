<script lang="ts">
  import type { Snippet } from "svelte";
  // Button system per §47: compact, professional, no oversized CTAs.
  let {
    variant = "secondary",
    children,
    onclick,
    disabled = false,
    type = "button",
    class: cls = "",
    title,
  }: {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    children: Snippet;
    onclick?: (e: MouseEvent) => void;
    disabled?: boolean;
    type?: "button" | "submit";
    class?: string;
    title?: string;
  } = $props();
</script>

<button {type} {disabled} {title} class="btn {variant} {cls}" onclick={onclick}>
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 11px;
    border-radius: var(--radius-ctl);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: background var(--dur-micro) var(--ease-out), border-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
    white-space: nowrap;
  }
  .primary {
    background: var(--color-pink);
    color: #0a0006;
    border: 1px solid var(--color-pink);
  }
  .primary:hover:not(:disabled) {
    background: var(--color-pink-soft);
    border-color: var(--color-pink-soft);
  }
  .secondary {
    background: var(--color-elevated);
    color: var(--color-ink);
    border: 1px solid var(--color-edge-strong);
  }
  .secondary:hover:not(:disabled) {
    border-color: #34344c;
    background: #16161f;
  }
  .ghost {
    background: transparent;
    color: var(--color-ink-muted);
    border: 1px solid transparent;
  }
  .ghost:hover:not(:disabled) {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .danger {
    background: transparent;
    color: var(--color-bad);
    border: 1px solid rgba(255, 77, 94, 0.35);
  }
  .danger:hover:not(:disabled) {
    background: rgba(255, 77, 94, 0.1);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>

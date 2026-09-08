<script lang="ts">
  import type { Snippet } from "svelte";
  // Tooltip (§46): hover/focus hint. Keyboard-accessible via tabindex.
  let {
    text,
    position = "top",
    children,
  }: {
    text: string;
    position?: "top" | "bottom";
    children: Snippet;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- focusable on purpose so keyboard users can read the hint -->
<span class="tip" class:below={position === "bottom"} tabindex="0" data-tip={text}>
  {@render children()}
</span>

<style>
  .tip {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .tip::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 7px);
    left: 50%;
    transform: translateX(-50%) translateY(2px);
    max-width: 240px;
    width: max-content;
    padding: 5px 9px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-ctl);
    color: var(--color-ink-soft);
    font-size: 11px;
    line-height: 1.4;
    white-space: normal;
    text-align: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
    z-index: 60;
  }
  .tip.below::after {
    bottom: auto;
    top: calc(100% + 7px);
    transform: translateX(-50%) translateY(-2px);
  }
  .tip:hover::after,
  .tip:focus-visible::after {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
</style>

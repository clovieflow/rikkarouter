<script lang="ts">
  import type { ToastItem } from "../lib/toast.ts";
  import { dismiss } from "../lib/toast.ts";
  // Toast (§48): one transient notice row. Rendered by ToastHost.
  let { item }: { item: ToastItem } = $props();
</script>

<div class="toast {item.kind}" role="status">
  <span class="msg">{item.msg}</span>
  <button class="x" aria-label="Dismiss notification" onclick={() => dismiss(item.id)}>×</button>
</div>

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 240px;
    max-width: 360px;
    padding: 9px 8px 9px 12px;
    background: var(--color-raised);
    border: 1px solid var(--color-edge-strong);
    border-left-width: 2px;
    border-radius: var(--radius-input);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    font-size: 12.5px;
    color: var(--color-ink-soft);
    animation: rise var(--dur-micro) var(--ease-out) both;
  }
  .toast.ok { border-left-color: var(--color-ok); }
  .toast.err { border-left-color: var(--color-bad); }
  .toast.info { border-left-color: var(--color-blue); }
  .msg {
    flex: 1;
    line-height: 1.45;
  }
  .x {
    background: none;
    border: none;
    color: var(--color-ink-faint);
    font-size: 15px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--radius-ctl);
    cursor: pointer;
  }
  .x:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.05);
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // Drawer (§47): right-side panel. Esc closes, scrim click closes.
  let {
    open,
    title,
    onClose,
    children,
  }: {
    open: boolean;
    title: string;
    onClose?: () => void;
    children: Snippet;
  } = $props();

  // A6: move focus into the drawer on open so keyboard users land inside it.
  let panel: HTMLElement | undefined = $state();
  $effect(() => {
    if (open) queueMicrotask(() => panel?.focus());
  });

  $effect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose?.();
    }}
  >
    <div class="dr" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" bind:this={panel}>
      <header class="dh">
        <h3>{title}</h3>
        <button class="x" aria-label="Close panel" onclick={() => onClose?.()}>
          <Icon name="x" size={13} />
        </button>
      </header>
      <div class="db">{@render children()}</div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(3, 3, 5, 0.6);
    z-index: 100;
    animation: fade 140ms var(--ease-out) both;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  .dr {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 92vw);
    background: var(--color-raised);
    border-left: 1px solid var(--color-edge-strong);
    display: flex;
    flex-direction: column;
    animation: slide var(--dur-panel) var(--ease-out) both;
  }
  @keyframes slide {
    from { transform: translateX(24px); opacity: 0; }
  }
  .dr:focus {
    outline: none;
  }
  .dh {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--color-edge);
  }
  .dh h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }
  .x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-ctl);
    color: var(--color-ink-muted);
    cursor: pointer;
  }
  .x:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .db {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px 16px;
  }
</style>

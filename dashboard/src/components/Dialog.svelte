<script lang="ts">
  import type { Snippet } from "svelte";
  // Dialog (§47): modal scrim + panel. Esc closes, scrim click closes,
  // panel click does not. Focus moves into the panel on open.
  let {
    open,
    label,
    onClose,
    children,
  }: {
    open: boolean;
    label: string;
    onClose?: () => void;
    children: Snippet;
  } = $props();

  let dlg: HTMLDivElement | undefined = $state(undefined);
  $effect(() => {
    if (open) queueMicrotask(() => dlg?.focus());
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
    <div
      bind:this={dlg}
      class="dlg"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      {@render children()}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(3, 3, 5, 0.72);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 16vh;
    z-index: 100;
    animation: fade 140ms var(--ease-out) both;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  .dlg {
    width: min(480px, 92vw);
    background: var(--color-raised);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-panel);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7);
    padding: 18px;
    animation: rise var(--dur-micro) var(--ease-out) both;
  }
  .dlg:focus {
    outline: none;
  }
</style>

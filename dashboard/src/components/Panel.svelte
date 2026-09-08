<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    sub = "",
    actions,
    children,
    pad = true,
    class: cls = "",
  }: {
    title?: string;
    sub?: string;
    actions?: Snippet;
    children: Snippet;
    pad?: boolean;
    class?: string;
  } = $props();
</script>

<section class="panel {cls}" role="group" aria-label={title ?? undefined}>
  {#if title}
    <header class="head">
      <div>
        <h3>{title}</h3>
        {#if sub}<p>{sub}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="body" class:unpad={!pad}>{@render children()}</div>
</section>

<style>
  .panel {
    background: var(--color-base);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-panel);
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    animation: rise var(--dur-panel) var(--ease-out) both;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 0;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }
  p {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--color-ink-faint);
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .body {
    padding: 14px 16px 16px;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-x: auto;
  }
  .body.unpad {
    padding: 0;
    overflow-x: auto;
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  // Badge (§49): status pill — dot + text label, never color alone.
  // Replaces inline .chip level/availability pills.
  export type BadgeTone = "ok" | "warn" | "bad" | "info" | "pink" | "muted";
  let {
    tone = "muted",
    label,
    dot = true,
    children,
  }: {
    tone?: BadgeTone;
    label?: string;
    dot?: boolean;
    children?: Snippet;
  } = $props();
</script>

<span class="badge {tone}">
  {#if dot}<i aria-hidden="true"></i>{/if}
  {#if children}{@render children()}{:else}{label}{/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--color-edge);
    background: rgba(255, 255, 255, 0.02);
    color: var(--color-ink-muted);
    white-space: nowrap;
  }
  .badge i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }
  .badge.ok {
    color: var(--color-ok);
    border-color: rgba(46, 230, 168, 0.3);
  }
  .badge.warn {
    color: var(--color-warn);
    border-color: rgba(255, 181, 70, 0.3);
  }
  .badge.bad {
    color: var(--color-bad);
    border-color: rgba(255, 77, 94, 0.35);
  }
  .badge.info {
    color: var(--color-blue-bright);
    border-color: rgba(23, 105, 255, 0.35);
  }
  .badge.pink {
    color: var(--color-pink-soft);
    border-color: rgba(255, 22, 140, 0.4);
  }
  .badge.muted {
    color: var(--color-ink-muted);
  }
</style>

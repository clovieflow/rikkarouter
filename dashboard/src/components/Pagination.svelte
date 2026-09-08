<script lang="ts">
  // Pagination (§46): 1-based page control. Parent owns filtering/sorting and
  // resets `page` to 1 when the result set changes; this clamps defensively.
  let {
    total,
    page = $bindable(1),
    perPage = 50,
    onchange,
  }: {
    total: number;
    page?: number;
    perPage?: number;
    onchange?: (p: number) => void;
  } = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / perPage)));
  const cur = $derived(Math.min(Math.max(1, page), pages));
  const from = $derived(total === 0 ? 0 : (cur - 1) * perPage + 1);
  const to = $derived(Math.min(total, cur * perPage));

  $effect(() => {
    if (page > pages) page = pages;
    if (page < 1) page = 1;
  });

  function go(p: number): void {
    page = Math.min(Math.max(1, p), pages);
    onchange?.(page);
  }
</script>

{#if total > 0}
  <div class="pg">
    <span class="range" aria-live="polite">showing {from}–{to} of {total}</span>
    {#if pages > 1}
      <nav class="nav" aria-label="Pagination">
        <button class="pbtn" disabled={cur <= 1} aria-label="Previous page" onclick={() => go(cur - 1)}>‹ Prev</button>
        <span class="cur" aria-current="page">{cur} / {pages}</span>
        <button class="pbtn" disabled={cur >= pages} aria-label="Next page" onclick={() => go(cur + 1)}>Next ›</button>
      </nav>
    {/if}
  </div>
{/if}

<style>
  .pg {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px 6px;
    flex-wrap: wrap;
  }
  .range {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-faint);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pbtn {
    height: 26px;
    padding: 0 10px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-ctl);
    color: var(--color-ink-soft);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: border-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
  }
  .pbtn:hover:not(:disabled) {
    color: var(--color-ink);
    border-color: #34344c;
  }
  .pbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .cur {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-muted);
    min-width: 48px;
    text-align: center;
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  // DataTable (§46): scroll wrapper + table + sticky sortable header.
  // Body rows stay in the caller (passed as a <tbody> children snippet) so
  // custom cells, expandable detail rows and empty states keep working.
  export interface DataColumn {
    key: string;
    label: string;
    align?: "left" | "right";
    sortable?: boolean;
  }
  let {
    columns,
    sortKey = null,
    sortDir = null,
    onSort,
    maxHeight = "min(64vh, 680px)",
    label,
    children,
  }: {
    columns: DataColumn[];
    sortKey?: string | null;
    sortDir?: "asc" | "desc" | null;
    onSort?: (key: string) => void;
    maxHeight?: string;
    label?: string;
    children: Snippet;
  } = $props();
</script>

<div class="scroll" style="max-height:{maxHeight}">
  <table class="tbl" aria-label={label}>
    <thead>
      <tr>
        {#each columns as c (c.key)}
          <th
            class:r={c.align === "right"}
            aria-sort={c.sortable ? (sortKey === c.key ? (sortDir === "asc" ? "ascending" : "descending") : "none") : undefined}
          >
            {#if c.sortable}
              <button
                class="th"
                class:act={sortKey === c.key}
                onclick={() => onSort?.(c.key)}
                aria-label="Sort by {c.label}"
              >
                {c.label}
                {#if sortKey === c.key}<span class="arrow">{sortDir === "asc" ? "↑" : "↓"}</span>{/if}
              </button>
            {:else}{c.label}{/if}
          </th>
        {/each}
      </tr>
    </thead>
    {@render children()}
  </table>
</div>

<style>
  .scroll {
    overflow-y: auto;
  }
  .tbl {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
  }
  .tbl th {
    position: sticky;
    top: 0;
    z-index: 2;
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-ink-faint);
    font-weight: 600;
    padding: 8px 16px;
    background: var(--color-base);
    border-bottom: 1px solid var(--color-edge);
  }
  .tbl th.r {
    text-align: right;
  }
  .th {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .th.act {
    color: var(--color-pink);
  }
  .arrow {
    font-size: 10px;
  }
  .tbl :global(td) {
    padding: 6.5px 16px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
    color: var(--color-ink-soft);
  }
</style>

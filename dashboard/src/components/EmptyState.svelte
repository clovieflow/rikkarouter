<script lang="ts">
  import type { Snippet } from "svelte";
  // Empty states per §38: title + why + next action, never "no data found".
  let {
    title,
    desc,
    action,
  }: { title: string; desc: string; action?: Snippet } = $props();
</script>

<div class="empty" role="status">
  <div class="ring" aria-hidden="true"></div>
  <h4>{title}</h4>
  <p>{desc}</p>
  {#if action}<div class="act">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 40px 16px;
    text-align: center;
  }
  .ring {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1.5px solid var(--color-edge-strong);
    border-top-color: var(--color-pink);
    margin-bottom: 10px;
    animation: spin 3.2s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-ink);
  }
  p {
    margin: 0;
    max-width: 380px;
    font-size: 12.5px;
    color: var(--color-ink-muted);
  }
  .act {
    margin-top: 14px;
  }
</style>

<script lang="ts">
  // JsonView (§48): pretty-printed JSON for inspectable payloads.
  // Data stays unaltered — stringify only, with a fallback for odd values.
  let { data, label = "JSON" }: { data: unknown; label?: string } = $props();

  const text = $derived.by(() => {
    try {
      const s = JSON.stringify(data, null, 2);
      return s ?? "—";
    } catch {
      return String(data);
    }
  });
</script>

<pre class="jv" aria-label={label}>{text}</pre>

<style>
  .jv {
    margin: 0;
    padding: 9px 12px;
    background: var(--color-void);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--color-ink-soft);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
</style>

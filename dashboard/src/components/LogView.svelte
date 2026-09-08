<script lang="ts">
  // LogView (§48): raw stored line block for request/log detail rows.
  let {
    line,
    label = "stored record",
  }: {
    line: string;
    label?: string;
  } = $props();
</script>

<span class="dlabel">{label}</span>
<div class="raw">{line}</div>

<style>
  .dlabel {
    display: block;
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-ink-faint);
    margin: 4px 0 6px;
  }
  .raw {
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--color-ink-soft);
    background: var(--color-void);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    padding: 9px 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>

<script lang="ts">
  import Icon from "./Icon.svelte";
  // CodeBlock (§48): monospace block with language tag + copy button.
  let {
    code,
    lang = "text",
    label,
  }: {
    code: string;
    lang?: string;
    label?: string;
  } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="cb">
  <div class="cb-h">
    <span class="lang">{label ?? lang}</span>
    <button class="cp" onclick={() => void copy()} aria-label="Copy code block">
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  </div>
  <pre class="pre"><code>{code}</code></pre>
</div>

<style>
  .cb {
    background: var(--color-void);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    overflow: hidden;
  }
  .cb-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 6px 5px 12px;
    border-bottom: 1px solid var(--color-edge);
  }
  .lang {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-ink-faint);
  }
  .cp {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-ctl);
    color: var(--color-ink-muted);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .cp:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .pre {
    margin: 0;
    padding: 9px 12px;
    overflow-x: auto;
  }
  .pre code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--color-ink-soft);
    white-space: pre;
  }
</style>

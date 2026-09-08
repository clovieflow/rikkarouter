<script lang="ts">
  // Status per §49: dot + text label, never color alone.
  const TONE: Record<string, string> = {
    ok: "var(--color-ok)",
    warn: "var(--color-warn)",
    bad: "var(--color-bad)",
    active: "var(--color-pink)",
    muted: "var(--color-ink-faint)",
  };
  let {
    tone = "ok",
    label,
    pulse = false,
  }: { tone?: keyof typeof TONE; label: string; pulse?: boolean } = $props();
</script>

<span class="pill">
  <span class="dot" class:pulse style={`background:${TONE[tone] ?? TONE.muted}; color:${TONE[tone] ?? TONE.muted}`}></span>
  <span class="txt">{label}</span>
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    padding: 2px 8px 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--color-edge);
    background: rgba(255, 255, 255, 0.02);
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .dot.pulse {
    animation: pulse-dot 2s var(--ease-out) infinite;
  }
  .txt {
    color: var(--color-ink-soft);
  }
</style>

<script lang="ts">
  import { untrack } from "svelte";
  import { tweenNumber } from "./live-anim.ts";
  import { sparkPath } from "../lib/spark.ts";

  let {
    value,
    label,
    trend = null,
    trendGood = "down",
    spark = [],
    cue = null,
    cueTone = null,
    /** live numeric source: when set with `format`, the value count-ups toward it on real data deltas */
    raw = null,
    format = null,
    /** increment to blink the cue once (e.g. parent bumps it when avg cost rises) */
    ping = 0,
  }: {
    value: string;
    label: string;
    trend?: string | null;
    /** whether a decreasing trend is good (latency: yes, cost: yes, requests: no) */
    trendGood?: "up" | "down";
    spark?: number[];
    cue?: string | null;
    /** status cue dot: ok | warn | bad — always paired with the text cue, never color alone */
    cueTone?: "ok" | "warn" | "bad" | null;
    raw?: number | null;
    format?: ((n: number) => string) | null;
    ping?: number;
  } = $props();

  // ── count-up (400–600ms rAF, tabular-nums via .val): tweens toward each new
  // polled value; jumps instantly under reduced motion. First paint is exact.
  let shown = $state<number | null>(null);
  let primed = false;
  $effect(() => {
    const target = raw;
    if (target == null || !Number.isFinite(target) || format == null) {
      shown = target;
      primed = true;
      return;
    }
    if (!primed) {
      primed = true;
      shown = target;
      return;
    }
    const from = untrack(() => shown) ?? target;
    return tweenNumber(from, target, (v) => (shown = v), 500);
  });
  const text = $derived(raw == null || format == null || shown == null ? value : format(shown));

  // ── spend-pulse: a single 300ms cue blink when the parent reports a rise ──
  let pinging = $state(false);
  $effect(() => {
    if (ping > 0) {
      pinging = true;
      const t = setTimeout(() => (pinging = false), 320);
      return () => clearTimeout(t);
    }
  });

  const W = 96;
  const H = 26;
  const path = $derived(sparkPath(spark, W, H));

  let trendTone = $derived(
    !trend ? "flat" : trend.startsWith("-") ? (trendGood === "down" ? "good" : "bad") : trend.startsWith("+") ? (trendGood === "up" ? "good" : "bad") : "flat",
  );
</script>

<div class="kpi" data-testid="kpi-{label.toLowerCase().replace(/\W+/g, '-')}">
  <div class="row">
    <span class="label">{label}</span>
    {#if trend}<span class="trend {trendTone}">{trend}</span>{/if}
  </div>
  <div class="val">{text}</div>
  <div class="foot">
    {#if cue}<span class="cue" class:ping={pinging}>{#if cueTone}<i class="cdot {cueTone}"></i>{/if}{cue}</span>{/if}
    {#if path}
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
        <path {path} fill="none" stroke="#1769ff" stroke-width="1.4" opacity="0.8" />
      </svg>
    {/if}
  </div>
</div>

<style>
  .kpi {
    background: var(--color-base);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-card);
    padding: 12px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    animation: rise var(--dur-panel) var(--ease-out) both;
    min-width: 0;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-ink-muted);
  }
  .val {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .trend {
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .trend.good {
    color: var(--color-ok);
  }
  .trend.bad {
    color: var(--color-bad);
  }
  .trend.flat {
    color: var(--color-ink-faint);
  }
  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    min-height: 18px;
  }
  .cue {
    font-size: 11px;
    color: var(--color-ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cue.ping {
    animation: cue-blink var(--dur-panel) var(--ease-out) 1;
  }
  @keyframes cue-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .cdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 5px;
    vertical-align: 1px;
  }
  .cdot.ok { background: var(--color-ok); }
  .cdot.warn { background: var(--color-warn); }
  .cdot.bad { background: var(--color-bad); }
  svg {
    width: 72px;
    height: 18px;
    flex-shrink: 0;
  }
</style>

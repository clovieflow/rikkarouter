<script lang="ts">
  // Minimal precise line/area chart (§14, §45): one primary line, subtle grid,
  // premium tooltip. Pink = current series, blue = secondary.
  import { untrack } from "svelte";
  import { timeShort } from "../lib/format.ts";
  import { isReducedMotion } from "./live-anim.ts";

  export interface Series {
    name: string;
    color?: string;
    values: number[];
    /** per-series value formatter; falls back to the chart-level fmt */
    fmt?: (n: number) => string;
    /** hidden series are skipped when drawing but still listed in the tooltip */
    hidden?: boolean;
  }

  let {
    series,
    labels,
    height = 180,
    fmt = (n: number) => n.toLocaleString("en-US"),
    label = "Requests and latency trend chart",
  }: { series: Series[]; labels: number[]; height?: number; fmt?: (n: number) => string; label?: string } = $props();

  const W = 640;
  const PAD = { l: 38, r: 8, t: 10, b: 20 };

  let hover = $state<number | null>(null);

  const max = $derived(Math.max(1, ...series.flatMap((s) => s.values)));
  const n = $derived(labels.length);

  // ── dataset crossfade (300ms opacity only — the path itself never morphs):
  // each newly polled dataset remounts via {#key sig} and fades in while the
  // previous dataset's paths linger as a fading ghost, then unmount.
  interface Rec {
    name: string;
    line: string;
    area: string;
    stroke: string;
    areaFill: string;
    showArea: boolean;
  }
  const sig = $derived(JSON.stringify(series.map((s) => [s.name, s.hidden ? 0 : 1, s.values])));
  function strokeOf(s: Series, i: number): string {
    return s.color ?? (i === 0 ? "var(--color-pink)" : "var(--color-blue-bright)");
  }
  function recsOf(list: Series[]): Rec[] {
    return list.flatMap((s, i) =>
      s.hidden
        ? []
        : [
            {
              name: s.name,
              line: lineOf(s.values),
              area: areaOf(s.values),
              stroke: strokeOf(s, i),
              areaFill: s.color ?? "var(--color-pink)",
              showArea: i === 0,
            },
          ],
    );
  }
  let ghosts = $state<{ key: number; recs: Rec[] }[]>([]);
  let gkey = 0;
  let lastSig = "";
  let lastRecs: Rec[] = [];
  let xStarted = false;
  $effect(() => {
    const cur = recsOf(series);
    const s = sig;
    if (!xStarted) {
      xStarted = true;
      lastSig = s;
      lastRecs = cur;
      return;
    }
    if (s === lastSig) {
      lastRecs = cur;
      return;
    }
    const old = lastRecs;
    lastSig = s;
    lastRecs = cur;
    if (isReducedMotion()) return;
    gkey += 1;
    const k = gkey;
    ghosts = [...untrack(() => ghosts).slice(-1), { key: k, recs: old }];
    setTimeout(() => {
      ghosts = ghosts.filter((g) => g.key !== k);
    }, 340);
  });

  function x(i: number): number {
    return PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  }
  function y(v: number): number {
    return height - PAD.b - (v / max) * (height - PAD.t - PAD.b);
  }
  function lineOf(values: number[]): string {
    return values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  }
  function areaOf(values: number[]): string {
    if (!values.length) return "";
    return `${lineOf(values)} L ${x(values.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  }
  const gridYs = $derived([0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: y(max * f) })));

  function onMove(e: MouseEvent & { currentTarget: SVGElement }) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    hover = i >= 0 && i < n ? i : null;
  }
</script>

<div class="chart">
  <svg role="img" aria-label={label} viewBox="0 0 {W} {height}" preserveAspectRatio="none" style="height:{height}px" onmousemove={onMove} onmouseleave={() => (hover = null)}>
    {#each gridYs as g}
      <line x1={PAD.l} x2={W - PAD.r} y1={g.y} y2={g.y} class="grid" />
      <text x={PAD.l - 6} y={g.y + 3} class="axis" text-anchor="end">{fmt(g.v)}</text>
    {/each}
    <text x={PAD.l - 6} y={height - PAD.b + 3} class="axis" text-anchor="end">0</text>
    {#each [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1] as i (i)}
      {#if labels[i] != null}
        <text x={x(i)} y={height - 5} class="axis" text-anchor="middle">{timeShort(labels[i]!)}</text>
      {/if}
    {/each}
    {#each ghosts as g (g.key)}
      {#each g.recs as r (r.name)}
        {#if r.showArea}<path d={r.area} fill={r.areaFill} stroke="none" class="area ghost" />{/if}
        <path d={r.line} fill="none" stroke={r.stroke} stroke-width="1.6" class="line ghost" />
      {/each}
    {/each}
    {#key sig}
      {#each series as s, si (s.name)}
        {#if !s.hidden}
          {#if si === 0}
            <path d={areaOf(s.values)} fill={s.color ?? "var(--color-pink)"} stroke="none" class="area fresh" />
          {/if}
          <path d={lineOf(s.values)} fill="none" stroke={s.color ?? (si === 0 ? "var(--color-pink)" : "var(--color-blue-bright)")} stroke-width="1.6" class="line fresh" />
        {/if}
      {/each}
    {/key}

    {#if hover != null && series[0]}
      <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height - PAD.b} class="cross" />
      {#each series as s, si (s.name)}
        {#if !s.hidden}
          <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="3" fill={s.color ?? (si === 0 ? "#ff168c" : "#3c8cff")} stroke="#050507" stroke-width="1.5" />
        {/if}
      {/each}
    {/if}
  </svg>

  {#if hover != null && labels[hover] != null}
    <div class="tip" style="left: calc({(x(hover) / W) * 100}%)">
      <div class="t-time">{timeShort(labels[hover]!)}</div>
      {#each series as s, si (s.name)}
        <div class="t-row"><i style="background:{s.color ?? (si === 0 ? '#ff168c' : '#3c8cff')}"></i>{s.name}<b>{(s.fmt ?? fmt)(s.values[hover] ?? 0)}</b></div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chart {
    position: relative;
  }
  svg {
    display: block;
    width: 100%;
  }
  .grid {
    stroke: #131320;
    stroke-width: 1;
  }
  .axis {
    fill: #5c5c6b;
    font-size: 9.5px;
    font-family: var(--font-mono);
  }
  .line {
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .area {
    opacity: 0.07;
  }
  /* dataset crossfade: opacity only, 300ms (§42 panel) — never a path morph */
  .line.fresh { animation: xf-in var(--dur-panel) var(--ease-out) 1; }
  .area.fresh { animation: xf-in-area var(--dur-panel) var(--ease-out) 1; opacity: 0.07; }
  .line.ghost { animation: xf-out var(--dur-panel) var(--ease-out) 1; opacity: 0; }
  .area.ghost { animation: xf-out-area var(--dur-panel) var(--ease-out) 1; opacity: 0; }
  @keyframes xf-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes xf-in-area { from { opacity: 0; } to { opacity: 0.07; } }
  @keyframes xf-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes xf-out-area { from { opacity: 0.07; } to { opacity: 0; } }
  .cross {
    stroke: #262638;
    stroke-dasharray: 2 3;
  }
  .tip {
    position: absolute;
    top: 6px;
    transform: translateX(-50%);
    background: #111119;
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-ctl);
    padding: 7px 10px;
    pointer-events: none;
    min-width: 120px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  }
  .t-time {
    font-size: 10px;
    color: var(--color-ink-faint);
    font-family: var(--font-mono);
    margin-bottom: 4px;
  }
  .t-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-ink-soft);
    white-space: nowrap;
  }
  .t-row b {
    margin-left: auto;
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .t-row i {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    display: inline-block;
  }
</style>

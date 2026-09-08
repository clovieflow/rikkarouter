<script lang="ts">
  // ── LIVE REQUEST FLOW — the product's signature visual (spec §11-§12) ──
  // request enters → router evaluates → provider selected.
  // Blue = network/secondary, pink = active route; amber degraded, red failed;
  // failover visibly repaints the path from primary to fallback.
  import { onMount } from "svelte";
  import { beatOf } from "./live-anim.ts";
  import type { FlowProvider, RouterState, FailoverEvent } from "./flow-types.ts";

  let {
    providers = [],
    rps = 0,
    failover = null,
    flow = "normal",
  }: {
    providers: FlowProvider[];
    rps?: number;
    failover?: FailoverEvent | { from: string; to: string } | null;
    flow?: RouterState;
  } = $props();

  const W = 760;
  const H = 430;
  const CX = W / 2;
  const CY = H / 2 + 8;
  const INGRESS = { x: 46, y: CY };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let nodes = $derived(positions(providers));

  // ── core-beat: ring scale/opacity follow the real request rate via --beat ──
  const beat = $derived(beatOf(rps));

  // ── node-hit flash: the single provider whose traffic weight rose most since
  // the last poll gets one 500ms pink stroke fade (max 1 per refresh) ──
  let hitId = $state<string | null>(null);
  let hitPrimed = false;
  const prevW = new Map<string, number>();
  $effect(() => {
    const snap = providers.map((p) => [p.id, p.weight ?? 0] as const);
    if (!hitPrimed) {
      hitPrimed = true;
      for (const [id, w] of snap) prevW.set(id, w);
      return;
    }
    let best: string | null = null;
    let bestD = 0;
    for (const [id, w] of snap) {
      const d = w - (prevW.get(id) ?? 0);
      if (d > bestD) {
        bestD = d;
        best = id;
      }
    }
    for (const [id, w] of snap) prevW.set(id, w);
    if (best != null) {
      hitId = best;
      const t = setTimeout(() => (hitId = null), 520);
      return () => clearTimeout(t);
    }
  });
  function positionFor(p: FlowProvider, i: number, arr: FlowProvider[]) {
    const n = Math.max(arr.length, 1);
    const spread = Math.min(Math.PI * 1.15, 0.42 * n + 0.9);
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = -spread / 2 + spread * t;
    const r = 178 + (i % 2 === 0 ? 26 : 0);
    return { x: CX + 118 + Math.cos(a) * r, y: CY + Math.sin(a) * r * 0.98 };
  }
  function positions(arr: FlowProvider[]) {
    return arr.map((p, i) => ({ ...p, ...positionFor(p, i, arr) }));
  }

  function qPoint(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) {
    const u = 1 - t;
    return {
      x: u * u * x0 + 2 * u * t * cx + t * t * x1,
      y: u * u * y0 + 2 * u * t * cy + t * t * y1,
    };
  }
  function ctrlOf(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: (a.x + b.x) / 2 + (b.y - a.y) * 0.18, y: (a.y + b.y) / 2 + (a.x - b.x) * 0.18 };
  }

  interface Particle {
    seg: "out" | "in";
    node: number;
    t: number;
    speed: number;
  }
  interface Rendered {
    x: number;
    y: number;
    seg: "out" | "in";
    color: string;
  }

  let particles: Particle[] = [];
  let dots = $state<Rendered[]>([]);
  let phase = $state(0);

  function pickTarget(): number {
    const live = nodes.filter((n) => n.status === "healthy");
    if (!live.length) return -1;
    const total = live.reduce((s, n) => s + n.weight + 0.05, 0);
    let r = Math.random() * total;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.status !== "healthy") continue;
      r -= n.weight + 0.05;
      if (r <= 0) return i;
    }
    return nodes.indexOf(live[0]!);
  }

  onMount(() => {
    if (reduced) return;
    let raf = 0;
    let last = performance.now();
    let spawnAcc = 0;
    const tick = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      phase = (phase + dt / 26) % 360;

      const rate = 0.0009 + Math.min(0.004, (rps || 0) * 0.00035);
      spawnAcc += (dt * rate) / 1.6;
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        const target = pickTarget();
        if (target >= 0) {
          particles.push({ seg: "in", node: target, t: 0, speed: 0.0011 + Math.random() * 0.0007 });
          particles.push({ seg: "out", node: target, t: -0.16 - Math.random() * 0.1, speed: 0.0012 + Math.random() * 0.0007 });
        }
      }
      const next: Rendered[] = [];
      particles = particles.filter((p) => {
        p.t += p.speed * dt;
        if (p.t < 0) return true;
        if (p.t > 1) return false;
        const n = nodes[p.node];
        if (!n) return false;
        if (p.seg === "in") {
          const c = ctrlOf(INGRESS, { x: CX, y: CY });
          const pt = qPoint(INGRESS.x + 8, INGRESS.y, c.x, c.y, CX - 34, CY, p.t);
          const mix = Math.max(0, (p.t - 0.55) / 0.45);
          next.push({ ...pt, seg: "in", color: mix > 0.5 ? "#ff168c" : "#3c8cff" });
        } else {
          const c = ctrlOf({ x: CX, y: CY }, n);
          const pt = qPoint(CX - 34, CY, c.x, c.y, n.x - 40, n.y, p.t);
          const dead = n.status === "failed" && p.t > 0.4;
          next.push({ ...pt, seg: "out", color: dead ? "#ff4d5e" : n.status === "cooldown" ? "#ffb546" : "#ff168c" });
        }
        return true;
      });
      dots = next;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="flow-head">
  <span class="core-state {flow}"><i></i>{flow === "high-traffic" ? "high traffic" : flow}{rps > 0 ? ` · ${rps} req/min` : ""}</span>
  {#if failover}
    <span class="fo-flag" title={(failover as FailoverEvent).reason ?? ""}>failover: {(failover as FailoverEvent).fromName ?? (failover as { from: string }).from} → {(failover as FailoverEvent).toName ?? (failover as { to: string }).to}</span>
  {/if}
</div>
<div class="flow" class:beating={rps > 0} style="--beat: {beat}" role="img" aria-label="Live request flow: {nodes.filter((n) => n.status === 'healthy').length} of {nodes.length} providers healthy">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ff168c" stop-opacity="0.22" />
        <stop offset="45%" stop-color="#1769ff" stop-opacity="0.10" />
        <stop offset="100%" stop-color="#050507" stop-opacity="0" />
      </radialGradient>
      <linearGradient id="route-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#050507" />
        <stop offset="35%" stop-color="#071a55" />
        <stop offset="70%" stop-color="#1769ff" />
        <stop offset="100%" stop-color="#ff168c" />
      </linearGradient>
    </defs>

    <circle cx={CX} cy={CY} r="150" fill="url(#core-glow)" />
    <g class="orbits">
      <circle cx={CX} cy={CY} r="66" />
      <circle cx={CX} cy={CY} r="98" class="o2" />
    </g>

    <!-- ingress trunk: the signature gradient, used exactly once per screen (§04) -->
    <path class="trunk" d="M 26 {CY} L {CX - 92} {CY}" stroke="url(#route-grad)" stroke-width="1.5" fill="none" />
    <text class="lbl" x="30" y={CY - 14}>REQUESTS</text>
    <text class="lbl dim" x="30" y={CY + 24}>/v1 · /messages</text>

    {#each nodes as n (n.id)}
      {@const cOut = ctrlOf({ x: CX, y: CY }, n)}
      <path
        class="wire"
        class:hot={rps > 0 && n.status === "healthy" && n.weight > 0.4}
        class:bad={n.status === "failed"}
        class:warn={n.status === "cooldown"}
        d="M {CX + 34} {CY} Q {cOut.x} {cOut.y} {n.x - 40} {n.y}"
        fill="none"
      />
      {#if failover?.from === n.id}
        <path class="wire drop" d="M {CX + 34} {CY} Q {cOut.x} {cOut.y} {n.x - 40} {n.y}" fill="none" />
      {/if}
    {/each}

    {#each dots as d}
      <circle class="dot {d.seg}" cx={d.x} cy={d.y} r={d.seg === "out" ? 2.2 : 1.8} fill={d.color} />
    {/each}

    <g class="core" transform="translate({CX} {CY})">
      <circle r="30" class="core-ring" />
      <circle r="30" class="core-dash" style="stroke-dasharray: 6 10; stroke-dashoffset: {phase}" />
      <circle r="14" class="core-pulse" />
      <circle r="14" class="core-pulse slow" />
      <circle r="4" fill="#ff168c" />
      <text class="core-label" y="54" text-anchor="middle">ROUTER CORE</text>
    </g>

    {#each nodes as n (n.id)}
      <g class="node" class:failed={n.status === "failed"} class:cold={n.status === "cooldown"} class:hot={n.weight > 0.4} class:hit={hitId === n.id} transform="translate({n.x - 40} {n.y - 16})">
        <rect width="128" height="32" rx="8" />
        <circle class="led" cx="14" cy="16" r="3.5" />
        <text x="26" y="14" class="nm">{n.name}</text>
        <text x="26" y="26" class="mt">{n.latency != null ? `${Math.round(n.latency)}ms` : n.status === "idle" ? "no traffic" : "—"}</text>
        {#if failover?.to === n.id}<rect class="failover-in" width="128" height="32" rx="8" />{/if}
      </g>
    {/each}
  </svg>

  <div class="states" aria-hidden="true">
    <span><i class="sw b"></i>network</span>
    <span><i class="sw p"></i>active route</span>
    <span><i class="sw a"></i>degraded</span>
    <span><i class="sw r"></i>failed</span>
  </div>
  {#if failover && (failover as FailoverEvent).fromName}
    {@const fo = failover as FailoverEvent}
    <div class="fo-strip" role="note" aria-label="Failover: {fo.fromName} to {fo.toName}">
      <span class="fo-node bad">{fo.fromName}</span>
      <span class="fo-track" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="fo-node ok">{fo.toName}</span>
      <span class="fo-meta">{fo.atLabel}{fo.reason ? ` · ${fo.reason}` : ""}</span>
    </div>
  {/if}
</div>

<style>
  .flow {
    --beat: 0;
    position: relative;
    width: 100%;
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .flow-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .core-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 10px;
    border: 1px solid var(--color-edge-strong);
    border-radius: 999px;
    color: var(--color-ink-muted);
    background: rgba(255, 255, 255, 0.015);
  }
  .core-state i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-ink-faint);
  }
  .core-state.normal i { background: var(--color-ink-faint); }
  .core-state.active { color: var(--color-ok); border-color: rgba(46, 230, 168, 0.35); }
  .core-state.active i { background: var(--color-ok); }
  .core-state.high-traffic { color: var(--color-pink-soft); border-color: rgba(255, 22, 140, 0.35); }
  .core-state.high-traffic i { background: var(--color-pink); }
  .core-state.degraded { color: var(--color-warn); border-color: rgba(255, 181, 70, 0.35); }
  .core-state.degraded i { background: var(--color-warn); }
  .core-state.failure { color: var(--color-bad); border-color: rgba(255, 77, 94, 0.4); }
  .core-state.failure i { background: var(--color-bad); }
  .fo-flag {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--color-warn);
  }
  .fo-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 4px 2px;
    padding: 8px 12px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-ctl);
    background: rgba(255, 255, 255, 0.015);
    font-size: 11.5px;
  }
  .fo-node {
    font-weight: 600;
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: nowrap;
  }
  .fo-node.bad { color: var(--color-bad); }
  .fo-node.ok { color: var(--color-ok); }
  .fo-track {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 40px;
  }
  .fo-track i {
    height: 1.5px;
    background: var(--color-blue);
    border-radius: 1px;
    animation: fo-slide var(--dur-major) var(--ease-out) infinite;
  }
  .fo-track i:nth-child(1) { flex: 2; opacity: 0.35; }
  .fo-track i:nth-child(2) { flex: 3; opacity: 0.6; animation-delay: 120ms; }
  .fo-track i:nth-child(3) { flex: 2; background: var(--color-pink); opacity: 0.85; animation-delay: 240ms; }
  @keyframes fo-slide {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 0.9; }
  }
  .fo-meta {
    margin-left: auto;
    color: var(--color-ink-faint);
    font-size: 10.5px;
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  .orbits circle {
    fill: none;
    stroke: #14213d;
    stroke-width: 1;
  }
  .orbits .o2 {
    stroke-dasharray: 2 7;
  }
  .trunk {
    opacity: 0.85;
  }
  .lbl {
    fill: #777786;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.14em;
  }
  .lbl.dim {
    fill: #4b4b57;
    letter-spacing: 0.06em;
  }
  .wire {
    stroke: #16304f;
    stroke-width: 1.1;
    transition: stroke var(--dur-panel) var(--ease-out);
  }
  .wire.hot {
    stroke: #1f3f77;
  }
  .wire.warn {
    stroke: rgba(255, 181, 70, 0.5);
  }
  .wire.bad,
  .wire.drop {
    stroke: rgba(255, 77, 94, 0.55);
    stroke-dasharray: 3 5;
  }
  .dot {
    opacity: 0.9;
  }
  .dot.out {
    filter: drop-shadow(var(--glow-pink));
  }
  .dot.in {
    filter: drop-shadow(var(--glow-blue));
  }
  .core-ring {
    fill: #0a0a12;
    stroke: #262638;
    stroke-width: 1.5;
    filter: drop-shadow(0 0 14px rgba(255, 22, 140, 0.18));
    transform-box: fill-box;
    transform-origin: center;
    transition:
      transform var(--dur-panel) var(--ease-out),
      opacity var(--dur-panel) var(--ease-out);
  }
  /* live beat: scale + opacity track the real request rate via --beat */
  .beating .core-ring {
    transform: scale(calc(1 + var(--beat) * 0.22));
    opacity: calc(0.72 + var(--beat) * 0.28);
  }
  .core-dash {
    fill: none;
    stroke: #1769ff;
    stroke-width: 1.2;
    opacity: 0.65;
  }
  .core-pulse {
    fill: none;
    stroke: rgba(255, 22, 140, 0.35);
    animation: core-pulse 2.6s var(--ease-out) infinite;
  }
  /* the idle pulse rests while live traffic drives the beat instead */
  .beating .core-pulse {
    animation: none;
    opacity: 0;
  }
  .core-pulse.slow {
    animation-delay: 1.3s;
  }
  @keyframes core-pulse {
    0% {
      r: 10px;
      opacity: 0.7;
    }
    100% {
      r: 44px;
      opacity: 0;
    }
  }
  .core-label {
    fill: #b8b8c5;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.16em;
  }
  .node rect {
    fill: #0d0d13;
    stroke: #1f1f2e;
    stroke-width: 1;
    transition: stroke var(--dur-panel) var(--ease-out);
  }
  .node.hot rect {
    stroke: #2c2c44;
  }
  /* node-hit: one 500ms pink stroke fade for the risen provider per refresh */
  .node.hit rect {
    stroke: var(--color-pink);
    stroke-width: 1.6;
    animation: hit-fade var(--dur-major) var(--ease-out) 1;
  }
  @keyframes hit-fade {
    0% { stroke-opacity: 1; }
    100% { stroke-opacity: 0.25; }
  }
  .node .led {
    fill: var(--color-ok);
  }
  .node.cold .led {
    fill: var(--color-warn);
  }
  .node.failed .led {
    fill: var(--color-bad);
  }
  .node.failed rect {
    stroke: rgba(255, 77, 94, 0.4);
  }
  .node .nm {
    fill: #e8e8ee;
    font-size: 11px;
    font-weight: 600;
  }
  .node .mt {
    fill: #6e6e7f;
    font-size: 9px;
    letter-spacing: 0.03em;
    font-family: var(--font-mono);
  }
  .failover-in {
    fill: none;
    stroke: var(--color-pink);
    stroke-width: 1.4;
    filter: drop-shadow(var(--glow-pink));
    animation: fo 1.6s var(--ease-out) 3;
  }
  @keyframes fo {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
  .states {
    position: absolute;
    left: 8px;
    bottom: 2px;
    display: flex;
    gap: 14px;
    font-size: 10.5px;
    color: var(--color-ink-faint);
  }
  .states span {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }
  .sw {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    display: inline-block;
  }
  .sw.b {
    background: #3c8cff;
  }
  .sw.p {
    background: #ff168c;
  }
  .sw.a {
    background: #ffb546;
  }
  .sw.r {
    background: #ff4d5e;
  }
</style>

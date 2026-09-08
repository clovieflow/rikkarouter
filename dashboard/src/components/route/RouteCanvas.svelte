<script lang="ts">
  // RouteCanvas (§18, signature #2): the route as vertical node infra —
  // INCOMING → POLICY → DECISION → PRIMARY → FALLBACK → RESPONSE.
  // Monochrome tokens only, no flowchart colors. Click a node to edit it;
  // the parent renders the matching editor. Presentational: all writes happen
  // in RouteDetail via /api/combos.
  import { strategyDef, isGatewayStrategy, primaryOf, fallbacksOf, stepLabel, type Step } from "./route-data.ts";

  export type CanvasNode = "incoming" | "policy" | "decision" | "primary" | "fallback" | "response";

  let {
    comboName,
    strategy,
    steps,
    selected = null,
    onselect,
  }: {
    comboName: string;
    strategy: string;
    steps: Step[];
    selected?: CanvasNode | null;
    onselect?: (n: CanvasNode) => void;
  } = $props();

  const strat = $derived(strategyDef(strategy));
  const primary = $derived(primaryOf(steps));
  const fallbacks = $derived(fallbacksOf(steps));
  const gw = $derived(isGatewayStrategy(strategy));

  function pick(n: CanvasNode): void {
    onselect?.(n);
  }
  function key(n: CanvasNode, e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(n);
    }
  }
</script>

<div class="canvas" role="group" aria-label="Route canvas">
  <!-- INCOMING -->
  <div class="node" class:sel={selected === "incoming"} role="button" tabindex="0" aria-pressed={selected === "incoming"} onclick={() => pick("incoming")} onkeydown={(e) => key("incoming", e)}>
    <span class="k">Incoming</span>
    <span class="v mono">{comboName || "—"}</span>
    <span class="h">request enters as model “{comboName || "…"}”</span>
  </div>
  <div class="wire" aria-hidden="true"></div>

  <!-- POLICY -->
  <div class="node" class:sel={selected === "policy"} role="button" tabindex="0" aria-pressed={selected === "policy"} onclick={() => pick("policy")} onkeydown={(e) => key("policy", e)}>
    <span class="k">Policy <em class={gw ? "gw" : "adv"}>{gw ? "gateway" : "advisory"}</em></span>
    <span class="v">{strat.name}</span>
    <span class="h">{gw ? "executed by the gateway" : "stored as preference; gateway runs priority order"}</span>
  </div>
  <div class="wire" aria-hidden="true"></div>

  <!-- DECISION -->
  <div class="node" class:sel={selected === "decision"} role="button" tabindex="0" aria-pressed={selected === "decision"} onclick={() => pick("decision")} onkeydown={(e) => key("decision", e)}>
    <span class="k">Decision</span>
    <span class="v">{strategy === "weighted" ? "weight-desc, then priority" : "step order, pre-first-byte"}</span>
    <span class="h">{steps.length} candidate{steps.length === 1 ? "" : "s"} · skip steps with no usable connection</span>
  </div>
  <div class="wire" aria-hidden="true"></div>

  <!-- PRIMARY -->
  <div class="node" class:sel={selected === "primary"} role="button" tabindex="0" aria-pressed={selected === "primary"} onclick={() => pick("primary")} onkeydown={(e) => key("primary", e)}>
    <span class="k">Primary</span>
    <span class="v mono">{primary ? stepLabel(primary) : "— none —"}</span>
    <span class="h">tried first on every request</span>
  </div>
  <div class="wire" aria-hidden="true"></div>

  <!-- FALLBACK -->
  <div class="node" class:sel={selected === "fallback"} role="button" tabindex="0" aria-pressed={selected === "fallback"} onclick={() => pick("fallback")} onkeydown={(e) => key("fallback", e)}>
    <span class="k">Fallback <em class="count">{fallbacks.length}</em></span>
    {#if fallbacks.length}
      <span class="v mono">{fallbacks.map(stepLabel).join(" → ")}</span>
    {:else}
      <span class="v dim">— no fallback: single point of failure —</span>
    {/if}
    <span class="h">tried in order when the previous step fails</span>
  </div>
  <div class="wire" aria-hidden="true"></div>

  <!-- RESPONSE -->
  <div class="node" class:sel={selected === "response"} role="button" tabindex="0" aria-pressed={selected === "response"} onclick={() => pick("response")} onkeydown={(e) => key("response", e)}>
    <span class="k">Response</span>
    <span class="v">first success wins</span>
    <span class="h">usage recorded with latency, tokens, cost</span>
  </div>
</div>

<style>
  .canvas {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    max-width: 560px;
  }
  .node {
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    cursor: pointer;
    outline: 0;
  }
  .node:hover { border-color: #34344c; }
  .node:focus-visible { border-color: var(--color-blue); }
  .node.sel { border-color: var(--color-blue); background: rgba(23, 105, 255, 0.07); }
  .k {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .k em {
    font-style: normal;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.05em;
    padding: 0 7px;
    border-radius: 999px;
    border: 1px solid var(--color-edge-strong);
  }
  .k em.gw { color: var(--color-ok); border-color: rgba(46, 230, 168, 0.35); }
  .k em.adv { color: var(--color-warn); border-color: rgba(255, 181, 70, 0.35); }
  .k .count {
    color: var(--color-ink-soft);
  }
  .v { font-size: 13px; font-weight: 600; color: var(--color-ink); overflow-wrap: anywhere; }
  .v.dim { font-weight: 400; color: var(--color-warn); }
  .mono { font-family: var(--font-mono); font-size: 12px; font-weight: 500; }
  .h { font-size: 11.5px; color: var(--color-ink-faint); }
  .wire {
    width: 1px;
    height: 14px;
    background: var(--color-edge-strong);
    margin-left: 28px;
  }
</style>

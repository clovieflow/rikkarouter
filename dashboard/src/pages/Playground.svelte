<script lang="ts">
  // Playground (§21): send a REAL request through /v1 and show what came
  // back. There is no dry-run endpoint, so there is no fake confidence and
  // no server-side step trace — the trace below is reconstructed client-side
  // from the request we sent, the combo policy, and the response + request
  // log row we observed.
  import Icon from "../components/Icon.svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import { onMount } from "svelte";
  import StatusPill from "../components/StatusPill.svelte";
  import Timeline, { type TLItem } from "../components/Timeline.svelte";
  import { parseSteps, strategyDef, type Step } from "../components/route/route-data.ts";
  import { api, listCombos, getPricing, type Combo, type RegistryProvider, type PricingRow } from "../lib/api.ts";
  import { clientKey, setClientKey } from "../lib/nav.ts";
  import { toast } from "../lib/toast.ts";
  import { num, ms } from "../lib/format.ts";

  let combos = $state<Combo[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let pricing = $state<PricingRow[]>([]);
  let booted = $state(false);
  let err = $state<string | null>(null);

  // controls
  let routeSel = $state<string>(""); // combo id, or "__direct__"
  let directModel = $state("");
  let env = $state<"local" | "custom">("local");
  let customBase = $state("http://127.0.0.1:20200");
  let key = $state("");
  let prompt = $state("Say OK in five words or fewer.");
  let running = $state(false);
  let keySrc = $state<"last" | "paste">("last");
  let keyCount = $state(0);
  let compareOn = $state(false);
  let compareModel = $state("");
  let resultB = $state<TestResult | null>(null);
  let runningB = $state(false);

  // result
  interface TestResult {
    at: number;
    requested: string;
    comboName: string | null;
    steps: Step[];
    strategy: string;
    status: number;
    clientMs: number;
    serverMs: number | null;
    serverStatus: number | null;
    provider: string;
    model: string;
    decision: string;
    stepIdx: number | null;
    inp: number | null;
    outp: number | null;
    costUsd: number | null;
    text: string;
    trace: TLItem[];
    error: string | null;
  }
  let result = $state<TestResult | null>(null);

  const combo = $derived(combos.find((c) => c.id === routeSel) ?? null);
  const steps = $derived(combo ? parseSteps(combo.steps) : []);
  const strat = $derived(combo ? strategyDef(combo.strategy) : null);

  const modelHints = $derived.by(() => {
    const fromReg = registry.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
    const fromCombo = combos.map((c) => c.name);
    return [...new Set([...fromCombo, ...fromReg])].sort().slice(0, 800);
  });

  async function refresh(): Promise<void> {
    try {
      const [c, r, p] = await Promise.all([listCombos(), api.registry(), getPricing().catch(() => ({ pricing: [] as PricingRow[] }))]);
      try {
        keyCount = (await api.keys()).keys.length;
      } catch {
        keyCount = 0;
      }
      combos = (c.combos ?? []).map((x) => ({
        ...x,
        steps: parseSteps((x as unknown as { steps: unknown }).steps) as unknown as unknown[],
      })) as Combo[];
      if (!routeSel && combos.length) routeSel = combos[0]!.id;
      registry = r.providers;
      pricing = p.pricing ?? [];
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  function base(): string {
    return env === "local" ? "" : customBase.replace(/\/+$/, "");
  }

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (b && typeof b === "object" && "text" in (b as Record<string, unknown>) ? String((b as { text: unknown }).text ?? "") : ""))
        .join("");
    }
    return content == null ? "" : String(content);
  }

  /** Which chain step produced this model? -1 when outside the chain. */
  function matchStep(steps: Step[], model: string): number {
    const bare = model.includes("/") ? model.split("/").slice(1).join("/") : model;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!.model;
      if (s === model) return i;
      const sBare = s.includes("/") ? s.split("/").slice(1).join("/") : s;
      if (sBare.toLowerCase() === bare.toLowerCase()) return i;
    }
    return -1;
  }

  function priceFor(provider: string, model: string): PricingRow | null {
    const bare = model.includes("/") ? model.split("/").slice(1).join("/") : model;
    return (
      pricing.find((p) => p.provider === provider && (p.model === model || p.model === bare)) ??
      pricing.find((p) => p.model === model || p.model === bare) ??
      null
    );
  }

  async function serverRow(): Promise<{ dur: number | null; status: number | null }> {
    try {
      const l = await api.logs(20);
      const hit = l.rows.find((r) => r.method === "POST" && r.path === "/v1/chat/completions");
      return hit ? { dur: hit.dur_ms, status: hit.status } : { dur: null, status: null };
    } catch {
      return { dur: null, status: null };
    }
  }

  async function test(): Promise<void> {
    const k = (keySrc === "last" ? $clientKey : key).trim();
    if (!k) {
      toast(keySrc === "last" ? "no stored key — create one under API Keys, use it once, then come back" : "paste an API key first (create one under API Keys)", "err");
      return;
    }
    const requested = routeSel === "__direct__" ? directModel.trim() : (combo?.name ?? "");
    if (!requested) {
      toast(routeSel === "__direct__" ? "enter a model" : "pick a route", "err");
      return;
    }
    if (!prompt.trim()) {
      toast("enter a message", "err");
      return;
    }
    setClientKey(k);
    running = true;
    result = null;
    const t0 = performance.now();
    const comboName = combo && routeSel !== "__direct__" ? combo.name : null;
    const sentSteps = [...steps];
    const sentStrategy = combo?.strategy ?? "priority";
    let status = 0;
    let body: Record<string, unknown> = {};
    let error: string | null = null;
    try {
      const res = await fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
        body: JSON.stringify({ model: requested, messages: [{ role: "user", content: prompt }], stream: false }),
      });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const em = (body as { error?: { message?: string } }).error?.message ?? `gateway ${res.status}`;
        throw new Error(em);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    const clientMs = performance.now() - t0;
    const srv = await serverRow();

    if (error) {
      result = {
        at: Date.now(), requested, comboName, steps: sentSteps, strategy: sentStrategy,
        status, clientMs, serverMs: srv.dur, serverStatus: srv.status,
        provider: "—", model: "—", decision: "no response", stepIdx: null,
        inp: null, outp: null, costUsd: null, text: "", trace: [], error,
      };
      running = false;
      return;
    }

    const choice = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0];
    const text = textOf(choice?.message?.content);
    const respModel = String((body as { model?: unknown }).model ?? "");
    const usage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage ?? {};
    const inp = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
    const outp = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
    const idx = comboName ? matchStep(sentSteps, respModel) : -1;
    const decision = !comboName
      ? "direct model (no route)"
      : idx < 0
        ? "outside chain — response model matches no step"
        : idx === 0
          ? "primary served"
          : `fallback served (step ${idx + 1}/${sentSteps.length})`;
    let provider = "—";
    let costUsd: number | null = null;
    if (idx >= 0) {
      const sm = sentSteps[idx]!.model;
      provider = sm.includes("/") ? sm.split("/")[0]! : respModel.split("/")[0] ?? "—";
      const pr = priceFor(provider, respModel);
      if (pr && inp != null && outp != null) costUsd = (inp / 1e6) * pr.input_usd + (outp / 1e6) * pr.output_usd;
    } else if (respModel.includes("/")) {
      provider = respModel.split("/")[0]!;
    }

    const trace: TLItem[] = [
      { title: "request", desc: `POST /v1/chat/completions · model "${requested}" · 1 user message`, tone: "muted", time: `${Math.round(clientMs)}ms client` },
      {
        title: "policy",
        desc: comboName
          ? `route "${comboName}" · ${strategyDef(sentStrategy).name}${strategyDef(sentStrategy).gateway ? " (gateway)" : " (advisory — ran as priority order)"} · ${sentSteps.length} steps`
          : "no route — direct model call",
        tone: "blue",
      },
      {
        title: "selection",
        desc: comboName
          ? sentStrategy === "weighted" ? "weight-desc, then priority" : "step order, pre-first-byte"
          : "single candidate",
        tone: "blue",
      },
      { title: "provider", desc: `${provider} · model "${respModel || "—"}" · ${decision}`, tone: status === 200 ? "ok" : "bad" },
      {
        title: "response",
        desc: `client ${Math.round(clientMs)}ms${srv.dur != null ? ` · server ${srv.dur}ms (log #${srv.status})` : " · server row not found in request log"}`,
        tone: "muted",
      },
    ];

    result = {
      at: Date.now(), requested, comboName, steps: sentSteps, strategy: sentStrategy,
      status, clientMs, serverMs: srv.dur, serverStatus: srv.status,
      provider, model: respModel || "—", decision, stepIdx: idx >= 0 ? idx : null,
      inp, outp, costUsd, text, trace, error: null,
    };
    running = false;
  }

  async function compare(): Promise<void> {
    const b = compareModel.trim();
    if (!b) {
      toast("enter a second model to compare", "err");
      return;
    }
    const keepRoute = routeSel;
    const keepModel = directModel;
    resultB = null;
    runningB = true;
    try {
      routeSel = "__direct__";
      directModel = b;
      await test();
      resultB = result;
    } finally {
      routeSel = keepRoute;
      directModel = keepModel;
      runningB = false;
    }
  }

  // seed key field once from the stored dashboard key (never synced anywhere)
  let keySeeded = false;
  $effect(() => {
    if (!keySeeded && $clientKey) {
      key = $clientKey;
      keySeeded = true;
    }
  });
  onMount(() => {
    void refresh();
  });
</script>

<div class="head">
  <div>
    <h1>Playground</h1>
    <p class="sub">Send a real request through the gateway. Trace is reconstructed from what we sent, the route policy, and the observed response — the server exposes no dry-run and no per-step trace.</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
    <Button variant="primary" onclick={() => void test()} disabled={running}><Icon name="bolt" size={13} /> {running ? "Sending…" : "Test route"}</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton"></div>
{:else}
  {#if err}<div class="errbar">{err}</div>{/if}
  <div class="grid">
    <Panel title="Controls" sub="route or direct model, environment, key, message">
      <div class="ctl">
        <label class="fld"><span>Route</span>
          <select class="inp" bind:value={routeSel} aria-label="Route">
            {#each combos as c (c.id)}
              <option value={c.id}>{c.name}{c.enabled ? "" : " (paused)"}</option>
            {/each}
            <option value="__direct__">direct model (no route)</option>
          </select>
        </label>
        {#if routeSel === "__direct__"}
          <label class="fld"><span>Model</span>
            <input class="inp" list="pg-models" value={directModel} placeholder="provider/model" aria-label="Model"
              oninput={(e) => (directModel = (e.target as HTMLInputElement).value)} />
          </label>
        {:else if combo}
          <div class="strat-line">
            <span class="lbl">Strategy</span>
            <span class="sval">{strat?.name}
              {#if strat && !strat.gateway}<span class="adv">advisory</span>{/if}
            </span>
          </div>
        {/if}
        <div class="frow">
          <label class="fld"><span>API key</span>
            <select class="inp" bind:value={keySrc} aria-label="API key source">
              <option value="last">stored key{$clientKey ? ` •••${$clientKey.slice(-4)}` : " (none yet)"}{keyCount ? ` · ${keyCount} key${keyCount === 1 ? "" : "s"} on file` : ""}</option>
              <option value="paste">type / paste another</option>
            </select>
          </label>
          {#if keySrc === "paste"}
            <label class="fld grow"><span>Paste key</span>
              <input class="inp" type="password" value={key} placeholder="rikka key — stored in this browser only" aria-label="API key"
                oninput={(e) => (key = (e.target as HTMLInputElement).value)} />
            </label>
          {/if}
        </div>
        <label class="fld chk"><span>Compare mode</span>
          <span class="chkrow"><input type="checkbox" bind:checked={compareOn} /> run a second model on the same prompt</span>
        </label>
        {#if compareOn}
          <label class="fld"><span>Model B</span>
            <input class="inp" list="pg-models" value={compareModel} placeholder="provider/model" aria-label="Model B"
              oninput={(e) => (compareModel = (e.target as HTMLInputElement).value)} />
          </label>
        {/if}
        <div class="frow">
          <label class="fld"><span>Env</span>
            <select class="inp" bind:value={env} aria-label="Environment">
              <option value="local">local gateway (same origin)</option>
              <option value="custom">custom base URL</option>
            </select>
          </label>
          {#if env === "custom"}
            <label class="fld grow"><span>Base URL</span>
              <input class="inp" value={customBase} placeholder="http://127.0.0.1:20200" aria-label="Base URL"
                oninput={(e) => (customBase = (e.target as HTMLInputElement).value)} />
            </label>
          {/if}
        </div>
        <label class="fld"><span>Message</span>
          <textarea class="area" rows="4" value={prompt} aria-label="Message"
            oninput={(e) => (prompt = (e.target as HTMLTextAreaElement).value)}></textarea>
        </label>
        <div class="form-actions">
          <Button variant="primary" onclick={() => void test()} disabled={running || runningB}><Icon name="bolt" size={13} /> {running ? "Sending…" : "Test route"}</Button>
          {#if compareOn}
            <Button variant="secondary" onclick={() => void compare()} disabled={running || runningB}><Icon name="analytics" size={13} /> {runningB ? "Comparing…" : "Compare A vs B"}</Button>
          {/if}
        </div>
      </div>
      <datalist id="pg-models">
        {#each modelHints as h (h)}<option value={h}></option>{/each}
      </datalist>
    </Panel>

    <div class="side">
      <Panel title="Result" sub={result ? `answered ${new Date(result.at).toLocaleTimeString("en-GB", { hour12: false })}` : "no request yet"}>
        {#if !result}
          <p class="empty">Press TEST ROUTE. The response, latency, tokens, and cost (when pricing is known) appear here.</p>
        {:else if result.error}
          <p class="bad">request failed{result.status ? ` (${result.status})` : ""}: {result.error}</p>
          {#if result.status === 401}
            <p class="empty">401 means the key is missing or unknown — create one under API Keys, paste it above, and retry. The key stays in this browser's localStorage.</p>
          {/if}
          {#if result.serverMs != null}<p class="meta mono">server log: {result.serverMs}ms · status {result.serverStatus}</p>{/if}
        {:else}
          <div class="res-head">
            <StatusPill tone="ok" label={result.decision} />
            <span class="mono dim">{result.provider} · {result.model}</span>
          </div>
          <dl class="kv">
            <div><dt>Latency</dt><dd class="mono">{ms(Math.round(result.clientMs))}{result.serverMs != null ? ` (server ${result.serverMs}ms)` : ""}</dd></div>
            <div><dt>Tokens in / out</dt><dd class="mono">{result.inp != null ? num(result.inp) : "—"} / {result.outp != null ? num(result.outp) : "—"}</dd></div>
            <div><dt>Cost</dt><dd class="mono">{result.costUsd != null ? `$${result.costUsd.toFixed(6)}` : "— (no pricing row)"}</dd></div>
            <div><dt>Confidence</dt><dd class="mono">n/a — no dry-run endpoint</dd></div>
          </dl>
          {#if result.text}
            <pre class="out">{result.text}</pre>
          {/if}
        {/if}
      </Panel>

      {#if result && !result.error}
        <Panel title="Trace" sub="client-reconstructed — request → policy → selection → provider → response">
          <Timeline label="Request trace" items={result.trace} />
        </Panel>
      {/if}
      {#if resultB && !resultB.error}
        <Panel title="Model B" sub="{resultB.model} · answered {new Date(resultB.at).toLocaleTimeString('en-GB', { hour12: false })}">
          <dl class="kv">
            <div><dt>Latency</dt><dd class="mono">{ms(Math.round(resultB.clientMs))}{resultB.serverMs != null ? ` (server ${resultB.serverMs}ms)` : ""}{result && !result.error ? (resultB.clientMs < result.clientMs ? " · faster ✓" : " · slower") : ""}</dd></div>
            <div><dt>Tokens in / out</dt><dd class="mono">{resultB.inp != null ? num(resultB.inp) : "—"} / {resultB.outp != null ? num(resultB.outp) : "—"}</dd></div>
            <div><dt>Cost</dt><dd class="mono">{resultB.costUsd != null ? `$${resultB.costUsd.toFixed(6)}` : "— (no pricing row)"}</dd></div>
          </dl>
          {#if resultB.text}
            <pre class="out">{resultB.text}</pre>
          {/if}
        </Panel>
      {:else if resultB?.error}
        <Panel title="Model B" sub="failed">
          <p class="bad">request failed{resultB.status ? ` (${resultB.status})` : ""}: {resultB.error}</p>
        </Panel>
      {/if}
    </div>
  </div>
{/if}

<style>
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .sub { margin: 3px 0 0; font-size: 12.5px; color: var(--color-ink-muted); line-height: 1.5; max-width: 640px; }
  .hdr-actions { display: flex; gap: 8px; }
  .grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 12px; }
  @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
  .side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ctl { display: flex; flex-direction: column; gap: 12px; }
  .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .fld span, .lbl { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-soft); }
  .frow { display: flex; gap: 10px; }
  .chkrow { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
  .frow .fld { flex: 0 0 auto; }
  .grow { flex: 1; }
  .inp, .area {
    border: 1px solid var(--color-edge-strong); background: var(--color-elevated);
    border-radius: var(--radius-input); color: var(--color-ink);
    font-family: inherit; font-size: 13px; padding: 0 10px; outline: 0; min-width: 0;
  }
  .inp { height: 34px; }
  .inp:focus, .area:focus { border-color: var(--color-blue); }
  select.inp option { background: var(--color-raised); }
  .area { padding: 9px 10px; resize: vertical; line-height: 1.5; }
  .strat-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .sval { font-size: 13px; font-weight: 600; }
  .adv {
    margin-left: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--color-warn); border: 1px solid rgba(255,181,70,0.35); border-radius: 999px; padding: 1px 7px;
  }
  .form-actions { display: flex; gap: 8px; }
  .empty { margin: 0; font-size: 12.5px; color: var(--color-ink-muted); line-height: 1.6; }
  .bad { margin: 0 0 8px; color: var(--color-bad); font-size: 13px; overflow-wrap: anywhere; }
  .meta { font-size: 11.5px; color: var(--color-ink-faint); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .dim { color: var(--color-ink-muted); }
  .res-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .kv { margin: 0 0 10px; display: flex; flex-direction: column; gap: 8px; }
  .kv div { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; }
  .kv dt { color: var(--color-ink-muted); }
  .kv dd { margin: 0; color: var(--color-ink); }
  .out {
    margin: 0; padding: 10px 12px; border: 1px solid var(--color-edge); border-radius: var(--radius-card);
    background: var(--color-raised); font-family: inherit; font-size: 13px; line-height: 1.6;
    white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-ink);
  }
  .errbar { padding: 8px 12px; font-size: 12px; color: var(--color-bad); border: 1px solid var(--color-edge); border-radius: var(--radius-card); background: rgba(255,77,94,0.06); margin-bottom: 12px; }
  .skeleton { height: 220px; border: 1px solid var(--color-edge); border-radius: var(--radius-panel); background: var(--color-base); }
</style>
